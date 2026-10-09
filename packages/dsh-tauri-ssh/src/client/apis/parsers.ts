import type {
  InstallResult,
  MachineListSnapshot,
  MachineRow,
  MachineStatus,
  ProgressPhase,
  SecretValues,
  SshMachineEvent,
  SyncApplyResult,
  SyncItemResult,
  SyncPluginItem,
  SyncPreview,
  SyncSkillItem,
} from '../types/index'
import type { PostApiTauriSshMachinesBody } from './index.type'
import { DEFAULT_REMOTE_PORT, DEFAULT_SSH_PORT } from '../../shared/constants'
import { messageOf } from '../../shared/error'
import { isLifecycleState } from '../types/index'

export const SSH_API_EMPTY = 'SSH_API_EMPTY'

const MISSING_API_STATUSES: readonly number[] = [404, 405]
const HTTP_FAILURE = /^请求失败 \((\d{3})\)(?:: )?/
const PROFILE_NAME = /^[\w-]+$/
const PROGRESS_PHASES: readonly ProgressPhase[] = ['handshake', 'installing', 'starting', 'probing', 'syncing']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function entriesOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function isTransportError(message: string): boolean {
  return message.startsWith('SSH_API_')
}

export function errorMessageOf(error: unknown): string {
  const message = messageOf(error)
  const match = HTTP_FAILURE.exec(message)
  if (match === null)
    return message
  const status = Number(match[1])
  if (MISSING_API_STATUSES.includes(status))
    return `SSH_API_HTTP_${status}`
  return message.slice(match[0].length) || message
}

export function enabledOf(value: unknown): boolean | undefined {
  if (!isRecord(value))
    return undefined
  return typeof value.enabled === 'boolean' ? value.enabled : undefined
}

export function sessionRoleOf(value: unknown): { remote: boolean, origin?: string } {
  const source = isRecord(value) ? value : {}
  const origin = textOf(source.origin)
  return {
    remote: source.remote === true,
    ...origin === undefined ? {} : { origin },
  }
}

export function testResultOf(value: unknown): { ok: boolean, banner?: string, message?: string } {
  const source = isRecord(value) ? value : {}
  const banner = textOf(source.banner)
  const message = textOf(source.message)
  return {
    ok: source.ok === true,
    ...banner === undefined ? {} : { banner },
    ...message === undefined ? {} : { message },
  }
}

export function tunnelUrlOf(value: unknown): string {
  const source = isRecord(value) ? value : {}
  return textOf(source.tunnelBaseUrl) ?? ''
}

export function installResultOf(value: unknown): InstallResult {
  const source = isRecord(value) ? value : {}
  const credentialsError = textOf(source.credentialsError)
  return {
    dshPath: textOf(source.dshPath) ?? '',
    credentialsCopied: source.credentialsCopied === true,
    ...credentialsError === undefined ? {} : { credentialsError },
  }
}

function lifecycleStateOf(value: unknown): MachineStatus['state'] {
  return isLifecycleState(value) ? value : 'disconnected'
}

function machineRowOf(value: unknown): MachineRow | undefined {
  if (!isRecord(value))
    return undefined
  const id = textOf(value.id)
  const host = textOf(value.host)
  if (id === undefined || typeof value.name !== 'string' || host === undefined || typeof value.user !== 'string')
    return undefined
  const profileName = typeof value.profileName === 'string' ? value.profileName.trim() : ''
  const startCommand = textOf(value.startCommand)
  const color = textOf(value.color)
  return {
    id,
    name: value.name,
    host,
    port: numberOf(value.port) ?? DEFAULT_SSH_PORT,
    user: value.user,
    hasPassword: value.hasPassword === true,
    hasPassphrase: value.hasPassphrase === true,
    remotePort: numberOf(value.remotePort) ?? DEFAULT_REMOTE_PORT,
    ...PROFILE_NAME.test(profileName) ? { profileName } : {},
    ...startCommand === undefined ? {} : { startCommand },
    ...color === undefined ? {} : { color },
    ...value.tintBorder === true ? { tintBorder: true } : {},
  }
}

function progressOf(value: unknown): MachineStatus['progress'] {
  if (!isRecord(value))
    return undefined
  const phase = PROGRESS_PHASES.find(candidate => candidate === value.phase)
  if (phase === undefined)
    return undefined
  const attempt = numberOf(value.attempt)
  const total = numberOf(value.total)
  const item = textOf(value.item)
  const log = textOf(value.log)
  return {
    phase,
    ...attempt === undefined ? {} : { attempt },
    ...total === undefined ? {} : { total },
    ...item === undefined ? {} : { item },
    ...log === undefined ? {} : { log },
  }
}

function statusOf(value: unknown): { id: string, status: MachineStatus } | undefined {
  if (!isRecord(value))
    return undefined
  const id = textOf(value.id)
  if (id === undefined)
    return undefined
  const status: MachineStatus = { state: lifecycleStateOf(value.state) }
  const nextRetryAt = numberOf(value.nextRetryAt)
  if (nextRetryAt !== undefined)
    status.nextRetryAt = nextRetryAt
  if (value.authMethod === 'agent' || value.authMethod === 'key' || value.authMethod === 'password')
    status.authMethod = value.authMethod
  const tunnelBaseUrl = textOf(value.tunnelBaseUrl)
  if (tunnelBaseUrl !== undefined)
    status.tunnelBaseUrl = tunnelBaseUrl
  const lastError = textOf(value.lastError)
  if (lastError !== undefined)
    status.lastError = lastError
  if (value.dshMissing === true)
    status.dshMissing = true
  const progress = progressOf(value.progress)
  if (progress !== undefined)
    status.progress = progress
  return { id, status }
}

function rowsOf(value: unknown): MachineRow[] {
  return entriesOf(value).map(machineRowOf).filter((row): row is MachineRow => row !== undefined)
}

export function machineListOf(value: unknown): MachineListSnapshot {
  const source = isRecord(value) ? value : {}
  const statuses: Record<string, MachineStatus> = {}
  for (const entry of [...entriesOf(source.items), ...entriesOf(source.discovered)]) {
    const parsed = statusOf(entry)
    if (parsed !== undefined)
      statuses[parsed.id] = parsed.status
  }
  return {
    machines: rowsOf(source.items),
    discovered: rowsOf(source.discovered),
    statuses,
  }
}

export function savePayloadOf(machine: MachineRow, secrets: SecretValues): PostApiTauriSshMachinesBody {
  const profileName = textOf(machine.profileName)?.trim() ?? ''
  const startCommand = textOf(machine.startCommand)
  const color = textOf(machine.color)
  const typed: SecretValues = {}
  const password = textOf(secrets.password)
  if (password !== undefined)
    typed.password = password
  const passphrase = textOf(secrets.passphrase)
  if (passphrase !== undefined)
    typed.passphrase = passphrase
  return {
    machineId: machine.id,
    row: {
      name: machine.name,
      host: machine.host,
      port: machine.port,
      user: machine.user,
      remotePort: machine.remotePort,
      ...PROFILE_NAME.test(profileName) ? { profileName } : {},
      ...startCommand === undefined ? {} : { startCommand },
      ...color === undefined ? {} : { color },
      ...machine.tintBorder === true ? { tintBorder: true } : {},
    },
    ...Object.keys(typed).length === 0 ? {} : { secrets: typed },
  }
}

export function machineEventsOf(value: unknown): SshMachineEvent[] {
  const source = isRecord(value) ? value : {}
  const events: SshMachineEvent[] = []
  for (const entry of entriesOf(source.items)) {
    if (!isRecord(entry))
      continue
    if (typeof entry.seq !== 'number' || typeof entry.machineId !== 'string' || typeof entry.line !== 'string')
      continue
    if (entry.ts !== undefined && typeof entry.ts !== 'string')
      continue
    if (entry.stage !== undefined && typeof entry.stage !== 'string')
      continue
    events.push({
      seq: entry.seq,
      ts: typeof entry.ts === 'string' ? entry.ts : '',
      machineId: entry.machineId,
      stage: typeof entry.stage === 'string' ? entry.stage : '',
      line: entry.line,
      ...entry.terminal === 'success' || entry.terminal === 'failed' ? { terminal: entry.terminal } : {},
      ...typeof entry.reason === 'string' ? { reason: entry.reason } : {},
    })
  }
  return events
}

export function syncPreviewOf(value: unknown): SyncPreview | null {
  if (!isRecord(value) || !Array.isArray(value.plugins) || !Array.isArray(value.skills))
    return null
  const plugins: SyncPluginItem[] = []
  for (const entry of value.plugins) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.spec !== 'string')
      continue
    plugins.push({
      name: entry.name,
      spec: entry.spec,
      syncable: entry.syncable === true,
      ...typeof entry.reason === 'string' ? { reason: entry.reason } : {},
    })
  }
  const skills: SyncSkillItem[] = []
  for (const entry of value.skills) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.root !== 'string')
      continue
    skills.push({ name: entry.name, root: entry.root })
  }
  return { plugins, skills }
}

export function syncApplyResultOf(value: unknown): SyncApplyResult | null {
  if (!isRecord(value) || !Array.isArray(value.items))
    return null
  const items: SyncItemResult[] = []
  for (const entry of value.items) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.ok !== 'boolean')
      continue
    if (entry.kind !== 'plugin' && entry.kind !== 'skill')
      continue
    items.push({
      kind: entry.kind,
      name: entry.name,
      ...typeof entry.root === 'string' ? { root: entry.root } : {},
      ok: entry.ok,
      ...typeof entry.error === 'string' ? { error: entry.error } : {},
      ...typeof entry.log === 'string' ? { log: entry.log } : {},
    })
  }
  return { items }
}
