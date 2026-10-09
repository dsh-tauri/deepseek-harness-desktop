export interface ExtensionRouteDeps {
  profileDirPath: string
  remountProvider: () => Promise<void>
}

export interface ActionResult {
  ok: boolean
  error?: string
}

export interface SkillRepositoryView {
  id: string
  label: string
  kind: 'local' | 'git'
  githubUrl?: string
}

export interface SkillRowView {
  name: string
  description: string
  whenToUse?: string
  invocation: { modelInvocable: boolean, userInvocable: boolean }
  source: string
  provider: string
  editable: boolean
  removable: boolean
  dir?: string
  policyEditable: boolean
  repository?: SkillRepositoryView
}

export interface SkillsResponse {
  skills: SkillRowView[]
}

export interface SkillContentResponse {
  name: string
  content: string
}

export interface SkillSourceView {
  id: string
  kind: 'local' | 'git'
  label: string
  url?: string
  ref?: string
  path?: string
  roots: string[]
  materialDir?: string
  addedAt: number
  live: boolean
}

export interface RootAddResponse {
  ok: boolean
  root: SkillSourceView
}

export interface ImportedServerView {
  agent: 'claude-code' | 'codex' | 'cursor' | 'gemini'
  name: string
  transport: 'stdio' | 'streamable-http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

export interface McpRowView {
  id: string
  layer?: 'global' | 'profile'
  shadowed?: boolean
  scope?: 'global' | 'profile'
  serverName: string
  transport: 'stdio' | 'streamable-http'
  disabled: boolean
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
}

export interface McpListResponse {
  servers: McpRowView[]
  globalError?: string
  restartNeeded: boolean
}

export interface McpSaveResponse {
  ok: boolean
  id: string
  restartNeeded: boolean
}

export interface McpActionResult {
  ok: boolean
  restartNeeded: boolean
}

export interface McpCheckResponse {
  ok: boolean
  detail: string
}

export interface McpImportScanResponse {
  servers: ImportedServerView[]
  existing: string[]
}

export interface McpApplyImportResponse {
  ok: boolean
  results: Array<{ name: string, ok: boolean, error?: string }>
  restartNeeded: boolean
}

export interface SkillSaveBody {
  name: string
  description: string
  whenToUse?: string
  modelInvocable?: boolean
  userInvocable?: boolean
  content: string
}

export interface SkillDeleteBody {
  name: string
}

export interface SkillPolicyBody {
  name: string
  enabled: boolean
}

export interface SkillOpenBody {
  target: 'user-skills' | 'plugin-state' | 'skill' | 'root'
  name?: string
  id?: string
}

export interface RootAddBody {
  kind: 'local' | 'git'
  path?: string
  url?: string
}

export interface RootRemoveBody {
  id: string
}

export interface McpSaveBody {
  id: string
  serverName: string
  transport: 'stdio' | 'streamable-http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  scope?: 'global' | 'profile'
}

export interface McpRemoveBody {
  id: string
  scope?: 'global' | 'profile'
}

export interface McpToggleBody {
  id: string
  disabled: boolean
  scope?: 'global' | 'profile'
}

export interface McpCheckBody {
  id: string
  scope?: 'global' | 'profile'
}

export interface McpImportApplyBody {
  items: Array<{ agent: string, name: string }>
  scope?: 'global' | 'profile'
}
