import type { MachineSaveRow, MachineSecretWrite, MachineView, SshMachineStatus, SyncPluginRef, SyncSkillRef, SyncSkillRoot } from '../../types/index'
import type { SshMachineListItem } from './index.types'
import { DEFAULT_REMOTE_PORT, DEFAULT_SSH_PORT } from '../../../shared/constants'
import { MachineId } from '../../types/index'

export async function guarded<T>(event: { res: { status?: number } }, run: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await run()
  }
  catch (error) {
    const status = typeof error === 'object' && error !== null ? (error as { statusCode?: unknown }).statusCode : undefined
    if (typeof status === 'number')
      throw error
    event.res.status = 400
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export function listItemOf(view: MachineView, status: SshMachineStatus): SshMachineListItem {
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

export function machineIdOf(value: { machineId?: unknown }): MachineId {
  if (typeof value.machineId !== 'string' || value.machineId === '')
    throw new Error('missing machineId')
  return MachineId(value.machineId)
}

export function enabledOf(value: { enabled?: unknown }): boolean {
  if (typeof value.enabled !== 'boolean')
    throw new Error('missing enabled')
  return value.enabled
}

export function sinceSeqOf(value: { sinceSeq?: unknown }): number | undefined {
  const raw = value.sinceSeq
  if (raw === undefined || raw === '')
    return undefined
  const seq = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isInteger(seq) || seq < 0)
    throw new Error('invalid sinceSeq')
  return seq
}

export function saveRowOf(value: { row?: unknown }): MachineSaveRow {
  const row = value.row
  if (typeof row !== 'object' || row === null)
    throw new Error('missing row')
  const fields = row as Record<string, unknown>
  if (typeof fields.name !== 'string' || fields.name === '')
    throw new Error('invalid row: name')
  if (typeof fields.host !== 'string' || fields.host === '')
    throw new Error('invalid row: host')
  if (typeof fields.user !== 'string')
    throw new Error('invalid row: user')
  const port = typeof fields.port === 'number' ? fields.port : DEFAULT_SSH_PORT
  const remotePort = typeof fields.remotePort === 'number' ? fields.remotePort : DEFAULT_REMOTE_PORT
  const startCommand = typeof fields.startCommand === 'string' && fields.startCommand !== ''
    ? fields.startCommand
    : undefined
  const rawProfileName = typeof fields.profileName === 'string' ? fields.profileName.trim() : ''
  const profileName = /^[\w-]+$/.test(rawProfileName) ? rawProfileName : undefined
  const color = typeof fields.color === 'string' && fields.color !== '' ? fields.color : undefined
  return {
    name: fields.name,
    host: fields.host,
    port,
    user: fields.user,
    remotePort,
    ...profileName === undefined ? {} : { profileName },
    ...startCommand === undefined ? {} : { startCommand },
    ...color === undefined ? {} : { color },
    ...fields.tintBorder === true ? { tintBorder: true } : {},
  }
}

export function secretsOf(value: { secrets?: unknown }): MachineSecretWrite | undefined {
  const secrets = value.secrets
  if (secrets === undefined)
    return undefined
  if (typeof secrets !== 'object' || secrets === null)
    throw new Error('invalid secrets')
  const fields = secrets as Record<string, unknown>
  const out: MachineSecretWrite = {}
  if (typeof fields.password === 'string' && fields.password !== '')
    out.password = fields.password
  if (typeof fields.passphrase === 'string' && fields.passphrase !== '')
    out.passphrase = fields.passphrase
  return out
}

export function pluginRefsOf(value: { plugins?: unknown }): SyncPluginRef[] {
  const list = value.plugins
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

export function skillRefsOf(value: { skills?: unknown }): SyncSkillRef[] {
  const list = value.skills
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
