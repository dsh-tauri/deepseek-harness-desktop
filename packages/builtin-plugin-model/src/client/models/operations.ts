import type { ModelDiscoveryOutcome } from '../service/model-config.ts'
import type {
  ClientRemote,
  CredentialInfo,
  LlmModelDiscoveryRequest,
  SettingsNamespaceView,
  SettingsPathOpView,
} from '../types/remotes.ts'

export type SettingsWriteOutcome
  = | { readonly kind: 'written', readonly view: SettingsNamespaceView }
    | { readonly kind: 'conflict', readonly message: string }
    | { readonly kind: 'refused', readonly message: string }

export type { ModelDiscoveryOutcome } from '../service/model-config.ts'

export interface ModelsOperations {
  describeCredential: (ref: string) => Promise<CredentialInfo | undefined>
  storeCredential: (ref: string, value: string) => Promise<string | undefined>
  removeCredential: (ref: string) => Promise<string | undefined>
  writeSettings: (
    ns: string,
    ops: SettingsPathOpView[],
    expectedRevision: number | undefined,
  ) => Promise<SettingsWriteOutcome>
  discoverModels: (settingsNs: string, request: LlmModelDiscoveryRequest) => Promise<ModelDiscoveryOutcome>
}

export function createModelsOperations(remote: ClientRemote): ModelsOperations {
  return {
    describeCredential: async (ref) => {
      const response = await remote.credentials.describe([ref])
      return response.ok ? response.value[ref] : undefined
    },
    storeCredential: async (ref, value) => {
      const response = await remote.credentials.set(ref, value)
      return response.ok ? undefined : response.error.message
    },
    removeCredential: async (ref) => {
      const response = await remote.credentials.unset(ref)
      return response.ok ? undefined : response.error.message
    },
    writeSettings: async (ns, ops, expectedRevision) => {
      const response = await remote.settings.mutate(ns, ops, expectedRevision)
      if (response.ok)
        return { kind: 'written', view: response.value }
      const { code, message } = response.error
      return code === 'settings/conflict' ? { kind: 'conflict', message } : { kind: 'refused', message }
    },
    discoverModels: async (settingsNs, request) => {
      const response = await remote.llm.discoverModels(settingsNs, request)
      return response.ok
        ? { kind: 'found', models: response.value }
        : { kind: 'refused', message: response.error.message }
    },
  }
}
