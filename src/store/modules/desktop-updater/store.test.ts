import type { DesktopUpdateInfo } from './types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  toast: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))
vi.mock('i18next', () => ({ default: { t: (key: string) => key } }))
vi.mock('@/utils/toast', () => ({ toast: mocks.toast }))

const UPDATE: DesktopUpdateInfo = {
  version: '0.22.4',
  currentVersion: '0.22.3',
  tag: 'v0.22.4',
  published_at: '2026-10-08T00:00:00Z',
  url: 'https://example.test/v0.22.4',
  asset_name: 'desktop-installer.exe',
  path: 'C:/desktop-installer.exe',
  downloaded: true,
}

let desktopUpdater: (typeof import('./store'))['desktopUpdater']

beforeEach(async () => {
  vi.resetModules()
  mocks.invoke.mockReset()
  mocks.listen.mockReset().mockResolvedValue(() => {})
  mocks.toast.mockReset()
  ;({ desktopUpdater } = await import('./store'))
})

afterEach(() => {
  vi.restoreAllMocks()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('desktop updater operation coordination', () => {
  it('shares the final update result while a check is already in flight', async () => {
    const pending = deferred<DesktopUpdateInfo | null>()
    const stale = { ...UPDATE, version: '0.22.2', tag: 'v0.22.2' }
    desktopUpdater.updateInfo = stale
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'check_desktop_update')
        return pending.promise
      throw new Error(`Unexpected command: ${command}`)
    })

    const first = desktopUpdater.check()
    const second = desktopUpdater.check()

    expect(second).toBe(first)
    expect(desktopUpdater.checking).toBe(true)
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('check_desktop_update')
    pending.resolve(UPDATE)
    await expect(Promise.all([first, second])).resolves.toEqual([UPDATE, UPDATE])
    expect(desktopUpdater.updateInfo).toEqual(UPDATE)
    expect(desktopUpdater.checking).toBe(false)
  })

  it('shares a check failure with every caller and allows a later retry', async () => {
    const pending = deferred<DesktopUpdateInfo | null>()
    const failure = new Error('release service unavailable')
    mocks.invoke.mockImplementationOnce(() => pending.promise).mockResolvedValueOnce(null)

    const first = desktopUpdater.check()
    const second = desktopUpdater.check()
    const outcomes = Promise.allSettled([first, second])
    pending.reject(failure)

    await expect(outcomes).resolves.toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure },
    ])
    expect(desktopUpdater.checking).toBe(false)
    await expect(desktopUpdater.check()).resolves.toBeNull()
    expect(mocks.invoke).toHaveBeenCalledTimes(2)
  })

  it('refreshes native installer state when the release tag is unchanged', async () => {
    const download = deferred<DesktopUpdateInfo>()
    const refreshed = { ...UPDATE, path: 'C:/replacement-installer.exe', downloaded: false }
    desktopUpdater.updateInfo = { ...UPDATE, path: 'C:/removed-installer.exe' }
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'check_desktop_update')
        return Promise.resolve(refreshed)
      if (command === 'download_desktop_update')
        return download.promise
      throw new Error(`Unexpected command: ${command}`)
    })

    await expect(desktopUpdater.check()).resolves.toEqual(refreshed)
    expect(desktopUpdater.updateInfo).toEqual(refreshed)
    expect(mocks.invoke).toHaveBeenCalledWith('download_desktop_update')
    download.resolve({ ...refreshed, downloaded: true })
    await vi.waitFor(() => {
      expect(desktopUpdater.updateInfo).toEqual({ ...refreshed, downloaded: true })
    })
  })

  it('downloads and opens an installer only once for simultaneous actions', async () => {
    const download = deferred<DesktopUpdateInfo>()
    const open = deferred<void>()
    desktopUpdater.updateInfo = { ...UPDATE, downloaded: false }
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'download_desktop_update')
        return download.promise
      if (command === 'open_desktop_installer')
        return open.promise
      throw new Error(`Unexpected command: ${command}`)
    })

    const first = desktopUpdater.downloadAndOpen()
    const second = desktopUpdater.downloadAndOpen()

    expect(second).toBe(first)
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('download_desktop_update')
    download.resolve(UPDATE)
    await vi.waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('open_desktop_installer', { path: UPDATE.path })
    })
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'open_desktop_installer')).toHaveLength(1)
    open.resolve()
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith('update.desktop_opened', {
      variant: 'default',
      placement: 'bottom end',
    })
  })

  it('reuses a background download before opening the installer', async () => {
    const download = deferred<DesktopUpdateInfo>()
    const open = deferred<void>()
    desktopUpdater.updateInfo = { ...UPDATE, downloaded: false }
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'download_desktop_update')
        return download.promise
      if (command === 'open_desktop_installer')
        return open.promise
      throw new Error(`Unexpected command: ${command}`)
    })

    const background = desktopUpdater.download()
    const first = desktopUpdater.downloadAndOpen()
    const second = desktopUpdater.downloadAndOpen()

    expect(second).toBe(first)
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('download_desktop_update')
    download.resolve(UPDATE)
    await vi.waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('open_desktop_installer', { path: UPDATE.path })
    })
    open.resolve()
    await expect(Promise.all([background, first, second])).resolves.toEqual([undefined, true, true])
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'download_desktop_update')).toHaveLength(1)
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'open_desktop_installer')).toHaveLength(1)
  })

  it('opens an existing installer only once for simultaneous actions', async () => {
    const open = deferred<void>()
    desktopUpdater.updateInfo = UPDATE
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'open_desktop_installer')
        return open.promise
      throw new Error(`Unexpected command: ${command}`)
    })

    const first = desktopUpdater.downloadAndOpen()
    const second = desktopUpdater.downloadAndOpen()

    expect(second).toBe(first)
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('open_desktop_installer', { path: UPDATE.path })
    open.resolve()
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
  })

  it('reports an installer launch failure and permits a retry', async () => {
    const failure = new Error('shell rejected installer')
    desktopUpdater.updateInfo = UPDATE
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.invoke.mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined)

    await expect(desktopUpdater.downloadAndOpen()).resolves.toBe(false)
    expect(mocks.toast).toHaveBeenCalledWith('update.desktop_open_failed', {
      variant: 'danger',
      placement: 'bottom end',
    })
    await expect(desktopUpdater.downloadAndOpen()).resolves.toBe(true)
    expect(mocks.invoke).toHaveBeenCalledTimes(2)
  })

  it('does not invoke native update actions when no update is available', async () => {
    desktopUpdater.updateInfo = null

    await expect(desktopUpdater.downloadAndOpen()).resolves.toBe(false)
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('does not open an installer after a failed download', async () => {
    desktopUpdater.updateInfo = { ...UPDATE, downloaded: false }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.invoke.mockRejectedValueOnce(new Error('download interrupted'))

    await expect(desktopUpdater.downloadAndOpen()).resolves.toBe(false)
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('download_desktop_update')
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith('update.desktop_download_failed', {
      variant: 'danger',
      placement: 'bottom end',
    })
  })

  it('retries a failed download before opening the installer', async () => {
    desktopUpdater.updateInfo = { ...UPDATE, downloaded: false }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.invoke
      .mockRejectedValueOnce(new Error('download interrupted'))
      .mockResolvedValueOnce(UPDATE)
      .mockResolvedValueOnce(undefined)

    await expect(desktopUpdater.downloadAndOpen()).resolves.toBe(false)
    await expect(desktopUpdater.downloadAndOpen()).resolves.toBe(true)
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'download_desktop_update')).toHaveLength(2)
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'open_desktop_installer')).toEqual([
      ['open_desktop_installer', { path: UPDATE.path }],
    ])
  })
})
