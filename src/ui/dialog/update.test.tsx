// @vitest-environment jsdom
import { OverlaysProvider, useOverlay } from '@overlastic/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopUpdateDialog } from './update'

const { desktopUpdater } = vi.hoisted(() => ({
  desktopUpdater: {
    updateInfo: null as null | { currentVersion: string, version: string, tag: string, downloaded: boolean, path: string },
    downloading: false,
    downloadProgress: 0,
    downloadAndOpen: vi.fn(),
  },
}))

vi.mock('@/store', () => ({ store: { desktopUpdater } }))
vi.mock('valtio-define', () => ({ useStore: (value: unknown) => value }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

function Launcher() {
  const open = useOverlay(DesktopUpdateDialog)
  function handleOpen() {
    void open().catch(() => {})
  }
  return <button onClick={handleOpen}>Open update</button>
}

let client: QueryClient

function openDialog() {
  render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <OverlaysProvider><Launcher /></OverlaysProvider>
      </QueryClientProvider>
    </StrictMode>,
  )
  fireEvent.click(screen.getByText('Open update'))
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  desktopUpdater.updateInfo = {
    currentVersion: '0.21.1',
    version: '0.21.2',
    tag: 'v0.21.2',
    downloaded: false,
    path: 'C:/installer.exe',
  }
  desktopUpdater.downloading = false
  desktopUpdater.downloadProgress = 0
  desktopUpdater.downloadAndOpen.mockReset()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('desktop update dialog', () => {
  it('hides the footer actions while downloading and keeps the progress visible', async () => {
    desktopUpdater.downloading = true
    desktopUpdater.downloadProgress = 42
    openDialog()
    await screen.findByText('update.desktop_downloading')
    expect(screen.queryByRole('button', { name: 'update.later' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'update.now' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'update.open_installer' })).toBeNull()
  })

  it('offers the download action once no download is in flight', async () => {
    openDialog()
    expect((await screen.findByRole('button', { name: 'update.now' })).textContent).toBe('update.now')
    expect(screen.queryByRole('button', { name: 'update.later' })).not.toBeNull()
  })

  it('offers the installer action once the package is downloaded', async () => {
    desktopUpdater.updateInfo!.downloaded = true
    openDialog()
    expect((await screen.findByRole('button', { name: 'update.open_installer' })).textContent).toBe('update.open_installer')
  })

  it('closes after an existing installer is opened successfully', async () => {
    desktopUpdater.updateInfo!.downloaded = true
    desktopUpdater.downloadAndOpen.mockResolvedValue(true)
    openDialog()
    fireEvent.click(await screen.findByRole('button', { name: 'update.open_installer' }))
    await vi.waitFor(() => {
      expect(screen.queryByRole('button', { name: 'update.open_installer' })).toBeNull()
    })
    expect(desktopUpdater.downloadAndOpen).toHaveBeenCalledOnce()
  })

  it('keeps the dialog open when the installer cannot be opened', async () => {
    desktopUpdater.updateInfo!.downloaded = true
    desktopUpdater.downloadAndOpen.mockResolvedValue(false)
    openDialog()
    fireEvent.click(await screen.findByRole('button', { name: 'update.open_installer' }))
    await vi.waitFor(() => {
      expect(desktopUpdater.downloadAndOpen).toHaveBeenCalledOnce()
    })
    expect(screen.queryByRole('button', { name: 'update.open_installer' })).not.toBeNull()
  })

  it('disables the primary action while installer handoff is pending', async () => {
    let finish!: (opened: boolean) => void
    const pending = new Promise<boolean>((resolve) => {
      finish = resolve
    })
    desktopUpdater.updateInfo!.downloaded = true
    desktopUpdater.downloadAndOpen.mockReturnValue(pending)
    openDialog()
    const primary = await screen.findByRole<HTMLButtonElement>('button', { name: 'update.open_installer' })
    fireEvent.click(primary)
    await vi.waitFor(() => {
      expect(primary.disabled).toBe(true)
    })
    finish(false)
    await vi.waitFor(() => {
      expect(primary.disabled).toBe(false)
    })
  })
})
