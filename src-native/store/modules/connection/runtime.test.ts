import type { HistoryEntry } from './index'
import type { BridgeHost } from '@/services/probe-bridge'
import type { ScanOptions } from '@/services/scan-candidates'
import type { BridgeAddress } from '@/utils/bridge-protocol'
import type { ScanCandidate } from '@/utils/discovery'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n'

const boundary = vi.hoisted(createBoundaryMocks)

function createBoundaryMocks() {
  return {
    ip: vi.fn<() => Promise<string>>(),
    probe: vi.fn<typeof import('@/services/probe-bridge').probeBridge>(),
    scan: vi.fn<typeof import('@/services/scan-candidates').scanCandidates>(),
    notify: vi.fn<typeof import('@/hooks/use-notifications').sendNativeNotification>(),
  }
}

vi.mock('expo-network', mockExpoNetwork)

function mockExpoNetwork() {
  return { getIpAddressAsync: boundary.ip }
}
vi.mock('@/services/probe-bridge', mockProbeBridge)

function mockProbeBridge() {
  return { probeBridge: boundary.probe }
}
vi.mock('@/services/scan-candidates', mockScanCandidates)

function mockScanCandidates() {
  return { scanCandidates: boundary.scan }
}
vi.mock('@/hooks/use-notifications', mockNativeNotification)

function mockNativeNotification() {
  return { sendNativeNotification: boundary.notify }
}

vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'zh-CN' }] }))
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(), setItem: vi.fn() } }))

const alpha: BridgeAddress = { id: 'http://10.0.0.20:4444', url: 'http://10.0.0.20:4444/tasks?theme=dark', host: '10.0.0.20', port: 4444 }
const beta: BridgeAddress = { id: 'http://10.0.0.2:3082', url: 'http://10.0.0.2:3082/workspaces', host: '10.0.0.2', port: 3082 }
const gamma: BridgeAddress = { id: 'http://10.0.0.3:3080', url: 'http://10.0.0.3:3080/', host: '10.0.0.3', port: 3080 }
const recentAlpha: HistoryEntry = { ...alpha, lastConnectedAt: 20 }
const recentBeta: HistoryEntry = { ...beta, lastConnectedAt: 10 }
const noHosts = i18n.t('connection.noHosts')
const noNetwork = i18n.t('connection.noNetwork')
const tokenRequired = i18n.t('connection.tokenRequired')
const hostOffline = i18n.t('connection.hostOffline')
const releases: (() => void)[] = []
let runtime: typeof import('./runtime')
let connection: typeof import('./index')['connection']

function hydrate(history: HistoryEntry[] = [], tokens: Record<string, string> = {}): void {
  connection.$patch({ version: 1, history, guidedHosts: [] })
  connection.markHydrated(tokens)
}

function openHost(address: BridgeAddress): BridgeHost {
  return { ...address, auth: { enabled: false, allowLoopback: false } }
}

function lockedHost(address: BridgeAddress): BridgeHost {
  return { ...address, auth: { enabled: true, mode: 'token_only', allowLoopback: false } }
}

function deferred<T>(fallback: T) {
  const pending = Promise.withResolvers<T>()
  releases.push(releasePendingFixture)

  function releasePendingFixture() {
    pending.resolve(fallback)
  }
  return pending
}

function recordedProbe(index = 0): Parameters<typeof import('@/services/probe-bridge').probeBridge> {
  const call = boundary.probe.mock.calls[index]
  if (!call)
    throw new Error(`Expected recorded bridge probe ${index}`)
  return call
}

function recordedScan(index = 0): Parameters<typeof import('@/services/scan-candidates').scanCandidates> {
  const call = boundary.scan.mock.calls[index]
  if (!call)
    throw new Error(`Expected recorded LAN scan ${index}`)
  return call
}

function publish(host: BridgeHost, index = 0): void {
  const options: ScanOptions = recordedScan(index)[1]
  if (!options.onFound)
    throw new Error('Expected a discovery callback at the bridge-client boundary')
  options.onFound(host)
}

beforeEach(initializeRuntime)

async function initializeRuntime() {
  vi.resetModules()
  vi.resetAllMocks()
  vi.clearAllMocks()
  vi.useFakeTimers()
  boundary.ip.mockResolvedValue('10.0.0.9')
  boundary.probe.mockResolvedValue(null)
  boundary.scan.mockResolvedValue([])
  boundary.notify.mockResolvedValue(undefined)
  const store = await import('./index')
  connection = store.connection
  connection.$persist.meta.hydrated = false
  connection.$persist.meta.mounted = false
  connection.$patch(store.createConnectionState())
  store.resetConnectionStorageCache()
  runtime = await import('./runtime')
}

afterEach(disposeRuntime)

async function disposeRuntime() {
  runtime.stopConnectionRuntime()
  for (const release of releases.splice(0))
    release()
  await vi.advanceTimersByTimeAsync(0)
  vi.restoreAllMocks()
  vi.resetAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.resetModules()
}

describe('connectAddress', describeDirectConnections)

function describeDirectConnections() {
  it('opens the requested route with its saved origin token without probing or recording successful history', connectDirectly)

  function connectDirectly() {
    hydrate([], { 'http://10.0.0.20:4444': 'fixture-saved-token' })

    runtime.connectAddress(alpha)

    expect(connection.current).toEqual({ ...alpha, token: 'fixture-saved-token' })
    expect(connection.stage).toBe('connected')
    expect(connection.loading).toBe(true)
    expect(connection.notice).toBeNull()
    expect(connection.history).toEqual([])
    expect(connection.health).toEqual({ 'http://10.0.0.20:4444': 'available' })
    expect(boundary.probe).not.toHaveBeenCalled()
    expect(boundary.ip).not.toHaveBeenCalled()
    expect(boundary.scan).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  }

  it('prefers an explicit new token over the saved token for the same origin', preferExplicitToken)

  function preferExplicitToken() {
    hydrate([], { 'http://10.0.0.20:4444': 'fixture-old-token' })

    runtime.connectAddress({ ...alpha, token: 'fixture-new-token' })

    expect(connection.current).toEqual({ ...alpha, token: 'fixture-new-token' })
    expect(connection.tokens).toEqual({ 'http://10.0.0.20:4444': 'fixture-new-token' })
    expect(connection.serialize()).toEqual({ version: 1, history: [], guidedHosts: [] })
  }

  it('preserves a new URL token instead of replacing it with an older saved token', preferUrlToken)

  function preferUrlToken() {
    hydrate([], { 'http://10.0.0.20:4444': 'fixture-old-token' })

    runtime.connectAddress({ ...alpha, url: 'http://10.0.0.20:4444/tasks?auth=fixture-new-token&theme=dark' })

    expect(connection.current).toEqual({ ...alpha, token: 'fixture-new-token' })
    expect(connection.tokens).toEqual({ 'http://10.0.0.20:4444': 'fixture-new-token' })
  }

  it('aborts an in-flight history probe before a direct connection and ignores its late success', supersedeHistoryWithDirectConnection)

  async function supersedeHistoryWithDirectConnection() {
    hydrate([recentAlpha])
    const probe = deferred<BridgeHost | null>(null)
    boundary.probe.mockReturnValue(probe.promise)
    const scanning = runtime.startAutoScan()
    const signal = recordedProbe()[1]
    expect(signal.aborted).toBe(false)

    runtime.connectAddress(beta)
    expect(signal.aborted).toBe(true)
    const generation = connection.scanGeneration
    probe.resolve(openHost(alpha))
    await scanning

    expect(connection.current).toEqual(beta)
    expect(connection.stage).toBe('connected')
    expect(connection.scanGeneration).toBe(generation)
    expect(connection.health[alpha.id]).toBe('checking')
    expect(connection.notice).toBeNull()
    expect(boundary.ip).not.toHaveBeenCalled()
    expect(boundary.scan).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  }

  it('keeps a direct connection when an aborted LAN scan publishes a late discovery', supersedeLanWithDirectConnection)

  async function supersedeLanWithDirectConnection() {
    hydrate()
    const scan = deferred<BridgeHost[]>([])
    boundary.scan.mockReturnValue(scan.promise)
    const scanning = runtime.startAutoScan()
    await vi.advanceTimersByTimeAsync(0)
    const signal = recordedScan()[1].signal

    runtime.connectAddress(beta)
    expect(signal.aborted).toBe(true)
    publish(openHost(gamma))
    scan.resolve([openHost(gamma)])
    await scanning

    expect(connection.current).toEqual(beta)
    expect(connection.stage).toBe('connected')
    expect(connection.notice).toBeNull()
    expect(connection.health[gamma.id]).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  }
}

describe('startAutoScan history and host eligibility', describeDiscovery)

function describeDiscovery() {
  it('chooses the newest reachable history entry rather than the first probe to finish', prioritizeHistoryOrder)

  async function prioritizeHistoryOrder() {
    hydrate([recentAlpha, recentBeta])
    const newest = deferred<BridgeHost | null>(null)
    const older = deferred<BridgeHost | null>(null)
    boundary.probe.mockReturnValueOnce(newest.promise).mockReturnValueOnce(older.promise)
    const scanning = runtime.startAutoScan()
    const signal = recordedProbe()[1]

    expect(boundary.probe.mock.calls).toEqual([[recentAlpha, signal, 3000], [recentBeta, signal, 3000]])
    expect(connection.health).toEqual({ 'http://10.0.0.20:4444': 'checking', 'http://10.0.0.2:3082': 'checking' })
    older.resolve(openHost(beta))
    await vi.advanceTimersByTimeAsync(0)
    expect(connection.current).toBeNull()
    expect(boundary.ip).not.toHaveBeenCalled()
    newest.resolve(openHost(alpha))
    await scanning

    expect(connection.current).toEqual(alpha)
    expect(connection.stage).toBe('connected')
    expect(connection.loading).toBe(true)
    expect(connection.history).toEqual([recentAlpha, recentBeta])
    expect(connection.health).toEqual({ 'http://10.0.0.20:4444': 'available', 'http://10.0.0.2:3082': 'available' })
    expect(boundary.ip).not.toHaveBeenCalled()
    expect(boundary.scan).not.toHaveBeenCalled()
    expect(signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  }

  it('connects an older reachable history entry when the newest entry is unavailable', fallBackWithinHistory)

  async function fallBackWithinHistory() {
    hydrate([recentAlpha, recentBeta])
    boundary.probe.mockResolvedValueOnce(null).mockResolvedValueOnce(openHost(beta))

    await runtime.startAutoScan()

    expect(connection.current).toEqual(beta)
    expect(connection.health).toEqual({ 'http://10.0.0.20:4444': 'unavailable', 'http://10.0.0.2:3082': 'available' })
    expect(boundary.ip).not.toHaveBeenCalled()
    expect(boundary.scan).not.toHaveBeenCalled()
  }

  it('skips reachable token-only history without credentials in favor of a usable history entry', filterLockedHistory)

  async function filterLockedHistory() {
    hydrate([recentAlpha, recentBeta])
    boundary.probe.mockResolvedValueOnce(lockedHost(alpha)).mockResolvedValueOnce(openHost(beta))

    await runtime.startAutoScan()

    expect(connection.current).toEqual(beta)
    expect(connection.tokens).toEqual({})
    expect(connection.health[alpha.id]).toBe('available')
    expect(boundary.scan).not.toHaveBeenCalled()
    expect(connection.notice).toBeNull()
  }

  it('reuses the exact saved origin token when probing token-only history', acceptAuthenticatedHistory)

  async function acceptAuthenticatedHistory() {
    hydrate([recentAlpha], { 'http://10.0.0.20:4444': 'fixture-saved-token' })
    boundary.probe.mockResolvedValue(lockedHost({ ...alpha, token: 'fixture-saved-token' }))

    await runtime.startAutoScan()

    expect(recordedProbe()[0]).toEqual({ ...recentAlpha, token: 'fixture-saved-token' })
    expect(recordedProbe()[2]).toBe(3000)
    expect(connection.current).toEqual({ ...alpha, token: 'fixture-saved-token' })
    expect(connection.history).toEqual([recentAlpha])
    expect(boundary.ip).not.toHaveBeenCalled()
    expect(boundary.scan).not.toHaveBeenCalled()
  }

  it('retains the token-required notice from unusable history when the LAN has no usable host', retainHistoryTokenRequirement)

  async function retainHistoryTokenRequirement() {
    hydrate([recentAlpha])
    boundary.probe.mockResolvedValue(lockedHost(alpha))

    await runtime.startAutoScan()

    expect(boundary.scan).toHaveBeenCalledTimes(1)
    expect(connection.current).toBeNull()
    expect(connection.stage).toBe('idle')
    expect(connection.notice).toBe(tokenRequired)
    expect(connection.tokens).toEqual({})
  }

  it('passes history custom ports into the real subnet candidate builder while excluding self and subnet boundaries', includeHistoryPorts)

  async function includeHistoryPorts() {
    hydrate([recentAlpha, recentBeta])

    await runtime.startAutoScan()

    const [candidates, options] = recordedScan()
    expect(boundary.ip).toHaveBeenCalledExactlyOnceWith()
    expect([...new Set(candidates.map(candidatePort))]).toEqual([4444, 3082, 3080])

    function candidatePort(candidate: ScanCandidate): number {
      return candidate.port
    }
    expect(candidates).toHaveLength(759)
    expect(candidates.slice(0, 2)).toEqual([{ host: '10.0.0.1', port: 4444 }, { host: '10.0.0.2', port: 4444 }])
    expect(candidates).toContainEqual({ host: '10.0.0.20', port: 4444 })
    expect(candidates.filter(excludedCandidate)).toEqual([])

    function excludedCandidate(candidate: ScanCandidate): boolean {
      return ['10.0.0.0', '10.0.0.9', '10.0.0.255'].includes(candidate.host)
    }
    expect(options.signal.aborted).toBe(true)
    expect(connection.notice).toBe(noHosts)
    expect(connection.current).toBeNull()
  }

  it.each(['', '::1', '127.0.0.1'])('finishes without a LAN scan when expo-network returns an ineligible IPv4 address %j', rejectUnavailableSubnet)

  async function rejectUnavailableSubnet(selfIp: string) {
    hydrate()
    boundary.ip.mockResolvedValue(selfIp)

    await runtime.startAutoScan()

    expect(boundary.scan).not.toHaveBeenCalled()
    expect(connection.current).toBeNull()
    expect(connection.stage).toBe('idle')
    expect(connection.notice).toBe(noNetwork)
    expect(vi.getTimerCount()).toBe(0)
  }

  it('finishes with a no-hosts notice after an empty eligible LAN scan', finishEmptyDiscovery)

  async function finishEmptyDiscovery() {
    hydrate()

    await runtime.startAutoScan()

    expect(recordedScan()[0]).toHaveLength(506)
    expect(connection.stage).toBe('idle')
    expect(connection.current).toBeNull()
    expect(connection.notice).toBe(noHosts)
    expect(vi.getTimerCount()).toBe(0)
  }

  it('keeps scanning after a token-only LAN host without a token and accepts the next usable discovery', filterLockedLanHost)

  async function filterLockedLanHost() {
    hydrate()
    const scan = deferred<BridgeHost[]>([])
    boundary.scan.mockReturnValue(scan.promise)
    const scanning = runtime.startAutoScan()
    await vi.advanceTimersByTimeAsync(0)
    const signal = recordedScan()[1].signal

    publish(lockedHost(beta))
    expect(signal.aborted).toBe(false)
    expect(connection.current).toBeNull()
    publish(openHost(gamma))
    expect(signal.aborted).toBe(true)
    scan.resolve([lockedHost(beta), openHost(gamma)])
    await scanning

    expect(connection.current).toEqual(gamma)
    expect(connection.stage).toBe('connected')
    expect(connection.notice).toBeNull()
    expect(connection.history).toEqual([])
    expect(connection.tokens).toEqual({})
    expect(vi.getTimerCount()).toBe(0)
  }

  it('reports token-required when every LAN discovery needs an unavailable token', reportLockedLanHosts)

  async function reportLockedLanHosts() {
    hydrate()
    const scan = deferred<BridgeHost[]>([])
    boundary.scan.mockReturnValue(scan.promise)
    const scanning = runtime.startAutoScan()
    await vi.advanceTimersByTimeAsync(0)

    publish(lockedHost(beta))
    publish(lockedHost(gamma))
    expect(recordedScan()[1].signal.aborted).toBe(false)
    scan.resolve([lockedHost(beta), lockedHost(gamma)])
    await scanning

    expect(connection.current).toBeNull()
    expect(connection.stage).toBe('idle')
    expect(connection.notice).toBe(tokenRequired)
    expect(connection.tokens).toEqual({})
  }

  it('accepts a token-only LAN discovery using a saved token for the exact origin', acceptAuthenticatedLanHost)

  async function acceptAuthenticatedLanHost() {
    hydrate([], { 'http://10.0.0.2:3082': 'fixture-saved-token' })
    const scan = deferred<BridgeHost[]>([])
    boundary.scan.mockReturnValue(scan.promise)
    const scanning = runtime.startAutoScan()
    await vi.advanceTimersByTimeAsync(0)

    publish(lockedHost(beta))
    expect(recordedScan()[1].signal.aborted).toBe(true)
    scan.resolve([lockedHost(beta)])
    await scanning

    expect(connection.current).toEqual({ ...beta, token: 'fixture-saved-token' })
    expect(connection.notice).toBeNull()
    expect(connection.history).toEqual([])
  }

  it('does not reuse a saved token for another port on the same LAN host', isolateLanTokensByOrigin)

  async function isolateLanTokensByOrigin() {
    hydrate([], { 'http://10.0.0.2:3080': 'fixture-sibling-token' })
    const scan = deferred<BridgeHost[]>([])
    boundary.scan.mockReturnValue(scan.promise)
    const scanning = runtime.startAutoScan()
    await vi.advanceTimersByTimeAsync(0)

    publish(lockedHost(beta))
    expect(recordedScan()[1].signal.aborted).toBe(false)
    scan.resolve([lockedHost(beta)])
    await scanning

    expect(connection.current).toBeNull()
    expect(connection.notice).toBe(tokenRequired)
    expect(connection.tokens).toEqual({ 'http://10.0.0.2:3080': 'fixture-sibling-token' })
  }

  it('reports a network-boundary rejection and releases the scan deadline', reportDiscoveryFailure)

  async function reportDiscoveryFailure() {
    hydrate()
    const error = new Error('Fixture network unavailable')
    const log = vi.spyOn(console, 'error').mockImplementation(suppressExpectedError)

    function suppressExpectedError() {}
    boundary.ip.mockRejectedValue(error)

    await runtime.startAutoScan()

    expect(connection.current).toBeNull()
    expect(connection.stage).toBe('idle')
    expect(connection.notice).toBe(i18n.t('connection.scanFailed'))
    expect(log).toHaveBeenCalledExactlyOnceWith('[connection] scan failed:', error)
    expect(boundary.scan).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  }
}

describe('history-only re-entry', () => {
  it('preserves history ordering and saved tokens without reading the LAN address', async () => {
    hydrate([recentAlpha, recentBeta], { 'http://10.0.0.20:4444': 'fixture-saved-token' })
    boundary.probe.mockResolvedValueOnce(lockedHost({ ...alpha, token: 'fixture-saved-token' })).mockResolvedValueOnce(openHost(beta))

    await runtime.startAutoScan({ historyOnly: true })

    expect(recordedProbe()[0]).toEqual({ ...recentAlpha, token: 'fixture-saved-token' })
    expect(recordedProbe(1)[0]).toEqual(recentBeta)
    expect(connection.current).toEqual({ ...alpha, token: 'fixture-saved-token' })
    expect(connection.history).toEqual([recentAlpha, recentBeta])
    expect(boundary.ip).not.toHaveBeenCalled()
    expect(boundary.scan).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('falls back within saved history rather than scanning new LAN hosts', async () => {
    hydrate([recentAlpha, recentBeta])
    boundary.probe.mockResolvedValueOnce(null).mockResolvedValueOnce(openHost(beta))

    await runtime.startAutoScan({ historyOnly: true })

    expect(connection.current).toEqual(beta)
    expect(connection.health).toEqual({ 'http://10.0.0.20:4444': 'unavailable', 'http://10.0.0.2:3082': 'available' })
    expect(connection.notice).toBeNull()
    expect(boundary.ip).not.toHaveBeenCalled()
    expect(boundary.scan).not.toHaveBeenCalled()
  })

  it('returns to method selection when there is no available history without starting a LAN scan', async () => {
    hydrate([recentAlpha, recentBeta])

    await runtime.startAutoScan({ historyOnly: true })

    expect(connection.current).toBeNull()
    expect(connection.stage).toBe('idle')
    expect(connection.notice).toBe(i18n.t('connection.noHistoryAvailable'))
    expect(connection.history).toEqual([recentAlpha, recentBeta])
    expect(boundary.probe).toHaveBeenCalledTimes(2)
    expect(boundary.ip).not.toHaveBeenCalled()
    expect(boundary.scan).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps unusable token-only history for QR login without silently searching the LAN', async () => {
    hydrate([recentAlpha])
    boundary.probe.mockResolvedValue(lockedHost(alpha))

    await runtime.startAutoScan({ historyOnly: true })

    expect(connection.current).toBeNull()
    expect(connection.stage).toBe('idle')
    expect(connection.notice).toBe(tokenRequired)
    expect(connection.health[alpha.id]).toBe('available')
    expect(connection.history).toEqual([recentAlpha])
    expect(connection.tokens).toEqual({})
    expect(boundary.ip).not.toHaveBeenCalled()
    expect(boundary.scan).not.toHaveBeenCalled()
  })

  it('lets an explicit QR address cancel history reconnection and discard its late result', async () => {
    hydrate([recentAlpha])
    const probe = deferred<BridgeHost | null>(null)
    boundary.probe.mockReturnValue(probe.promise)
    const reconnecting = runtime.startAutoScan({ historyOnly: true })
    const signal = recordedProbe()[1]

    runtime.connectAddress(beta)
    probe.resolve(openHost(alpha))
    await reconnecting

    expect(signal.aborted).toBe(true)
    expect(connection.current).toEqual(beta)
    expect(connection.notice).toBeNull()
    expect(boundary.ip).not.toHaveBeenCalled()
    expect(boundary.scan).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('runtime cancellation and scan generations', describeCancellation)

function describeCancellation() {
  it('aborts history probes on cancellation and discards late availability and connection results', cancelHistoryProbe)

  async function cancelHistoryProbe() {
    hydrate([recentAlpha])
    const probe = deferred<BridgeHost | null>(null)
    boundary.probe.mockReturnValue(probe.promise)
    const scanning = runtime.startAutoScan()
    const signal = recordedProbe()[1]
    const generation = connection.scanGeneration

    runtime.cancelAutoScan()
    expect(signal.aborted).toBe(true)
    expect(connection.scanGeneration).toBeGreaterThan(generation)
    probe.resolve(openHost(alpha))
    await scanning

    expect(connection.current).toBeNull()
    expect(connection.stage).toBe('idle')
    expect(connection.notice).toBeNull()
    expect(connection.health[alpha.id]).toBe('checking')
    expect(boundary.ip).not.toHaveBeenCalled()
    expect(boundary.scan).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  }

  it('does not launch a LAN scan when the IP lookup resolves after cancellation', cancelIpLookup)

  async function cancelIpLookup() {
    hydrate()
    const ip = deferred('')
    boundary.ip.mockReturnValue(ip.promise)
    const scanning = runtime.startAutoScan()
    await vi.advanceTimersByTimeAsync(0)
    expect(boundary.ip).toHaveBeenCalledTimes(1)

    runtime.cancelAutoScan()
    ip.resolve('10.0.0.9')
    await scanning

    expect(boundary.scan).not.toHaveBeenCalled()
    expect(connection.current).toBeNull()
    expect(connection.stage).toBe('idle')
    expect(connection.notice).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  }

  it('does not reconnect when a cancelled LAN scan publishes and returns a late host', cancelLanDiscovery)

  async function cancelLanDiscovery() {
    hydrate()
    const scan = deferred<BridgeHost[]>([])
    boundary.scan.mockReturnValue(scan.promise)
    const scanning = runtime.startAutoScan()
    await vi.advanceTimersByTimeAsync(0)
    const signal = recordedScan()[1].signal

    runtime.cancelAutoScan()
    expect(signal.aborted).toBe(true)
    publish(openHost(gamma))
    scan.resolve([openHost(gamma)])
    await scanning

    expect(connection.current).toBeNull()
    expect(connection.stage).toBe('idle')
    expect(connection.notice).toBeNull()
    expect(connection.health).toEqual({})
    expect(vi.getTimerCount()).toBe(0)
  }

  it('keeps the newer scan connection when the superseded scan returns later', invalidateSupersededScan)

  async function invalidateSupersededScan() {
    hydrate()
    const older = deferred<BridgeHost[]>([])
    const newer = deferred<BridgeHost[]>([])
    boundary.scan.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const first = runtime.startAutoScan()
    await vi.advanceTimersByTimeAsync(0)
    const oldSignal = recordedScan()[1].signal
    const second = runtime.startAutoScan()
    await vi.advanceTimersByTimeAsync(0)
    expect(oldSignal.aborted).toBe(true)

    publish(openHost(gamma), 1)
    newer.resolve([openHost(gamma)])
    await second
    const generation = connection.scanGeneration
    publish(openHost(beta), 0)
    older.resolve([openHost(beta)])
    await first

    expect(connection.current).toEqual(gamma)
    expect(connection.stage).toBe('connected')
    expect(connection.scanGeneration).toBe(generation)
    expect(connection.notice).toBeNull()
    expect(connection.health[beta.id]).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  }

  it('stops both active scan and health probes without accepting their late results', stopAllRuntimeWork)

  async function stopAllRuntimeWork() {
    hydrate([recentAlpha])
    runtime.connectAddress(alpha)
    const scanProbe = deferred<BridgeHost | null>(null)
    const healthProbe = deferred<BridgeHost | null>(null)
    boundary.probe.mockReturnValueOnce(scanProbe.promise).mockReturnValueOnce(healthProbe.promise)
    const scanning = runtime.startAutoScan()
    const refreshing = runtime.refreshHealth()
    const scanSignal = recordedProbe(0)[1]
    const healthSignal = recordedProbe(1)[1]
    expect(scanSignal).not.toBe(healthSignal)

    runtime.stopConnectionRuntime()
    expect(scanSignal.aborted).toBe(true)
    expect(healthSignal.aborted).toBe(true)
    scanProbe.resolve(openHost(alpha))
    healthProbe.resolve(openHost(alpha))
    await Promise.all([scanning, refreshing])

    expect(connection.stage).toBe('idle')
    expect(connection.current).toBeNull()
    expect(connection.health[alpha.id]).toBe('checking')
    expect(connection.notice).toBeNull()
    expect(boundary.notify).not.toHaveBeenCalled()
    expect(boundary.scan).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  }
}

describe('startAutoScan total deadline', describeScanDeadlines)

function describeScanDeadlines() {
  it('aborts stalled history at exactly 20000ms without accepting its later successful result', enforceHistoryDeadline)

  async function enforceHistoryDeadline() {
    hydrate([recentAlpha])
    const probe = deferred<BridgeHost | null>(null)
    boundary.probe.mockReturnValue(probe.promise)
    const scanning = runtime.startAutoScan()
    const signal = recordedProbe()[1]

    await vi.advanceTimersByTimeAsync(19999)
    expect(signal.aborted).toBe(false)
    expect(connection.stage).toBe('scanning')
    await vi.advanceTimersByTimeAsync(1)
    expect(signal.aborted).toBe(true)
    expect(connection.stage).toBe('idle')
    expect(connection.notice).toBe(noHosts)
    probe.resolve(openHost(alpha))
    await scanning

    expect(connection.current).toBeNull()
    expect(connection.health[alpha.id]).toBe('checking')
    expect(boundary.ip).not.toHaveBeenCalled()
    expect(boundary.scan).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  }

  it('uses one 20000ms budget across history, IP lookup and LAN discovery rather than restarting it per phase', shareTotalDeadline)

  async function shareTotalDeadline() {
    hydrate([recentAlpha])
    const probe = deferred<BridgeHost | null>(null)
    const ip = deferred('')
    const scan = deferred<BridgeHost[]>([])
    boundary.probe.mockReturnValue(probe.promise)
    boundary.ip.mockReturnValue(ip.promise)
    boundary.scan.mockReturnValue(scan.promise)
    const scanning = runtime.startAutoScan()

    await vi.advanceTimersByTimeAsync(2500)
    probe.resolve(null)
    await vi.advanceTimersByTimeAsync(0)
    expect(boundary.ip).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1500)
    ip.resolve('10.0.0.9')
    await vi.advanceTimersByTimeAsync(0)
    const signal = recordedScan()[1].signal
    expect(signal).toBe(recordedProbe()[1])
    await vi.advanceTimersByTimeAsync(15999)
    expect(signal.aborted).toBe(false)
    expect(connection.stage).toBe('scanning')
    await vi.advanceTimersByTimeAsync(1)
    expect(signal.aborted).toBe(true)
    expect(connection.stage).toBe('idle')
    expect(connection.notice).toBe(noHosts)
    scan.resolve([])
    await scanning

    expect(connection.current).toBeNull()
    expect(connection.notice).toBe(noHosts)
    expect(vi.getTimerCount()).toBe(0)
  }

  it('does not begin LAN discovery after an IP lookup outlives the total deadline', enforceIpLookupDeadline)

  async function enforceIpLookupDeadline() {
    hydrate()
    const ip = deferred('')
    boundary.ip.mockReturnValue(ip.promise)
    const scanning = runtime.startAutoScan()
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(20000)
    expect(connection.stage).toBe('idle')
    expect(connection.notice).toBe(noHosts)
    ip.resolve('10.0.0.9')
    await scanning

    expect(boundary.scan).not.toHaveBeenCalled()
    expect(connection.current).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  }

  it('does not accept a predeadline discovery when aborted scan workers only settle after the total deadline', rejectExpiredChosenHost)

  async function rejectExpiredChosenHost() {
    hydrate()
    const scan = deferred<BridgeHost[]>([])
    boundary.scan.mockReturnValue(scan.promise)
    const scanning = runtime.startAutoScan()
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(19999)
    publish(openHost(gamma))
    expect(recordedScan()[1].signal.aborted).toBe(true)
    expect(connection.stage).toBe('scanning')
    await vi.advanceTimersByTimeAsync(1)
    expect(connection.stage).toBe('idle')
    expect(connection.notice).toBe(noHosts)
    scan.resolve([openHost(gamma)])
    await scanning

    expect(connection.current).toBeNull()
    expect(connection.stage).toBe('idle')
    expect(connection.notice).toBe(noHosts)
    expect(vi.getTimerCount()).toBe(0)
  }

  it('does not reconnect when LAN discovery publishes a host after the total deadline has expired', discardDiscoveryAfterDeadline)

  async function discardDiscoveryAfterDeadline() {
    hydrate()
    const scan = deferred<BridgeHost[]>([])
    boundary.scan.mockReturnValue(scan.promise)
    const scanning = runtime.startAutoScan()
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(20000)
    expect(recordedScan()[1].signal.aborted).toBe(true)
    expect(connection.stage).toBe('idle')
    publish(openHost(gamma))
    scan.resolve([openHost(gamma)])
    await scanning

    expect(connection.current).toBeNull()
    expect(connection.stage).toBe('idle')
    expect(connection.notice).toBe(noHosts)
    expect(connection.health).toEqual({})
    expect(vi.getTimerCount()).toBe(0)
  }
}

describe('disconnectAndScan', describeDisconnectDiscovery)

function describeDisconnectDiscovery() {
  it('skips the disconnected history origin and reconnects another reachable history entry', skipDisconnectedHistory)

  async function skipDisconnectedHistory() {
    hydrate([recentAlpha, recentBeta])
    runtime.connectAddress(alpha)
    boundary.probe.mockResolvedValue(openHost(beta))

    runtime.disconnectAndScan()
    expect(connection.current).toBeNull()
    await vi.advanceTimersByTimeAsync(0)

    expect(boundary.probe).toHaveBeenCalledTimes(1)
    expect(recordedProbe()[0]).toEqual(recentBeta)
    expect(connection.current).toEqual(beta)
    expect(connection.history).toEqual([recentAlpha, recentBeta])
    expect(connection.stage).toBe('connected')
    expect(boundary.ip).not.toHaveBeenCalled()
    expect(boundary.scan).not.toHaveBeenCalled()
  }

  it('excludes only the disconnected host and port from LAN discovery while preserving sibling ports and history custom ports', excludeDisconnectedAddress)

  async function excludeDisconnectedAddress() {
    const recentGamma: HistoryEntry = { ...gamma, lastConnectedAt: 30 }
    hydrate([recentGamma, recentAlpha])
    runtime.connectAddress(gamma)

    runtime.disconnectAndScan()
    await vi.advanceTimersByTimeAsync(0)

    expect(boundary.probe).toHaveBeenCalledTimes(1)
    expect(recordedProbe()[0]).toEqual(recentAlpha)
    const candidates = recordedScan()[0]
    expect(candidates).toHaveLength(758)
    expect(candidates).not.toContainEqual({ host: '10.0.0.3', port: 3080 })
    expect(candidates.filter(disconnectedHostCandidate)).toEqual([
      { host: '10.0.0.3', port: 4444 },
      { host: '10.0.0.3', port: 3082 },
    ])

    function disconnectedHostCandidate(candidate: ScanCandidate): boolean {
      return candidate.host === '10.0.0.3'
    }
    expect(candidates).toContainEqual({ host: '10.0.0.20', port: 4444 })
    expect(candidates.filter(selfCandidate)).toEqual([])

    function selfCandidate(candidate: ScanCandidate): boolean {
      return candidate.host === '10.0.0.9'
    }
    expect(connection.history).toEqual([recentGamma, recentAlpha])
    expect(connection.current).toBeNull()
    expect(connection.stage).toBe('idle')
    expect(connection.notice).toBe(noHosts)
    expect(vi.getTimerCount()).toBe(0)
  }
}

describe('refreshHealth and offline notifications', describeHealthRefresh)

function describeHealthRefresh() {
  it('deduplicates overlapping health refreshes and permits another refresh after the first settles', preventOverlappingHealthWork)

  async function preventOverlappingHealthWork() {
    hydrate([recentAlpha])
    runtime.connectAddress(alpha)
    const probe = deferred<BridgeHost | null>(null)
    boundary.probe.mockReturnValueOnce(probe.promise).mockResolvedValueOnce(openHost(alpha))
    const first = runtime.refreshHealth()

    await runtime.refreshHealth()
    expect(boundary.probe).toHaveBeenCalledTimes(1)
    expect(recordedProbe()[0]).toEqual(alpha)
    expect(recordedProbe()[2]).toBe(3000)
    probe.resolve(openHost(alpha))
    await first
    await runtime.refreshHealth()

    expect(boundary.probe).toHaveBeenCalledTimes(2)
    expect(connection.health[alpha.id]).toBe('available')
    expect(connection.current).toEqual(alpha)
    expect(boundary.notify).not.toHaveBeenCalled()
  }

  it('limits history health checks to the most recent five while including a current origin outside that window', restrictHealthWindow)

  async function restrictHealthWindow() {
    const history: HistoryEntry[] = Array.from({ length: 6 }, makeHistoryEntry)

    function makeHistoryEntry(_: unknown, index: number): HistoryEntry {
      return { id: `http://host-${index + 1}.test:3080`, url: `http://host-${index + 1}.test:3080/`, host: `host-${index + 1}.test`, port: 3080, lastConnectedAt: 6 - index }
    }
    hydrate(history)

    await runtime.refreshHealth()

    expect(boundary.probe.mock.calls.map(probedOrigin)).toEqual([
      'http://host-1.test:3080',
      'http://host-2.test:3080',
      'http://host-3.test:3080',
      'http://host-4.test:3080',
      'http://host-5.test:3080',
    ])

    function probedOrigin(call: Parameters<typeof import('@/services/probe-bridge').probeBridge>): string {
      return call[0].id
    }
    expect(connection.health['http://host-6.test:3080']).toBeUndefined()
    boundary.probe.mockClear()
    runtime.connectAddress({ id: 'http://host-6.test:3080', url: 'http://host-6.test:3080/', host: 'host-6.test', port: 3080 })

    await runtime.refreshHealth()

    expect(boundary.probe.mock.calls.map(probedOrigin)).toEqual([
      'http://host-1.test:3080',
      'http://host-2.test:3080',
      'http://host-3.test:3080',
      'http://host-4.test:3080',
      'http://host-5.test:3080',
      'http://host-6.test:3080',
    ])
  }

  it('does not let a previous origin failure set the new origin offline notice or notification', isolatePreviousOriginHealth)

  async function isolatePreviousOriginHealth() {
    hydrate([recentAlpha])
    runtime.connectAddress(alpha)
    const probe = deferred<BridgeHost | null>(null)
    boundary.probe.mockReturnValue(probe.promise)
    const refreshing = runtime.refreshHealth()

    runtime.connectAddress(beta)
    probe.resolve(null)
    await refreshing

    expect(connection.current).toEqual(beta)
    expect(connection.health[alpha.id]).toBe('unavailable')
    expect(connection.health[beta.id]).toBe('available')
    expect(connection.notice).toBeNull()
    expect(boundary.notify).not.toHaveBeenCalled()
  }

  it('does not overwrite a newly reconnected origin with a health result from its previous view generation', discardHealthFromPreviousConnection)

  async function discardHealthFromPreviousConnection() {
    hydrate([recentAlpha])
    runtime.connectAddress(alpha)
    const probe = deferred<BridgeHost | null>(null)
    boundary.probe.mockReturnValue(probe.promise)
    const refreshing = runtime.refreshHealth()
    const oldGeneration = connection.viewGeneration

    runtime.connectAddress({ ...alpha, url: 'http://10.0.0.20:4444/new-route' })
    expect(connection.viewGeneration).toBeGreaterThan(oldGeneration)
    probe.resolve(null)
    await refreshing

    expect(connection.current).toEqual({ ...alpha, url: 'http://10.0.0.20:4444/new-route' })
    expect(connection.health[alpha.id]).toBe('available')
    expect(connection.notice).toBeNull()
    expect(boundary.notify).not.toHaveBeenCalled()
  }

  it('discards stopped health results and does not release the lock owned by a subsequent refresh', retainNewHealthControllerOwnership)

  async function retainNewHealthControllerOwnership() {
    hydrate([recentAlpha])
    runtime.connectAddress(alpha)
    const oldProbe = deferred<BridgeHost | null>(null)
    const newProbe = deferred<BridgeHost | null>(null)
    boundary.probe.mockReturnValueOnce(oldProbe.promise).mockReturnValueOnce(newProbe.promise)
    const oldRefresh = runtime.refreshHealth()
    const oldSignal = recordedProbe(0)[1]

    runtime.stopConnectionRuntime()
    expect(oldSignal.aborted).toBe(true)
    const newRefresh = runtime.refreshHealth()
    const newSignal = recordedProbe(1)[1]
    expect(newSignal).not.toBe(oldSignal)
    oldProbe.resolve(null)
    await oldRefresh
    expect(connection.health[alpha.id]).toBe('available')
    expect(connection.notice).toBeNull()
    await runtime.refreshHealth()
    expect(boundary.probe).toHaveBeenCalledTimes(2)
    expect(newSignal.aborted).toBe(false)
    newProbe.resolve(openHost(alpha))
    await newRefresh

    expect(connection.health[alpha.id]).toBe('available')
    expect(boundary.notify).not.toHaveBeenCalled()
  }

  it('notifies only on an available-to-offline current-host transition and clears the offline notice after recovery', notifyOfflineTransitions)

  async function notifyOfflineTransitions() {
    hydrate([recentAlpha])
    runtime.connectAddress(alpha)
    boundary.probe.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(openHost(alpha)).mockResolvedValueOnce(null)

    await runtime.refreshHealth()

    expect(connection.health[alpha.id]).toBe('unavailable')
    expect(connection.notice).toBe(hostOffline)
    expect(connection.current).toEqual(alpha)
    expect(boundary.notify).toHaveBeenCalledExactlyOnceWith({
      type: 'dsh://native-notification',
      title: 'DSH Bridge',
      body: hostOffline,
      tag: 'connection:http://10.0.0.20:4444',
      sessionId: '',
      silent: false,
    }, 'http://10.0.0.20:4444')
    await runtime.refreshHealth()
    expect(boundary.notify).toHaveBeenCalledTimes(1)
    expect(connection.notice).toBe(hostOffline)
    await runtime.refreshHealth()
    expect(connection.health[alpha.id]).toBe('available')
    expect(connection.notice).toBeNull()
    expect(boundary.notify).toHaveBeenCalledTimes(1)
    await runtime.refreshHealth()
    expect(connection.health[alpha.id]).toBe('unavailable')
    expect(connection.notice).toBe(hostOffline)
    expect(boundary.notify).toHaveBeenCalledTimes(2)
  }

  it('does not clear an unrelated notice when the current host is available', preserveUnrelatedNotice)

  async function preserveUnrelatedNotice() {
    hydrate([recentAlpha])
    runtime.connectAddress(alpha)
    connection.setNotice('Fixture unrelated notice')
    boundary.probe.mockResolvedValue(openHost(alpha))

    await runtime.refreshHealth()

    expect(connection.health[alpha.id]).toBe('available')
    expect(connection.notice).toBe('Fixture unrelated notice')
    expect(boundary.notify).not.toHaveBeenCalled()
  }
}
