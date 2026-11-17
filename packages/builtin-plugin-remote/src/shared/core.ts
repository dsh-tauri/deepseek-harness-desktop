export type CoreScope = 'local' | 'remote'

export type CoreCapability
  = | 'listVersions'
    | 'installVersion'
    | 'activate'
    | 'removeSlot'
    | 'asar'
    | 'bundledCore'

export type CorePlatform
  = | 'windows-x64'
    | 'windows-arm64'
    | 'macos-x64'
    | 'macos-arm64'
    | 'linux-x64'
    | 'linux-arm64'

export interface CoreVersionItem {
  version: string
  tag: string
  preview: boolean
}

export interface CoreProfileItem {
  name: string
  configured: boolean
}

interface CoreTargetBase {
  id: string
  scope: CoreScope
  machineId?: string
  remoteProfile?: string
  capabilities: CoreCapability[]
  platforms: CorePlatform[]
}

export type CoreTarget = CoreTargetBase & CoreTargetState

export type CoreTargetState
  = | { availability: 'absent', slots: [] }
    | { availability: 'present', slots: CoreSlotState[] }
    | { availability: 'unreadable', error: string, path?: string, slots: CoreUnreadableSlot[] }

export type CoreSlotState
  = | CoreInstalledSlot
    | CoreUnsupportedSlot
    | CoreUnreadableSlot

export interface CoreInstalledSlot {
  kind: 'installed'
  slotKey: string
  version: string
  tag?: string
  path?: string
  dir?: string
  active: boolean
  removable?: boolean
  preview: boolean
  bundled?: boolean
  orphaned?: boolean
}

export interface CoreUnsupportedSlot {
  kind: 'unsupported'
  slotKey: string
  version: string
  tag?: string
  path?: string
  dir?: string
  error: string
}

export interface CoreUnreadableSlot {
  kind: 'unreadable'
  slotKey: string
  tag?: string
  path?: string
  dir?: string
  error: string
}

export interface CoreRowRef {
  targetId: string
  slotKey: string
}

export type CoreOperation = 'installVersion' | 'activate' | 'removeSlot'

export type CoreTaskState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface CoreInstallVersionRequest {
  targetId: string
  tag: string
}

export interface CoreActivateRequest extends CoreRowRef {
  confirmRestart: boolean
}

export interface CoreRemoveSlotRequest extends CoreRowRef {
  force?: boolean
}

export interface CoreTaskAccepted {
  taskId: string
}

export interface CoreTaskEvent {
  taskId: string
  seq: number
  ts: string
  state: CoreTaskState
  stage: string
  line: string
  terminal?: 'success' | 'failed'
  reason?: string
}

export interface CoreTaskEventPage {
  events: CoreTaskEvent[]
  nextSeq: number
}

export interface CoreTask {
  taskId: string
  targetId: string
  operation: CoreOperation
  slotKey?: string
  state: CoreTaskState
  startedAt: string
  finishedAt?: string
  error?: string
}

export const LOCAL_CORE_CAPABILITIES: CoreCapability[] = [
  'listVersions',
  'installVersion',
  'activate',
  'removeSlot',
  'asar',
  'bundledCore',
]

export const REMOTE_CORE_CAPABILITIES: CoreCapability[] = ['listVersions', 'installVersion']

export const LOCAL_CORE_PLATFORMS: CorePlatform[] = [
  'windows-x64',
  'windows-arm64',
  'macos-x64',
  'macos-arm64',
  'linux-x64',
  'linux-arm64',
]

export const REMOTE_CORE_PLATFORMS: CorePlatform[] = ['linux-x64', 'linux-arm64', 'macos-x64']

export function remoteCoreTargetId(machineId: string, remoteProfile: string): string {
  return `remote:${machineId}:${remoteProfile}`
}
