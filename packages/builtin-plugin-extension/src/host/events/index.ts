import { createHooks } from 'hookable'

export interface ProviderLifecycleHooks {
  'provider:before-remount': () => void
  'provider:after-remount': (roots: string[]) => void
  'provider:error': (error: unknown) => void
}

export const providerHooks = createHooks<ProviderLifecycleHooks>()
