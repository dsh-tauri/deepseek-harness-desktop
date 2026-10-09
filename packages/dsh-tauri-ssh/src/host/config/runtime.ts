import type { MachineDeps, MachineState } from '../service/machine.types'
import type { SyncDeps } from '../service/sync.types'
import type { MachineId, MachineProfile, SshMachineEvent } from '../types/index'
import type { Config } from './schema'
import { homedir } from 'node:os'
import process from 'node:process'
import { join } from 'pathe'
import { EVENT_RING_CAPACITY } from './constants'

export const machineProfiles = new Map<MachineId, MachineProfile>()

export const machineStates = new Map<MachineId, MachineState>()

export const machineTable: { enabled: boolean, machines: Map<MachineId, MachineProfile> } = {
  enabled: false,
  machines: new Map(),
}

export const eventBuffers = new Map<MachineId, { seq: number, events: SshMachineEvent[] }>()

let config: Config | undefined
let homeDir = homedir()
let sshDir = ''
let statePath = ''
let knownHostsPath = ''
let eventCapacity = EVENT_RING_CAPACITY
let deps: MachineDeps | undefined
let syncDeps: SyncDeps | undefined

export function harnessHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
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
  statePath = next.statePath ?? join(harnessHome(), 'ssh', 'machines.json')
  knownHostsPath = next.knownHostsPath ?? join(harnessHome(), 'ssh', 'known-hosts.json')
}

export function stateDocumentPath(): string {
  return statePath === '' ? join(harnessHome(), 'ssh', 'machines.json') : statePath
}

export function setKnownHostsPath(path: string): void {
  knownHostsPath = path
}

export function knownHostsFilePath(): string {
  return knownHostsPath === '' ? join(harnessHome(), 'ssh', 'known-hosts.json') : knownHostsPath
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

export function resetRuntime(): void {
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
  machineProfiles.clear()
  machineStates.clear()
  machineTable.enabled = false
  machineTable.machines.clear()
  eventBuffers.clear()
}
