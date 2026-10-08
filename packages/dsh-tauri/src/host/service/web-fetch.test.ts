import type { HostPluginLoader, WebFetchProviderService, WebFetchResult, WebRuntimeService } from '../types'
import type { AddressLookup, DnsLookupAddress, HttpFetchResolver } from './web-fetch.types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearHostRuntime, setCurrentHostInstance } from '../config/runtime'
import { webFetch } from './web-fetch'
import { createFakeIpResolver, createStrictPublicResolver, isFakeIp, isPublicAddress, parseFakeIpCidrs } from './web-fetch.utils'

afterEach(() => {
  clearHostRuntime()
})

const FAKE_IP_FETCH_PROVIDER_ID = 'http'
const DEFAULT_FAKE_IP_CIDRS = ['198.18.0.0/15'] as const

class TestWebError extends Error {
  readonly code: string

  constructor(message: string, code: string, options?: { readonly cause?: unknown }) {
    super(message, options)
    this.code = code
  }
}

function staticLookup(addresses: readonly DnsLookupAddress[]): AddressLookup {
  return vi.fn(async () => addresses)
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code })
}

describe('fake-IP resolver policy', () => {
  it('accepts a complete RFC 2544 Fake-IP answer set and copies the answers', async () => {
    const answers = [{ address: '198.18.0.43', family: 4 as const }]
    const lookup = staticLookup(answers)
    const resolver = createFakeIpResolver({ lookup })

    const resolved = await resolver('example.test', new AbortController().signal)

    expect(resolved).toEqual(answers)
    expect(resolved).not.toBe(answers)
    expect(resolved[0]).not.toBe(answers[0])
    expect(lookup).toHaveBeenCalledOnce()
    expect(lookup).toHaveBeenCalledWith('example.test', { all: true, order: 'verbatim' })
  })

  it('keeps public answers on the strict path without a second lookup', async () => {
    const lookup = staticLookup([{ address: '93.184.216.34', family: 4 }])
    const resolver = createFakeIpResolver({ lookup })

    await expect(resolver('example.test', new AbortController().signal)).resolves.toEqual([
      { address: '93.184.216.34', family: 4 },
    ])
    expect(lookup).toHaveBeenCalledOnce()
  })

  it('rejects mixed Fake-IP and public answers as a blocked destination', async () => {
    const lookup = staticLookup([
      { address: '198.18.0.43', family: 4 },
      { address: '93.184.216.34', family: 4 },
    ])
    const resolver = createFakeIpResolver({ lookup })

    await expectCode(resolver('example.test', new AbortController().signal), 'WEB_BLOCKED_URL')
    expect(lookup).toHaveBeenCalledOnce()
  })

  it.each([
    ['private', [{ address: '10.0.0.5', family: 4 }]],
    ['loopback', [{ address: '127.0.0.1', family: 4 }]],
    ['link-local', [{ address: '169.254.169.254', family: 4 }]],
    ['unique-local IPv6', [{ address: 'fdfe:dcba:9876::1', family: 6 }]],
    ['arbitrary reserved', [{ address: '192.0.2.1', family: 4 }]],
  ])('rejects %s answers', async (_label, answers) => {
    const resolver = createFakeIpResolver({ lookup: staticLookup(answers) })

    await expectCode(resolver('example.test', new AbortController().signal), 'WEB_BLOCKED_URL')
  })

  it('rejects empty and malformed DNS answers with provider errors', async () => {
    const emptyResolver = createFakeIpResolver({ lookup: staticLookup([]) })
    await expectCode(emptyResolver('example.test', new AbortController().signal), 'WEB_PROVIDER_ERROR')

    const malformedResolver = createFakeIpResolver({
      lookup: staticLookup([{ address: '198.18.0.43', family: 6 }]),
    })
    await expectCode(malformedResolver('example.test', new AbortController().signal), 'WEB_PROVIDER_ERROR')
  })

  it('translates DNS failures to provider errors with their cause', async () => {
    const cause = new Error('DNS unavailable')
    const lookup: AddressLookup = vi.fn(async () => {
      throw cause
    })
    const resolver = createFakeIpResolver({ lookup })

    await expect(resolver('example.test', new AbortController().signal)).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      cause,
    })
  })

  it('never turns an IP literal into a Fake-IP exception', async () => {
    const lookup = vi.fn<AddressLookup>()
    const resolver = createFakeIpResolver({ lookup })

    await expectCode(resolver('198.18.0.43', new AbortController().signal), 'WEB_BLOCKED_URL')
    expect(lookup).not.toHaveBeenCalled()
  })

  it('honors cancellation during DNS lookup', async () => {
    let releaseLookup: ((value: readonly DnsLookupAddress[]) => void) | undefined
    const lookup: AddressLookup = vi.fn(async () => new Promise<readonly DnsLookupAddress[]>((resolve) => {
      releaseLookup = resolve
    }))
    const controller = new AbortController()
    const resolver = createFakeIpResolver({ lookup })
    const pending = resolver('example.test', controller.signal)
    const reason = new Error('cancelled by test')

    expect(lookup).toHaveBeenCalledOnce()
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    releaseLookup?.([])
  })

  it('honors cancellation before resolution starts', async () => {
    const lookup = vi.fn<AddressLookup>()
    const controller = new AbortController()
    const reason = new Error('already cancelled')
    controller.abort(reason)

    await expect(createFakeIpResolver({ lookup })('example.test', controller.signal)).rejects.toBe(reason)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('rejects NAT64 addresses translating to private IPv4 destinations', async () => {
    const lookup: AddressLookup = vi.fn(async (hostname) => {
      if (hostname === 'ipv4only.arpa') {
        return [
          { address: '64:ff9b::c000:aa', family: 6 },
          { address: '64:ff9b::c000:ab', family: 6 },
        ]
      }
      return [{ address: '64:ff9b::a00:1', family: 6 }]
    })
    const resolver = createStrictPublicResolver({ lookup })

    await expectCode(resolver('example.test', new AbortController().signal), 'WEB_BLOCKED_URL')
  })

  it('fails closed when NAT64 discovery returns malformed answers', async () => {
    const lookup: AddressLookup = vi.fn(async (hostname) => {
      if (hostname === 'ipv4only.arpa')
        return [{ address: '64:ff9b::c000:aa', family: 4 }]
      return [{ address: '2001:4860:4860::8888', family: 6 }]
    })
    const resolver = createStrictPublicResolver({ lookup })

    await expectCode(resolver('example.test', new AbortController().signal), 'WEB_PROVIDER_ERROR')
  })
})

describe('fake-IP provider registration', () => {
  it('registers an unavailable provider when the runtime web module fails to load', async () => {
    const loader: HostPluginLoader = {
      import: vi.fn(async () => {
        throw new Error('runtime module unavailable')
      }),
      unwrapExports: vi.fn((value: unknown) => value),
    }
    const registered: { provider?: WebFetchProviderService } = {}
    const web: WebRuntimeService = {
      registerFetchProvider: vi.fn((provider: WebFetchProviderService) => {
        registered.provider = provider
        return vi.fn()
      }),
    }
    setCurrentHostInstance({ connection: {} as never, web, loader } as never)

    await webFetch.attach()

    expect(registered.provider?.id).toBe(FAKE_IP_FETCH_PROVIDER_ID)
    expect(registered.provider?.available()).toBe(false)
    await expect(registered.provider?.fetch({ url: 'https://example.test' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })

  it('registers an unavailable provider when the runtime HTTP module is invalid', async () => {
    const loader: HostPluginLoader = {
      import: vi.fn(async (name: string) => name === '@deepseek-ai/dsh-web'
        ? { WebError: TestWebError }
        : { HttpFetchProvider: class {} }),
      unwrapExports: vi.fn((value: unknown) => value),
    }
    const registered: { provider?: WebFetchProviderService } = {}
    const web: WebRuntimeService = {
      registerFetchProvider: vi.fn((provider: WebFetchProviderService) => {
        registered.provider = provider
        return vi.fn()
      }),
    }
    setCurrentHostInstance({ connection: {} as never, web, loader } as never)

    await webFetch.attach()

    expect(registered.provider?.id).toBe(FAKE_IP_FETCH_PROVIDER_ID)
    expect(registered.provider?.available()).toBe(false)
    await expect(registered.provider?.fetch({ url: 'https://example.test' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })

  it('loads the runtime modules, preserves the official provider behavior, and disposes registration', async () => {
    const registered: { provider?: WebFetchProviderService } = {}
    const dispose = vi.fn()
    let capturedResolver: HttpFetchResolver | undefined
    const providerResult: WebFetchResult = {
      url: 'https://example.test',
      statusCode: 200,
      body: { kind: 'text', content: 'ok' },
      truncated: false,
    }
    const providerFetch = vi.fn(async () => providerResult)
    class FakeHttpFetchProvider {
      readonly id = 'http'
      constructor(
        readonly limits: unknown,
        readonly resolveAddresses?: HttpFetchResolver,
      ) {
        capturedResolver = resolveAddresses
      }

      available(): boolean { return true }
      fetch = providerFetch
    }
    const httpModule = {
      Config: vi.fn(() => ({ maxResponseBytes: 12, maxBodyChars: 13, timeoutMs: 14, maxRedirects: 15, userAgent: 'test' })),
      HttpFetchProvider: FakeHttpFetchProvider,
    }
    const webModule = { WebError: class extends Error {} }
    const loader: HostPluginLoader = {
      import: vi.fn(async (name: string) => name === '@deepseek-ai/dsh-web' ? webModule : httpModule),
      unwrapExports: vi.fn((value: unknown) => value),
    }
    const web: WebRuntimeService = {
      registerFetchProvider: vi.fn((provider: WebFetchProviderService) => {
        registered.provider = provider
        return dispose
      }),
    }
    setCurrentHostInstance({ connection: {} as never, web, loader } as never)

    const unregister = await webFetch.attach(DEFAULT_FAKE_IP_CIDRS)

    expect(loader.import).toHaveBeenNthCalledWith(1, '@deepseek-ai/dsh-web')
    expect(loader.import).toHaveBeenNthCalledWith(2, '@deepseek-ai/dsh-web-fetch-http')
    expect(loader.unwrapExports).toHaveBeenCalledTimes(2)
    expect(httpModule.Config).toHaveBeenCalledWith({})
    expect(registered.provider?.id).toBe(FAKE_IP_FETCH_PROVIDER_ID)
    expect(capturedResolver).toEqual(expect.any(Function))
    expect(registered.provider?.available()).toBe(true)
    await expect(registered.provider?.fetch({ url: 'https://example.test' })).resolves.toEqual(providerResult)
    expect(providerFetch).toHaveBeenCalledWith({ url: 'https://example.test' }, undefined)
    expect(unregister).toBe(dispose)
    unregister()
    expect(dispose).toHaveBeenCalledOnce()
  })
})

describe('address classification', () => {
  it('keeps the accepted ranges narrow', () => {
    const ranges = parseFakeIpCidrs(DEFAULT_FAKE_IP_CIDRS)

    expect(isFakeIp('198.18.0.43', 4, ranges)).toBe(true)
    expect(isFakeIp('198.19.255.254', 4, ranges)).toBe(true)
    expect(isFakeIp('198.20.0.1', 4, ranges)).toBe(false)
    expect(isFakeIp('fdfe:dcba:9876::1', 6, ranges)).toBe(false)
    expect(isPublicAddress('28.0.0.1')).toBe(true)
    expect(isPublicAddress('10.0.0.5')).toBe(false)
    expect(() => parseFakeIpCidrs(['192.0.2.0/24'])).toThrow()
  })
})
