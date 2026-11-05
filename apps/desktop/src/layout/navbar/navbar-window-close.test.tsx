// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Navbar } from './navbar'

const { userAgent, native, toggleDevtools } = vi.hoisted(() => {
  const userAgent = navigator.userAgent
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Windows' })
  return {
    userAgent,
    native: vi.fn<(command: string, args?: Record<string, unknown>) => unknown>(),
    toggleDevtools: vi.fn<() => Promise<void>>(),
  }
})

vi.mock('@/store', () => ({ store: { desktopUpdater: { updateInfo: null }, setting: { zoom: vi.fn() } } }))
vi.mock('valtio-define', () => ({ useStore: (value: unknown) => value }))
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: [] }),
  useQueryClient: () => ({ ensureQueryData: () => Promise.resolve('dsh-tauri') }),
}))
vi.mock('@overlastic/react', () => ({ useOverlay: () => vi.fn() }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('i18next', () => ({ default: { t: (key: string) => key } }))
vi.mock('@/hooks/use-dsh-style', () => ({ useDshStyle: () => [{}] }))
vi.mock('@/ui/dialog/about', () => ({ DesktopAboutDialog: () => null }))
vi.mock('@/ui/dialog/config', () => ({ ConfigDialog: () => null }))
vi.mock('@/ui/dialog/task-manager', () => ({ TaskManagerDialog: () => null }))
vi.mock('@/ui/dialog/update', () => ({ DesktopUpdateDialog: () => null }))
vi.mock('@/utils/toast', () => ({ toast: vi.fn<(title: string, options?: { description?: ReactNode }) => void>() }))
vi.mock('@/layout/remote/switcher', () => ({ RemoteSwitcher: () => null }))
vi.mock('@/layout/remote/share', () => ({ RemoteShare: () => null }))

beforeEach(() => {
  vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/[^\w-]/g, character => `\\${character}`) })
  toggleDevtools.mockReset().mockResolvedValue(undefined)
  native.mockReset().mockImplementation((command) => {
    switch (command) {
      case 'plugin:event|listen':
        return 1
      case 'plugin:event|unlisten':
      case 'plugin:window|is_maximized':
      case 'sync_view_menu':
        return command === 'plugin:window|is_maximized' ? false : undefined
      case 'toggle_devtools':
        return toggleDevtools()
      default:
        return undefined
    }
  })
  mockIPC((command, args) => native(command, args as Record<string, unknown> | undefined))
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

afterAll(() => {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent })
})

describe('navbar window close', () => {
  it.each(['window-2', 'remote-2'])('closes the %s attached window instead of hiding it', async (label) => {
    mockWindows(label)
    render(<Navbar onRemoteChange={vi.fn()} />)

    fireEvent.click(screen.getByLabelText('nav.close'))

    await waitFor(() => expect(native).toHaveBeenCalledWith('plugin:window|close', expect.objectContaining({ label })))
    expect(native).not.toHaveBeenCalledWith('plugin:window|hide', expect.anything())
  })

  it('hides the main window when its background button is clicked without requesting close', async () => {
    mockWindows('main')
    render(<Navbar onRemoteChange={vi.fn()} />)

    fireEvent.click(screen.getByLabelText('nav.background'))

    await waitFor(() => expect(native).toHaveBeenCalledWith('plugin:window|hide', expect.objectContaining({ label: 'main' })))
    expect(native).not.toHaveBeenCalledWith('plugin:window|close', expect.anything())
  })

  it.each(['main', 'window-2', 'remote-2'])('routes the File close action for %s to the matching native operation', async (label) => {
    mockWindows(label)
    render(<Navbar onRemoteChange={vi.fn()} />)

    fireEvent.click(screen.getByTestId('dsh-navbar-menu-file'))
    fireEvent.click(await screen.findByTestId('dsh-navbar-item-close'))

    const command = label === 'main' ? 'plugin:window|hide' : 'plugin:window|close'
    const otherCommand = label === 'main' ? 'plugin:window|close' : 'plugin:window|hide'
    await waitFor(() => expect(native).toHaveBeenCalledWith(command, expect.objectContaining({ label })))
    expect(native).not.toHaveBeenCalledWith(otherCommand, expect.anything())
  })

  it.each(['main', 'window-2', 'remote-2'])('marks %s as a child window only when it is not the main window', (label) => {
    mockWindows(label)
    render(<Navbar onRemoteChange={vi.fn()} />)

    const chip = screen.queryByTestId('dsh-navbar-child-window-chip')
    if (label === 'main')
      expect(chip).toBeNull()
    else
      expect(chip?.textContent).toBe('navbar.child_window')
  })

  it('keeps the main window close labeled as backgrounding to the tray', () => {
    mockWindows('main')
    render(<Navbar onRemoteChange={vi.fn()} />)

    expect(screen.getByLabelText('nav.background')).toBeTruthy()
    expect(screen.queryByLabelText('nav.close')).toBeNull()
  })
})
