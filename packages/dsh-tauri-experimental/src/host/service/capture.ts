/**
 * host/service/capture.ts — turn 生命周期编排：before 快照 → after 快照 → 差异 → 账本。
 *
 * 时机：`agent/pre-step`（step === 1）是执行屏障，before 快照必然早于一切文件改动；
 * `session/event` 的 `turn/end` 与 `agent/status → idle` 只做后台结算，不阻塞 turn 落定。
 *
 * 并发：私有仓的 index/refs 是每个工作区共享的可变状态，所有 git 动作（捕获、结算、
 * 实时读数、容量治理）都经 runtime 的同一个工作区队列串行。
 *
 * 失败语义：任何捕获/统计失败都只写日志 + 账本里记 unavailable，绝不抛给 Agent 链路。
 */

import type { LiveSnapshot, SnapshotStore, TurnFileChange, TurnRecord } from '../types'
import type { ActiveTurn, BeginningTurn, CaptureLogger } from './capture.types'
import { getServerContext } from 'dsh-h3/utils'
import { defineService } from 'dsh-tauri'
import { RUNNING_CHANGES_REASON_WORKSPACE_CHANGED as REASON_WORKSPACE_CHANGED } from '../../shared/constants'
import { LOCK_BARRIER_TIMEOUT_MS, REASON_SNAPSHOT_FAILED, REASON_UNSAFE_WORKSPACE } from '../config/constants'
import {
  activeTurns,
  beginningTurns,
  isCaptureDisposed,
  setCaptureDisposed,
  settlingTurns,
  workspaceQueue,
} from '../config/runtime'
import { runningChangesHooks } from '../events'
import { server } from '../server'
import { pruneLooseObjects } from '../utils/git'
import { WorkspaceLockTimeoutError } from '../utils/lock'
import { retention } from './retention'
import { snapshot } from './snapshot'
import { turns } from './turns'
import { workspace } from './workspace'

const LIVE_POLL_INTERVAL_MS = 1500

export const capture = defineService({
  /**
   * pre-step 登记：起一个在飞的 before 快照，**不等待**。
   *
   * 快照只需早于文件改动，而唯一会改文件的是工具派发——等待点因此挪到
   * `tools/pre-execute`（见 [`capture.awaitBegin`]）。留在 pre-step 的屏障会让
   * 「prompt 已受理」到「user 节点落盘」之间多出一整个快照的时间，客户端那一头
   * 表现为刚发出的消息迟迟不出现。
   */
  start(sessionId: string, turn: number): void {
    if (isCaptureDisposed())
      return
    const key = activeKey(sessionId, turn)
    if (activeTurns.has(key) || beginningTurns.has(key))
      return
    // 落地 promise 永不 reject：结算侧与工具屏障都要 await 它，一次失败的快照不能把它们带走。
    const task = runBegin(sessionId, turn).then(
      () => undefined,
      async (error: unknown) => {
        warn(`dsh-tauri-experimental: before snapshot for session ${sessionId} turn ${turn} failed: ${String(error)}`)
        // 意外异常同样要留一笔账：客户端才知道「这一轮存在过」。没有基线 → 该轮保持沉默。
        await recordUnavailable(sessionId, turn, REASON_SNAPSHOT_FAILED).catch(() => undefined)
      },
    )
    const entry: BeginningTurn = { sessionId, turn, task }
    beginningTurns.set(key, entry)
    void task.finally(() => {
      if (beginningTurns.get(key)?.task === task)
        beginningTurns.delete(key)
    })
  },

  /**
   * 工具派发前的执行屏障：等该会话在飞的 before 快照落地（已落地的立即返回）。
   *
   * 与原先放在 pre-step 语义等价——快照必然早于一切文件改动——但这段等待与模型请求
   * 并行，用户看不到。刻意不观察 `exec.signal`：工具被取消时快照仍是基线，宁可让一次
   * 已取消的派发多等一会儿，也不能让基线晚于文件改动而记错这一轮的改动。
   */
  async awaitBegin(sessionId: string, turn?: number): Promise<void> {
    const inflight: Promise<void>[] = []
    for (const item of beginningTurns.values()) {
      if (item.sessionId !== sessionId)
        continue
      if (turn !== undefined && item.turn !== turn)
        continue
      inflight.push(item.task)
    }
    if (inflight.length > 0)
      await Promise.all(inflight)
  },

  /**
   * 结算一轮：等 before 快照落地 → 捕 after → 差异 → 写账本。
   *
   * 幂等：`turn/end` 与 `agent/status → idle` 常常几乎同时到达，按 key 用 runtime 的
   * settling 集合串行。只有走到**终态**才把条目移出 active：中途抛错时留着它，
   * 下一次事件还能重试，而不是让这一轮永远没有记录。
   */
  async settle(sessionId: string, turn: number): Promise<void> {
    const key = activeKey(sessionId, turn)
    if (settlingTurns.has(key))
      return
    if (!activeTurns.has(key) && !beginningTurns.has(key))
      return
    settlingTurns.add(key)
    // 终态标记：只有它才能让条目离开 active（见 finally）。
    let terminal = false
    try {
      // 用户手动停止可能落在 before 快照还飞着的时候（屏障上要跑几秒到几十秒）：
      // 先等它落地，否则这一轮会被整个漏掉。
      await beginningTurns.get(key)?.task
      const entry = activeTurns.get(key)
      if (entry === undefined)
        return
      // 读数是过程态，不该跨 turn 残留：结算即结束运行中提示。
      stopLivePolling(entry)
      if (entry.workspaceRoot === null || entry.store === null) {
        terminal = true
        return
      }
      if (entry.beforeCommit === null) {
        // 连基线都没建立：这一轮从来没有过变更记录，账本行不带 ref（客户端据此沉默）。
        await recordUnavailable(sessionId, entry.turn, entry.skippedReason ?? REASON_SNAPSHOT_FAILED)
        terminal = true
        return
      }
      const store = entry.store
      const workspaceRoot = entry.workspaceRoot
      const beforeCommit = entry.beforeCommit
      // 工作区在 turn 期间被带外换了提交世代：before 树与当前磁盘的差不是这一轮的改动，
      // 如实记不可用，而不是把整段世代差报成「这一轮改了 N 个文件」。
      if (await workspaceHeadMoved(entry)) {
        await recordUnavailable(sessionId, turn, REASON_WORKSPACE_CHANGED, snapshot.ref(sessionId, turn, 'before'))
        terminal = true
        return
      }
      await workspaceQueue.run(workspaceRoot, async () => {
        const headBefore = await snapshot.head(workspaceRoot)
        const after = await snapshot.capture(store, snapshot.ref(sessionId, turn, 'after'), `turn ${turn} after`, {
          exclude: entry.exclusions,
          nestedDirs: entry.nestedDirs,
        })
        const headAfter = await snapshot.head(workspaceRoot)
        // after 快照期间被带外换世代：这一轮的树横跨两代，不能按内容归属。
        if (headBefore !== headAfter) {
          await recordUnavailable(sessionId, turn, REASON_WORKSPACE_CHANGED, snapshot.ref(sessionId, turn, 'before'))
          terminal = true
          return
        }
        if (!after.ok) {
          // 基线在、after 失败：账本行保留 before ref，
          // 客户端据此仍然给出告警（与「从没建立基线」的沉默区分开）。
          await recordUnavailable(sessionId, turn, after.reason, snapshot.ref(sessionId, turn, 'before'))
          terminal = true
          return
        }
        const diff = await snapshot.diff(store, beforeCommit, after.commit)
        if (!diff.ok) {
          await recordUnavailable(sessionId, turn, REASON_SNAPSHOT_FAILED, snapshot.ref(sessionId, turn, 'before'))
          terminal = true
          return
        }
        const record = buildRecord(turn, sessionId, diff.changes, {
          generation: entry.generation,
          skippedOversized: after.skippedOversized,
          skippedNestedRepos: after.skippedNestedRepos,
        })
        const refsToDelete = await turns.record(sessionId, record)
        // 账本已经落定 → 立即进入终态：后面几步即使抛错也不能重试，
        // 否则会重复捕 after、重复触发钩子，还可能把之后才发生的改动算进这一轮。
        terminal = true
        // 保留窗口淘汰 / 硬上限丢弃：删掉对应 refs，再回收不可达对象（含实时读数留下的
        // 中间版本 blob）。prune 只在真的淘汰了东西时跑。
        if (refsToDelete.length > 0) {
          await snapshot.remove(store, refsToDelete)
          await pruneLooseObjects(store)
        }
        await runningChangesHooks.callHook('turn:captured', sessionId, turn, record.files.length)
      })
    }
    finally {
      settlingTurns.delete(key)
      if (terminal)
        activeTurns.delete(key)
    }
  },

  /**
   * 会话空闲兜底：结算「idle 那一刻已经存在」的 turn。
   *
   * 候选集必须同步取定：若等完在飞的快照再去看 active，就可能把 idle 之后新开始、
   * 其实还在跑的 turn 误结算掉。
   */
  async settleIdle(sessionId: string): Promise<void> {
    const inflight = [...beginningTurns.values()].filter(item => item.sessionId === sessionId)
    const candidates = [...activeTurns.values()].filter(entry => entry.sessionId === sessionId)
    if (inflight.length > 0)
      await Promise.all(inflight.map(item => item.task))
    for (const entry of candidates)
      await capture.settle(sessionId, entry.turn)
    // 在飞的那些当时还没有 active 条目，落地后按 turn 号结算（settle 内部幂等）。
    for (const item of inflight)
      await capture.settle(sessionId, item.turn)
  },

  /**
   * 立刻作废实时读数（停表 + 清读数），条目本身保留给后台结算。
   * 读数相对的是本轮的 before 快照，工作区此后每一次改动都会让它变大；一旦这一轮
   * （或整个会话）结束，这份读数就再也不是「当前正在发生什么」，必须立刻归零。
   * @param sessionId - 会话 id。
   * @param turn - 省略即该会话全部轮次（会话结束/销毁）。
   */
  resetLive(sessionId: string, turn?: number): void {
    for (const entry of activeTurns.values()) {
      if (entry.sessionId !== sessionId)
        continue
      if (turn !== undefined && entry.turn !== turn)
        continue
      stopLivePolling(entry)
    }
  },

  /**
   * 运行中实时读数；没有正在进行的 turn 时返回 active: false。
   * 同一会话可能同时留着多条（旧轮还在后台结算，新一轮已经开始）：只认**轮次最新**的
   * 那条读数，按插入序取第一条会报出更早 before 快照的差值，看上去就是跨轮累加的数字。
   */
  live(sessionId: string): LiveSnapshot {
    let newest: ActiveTurn | null = null
    for (const entry of activeTurns.values()) {
      if (entry.sessionId !== sessionId || entry.live === null)
        continue
      if (newest === null || entry.turn > newest.turn)
        newest = entry
    }
    if (newest === null || newest.live === null)
      return { active: false, turn: null, fileCount: 0, insertions: 0, deletions: 0 }
    return { active: true, ...newest.live }
  },

  /** 卸载：清定时器并丢弃内存态（服务卸载由 apply 负责）。 */
  dispose(): void {
    setCaptureDisposed(true)
    // 必须清掉每个 active turn 的轮询定时器，否则插件停用后仍会持续拉起 git 子进程。
    for (const entry of activeTurns.values())
      stopLivePolling(entry)
    activeTurns.clear()
    beginningTurns.clear()
    settlingTurns.clear()
  },
})

// --- internal ---

function activeKey(sessionId: string, turn: number): string {
  return `${sessionId}:${turn}`
}

/** 日志面（宿主 logger 的最小契约；未绑定宿主或没有 logger 时静默）。 */
function warn(message: string): void {
  try {
    const logger = getServerContext(server)?.logger as CaptureLogger | undefined
    logger?.warn?.(message)
  }
  catch {
    /* 未绑定宿主：静默 */
  }
}

function skippedEntry(sessionId: string, turn: number, parts: { store: SnapshotStore, workspaceRoot: string } | null, reason: string): ActiveTurn {
  return {
    sessionId,
    turn,
    workspaceRoot: parts?.workspaceRoot ?? null,
    store: parts?.store ?? null,
    beforeCommit: null,
    baselineHead: null,
    skippedReason: reason,
    live: null,
    liveTimer: null,
    liveBusy: false,
    liveEpoch: 0,
    exclusions: [],
    nestedDirs: [],
    generation: null,
  }
}

/**
 * before 快照的真实工作：探测工作区资格 → 容量治理 → 捕获 before → 登记活动条目并起实时轮询。
 */
async function runBegin(sessionId: string, turn: number): Promise<void> {
  const key = activeKey(sessionId, turn)
  // 快照跑完时插件可能已经卸载：不再登记条目，否则会留下永不清理的轮询定时器。
  const register = (entry: ActiveTurn): boolean => {
    if (isCaptureDisposed())
      return false
    activeTurns.set(key, entry)
    return true
  }
  const probe = await workspace.resolve(sessionId)
  if (!probe.ok) {
    // 非 Git / 系统目录 / git 缺失：不建快照。资格结论写进账本供客户端呈现。
    // 「确实是 Git 仓库但被守卫拒绝」的目录保持 isGit=true，避免客户端误报「需要 Git 仓库」。
    await turns.note(sessionId, {
      workspaceRoot: null,
      isGit: probe.reason === REASON_UNSAFE_WORKSPACE,
      unavailableReason: probe.reason,
    }).catch(() => undefined)
    register(skippedEntry(sessionId, turn, null, probe.reason))
    return
  }
  const store = snapshot.resolve(probe.root, probe.commonDir, sessionId)
  const waitOptions = { waitDeadline: Date.now() + LOCK_BARRIER_TIMEOUT_MS }
  // 治理与基线共用一次持锁；等待预算只在整个任务开始前生效。
  const { exclusions, result, baselineHead, stable } = await workspaceQueue.run(probe.root, async () => {
    let exclusions: string[]
    try {
      const outcome = await retention.ensure(store)
      if (outcome?.rebuilt)
        warn(`dsh-tauri-experimental: snapshot repository for ${probe.root} exceeded the size cap and was rebuilt; older turns are now expired`)
      exclusions = outcome?.exclusions ?? await retention.read(store)
    }
    catch (error) {
      if (error instanceof WorkspaceLockTimeoutError)
        throw error
      exclusions = []
    }
    const nestedDirs = snapshot.scan(probe.root)
    // 基线必须绑定一个**稳定的**提交世代：快照期间工作区被带外 checkout 时，读到的树
    // 可能横跨两代，之后任何比对都不再有意义。
    const headBefore = await snapshot.head(probe.root)
    const result = await snapshot.capture(store, snapshot.ref(sessionId, turn, 'before'), `turn ${turn} before`, { exclude: exclusions, nestedDirs })
    const headAfter = await snapshot.head(probe.root)
    return { exclusions, result, baselineHead: headBefore, stable: headBefore === headAfter }
  }, LOCK_BARRIER_TIMEOUT_MS, waitOptions)
  if (!result.ok) {
    warn(`dsh-tauri-experimental: before snapshot for session ${sessionId} turn ${turn} unavailable: ${result.reason}`)
    await turns.note(sessionId, { workspaceRoot: probe.root, isGit: true, unavailableReason: null }).catch(() => undefined)
    register(skippedEntry(sessionId, turn, { store, workspaceRoot: probe.root }, result.reason))
    return
  }
  await turns.note(sessionId, { workspaceRoot: probe.root, isGit: true, unavailableReason: null }).catch(() => undefined)
  // 本轮新学到的排除项（超限文件/嵌套仓库）持久化：后续 turn 不必再付一次重捕代价。
  if (result.learnedExclusions.length > 0)
    await retention.write(store, [...exclusions, ...result.learnedExclusions])

  // 基线本身横跨两代：这一轮从没有过可归属的基线，如实记原因（客户端据此给出说明）。
  if (!stable) {
    warn(`dsh-tauri-experimental: workspace HEAD moved during the before snapshot for session ${sessionId} turn ${turn}`)
    register(skippedEntry(sessionId, turn, { store, workspaceRoot: probe.root }, REASON_WORKSPACE_CHANGED))
    return
  }

  const entry: ActiveTurn = {
    sessionId,
    turn,
    workspaceRoot: probe.root,
    store,
    beforeCommit: result.commit,
    baselineHead,
    skippedReason: null,
    live: { turn, fileCount: 0, insertions: 0, deletions: 0 },
    liveTimer: null,
    liveBusy: false,
    liveEpoch: 0,
    exclusions: [...new Set([...exclusions, ...result.learnedExclusions])],
    nestedDirs: result.skippedNestedRepos,
    generation: store.generation ?? null,
  }
  // 新一轮登记前先收回旧轮的读数：提示条从这一轮从零开始。
  retireOlderLive(sessionId, turn)
  if (register(entry))
    startLivePolling(entry)
}

/**
 * 运行中轮询：定时把「当前工作区 vs before 快照」的读数刷进 entry.live。
 * 上一次刷新还在飞就跳过本次（慢仓库/大仓库时不堆积 git 子进程）；定时器 unref。
 */
function startLivePolling(entry: ActiveTurn): void {
  if (entry.liveTimer !== null || entry.store === null || entry.beforeCommit === null)
    return
  const timer = setInterval(() => {
    void refreshLive(entry)
  }, LIVE_POLL_INTERVAL_MS)
  ;(timer as unknown as { unref?: () => void }).unref?.()
  entry.liveTimer = timer
}

async function refreshLive(entry: ActiveTurn): Promise<void> {
  if (isCaptureDisposed() || entry.liveBusy || entry.store === null || entry.beforeCommit === null)
    return
  const { store, beforeCommit, workspaceRoot } = entry
  if (store === null || beforeCommit === null || workspaceRoot === null)
    return
  // 记下本次刷新的世代：期间发生任何作废（turn/end、会话结束、新一轮开始），
  // 结果都必须丢弃，不能让提示条把已经重置掉的读数复活。
  const epoch = entry.liveEpoch
  entry.liveBusy = true
  try {
    // 工作区被带外换世代（checkout / worktree 更新）：before 树与磁盘之间横着整段世代差，
    // 读数不再是「这一轮改了什么」，停表并让提示条消失。
    if (await workspaceHeadMoved(entry)) {
      stopLivePolling(entry)
      return
    }
    // 嵌套仓库目录必须一起传：目录语义的排除（`:(exclude,glob)dir/**`）只有独立传入才
    // 生效，漏掉时 `git add` 会把嵌套仓库当 gitlink 写进私有 index，读数于是报出工作区
    // 根本没发生过的改动。
    const result = await workspaceQueue.run(workspaceRoot, () => snapshot.live(store, beforeCommit, {
      exclude: entry.exclusions,
      nestedDirs: entry.nestedDirs,
    }))
    if (result.ok && entry.liveEpoch === epoch) {
      // 读数期间被带外换世代：这次读数横跨两代，丢弃并停表。
      if (await workspaceHeadMoved(entry))
        stopLivePolling(entry)
      else
        entry.live = { turn: entry.turn, ...result.stats }
    }
  }
  catch (error) {
    warn(`dsh-tauri-experimental: live diff failed: ${String(error)}`)
  }
  finally {
    entry.liveBusy = false
  }
}

/** 源仓库 HEAD 是否已离开 before 快照绑定的那个提交世代。 */
async function workspaceHeadMoved(entry: ActiveTurn): Promise<boolean> {
  if (entry.workspaceRoot === null || entry.baselineHead === null)
    return false
  const current = await snapshot.head(entry.workspaceRoot)
  return current !== null && current !== entry.baselineHead
}

function stopLivePolling(entry: ActiveTurn): void {
  if (entry.liveTimer !== null) {
    clearInterval(entry.liveTimer)
    entry.liveTimer = null
  }
  entry.live = null
  // 世代自增：在飞的刷新落地时会被认作过期结果丢弃（见 refreshLive）。
  entry.liveEpoch += 1
}

/**
 * 新一轮开始时收回更早轮次的读数。只清 `turn` 更小的条目（严格单调），并发路径下不会误伤
 * 刚开始的这一轮；上一轮若还在后台结算，它的读数也不再上报。
 */
function retireOlderLive(sessionId: string, turn: number): void {
  for (const entry of activeTurns.values()) {
    if (entry.sessionId === sessionId && entry.turn < turn)
      stopLivePolling(entry)
  }
}

function buildRecord(
  turn: number,
  sessionId: string,
  files: TurnFileChange[],
  extras: { generation: string | null, skippedOversized: string[], skippedNestedRepos: string[] },
): TurnRecord {
  let insertions = 0
  let deletions = 0
  for (const file of files) {
    insertions += file.insertions ?? 0
    deletions += file.deletions ?? 0
  }
  return {
    turn,
    // 账本只留 ref：commit oid 由 ref 解析，
    // 避免账本与仓库状态出现两份可能漂移的真相。
    beforeRef: snapshot.ref(sessionId, turn, 'before'),
    afterRef: snapshot.ref(sessionId, turn, 'after'),
    files,
    insertions,
    deletions,
    createdAt: Date.now(),
    unavailable: null,
    generation: extras.generation,
    skippedOversized: extras.skippedOversized,
    skippedNestedRepos: extras.skippedNestedRepos,
  }
}

/**
 * 记录一个没有变更明细的 turn（快照失败/超限），保留原因供读数呈现。
 *
 * `beforeRef` 只在**基线确实建立过**时传入：客户端用它把两种结局分开——
 * 「这一轮从没建立过快照」不弹告警；「基线在、after 结算失败」必须如实告警。
 */
async function recordUnavailable(sessionId: string, turn: number, reason: string, beforeRef = ''): Promise<void> {
  await turns.record(sessionId, {
    turn,
    beforeRef,
    afterRef: '',
    files: [],
    insertions: 0,
    deletions: 0,
    createdAt: Date.now(),
    unavailable: reason,
  })
}
