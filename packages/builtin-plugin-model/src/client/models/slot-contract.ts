import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { ProviderDirectoryEntry } from './store.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'settings.models.provider-card': { kind: 'keyed', scope: 'root', owner: ProviderCardExtrasOwnerProps }
    'settings.models.sign-in': { kind: 'single', scope: 'root', owner: { complete: () => void, useApiKey: () => void } }
    'settings.models.footer': { kind: 'list', scope: 'root', owner: ModelsFooterOwnerProps }
  }
}

export interface ProviderCardExtrasOwnerProps {
  provider: ProviderDirectoryEntry
  configured: boolean
  keyConfigured: boolean
}

export interface ModelsFooterOwnerProps {
  children?: never
}
