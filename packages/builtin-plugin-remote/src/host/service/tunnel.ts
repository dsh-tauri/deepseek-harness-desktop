import type { RemoteTunnelConfig, RemoteTunnelEvent, RemoteTunnelMode, RemoteTunnelProgress, RemoteTunnelState, RemoteTunnelStatus } from '../types/index'
import type { TunnelProcess } from './tunnel.types'
import { defineService } from 'dsh-tauri'
import { messageOf } from '../../shared/error'
import { localUpstream, mintAuthenticatedUrl, tunnelRuntimeDeps } from '../config/runtime'
import { parseQuickTunnelUrl, tokenTunnelEnv, tunnelArgs } from '../utils/cloudflared'
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

const RESTART_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000]

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
  setProgress({ stage: 'check' })
  try {
    const binary = await tunnelRuntimeDeps().resolveBinary(setProgress)
    bound = await listenGateway()
    launch(tunnelConfig(), binary)
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

function launch(config: RemoteTunnelConfig, executable: string): void {
  setProgress({ stage: 'spawn' })
  const args = tunnelArgs(config.mode === 'token' ? undefined : `http://${ENTRY_HOST}:${bound}`)
  const env = config.mode === 'token' ? tokenTunnelEnv(config.token ?? '') : undefined
  const generation = ++activation
  child = tunnelRuntimeDeps().spawn(executable, args, {
    onLine: line => onLine(config.mode, line, generation),
    onExit: (code, signal) => onExit(code, signal, generation),
  }, env)
  if (generation !== activation) {
    // 本次激活已被并发 stop 取代：立刻回收刚起的进程，避免留下孤儿 cloudflared
    child.kill('SIGTERM')
    child = undefined
    return
  }
  note('state', `隧道入口已监听 ${ENTRY_HOST}:${bound}`)
  if (config.mode === 'token') {
    void ready(`https://${config.hostname ?? ''}`)
    return
  }
  setProgress({ stage: 'domain' })
  note('process', 'cloudflared 已启动，等待分配 trycloudflare 域名')
}

async function deactivate(reason: string | undefined): Promise<void> {
  activation += 1
  restartAttempt = 0
  if (restartTimer !== undefined) {
    clearTimeout(restartTimer)
    restartTimer = undefined
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

async function ready(next: string): Promise<void> {
  restartAttempt = 0
  setProgress({ stage: 'ready' })
  state = 'running'
  url = next
  note('state', `公网隧道已就绪：${next}`)
}

function onLine(mode: RemoteTunnelMode, line: string, generation: number): void {
  if (generation !== activation)
    return
  const trimmed = line.trim()
  if (trimmed === '')
    return
  note('process', trimmed.slice(0, LINE_LIMIT))
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
  void ready(found)
}

function onExit(code: number | null, signal: NodeJS.Signals | null, generation: number): void {
  if (generation !== activation)
    return
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
  const delay = RESTART_DELAYS_MS[restartAttempt]
  if (delay === undefined) {
    void enqueue(async () => {
      if (generation !== activation)
        return
      await exhaust(`${reason}；已自动重建 ${RESTART_DELAYS_MS.length} 次仍失败，请手动重试`)
    })
    return
  }
  restartAttempt += 1
  note('state', `${delay / 1000} 秒后重建隧道（第 ${restartAttempt}/${RESTART_DELAYS_MS.length} 次）`)
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
    launch(tunnelConfig(), binary)
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
