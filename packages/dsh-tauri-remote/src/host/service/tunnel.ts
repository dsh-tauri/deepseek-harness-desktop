import type { RemoteTunnelConfig, RemoteTunnelEvent, RemoteTunnelMode, RemoteTunnelState, RemoteTunnelStatus } from '../types/index'
import type { TunnelProcess } from './tunnel.types'
import { defineService } from 'dsh-tauri'
import { messageOf } from '../../shared/error'
import { localUpstream, mintAuthenticatedUrl, tunnelRuntimeDeps } from '../config/runtime'
import { parseQuickTunnelUrl, quickTunnelArgs, tokenTunnelArgs } from '../utils/cloudflared'
import { readAccessDocument, writeAccessDocument } from './access.utils'
import { gateway } from './gateway'

const ENTRY_ID = 'tunnel'

const ENTRY_PORT = 3089

const ENTRY_HOST = '127.0.0.1'

const EVENT_CAPACITY = 50

const LINE_LIMIT = 500

const STOP_GRACE_MS = 5_000

const NO_LOCAL_UPSTREAM = '无法确定本机 DSH 端口（宿主 webserver 未暴露端口且进程缺少 DSH_WEB_PORT），未启动隧道'

const TOKEN_REQUIRED = '具名隧道需要 Tunnel Token（Cloudflare 控制台 → 隧道 → 安装连接器）'

const HOSTNAME_REQUIRED = '具名隧道需要公开主机名，用于拼链接与二维码'

let child: TunnelProcess | undefined

let state: RemoteTunnelState = 'stopped'

let url: string | undefined

let failure: string | undefined

let bound = 0

let stopping = false

let sequence = 0

let events: RemoteTunnelEvent[] = []

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
      ...failure === undefined ? {} : { error: failure },
    }
  },

  async start(mode: RemoteTunnelMode, token?: string, hostname?: string): Promise<void> {
    persist(tunnelConfigOf(mode, token, hostname))
    await activate()
  },

  async stop(): Promise<void> {
    persist({ ...tunnelConfig(), enabled: false })
    await deactivate('公网隧道已停止')
  },

  async restore(): Promise<void> {
    const parsed = readAccessDocument()
    for (const warning of parsed.warnings)
      note('state', warning)
    if (!parsed.document.tunnel.enabled)
      return
    await activate()
  },

  async dispose(): Promise<void> {
    await deactivate(undefined)
    state = 'stopped'
    failure = undefined
    url = undefined
    events = []
  },
})

// --- internal ---
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
  const config = tunnelConfig()
  const upstream = localUpstream()
  if (upstream === undefined) {
    await fail(NO_LOCAL_UPSTREAM)
    return
  }
  state = 'starting'
  failure = undefined
  url = undefined
  try {
    const binary = await tunnelRuntimeDeps().resolveBinary()
    const entry = await gateway.start({
      id: ENTRY_ID,
      kind: 'tunnel',
      upstream,
      port: ENTRY_PORT,
      host: ENTRY_HOST,
      tokenProvider: mintAuthenticatedUrl,
      auth: () => tunnelRuntimeDeps().policy(),
    })
    bound = entry.port
    const args = config.mode === 'token' ? tokenTunnelArgs(config.token ?? '') : quickTunnelArgs(`http://${ENTRY_HOST}:${entry.port}`)
    child = tunnelRuntimeDeps().spawn(binary, args, {
      onLine: line => onLine(config.mode, line),
      onExit: (code, signal) => onExit(code, signal),
    })
    note('state', `隧道入口已监听 ${ENTRY_HOST}:${entry.port}`)
    if (config.mode === 'token')
      await ready(`https://${config.hostname ?? ''}`)
    else
      note('process', 'cloudflared 已启动，等待分配 trycloudflare 域名')
  }
  catch (error) {
    await fail(messageOf(error))
  }
}

async function deactivate(reason: string | undefined): Promise<void> {
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
  if (state !== 'error')
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
  state = 'running'
  url = next
  note('state', `公网隧道已就绪：${next}`)
}

function onLine(mode: RemoteTunnelMode, line: string): void {
  const trimmed = line.trim()
  if (trimmed === '')
    return
  note('process', trimmed.slice(0, LINE_LIMIT))
  if (mode !== 'quick' || state === 'running')
    return
  const found = parseQuickTunnelUrl(trimmed)
  if (found === undefined)
    return
  persist({ ...tunnelConfig(), hostname: hostOf(found) })
  void ready(found)
}

function onExit(code: number | null, signal: NodeJS.Signals | null): void {
  child = undefined
  bound = 0
  if (stopping)
    return
  state = 'error'
  url = undefined
  failure = `cloudflared 已退出（${signal ?? code ?? '未知原因'}）`
  note('state', failure)
  void gateway.stop(ENTRY_ID)
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
