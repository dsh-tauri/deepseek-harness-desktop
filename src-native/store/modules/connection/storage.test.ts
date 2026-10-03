import type { ConnectionSnapshot } from './index'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n'
import { connection, createConnectionState, parseConnectionSnapshot, resetConnectionStorageCache } from './index'
import { bindConnectionPersistence, restoreConnections } from './storage'

const native = vi.hoisted(() => ({
  read: vi.fn<(key: string) => Promise<string | null>>(),
  write: vi.fn<(key: string, value: string) => Promise<void>>(),
  readToken: vi.fn<(key: string) => Promise<string | null>>(),
  writeToken: vi.fn<(key: string, value: string) => Promise<void>>(),
  deleteToken: vi.fn<(key: string) => Promise<void>>(),
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: native.read, setItem: native.write } }))
vi.mock('expo-secure-store', () => ({ getItemAsync: native.readToken, setItemAsync: native.writeToken, deleteItemAsync: native.deleteToken }))
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'zh-CN' }] }))

const alpha = { id: 'http://bridge.local:3080', url: 'http://bridge.local:3080/tasks?theme=dark', host: 'bridge.local', port: 3080 }
const beta = { id: 'https://second.local', url: 'https://second.local/workspaces', host: 'second.local', port: 443 }
const alphaKey = 'dsh-bridge.token.0068007400740070003a002f002f006200720069006400670065002e006c006f00630061006c003a0033003000380030'
const betaKey = 'dsh-bridge.token.00680074007400700073003a002f002f007300650063006f006e0064002e006c006f00630061006c'
const emptySnapshot: ConnectionSnapshot = { version: 1, history: [], guidedHosts: [] }
const emptyPayload = payload([])
const storageFailure = i18n.t('connection.storageFailed')
const unsubscribers: (() => void)[] = []

function payload(history: ConnectionSnapshot['history'], guidedHosts: string[] = []): string {
  return JSON.stringify({ version: 1, history, guidedHosts })
}

function secureKey(origin: string): string {
  return `dsh-bridge.token.${Array.from(origin, character => character.charCodeAt(0).toString(16).padStart(4, '0')).join('')}`
}

function writtenPayloads(): string[] {
  return native.write.mock.calls.map(call => call[1])
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function bind() {
  const unsubscribe = bindConnectionPersistence()
  unsubscribers.push(unsubscribe)
  return unsubscribe
}

async function hydrate(snapshot: ConnectionSnapshot = emptySnapshot, tokens: Record<string, string> = {}) {
  native.read.mockResolvedValue(JSON.stringify(parseConnectionSnapshot(snapshot)))
  native.readToken.mockImplementation(async key => Object.entries(tokens).find(([id]) => secureKey(id) === key)?.[1] ?? null)
  await restoreConnections()
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  connection.$persist.meta.hydrated = false
  connection.$persist.meta.mounted = false
  connection.$patch(createConnectionState())
  resetConnectionStorageCache()
  vi.resetAllMocks()
  native.read.mockResolvedValue(null)
  native.write.mockResolvedValue(undefined)
  native.readToken.mockResolvedValue(null)
  native.writeToken.mockResolvedValue(undefined)
  native.deleteToken.mockResolvedValue(undefined)
  vi.clearAllMocks()
})

afterEach(() => {
  for (const unsubscribe of unsubscribers.splice(0))
    unsubscribe()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('restoreConnections', () => {
  it('restores sanitized history and retrieves tokens exclusively from native secure storage by normalized origin', async () => {
    native.read.mockResolvedValue(JSON.stringify({
      version: 1,
      history: [
        { id: 'https://evil.test', url: 'http://BRIDGE.local:3080/tasks?auth=plaintext&token=other&theme=dark#private', host: 'evil.test', port: 9, token: 'injected', lastConnectedAt: 10 },
        { url: 'https://second.local/workspaces', lastConnectedAt: 20 },
        { url: 'ftp://wrong.local', lastConnectedAt: 30 },
      ],
      tokens: { 'http://bridge.local:3080': 'plaintext-map' },
      guidedHosts: ['http://bridge.local:3080', 'https://evil.test'],
    }))
    native.readToken.mockImplementation(async (key) => {
      if (key === alphaKey)
        return 'secure-alpha'
      if (key === betaKey)
        return null
      throw new Error(`Unexpected secure key: ${key}`)
    })
    await restoreConnections()
    expect(native.read).toHaveBeenCalledExactlyOnceWith('dsh-bridge/connections')
    expect(native.readToken.mock.calls).toEqual([[betaKey], [alphaKey]])
    expect(connection.hydrated).toBe(true)
    expect(connection.history).toEqual([{ ...beta, lastConnectedAt: 20 }, { ...alpha, lastConnectedAt: 10 }])
    expect(connection.tokens).toEqual({ 'http://bridge.local:3080': 'secure-alpha' })
    expect(connection.guidedHosts).toEqual(['http://bridge.local:3080'])
    expect(connection.current).toBeNull()
    expect(connection.stage).toBe('idle')
    expect(native.write).not.toHaveBeenCalled()
    expect(native.writeToken).not.toHaveBeenCalled()
    expect(native.deleteToken).not.toHaveBeenCalled()
    await restoreConnections()
    expect(native.read).toHaveBeenCalledTimes(1)
    expect(native.readToken).toHaveBeenCalledTimes(2)
  })

  it('hydrates an empty store and persists the clean snapshot when there is no persisted snapshot', async () => {
    await restoreConnections()
    expect(connection.hydrated).toBe(true)
    expect(connection.serialize()).toEqual({ version: 1, history: [], guidedHosts: [] })
    expect(connection.tokens).toEqual({})
    expect(connection.notice).toBeNull()
    expect(native.readToken).not.toHaveBeenCalled()
    expect(native.write).toHaveBeenCalledExactlyOnceWith('dsh-bridge/connections', emptyPayload)
  })

  it('rejects untrusted persisted address schemes and credentials before any secure-storage lookup', async () => {
    native.read.mockResolvedValue(JSON.stringify({
      version: 1,
      history: [
        { url: 'javascript:alert(1)', lastConnectedAt: 1 },
        { url: 'http://user:secret@bridge.local:3080/', lastConnectedAt: 2 },
        { url: 'http://bridge.local:65536/', lastConnectedAt: 3 },
        { url: 'http://bad.local', lastConnectedAt: -1 },
      ],
      guidedHosts: ['http://bridge.local:3080'],
      tokens: { 'http://bridge.local:3080': 'untrusted' },
    }))
    await restoreConnections()
    expect(connection.serialize()).toEqual({ version: 1, history: [], guidedHosts: [] })
    expect(connection.tokens).toEqual({})
    expect(native.readToken).not.toHaveBeenCalled()
    expect(connection.hydrated).toBe(true)
    expect(native.write).not.toHaveBeenCalled()
  })

  it('reports malformed persisted JSON without accepting its embedded token and replaces it with a clean snapshot', async () => {
    native.read.mockResolvedValue('{"version":1,"tokens":{"bad":"secret"}')
    await restoreConnections()
    expect(connection.hydrated).toBe(true)
    expect(connection.serialize()).toEqual({ version: 1, history: [], guidedHosts: [] })
    expect(connection.tokens).toEqual({})
    expect(connection.notice).toBe(storageFailure)
    expect(native.readToken).not.toHaveBeenCalled()
    expect(native.write).toHaveBeenCalledExactlyOnceWith('dsh-bridge/connections', emptyPayload)
  })

  it('discards unsupported snapshot versions before fetching tokens', async () => {
    native.read.mockResolvedValue(JSON.stringify({ version: 2, history: [{ ...alpha, lastConnectedAt: 10 }], guidedHosts: [] }))
    await restoreConnections()
    expect(connection.hydrated).toBe(true)
    expect(connection.history).toEqual([])
    expect(native.readToken).not.toHaveBeenCalled()
    expect(native.write).not.toHaveBeenCalled()
  })

  it('reports a native history-read error and completes safe empty hydration', async () => {
    const error = new Error('History storage unavailable')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    native.read.mockRejectedValue(error)
    await restoreConnections()
    expect(connection.hydrated).toBe(true)
    expect(connection.serialize()).toEqual({ version: 1, history: [], guidedHosts: [] })
    expect(connection.tokens).toEqual({})
    expect(connection.notice).toBe(storageFailure)
    expect(log).toHaveBeenCalledExactlyOnceWith('[connection] restore failed:', error)
    expect(native.readToken).not.toHaveBeenCalled()
    expect(native.write).toHaveBeenCalledExactlyOnceWith('dsh-bridge/connections', emptyPayload)
  })

  it('preserves valid history when secure-token reads fail without falling back to plaintext tokens', async () => {
    const error = new Error('Secure storage locked')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    native.read.mockResolvedValue(JSON.stringify({ version: 1, history: [{ ...alpha, token: 'plaintext', lastConnectedAt: 10 }], guidedHosts: [] }))
    native.readToken.mockRejectedValue(error)
    await restoreConnections()
    expect(connection.hydrated).toBe(true)
    expect(connection.serialize()).toEqual({ version: 1, history: [{ ...alpha, lastConnectedAt: 10 }], guidedHosts: [] })
    expect(connection.tokens).toEqual({})
    expect(connection.notice).toBe(storageFailure)
    expect(log).toHaveBeenCalledExactlyOnceWith('[connection] token restore failed:', error)
    expect(native.write).not.toHaveBeenCalled()
  })

  it('isolates a failed token read without discarding other readable tokens or saved guide state', async () => {
    const error = new Error('One token unavailable')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    native.read.mockResolvedValue(JSON.stringify({
      version: 1,
      history: [{ ...beta, lastConnectedAt: 20 }, { ...alpha, lastConnectedAt: 10 }],
      guidedHosts: [alpha.id],
    }))
    native.readToken.mockImplementation(async (key) => {
      if (key === betaKey)
        throw error
      return 'secure-alpha'
    })
    await restoreConnections()
    expect(connection.serialize()).toEqual({
      version: 1,
      history: [{ ...beta, lastConnectedAt: 20 }, { ...alpha, lastConnectedAt: 10 }],
      guidedHosts: [alpha.id],
    })
    expect(connection.tokens).toEqual({ [alpha.id]: 'secure-alpha' })
    expect(connection.notice).toBe(storageFailure)
    expect(log).toHaveBeenCalledExactlyOnceWith('[connection] token restore failed:', error)
    expect(native.write).not.toHaveBeenCalled()
    expect(native.writeToken).not.toHaveBeenCalled()
    expect(native.deleteToken).not.toHaveBeenCalled()
  })

  it('never writes before both history and secure-token hydration finish and does not echo the snapshot already on disk', async () => {
    const historyRead = deferred<string | null>()
    const tokenRead = deferred<string | null>()
    native.read.mockReturnValue(historyRead.promise)
    native.readToken.mockReturnValue(tokenRead.promise)
    bind()
    const restoring = restoreConnections()
    connection.setNotice('Restoring')
    await vi.advanceTimersByTimeAsync(0)
    expect(connection.hydrated).toBe(false)
    expect(connection.tokens).toEqual({})
    expect(native.write).not.toHaveBeenCalled()
    expect(native.writeToken).not.toHaveBeenCalled()
    historyRead.resolve(payload([{ ...alpha, lastConnectedAt: 10 }]))
    await vi.advanceTimersByTimeAsync(0)
    expect(native.readToken).toHaveBeenCalledExactlyOnceWith(alphaKey)
    expect(connection.hydrated).toBe(false)
    expect(connection.history).toEqual([{ ...alpha, lastConnectedAt: 10 }])
    expect(connection.tokens).toEqual({})
    expect(native.write).not.toHaveBeenCalled()
    tokenRead.resolve('secure-alpha')
    await restoring
    await vi.advanceTimersByTimeAsync(0)
    expect(connection.hydrated).toBe(true)
    expect(connection.tokens).toEqual({ [alpha.id]: 'secure-alpha' })
    expect(native.writeToken).toHaveBeenCalledExactlyOnceWith(alphaKey, 'secure-alpha')
    expect(native.write).not.toHaveBeenCalled()
    expect(native.deleteToken).not.toHaveBeenCalled()
  })
})

describe('bindConnectionPersistence security and ordering', () => {
  it('does not write any pre-hydration runtime changes', async () => {
    bind()
    connection.accept({ ...alpha, token: 'not-yet-hydrated' })
    connection.markLoaded(connection.viewGeneration, 10)
    await vi.advanceTimersByTimeAsync(0)
    expect(native.write).not.toHaveBeenCalled()
    expect(native.writeToken).not.toHaveBeenCalled()
    expect(native.deleteToken).not.toHaveBeenCalled()
  })

  it('retains the current unsaved token in secure storage without putting it in the public snapshot', async () => {
    await hydrate()
    bind()
    connection.accept({ ...alpha, token: 'current-secret' })
    await vi.advanceTimersByTimeAsync(0)
    expect(native.writeToken).toHaveBeenCalledExactlyOnceWith(alphaKey, 'current-secret')
    expect(native.writeToken.mock.calls).toEqual([[alphaKey, 'current-secret']])
    expect(native.write).not.toHaveBeenCalled()
    connection.markLoaded(connection.viewGeneration, 10)
    await vi.advanceTimersByTimeAsync(0)
    expect(native.write).toHaveBeenCalledExactlyOnceWith('dsh-bridge/connections', payload([{ ...alpha, lastConnectedAt: 10 }]))
    expect(writtenPayloads()[0]).not.toContain('current-secret')
    expect(connection.tokens).toEqual({ [alpha.id]: 'current-secret' })
    expect(native.deleteToken).not.toHaveBeenCalled()
  })

  it('writes only retained-origin tokens and excludes secrets from successful history serialization', async () => {
    await hydrate()
    connection.$patch({ tokens: { 'http://orphan.local': 'orphan-secret' } })
    bind()
    connection.accept({ ...alpha, url: 'http://bridge.local:3080/tasks?auth=qr-secret&token=other&theme=dark#private', token: 'secure-secret' })
    connection.markLoaded(connection.viewGeneration, 10)
    connection.dismissHint()
    await vi.advanceTimersByTimeAsync(0)
    expect(native.writeToken.mock.calls).toEqual([[alphaKey, 'secure-secret']])
    expect(native.write).toHaveBeenCalledExactlyOnceWith('dsh-bridge/connections', payload([{ ...alpha, lastConnectedAt: 10 }], ['http://bridge.local:3080']))
    expect(native.write.mock.calls[0]?.[1]).not.toContain('secret')
    expect(native.write.mock.calls[0]?.[1]).not.toContain('auth')
    expect(native.deleteToken).not.toHaveBeenCalled()
  })

  it('writes later normalized snapshots while an earlier snapshot write is still pending', async () => {
    const firstWrite = deferred<void>()
    native.write.mockReturnValueOnce(firstWrite.promise)
    await hydrate()
    bind()
    connection.accept({ ...alpha, token: 'alpha-secret' })
    connection.markLoaded(connection.viewGeneration, 10)
    await vi.advanceTimersByTimeAsync(0)
    expect(native.write).toHaveBeenCalledTimes(1)
    expect(native.writeToken.mock.calls).toEqual([[alphaKey, 'alpha-secret']])
    connection.accept({ ...beta, token: 'beta-secret' })
    connection.markLoaded(connection.viewGeneration, 20)
    await vi.advanceTimersByTimeAsync(0)
    expect(native.write).toHaveBeenCalledTimes(2)
    expect(JSON.parse(native.write.mock.calls[0]![1])).toEqual({ version: 1, history: [{ ...alpha, lastConnectedAt: 10 }], guidedHosts: [] })
    expect(native.writeToken.mock.calls).toEqual([[alphaKey, 'alpha-secret'], [alphaKey, 'alpha-secret'], [betaKey, 'beta-secret']])
    firstWrite.resolve(undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(native.write.mock.calls.map(call => [call[0], JSON.parse(call[1])])).toEqual([
      ['dsh-bridge/connections', { version: 1, history: [{ ...alpha, lastConnectedAt: 10 }], guidedHosts: [] }],
      ['dsh-bridge/connections', { version: 1, history: [{ ...beta, lastConnectedAt: 20 }, { ...alpha, lastConnectedAt: 10 }], guidedHosts: [] }],
    ])
    expect(native.writeToken.mock.calls).toEqual([[alphaKey, 'alpha-secret'], [alphaKey, 'alpha-secret'], [betaKey, 'beta-secret']])
  })

  it('writes the pruned history and deletes the secure token of an evicted origin without waiting for the snapshot write', async () => {
    const snapshotWrite = deferred<void>()
    native.write.mockReturnValueOnce(snapshotWrite.promise)
    await hydrate({ version: 1, history: [{ ...alpha, lastConnectedAt: 10 }, { ...beta, lastConnectedAt: 5 }], guidedHosts: [] }, { 'http://bridge.local:3080': 'alpha-secret', 'https://second.local': 'beta-secret' })
    bind()
    connection.$patch({ history: [{ ...beta, lastConnectedAt: 5 }] })
    await vi.advanceTimersByTimeAsync(0)
    expect(native.writeToken.mock.calls).toEqual([[betaKey, 'beta-secret']])
    expect(native.write).toHaveBeenCalledExactlyOnceWith('dsh-bridge/connections', payload([{ ...beta, lastConnectedAt: 5 }]))
    expect(native.deleteToken).toHaveBeenCalledExactlyOnceWith(alphaKey)
    expect(native.write.mock.invocationCallOrder[0]).toBeLessThan(native.deleteToken.mock.invocationCallOrder[0]!)
    snapshotWrite.resolve(undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(native.deleteToken).toHaveBeenCalledExactlyOnceWith(alphaKey)
  })

  it('keeps saved history tokens on disconnect while deleting a token for an unsaved current origin', async () => {
    await hydrate({ version: 1, history: [{ ...alpha, lastConnectedAt: 10 }], guidedHosts: [] }, { 'http://bridge.local:3080': 'alpha-secret' })
    bind()
    connection.accept({ ...beta, token: 'unsaved-secret' })
    await vi.advanceTimersByTimeAsync(0)
    expect(native.writeToken.mock.calls).toEqual([[alphaKey, 'alpha-secret'], [betaKey, 'unsaved-secret']])
    connection.disconnect()
    await vi.advanceTimersByTimeAsync(0)
    expect(connection.history).toEqual([{ ...alpha, lastConnectedAt: 10 }])
    expect(native.deleteToken.mock.calls).toEqual([[betaKey]])
    expect(native.writeToken.mock.calls).toEqual([[alphaKey, 'alpha-secret'], [betaKey, 'unsaved-secret'], [alphaKey, 'alpha-secret']])
    expect(native.write).not.toHaveBeenCalled()
  })

  it('does not rewrite an unchanged snapshot and token payload for transient UI changes', async () => {
    await hydrate()
    bind()
    connection.setNotice('First notice')
    await vi.advanceTimersByTimeAsync(0)
    expect(native.write).not.toHaveBeenCalled()
    connection.setNotice('Second notice')
    connection.setDrawerOpen(true)
    connection.setHealth('http://bridge.local:3080', 'unavailable')
    await vi.advanceTimersByTimeAsync(0)
    expect(native.write).not.toHaveBeenCalled()
    expect(native.writeToken).not.toHaveBeenCalled()
    expect(native.deleteToken).not.toHaveBeenCalled()
  })

  it('stops syncing secure-store tokens when the returned disposer is called', async () => {
    await hydrate()
    const unsubscribe = bind()
    connection.setNotice('Initial')
    await vi.advanceTimersByTimeAsync(0)
    expect(native.writeToken).not.toHaveBeenCalled()
    unsubscribe()
    connection.accept({ ...alpha, token: 'after-dispose' })
    connection.markLoaded(connection.viewGeneration, 10)
    await vi.advanceTimersByTimeAsync(0)
    expect(native.write).toHaveBeenCalledExactlyOnceWith('dsh-bridge/connections', payload([{ ...alpha, lastConnectedAt: 10 }]))
    expect(native.writeToken).not.toHaveBeenCalled()
    expect(native.deleteToken).not.toHaveBeenCalled()
  })
})

describe('connection persistence failures', () => {
  it('reports a public snapshot write failure and permits a subsequent successful save', async () => {
    const error = new Error('Disk full')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    native.write.mockRejectedValueOnce(error)
    await restoreConnections()
    await vi.advanceTimersByTimeAsync(0)
    expect(log).toHaveBeenCalledExactlyOnceWith('[connection] save failed:', error)
    expect(connection.notice).toBe(storageFailure)
    bind()
    connection.accept({ ...alpha, token: 'secure-secret' })
    connection.markLoaded(connection.viewGeneration, 10)
    await vi.advanceTimersByTimeAsync(0)
    expect(native.write.mock.calls.map(call => [call[0], JSON.parse(call[1])])).toEqual([
      ['dsh-bridge/connections', { version: 1, history: [], guidedHosts: [] }],
      ['dsh-bridge/connections', { version: 1, history: [], guidedHosts: [] }],
      ['dsh-bridge/connections', { version: 1, history: [{ ...alpha, lastConnectedAt: 10 }], guidedHosts: [] }],
    ])
    expect(writtenPayloads()[2]).not.toContain('secure-secret')
    expect(native.deleteToken).not.toHaveBeenCalled()
  })

  it('writes the public snapshot independently of a failing secure-token save without leaking secrets', async () => {
    const error = new Error('Secure write refused')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    native.writeToken.mockRejectedValueOnce(error)
    await hydrate()
    bind()
    connection.accept({ ...alpha, token: 'secure-secret' })
    await vi.advanceTimersByTimeAsync(0)
    expect(log).toHaveBeenCalledExactlyOnceWith('[connection] token save failed:', error)
    expect(connection.notice).toBe(storageFailure)
    expect(native.writeToken.mock.calls).toEqual([[alphaKey, 'secure-secret'], [alphaKey, 'secure-secret']])
    expect(native.write).not.toHaveBeenCalled()
    connection.markLoaded(connection.viewGeneration, 10)
    await vi.advanceTimersByTimeAsync(0)
    expect(native.write).toHaveBeenCalledExactlyOnceWith('dsh-bridge/connections', payload([{ ...alpha, lastConnectedAt: 10 }]))
    expect(writtenPayloads()[0]).not.toContain('secure-secret')
  })

  it('reports a secure deletion failure and retries the eviction on the next persistence sync', async () => {
    const error = new Error('Secure delete refused')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    native.deleteToken.mockRejectedValueOnce(error)
    await hydrate({ version: 1, history: [{ ...alpha, lastConnectedAt: 10 }], guidedHosts: [] }, { 'http://bridge.local:3080': 'secure-secret' })
    bind()
    connection.$patch({ history: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(log).toHaveBeenCalledExactlyOnceWith('[connection] token save failed:', error)
    expect(connection.notice).toBe(storageFailure)
    expect(native.deleteToken.mock.calls).toEqual([[alphaKey], [alphaKey]])
    expect(native.write).toHaveBeenCalledExactlyOnceWith('dsh-bridge/connections', emptyPayload)
    expect(native.writeToken).not.toHaveBeenCalled()
    expect(native.write.mock.invocationCallOrder[0]).toBeLessThan(native.deleteToken.mock.invocationCallOrder[1]!)
  })
})
