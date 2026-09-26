/**
 * The plugin's own HTTP API, mounted by the plugin on `ctx.webServer` under
 * `/api-ssh` (same-origin with the web UI; no upstream gateway changes).
 * Loopback-only by construction: non-loopback peers are refused before any
 * dispatch. The protocol is a minimal JSON envelope:
 *
 *   POST /api-ssh  { "method": "machine.list", "payload": {} }
 *   → 200          { "ok": true, "value": ... } | { "ok": false, "error": { "code", "message" } }
 *
 * The plugin state lives in the plugin-owned state document; this API serves
 * the feature switch (`settings.get`/`settings.set`), the connection plane
 * (list/test/connect/disconnect/install), the per-machine bootstrap event
 * drain (`machine.events`: ring-buffered, seq-cursored polling — no
 * SSE/WebSocket), and the CRUD writes (save/remove), which is exactly what the
 * settings page cannot do through the settings domain.
 * @module dsh-tauri-ssh/host/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { MachineSaveRow, MachineSecretWrite, MachineView, SshInstallResult, SshMachineEventsPage, SshMachineStatus, SshTestResult, SyncApplyResult, SyncPluginRef, SyncPreview, SyncSkillRef, SyncSkillRoot } from '../types/index'
import { Buffer } from 'node:buffer'
import { MachineId, SshError } from '../types/index'

/** One request envelope. */
export interface SshApiRequest {
  method: string
  payload?: unknown
}

/** One response envelope. */
export type SshApiResponse
  = | { ok: true, value: unknown }
    | { ok: false, error: { code: string, message: string } }

/**
 * The connection-plane method set (CRUD lives here too: the settings domain
 * only serves an upstream allowlist, so the page writes through this route),
 * the plugin state switch, plus the S4-owned `sync.*` surface.
 */
export type SshApiMethod
  = | 'machine.list'
    | 'machine.test'
    | 'machine.connect'
    | 'machine.disconnect'
    | 'machine.install'
    | 'machine.events'
    | 'machine.save'
    | 'machine.remove'
    | 'session.role'
    | 'settings.get'
    | 'settings.set'
    | 'sync.preview'
    | 'sync.apply'

/** A machine list row: the redacted profile plus its live status. */
export interface SshMachineListItem extends MachineView {
  state: SshMachineStatus['state']
  tunnelBaseUrl?: string
  lastError?: string
  dshMissing?: boolean
  /** Epoch ms of the next scheduled reconnect retry (while reconnecting). */
  nextRetryAt?: number
  /** Which credential the live (or last successful) connection used. */
  authMethod?: SshMachineStatus['authMethod']
  /** Live progress of the in-flight operation. */
  progress?: SshMachineStatus['progress']
}

/** The manager face this API needs (the plugin's service). */
export interface SshApiHost {
  /** Whether this host instance is itself a remote target of an SSH session. */
  sessionRole: () => { remote: boolean, origin?: string }
  /** Whether the SSH feature is switched on. */
  enabled: () => boolean
  /** Flip the feature switch. */
  setEnabled: (enabled: boolean) => Promise<void>
  profileViews: () => MachineView[]
  /** The read-only `~/.ssh/config` alias machines (awaits the config read). */
  discoveredViews: () => Promise<MachineView[]>
  status: (machineId: MachineId) => SshMachineStatus
  test: (machineId: MachineId, signal?: AbortSignal) => Promise<SshTestResult>
  connect: (machineId: MachineId, signal?: AbortSignal) => Promise<{ tunnelBaseUrl: string }>
  disconnect: (machineId: MachineId) => Promise<void>
  /** One-shot remote dsh install; a successful install auto-connects. */
  install: (machineId: MachineId, signal?: AbortSignal) => Promise<SshInstallResult>
  /** Drain one machine's bootstrap log/progress events after a seq cursor. */
  events: (machineId: MachineId, sinceSeq?: number) => SshMachineEventsPage
  save: (machineId: MachineId, row: MachineSaveRow, secrets?: MachineSecretWrite) => Promise<void>
  remove: (machineId: MachineId) => Promise<void>
  /** The local plugins and skills available to sync (the selection list). */
  syncPreview: () => SyncPreview
  /** Sync the selection to one machine; every item settles in the result. */
  syncApply: (machineId: MachineId, plugins: SyncPluginRef[], skills: SyncSkillRef[]) => Promise<SyncApplyResult>
}

/** Whether a socket peer is loopback (the only allowed caller of this API). */
export function isLoopbackPeer(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Map one business failure onto the envelope. */
function failureOf(error: unknown): { code: string, message: string } {
  if (error instanceof SshError) {
    return { code: error.code, message: error.message }
  }
  return { code: 'internal', message: error instanceof Error ? error.message : String(error) }
}

/** Read and parse the request body (bounded). */
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > 64 * 1024)
      throw new Error('request body too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

/**
 * The origins the desktop shell's webview may cross-origin read this API from:
 * the Tauri 2 shell schemes (macOS/Linux `tauri://localhost`, Windows
 * `http://tauri.localhost`) and the dev-shell Vite origin. The embedded web UI
 * itself is same-origin and needs none of this; without these headers the
 * shell's switcher poll (`fetch` from the webview) is CORS-blocked with a bare
 * "Load failed". Any other origin stays blocked, so a rogue local page cannot
 * read (or preflight into) the API.
 */
const SHELL_ORIGINS = new Set([
  'tauri://localhost',
  'http://tauri.localhost',
  'http://localhost:1420',
])

/** CORS headers for one request's Origin, or none when the origin is not a shell origin. */
function shellCorsHeaders(origin: string | undefined): Record<string, string> {
  if (origin === undefined || !SHELL_ORIGINS.has(origin))
    return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    'vary': 'Origin',
  }
}

/**
 * Build the `/api-ssh` request handler over one service.
 * @param host - the manager-backed service face.
 * @returns the node:http handler (owns the full response lifecycle).
 */
export function createSshApiHandler(host: SshApiHost): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const cors = shellCorsHeaders(req.headers.origin)
    const respond = (status: number, body: SshApiResponse): void => {
      res.writeHead(status, { 'content-type': 'application/json', ...cors })
      res.end(JSON.stringify(body))
    }
    if (!isLoopbackPeer(req.socket.remoteAddress)) {
      respond(403, { ok: false, error: { code: 'forbidden', message: 'this API is loopback-only' } })
      return
    }
    // CORS preflight from the shell webview: answer without touching the body.
    if (req.method === 'OPTIONS') {
      if (cors['access-control-allow-origin'] === undefined) {
        respond(403, { ok: false, error: { code: 'forbidden', message: 'origin not allowed' } })
        return
      }
      res.writeHead(204, cors)
      res.end()
      return
    }
    if (req.method !== 'POST') {
      respond(405, { ok: false, error: { code: 'method-not-allowed', message: 'POST only' } })
      return
    }
    let request: SshApiRequest
    try {
      request = await readBody(req) as SshApiRequest
    }
    catch {
      respond(400, { ok: false, error: { code: 'bad-request', message: 'malformed JSON body' } })
      return
    }
    if (typeof request.method !== 'string' || request.method === '') {
      respond(400, { ok: false, error: { code: 'bad-request', message: 'missing method' } })
      return
    }
    const payload = (request.payload ?? {}) as Record<string, unknown>
    try {
      switch (request.method as SshApiMethod) {
        case 'session.role': {
          respond(200, { ok: true, value: host.sessionRole() })
          return
        }
        case 'settings.get': {
          respond(200, { ok: true, value: { enabled: host.enabled() } })
          return
        }
        case 'settings.set': {
          const enabled = enabledOf(payload)
          await host.setEnabled(enabled)
          respond(200, { ok: true, value: { enabled } })
          return
        }
        case 'machine.list': {
          // 未启用：不枚举任何机器（不读 ~/.ssh/config，也不碰连接面），只回报开关，
          // 壳层据此不渲染「本地」控件。
          if (!host.enabled()) {
            respond(200, { ok: true, value: { enabled: false, items: [], discovered: [] } })
            return
          }
          const items: SshMachineListItem[] = host.profileViews().map(view => listItemOf(host, view))
          const discovered: SshMachineListItem[] = (await host.discoveredViews()).map(view => listItemOf(host, view))
          respond(200, { ok: true, value: { enabled: true, items, discovered } })
          return
        }
        case 'machine.test': {
          const value = await host.test(machineIdOf(payload), new AbortController().signal)
          respond(200, { ok: true, value })
          return
        }
        case 'machine.connect': {
          const link = await host.connect(machineIdOf(payload), new AbortController().signal)
          respond(200, { ok: true, value: { tunnelBaseUrl: link.tunnelBaseUrl } })
          return
        }
        case 'machine.disconnect': {
          await host.disconnect(machineIdOf(payload))
          respond(200, { ok: true, value: {} })
          return
        }
        case 'machine.install': {
          const value = await host.install(machineIdOf(payload), new AbortController().signal)
          respond(200, { ok: true, value })
          return
        }
        case 'machine.events': {
          const machineId = machineIdOf(payload)
          const sinceSeq = sinceSeqOf(payload)
          respond(200, { ok: true, value: host.events(machineId, sinceSeq) })
          return
        }
        case 'machine.save': {
          const machineId = machineIdOf(payload)
          const row = saveRowOf(payload)
          const secrets = secretsOf(payload)
          await host.save(machineId, row, secrets)
          respond(200, { ok: true, value: {} })
          return
        }
        case 'machine.remove': {
          const machineId = machineIdOf(payload)
          await host.remove(machineId)
          respond(200, { ok: true, value: {} })
          return
        }
        case 'sync.preview': {
          respond(200, { ok: true, value: host.syncPreview() })
          return
        }
        case 'sync.apply': {
          const machineId = machineIdOf(payload)
          const value = await host.syncApply(machineId, pluginRefsOf(payload), skillRefsOf(payload))
          respond(200, { ok: true, value })
          return
        }
        default:
          respond(404, { ok: false, error: { code: 'unknown-method', message: `unknown method "${request.method}"` } })
      }
    }
    catch (error) {
      respond(200, { ok: false, error: failureOf(error) })
    }
  }
}

/** Read the machineId payload field; missing payloads fail loud. */
function machineIdOf(payload: Record<string, unknown>): MachineId {
  if (typeof payload.machineId !== 'string' || payload.machineId === '') {
    throw new Error('missing machineId')
  }
  return MachineId(payload.machineId)
}

/** Read the settings.set payload; a non-boolean switch fails loud. */
function enabledOf(payload: Record<string, unknown>): boolean {
  if (typeof payload.enabled !== 'boolean')
    throw new Error('missing enabled')
  return payload.enabled
}

/** Read the optional event poll cursor; absent or non-numeric means "from the start". */
function sinceSeqOf(payload: Record<string, unknown>): number | undefined {
  if (payload.sinceSeq === undefined)
    return undefined
  if (typeof payload.sinceSeq !== 'number' || !Number.isInteger(payload.sinceSeq) || payload.sinceSeq < 0) {
    throw new Error('invalid sinceSeq')
  }
  return payload.sinceSeq
}

/** One list row: the redacted view plus its live status. */
function listItemOf(host: SshApiHost, view: MachineView): SshMachineListItem {
  const status = host.status(view.id)
  return {
    ...view,
    state: status.state,
    ...status.tunnelBaseUrl === undefined ? {} : { tunnelBaseUrl: status.tunnelBaseUrl },
    ...status.lastError === undefined ? {} : { lastError: status.lastError },
    ...status.dshMissing === true ? { dshMissing: true } : {},
    ...status.progress === undefined ? {} : { progress: status.progress },
    ...status.nextRetryAt === undefined ? {} : { nextRetryAt: status.nextRetryAt },
    ...status.authMethod === undefined ? {} : { authMethod: status.authMethod },
  }
}

/** Validate one machine.save config row; defaults mirror the schema. */
function saveRowOf(payload: Record<string, unknown>): MachineSaveRow {
  const row = payload.row
  if (typeof row !== 'object' || row === null)
    throw new Error('missing row')
  const value = row as Record<string, unknown>
  if (typeof value.name !== 'string' || value.name === '')
    throw new Error('invalid row: name')
  if (typeof value.host !== 'string' || value.host === '')
    throw new Error('invalid row: host')
  if (typeof value.user !== 'string')
    throw new Error('invalid row: user')
  const port = typeof value.port === 'number' ? value.port : 22
  const remotePort = typeof value.remotePort === 'number' ? value.remotePort : 3080
  const startCommand = typeof value.startCommand === 'string' && value.startCommand !== ''
    ? value.startCommand
    : undefined
  const rawProfileName = typeof value.profileName === 'string' ? value.profileName.trim() : ''
  const profileName = /^[\w-]+$/.test(rawProfileName) ? rawProfileName : undefined
  const color = typeof value.color === 'string' && value.color !== '' ? value.color : undefined
  return {
    name: value.name,
    host: value.host,
    port,
    user: value.user,
    remotePort,
    ...profileName === undefined ? {} : { profileName },
    ...startCommand === undefined ? {} : { startCommand },
    ...color === undefined ? {} : { color },
    ...value.tintBorder === true ? { tintBorder: true } : {},
  }
}

/** Validate the write-only secret block; absent or empty fields are dropped. */
function secretsOf(payload: Record<string, unknown>): MachineSecretWrite | undefined {
  const secrets = payload.secrets
  if (secrets === undefined)
    return undefined
  if (typeof secrets !== 'object' || secrets === null)
    throw new Error('invalid secrets')
  const value = secrets as Record<string, unknown>
  const out: MachineSecretWrite = {}
  if (typeof value.password === 'string' && value.password !== '')
    out.password = value.password
  if (typeof value.passphrase === 'string' && value.passphrase !== '')
    out.passphrase = value.passphrase
  return out
}

/** Validate the sync.apply plugin refs; the panel sends its display names along. */
function pluginRefsOf(payload: Record<string, unknown>): SyncPluginRef[] {
  const list = payload.plugins
  if (list === undefined)
    return []
  if (!Array.isArray(list))
    throw new Error('invalid plugins')
  return list.map((entry) => {
    if (typeof entry !== 'object' || entry === null)
      throw new Error('invalid plugin ref')
    const ref = entry as Record<string, unknown>
    if (typeof ref.name !== 'string' || typeof ref.spec !== 'string' || ref.spec === '')
      throw new Error('invalid plugin ref')
    return { name: ref.name, spec: ref.spec }
  })
}

/** Validate the sync.apply skill refs; the root picks the local source tree. */
function skillRefsOf(payload: Record<string, unknown>): SyncSkillRef[] {
  const list = payload.skills
  if (list === undefined)
    return []
  if (!Array.isArray(list))
    throw new Error('invalid skills')
  return list.map((entry) => {
    if (typeof entry !== 'object' || entry === null)
      throw new Error('invalid skill ref')
    const ref = entry as Record<string, unknown>
    if (typeof ref.name !== 'string' || ref.name === '')
      throw new Error('invalid skill ref')
    if (ref.root !== 'dsh' && ref.root !== 'agents')
      throw new Error('invalid skill ref: root')
    return { name: ref.name, root: ref.root as SyncSkillRoot }
  })
}
