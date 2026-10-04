import type { IncompatibleVersion, PolicyBlockedVersion } from '../preinstall/types'
import type { DshPlugin, PluginErrorInfo } from '@/types'

export type BlockedRefusal
  = | { kind: 'incompatible', versions: IncompatibleVersion[] }
    | { kind: 'policy', versions: PolicyBlockedVersion[] }
    // update-hold 是逐项核验的结果：一次升级可能有的插件装上了、有的没变化、有的只是太新
    // 需要授权。`versions` 只放能写进档案豁免清单的条目（带得出新版本号的），`retryableNames`
    // 是可以就地授权的那几个，`heldNames` 是完全查不到更新版本的（来源被钉死）——它们只能
    // 报「保持原样」，不能进授权流程。
    | { kind: 'update-hold', versions: PolicyBlockedVersion[], retryable: boolean, retryableNames: string[], heldNames: string[] }

export interface Plugin {
  id: string
  name: string
  version: string
  description: string
  repoUrl: string
  bundled: boolean
  disabled: boolean
  patchDisabled: boolean
  recommended: boolean
  fix: boolean
  internal: boolean
  hasSnapshot: boolean
  error: PluginErrorInfo | null
  latest: string | null
  updateAvailable: boolean
  incompatible: boolean
  latestIncompatible: boolean
}

export type PluginRef = string | { spec: string, version?: string }

export type PluginProcessType = 'install' | 'upgrade' | 'uninstall' | 'disable' | 'enable'

export type PluginProcessStatus = 'pending' | 'running' | 'unauthorized'

export type PluginProcessReason
  = | 'not-installed'
    | 'already-absent'
    | 'update-hold'
    | 'rejected'
    | 'cancelled'
    | 'retry-exhausted'

export interface PluginProcess {
  id: string
  groupId: string
  type: PluginProcessType
  status: PluginProcessStatus
  spec: string
  name: string
  version?: string
  refusal?: BlockedRefusal
  progressKey?: string
  approvalKey?: string
}

export interface PluginProcessResult {
  process: PluginProcess
  ok: boolean
  error?: string
  code?: string
  reason?: PluginProcessReason
}

export interface PluginManagerLog {
  at: number
  level: 'info' | 'error'
  message: string
  groupId?: string
  processId?: string
}

export type PluginSearchProblem = 'invalid-spec' | 'not-found' | 'local-missing' | 'network' | 'unsupported' | 'unknown'

export interface PluginSearchResult {
  spec: string
  name?: string
  version?: string
  compatible: boolean | null
  peers?: Record<string, string>
  problem?: PluginSearchProblem
}

export interface PluginsManagerRuntime {
  toast: boolean
  restartOnSettle: boolean
  clearConfigOverride?: boolean
}

export interface PluginGroup {
  id: string
  type: PluginProcessType
  status: 'pending' | 'active' | 'settled'
  processIds: string[]
  attempt: number
  pending: string[]
  results: PluginProcessResult[]
  resume?: () => void
  done: Promise<PluginProcessResult[]>
  resolveDone: (results: PluginProcessResult[]) => void
  options: PluginsManagerRuntime
}

export interface PluginsState {
  groups: PluginGroup[]
  processes: PluginProcess[]
  logs: PluginManagerLog[]
  activeGroupId: string | null
  cancelling: boolean
  installedSource: DshPlugin[]
  installedLoaded: boolean
  progressKey: string | null
  progressDetail: string
  queueResults: PluginProcessResult[]
}

export type { DshPlugin }
