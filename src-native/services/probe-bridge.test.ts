import type { BridgeAddress } from '@/utils/bridge-protocol'
import { FetchError } from 'expo/src/winter/fetch/FetchErrors'
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
const manifest = { name: 'DeepSeek Harness', short_name: 'DSH' }

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
  it('recognizes the deployed DSH manifest without the nonexistent auth-status endpoint or pairing credentials', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (String(input) === 'https://bridge.local:8443/manifest.webmanifest')
        return jsonResponse({ name: 'DeepSeek Harness', short_name: 'DSH', start_url: './', scope: './', display: 'fullscreen' })
      return new Response(null, { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    expect(await probeBridge(address, new AbortController().signal)).toEqual(address)
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('https://bridge.local:8443/manifest.webmanifest', {
      signal: expect.any(AbortSignal),
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
    { name: 'DeepSeek Harness' },
    { short_name: 'DSH' },
    { name: 'Other app', short_name: 'DSH' },
    { name: 'DeepSeek Harness', short_name: 'OTHER' },
    { name: 'deepseek harness', short_name: 'DSH' },
    { enabled: false, allowLoopback: true },
  ])('does not identify a service with a foreign manifest %j', async (body) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body))
    vi.stubGlobal('fetch', fetchMock)
    expect(await probeBridge(address, new AbortController().signal)).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([401, 403, 404, 503])('rejects HTTP %s even with a matching manifest body', async (status) => {
    const response = jsonResponse(manifest, status)
    const json = vi.spyOn(response, 'json')
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response))
    expect(await probeBridge(address, new AbortController().signal)).toBeNull()
    expect(json).not.toHaveBeenCalled()
  })

  it.each(['not JSON', '<!doctype html><title>DeepSeek Harness</title><form>请输入配对码</form>'])('rejects HTTP 200 without a valid manifest: %s', async (body) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(body)))
    expect(await probeBridge(address, new AbortController().signal)).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('handles a rejected network request as an unavailable bridge', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Network unavailable')))
    expect(await probeBridge(address, new AbortController().signal)).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('handles the actual Expo57 FetchError without caller cancellation as an unavailable bridge', async () => {
    const caller = new AbortController()
    const error = FetchError.createFromError(new Error('Failed to connect to /10.0.0.1:3080'))
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(error))

    await expect(probeBridge(address, caller.signal)).resolves.toBeNull()
    expect(caller.signal.aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('propagates unexpected failures instead of hiding a programming error as an offline host', async () => {
    const error = new Error('Unexpected request implementation failure')
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(error))
    await expect(probeBridge(address, new AbortController().signal)).rejects.toBe(error)
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

  it('keeps the request timeout active while its manifest body is being parsed', async () => {
    const body = deferred<unknown>()
    const response = jsonResponse(manifest)
    vi.spyOn(response, 'json').mockReturnValue(body.promise)
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response)
    vi.stubGlobal('fetch', fetchMock)
    const pending = probeBridge(address, new AbortController().signal, 100)
    await vi.advanceTimersByTimeAsync(99)
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    body.resolve(manifest)
    expect(await pending).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('discards a manifest body that finishes parsing after the caller aborts', async () => {
    const body = deferred<unknown>()
    const response = jsonResponse(manifest)
    vi.spyOn(response, 'json').mockReturnValue(body.promise)
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response)
    vi.stubGlobal('fetch', fetchMock)
    const caller = new AbortController()
    const pending = probeBridge(address, caller.signal)
    await vi.advanceTimersByTimeAsync(0)
    caller.abort()
    body.resolve(manifest)
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
    response.resolve(jsonResponse(manifest))
    expect(await pending).toBeNull()
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })
})
