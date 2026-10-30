export interface HostSkill {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: { modelInvocable: boolean, userInvocable: boolean }
  readonly source: string
  readonly provider: string
  readonly resourceBase?: { kind: 'directory', path: string } | { kind: 'url', url: string } | { kind: 'opaque', description: string }
}

export interface HostSkillDefinition {
  readonly name: string
  readonly content: string
  readonly path?: string
  readonly resourceBase?: HostSkill['resourceBase']
}

export interface SkillsService {
  list: (options?: { cwd?: string }) => Promise<HostSkill[]>
  get: (name: string, options?: { cwd?: string }) => Promise<HostSkillDefinition | undefined>
}

export interface SkillInput {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
  content: string
}

export interface SkillRepositoryMetadata {
  id: string
  label: string
  kind: 'local' | 'git'
  githubUrl?: string
}

export type SkillRow = HostSkill & {
  editable: boolean
  removable: boolean
  dir?: string
  policyEditable: boolean
  repository?: SkillRepositoryMetadata
}

export interface SkillSourceEntry {
  id: string
  kind: 'local' | 'git'
  label: string
  url?: string
  ref?: string
  path?: string
  roots: string[]
  materialDir?: string
  addedAt: number
}

export interface PluginState {
  skillRoots: SkillSourceEntry[]
}

export type SkillSourceView = SkillSourceEntry & { live: boolean }
