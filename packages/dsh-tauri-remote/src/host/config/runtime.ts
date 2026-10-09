import type { MachineDeps, MachineState } from '../service/machine.types'
import type { SyncDeps } from '../service/sync.types'
import type { MachineId, MachineProfile, RemoteHostContext, RemoteMachineEvent } from '../types/index'
import type { Config } from './schema'
import { homedir } from 'node:os'
import process from 'node:process'
import { join } from 'pathe'
import { messageOf } from '../../shared/error'
import { migrateDocument } from '../utils/migrate'
import { EVENT_RING_CAPACITY } from './constants'

const STATE_DIR = 'remote'
const LEGACY_STATE_DIR = 'ssh'
const STATE_DOCUMENT = 'machines.json'
const KNOWN_HOSTS_DOCUMENT = 'known-hosts.json'

let hostInstance: RemoteHostContext | undefined

export function setCurrentHostInstance(next: RemoteHostContext | undefined): void {
  hostInstance = next
}

export function getCurrentHostInstance(): RemoteHostContext {
  if (hostInstance === undefined)
    throw new TypeError('getCurrentHostInstance: 宿主实例尚未绑定，apply.ts 需先调用 setCurrentHostInstance(ctx)')
  return hostInstance
}

export const machineProfiles = new Map<MachineId, MachineProfile>()

export const machineStates = new Map<MachineId, MachineState>()

export const machineTable: { enabled: boolean, machines: Map<MachineId, MachineProfile> } = {
  enabled: false,
  machines: new Map(),
}

export const eventBuffers = new Map<MachineId, { seq: number, events: RemoteMachineEvent[] }>()

let config: Config | undefined
let homeDir = homedir()
let sshDir = ''
let statePath = ''
let knownHostsPath = ''
let eventCapacity = EVENT_RING_CAPACITY
let deps: MachineDeps | undefined
let syncDeps: SyncDeps | undefined
let migrated = false
let migrationWarning: string | undefined
let sourceSession = ''

export function setSourceSession(session: string): void {
  sourceSession = session
}

/** 网关进程内会话标识：只有持有它的转发请求才能声明来源分类（未设置时任何声明都不可信）。 */
export function sourceSessionToken(): string {
  return sourceSession
}

export function harnessHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

function stateDir(): string {
  return join(harnessHome(), STATE_DIR)
}

function legacyStateDir(): string {
  return join(harnessHome(), LEGACY_STATE_DIR)
}

export function hostConfig(): Config {
  if (config === undefined)
    throw new TypeError('hostConfig: 插件配置尚未装配，apply.ts 需先调用 setHostConfig(config)')
  return config
}

export function setHostConfig(next: Config): void {
  config = next
  homeDir = homedir()
  sshDir = next.sshDir ?? join(homeDir, '.ssh')
  statePath = next.statePath ?? join(stateDir(), STATE_DOCUMENT)
  knownHostsPath = next.knownHostsPath ?? join(stateDir(), KNOWN_HOSTS_DOCUMENT)
}

export function stateDocumentPath(): string {
  return statePath === '' ? join(stateDir(), STATE_DOCUMENT) : statePath
}

export function setKnownHostsPath(path: string): void {
  knownHostsPath = path
}

export function knownHostsFilePath(): string {
  return knownHostsPath === '' ? join(stateDir(), KNOWN_HOSTS_DOCUMENT) : knownHostsPath
}

/**
 * 一次性幂等迁移 `$DSH_HOME/ssh/` → `$DSH_HOME/remote/`：进程内去重、旧文件保留为只读备份、
 * 目标已存在（含半迁移的空文件）即视为已迁移，失败只回可读原因、绝不阻断插件加载。
 *
 * @returns 未迁移原因（旧文件损坏 / 写入失败）；全部成功或无需迁移时为 undefined。
 */
export function migrateLegacyState(): string | undefined {
  if (migrated)
    return migrationWarning
  migrated = true
  const reasons: string[] = []
  let current: Config
  try {
    current = hostConfig()
  }
  catch (error) {
    migrationWarning = messageOf(error)
    return migrationWarning
  }
  // 两份文档各自迁移：其中一份损坏或写不进去，不影响另一份被带过来。
  if (current.statePath === undefined)
    migrateInto(join(legacyStateDir(), STATE_DOCUMENT), stateDocumentPath(), reasons)
  if (current.knownHostsPath === undefined)
    migrateInto(join(legacyStateDir(), KNOWN_HOSTS_DOCUMENT), knownHostsFilePath(), reasons)
  migrationWarning = reasons.length === 0 ? undefined : reasons.join('; ')
  return migrationWarning
}

/** 迁移失败原因（面板经 `GET /settings` 展示的那一条告警）；成功或无需迁移时为 undefined。 */
export function migrationWarningOf(): string | undefined {
  return migrationWarning
}

export function setMigrationWarning(warning: string | undefined): void {
  migrationWarning = warning
}

function migrateInto(source: string, target: string, reasons: string[]): void {
  try {
    migrateDocument(source, target)
  }
  catch (error) {
    reasons.push(messageOf(error))
  }
}

export function sshDirPath(): string {
  return sshDir === '' ? join(homedir(), '.ssh') : sshDir
}

export function homeDirPath(): string {
  return homeDir
}

export function setEventCapacity(capacity: number): void {
  eventCapacity = capacity
}

export function eventRingCapacity(): number {
  return eventCapacity
}

export function setMachineDeps(next: MachineDeps): void {
  deps = next
}

export function machineRuntimeDeps(): MachineDeps {
  if (deps === undefined)
    throw new TypeError('machineRuntimeDeps: 连接面依赖尚未装配，apply.ts 需先调用 setMachineDeps(deps)')
  return deps
}

export function setSyncDeps(next: SyncDeps): void {
  syncDeps = next
}

export function syncRuntimeDeps(): SyncDeps {
  if (syncDeps === undefined)
    throw new TypeError('syncRuntimeDeps: 同步面依赖尚未装配，apply.ts 需先调用 setSyncDeps(deps)')
  return syncDeps
}

export function clearHostRuntime(): void {
  // 使在途 attempt 失效：未完成的 performConnect/performInstall 恢复执行时会比对 generation，
  // 若不等则不再对外拨号（否则它们的续跑会读到下一个 runtime 的 deps，把连接打到别人的 transport 上）。
  for (const target of machineStates.values())
    target.generation += 1
  config = undefined
  homeDir = homedir()
  sshDir = ''
  statePath = ''
  knownHostsPath = ''
  eventCapacity = EVENT_RING_CAPACITY
  deps = undefined
  syncDeps = undefined
  migrated = false
  migrationWarning = undefined
  sourceSession = ''
  machineProfiles.clear()
  machineStates.clear()
  machineTable.enabled = false
  machineTable.machines.clear()
  eventBuffers.clear()
  setCurrentHostInstance(undefined)
}
