import type { WebFetchRequest, WebFetchResult } from '../types/harness'

export interface PublicAddress {
  readonly address: string
  readonly family: 4 | 6
}

export interface DnsLookupAddress {
  readonly address: string
  readonly family: number
}

export type AddressLookup = (hostname: string, options: {
  all: true
  order: 'verbatim'
}) => Promise<readonly DnsLookupAddress[]>

export type HttpFetchResolver = (
  hostname: string,
  signal: AbortSignal,
) => Promise<PublicAddress[]>

export type WebErrorFactory = (
  message: string,
  code: string,
  options?: { readonly cause?: unknown },
) => Error

export interface FakeIpResolverOptions {
  readonly lookup?: AddressLookup
  readonly fakeIpCidrs?: readonly string[]
  readonly createError?: WebErrorFactory
}

export interface StrictResolverOptions {
  readonly lookup?: AddressLookup
  readonly createError?: WebErrorFactory
}

export interface IPv4Range {
  readonly network: number
  readonly mask: number
}

export interface LoadedHttpFetchProvider {
  readonly id: string
  available: () => boolean
  fetch: (request: WebFetchRequest, signal?: AbortSignal) => Promise<WebFetchResult>
}

export interface LoadedHttpFetchModule {
  readonly Config: (config: Record<string, unknown>) => HttpFetchLimits
  readonly HttpFetchProvider: new (
    limits: HttpFetchLimits,
    resolveAddresses?: HttpFetchResolver,
  ) => LoadedHttpFetchProvider
}

export interface LoadedWebModule {
  readonly WebError: new (
    message: string,
    code: string,
    options?: { readonly cause?: unknown },
  ) => Error
}

export interface HttpFetchLimits {
  readonly maxResponseBytes: number
  readonly maxBodyChars: number
  readonly timeoutMs: number
  readonly maxRedirects: number
  readonly userAgent: string
}
