import type { SshMachineStage, SshMachineTerminal, SshProgress } from '../types/index'
import type { RemoteArch, RemoteAssetMatrix, RemoteOs } from '../utils/assets'

export interface BootstrapLogLine {
  stage: SshMachineStage
  line: string
}

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
  onProgress?: (progress: SshProgress) => void
  onEvent?: (stage: SshMachineStage, line: string, options?: { terminal?: SshMachineTerminal, reason?: string }) => void
}
