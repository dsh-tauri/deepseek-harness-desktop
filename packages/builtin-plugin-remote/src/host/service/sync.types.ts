import type { Buffer } from 'node:buffer'
import type { SyncSkillRoot } from '../types/index'

export interface SyncSkillScan {
  root: SyncSkillRoot
  dir: string
  names: string[]
}

export interface SyncDeps {
  profileDependencies: () => Record<string, string>
  scanSkills: () => SyncSkillScan[]
  packSkills: (dir: string, names: readonly string[]) => Promise<Buffer>
  commandTimeoutMs?: number
}
