import type { WebFetchProviderService, WebFetchRequest, WebFetchResult, WebRuntimeService } from '../types'
import type { LoadedHttpFetchModule, LoadedWebModule, WebErrorFactory } from './web-fetch.types'
import { getCurrentHostInstance } from '../config/runtime'
import { defineService } from './index'
import { createFakeIpResolver, readFakeIpCidrs } from './web-fetch.utils'

const FAKE_IP_FETCH_PROVIDER_ID = 'http'

export const webFetch = defineService({
  async attach(fakeIpCidrs = readFakeIpCidrs()): Promise<() => void> {
    const { web, loader } = getCurrentHostInstance()
    let createError: WebErrorFactory | undefined
    let provider: WebFetchProviderService
    try {
      const webModule = unwrapWebModule(loader.unwrapExports(await loader.import('@deepseek-ai/dsh-web')))
      createError = (message, code, options) => new webModule.WebError(message, code, options)
      const module = unwrapHttpFetchModule(loader.unwrapExports(await loader.import('@deepseek-ai/dsh-web-fetch-http')))
      const limits = module.Config({})
      const httpProvider = new module.HttpFetchProvider(limits, createFakeIpResolver({ fakeIpCidrs, createError }))
      provider = {
        id: FAKE_IP_FETCH_PROVIDER_ID,
        available: () => httpProvider.available(),
        fetch: (request, signal) => httpProvider.fetch(request, signal),
      }
    }
    catch (error) {
      return registerUnavailableFetchProvider(web, error, createError)
    }
    return web.registerFetchProvider(provider)
  },
})

// --- internal ---

function registerUnavailableFetchProvider(
  web: WebRuntimeService,
  cause: unknown,
  createError?: WebErrorFactory,
): () => void {
  const unavailable = createError?.(
    'desktop HTTP fetch provider is unavailable',
    'WEB_PROVIDER_ERROR',
    { cause },
  ) ?? defaultError('desktop HTTP fetch provider is unavailable', 'WEB_PROVIDER_ERROR', { cause })
  return web.registerFetchProvider({
    id: FAKE_IP_FETCH_PROVIDER_ID,
    available: () => false,
    fetch: async (_request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> => {
      if (signal?.aborted)
        throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
      throw unavailable
    },
  })
}

function defaultError(message: string, code: string, options?: { readonly cause?: unknown }): Error & { readonly code: string } {
  const error = new Error(message, options) as Error & { code: string }
  error.code = code
  return error
}

function unwrapHttpFetchModule(value: unknown): LoadedHttpFetchModule {
  if (typeof value !== 'object' || value === null)
    throw new Error('dsh-web-fetch-http did not load as a module')
  const module = value as Partial<LoadedHttpFetchModule>
  if (typeof module.Config !== 'function' || typeof module.HttpFetchProvider !== 'function')
    throw new Error('dsh-web-fetch-http provider is unavailable')
  return module as LoadedHttpFetchModule
}

function unwrapWebModule(value: unknown): LoadedWebModule {
  if (typeof value !== 'object' || value === null || typeof (value as Partial<LoadedWebModule>).WebError !== 'function')
    throw new Error('@deepseek-ai/dsh-web did not load as a module')
  return value as LoadedWebModule
}
