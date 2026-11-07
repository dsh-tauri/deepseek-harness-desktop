// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isFullSidebarWindow } from '@/utils/window-presentation'
import { FullSidebarNavbar } from './full-sidebar-navbar'

const { native } = vi.hoisted(() => ({ native: vi.fn<(command: string, args?: Record<string, unknown>) => unknown>() }))

vi.mock('@/store', () => ({ store: { desktopUpdater: { updateInfo: null }, setting: { zoom: vi.fn() } } }))
vi.mock('valtio-define', () => ({ useStore: (value: unknown) => value }))
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: [] }),
  useQueryClient: () => ({ ensureQueryData: () => Promise.resolve('dsh-tauri') }),
}))
vi.mock('@overlastic/react', () => ({ useOverlay: () => vi.fn() }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('i18next', () => ({ default: { t: (key: string) => key } }))
vi.mock('@/hooks/use-dsh-style', () => ({ useDshStyle: () => [{ sidebar: { background: 'rgb(10, 20, 30)' } }] }))
vi.mock('@/ui/dialog/about', () => ({ DesktopAboutDialog: () => null }))
vi.mock('@/ui/dialog/config', () => ({ ConfigDialog: () => null }))
vi.mock('@/ui/dialog/task-manager', () => ({ TaskManagerDialog: () => null }))
vi.mock('@/ui/dialog/update', () => ({ DesktopUpdateDialog: () => null }))
vi.mock('@/utils/toast', () => ({ toast: vi.fn<(title: string, options?: { description?: ReactNode }) => void>() }))
vi.mock('./remote-switcher', () => ({ RemoteSwitcher: () => null }))
vi.mock('./remote-share', () => ({ RemoteShare: () => null }))

beforeEach(() => {
  native.mockReset().mockImplementation((command) => {
    switch (command) {
      case 'plugin:event|listen':
        return 1
      case 'plugin:window|is_maximized':
        return false
      default:
        return undefined
    }
  })
  mockIPC((command, args) => native(command, args as Record<string, unknown> | undefined))
  mockWindows('window-2')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete (globalThis as Record<string, unknown>).__DSH_NAVIGATION__
})

describe('fullSidebarNavbar', () => {
  it('只留不可交互的布局标记与窗口控制，没有侧栏开关、菜单与远程切换', () => {
    render(<FullSidebarNavbar />)

    const navbar = screen.getByTestId('dsh-full-sidebar-navbar-root')
    expect(navbar.style.background).toBe('rgb(10, 20, 30)')
    expect(screen.getByTestId('dsh-full-sidebar-navbar-mark').getAttribute('aria-hidden')).toBe('true')
    expect(screen.queryByTestId('dsh-navbar-sidebar-toggle')).toBeNull()
    expect(screen.queryByTestId('dsh-navbar-menu-file')).toBeNull()
    expect(screen.queryByTestId('dsh-navbar-menu-view')).toBeNull()
    expect(screen.queryByTestId('dsh-navbar-menu-help')).toBeNull()
    expect(screen.queryByTestId('dsh-navbar-dev-chip')).toBeNull()
    expect(screen.getByLabelText('nav.minimize')).toBeTruthy()
  })

  it('只有带 presentation=full-sidebar 的注入载荷才算全屏右栏窗口', () => {
    expect(isFullSidebarWindow()).toBe(false)

    ;(globalThis as Record<string, unknown>).__DSH_NAVIGATION__ = { sessionId: 'session-1' }
    expect(isFullSidebarWindow()).toBe(false)

    ;(globalThis as Record<string, unknown>).__DSH_NAVIGATION__ = { sessionId: 'session-1', presentation: 'full-sidebar' }
    expect(isFullSidebarWindow()).toBe(true)
  })

  it('最大化状态按原生窗口回报切换字形', async () => {
    native.mockImplementation((command) => {
      switch (command) {
        case 'plugin:event|listen':
          return 1
        case 'plugin:window|is_maximized':
          return true
        default:
          return undefined
      }
    })
    render(<FullSidebarNavbar />)

    await waitFor(() => expect(screen.getByLabelText('nav.restore')).toBeTruthy())
  })
})
