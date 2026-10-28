import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  saved: {} as Record<string, unknown>,
  listeners: new Set<(event: { payload: Record<string, unknown> }) => Promise<void>>(),
  invoke: vi.fn(),
  setItem: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event, callback) => {
    mocks.listeners.add(callback)
    return () => mocks.listeners.delete(callback)
  }),
}))
vi.mock('@/config/storage', () => ({
  storage: {
    getItem: async () => JSON.stringify(mocks.saved),
    setItem: mocks.setItem,
  },
}))

let setting: (typeof import('./store'))['setting']

beforeEach(async () => {
  vi.resetModules()
  mocks.saved = {
    appearance: { palette: 'default', terminal: false, transparency: false, opacity: 100, blur: false, sidebarOnly: false },
    zoom_factor: 1,
    backup_include_credentials: true,
  }
  mocks.setItem.mockImplementation(async (_key: string, value: string) => {
    mocks.saved = JSON.parse(value)
  })
  mocks.invoke.mockImplementation(async (command, update) => {
    if (command === 'update_app_config') {
      if (update.appearance !== undefined)
        mocks.saved.appearance = structuredClone(update.appearance)
      if (update.zoomFactor !== undefined)
        mocks.saved.zoom_factor = update.zoomFactor
    }
    else if (command !== 'get_app_config') {
      throw new Error(`Unexpected command: ${command}`)
    }
    return structuredClone(mocks.saved)
  })
  ;({ setting } = await import('./store'))
})

afterEach(() => {
  mocks.listeners.clear()
  vi.resetAllMocks()
})

async function nativeUpdate(value: Record<string, unknown>) {
  mocks.saved = structuredClone(value)
  await Promise.all([...mocks.listeners].map(callback => callback({ payload: structuredClone(value) })))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('settings synchronization across windows', () => {
  it('applies native settings updates after initial hydration', async () => {
    await nativeUpdate(mocks.saved)
    await nativeUpdate({ ...mocks.saved, appearance: { palette: 'amber', terminal: true, opacity: 80 } })
    expect(setting.appearance).toEqual({ palette: 'amber', terminal: true, opacity: 80 })
  })

  it('keeps another window’s appearance when a local zoom change is saved', async () => {
    await nativeUpdate(mocks.saved)
    await nativeUpdate({ ...mocks.saved, appearance: { palette: 'nord', terminal: false, opacity: 78 } })
    await setting.zoom('increase')
    expect(mocks.invoke).toHaveBeenCalledWith('update_app_config', { zoomFactor: 1.1 })
    expect(mocks.saved.zoom_factor).toBe(1.1)
    expect(mocks.saved.appearance).toEqual({ palette: 'nord', terminal: false, opacity: 78 })
    expect(mocks.setItem).not.toHaveBeenCalled()
  })

  it('preserves a newer credential-backup opt-out after an older appearance response', async () => {
    await nativeUpdate(mocks.saved)
    const olderResponse = deferred<Record<string, unknown>>()
    mocks.invoke.mockImplementationOnce(() => olderResponse.promise)
    const appearance = { ...setting.appearance, palette: 'github-high-contrast' as const }
    const pending = setting.update({ appearance })
    expect(mocks.invoke).toHaveBeenCalledWith('update_app_config', { appearance })
    const olderSnapshot = { ...mocks.saved, appearance }
    await nativeUpdate(olderSnapshot)
    await nativeUpdate({ ...olderSnapshot, backup_include_credentials: false })
    expect(setting.backup_include_credentials).toBe(false)
    olderResponse.resolve(olderSnapshot)
    await pending
    expect(setting.backup_include_credentials).toBe(false)
    expect(mocks.saved.backup_include_credentials).toBe(false)
    expect(setting.appearance.palette).toBe('github-high-contrast')
    expect(mocks.setItem).not.toHaveBeenCalled()
  })

  it('reads current native settings when an older event arrives late', async () => {
    const olderSnapshot = structuredClone(mocks.saved)
    await nativeUpdate({ ...mocks.saved, backup_include_credentials: false })
    await Promise.all([...mocks.listeners].map(callback => callback({ payload: olderSnapshot })))
    expect(setting.backup_include_credentials).toBe(false)
    expect(mocks.saved.backup_include_credentials).toBe(false)
    expect(mocks.setItem).not.toHaveBeenCalled()
  })

  it.each(['older first', 'newer first'])('discards superseded reads when responses arrive %s', async (order) => {
    await nativeUpdate(mocks.saved)
    const older = deferred<Record<string, unknown>>()
    const newer = deferred<Record<string, unknown>>()
    mocks.invoke.mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise)
    let initialRefreshFinished = false
    const initial = setting.refresh().then(() => {
      initialRefreshFinished = true
    })
    const latest = setting.refresh()
    const latestSnapshot = { ...mocks.saved, installed: true, backup_include_credentials: false }
    if (order === 'older first') {
      older.resolve({ ...mocks.saved, installed: false })
      await Promise.resolve()
      expect(initialRefreshFinished).toBe(false)
      newer.resolve(latestSnapshot)
    }
    else {
      newer.resolve(latestSnapshot)
      await latest
      older.resolve({ ...mocks.saved, installed: false })
    }
    await Promise.all([initial, latest])
    expect(setting.installed).toBe(true)
    expect(setting.backup_include_credentials).toBe(false)
    expect(mocks.setItem).not.toHaveBeenCalled()
  })

  it('refreshes a saved appearance even when no native event is delivered', async () => {
    await nativeUpdate(mocks.saved)
    const appearance = { ...setting.appearance, palette: 'github' as const }
    await setting.update({ appearance })
    expect(setting.appearance.palette).toBe('github')
    expect(mocks.saved.appearance).toEqual(appearance)
    expect(mocks.setItem).not.toHaveBeenCalled()
  })

  it('keeps the last settings when a native read fails', async () => {
    await nativeUpdate({ ...mocks.saved, backup_include_credentials: false })
    mocks.invoke.mockRejectedValueOnce(new Error('native read failed'))
    await expect(setting.refresh()).rejects.toThrow('native read failed')
    expect(setting.backup_include_credentials).toBe(false)
    expect(mocks.setItem).not.toHaveBeenCalled()
  })

  it('rejects a failed save without applying or persisting its proposed appearance', async () => {
    await nativeUpdate(mocks.saved)
    mocks.invoke.mockRejectedValueOnce(new Error('native write failed'))
    await expect(setting.update({ appearance: { ...setting.appearance, palette: 'github' } })).rejects.toThrow('native write failed')
    expect(setting.appearance.palette).toBe('default')
    expect(mocks.saved.appearance).toEqual({ palette: 'default', terminal: false, transparency: false, opacity: 100, blur: false, sidebarOnly: false })
    expect(mocks.setItem).not.toHaveBeenCalled()
  })

  it('persists consecutive zoom shortcuts without dropping an increment', async () => {
    await nativeUpdate({ ...mocks.saved, backup_include_credentials: false })
    await Promise.all([setting.zoom('increase'), setting.zoom('increase')])
    expect(setting.zoom_factor).toBe(1.2)
    expect(mocks.saved.zoom_factor).toBe(1.2)
    expect(mocks.saved.backup_include_credentials).toBe(false)
    expect(mocks.setItem).not.toHaveBeenCalled()
  })

  it('accepts the next zoom shortcut after a rejected save', async () => {
    await nativeUpdate(mocks.saved)
    mocks.invoke.mockRejectedValueOnce(new Error('native write failed'))
    await expect(setting.zoom('increase')).rejects.toThrow('native write failed')
    await setting.zoom('increase')
    expect(setting.zoom_factor).toBe(1.1)
    expect(mocks.saved.zoom_factor).toBe(1.1)
  })

  it.each([['decrease', 1.4], ['reset', 1]] as const)('persists the %s zoom shortcut', async (action, expected) => {
    await nativeUpdate({ ...mocks.saved, zoom_factor: 1.5 })
    await setting.zoom(action)
    expect(setting.zoom_factor).toBe(expected)
    expect(mocks.saved.zoom_factor).toBe(expected)
  })
})
