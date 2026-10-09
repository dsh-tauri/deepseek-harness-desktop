import type { ProviderRuntime } from '../service/provider.types'

export const providerRuntime: ProviderRuntime = {
  fiber: undefined,
  chain: Promise.resolve(),
  disposed: false,
}

export function resetProviderRuntime(): void {
  providerRuntime.fiber = undefined
  providerRuntime.chain = Promise.resolve()
  providerRuntime.disposed = false
}

export function disposeProviderRuntime(): void {
  providerRuntime.fiber = undefined
  providerRuntime.chain = Promise.resolve()
  providerRuntime.disposed = true
}
