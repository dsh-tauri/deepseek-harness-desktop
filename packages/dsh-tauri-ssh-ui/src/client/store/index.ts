/**
 * State owner of the SSH-machines settings page. Everything goes through the
 * host plugin's same-origin `/api-ssh` route: machine.list serves the config
 * rows (secrets replaced by presence flags), the live statuses, and the
 * connection plane; machine.save/machine.remove are the CRUD writes. The
 * upstream settings RPC is deliberately NOT used for this namespace — its
 * configuration-client allowlist is hard-coded upstream, and the plugin must
 * stay zero-upstream-change. Framework-agnostic: tests inject a fake fetch.
 * @module dsh-tauri-ssh-ui/client/store
 */

import type { SshKey } from '../locales/index'
import type { MachineLifecycleState, SshMachineEvent, SyncApplyResult, SyncItemResult, SyncPreview } from '../types/index'
import { SSH_API_PATH } from '../constants/index'
import { isLifecycleState } from '../types/index'

/**
 * A published notice: `text` carries host-provided words verbatim (banner /
 * failure message); `key` is a store-generated literal rendered through the
 * locale table (params folded by `{name}` replacement at render time).
 */
export type MachinesNotice
  = | { kind: 'text', text: string }
    | { kind: 'key', key: SshKey, params?: Record<string, string> }

/** One redacted machine row (secret fields live only in the form). */
export interface MachineRow {
  id: string
  name: string
  host: string
  port: number
  user: string
  hasPassword: boolean
  hasPassphrase: boolean
  remotePort: number
  profileName?: string
  startCommand?: string
  /** Optional identity color (any CSS color) shown as the machine's pip. */
  color?: string
  /** Whether the identity color also tints the machine card's border. */
  tintBorder?: boolean
}

/** Secret values the operator typed into the form (write-only direction). */
export interface SecretValues {
  password?: string
  passphrase?: string
}

/** The pipeline phases one connection-plane operation walks through. */
export type ProgressPhase = 'handshake' | 'installing' | 'starting' | 'probing' | 'syncing'

/** Live transport status of one machine, from the /api-ssh list. */
export interface MachineStatus {
  /** The C-STATE vocabulary (S3-owned); unknown wire values read as disconnected. */
  state: MachineLifecycleState
  /** While reconnecting: epoch ms of the next scheduled retry (S3-owned field). */
  nextRetryAt?: number
  /** Which credential the live (or last successful) connection used; registered, not rendered. */
  authMethod?: 'agent' | 'key' | 'password'
  tunnelBaseUrl?: string
  lastError?: string
  /** Whether the last failure was "dsh not installed on the remote" (offers install). */
  dshMissing?: boolean
  /** Live progress of the in-flight operation (phase codes translated by the UI). */
  progress?: { phase: ProgressPhase, attempt?: number, total?: number, item?: string, log?: string }
}

/** Outcome of a machine.install call (the host's install result). */
export interface InstallResult {
  dshPath: string
  credentialsCopied: boolean
  credentialsError?: string
}

/** One machine row as the /api-ssh machine.list method returns it. */
export interface MachineListItem extends MachineRow, MachineStatus {}

/** The /api-ssh envelope (host plugin protocol). */
export type SshApiResponse
  = | { ok: true, value: unknown }
    | { ok: false, error: { code: string, message: string } }

/** The sync panel's slice of the page state. */
export interface SyncPanelState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  /** The selectable plugins and skills (null until a preview lands). */
  preview: SyncPreview | null
  /** Whether a sync.apply is in flight. */
  applying: boolean
  /**
   * Apply outcomes keyed by item (kind:root:name); a retry overwrites its own
   * entries instead of dropping the earlier batch, so the list stays a running
   * record of this page. Null before the first apply.
   */
  results: SyncItemResult[] | null
}

/** Page state published to the component through the snapshot seam. */
export interface MachinesPageState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  /** Whether the SSH feature is switched on; null until settings.get answers. */
  enabled: boolean | null
  /** Whether a settings.set enable call is in flight. */
  enabling: boolean
  /** Redacted machine rows in settings order (the stored, editable set). */
  machines: MachineRow[]
  /** Read-only rows discovered from the host's ~/.ssh/config (aliases). */
  discovered: MachineRow[]
  /** Live status per machine id. */
  statuses: Record<string, MachineStatus>
  /** Streaming log lines per machine id (the S2 event channel; capped tail). */
  logs: Record<string, string[]>
  /** Observed progress-phase sequence per machine id (the step rail's truth). */
  trails: Record<string, ProgressPhase[]>
  /** One in-flight connection-plane op per machine id. */
  busy: Record<string, 'test' | 'connect' | 'disconnect' | 'install'>
  /** The latest connection-plane outcome, shown in the banner. */
  notice: MachinesNotice | null
  /** The latest install outcome per machine id (shown under the card). */
  installResults: Record<string, InstallResult>
  /** The sync-to-remote panel state. */
  sync: SyncPanelState
  /** This instance's session role (a remote target renders the read-only banner). */
  role: { remote: boolean, origin?: string } | null
}

/** The fetch seam (window.fetch in the browser, fakes in tests). */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>

/** uSES-compatible snapshot store (getSnapshot returns a fresh object per update). */
export interface SnapshotStore<T> {
  getSnapshot: () => T
  subscribe: (listener: () => void) => () => void
}

/** Create a snapshot store around one mutable state object. */
export function createSnapshotStore<T>(initial: T): SnapshotStore<T> & { update: (mutator: (state: T) => void) => void } {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    update: (mutator) => {
      const next = { ...state }
      mutator(next)
      state = next
      for (const listener of listeners) listener()
    },
  }
}

/** Operator-facing description of any failure. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Read one wire state through the C-STATE vocabulary; unknowns read as disconnected. */
function lifecycleStateOf(raw: unknown): MachineLifecycleState {
  return isLifecycleState(raw) ? raw : 'disconnected'
}

/** How many log lines one machine keeps (the streaming tail). */
const LOG_TAIL_LINES = 300

/** Parse one machine.events value; malformed entries are dropped, not fatal. */
export function machineEventsOf(value: unknown): SshMachineEvent[] {
  if (typeof value !== 'object' || value === null)
    return []
  const events = (value as { events?: unknown }).events
  if (!Array.isArray(events))
    return []
  const out: SshMachineEvent[] = []
  for (const entry of events) {
    if (typeof entry !== 'object' || entry === null)
      continue
    const event = entry as Record<string, unknown>
    if (typeof event.seq !== 'number' || typeof event.machineId !== 'string' || typeof event.line !== 'string')
      continue
    if (event.ts !== undefined && typeof event.ts !== 'string')
      continue
    if (event.stage !== undefined && typeof event.stage !== 'string')
      continue
    out.push({
      seq: event.seq,
      ts: typeof event.ts === 'string' ? event.ts : '',
      machineId: event.machineId,
      stage: typeof event.stage === 'string' ? event.stage : '',
      line: event.line,
      ...(event.terminal === 'success' || event.terminal === 'failed') ? { terminal: event.terminal } : {},
      ...typeof event.reason === 'string' ? { reason: event.reason } : {},
    })
  }
  return out
}

/** Parse one sync.preview value; null when the shape is wrong. */
export function syncPreviewOf(value: unknown): SyncPreview | null {
  if (typeof value !== 'object' || value === null)
    return null
  const raw = value as { plugins?: unknown, skills?: unknown }
  if (!Array.isArray(raw.plugins) || !Array.isArray(raw.skills))
    return null
  const plugins = raw.plugins.flatMap((entry): SyncPreview['plugins'] => {
    if (typeof entry !== 'object' || entry === null)
      return []
    const item = entry as Record<string, unknown>
    if (typeof item.name !== 'string' || typeof item.spec !== 'string')
      return []
    return [{
      name: item.name,
      spec: item.spec,
      syncable: item.syncable === true,
      ...typeof item.reason === 'string' ? { reason: item.reason } : {},
    }]
  })
  const skills = raw.skills.flatMap((entry): SyncPreview['skills'] => {
    if (typeof entry !== 'object' || entry === null)
      return []
    const item = entry as Record<string, unknown>
    if (typeof item.name !== 'string' || typeof item.root !== 'string')
      return []
    return [{ name: item.name, root: item.root }]
  })
  return { plugins, skills }
}

/** Parse one sync.apply value; null when the shape is wrong. */
export function syncApplyResultOf(value: unknown): SyncApplyResult | null {
  if (typeof value !== 'object' || value === null)
    return null
  const items = (value as { items?: unknown }).items
  if (!Array.isArray(items))
    return null
  const out: SyncItemResult[] = []
  for (const entry of items) {
    if (typeof entry !== 'object' || entry === null)
      continue
    const item = entry as Record<string, unknown>
    if (typeof item.name !== 'string' || typeof item.ok !== 'boolean')
      continue
    if (item.kind !== 'plugin' && item.kind !== 'skill')
      continue
    out.push({
      kind: item.kind,
      name: item.name,
      ...typeof item.root === 'string' ? { root: item.root } : {},
      ok: item.ok,
      ...typeof item.error === 'string' ? { error: item.error } : {},
      ...typeof item.log === 'string' ? { log: item.log } : {},
    })
  }
  return { items: out }
}

/**
 * The multi-select toggle: independent Set membership per key. This is the
 * semantic the sync items needed (the old panel behaved like a radio group —
 * picking one item silently dropped the others).
 */
export function toggleSelection(selected: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(selected)
  if (next.has(key))
    next.delete(key)
  else
    next.add(key)
  return next
}

/**
 * The selection key of one preview plugin — identical in shape to the outcome
 * key {@link syncKeyOf} derives, so a selection and its result never drift.
 */
export function pluginKeyOf(plugin: { name: string }): string {
  return `plugin::${plugin.name}`
}

/** The selection key of one preview skill (same shape as the outcome key). */
export function skillKeyOf(skill: { name: string, root: string }): string {
  return `skill:${skill.root}:${skill.name}`
}

/** The outcome key of one settled sync item. */
export function syncKeyOf(item: SyncItemResult): string {
  return `${item.kind}:${item.root ?? ''}:${item.name}`
}

/**
 * Merge one apply batch into the running outcome list: an item that ran again
 * (a retry) replaces its own entry in place, a new item appends. Without this
 * a retry would wipe the earlier batch and hide which items had succeeded.
 */
export function mergeSyncResults(previous: readonly SyncItemResult[], incoming: readonly SyncItemResult[]): SyncItemResult[] {
  const merged = [...previous]
  const at = new Map(merged.map((item, index) => [syncKeyOf(item), index]))
  for (const item of incoming) {
    const index = at.get(syncKeyOf(item))
    if (index === undefined) {
      at.set(syncKeyOf(item), merged.length)
      merged.push(item)
    }
    else {
      merged[index] = item
    }
  }
  return merged
}

/** Parse one /api-ssh envelope; a transport-level failure throws a stable code. */
async function envelopeOf(response: Response): Promise<SshApiResponse> {
  // 非 2xx（路由未挂载 / 插件未启用时的 404、405）与空响应体都没有可解析的
  // JSON：直接抛稳定错误码，绝不把 `Unexpected end of JSON input` 这类原生
  // 解析异常泄漏到界面。
  if (response.ok === false)
    throw new Error(`SSH_API_HTTP_${response.status}`)
  try {
    return await response.json() as SshApiResponse
  }
  catch {
    throw new Error('SSH_API_EMPTY')
  }
}

/** Whether one failure text is a transport code rather than host-provided prose. */
export function isTransportError(message: string): boolean {
  return message.startsWith('SSH_API_')
}

/** Build a redacted machine row from one machine.list item. */
export function machineRowOf(value: unknown): MachineRow | undefined {
  if (typeof value !== 'object' || value === null)
    return undefined
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'string' || row.id === '')
    return undefined
  if (typeof row.name !== 'string')
    return undefined
  if (typeof row.host !== 'string' || row.host === '')
    return undefined
  if (typeof row.user !== 'string')
    return undefined
  const port = typeof row.port === 'number' ? row.port : 22
  const remotePort = typeof row.remotePort === 'number' ? row.remotePort : 3080
  const startCommand = typeof row.startCommand === 'string' && row.startCommand !== ''
    ? row.startCommand
    : undefined
  const rawProfileName = typeof row.profileName === 'string' ? row.profileName.trim() : ''
  const profileName = /^[\w-]+$/.test(rawProfileName) ? rawProfileName : undefined
  const color = typeof row.color === 'string' && row.color !== '' ? row.color : undefined
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port,
    user: row.user,
    hasPassword: row.hasPassword === true,
    hasPassphrase: row.hasPassphrase === true,
    remotePort,
    ...profileName === undefined ? {} : { profileName },
    ...startCommand === undefined ? {} : { startCommand },
    ...color === undefined ? {} : { color },
    ...row.tintBorder === true ? { tintBorder: true } : {},
  }
}

/** The machine.save config row shape (config fields only). */
export interface MachineSaveRow {
  name: string
  host: string
  port: number
  user: string
  remotePort: number
  profileName?: string
  startCommand?: string
  color?: string
  tintBorder?: boolean
}

/** Map one form row onto the machine.save payload (id + row + write-only secrets). */
export function savePayloadOf(machine: MachineRow, secrets: SecretValues): { machineId: string, row: MachineSaveRow, secrets?: SecretValues } {
  const row: MachineSaveRow = {
    name: machine.name,
    host: machine.host,
    port: machine.port,
    user: machine.user,
    remotePort: machine.remotePort,
    ...machine.profileName === undefined || machine.profileName === '' ? {} : { profileName: machine.profileName },
    ...machine.startCommand === undefined || machine.startCommand === '' ? {} : { startCommand: machine.startCommand },
    ...machine.color === undefined || machine.color === '' ? {} : { color: machine.color },
    ...machine.tintBorder === true ? { tintBorder: true } : {},
  }
  const typed: SecretValues = {}
  if (secrets.password !== undefined && secrets.password !== '')
    typed.password = secrets.password
  if (secrets.passphrase !== undefined && secrets.passphrase !== '')
    typed.passphrase = secrets.passphrase
  const payload: { machineId: string, row: MachineSaveRow, secrets?: SecretValues } = { machineId: machine.id, row }
  if (Object.keys(typed).length > 0)
    payload.secrets = typed
  return payload
}

/**
 * The page store: machine CRUD and the connection plane, all through
 * /api-ssh. Every mutation settles the published state; failures surface as
 * `state.error`/`state.notice` rather than throws.
 */
export class MachinesStore {
  /** The published page state. */
  readonly store: SnapshotStore<MachinesPageState> & { update: (mutator: (state: MachinesPageState) => void) => void }

  /**
   * The consumed event cursor per machine id (the last `seq` seen for that
   * machine). `seq` is a per-machine space — a global high-water mark would
   * mix counters and starve machines with lower sequence numbers.
   */
  private readonly lastEventSeqByMachine = new Map<string, number>()

  /** Whether the host still gets asked for machine.events (off after first refusal). */
  private eventsSupported = true

  /**
   * @param fetchFn - the /api-ssh transport (window.fetch in the browser).
   */
  constructor(private readonly fetchFn: FetchFn) {
    this.store = createSnapshotStore<MachinesPageState>({
      status: 'idle',
      error: null,
      enabled: null,
      enabling: false,
      machines: [],
      discovered: [],
      statuses: {},
      logs: {},
      trails: {},
      busy: {},
      notice: null,
      installResults: {},
      sync: { status: 'idle', error: null, preview: null, applying: false, results: null },
      role: null,
    })
  }

  /** Snapshot subscribe seam for useSyncExternalStore. */
  subscribe = (listener: () => void): () => void => this.store.subscribe(listener)

  /** Snapshot read seam for useSyncExternalStore. */
  getSnapshot = (): MachinesPageState => this.store.getSnapshot()

  /** POST one connection-plane method and return its value; failures throw. */
  private async callApi<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    const response = await this.fetchFn(SSH_API_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, payload }),
    })
    const envelope = await envelopeOf(response)
    if (!envelope.ok)
      throw new Error(envelope.error.message)
    return envelope.value as T
  }

  /** Apply one machine.list payload to the published state. */
  private applyList(list: { items?: MachineListItem[], discovered?: MachineListItem[] }): void {
    const machines = (list.items ?? []).map(machineRowOf).filter((row): row is MachineRow => row !== undefined)
    const discovered = (list.discovered ?? []).map(machineRowOf).filter((row): row is MachineRow => row !== undefined)
    const statuses: Record<string, MachineStatus> = {}
    for (const item of [...(list.items ?? []), ...(list.discovered ?? [])]) {
      const status: MachineStatus = { state: lifecycleStateOf(item.state) }
      if (typeof item.nextRetryAt === 'number' && Number.isFinite(item.nextRetryAt))
        status.nextRetryAt = item.nextRetryAt
      if (item.authMethod === 'agent' || item.authMethod === 'key' || item.authMethod === 'password')
        status.authMethod = item.authMethod
      if (item.tunnelBaseUrl !== undefined)
        status.tunnelBaseUrl = item.tunnelBaseUrl
      if (item.lastError !== undefined)
        status.lastError = item.lastError
      if (item.dshMissing === true)
        status.dshMissing = true
      if (item.progress !== undefined)
        status.progress = item.progress
      statuses[item.id] = status
    }
    this.store.update((state) => {
      state.status = 'ready'
      state.error = null
      state.machines = machines
      state.discovered = discovered
      state.statuses = statuses
      // 阶段轨迹：操作期间把实际出现的 progress.phase 依次入轨（步骤条的
      // 真值——装没装过 install 阶段由轨迹说话）；progress 消失即操作结束，
      // 清轨让步骤条收起。被删除的机器顺带清轨。
      for (const [id, status] of Object.entries(statuses)) {
        const phase = status.progress?.phase
        if (phase !== undefined) {
          const trail = state.trails[id] ?? []
          if (trail[trail.length - 1] !== phase)
            state.trails[id] = [...trail, phase]
        }
        else {
          delete state.trails[id]
        }
      }
      for (const id of Object.keys(state.trails)) {
        if (statuses[id] === undefined)
          delete state.trails[id]
      }
    })
  }

  /** Refresh machines, secret flags, and live statuses from machine.list. */
  async load(): Promise<void> {
    if (this.store.getSnapshot().enabled === false)
      return
    this.store.update((state) => {
      state.status = 'loading'
      state.error = null
    })
    try {
      if (this.store.getSnapshot().role === null)
        void this.loadRole()
      this.applyList(await this.callApi<{ items?: MachineListItem[], discovered?: MachineListItem[] }>('machine.list', {}))
    }
    catch (error) {
      this.store.update((state) => {
        state.status = 'error'
        state.error = messageOf(error)
      })
    }
  }

  /**
   * Read the feature switch (settings.get). A transport failure reads as
   * "off" plus an error notice: the section then shows the enable surface
   * instead of a raw parse error.
   */
  async loadSettings(): Promise<void> {
    try {
      const value = await this.callApi<{ enabled?: unknown }>('settings.get', {})
      this.store.update((state) => {
        state.enabled = value.enabled === true
        state.error = null
      })
    }
    catch (error) {
      this.store.update((state) => {
        state.enabled = false
        state.error = messageOf(error)
      })
    }
  }

  /** Switch the SSH feature on (settings.set), then load the machine table. */
  async enable(): Promise<void> {
    this.store.update((state) => {
      state.enabling = true
      state.error = null
    })
    try {
      const value = await this.callApi<{ enabled?: unknown }>('settings.set', { enabled: true })
      this.store.update((state) => {
        state.enabled = value.enabled !== false
      })
      if (this.store.getSnapshot().enabled === true)
        await this.load()
    }
    catch (error) {
      this.store.update((state) => {
        state.error = messageOf(error)
      })
    }
    finally {
      this.store.update((state) => {
        state.enabling = false
      })
    }
  }

  /** Load this instance's session role once (old hosts without the method keep null). */
  async loadRole(): Promise<void> {
    try {
      const role = await this.callApi<{ remote: boolean, origin?: string }>('session.role', {})
      this.store.update((state) => {
        state.role = role.remote === true ? { remote: true, ...role.origin === undefined || role.origin === '' ? {} : { origin: role.origin } } : { remote: false }
      })
    }
    catch {
      // Older hosts lack session.role; the banner simply stays hidden.
    }
  }

  /** Silent refresh: same payload as load(), but never flips the loading banner. */
  async poll(): Promise<void> {
    try {
      this.applyList(await this.callApi<{ items?: MachineListItem[], discovered?: MachineListItem[] }>('machine.list', {}))
      await this.pollEvents()
    }
    catch (error) {
      this.store.update((state) => {
        state.error = messageOf(error)
      })
    }
  }

  /**
   * Pull machine.events for every known machine and fold the lines into the
   * per-machine logs. The channel is per-machine: `seq` counts inside one
   * machine's buffer only, so the cursor lives per machine id and each poll
   * sends `{ machineId, sinceSeq }` per machine (the cursor is omitted on a
   * machine's first poll). A host without the S2 channel (or any refusal)
   * turns the channel off for good — the panel then lives on the status
   * progress fields alone, and the polling loop never fails the page for it.
   */
  private async pollEvents(): Promise<void> {
    if (!this.eventsSupported)
      return
    const snapshot = this.store.getSnapshot()
    const known = new Set([...snapshot.machines, ...snapshot.discovered].map(row => row.id))
    // Removed machines leave their cursors behind; drop them so the map
    // tracks the live machine set only.
    for (const id of this.lastEventSeqByMachine.keys()) {
      if (!known.has(id))
        this.lastEventSeqByMachine.delete(id)
    }
    const byMachine = new Map<string, string[]>()
    try {
      for (const machineId of known) {
        const cursor = this.lastEventSeqByMachine.get(machineId)
        const events = machineEventsOf(await this.callApi<unknown>('machine.events', {
          machineId,
          ...cursor === undefined ? {} : { sinceSeq: cursor },
        }))
        if (events.length === 0)
          continue
        this.lastEventSeqByMachine.set(machineId, Math.max(...events.map(event => event.seq)))
        for (const event of events) {
          // 空行的收尾事件（terminal/reason）合成一行标记，不再静默丢弃
          const line = event.line !== ''
            ? event.line
            : event.terminal === undefined
              ? ''
              : `[${event.terminal}]${event.reason === undefined ? '' : ` ${event.reason}`}`
          if (line === '')
            continue
          byMachine.set(event.machineId, [...(byMachine.get(event.machineId) ?? []), line])
        }
      }
    }
    catch {
      this.eventsSupported = false
      return
    }
    if (byMachine.size === 0)
      return
    this.store.update((state) => {
      for (const [machineId, lines] of byMachine) {
        state.logs[machineId] = [...(state.logs[machineId] ?? []), ...lines].slice(-LOG_TAIL_LINES)
      }
    })
  }

  /**
   * Persist the form: machine.save per row (write-only secrets; absent fields
   * keep the stored value) and machine.remove for ids that vanished.
   * @param machines - the form's machine rows (id is the dict key).
   * @param secrets - secret values the operator typed, keyed by machine id.
   * @returns whether every write landed (failures surface as `state.error`).
   */
  async persist(machines: MachineRow[], secrets: Record<string, SecretValues>): Promise<boolean> {
    const previous = this.store.getSnapshot().machines
    const previousIds = new Set(previous.map(row => row.id))
    try {
      for (const machine of machines) {
        await this.callApi<Record<string, never>>('machine.save', savePayloadOf(machine, secrets[machine.id] ?? {}))
      }
      for (const id of previousIds) {
        if (!machines.some(row => row.id === id)) {
          await this.callApi<Record<string, never>>('machine.remove', { machineId: id })
        }
      }
      this.store.update((state) => {
        state.error = null
      })
      await this.load()
      return true
    }
    catch (error) {
      this.store.update((state) => {
        state.error = messageOf(error)
      })
      return false
    }
  }

  /** Remove one machine immediately (config + secrets); returns success. */
  async remove(id: string): Promise<boolean> {
    try {
      await this.callApi<Record<string, never>>('machine.remove', { machineId: id })
      this.store.update((state) => {
        state.error = null
      })
      await this.load()
      return true
    }
    catch (error) {
      this.store.update((state) => {
        state.error = messageOf(error)
      })
      return false
    }
  }

  /** Mark one machine busy; failures settle the banner error. */
  private async withBusy(id: string, op: 'test' | 'connect' | 'disconnect' | 'install', action: () => Promise<void>): Promise<void> {
    this.store.update((state) => {
      state.busy[id] = op
      state.notice = null
      state.error = null
    })
    try {
      await action()
    }
    catch (error) {
      this.store.update((state) => {
        state.error = messageOf(error)
      })
    }
    finally {
      this.store.update((state) => {
        delete state.busy[id]
      })
    }
  }

  /** One-shot probe: runs `uname -srm` on the machine, never starts the instance. */
  async test(id: string): Promise<void> {
    await this.withBusy(id, 'test', async () => {
      const result = await this.callApi<{ ok: boolean, banner?: string, message?: string }>('machine.test', { machineId: id })
      if (result.ok) {
        this.store.update((state) => {
          state.notice = result.banner === undefined || result.banner === ''
            ? { kind: 'key', key: 'notice.probe_ok' }
            : { kind: 'text', text: result.banner }
          // 探测是旁路健康检查：只在还没有状态记录时落 disconnected，
          // 绝不把一条已建立/进行中的连接打回断开（连接面由轮询真值维护）。
          if (state.statuses[id] === undefined)
            state.statuses[id] = { state: 'disconnected' }
        })
      }
      else {
        this.store.update((state) => {
          state.notice = result.message === undefined || result.message === ''
            ? { kind: 'key', key: 'notice.probe_failed' }
            : { kind: 'text', text: result.message }
          const current = state.statuses[id]
          // 失败只追加 lastError；已有的连接态原样保留（真断开由轮询呈现）。
          state.statuses[id] = current === undefined || current.state === 'disconnected'
            ? { state: 'disconnected', lastError: result.message ?? 'failed' }
            : { ...current, lastError: result.message ?? 'failed' }
        })
      }
    })
  }

  /** Connect the machine: ensures the remote dsh instance and opens the tunnel. */
  async connect(id: string): Promise<void> {
    await this.withBusy(id, 'connect', async () => {
      const link = await this.callApi<{ tunnelBaseUrl: string }>('machine.connect', { machineId: id })
      this.store.update((state) => {
        state.statuses[id] = { state: 'connected', tunnelBaseUrl: link.tunnelBaseUrl }
        state.notice = { kind: 'key', key: 'notice.connected', params: { url: link.tunnelBaseUrl } }
      })
    })
  }

  /** Tear down one machine's link. */
  async disconnect(id: string): Promise<void> {
    await this.withBusy(id, 'disconnect', async () => {
      await this.callApi<Record<string, never>>('machine.disconnect', { machineId: id })
      this.store.update((state) => {
        state.statuses[id] = { state: 'disconnected' }
        state.notice = { kind: 'key', key: 'notice.disconnected' }
      })
    })
  }

  /**
   * One-click remote dsh install: streams through the host's machine.install,
   * which auto-connects on success. A follow-up load picks up the auto-connect
   * status (the polling loop keeps refreshing while it is in flight).
   */
  async install(id: string): Promise<void> {
    await this.withBusy(id, 'install', async () => {
      const result = await this.callApi<InstallResult>('machine.install', { machineId: id })
      this.store.update((state) => {
        state.installResults[id] = result
      })
      await this.load()
    })
  }

  /** Load the sync selection list (local plugins and skills) from sync.preview. */
  async loadSyncPreview(): Promise<void> {
    this.store.update((state) => {
      state.sync.status = 'loading'
      state.sync.error = null
    })
    try {
      const preview = syncPreviewOf(await this.callApi<unknown>('sync.preview', {}))
      if (preview === null)
        throw new Error('malformed sync.preview payload')
      this.store.update((state) => {
        state.sync.status = 'ready'
        state.sync.preview = preview
      })
    }
    catch (error) {
      this.store.update((state) => {
        state.sync.status = 'error'
        state.sync.error = messageOf(error)
      })
    }
  }

  /**
   * Sync one selection to a machine. The per-item outcomes land in
   * `state.sync.results` even on partial failure — a request-level failure
   * (session unreachable) surfaces as `state.sync.error`.
   * @param machineId - the connected target machine.
   * @param plugins - the selected plugin refs.
   * @param skills - the selected skill refs.
   */
  async applySync(machineId: string, plugins: SyncPreview['plugins'], skills: SyncPreview['skills']): Promise<void> {
    this.store.update((state) => {
      state.sync.applying = true
      state.sync.error = null
    })
    try {
      const result = syncApplyResultOf(await this.callApi<unknown>('sync.apply', {
        machineId,
        plugins: plugins.map(plugin => ({ name: plugin.name, spec: plugin.spec })),
        skills: skills.map(skill => ({ name: skill.name, root: skill.root })),
      }))
      if (result === null)
        throw new Error('malformed sync.apply payload')
      this.store.update((state) => {
        state.sync.results = mergeSyncResults(state.sync.results ?? [], result.items)
      })
    }
    catch (error) {
      this.store.update((state) => {
        state.sync.error = messageOf(error)
      })
    }
    finally {
      this.store.update((state) => {
        state.sync.applying = false
      })
    }
  }
}
