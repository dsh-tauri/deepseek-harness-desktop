import type { HostPluginLoader, WebFetchProviderService, WebFetchRequest, WebFetchResult, WebRuntimeService } from '../types'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import process from 'node:process'
import ipaddr from 'ipaddr.js'

export const FAKE_IP_FETCH_PROVIDER_ID = 'http'
export const DEFAULT_FAKE_IP_CIDRS = ['198.18.0.0/15'] as const
const FAKE_IP_NETWORK = 0xC6120000
const FAKE_IP_MASK = 0xFFFE0000
const IPV4_MAX = 0xFFFFFFFF
const RFC6052_PREFIX_LENGTHS = [32, 40, 48, 56, 64, 96] as const
const IPV4ONLY_DISCOVERY_HOST = 'ipv4only.arpa'
const IPV4ONLY_SENTINELS = new Set(['192.0.0.170', '192.0.0.171'])

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

interface LoadedHttpFetchProvider {
  readonly id: string
  available: () => boolean
  fetch: (request: WebFetchRequest, signal?: AbortSignal) => Promise<WebFetchResult>
}

interface LoadedHttpFetchModule {
  readonly Config: (config: Record<string, unknown>) => HttpFetchLimits
  readonly HttpFetchProvider: new (
    limits: HttpFetchLimits,
    resolveAddresses?: HttpFetchResolver,
  ) => LoadedHttpFetchProvider
}

interface LoadedWebModule {
  readonly WebError: new (
    message: string,
    code: string,
    options?: { readonly cause?: unknown },
  ) => Error
}

interface HttpFetchLimits {
  readonly maxResponseBytes: number
  readonly maxBodyChars: number
  readonly timeoutMs: number
  readonly maxRedirects: number
  readonly userAgent: string
}

interface Nat64Prefix {
  readonly bytes: readonly number[]
  readonly length: number
}

export function createFakeIpResolver(options: FakeIpResolverOptions = {}): HttpFetchResolver {
  const resolve = options.lookup ?? defaultLookup
  const createError = options.createError ?? defaultError
  const ranges = parseFakeIpCidrs(options.fakeIpCidrs ?? DEFAULT_FAKE_IP_CIDRS)

  return async (hostname, signal) => {
    const { addresses, literal } = await resolveAddressSet(hostname, signal, resolve, createError)
    try {
      await assertPublicAddresses(hostname, addresses, signal, resolve, createError)
      return addresses
    }
    catch (error) {
      if (!isBlockedAddressError(error) || literal)
        throw error
      if (addresses.every(address => isFakeIp(address.address, address.family, ranges)))
        return addresses
      throw error
    }
  }
}

export function createStrictPublicResolver(options: StrictResolverOptions = {}): HttpFetchResolver {
  const resolve = options.lookup ?? defaultLookup
  const createError = options.createError ?? defaultError

  return async (hostname, signal) => {
    const { addresses } = await resolveAddressSet(hostname, signal, resolve, createError)
    await assertPublicAddresses(hostname, addresses, signal, resolve, createError)
    return addresses
  }
}

async function resolveAddressSet(
  hostname: string,
  signal: AbortSignal,
  resolve: AddressLookup,
  createError: WebErrorFactory,
): Promise<{ readonly addresses: PublicAddress[], readonly literal: boolean }> {
  throwIfAborted(signal)
  const unbracketed = stripIpv6Brackets(hostname)
  const literalFamily = isIP(unbracketed)
  const literal = literalFamily !== 0
  const resolved = literal
    ? [{ address: unbracketed, family: literalFamily as 4 | 6 }]
    : await resolveLookup(hostname, unbracketed, signal, resolve, createError)
  throwIfAborted(signal)
  const addresses = validateAnswers(hostname, resolved, createError)
  return { addresses, literal }
}

async function resolveLookup(
  hostname: string,
  lookupHostname: string,
  signal: AbortSignal,
  resolve: AddressLookup,
  createError: WebErrorFactory,
): Promise<readonly DnsLookupAddress[]> {
  try {
    return await raceWithSignal(resolve(lookupHostname, { all: true, order: 'verbatim' }), signal)
  }
  catch (error) {
    if (signal.aborted)
      throw error
    if (isWebError(error))
      throw error
    throw createError(`failed to resolve hostname "${hostname}"`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
}

async function assertPublicAddresses(
  hostname: string,
  addresses: readonly PublicAddress[],
  signal: AbortSignal,
  resolve: AddressLookup,
  createError: WebErrorFactory,
): Promise<void> {
  const nat64Prefixes = addresses.some(entry => entry.family === 6)
    ? await discoverNat64Prefixes(signal, resolve, createError)
    : []
  throwIfAborted(signal)
  for (const address of addresses) {
    if (!isPublicAddress(address.address))
      throw blockedAddressError(hostname, createError)
    const translatedIpv4 = translatedIpv4Address(address.address, nat64Prefixes)
    if (translatedIpv4 !== undefined && !isPublicAddress(translatedIpv4))
      throw createError(`URL hostname "${hostname}" resolves through NAT64 to a non-public IPv4 address`, 'WEB_BLOCKED_URL')
  }
}

export async function registerFakeIpFetchProvider(
  web: WebRuntimeService,
  loader: HostPluginLoader,
  fakeIpCidrs = readFakeIpCidrs(),
): Promise<() => void> {
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
}

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
    fetch: async (_request, signal) => {
      if (signal?.aborted)
        throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
      throw unavailable
    },
  })
}

export function parseFakeIpCidrs(cidrs: readonly string[]): readonly IPv4Range[] {
  if (cidrs.length === 0)
    return []
  return cidrs.map(parseFakeIpCidr)
}

export function validateAnswers(
  hostname: string,
  answers: readonly DnsLookupAddress[],
  createError: WebErrorFactory = defaultError,
): PublicAddress[] {
  if (!Array.isArray(answers) || answers.length === 0)
    throw createError(`hostname "${hostname}" resolved to no addresses`, 'WEB_PROVIDER_ERROR')
  return answers.map((answer) => {
    if (answer === null || typeof answer !== 'object' || typeof answer.address !== 'string'
      || (answer.family !== 4 && answer.family !== 6) || isIP(answer.address) !== answer.family) {
      throw createError(`hostname "${hostname}" resolved to an invalid IP address`, 'WEB_PROVIDER_ERROR')
    }
    return { address: answer.address, family: answer.family }
  })
}

export function isFakeIp(
  address: string,
  family: 4 | 6,
  ranges: readonly IPv4Range[],
): boolean {
  if (family !== 4 || isIP(address) !== 4)
    return false
  const numeric = ipv4ToNumber(address)
  return ranges.some(({ network, mask }) => ((numeric & mask) >>> 0) === network)
}

export function isPublicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.parse(stripIpv6Brackets(address))
    if (parsed instanceof ipaddr.IPv4)
      return parsed.range() === 'unicast'
    if (parsed.isIPv4MappedAddress())
      return parsed.toIPv4Address().range() === 'unicast'
    return parsed.range() === 'unicast'
  }
  catch {
    return false
  }
}

function isWebError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error))
    return false
  const code = (error as { readonly code?: unknown }).code
  return typeof code === 'string' && code.startsWith('WEB_')
}

function isBlockedAddressError(error: unknown): boolean {
  return isWebError(error)
    && (error as { readonly code?: unknown }).code === 'WEB_BLOCKED_URL'
}

function blockedAddressError(hostname: string, createError: WebErrorFactory): Error {
  return createError(`URL hostname "${hostname}" resolves to a non-public IP address`, 'WEB_BLOCKED_URL')
}

async function discoverNat64Prefixes(
  signal: AbortSignal,
  resolve: AddressLookup,
  createError: WebErrorFactory,
): Promise<Nat64Prefix[]> {
  const discovered = await resolveLookup(
    IPV4ONLY_DISCOVERY_HOST,
    IPV4ONLY_DISCOVERY_HOST,
    signal,
    resolve,
    createError,
  )
  if (!Array.isArray(discovered))
    throw createError(`hostname "${IPV4ONLY_DISCOVERY_HOST}" resolved to invalid addresses`, 'WEB_PROVIDER_ERROR')
  const prefixes: Nat64Prefix[] = []
  const seen = new Set<string>()
  for (const entry of discovered) {
    if (entry === null || typeof entry !== 'object' || typeof entry.address !== 'string'
      || (entry.family !== 4 && entry.family !== 6) || isIP(entry.address) !== entry.family) {
      throw createError(`hostname "${IPV4ONLY_DISCOVERY_HOST}" resolved to an invalid IP address`, 'WEB_PROVIDER_ERROR')
    }
    if (entry.family !== 6)
      continue
    const bytes = ipaddr.parse(entry.address).toByteArray()
    for (const length of RFC6052_PREFIX_LENGTHS) {
      const embedded = embeddedIpv4Address(bytes, length)
      if (embedded === undefined || !IPV4ONLY_SENTINELS.has(embedded))
        continue
      const prefixBytes = bytes.slice(0, length / 8)
      const key = `${length}:${prefixBytes.join('.')}`
      if (seen.has(key))
        continue
      seen.add(key)
      prefixes.push({ bytes: prefixBytes, length })
    }
  }
  return prefixes
}

function translatedIpv4Address(input: string, prefixes: readonly Nat64Prefix[]): string | undefined {
  if (isIP(input) !== 6)
    return undefined
  const bytes = ipaddr.parse(input).toByteArray()
  for (const prefix of prefixes) {
    if (!prefix.bytes.every((byte, index) => bytes[index] === byte))
      continue
    return embeddedIpv4Address(bytes, prefix.length)
  }
  return undefined
}

function embeddedIpv4Address(bytes: readonly number[], prefixLength: number): string | undefined {
  if (prefixLength === 96)
    return bytes.slice(12, 16).join('.')
  if (bytes[8] !== 0)
    return undefined
  const prefixBytes = prefixLength / 8
  const beforeReservedOctet = 8 - prefixBytes
  return [...bytes.slice(prefixBytes, prefixBytes + beforeReservedOctet), ...bytes.slice(9, 13 - beforeReservedOctet)].join('.')
}

function parseFakeIpCidr(cidr: string): IPv4Range {
  const [address, prefixText, ...extra] = cidr.trim().split('/')
  if (extra.length > 0 || prefixText === undefined || isIP(address) !== 4)
    throw new Error(`invalid fake IP CIDR "${cidr}"`)
  const prefix = Number(prefixText)
  if (!Number.isInteger(prefix) || prefix < 15 || prefix > 32)
    throw new Error(`invalid fake IP CIDR "${cidr}"`)
  const mask = (IPV4_MAX << (32 - prefix)) >>> 0
  const network = (ipv4ToNumber(address) & mask) >>> 0
  if ((network & FAKE_IP_MASK) >>> 0 !== FAKE_IP_NETWORK)
    throw new Error(`fake IP CIDR must be within ${DEFAULT_FAKE_IP_CIDRS[0]}`)
  return { network, mask }
}

function ipv4ToNumber(address: string): number {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255))
    throw new Error(`invalid IPv4 address "${address}"`)
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0
}

async function defaultLookup(hostname: string, options: { all: true, order: 'verbatim' }): Promise<readonly DnsLookupAddress[]> {
  const answers = await lookup(hostname, options)
  return answers.map(answer => ({
    address: answer.address,
    family: answer.family === 4 || answer.family === 6 ? answer.family : 0,
  }))
}

function readFakeIpCidrs(): readonly string[] {
  const configured = process.env.DSH_TAURI_FAKE_IP_CIDRS
  if (configured === undefined)
    return DEFAULT_FAKE_IP_CIDRS
  return configured.split(',').map(cidr => cidr.trim()).filter(Boolean)
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

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal)
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const onAbort = () => {
      if (settled)
        return
      settled = true
      reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        if (settled)
          return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        if (settled)
          return
        settled = true
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}
