import type { ConnectionSnapshot } from './index'
import type { BridgeAddress } from '@/utils/bridge-protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connection, createConnectionState, parseConnectionSnapshot, resetConnectionStorageCache } from './index'

vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'zh-CN' }] }))
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(), setItem: vi.fn() } }))

const alpha: BridgeAddress = { id: 'http://bridge.local:3080', url: 'http://bridge.local:3080/tasks?theme=dark', host: 'bridge.local', port: 3080 }
const beta: BridgeAddress = { id: 'https://second.local', url: 'https://second.local/workspaces', host: 'second.local', port: 443 }

function load(address: BridgeAddress, at: number) {
  expect(connection.accept(address)).toBe(true)
  connection.markLoaded(connection.viewGeneration, at)
}

beforeEach(() => {
  connection.$persist.meta.hydrated = false
  connection.$persist.meta.mounted = false
  connection.$patch(createConnectionState())
  resetConnectionStorageCache()
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('parseConnectionSnapshot trust boundary', () => {
  it.each([null, undefined, [], {}, { version: 2, history: [] }, { version: '1', history: [] }, { version: 1, history: {} }])('discards invalid snapshot envelope %j', (value) => {
    expect(parseConnectionSnapshot(value)).toEqual({ version: 1, history: [], guidedHosts: [] })
  })

  it('reconstructs addresses from URLs, strips secrets and ignores injected metadata and unknown guided origins', () => {
    expect(parseConnectionSnapshot({
      version: 1,
      history: [
        { id: 'https://evil.test', url: 'https://BRIDGE.local:443/tasks?auth=secret&token=other&theme=dark#private', host: 'evil.test', port: 1, token: 'injected', lastConnectedAt: 10 },
        { url: 'http://second.local:3082/route', lastConnectedAt: 20 },
      ],
      tokens: { 'https://bridge.local': 'untrusted' },
      guidedHosts: ['https://bridge.local', 'https://unknown.local', 'https://bridge.local', 7, 'http://second.local:3082/path'],
    })).toEqual({
      version: 1,
      history: [
        { id: 'http://second.local:3082', url: 'http://second.local:3082/route', host: 'second.local', port: 3082, lastConnectedAt: 20 },
        { id: 'https://bridge.local', url: 'https://bridge.local/tasks?theme=dark', host: 'bridge.local', port: 443, lastConnectedAt: 10 },
      ],
      guidedHosts: ['https://bridge.local'],
    })
  })

  it('rejects malformed entries and nonfinite or negative timestamps while retaining timestamp zero', () => {
    expect(parseConnectionSnapshot({
      version: 1,
      history: [
        null,
        [],
        { url: 42, lastConnectedAt: 1 },
        { url: 'http://missing.local', lastConnectedAt: '1' },
        { url: 'ftp://wrong.local', lastConnectedAt: 1 },
        { url: 'http://user:password@unsafe.local', lastConnectedAt: 1 },
        { url: 'http://negative.local', lastConnectedAt: -1 },
        { url: 'http://nan.local', lastConnectedAt: Number.NaN },
        { url: 'http://infinite.local', lastConnectedAt: Number.POSITIVE_INFINITY },
        { url: 'http://zero.local', lastConnectedAt: 0 },
      ],
      guidedHosts: 'http://zero.local',
    })).toEqual({
      version: 1,
      history: [{ id: 'http://zero.local', url: 'http://zero.local/', host: 'zero.local', port: 80, lastConnectedAt: 0 }],
      guidedHosts: [],
    })
  })

  it('deduplicates equivalent default-port origins without merging distinct schemes or ports', () => {
    expect(parseConnectionSnapshot({
      version: 1,
      history: [
        { url: 'http://BRIDGE.local:80/new', lastConnectedAt: 3 },
        { url: 'http://bridge.local/old', lastConnectedAt: 1 },
        { url: 'https://bridge.local/', lastConnectedAt: 2 },
        { url: 'http://bridge.local:3080/', lastConnectedAt: 0 },
      ],
    }).history).toEqual([
      { id: 'http://bridge.local', url: 'http://bridge.local/new', host: 'bridge.local', port: 80, lastConnectedAt: 3 },
      { id: 'https://bridge.local', url: 'https://bridge.local/', host: 'bridge.local', port: 443, lastConnectedAt: 2 },
      { id: 'http://bridge.local:3080', url: 'http://bridge.local:3080/', host: 'bridge.local', port: 3080, lastConnectedAt: 0 },
    ])
  })

  it('retains the newest duplicate origin even when persisted history is unsorted', () => {
    expect(parseConnectionSnapshot({
      version: 1,
      history: [
        { url: 'http://bridge.local:3080/older?auth=old', lastConnectedAt: 1 },
        { url: 'http://bridge.local:3080/newer?token=new', lastConnectedAt: 7 },
      ],
    }).history).toEqual([
      { id: 'http://bridge.local:3080', url: 'http://bridge.local:3080/newer', host: 'bridge.local', port: 3080, lastConnectedAt: 7 },
    ])
  })

  it('sorts and caps persisted history at twenty while pruning guides for evicted origins', () => {
    const history = Array.from({ length: 22 }, (_, index) => ({ url: `http://host-${index + 1}.local:3080/`, lastConnectedAt: index + 1 }))
    const snapshot = parseConnectionSnapshot({ version: 1, history, guidedHosts: ['http://host-1.local:3080', 'http://host-22.local:3080'] })
    expect(snapshot.history).toHaveLength(20)
    expect(snapshot.history.map(entry => entry.lastConnectedAt)).toEqual([22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3])
    expect(snapshot.guidedHosts).toEqual(['http://host-22.local:3080'])
    expect(history).toHaveLength(22)
    expect(history[0]).toEqual({ url: 'http://host-1.local:3080/', lastConnectedAt: 1 })
  })
})

describe('connection hydration', () => {
  it('starts the singleton store with an isolated empty method-selection state', () => {
    expect(connection.$state).toEqual({
      version: 1,
      hydrated: false,
      stage: 'idle',
      current: null,
      history: [],
      tokens: {},
      health: {},
      guidedHosts: [],
      drawerOpen: false,
      swipeHintVisible: false,
      loading: false,
      loadError: null,
      notice: null,
      scanGeneration: 0,
      viewGeneration: 0,
      pendingFocus: null,
      focusGeneration: 0,
    })
    connection.setHealth('http://bridge.local:3080', 'unavailable')
    expect(connection.health).toEqual({ 'http://bridge.local:3080': 'unavailable' })
    expect(createConnectionState().health).toEqual({})
  })

  it('hydrates exactly once without opening a connection or replacing later state', () => {
    const snapshot: ConnectionSnapshot = {
      version: 1,
      history: [{ ...alpha, lastConnectedAt: 10 }],
      guidedHosts: ['http://bridge.local:3080'],
    }
    connection.$patch(parseConnectionSnapshot(snapshot))
    connection.markHydrated({ 'http://bridge.local:3080': 'secure-secret' })
    connection.markHydrated({})
    expect(connection.hydrated).toBe(true)
    expect(connection.history).toEqual([{ id: 'http://bridge.local:3080', url: 'http://bridge.local:3080/tasks?theme=dark', host: 'bridge.local', port: 3080, lastConnectedAt: 10 }])
    expect(connection.guidedHosts).toEqual(['http://bridge.local:3080'])
    expect(connection.tokens).toEqual({ 'http://bridge.local:3080': 'secure-secret' })
    expect(connection.current).toBeNull()
    expect(connection.stage).toBe('idle')
    expect(connection.scanGeneration).toBe(0)
    expect(connection.viewGeneration).toBe(0)
  })
})

describe('connection scan and view generations', () => {
  it('ignores stale scan results without mutating the active scan', () => {
    const first = connection.beginScan()
    const second = connection.beginScan()
    expect(first).toBe(1)
    expect(second).toBe(2)
    expect(connection.accept(alpha, first)).toBe(false)
    connection.finishScan(first, 'old notice')
    expect(connection.stage).toBe('scanning')
    expect(connection.current).toBeNull()
    expect(connection.notice).toBeNull()
    expect(connection.scanGeneration).toBe(2)
    connection.finishScan(second, 'No hosts')
    expect(connection.stage).toBe('idle')
    expect(connection.notice).toBe('No hosts')
  })

  it('cancelScan invalidates pending discoveries and completion notices', () => {
    const generation = connection.beginScan()
    connection.cancelScan()
    expect(connection.scanGeneration).toBe(2)
    expect(connection.stage).toBe('idle')
    expect(connection.accept(alpha, generation)).toBe(false)
    connection.finishScan(generation, 'stale')
    expect(connection.notice).toBeNull()
    expect(connection.current).toBeNull()
  })

  it('does not let scan cancellation or stale completion disconnect an accepted host', () => {
    const generation = connection.beginScan()
    expect(connection.accept(alpha, generation)).toBe(true)
    expect(connection.scanGeneration).toBe(2)
    expect(connection.viewGeneration).toBe(2)
    connection.finishScan(generation, 'late scan')
    connection.cancelScan()
    expect(connection.stage).toBe('connected')
    expect(connection.current).toEqual(alpha)
    expect(connection.notice).toBeNull()
  })

  it('beginScan clears transient view state while retaining successful history and tokens', () => {
    load({ ...alpha, token: 'saved' }, 10)
    connection.setDrawerOpen(true)
    connection.setNotice('old notice')
    connection.markLoadFailed(connection.viewGeneration, 'old error')
    expect(connection.beginScan()).toBe(2)
    expect(connection.viewGeneration).toBe(2)
    expect(connection.current).toBeNull()
    expect(connection.stage).toBe('scanning')
    expect(connection.loading).toBe(false)
    expect(connection.loadError).toBeNull()
    expect(connection.notice).toBeNull()
    expect(connection.drawerOpen).toBe(false)
    expect(connection.swipeHintVisible).toBe(false)
    expect(connection.history).toEqual([{ ...alpha, lastConnectedAt: 10 }])
    expect(connection.tokens).toEqual({ 'http://bridge.local:3080': 'saved' })
  })

  it('ignores stale loaded and failed callbacks after accepting another origin', () => {
    connection.accept(alpha)
    const oldView = connection.viewGeneration
    connection.accept(beta)
    connection.markLoaded(oldView, 100)
    connection.markLoadFailed(oldView, 'late failure')
    expect(connection.current).toEqual(beta)
    expect(connection.loading).toBe(true)
    expect(connection.loadError).toBeNull()
    expect(connection.history).toEqual([])
    expect(connection.health).toEqual({ 'http://bridge.local:3080': 'available', 'https://second.local': 'available' })
    connection.markLoaded(connection.viewGeneration, 200)
    expect(connection.history).toEqual([{ ...beta, lastConnectedAt: 200 }])
  })
})

describe('connection acceptance and successful history', () => {
  it('rejects invalid addresses without storing their token or advancing generations', () => {
    expect(connection.accept({ id: 'https://forged.local', url: 'ftp://bad.local', host: 'forged.local', port: 3080, token: 'secret' })).toBe(false)
    expect(connection.current).toBeNull()
    expect(connection.tokens).toEqual({})
    expect(connection.scanGeneration).toBe(0)
    expect(connection.viewGeneration).toBe(0)
  })

  it('normalizes the URL instead of trusting id, host and port supplied by a caller', () => {
    expect(connection.accept({ id: 'https://evil.local', url: 'http://BRIDGE.local:80/tasks?token=url-secret&theme=dark#fragment', host: 'evil.local', port: 9, token: 'explicit-secret' })).toBe(true)
    expect(connection.current).toEqual({ id: 'http://bridge.local', url: 'http://bridge.local/tasks?theme=dark', host: 'bridge.local', port: 80, token: 'explicit-secret' })
    expect(connection.tokens).toEqual({ 'http://bridge.local': 'explicit-secret' })
    expect(connection.history).toEqual([])
    expect(connection.health).toEqual({ 'http://bridge.local': 'available' })
  })

  it('reuses a secure token only for the exact normalized origin', () => {
    connection.markHydrated({ 'http://bridge.local:3080': 'saved' })
    connection.accept(alpha)
    expect(connection.current).toEqual({ ...alpha, token: 'saved' })
    connection.accept({ ...alpha, id: 'http://bridge.local:3082', url: 'http://bridge.local:3082/tasks', port: 3082 })
    expect(connection.current).toEqual({ id: 'http://bridge.local:3082', url: 'http://bridge.local:3082/tasks', host: 'bridge.local', port: 3082 })
    expect(connection.tokens).toEqual({ 'http://bridge.local:3080': 'saved' })
  })

  it('remembers a token extracted from the accepted URL even if there was no explicit token field', () => {
    connection.accept({ ...alpha, url: 'http://bridge.local:3080/tasks?auth=fresh&theme=dark' })
    expect(connection.current).toEqual({ ...alpha, token: 'fresh' })
    expect(connection.tokens).toEqual({ 'http://bridge.local:3080': 'fresh' })
  })

  it('prefers a newly scanned URL token over an older saved token for that origin', () => {
    connection.markHydrated({ 'http://bridge.local:3080': 'old' })
    connection.accept({ ...alpha, url: 'http://bridge.local:3080/tasks?auth=fresh&theme=dark' })
    expect(connection.current).toEqual({ ...alpha, token: 'fresh' })
    expect(connection.tokens).toEqual({ 'http://bridge.local:3080': 'fresh' })
  })

  it('records history only after a successful view load', () => {
    connection.accept({ ...alpha, token: 'secret' })
    expect(connection.history).toEqual([])
    connection.markLoadFailed(connection.viewGeneration, 'HTTP 401')
    connection.markLoaded(connection.viewGeneration, 100)
    expect(connection.history).toEqual([])
    expect(connection.loadError).toBe('HTTP 401')
    expect(connection.health['http://bridge.local:3080']).toBe('unavailable')
    expect(connection.loading).toBe(false)
    expect(connection.swipeHintVisible).toBe(false)
    load(alpha, 200)
    expect(connection.history).toEqual([{ ...alpha, lastConnectedAt: 200 }])
    expect(connection.loading).toBe(false)
    expect(connection.loadError).toBeNull()
  })

  it('does not rewrite history or reopen the dismissed guide on duplicate document readiness', () => {
    load(alpha, 10)
    connection.dismissHint()
    connection.markLoaded(connection.viewGeneration, 20)
    expect(connection.history).toEqual([{ ...alpha, lastConnectedAt: 10 }])
    expect(connection.guidedHosts).toEqual(['http://bridge.local:3080'])
    expect(connection.swipeHintVisible).toBe(false)
    expect(connection.loading).toBe(false)
  })

  it('uses the successful load clock rather than the accept time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-01-02T03:04:05.000Z'))
    connection.accept(alpha)
    vi.setSystemTime(new Date('2024-01-02T03:04:06.000Z'))
    connection.markLoaded(connection.viewGeneration)
    expect(connection.history).toEqual([{ ...alpha, lastConnectedAt: 1704164646000 }])
  })

  it('moves a repeated origin to the front with its latest route instead of duplicating it', () => {
    load(alpha, 1)
    load(beta, 2)
    load({ ...alpha, url: 'http://bridge.local:3080/new?auth=secret&view=compact' }, 3)
    expect(connection.history).toEqual([
      { id: 'http://bridge.local:3080', url: 'http://bridge.local:3080/new?view=compact', host: 'bridge.local', port: 3080, lastConnectedAt: 3 },
      { ...beta, lastConnectedAt: 2 },
    ])
  })

  it('retains twenty successful origins, exposes only five recent entries and prunes evicted guides', () => {
    for (let index = 1; index <= 21; index++) {
      load({ id: `http://host-${index}.local:3080`, url: `http://host-${index}.local:3080/`, host: `host-${index}.local`, port: 3080 }, index)
      if (index === 1 || index === 2)
        connection.dismissHint()
    }
    expect(connection.history).toHaveLength(20)
    expect(connection.history.map(entry => entry.lastConnectedAt)).toEqual([21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2])
    expect(connection.recentFive.map(entry => entry.id)).toEqual(['http://host-21.local:3080', 'http://host-20.local:3080', 'http://host-19.local:3080', 'http://host-18.local:3080', 'http://host-17.local:3080'])
    expect(connection.guidedHosts).toEqual(['http://host-2.local:3080'])
    connection.recentFive.pop()
    expect(connection.history).toHaveLength(20)
    expect(connection.recentFive).toHaveLength(5)
  })
})

describe('connection hints, disconnect and serialization', () => {
  it('shows the swipe hint only on successful load until dismissed for that exact origin', () => {
    connection.accept(alpha)
    expect(connection.swipeHintVisible).toBe(false)
    connection.markLoaded(connection.viewGeneration, 1)
    expect(connection.swipeHintVisible).toBe(true)
    connection.dismissHint()
    connection.dismissHint()
    expect(connection.guidedHosts).toEqual(['http://bridge.local:3080'])
    expect(connection.swipeHintVisible).toBe(false)
    load({ ...alpha, url: 'http://bridge.local:3080/another' }, 2)
    expect(connection.swipeHintVisible).toBe(false)
    load({ ...alpha, id: 'http://bridge.local:3082', url: 'http://bridge.local:3082/', port: 3082 }, 3)
    expect(connection.swipeHintVisible).toBe(true)
    expect(connection.guidedHosts).toEqual(['http://bridge.local:3080'])
  })

  it('cannot record an unseen guide as dismissed while the first document is loading or failed', () => {
    connection.accept(alpha)
    connection.dismissHint()
    expect(connection.guidedHosts).toEqual([])
    connection.markLoadFailed(connection.viewGeneration, 'Network unavailable')
    connection.dismissHint()
    expect(connection.guidedHosts).toEqual([])
    load(alpha, 10)
    expect(connection.swipeHintVisible).toBe(true)
    connection.dismissHint()
    expect(connection.guidedHosts).toEqual(['http://bridge.local:3080'])
    expect(connection.swipeHintVisible).toBe(false)
  })

  it('does not record a dismissed hint when no current host exists', () => {
    connection.dismissHint()
    expect(connection.guidedHosts).toEqual([])
    expect(connection.swipeHintVisible).toBe(false)
  })

  it('disconnect clears transient UI and invalidates callbacks while preserving history, secure tokens and guides', () => {
    load({ ...alpha, token: 'secure-secret' }, 10)
    connection.dismissHint()
    connection.setDrawerOpen(true)
    connection.setNotice('offline')
    connection.queueFocus({ origin: 'http://bridge.local:3080', sessionId: 'session-1', title: 'Task', tag: 'task-1' })
    const oldView = connection.viewGeneration
    connection.disconnect()
    connection.markLoaded(oldView, 20)
    connection.markLoadFailed(oldView, 'stale')
    expect(connection.current).toBeNull()
    expect(connection.stage).toBe('scanning')
    expect(connection.scanGeneration).toBe(2)
    expect(connection.viewGeneration).toBe(2)
    expect(connection.loading).toBe(false)
    expect(connection.loadError).toBeNull()
    expect(connection.notice).toBeNull()
    expect(connection.drawerOpen).toBe(false)
    expect(connection.swipeHintVisible).toBe(false)
    expect(connection.pendingFocus).toBeNull()
    expect(connection.history).toEqual([{ ...alpha, lastConnectedAt: 10 }])
    expect(connection.tokens).toEqual({ 'http://bridge.local:3080': 'secure-secret' })
    expect(connection.guidedHosts).toEqual(['http://bridge.local:3080'])
  })

  it('serializes only sanitized successful history and guides, never runtime state or tokens', () => {
    load({ ...alpha, url: 'http://bridge.local:3080/tasks?auth=secret&token=other&theme=dark#private', token: 'secure-secret' }, 10)
    connection.dismissHint()
    connection.queueFocus({ origin: 'http://bridge.local:3080', sessionId: 'session-1', title: 'Task', tag: 'task-1' })
    expect(connection.serialize()).toEqual({
      version: 1,
      history: [{ id: 'http://bridge.local:3080', url: 'http://bridge.local:3080/tasks?theme=dark', host: 'bridge.local', port: 3080, lastConnectedAt: 10 }],
      guidedHosts: ['http://bridge.local:3080'],
    })
    expect(JSON.stringify(connection.serialize())).not.toContain('secret')
    const serialized = connection.serialize()
    serialized.history[0]!.url = 'https://mutated.test/'
    serialized.guidedHosts.push('https://mutated.test')
    expect(connection.history[0]?.url).toBe('http://bridge.local:3080/tasks?theme=dark')
    expect(connection.guidedHosts).toEqual(['http://bridge.local:3080'])
  })
})
