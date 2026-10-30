import type { JsonValue, LlmModelDiscoveryRequest, RemoteResult, LlmDiscoveredModel as UILlmDiscoveredModel } from 'dsh-tauri-ui/client'

export type { JsonValue, LlmModelDiscoveryRequest, RemoteFailure, RemoteResult } from 'dsh-tauri-ui/client'

export interface CredentialInfo {
  configured: boolean
  source?: string
  writable: boolean
}

export interface SettingsSecretView {
  path: string[]
  set: boolean
}

export interface SettingsNamespaceView {
  ns: string
  schema: JsonValue
  value: JsonValue
  base?: JsonValue
  user?: JsonValue
  applies: 'live' | 'restart'
  secrets: SettingsSecretView[]
  revision: number
}

export type SettingsPathOpView
  = | { op: 'set', path: string[], value: JsonValue }
    | { op: 'unset', path: string[] }

export interface LlmProviderInfo {
  id: string
  name: string
}

export interface LlmConfigurableProvider {
  provider: string
  displayName: string
  settingsNs: string
  settingsPath: readonly string[]
  declared?: boolean
  error?: string
}

export interface LlmCatalogModel {
  id: string
  name: string
  description?: string
}

export interface LlmCatalogGroup {
  id: string
  name: string
  models: readonly LlmCatalogModel[]
}

export interface LlmModelCatalog {
  default: { provider: string, model: string, reasoningEffort?: string }
  routableProviders: readonly string[]
  groups: readonly LlmCatalogGroup[]
}

export interface LlmDiscoveredModel extends UILlmDiscoveredModel {
  inputModalities?: readonly string[]
}

export interface SettingsRemote {
  mutate: (ns: string, ops: SettingsPathOpView[], expectedRevision?: number) => Promise<RemoteResult<SettingsNamespaceView>>
}

export interface CredentialsRemote {
  describe: (refs: string[]) => Promise<RemoteResult<Record<string, CredentialInfo>>>
  set: (ref: string, value: string) => Promise<RemoteResult<unknown>>
  unset: (ref: string) => Promise<RemoteResult<unknown>>
}

export interface LlmRemote {
  listProviders: () => Promise<RemoteResult<LlmProviderInfo[]>>
  listConfigurableProviders: () => Promise<RemoteResult<LlmConfigurableProvider[]>>
  discoverModels: (settingsNs: string, request: LlmModelDiscoveryRequest) => Promise<RemoteResult<LlmDiscoveredModel[]>>
}

export interface WorkspacePathApplication {
  id: string
  name: string
  default: boolean
  icon: string | null
}

export interface SessionRemote {
  modelCatalog: () => Promise<RemoteResult<LlmModelCatalog>>
  canOpenWorkspacePath?: () => Promise<RemoteResult<boolean>>
  openWorkspacePath?: (request: { path: string, action?: 'reveal', application?: string }) => Promise<RemoteResult<unknown>>
  workspacePathApplications?: (request: { path: string }) => Promise<RemoteResult<WorkspacePathApplication[]>>
}

export type RemoteEventName = 'settings/document-updated' | 'credentials/reference-updated' | 'credentials/record-updated' | 'llm/adapters-updated'

export interface ClientRemote {
  settings: SettingsRemote
  credentials: CredentialsRemote
  llm: LlmRemote
  session: SessionRemote
  $on: (event: RemoteEventName, listener: () => void) => () => void
}
