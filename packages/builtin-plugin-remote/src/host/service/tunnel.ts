import type { RemoteTunnelConfig, RemoteTunnelEvent, RemoteTunnelMode, RemoteTunnelProgress, RemoteTunnelState, RemoteTunnelStatus } from '../types/index'
import type { TunnelProcess } from './tunnel.types'
import { defineService } from 'dsh-tauri'
import { messageOf } from '../../shared/error'
import { localUpstream, mintAuthenticatedUrl, tunnelRuntimeDeps } from '../config/runtime'
import { parseMetricsAddress, parseQuickTunnelUrl, probeCloudflaredReady, tokenTunnelEnv, tunnelArgs } from '../utils/cloudflared'
import { readAccessDocument, writeAccessDocument } from './access.utils'
import { gateway } from './gateway'

const ENTRY_ID = 'tunnel'

const ENTRY_PORT = 3089

const ENTRY_HOST = '127.0.0.1'

const EVENT_CAPACITY = 50

const LINE_LIMIT = 500

const STOP_GRACE_MS = 5_000

const PROGRESS_STEP_PERCENT = 5

const PROGRESS_MIN_INTERVAL_MS = 400

const RESTART_MAX_DELAY_MS = 16_000

const RESTART_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, RESTART_MAX_DELAY_MS]

// 运行时健康探针：cloudflared 连接器"假死"（进程存活但边缘连接全掉）既不退出也不报错，
// 只监听 onExit 的旧逻辑永远发现不了，面板一直显示运行中而公网地址实际已死。
// /ready 在正常重连期间同样是 503，单次失败无法区分"假死"与"正在自行重连"，
// 只有持续时长能区分，故两级升级：先可见降级，再强制重建。
const HEALTH_PROBE_INTERVAL_MS = 30_000

const HEALTH_PROBE_TIMEOUT_MS = 5_000

const HEALTH_DEGRADED_FAILURES = 3

const HEALTH_REBUILD_FAILURES = 10

const NO_LOCAL_UPSTREAM = '无法确定本机 DSH 端口（宿主 webserver 未暴露端口且进程缺少 DSH_WEB_PORT），未启动隧道'

const TOKEN_REQUIRED = '具名隧道需要 Tunnel Token（Cloudflare 控制台 → 隧道 → 安装连接器）'

const HOSTNAME_REQUIRED = '具名隧道需要公开主机名，用于拼链接与二维码'

let child: TunnelProcess | undefined

let state: RemoteTunnelState = 'stopped'

let url: string | undefined

let failure: string | undefined

let bound = 0

let stopping = false

let activation = 0

let queue: Promise<unknown> = Promise.resolve()

let sequence = 0

let events: RemoteTunnelEvent[] = []

let progress: RemoteTunnelProgress | undefined

let lastProgressAt = 0

let lastProgressPercent = -1

let restartTimer: NodeJS.Timeout | undefined

let restartAttempt = 0

let metricsAddress: string | undefined

let probeTimer: NodeJS.Timeout | undefined

let probeFailures = 0

let probing = false

/**
 * 健康探针判定假死后触发的重建链路：此期间不允许进入终态，网络恢复后仍要自愈。
 * 只有探活成功才清除——域名到达不证明边缘连接健康，且与 metrics 地址的先后顺序无关。
 * 代价是替代进程若始终不报 metrics 地址，重建会一直停在「启动中」而不是转成 error，
 * 与上游「健康重建永不进终态」的取舍一致；用户仍可手动停止。
 */
let rebuilding = false

/** 降级前的状态：探活自行恢复时据此还原面板文案，避免长期停在「启动中」。 */
let degradedFrom: RemoteTunnelState | undefined

/** 已退出的代次：进程退出后仍可能吐出缓冲中的日志，迟到的就绪不得再把状态改回运行中。 */
let exitedGeneration = -1

let killTimer: NodeJS.Timeout | undefined

export const tunnel = defineService({
  async status(): Promise<RemoteTunnelStatus> {
    const config = tunnelConfig()
    return {
      enabled: config.enabled,
      mode: config.mode,
      hostname: config.hostname,
      ...config.token === null ? {} : { token: config.token },
      state,
      events: [...events],
      ...url === undefined ? {} : { url },
      ...bound === 0 ? {} : { port: bound },
      ...progress === undefined ? {} : { progress },
      ...failure === undefined ? {} : { error: failure },
    }
  },

  assertStartable(mode: RemoteTunnelMode, token?: string, hostname?: string): void {
    tunnelConfigOf(mode, token, hostname)
  },

  async start(mode: RemoteTunnelMode, token?: string, hostname?: string): Promise<void> {
    await enqueue(async () => {
      persist(tunnelConfigOf(mode, token, hostname))
      await activate()
    })
  },

  async stop(): Promise<void> {
    await enqueue(async () => {
      persist({ ...tunnelConfig(), enabled: false })
      await deactivate('公网隧道已停止')
    })
  },

  async restore(): Promise<void> {
    await enqueue(async () => {
      const parsed = readAccessDocument()
      for (const warning of parsed.warnings)
        note('state', warning)
      if (!parsed.document.tunnel.enabled)
        return
      await activate()
    })
  },

  async dispose(): Promise<void> {
    await enqueue(async () => {
      await deactivate(undefined)
      state = 'stopped'
      failure = undefined
      url = undefined
      events = []
    })
  },
})

// --- internal ---
/** 启停串行化：并发 start/stop 会各起一个 cloudflared，这里保证同一时刻只有一次状态迁移。 */
function enqueue<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run, run)
  queue = next.then(() => undefined, () => undefined)
  return next
}

/** 进度写入：事件环按「每 5% 或 400ms」节流，避免下载把 50 条环形缓冲刷满。 */
function setProgress(next: RemoteTunnelProgress): void {
  progress = next
  if (next.stage !== 'download') {
    note('progress', progressLine(next))
    lastProgressAt = Date.now()
    lastProgressPercent = -1
    return
  }
  const now = Date.now()
  const percent = next.total === undefined || next.total <= 0 ? -1 : Math.floor((next.received ?? 0) * 100 / next.total)
  const advanced = percent < 0 ? lastProgressPercent < 0 : percent >= lastProgressPercent + PROGRESS_STEP_PERCENT
  if (!advanced || now - lastProgressAt < PROGRESS_MIN_INTERVAL_MS)
    return
  lastProgressAt = now
  lastProgressPercent = percent
  note('progress', progressLine(next))
}

function progressLine(entry: RemoteTunnelProgress): string {
  if (entry.stage === 'check')
    return '检查 cloudflared 可执行文件'
  if (entry.stage === 'download') {
    const source = entry.url === undefined ? '' : `（${entry.url}）`
    const amount = entry.total === undefined || entry.total <= 0
      ? `${formatBytes(entry.received ?? 0)}`
      : `${Math.floor((entry.received ?? 0) * 100 / entry.total)}% ${formatBytes(entry.received ?? 0)}/${formatBytes(entry.total)}`
    return `下载 cloudflared ${amount}${source}`
  }
  if (entry.stage === 'extract')
    return '解压 cloudflared 安装包'
  if (entry.stage === 'verify')
    return '校验 cloudflared 可执行文件'
  if (entry.stage === 'spawn')
    return '启动 cloudflared 进程'
  if (entry.stage === 'domain')
    return '等待分配 trycloudflare 域名'
  return '隧道已就绪'
}

function formatBytes(value: number): string {
  if (value < 1024)
    return `${value} B`
  if (value < 1024 * 1024)
    return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / 1024 / 1024).toFixed(1)} MiB`
}

function publicHostOf(value: string | undefined): string | undefined {
  if (value === undefined || value === '')
    return undefined
  try {
    return new URL(value).host
  }
  catch {
    return undefined
  }
}
function tunnelConfig(): RemoteTunnelConfig {
  return readAccessDocument().document.tunnel
}

function tunnelConfigOf(mode: RemoteTunnelMode, token: string | undefined, hostname: string | undefined): RemoteTunnelConfig {
  if (mode === 'token') {
    const credential = token?.trim() ?? ''
    const host = hostname?.trim() ?? ''
    if (credential === '')
      throw new Error(TOKEN_REQUIRED)
    if (host === '')
      throw new Error(HOSTNAME_REQUIRED)
    return { enabled: true, mode, token: credential, hostname: host }
  }
  return { enabled: true, mode: 'quick', token: null, hostname: null }
}

function persist(config: RemoteTunnelConfig): void {
  const parsed = readAccessDocument()
  if (parsed.corrupt)
    throw new Error('access.json 解析失败，已按未配置处理（请手工修复后再启用隧道）')
  writeAccessDocument({ ...parsed.document, tunnel: config })
}

async function activate(): Promise<void> {
  await deactivate(undefined)
  state = 'starting'
  failure = undefined
  url = undefined
  metricsAddress = undefined
  rebuilding = false
  degradedFrom = undefined
  setProgress({ stage: 'check' })
  try {
    const binary = await tunnelRuntimeDeps().resolveBinary(setProgress)
    bound = await listenGateway()
    launch(tunnelConfig(), binary, ++activation)
  }
  catch (error) {
    await fail(messageOf(error))
  }
}

/** 网关入口复用：自动重建沿用首次监听成功的端口，不打断已建立的本地回环入口。 */
async function listenGateway(): Promise<number> {
  const listing = gateway.status(ENTRY_ID)
  if (listing?.state === 'listening')
    return listing.port
  const upstream = localUpstream()
  if (upstream === undefined)
    throw new Error(NO_LOCAL_UPSTREAM)
  const entry = await gateway.start({
    id: ENTRY_ID,
    kind: 'tunnel',
    upstream,
    port: ENTRY_PORT,
    host: ENTRY_HOST,
    tokenProvider: mintAuthenticatedUrl,
    auth: () => tunnelRuntimeDeps().policy(),
    publicHost: () => publicHostOf(url),
  })
  return entry.port
}

/// 代次由调用方持有并递增：spawn 抛错时不能把代次一起推进，否则重试会拿着失效代次被丢弃。
function launch(config: RemoteTunnelConfig, executable: string, generation: number): void {
  metricsAddress = undefined
  exitedGeneration = -1
  setProgress({ stage: 'spawn' })
  const args = tunnelArgs(config.mode === 'token' ? undefined : `http://${ENTRY_HOST}:${bound}`)
  const env = config.mode === 'token' ? tokenTunnelEnv(config.token ?? '') : undefined
  child = tunnelRuntimeDeps().spawn(executable, args, {
    onLine: line => onLine(config.mode, line, generation),
    onExit: (code, signal) => onExit(code, signal, generation),
  }, env)
  note('state', `隧道入口已监听 ${ENTRY_HOST}:${bound}`)
  setProgress({ stage: 'domain' })
  note('process', config.mode === 'token'
    ? 'cloudflared 已启动，等待连接 Cloudflare 边缘'
    : 'cloudflared 已启动，等待分配 trycloudflare 域名')
}

async function deactivate(reason: string | undefined): Promise<void> {
  activation += 1
  restartAttempt = 0
  stopProbe()
  metricsAddress = undefined
  rebuilding = false
  degradedFrom = undefined
  if (restartTimer !== undefined) {
    clearTimeout(restartTimer)
    restartTimer = undefined
  }
  if (killTimer !== undefined) {
    clearTimeout(killTimer)
    killTimer = undefined
  }
  progress = undefined
  lastProgressPercent = -1
  const running = child
  child = undefined
  if (running !== undefined) {
    stopping = true
    running.kill('SIGTERM')
    const force = setTimeout(() => running.kill('SIGKILL'), STOP_GRACE_MS)
    try {
      await running.exited
    }
    finally {
      clearTimeout(force)
      stopping = false
    }
  }
  await gateway.stop(ENTRY_ID)
  bound = 0
  url = undefined
  if (state !== 'error' || reason !== undefined)
    state = 'stopped'
  if (reason !== undefined) {
    failure = undefined
    note('state', reason)
  }
}

async function fail(reason: string): Promise<void> {
  failure = reason
  state = 'error'
  note('state', `隧道未启动：${reason}`)
  await deactivate(undefined)
}

async function ready(next: string, generation: number): Promise<void> {
  restartAttempt = 0
  degradedFrom = undefined
  setProgress({ stage: 'ready' })
  state = 'running'
  url = next
  note('state', `公网隧道已就绪：${next}`)
  if (metricsAddress === undefined)
    note('state', '未识别到 cloudflared metrics 地址，健康探活将在地址出现后启用')
  startProbe(generation)
}

function onLine(mode: RemoteTunnelMode, line: string, generation: number): void {
  // 迟到的日志必须按代次丢弃：进程已退出后仍可能吐出缓冲输出，若照常走就绪判定，
  // 会把状态改回运行中并让排定的重建再起一个 cloudflared（两个进程抢同一隧道）。
  if (generation !== activation || generation === exitedGeneration)
    return
  const trimmed = line.trim()
  if (trimmed === '')
    return
  note('process', trimmed.slice(0, LINE_LIMIT))
  if (metricsAddress === undefined) {
    const address = parseMetricsAddress(trimmed)
    if (address !== undefined) {
      metricsAddress = address
      startProbe(generation)
    }
  }
  if (mode !== 'quick' || state === 'running')
    return
  const found = parseQuickTunnelUrl(trimmed)
  if (found === undefined)
    return
  try {
    persist({ ...tunnelConfig(), hostname: hostOf(found) })
  }
  catch (error) {
    // access.json 损坏时写入会抛错：这里必须自己兜住，否则异常从子进程日志回调里冒出去。
    void enqueue(async () => {
      if (generation === activation)
        await fail(`已拿到隧道域名但无法落盘：${messageOf(error)}`)
    })
    return
  }
  void ready(found, generation)
}

function onExit(code: number | null, signal: NodeJS.Signals | null, generation: number): void {
  if (generation !== activation)
    return
  exitedGeneration = generation
  stopProbe()
  if (killTimer !== undefined) {
    clearTimeout(killTimer)
    killTimer = undefined
  }
  child = undefined
  if (stopping)
    return
  // gateway 是长驻入口：异常退出只重建 cloudflared，隧道域名失效但本地端口留着给重试复用。
  state = 'starting'
  url = undefined
  scheduleRestart(generation, `cloudflared 已退出（${signal ?? code ?? '未知原因'}）`)
}

/** 退避重建：重试期间保持 starting 且不写 failure，面板继续显示「启动中」而不是「异常」。 */
function scheduleRestart(generation: number, reason: string): void {
  note('state', reason)
  const exhausted = restartAttempt >= RESTART_DELAYS_MS.length
  // 健康探针触发的重建不设终态上限：长时断网时 cloudflared 自身也是无限退避重连，
  // 这里保持同样语义，网络恢复后仍会自愈；退避仍随次数增长并封顶，不会变成重启风暴。
  if (exhausted && !rebuilding) {
    void enqueue(async () => {
      if (generation !== activation)
        return
      await exhaust(`${reason}；已自动重建 ${RESTART_DELAYS_MS.length} 次仍失败，请手动重试`)
    })
    return
  }
  const delay = RESTART_DELAYS_MS[restartAttempt] ?? RESTART_MAX_DELAY_MS
  restartAttempt += 1
  note('state', exhausted
    ? `${delay / 1000} 秒后继续重建隧道（已重建 ${restartAttempt} 次；判定假死后的重建不设上限，网络恢复后会自动重连）`
    : `${delay / 1000} 秒后重建隧道（第 ${restartAttempt}/${RESTART_DELAYS_MS.length} 次）`)
  restartTimer = setTimeout(() => {
    restartTimer = undefined
    void enqueue(() => retry(generation))
  }, delay)
}

async function retry(generation: number): Promise<void> {
  if (generation !== activation)
    return
  try {
    const binary = await tunnelRuntimeDeps().resolveBinary()
    bound = await listenGateway()
    launch(tunnelConfig(), binary, ++activation)
  }
  catch (error) {
    scheduleRestart(generation, `隧道重建失败：${messageOf(error)}`)
  }
}

/** 重试耗尽才进入 error：此时隧道确实不可用，才拆掉本地入口并留给用户手动重试。 */
async function exhaust(reason: string): Promise<void> {
  failure = reason
  state = 'error'
  note('state', failure)
  await deactivate(undefined)
}

/** 探活只在拿到 metrics 地址后才有意义；地址迟到时由 onLine 补启，避免安全网永久不启用。 */
function startProbe(generation: number): void {
  if (metricsAddress === undefined)
    return
  stopProbe()
  // 探针跑在定时器里：任何逃逸异常都会变成未捕获异常直接结束宿主进程，
  // 那正是探针本该防止的事故，所以这里必须自己兜住。
  probeTimer = setInterval(() => {
    probeOnce(generation).catch(() => undefined)
  }, HEALTH_PROBE_INTERVAL_MS)
  probeTimer.unref()
}

function stopProbe(): void {
  if (probeTimer !== undefined) {
    clearInterval(probeTimer)
    probeTimer = undefined
  }
  probeFailures = 0
  probing = false
}

async function probeOnce(generation: number): Promise<void> {
  const address = metricsAddress
  if (probing || address === undefined || generation !== activation)
    return
  probing = true
  let result: { healthy: boolean, reason?: string }
  try {
    result = await probeCloudflaredReady(address, HEALTH_PROBE_TIMEOUT_MS)
  }
  catch (error) {
    result = { healthy: false, reason: messageOf(error) }
  }
  finally {
    probing = false
  }
  if (generation !== activation || state === 'stopped')
    return
  if (result.healthy) {
    markHealthy()
    return
  }
  probeFailures += 1
  const reason = result.reason ?? '未知原因'
  if (probeFailures === HEALTH_DEGRADED_FAILURES) {
    // 第一级只让降级可见，不杀进程：/ready 为 503 也可能只是 cloudflared 正按自身退避重连，
    // 过早介入会把本可自愈的故障变成人工故障。
    degradedFrom = state
    state = 'starting'
    note('state', `健康探活连续 ${probeFailures} 次失败（${reason}）：连接器已无健康边缘连接，观察能否自行恢复（${probeFailures}/${HEALTH_REBUILD_FAILURES}）`)
    return
  }
  if (probeFailures < HEALTH_REBUILD_FAILURES) {
    note('state', `健康探活第 ${probeFailures}/${HEALTH_REBUILD_FAILURES} 次失败：${reason}`)
    return
  }
  forceRebuild()
}

function markHealthy(): void {
  if (probeFailures >= HEALTH_DEGRADED_FAILURES) {
    note('state', `隧道健康探活已自行恢复（此前连续失败 ${probeFailures} 次）`)
    if (degradedFrom !== undefined) {
      state = degradedFrom
      degradedFrom = undefined
    }
  }
  probeFailures = 0
  rebuilding = false
}

/** 第二级：持续不恢复即判定假死。只终止进程，重建交给既有 onExit → scheduleRestart 链路。 */
function forceRebuild(): void {
  const running = child
  note('state', `健康探活连续 ${HEALTH_REBUILD_FAILURES} 次失败（约 ${Math.round(HEALTH_REBUILD_FAILURES * HEALTH_PROBE_INTERVAL_MS / 60_000)} 分钟）：判定连接器假死，终止进程以触发重建`)
  rebuilding = true
  stopProbe()
  if (running === undefined)
    return
  running.kill('SIGTERM')
  killTimer = setTimeout(() => running.kill('SIGKILL'), STOP_GRACE_MS)
  killTimer.unref()
}

function hostOf(value: string): string | null {
  try {
    return new URL(value).hostname
  }
  catch {
    return null
  }
}

function note(kind: RemoteTunnelEvent['kind'], line: string): void {
  sequence += 1
  events = [...events, { seq: sequence, ts: new Date().toISOString(), kind, line }].slice(-EVENT_CAPACITY)
}
