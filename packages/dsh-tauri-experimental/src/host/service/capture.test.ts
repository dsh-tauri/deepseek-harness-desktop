import { execFile } from 'node:child_process'
import { rmSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetTestDshHome, testDshHome } from '../../../../.test/test-utils'
import { PLUGIN_ID, RUNNING_CHANGES_REASON_SNAPSHOT_FAILED, RUNNING_CHANGES_REASON_WORKSPACE_CHANGED } from '../../shared/constants'
import { LOCK_BARRIER_TIMEOUT_MS } from '../config/constants'
import { disposeRuntime, resetHostRuntime, workspaceQueue } from '../config/runtime'
import { runningChangesHooks } from '../events'
import { server } from '../server'
import { WorkspaceLockTimeoutError } from '../utils/lock'
import { capture } from './capture'
import { ledger } from './ledger'
import { retention } from './retention'
import { snapshot } from './snapshot'

vi.mock('dsh-tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('dsh-tauri')>()
  const { testDshHome: home } = await import('../../../../.test/test-utils')
  return { ...actual, DSH_HOME: home }
})

const run = promisify(execFile)

const temporaryDirectories: string[] = []

/** 本次用例替换掉的 runtime 工作区队列实现；afterEach 一律还原。 */
const originalQueueRun = workspaceQueue.run

/** 绑定的宿主实例：会话 cwd 指向当前 fixture 的工作区（capture 自己解析工作区，不再收 cwd）。 */
const disposers: Array<() => void> = []

let hostCwd = ''

function bindHost(cwd: string): void {
  hostCwd = cwd
  disposers.push(server({
    webServer: { register: () => () => {} },
    sessions: {
      get: (id: string) => ({ id, header: { cwd: hostCwd } }),
    },
  } as never))
}

async function fixture(): Promise<{ worktree: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-running-changes-capture-'))
  temporaryDirectories.push(root)
  const worktree = join(root, 'project')
  await mkdir(worktree, { recursive: true })
  await run('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', worktree], { windowsHide: true })
  await writeFile(join(worktree, 'a.txt'), 'one\ntwo\n', 'utf8')
  bindHost(worktree)
  return { worktree }
}

beforeEach(() => {
  resetTestDshHome()
  // 账本与私有快照仓都在 <DSH_HOME>/<feature> 下，resetTestDshHome 不清这个目录。
  rmSync(join(testDshHome, PLUGIN_ID), { recursive: true, force: true })
  resetHostRuntime()
})

/** 本次用例挂过的捕获钩子（收尾要卸载，否则跨用例串读数）。 */
const capturedHooks: Array<(sessionId: string, turn: number, fileCount: number) => void> = []

/** 注册本轮的捕获钩子：结算落账后 `turn:captured` 带回本轮文件数。 */
function captureFor(captured: number[] = []): void {
  const hook = (_sessionId: string, _turn: number, fileCount: number): void => {
    captured.push(fileCount)
  }
  runningChangesHooks.hook('turn:captured', hook)
  capturedHooks.push(hook)
}

/** 可注入失败的队列包装（真实队列放行，`failing` 期间一律拒绝）：复现 git/IO 抛错。 */
function faultyQueue(): { setFailing: (value: boolean) => void } {
  const real = workspaceQueue.run
  let failing = false
  workspaceQueue.run = <T>(key: string, task: () => Promise<T>): Promise<T> =>
    (failing ? Promise.reject(new Error('injected failure')) : real(key, task))
  return {
    setFailing: (value: boolean) => {
      failing = value
    },
  }
}

/**
 * 可闸门队列：闸门关上后 `run` 一律先挂起，用来把「实时读数那次 git 调用正在飞」
 * 这一刻定住（复现「重置读数」与「在飞刷新」的赛跑）。真实队列照旧执行，串行语义不变；
 * `waitForCompleted` 让用例等到那次放行后的 git 真正跑完，而不是靠固定 sleep 猜时间。
 */
function gatedQueue(): {
  close: () => void
  open: () => void
  waitForRun: () => Promise<void>
  waitForCompleted: () => Promise<void>
} {
  const real = workspaceQueue.run
  let gate: Promise<void> | null = null
  let openGate: (() => void) | null = null
  let notifyArrived: (() => void) | null = null
  let notifyCompleted: (() => void) | null = null
  let arrived = Promise.resolve()
  let completed = Promise.resolve()
  workspaceQueue.run = async <T>(key: string, task: () => Promise<T>): Promise<T> => {
    if (gate === null)
      return real(key, task)
    notifyArrived?.()
    await gate
    const result = await real(key, task)
    notifyCompleted?.()
    return result
  }
  return {
    close: () => {
      gate = new Promise<void>((resolve) => {
        openGate = resolve
      })
      arrived = new Promise<void>((resolve) => {
        notifyArrived = resolve
      })
      completed = new Promise<void>((resolve) => {
        notifyCompleted = resolve
      })
    },
    open: () => {
      const release = openGate
      gate = null
      openGate = null
      release?.()
    },
    waitForRun: () => arrived,
    waitForCompleted: () => completed,
  }
}

afterEach(async () => {
  // 卸载捕获编排器：实时轮询的定时器与在飞的 git 子进程都会握着工作区，
  // Windows 上直接 rmdir 会 EBUSY。先停表、再给子进程一点退出时间。
  capture.dispose()
  disposeRuntime()
  disposers.splice(0).forEach(dispose => dispose())
  workspaceQueue.run = originalQueueRun
  for (const hook of capturedHooks.splice(0))
    runningChangesHooks.removeHook('turn:captured', hook)
  await new Promise(resolve => setTimeout(resolve, 100))
  for (const path of temporaryDirectories.splice(0)) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rm(path, { recursive: true, force: true })
        break
      }
      catch (error) {
        // 在飞的 git 子进程把工作区当 cwd：有界重试后如实抛出，不静默留垃圾。
        if (attempt >= 4)
          throw error
        await new Promise(resolve => setTimeout(resolve, 250))
      }
    }
  }
})

describe('turn 结算编排', () => {
  it('正常一轮：before → 改动 → 结算，账本记录本轮改动（卡片据此渲染）', async () => {
    const { worktree } = await fixture()
    captureFor()

    capture.start('s5', 1)
    await capture.awaitBegin('s5', 1)
    await writeFile(join(worktree, 'a.txt'), 'one\ntwo\nthree\n', 'utf8')
    await capture.settle('s5', 1)

    const current = await ledger.load('s5')
    expect(current.turns).toHaveLength(1)
    expect(current.turns[0]?.unavailable ?? null).toBeNull()
    expect(current.turns[0]?.files.map(file => file.path)).toEqual(['a.txt'])
  })

  it('turn/end 落在 before 快照还在飞的时候，这一轮仍然会被结算', async () => {
    await fixture()
    captureFor()

    // 用户手动停止就发生在这个窗口里：`agent/pre-step` 的屏障还没回来（before 快照在跑
    // `git add`），而 `turn/end` 已经到达。变更前这种 turn 会**整个消失**——账本里没有行，
    // 直到很久以后某个 idle 才被顺手收掉（实测有 30 分钟后才落账的）。
    capture.start('s1', 1)
    const beginning = capture.awaitBegin('s1', 1)
    await capture.settle('s1', 1)
    await beginning

    const current = await ledger.load('s1')
    expect(current.turns.map(turn => turn.turn)).toEqual([1])
    // 基线留下了（refs 非空）：后续任何地方都能据此判定撤销是否可用。
    expect(current.turns[0]?.beforeRef.length).toBeGreaterThan(0)
    expect(current.turns[0]?.afterRef.length).toBeGreaterThan(0)
  })

  it('agent/status → idle 早于 before 快照落地时同样不丢（手动中断的常路）', async () => {
    await fixture()
    captureFor()

    capture.start('s2', 1)
    const beginning = capture.awaitBegin('s2', 1)
    await capture.settleIdle('s2')
    await beginning

    expect((await ledger.load('s2')).turns.map(turn => turn.turn)).toEqual([1])
  })

  it('turn/end 与 idle 同时到达也只结算一次', async () => {
    await fixture()
    const captured: number[] = []
    captureFor(captured)

    capture.start('s3', 1)
    const beginning = capture.awaitBegin('s3', 1)
    await Promise.all([capture.settle('s3', 1), capture.settleIdle('s3')])
    await beginning

    // 重复结算会重复捕 after、重复触发 turn:captured 钩子，账本行也会被后写的那次覆盖。
    expect(captured).toEqual([0])
    expect((await ledger.load('s3')).turns).toHaveLength(1)
  })

  it('idle 兜底只结算「idle 那一刻已在跑」的 turn，不碰随后新开始的一轮', async () => {
    await fixture()
    captureFor()

    capture.start('s6', 1)
    const first = capture.awaitBegin('s6', 1)
    const idle = capture.settleIdle('s6')
    // idle 之后（用户重新发消息）立刻开始的新一轮：这次兜底不能把它一起结算掉，
    // 否则它的 after 会在 before 刚结束时被拍下来，那一轮的真实改动就永远拿不到了。
    capture.start('s6', 2)
    const second = capture.awaitBegin('s6', 2)
    await Promise.all([first, second, idle])

    expect((await ledger.load('s6')).turns.map(turn => turn.turn)).toEqual([1])
  })

  it('根本没有 before 快照的 turn 不会被凭空记一笔', async () => {
    await fixture()
    captureFor()
    await capture.settle('s4', 9)
    await capture.settleIdle('s4')
    expect((await ledger.load('s4')).turns).toEqual([])
  })

  it('before 快照抛异常（而非收敛成结果对象）时也留一笔账，客户端不会永久缺这一轮', async () => {
    await fixture()
    const { setFailing } = faultyQueue()
    captureFor()

    // 复现 git/IO 抛错：runBeginTurn 里的 queue.run 直接拒绝，before 快照连结果对象都没有。
    setFailing(true)
    capture.start('s7', 1)
    await capture.awaitBegin('s7', 1)
    setFailing(false)
    // 结算没有条目可结算，但不能因此把这一轮从账本里抹掉（客户端靠账本行停止重试）。
    await capture.settleIdle('s7')

    const current = await ledger.load('s7')
    expect(current.turns.map(turn => turn.turn)).toEqual([1])
    expect(current.turns[0]?.unavailable).toBe(RUNNING_CHANGES_REASON_SNAPSHOT_FAILED)
    expect(current.turns[0]?.beforeRef).toBe('')
  })

  it('结算中途抛错时保留条目，下一次 idle 兜底把这一轮补上（而不是永远没有记录）', async () => {
    const { worktree } = await fixture()
    const { setFailing } = faultyQueue()
    captureFor()

    capture.start('s8', 1)
    await capture.awaitBegin('s8', 1)
    await writeFile(join(worktree, 'a.txt'), 'one\ntwo\nthree\n', 'utf8')

    // after 快照这一步抛错：账本还没有这一轮。
    setFailing(true)
    await expect(capture.settle('s8', 1)).rejects.toThrow('injected failure')
    expect((await ledger.load('s8')).turns).toEqual([])

    // 条目留在活动表里 → 下一次 idle 兜底重试成功（真实运行时任何一次 idle 都会重新扫）。
    setFailing(false)
    await capture.settleIdle('s8')
    const current = await ledger.load('s8')
    expect(current.turns.map(turn => turn.turn)).toEqual([1])
    expect(current.turns[0]?.files.map(file => file.path)).toEqual(['a.txt'])
  })
})

describe('运行中提示条的读数生命周期', () => {
  it('新一轮开始时上一轮的读数立刻作废：提示条只反映当前这一轮', async () => {
    await fixture()
    captureFor()

    capture.start('s9', 1)
    await capture.awaitBegin('s9', 1)
    expect(capture.live('s9')).toMatchObject({ active: true, turn: 1 })

    // 第 1 轮还在后台结算（after 快照排队），用户已经发了新消息：
    // 此时若还报第 1 轮的读数，客户端提示条就会显示跨轮的累加数字。
    capture.start('s9', 2)
    await capture.awaitBegin('s9', 2)
    expect(capture.live('s9')).toMatchObject({ active: true, turn: 2 })
  })

  it('会话结束重置读数后，该轮的结算与卡片照常（重置只作用于过程态）', async () => {
    const { worktree } = await fixture()
    captureFor()

    capture.start('s10', 1)
    await capture.awaitBegin('s10', 1)
    await writeFile(join(worktree, 'a.txt'), 'one\ntwo\nthree\n', 'utf8')
    // 会话结束：读数归零，客户端提示条立刻消失。
    capture.resetLive('s10')
    expect(capture.live('s10')).toEqual({ active: false, turn: null, fileCount: 0, insertions: 0, deletions: 0 })

    // 条目没有被丢：turn 尾部的变更卡片仍然照常落账。
    await capture.settle('s10', 1)
    const current = await ledger.load('s10')
    expect(current.turns.map(turn => turn.turn)).toEqual([1])
    expect(current.turns[0]?.files.map(file => file.path)).toEqual(['a.txt'])
  })

  it('resetLive 按会话与轮次精确作废，不误伤其他会话', async () => {
    await fixture()
    captureFor()

    capture.start('s11', 1)
    await capture.awaitBegin('s11', 1)
    capture.start('s12', 1)
    await capture.awaitBegin('s12', 1)

    capture.resetLive('s11')
    expect(capture.live('s11').active).toBe(false)
    expect(capture.live('s12')).toMatchObject({ active: true, turn: 1 })

    // 按轮次也会精确命中：清 s12 的第 1 轮后两个会话都不再上报读数。
    capture.resetLive('s12', 1)
    expect(capture.live('s12').active).toBe(false)
  })

  it('重置与在飞的实时刷新赛跑时，晚到的读数不会把提示条复活', async () => {
    await fixture()
    const gate = gatedQueue()
    captureFor()

    capture.start('s13', 1)
    await capture.awaitBegin('s13', 1)
    expect(capture.live('s13')).toMatchObject({ active: true, turn: 1 })

    // 关上闸门后，下一次定时刷新（1.5s）会挂在队列里 —— 等它真的开始。
    gate.close()
    try {
      await gate.waitForRun()
      // 读数还在飞的时候会话结束：重置必须生效，且在飞结果落地之后依然生效。
      capture.resetLive('s13')
    }
    finally {
      gate.open()
    }
    // 等到那次放行的 git 跑完（不加世代闸门时它会在这里把读数写回来）。
    await gate.waitForCompleted()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(capture.live('s13').active).toBe(false)
  })

  it('resetLive stops live readings without settling or losing the turn', async () => {
    const { worktree } = await fixture()
    capture.start('s14', 1)
    await capture.awaitBegin('s14', 1)
    await writeFile(join(worktree, 'a.txt'), 'one\ntwo\nthree\n', 'utf8')

    capture.resetLive('s14')
    expect(capture.live('s14')).toEqual({ active: false, turn: null, fileCount: 0, insertions: 0, deletions: 0 })
    expect((await ledger.load('s14')).turns).toEqual([])

    await capture.settle('s14', 1)
    const current = await ledger.load('s14')
    expect(current.turns.map(turn => turn.turn)).toEqual([1])
    expect(current.turns[0]?.files).toEqual([{ path: 'a.txt', status: 'M', insertions: 1, deletions: 0, binary: false }])
    await writeFile(join(worktree, 'a.txt'), 'later\n', 'utf8')
    await capture.settle('s14', 1)
    expect(await ledger.load('s14')).toEqual(current)
  })

  it('工作区里的嵌套仓库不会让运行中读数凭空多出文件（提示条假报 +N）', async () => {
    // 回归背景：`entry.nestedDirs` 此前只用于结算时的 after 快照，没传进 liveDiff ——
    // 实时读数的 `git add --all` 会把嵌套仓库当 gitlink 写进私有 index，而 before
    // 快照里没有它们，读数于是报出「2 个文件已更改 +2 -0」这种工作区根本没发生过的
    // 改动（用户实际反馈）。这里钉的是这条**接线**：本轮的改动只有 a.txt 一行。
    const { worktree } = await fixture()
    const nested = join(worktree, 'source', 'react-use')
    await mkdir(nested, { recursive: true })
    await run('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', nested], { windowsHide: true })
    await writeFile(join(nested, 'inner.txt'), 'v1\n', 'utf8')
    const identity = ['-c', 'user.email=test@example.com', '-c', 'user.name=test']
    await run('git', ['-C', nested, ...identity, 'add', '--all'], { windowsHide: true })
    await run('git', ['-C', nested, ...identity, 'commit', '--quiet', '-m', 'init'], { windowsHide: true })
    // 源仓库登记成 gitlink（被跟踪的嵌套仓库，不是被忽略的参考克隆）。
    await run('git', ['-C', worktree, ...identity, 'add', 'source/react-use'], { windowsHide: true })

    captureFor()
    capture.start('s16', 1)
    await capture.awaitBegin('s16', 1)
    await writeFile(join(worktree, 'a.txt'), 'one\ntwo\nthree\n', 'utf8')

    // 等第一次定时刷新（1.5s 起）落地：读数出现就必须正好是 a.txt 这一处改动。
    const deadline = Date.now() + 15_000
    while (capture.live('s16').fileCount === 0 && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 50))

    expect(capture.live('s16')).toMatchObject({ active: true, turn: 1, fileCount: 1, insertions: 1, deletions: 0 })
  })
})

describe('工作区被带外换提交世代（新建工作树 / checkout 到 origin/main）', () => {
  it('工作区 HEAD 移动后运行中读数作废，结算如实记不可用，而不是把整段世代差算成这一轮', async () => {
    // 回归背景：新建工作树时工作区先落在 refs/heads/main，随后被 checkout 到 origin/main。
    // before 快照取自旧世代、磁盘已是新世代，读数于是把整段世代差（实测 92 个文件
    // +8565 -8461）报成「这一轮改了什么」——用户什么都没改。这里钉的是基线绑定。
    const { worktree } = await fixture()
    const identity = ['-c', 'user.email=test@example.com', '-c', 'user.name=test']
    const gitAt = async (...args: string[]): Promise<string> => {
      const result = await run('git', ['-C', worktree, ...identity, ...args], { windowsHide: true })
      return result.stdout.trim()
    }
    await gitAt('add', '--all')
    await gitAt('commit', '--quiet', '-m', 'one')
    await writeFile(join(worktree, 'b.txt'), 'other\n', 'utf8')
    await gitAt('add', '--all')
    await gitAt('commit', '--quiet', '-m', 'two')
    const older = await gitAt('rev-parse', 'HEAD~1')

    captureFor()
    capture.start('s-head', 1)
    await capture.awaitBegin('s-head', 1)
    expect(capture.live('s-head')).toMatchObject({ active: true, turn: 1 })

    await gitAt('checkout', '--quiet', older)

    const deadline = Date.now() + 15_000
    while (capture.live('s-head').active && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 50))
    expect(capture.live('s-head').active).toBe(false)

    await capture.settle('s-head', 1)
    const current = await ledger.load('s-head')
    expect(current.turns[0]?.unavailable).toBe(RUNNING_CHANGES_REASON_WORKSPACE_CHANGED)
    expect(current.turns[0]?.files).toEqual([])
    expect(current.turns[0]?.insertions).toBe(0)
    expect(current.turns[0]?.deletions).toBe(0)
  })

  it('before 快照期间工作区被换世代时，这一轮不建立基线', async () => {
    // 快照本身横跨两代时，记下的树不属于任何一代：必须拒绝，而不是留一个假基线。
    const { worktree } = await fixture()
    const identity = ['-c', 'user.email=test@example.com', '-c', 'user.name=test']
    const gitAt = async (...args: string[]): Promise<string> => {
      const result = await run('git', ['-C', worktree, ...identity, ...args], { windowsHide: true })
      return result.stdout.trim()
    }
    await gitAt('add', '--all')
    await gitAt('commit', '--quiet', '-m', 'one')
    await writeFile(join(worktree, 'b.txt'), 'other\n', 'utf8')
    await gitAt('add', '--all')
    await gitAt('commit', '--quiet', '-m', 'two')
    const older = await gitAt('rev-parse', 'HEAD~1')

    captureFor()
    const real = snapshot.capture
    const spy = vi.spyOn(snapshot, 'capture').mockImplementation(async (store, ref, message, options) => {
      const result = await real(store, ref, message, options)
      // 快照与 HEAD 采样之间被带外换世代。
      await gitAt('checkout', '--quiet', older)
      return result
    })
    try {
      capture.start('s-race', 1)
      await capture.awaitBegin('s-race', 1)
    }
    finally {
      spy.mockRestore()
    }
    await capture.settle('s-race', 1)

    const current = await ledger.load('s-race')
    expect(current.turns[0]?.unavailable).toBe(RUNNING_CHANGES_REASON_WORKSPACE_CHANGED)
    expect(current.turns[0]?.files).toEqual([])
  })
})

describe('屏障等待预算（容量治理与 before 一次持锁）', () => {
  function recordingQueue(): Array<{ lockTimeoutMs: number | undefined, waitDeadline: number | undefined }> {
    const real = workspaceQueue.run
    const recorded: Array<{ lockTimeoutMs: number | undefined, waitDeadline: number | undefined }> = []
    workspaceQueue.run = <T>(key: string, task: () => Promise<T>, lockTimeoutMs?: number, options?: { waitDeadline?: number }): Promise<T> => {
      recorded.push({ lockTimeoutMs, waitDeadline: options?.waitDeadline })
      return real(key, task, lockTimeoutMs, options)
    }
    return recorded
  }

  it('屏障只排队持锁一次，后台结算仍用默认预算', async () => {
    const { worktree } = await fixture()
    captureFor()
    const recorded = recordingQueue()
    const startedAt = Date.now()

    capture.start('s-barrier', 1)
    await capture.awaitBegin('s-barrier', 1)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({ lockTimeoutMs: LOCK_BARRIER_TIMEOUT_MS })
    expect(recorded[0]!.waitDeadline).toBeGreaterThanOrEqual(startedAt + LOCK_BARRIER_TIMEOUT_MS)
    expect(recorded[0]!.waitDeadline).toBeLessThanOrEqual(Date.now() + LOCK_BARRIER_TIMEOUT_MS)

    await writeFile(join(worktree, 'a.txt'), 'one\ntwo\nthree\n', 'utf8')
    await capture.settle('s-barrier', 1)
    expect(recorded.at(-1)).toMatchObject({ lockTimeoutMs: undefined, waitDeadline: undefined })
  })

  it('容量治理拿不到跨进程锁时直接放弃本轮，不再申请第二次 before', async () => {
    await fixture()
    captureFor()
    const real = workspaceQueue.run
    let calls = 0
    workspaceQueue.run = <T>(): Promise<T> => {
      calls += 1
      return Promise.reject(new WorkspaceLockTimeoutError('workspace lock not acquired (barrier)'))
    }
    const ensure = vi.spyOn(retention, 'ensure')
    const captureSnapshot = vi.spyOn(snapshot, 'capture')
    try {
      capture.start('s-busy', 1)
      await capture.awaitBegin('s-busy', 1)
      expect(calls).toBe(1)
      expect(ensure).not.toHaveBeenCalled()
      expect(captureSnapshot).not.toHaveBeenCalled()
      const current = await ledger.load('s-busy')
      expect(current.turns.map(turn => turn.turn)).toEqual([1])
      expect(current.turns[0]?.unavailable).toBe(RUNNING_CHANGES_REASON_SNAPSHOT_FAILED)
      expect(current.turns[0]?.beforeRef).toBe('')
    }
    finally {
      workspaceQueue.run = real
      ensure.mockRestore()
      captureSnapshot.mockRestore()
    }
  })

  it('治理执行超过等待预算后仍在同一次持锁内捕获基线', async () => {
    const { worktree } = await fixture()
    const recorded = recordingQueue()
    const realEnsure = retention.ensure
    const realNow = Date.now
    let offset = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset)
    const ensure = vi.spyOn(retention, 'ensure').mockImplementation(async (store) => {
      const result = await realEnsure(store)
      offset = LOCK_BARRIER_TIMEOUT_MS + 1
      return result
    })
    const captureSnapshot = vi.spyOn(snapshot, 'capture')
    try {
      capture.start('s-slow-retention', 1)
      await capture.awaitBegin('s-slow-retention', 1)
      expect(recorded).toHaveLength(1)
      expect(Date.now()).toBeGreaterThan(recorded[0]!.waitDeadline!)
      expect(captureSnapshot).toHaveBeenCalledTimes(1)
      expect((await ledger.load('s-slow-retention')).turns).toEqual([])
      expect(capture.live('s-slow-retention')).toMatchObject({ active: true, turn: 1 })
    }
    finally {
      clock.mockRestore()
      ensure.mockRestore()
      captureSnapshot.mockRestore()
    }
    await writeFile(join(worktree, 'a.txt'), 'one\ntwo\nthree\n', 'utf8')
    await capture.settle('s-slow-retention', 1)
    const current = await ledger.load('s-slow-retention')
    expect(current.turns[0]?.unavailable).toBeNull()
    expect(current.turns[0]?.beforeRef).toBeTruthy()
    expect(current.turns[0]?.files).toHaveLength(1)
  })

  it('治理普通异常仍降级为空排除清单并完成基线', async () => {
    await fixture()
    const recorded = recordingQueue()
    const ensure = vi.spyOn(retention, 'ensure').mockRejectedValueOnce(new Error('retention failed'))
    const captureSnapshot = vi.spyOn(snapshot, 'capture')
    try {
      capture.start('s-retention-failed', 1)
      await capture.awaitBegin('s-retention-failed', 1)
      expect(recorded).toHaveLength(1)
      expect(captureSnapshot).toHaveBeenCalledTimes(1)
      expect(captureSnapshot.mock.calls[0]?.[3]?.exclude).toEqual([])
      expect(capture.live('s-retention-failed')).toMatchObject({ active: true, turn: 1 })
    }
    finally {
      ensure.mockRestore()
      captureSnapshot.mockRestore()
    }
  })
})
