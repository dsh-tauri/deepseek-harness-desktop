import type { BridgeAddress } from '@/utils/bridge-protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deferred, deferredNetwork, jsonResponse } from './bridge.test-utils'
import { probeBridge } from './probe-bridge'

const address: BridgeAddress = {
  id: 'https://bridge.local:8443',
  url: 'https://bridge.local:8443/workspaces/one?theme=dark',
  host: 'bridge.local',
  port: 8443,
  token: 'not-for-discovery',
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('probeBridge identity', () => {
  it('accepts the strict bridge auth response and probes only the stable origin without credentials', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ enabled: true, mode: 'token_only', allowLoopback: false, token: 'response-secret' }))
    vi.stubGlobal('fetch', fetchMock)
    const signal = new AbortController().signal
    const removeListener = vi.spyOn(signal, 'removeEventListener')
    expect(await probeBridge(address, signal)).toEqual({ ...address, auth: { enabled: true, mode: 'token_only', allowLoopback: false } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('https://bridge.local:8443/__dsh_bridge__/auth-status', {
      signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      redirect: 'error',
    })
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('requires the literal DSH manifest for a legacy auth response without allowLoopback', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ enabled: false }))
      .mockResolvedValueOnce(jsonResponse({ name: 'DeepSeek Harness', short_name: 'DSH' }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await probeBridge(address, new AbortController().signal)).toEqual({ ...address, auth: { enabled: false } })
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      'https://bridge.local:8443/__dsh_bridge__/auth-status',
      'https://bridge.local:8443/manifest.webmanifest',
    ])
    expect(fetchMock.mock.calls[1]?.[1]).toEqual({
      signal: fetchMock.mock.calls[0]?.[1]?.signal,
      headers: { Accept: 'application/manifest+json' },
      cache: 'no-store',
      redirect: 'error',
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    null,
    [],
    {},
    { enabled: 'false', allowLoopback: true },
    { enabled: true, mode: 1, allowLoopback: false },
    { enabled: false, allowLoopback: 'true' },
  ])('rejects malformed auth identity %j before manifest fallback', async (body) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body))
    vi.stubGlobal('fetch', fetchMock)
    expect(await probeBridge(address, new AbortController().signal)).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    {},
    { name: 'DeepSeek Harness' },
    { short_name: 'DSH' },
    { name: 'Other app', short_name: 'DSH' },
    { name: 'DeepSeek Harness', short_name: 'OTHER' },
    { name: 'deepseek harness', short_name: 'DSH' },
  ])('does not identify a legacy service with a foreign manifest %j', async (body) => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ enabled: false }))
      .mockResolvedValueOnce(jsonResponse(body))
    vi.stubGlobal('fetch', fetchMock)
    expect(await probeBridge(address, new AbortController().signal)).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects an HTTP error rather than interpreting its auth body', async () => {
    const response = jsonResponse({ enabled: false, allowLoopback: true }, 401)
    const json = vi.spyOn(response, 'json')
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response)
    vi.stubGlobal('fetch', fetchMock)
    expect(await probeBridge(address, new AbortController().signal)).toBeNull()
    expect(json).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects a failing manifest HTTP status even with a matching identity body', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ enabled: false }))
      .mockResolvedValueOnce(jsonResponse({ name: 'DeepSeek Harness', short_name: 'DSH' }, 404)))
    expect(await probeBridge(address, new AbortController().signal)).toBeNull()
  })

  it('rejects invalid JSON from the auth endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('not JSON')))
    expect(await probeBridge(address, new AbortController().signal)).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects invalid JSON from the legacy manifest endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ enabled: false }))
      .mockResolvedValueOnce(new Response('not JSON')))
    expect(await probeBridge(address, new AbortController().signal)).toBeNull()
  })

  it('handles a rejected network request as an unavailable bridge', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Network unavailable')))
    expect(await probeBridge(address, new AbortController().signal)).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('probeBridge cancellation', () => {
  it('does not fetch or allocate a timer for an already aborted caller', async () => {
    const network = deferredNetwork()
    const caller = new AbortController()
    caller.abort()
    expect(await probeBridge(address, caller.signal)).toBeNull()
    expect(network.fetchMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('propagates caller cancellation to the real request signal', async () => {
    const network = deferredNetwork()
    const caller = new AbortController()
    const pending = probeBridge(address, caller.signal, 500)
    expect(network.requests[0]?.signal.aborted).toBe(false)
    caller.abort()
    expect(await pending).toBeNull()
    expect(network.requests[0]?.signal.aborted).toBe(true)
    expect(network.active()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts at the exact default 600ms timeout', async () => {
    const network = deferredNetwork()
    const pending = probeBridge(address, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(599)
    expect(network.requests[0]?.signal.aborted).toBe(false)
    expect(network.active()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toBeNull()
    expect(network.requests[0]?.signal.aborted).toBe(true)
    expect(network.active()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses one timeout budget across auth and manifest requests', async () => {
    const network = deferredNetwork()
    const pending = probeBridge(address, new AbortController().signal, 100)
    await vi.advanceTimersByTimeAsync(60)
    network.requests[0]!.resolve(jsonResponse({ enabled: false }))
    await vi.advanceTimersByTimeAsync(0)
    expect(network.requests.map(request => request.url)).toEqual([
      'https://bridge.local:8443/__dsh_bridge__/auth-status',
      'https://bridge.local:8443/manifest.webmanifest',
    ])
    await vi.advanceTimersByTimeAsync(39)
    expect(network.requests[1]?.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toBeNull()
    expect(network.requests[1]?.signal.aborted).toBe(true)
    expect(network.active()).toBe(0)
  })

  it('discards an auth body that finishes parsing after the caller aborts', async () => {
    const body = deferred<unknown>()
    const response = jsonResponse({})
    vi.spyOn(response, 'json').mockReturnValue(body.promise)
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response)
    vi.stubGlobal('fetch', fetchMock)
    const caller = new AbortController()
    const pending = probeBridge(address, caller.signal)
    await vi.advanceTimersByTimeAsync(0)
    caller.abort()
    body.resolve({ enabled: false })
    expect(await pending).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('discards a late successful response even when a network mock ignores abort', async () => {
    const response = deferred<Response>()
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(response.promise)
    vi.stubGlobal('fetch', fetchMock)
    const caller = new AbortController()
    const pending = probeBridge(address, caller.signal)
    caller.abort()
    response.resolve(jsonResponse({ enabled: false, allowLoopback: true }))
    expect(await pending).toBeNull()
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })
})
