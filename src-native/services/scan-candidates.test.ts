import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deferredNetwork, jsonResponse } from './bridge.test-utils'
import { scanCandidates } from './scan-candidates'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('scanCandidates scheduling', () => {
  it('limits in-flight workers to two and publishes each successful host in completion order', async () => {
    const network = deferredNetwork()
    const onFound = vi.fn()
    const pending = scanCandidates([
      { host: '10.0.0.1', port: 3080 },
      { host: '10.0.0.2', port: 3080 },
      { host: '10.0.0.3', port: 3080 },
      { host: '10.0.0.4', port: 3080 },
      { host: '10.0.0.5', port: 3080 },
    ], { signal: new AbortController().signal, concurrency: 2, timeoutMs: 1000, budgetMs: 5000, onFound })
    expect(network.requests.map(request => request.url)).toEqual([
      'http://10.0.0.1:3080/__dsh_bridge__/auth-status',
      'http://10.0.0.2:3080/__dsh_bridge__/auth-status',
    ])
    expect(network.active()).toBe(2)
    network.requests[1]!.resolve(jsonResponse({ enabled: false, allowLoopback: true }))
    await vi.advanceTimersByTimeAsync(0)
    expect(network.requests).toHaveLength(3)
    expect(onFound.mock.calls.map(call => call[0].id)).toEqual(['http://10.0.0.2:3080'])
    network.requests[0]!.resolve(jsonResponse({ enabled: false, allowLoopback: true }))
    await vi.advanceTimersByTimeAsync(0)
    expect(network.requests).toHaveLength(4)
    network.requests[2]!.resolve(jsonResponse({ enabled: false, allowLoopback: true }))
    await vi.advanceTimersByTimeAsync(0)
    expect(network.requests).toHaveLength(5)
    network.requests[3]!.resolve(jsonResponse({ enabled: false, allowLoopback: true }))
    network.requests[4]!.resolve(jsonResponse({ enabled: false, allowLoopback: true }))
    const found = await pending
    expect(found.map(host => host.id)).toEqual(['http://10.0.0.2:3080', 'http://10.0.0.1:3080', 'http://10.0.0.3:3080', 'http://10.0.0.4:3080', 'http://10.0.0.5:3080'])
    expect(found[0]).toEqual({ id: 'http://10.0.0.2:3080', url: 'http://10.0.0.2:3080/', host: '10.0.0.2', port: 3080, auth: { enabled: false, allowLoopback: true } })
    expect(onFound.mock.calls.map(call => call[0].id)).toEqual(['http://10.0.0.2:3080', 'http://10.0.0.1:3080', 'http://10.0.0.3:3080', 'http://10.0.0.4:3080', 'http://10.0.0.5:3080'])
    expect(network.maximum()).toBe(2)
    expect(network.active()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('enforces the literal default worker limit of forty', async () => {
    const network = deferredNetwork()
    const candidates = Array.from({ length: 41 }, (_, index) => ({ host: `10.0.0.${index + 1}`, port: 3082 }))
    const pending = scanCandidates(candidates, { signal: new AbortController().signal })
    expect(network.requests).toHaveLength(40)
    expect(network.active()).toBe(40)
    for (const request of network.requests.slice())
      request.resolve(jsonResponse({ enabled: false, allowLoopback: true }))
    await vi.advanceTimersByTimeAsync(0)
    expect(network.requests).toHaveLength(41)
    network.requests[40]!.resolve(jsonResponse({ enabled: false, allowLoopback: true }))
    expect(await pending).toHaveLength(41)
    expect(network.maximum()).toBe(40)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('allows a worker to continue after a timed-out candidate', async () => {
    const network = deferredNetwork()
    const pending = scanCandidates([
      { host: '10.0.0.1', port: 3080 },
      { host: '10.0.0.2', port: 3080 },
    ], { signal: new AbortController().signal, concurrency: 1, timeoutMs: 50, budgetMs: 500 })
    await vi.advanceTimersByTimeAsync(49)
    expect(network.requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(network.requests[0]?.signal.aborted).toBe(true)
    expect(network.requests[1]?.signal.aborted).toBe(false)
    network.requests[1]!.resolve(jsonResponse({ enabled: false, allowLoopback: true }))
    expect((await pending).map(host => host.id)).toEqual(['http://10.0.0.2:3080'])
    expect(network.maximum()).toBe(1)
  })

  it('aborts all active requests at the scan budget and returns only prior discoveries', async () => {
    const network = deferredNetwork()
    const onFound = vi.fn()
    const pending = scanCandidates([
      { host: '10.0.0.1', port: 3080 },
      { host: '10.0.0.2', port: 3080 },
      { host: '10.0.0.3', port: 3080 },
      { host: '10.0.0.4', port: 3080 },
    ], { signal: new AbortController().signal, concurrency: 2, timeoutMs: 1000, budgetMs: 50, onFound })
    network.requests[0]!.resolve(jsonResponse({ enabled: false, allowLoopback: true }))
    await vi.advanceTimersByTimeAsync(49)
    expect(network.requests).toHaveLength(3)
    expect(network.active()).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect((await pending).map(host => host.id)).toEqual(['http://10.0.0.1:3080'])
    expect(network.requests.slice(1).map(request => request.signal.aborted)).toEqual([true, true])
    expect(network.requests).toHaveLength(3)
    expect(onFound).toHaveBeenCalledTimes(1)
    expect(network.active()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('supports onFound cancelling the actual scan without scheduling further candidates', async () => {
    const network = deferredNetwork()
    const caller = new AbortController()
    const onFound = vi.fn(() => caller.abort())
    const pending = scanCandidates([
      { host: '10.0.0.1', port: 3080 },
      { host: '10.0.0.2', port: 3080 },
      { host: '10.0.0.3', port: 3080 },
    ], { signal: caller.signal, concurrency: 2, onFound })
    network.requests[0]!.resolve(jsonResponse({ enabled: false, allowLoopback: true }))
    expect((await pending).map(host => host.id)).toEqual(['http://10.0.0.1:3080'])
    expect(onFound).toHaveBeenCalledTimes(1)
    expect(network.requests).toHaveLength(2)
    expect(network.requests[1]?.signal.aborted).toBe(true)
    expect(network.active()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('propagates a callback failure while aborting the remaining real worker requests', async () => {
    const network = deferredNetwork()
    const error = new Error('Consumer failed')
    const pending = scanCandidates([
      { host: '10.0.0.1', port: 3080 },
      { host: '10.0.0.2', port: 3080 },
    ], {
      signal: new AbortController().signal,
      concurrency: 2,
      onFound() { throw error },
    })
    const rejection = expect(pending).rejects.toBe(error)
    network.requests[0]!.resolve(jsonResponse({ enabled: false, allowLoopback: true }))
    await rejection
    expect(network.requests[1]?.signal.aborted).toBe(true)
    expect(network.active()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not notify onFound for failed probes or malformed candidates', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ enabled: 'false' }))
    vi.stubGlobal('fetch', fetchMock)
    const onFound = vi.fn()
    expect(await scanCandidates([
      { host: 'bad host', port: 3080 },
      { host: '10.0.0.1', port: 0 },
      { host: '10.0.0.2', port: 65536 },
      { host: '10.0.0.3', port: 3080 },
    ], { signal: new AbortController().signal, concurrency: 256, onFound })).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://10.0.0.3:3080/__dsh_bridge__/auth-status')
    expect(onFound).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not launch work for an empty or already aborted scan', async () => {
    const network = deferredNetwork()
    const caller = new AbortController()
    caller.abort()
    expect(await scanCandidates([{ host: '10.0.0.1', port: 3080 }], { signal: caller.signal })).toEqual([])
    expect(await scanCandidates([], { signal: new AbortController().signal })).toEqual([])
    expect(network.fetchMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([0, -1, 1.5, 257, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid worker concurrency %s', async (concurrency) => {
    const network = deferredNetwork()
    await expect(scanCandidates([], { signal: new AbortController().signal, concurrency })).rejects.toThrow('Scan concurrency must be between 1 and 256')
    expect(network.fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    { timeoutMs: 0 },
    { timeoutMs: -1 },
    { timeoutMs: Number.NaN },
    { timeoutMs: Number.POSITIVE_INFINITY },
    { budgetMs: 0 },
    { budgetMs: -1 },
    { budgetMs: Number.NaN },
    { budgetMs: Number.POSITIVE_INFINITY },
  ])('rejects invalid scan timing options %j', async (options) => {
    const network = deferredNetwork()
    await expect(scanCandidates([], { signal: new AbortController().signal, ...options })).rejects.toThrow('Scan timeouts must be positive')
    expect(network.fetchMock).not.toHaveBeenCalled()
  })
})
