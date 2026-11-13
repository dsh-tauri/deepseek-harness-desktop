import type { RemoteMachineStage, RemoteMachineTerminal, RemoteProgress } from '../types/index'
import type { RemoteArch, RemoteAssetMatrix, RemoteOs } from '../utils/assets'

export interface BootstrapLogLine {
  stage: RemoteMachineStage
  line: string
}

/** 发行包可用性：`available` 可下载；`missing` 已确认不存在（404）；`unknown` 网络不可达无法判定。 */
export type ReleaseAvailability = 'available' | 'missing' | 'unknown'

export interface DshNpmPlan {
  kind: 'npm-tgz'
  urls: string[]
  integrity?: string
  packageName: string
  version: string
}

export interface DshZipPlan {
  kind: 'pkg-zip'
  urls: string[]
  digest?: string
  zipName: string
  tag: string
}

export interface RemoteInstallPlan {
  os: RemoteOs
  arch: RemoteArch
  matrix: RemoteAssetMatrix
  repo: string
  dshEntry: string
  dshVersion: string
  node: { urls: string[], shasumUrls: string[], shasumSha256: string, filename: string, version: string }
  dsh: DshNpmPlan | DshZipPlan
  pnpm: { urls: string[], sha256: string, version: string }
  notes: string[]
}

export interface EnvCredentials {
  apiKey?: string
  baseUrl?: string
}

export interface BootstrapHooks {
  onProgress?: (progress: RemoteProgress) => void
  onEvent?: (stage: RemoteMachineStage, line: string, options?: { terminal?: RemoteMachineTerminal, reason?: string }) => void
}
