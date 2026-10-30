import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {
  ClientRemote,
  CredentialInfo,
  LlmConfigurableProvider,
  LlmModelCatalog,
  LlmProviderInfo,
  RemoteResult,
  SettingsNamespaceView,
} from '../types/remotes.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

const PROBE_ROUTE = '\u0000probe'

export interface ProviderDirectoryEntry {
  readonly provider: string
  readonly displayName: string
  readonly settingsNs: string
  readonly settingsPath: readonly string[]
  readonly active: boolean
  readonly declared?: boolean
  readonly error?: string
}

export function joinProviderDirectory(
  registered: readonly LlmProviderInfo[],
  directory: readonly LlmConfigurableProvider[],
): ProviderDirectoryEntry[] {
  const active = new Set(registered.map(provider => provider.id))
  const declared = new Set(directory.map(entry => entry.provider))
  const rows: ProviderDirectoryEntry[] = directory.map(entry => ({
    provider: entry.provider,
    displayName: entry.displayName,
    settingsNs: entry.settingsNs,
    settingsPath: [...entry.settingsPath],
    active: active.has(entry.provider),
    ...entry.declared === undefined ? {} : { declared: entry.declared },
    ...entry.error === undefined ? {} : { error: entry.error },
  }))
  for (const provider of registered) {
    if (declared.has(provider.id))
      continue
    rows.push({
      provider: provider.id,
      displayName: provider.name,
      settingsNs: '',
      settingsPath: [],
      active: true,
    })
  }
  return [...rows].sort((left, right) => routeRank(left.provider) - routeRank(right.provider))
}

function routeRank(provider: string): number {
  if (provider === 'deepseek-account')
    return 0
  return provider === 'deepseek-official' ? 1 : 2
}

export interface ProviderRow {
  entry: ProviderDirectoryEntry
  configured: boolean
  removable: boolean
  apiKeyEnv: string | undefined
  credential: CredentialInfo | undefined
  derivedCredential?: CredentialInfo
  accountAvailable?: boolean
}

const ACCOUNT_PROVIDER = 'deepseek-account'

export interface ModelsSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  credentialError: string | null
  writable: boolean
  rows: readonly ProviderRow[]
  namespaces: ReadonlyMap<string, SettingsNamespaceView>
}

export function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

async function modelCatalogOf(remote: ClientRemote): Promise<RemoteResult<LlmModelCatalog> | undefined> {
  try {
    const session = remote.session
    const call = session?.modelCatalog
    if (typeof call !== 'function')
      return undefined
    return await call.call(session)
  }
  catch {
    return undefined
  }
}

export function protocolChoices(
  namespace: SettingsNamespaceView | undefined,
  schema: SettingsSchemaOperations,
): string[] {
  if (namespace === undefined)
    return []
  const node = schema.nodeAtPath(schema.rehydrate(namespace.schema), ['providers', PROBE_ROUTE, 'api'])
  const list = node as { type?: string, list?: readonly { value?: unknown }[] } | undefined
  if (list?.type !== 'union' || list.list === undefined)
    return []
  return list.list.map(entry => entry.value).filter((value): value is string => typeof value === 'string')
}

function apiKeyEnvOf(
  namespace: SettingsNamespaceView | undefined,
  path: readonly string[],
  schema: SettingsSchemaOperations,
): string | undefined {
  if (namespace === undefined)
    return undefined
  const profile = schema.getPath(namespace.value, path)
  if (typeof profile !== 'object' || profile === null)
    return undefined
  const ref = (profile as { apiKeyEnv?: unknown }).apiKeyEnv
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined
}

export class ModelsSettingsStore {
  readonly store: SnapshotStore<ModelsSettingsState> = createSnapshotStore<ModelsSettingsState>({
    status: 'idle',
    error: null,
    credentialError: null,
    writable: false,
    rows: [],
    namespaces: new Map(),
  })

  private generation = 0

  constructor(
    private readonly remote: ClientRemote,
    private readonly schema: SettingsSchemaOperations,
    private readonly describeFace: SettingsDescribeFace,
  ) {}

  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((s) => {
      s.status = 'loading'
      s.error = null
    })
    const [registered, declared] = await Promise.all([
      this.remote.llm.listProviders(),
      this.remote.llm.listConfigurableProviders(),
      this.describeFace.ensure(),
    ])
    if (!registered.ok) {
      this.failLoad(generation, registered.error.message)
      return
    }
    if (!declared.ok) {
      this.failLoad(generation, declared.error.message)
      return
    }
    const mirrored = this.describeFace.getSnapshot()
    if (mirrored.view === undefined) {
      this.failLoad(generation, mirrored.error ?? 'settings are unavailable in this browser')
      return
    }
    const providers = joinProviderDirectory(registered.value, declared.value)
    const writable = mirrored.view.writable
    const views: readonly SettingsNamespaceView[] = mirrored.view.namespaces
    const namespaces = new Map(views.map(view => [view.ns, view]))
    const rows: ProviderRow[] = providers.map((entry) => {
      const namespace = namespaces.get(entry.settingsNs)
      const configured = namespace !== undefined
        && (entry.settingsPath.length === 0 || this.schema.getPath(namespace.value, entry.settingsPath) !== undefined)
      const removable = namespace !== undefined
        && entry.settingsPath.length > 0
        && this.schema.hasPath(namespace.user, entry.settingsPath)
        && !this.schema.hasPath(namespace.base, entry.settingsPath)
      return {
        entry,
        configured,
        removable,
        apiKeyEnv: entry.provider === ACCOUNT_PROVIDER
          ? undefined
          : apiKeyEnvOf(namespace, entry.settingsPath, this.schema),
        credential: undefined,
      }
    })
    if (rows.some(row => row.entry.provider === ACCOUNT_PROVIDER))
      await this.joinAccountAvailability(rows)
    const refs = [...new Set(rows.filter(row => row.entry.provider !== ACCOUNT_PROVIDER).map(row => row.apiKeyEnv ?? deriveKeyRef(row.entry.provider)))]
    let credentials: Record<string, CredentialInfo> = {}
    let credentialError: string | null = null
    if (refs.length > 0) {
      const response = await this.remote.credentials.describe(refs)

      if (response.ok)
        credentials = response.value
      else credentialError = response.error.message
    }
    if (generation !== this.generation)
      return
    this.store.update((s) => {
      s.status = 'ready'
      s.error = null
      s.credentialError = credentialError
      s.writable = writable
      s.rows = rows
        .filter(row => row.entry.provider !== ACCOUNT_PROVIDER || row.accountAvailable === true)
        .map((row) => {
          if (row.entry.provider === ACCOUNT_PROVIDER)
            return row
          const named = row.apiKeyEnv === undefined ? undefined : credentials[row.apiKeyEnv]
          const derived = row.apiKeyEnv !== undefined ? undefined : credentials[deriveKeyRef(row.entry.provider)]
          return {
            ...row,
            ...named === undefined ? {} : { credential: named },
            ...derived === undefined ? {} : { derivedCredential: derived },
          }
        })
      s.namespaces = namespaces
    })
  }

  private async joinAccountAvailability(rows: ProviderRow[]): Promise<void> {
    const catalog = await modelCatalogOf(this.remote)
    const available = catalog?.ok === true
      && catalog.value.groups.some(group => group.id === ACCOUNT_PROVIDER && group.models.length > 0)
    for (const row of rows) {
      if (row.entry.provider === ACCOUNT_PROVIDER)
        row.accountAvailable = available
    }
  }

  private failLoad(generation: number, message: string): void {
    if (generation !== this.generation)
      return
    this.store.update((s) => {
      s.status = 'error'
      s.error = message
    })
  }
}

export function providerUsable(row: ProviderRow): boolean {
  if (!row.entry.active)
    return false
  if (row.entry.provider === ACCOUNT_PROVIDER)
    return row.accountAvailable === true
  if (row.apiKeyEnv === undefined)
    return true
  return row.credential?.configured === true
}

export type OnboardingReadiness
  = | { kind: 'loading' }
    | { kind: 'adapter-absent' }
    | { kind: 'provider-ready' }
    | { kind: 'credential-missing' }
    | {
      kind: 'unavailable'
      reason:
        | 'load-failed'
        | 'provider-inactive'
        | 'credentials-unavailable'
        | 'settings-read-only'
        | 'credential-read-only'
    }

export function onboardingReadiness(state: ModelsSettingsState): OnboardingReadiness {
  if ((state.status === 'idle' || state.status === 'loading') && state.rows.length === 0) {
    return { kind: 'loading' }
  }
  if (state.status === 'error') {
    return {
      kind: 'unavailable',
      reason: 'load-failed',
    }
  }
  if (state.rows.some(providerUsable))
    return { kind: 'provider-ready' }
  const row = state.rows.find(candidate =>
    candidate.entry.provider === 'deepseek-official'
    && candidate.entry.settingsNs === 'llm-deepseek'
    && candidate.entry.settingsPath.length === 0)
  if (row === undefined)
    return { kind: 'adapter-absent' }
  if (!row.entry.active) {
    return {
      kind: 'unavailable',
      reason: 'provider-inactive',
    }
  }

  if (state.credentialError !== null || row.credential === undefined) {
    return {
      kind: 'unavailable',
      reason: 'credentials-unavailable',
    }
  }
  if (!state.writable) {
    return {
      kind: 'unavailable',
      reason: 'settings-read-only',
    }
  }
  if (!row.credential.writable) {
    return {
      kind: 'unavailable',
      reason: 'credential-read-only',
    }
  }
  return { kind: 'credential-missing' }
}
