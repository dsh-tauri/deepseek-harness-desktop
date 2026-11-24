import type { MachineDeps, MachineState } from '../service/machine.types'
import type { SyncDeps } from '../service/sync.types'
import type { TunnelDeps } from '../service/tunnel.types'
import type { MachineId, MachineProfile, RemoteHostContext, RemoteMachineEvent } from '../types/index'
import type { Config } from './schema'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync } from 'node:fs'
import { homedir } from 'node:os'
import process from 'node:process'
import { dirname, join } from 'pathe'
import { messageOf } from '../../shared/error'
import { migrateDocument } from '../utils/migrate'
import { EVENT_RING_CAPACITY } from './constants'

/** #1624：`$DSH_HOME/remote` 归 ds-harness-remote 的旧版迁移，本插件改用带命名空间的目录。 */
const STATE_DIR = 'remote.ssh'
const PREVIOUS_STATE_DIR = 'remote'
const LEGACY_STATE_DIR = 'ssh'
const STATE_DOCUMENT = 'machines.json'
const KNOWN_HOSTS_DOCUMENT = 'known-hosts.json'
const ACCESS_DOCUMENT = 'access.json'
export const BIN_DIR = 'bin'

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

const coreInstallTasks = new Map<string, string>()

const coreInstallAborts = new Map<string, AbortController>()

let config: Config | undefined
let homeDir = homedir()
let sshDir = ''
let statePath = ''
let knownHostsPath = ''
let eventCapacity = EVENT_RING_CAPACITY
let deps: MachineDeps | undefined
let syncDeps: SyncDeps | undefined
let tunnelDeps: TunnelDeps | undefined
let migrated = false
let migrationWarning: string | undefined
let sourceSession = ''
let runtimeGeneration = 0

export function setSourceSession(session: string): void {
  sourceSession = session
}

/** 网关装配时的会话标识保证：未设置则生成一次进程内随机值，注入与判定两侧共用同一枚。 */
export function ensureSourceSession(): string {
  if (sourceSession === '')
    sourceSession = randomBytes(32).toString('hex')
  return sourceSession
}

/** 网关进程内会话标识：只有持有它的转发请求才能声明来源分类（未设置时任何声明都不可信）。 */
export function sourceSessionToken(): string {
  return sourceSession
}

export function harnessHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

export function stateDir(): string {
  return join(harnessHome(), STATE_DIR)
}

function previousStateDir(): string {
  return join(harnessHome(), PREVIOUS_STATE_DIR)
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
  runtimeGeneration += 1
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

export function accessDocumentPath(): string {
  return join(stateDir(), ACCESS_DOCUMENT)
}

/** 本机 DSH 服务端口：宿主 webserver 的实监听端口优先，`DSH_WEB_PORT` 仅作回退（非桌面载体没有该变量）。 */
export function hostServicePort(): number | undefined {
  try {
    const port = getCurrentHostInstance().webServer.port
    if (isServicePort(port))
      return port
  }
  catch {
    // keep: 宿主实例可能尚未绑定（或已随插件卸载清空），回退进程环境变量
  }
  const fallback = Number(process.env.DSH_WEB_PORT)
  return isServicePort(fallback) ? fallback : undefined
}

export function localUpstream(): string | undefined {
  const port = hostServicePort()
  return port === undefined ? undefined : `http://127.0.0.1:${port}`
}

/** 上游 authority 绑定凭据的铸造：宿主实例尚未绑定（或已随插件卸载清空）时放弃本次铸造，不阻断转发。 */
export async function mintAuthenticatedUrl(authority: string): Promise<string | undefined> {
  try {
    return await getCurrentHostInstance().connection?.authenticatedUrl(`http://${authority}/`)
  }
  catch {
    return undefined
  }
}

function isServicePort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535
}

/**
 * 一次性幂等迁移：上一版现役目录 `$DSH_HOME/remote/` 整体搬进 `$DSH_HOME/remote.ssh/`，
 * 最早的 `$DSH_HOME/ssh/` 只搬两份文档并保留旧文件；进程内去重，失败只回可读原因、绝不阻断插件加载。
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
  const stranded = adoptPreviousStateDir(reasons)
  // 两份文档各自迁移：其中一份损坏或写不进去，不影响另一份被带过来。
  // 上一版目录里没能搬走的文档不能再由更旧的 ssh 备份顶上，否则旧状态会长期生效。
  if (current.statePath === undefined && !stranded.has(STATE_DOCUMENT))
    migrateInto(join(legacyStateDir(), STATE_DOCUMENT), stateDocumentPath(), reasons)
  if (current.knownHostsPath === undefined && !stranded.has(KNOWN_HOSTS_DOCUMENT))
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

/**
 * 把上一版现役目录里属于本插件的条目搬到各自的有效目标位置，并删掉腾空的目录。
 * 该目录要完整让给 ds-harness-remote 的旧版迁移，留下任何一个文件都会让它报 STORAGE_CONFLICT（#1624）；
 * 只搬自己写过的条目，`servers/` 之类他人数据原地不动。
 *
 * @returns 留在原处没搬走的条目名，调用方据此不再拿更旧的备份顶替它们。
 */
function adoptPreviousStateDir(reasons: string[]): Set<string> {
  const stranded = new Set<string>()
  const source = previousStateDir()
  if (!existsSync(source))
    return stranded
  const moves: [string, string][] = [
    [STATE_DOCUMENT, stateDocumentPath()],
    [KNOWN_HOSTS_DOCUMENT, knownHostsFilePath()],
    [ACCESS_DOCUMENT, accessDocumentPath()],
    [BIN_DIR, join(stateDir(), BIN_DIR)],
  ]
  for (const [entry, target] of moves) {
    const from = join(source, entry)
    if (!existsSync(from))
      continue
    if (existsSync(target)) {
      stranded.add(entry)
      reasons.push(`旧状态目录的 ${entry} 未迁移：目标位置已有同名条目`)
      continue
    }
    try {
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
      renameSync(from, target)
    }
    catch (error) {
      stranded.add(entry)
      reasons.push(`旧状态目录的 ${entry} 未迁移：${failureCode(error)}`)
    }
  }
  pruneEmptyDir(source)
  return stranded
}

function pruneEmptyDir(dir: string): void {
  try {
    if (readdirSync(dir).length === 0)
      rmdirSync(dir)
  }
  catch {
    // keep: 目录可能刚被外部删除或仍被占用；腾空失败不影响本次启动
  }
}

/** 搬迁失败原因只回错误码：这条原因经 `GET /settings` 下发到 web 载体，不下发 home 下的绝对路径。 */
function failureCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '未知原因'
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

export function coreInstallTask(machineId: MachineId, tag: string): string | undefined {
  return coreInstallTasks.get(`${machineId}\0${tag}`)
}

export function hostRuntimeGeneration(): number {
  return runtimeGeneration
}

export function registerCoreInstallTask(machineId: MachineId, tag: string, taskId: string, abort: AbortController): void {
  const key = `${machineId}\0${tag}`
  coreInstallTasks.set(key, taskId)
  coreInstallAborts.set(key, abort)
}

export function clearCoreInstallTask(machineId: MachineId, tag: string, taskId: string): void {
  const key = `${machineId}\0${tag}`
  if (coreInstallTasks.get(key) === taskId) {
    coreInstallTasks.delete(key)
    coreInstallAborts.delete(key)
  }
}

export function setSyncDeps(next: SyncDeps): void {
  syncDeps = next
}

export function syncRuntimeDeps(): SyncDeps {
  if (syncDeps === undefined)
    throw new TypeError('syncRuntimeDeps: 同步面依赖尚未装配，apply.ts 需先调用 setSyncDeps(deps)')
  return syncDeps
}

export function setTunnelDeps(next: TunnelDeps): void {
  tunnelDeps = next
}

export function tunnelRuntimeDeps(): TunnelDeps {
  if (tunnelDeps === undefined)
    throw new TypeError('tunnelRuntimeDeps: 隧道面依赖尚未装配，apply.ts 需先调用 setTunnelDeps(deps)')
  return tunnelDeps
}

export function clearHostRuntime(): void {
  runtimeGeneration += 1
  for (const abort of coreInstallAborts.values())
    abort.abort()
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
  tunnelDeps = undefined
  migrated = false
  migrationWarning = undefined
  sourceSession = ''
  machineProfiles.clear()
  machineStates.clear()
  machineTable.enabled = false
  machineTable.machines.clear()
  coreInstallAborts.clear()
  coreInstallTasks.clear()
  eventBuffers.clear()
  setCurrentHostInstance(undefined)
}
