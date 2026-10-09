// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Navbar } from './navbar'

const { userAgent, openUrl, writeText, toast, toggleDevtools } = vi.hoisted(() => {
  const userAgent = navigator.userAgent
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Windows' })
  return {
    userAgent,
    openUrl: vi.fn<(args: { url: string }) => Promise<void>>(),
    writeText: vi.fn<(args: { text: string }) => Promise<void>>(),
    toggleDevtools: vi.fn<() => Promise<void>>(),
    toast: vi.fn<(title: string, options?: {
      variant?: string
      description?: ReactNode
      actionProps?: { children: string, onPress: () => void }
    }) => void>(),
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
vi.mock('@/utils/toast', () => ({ toast }))
vi.mock('./remote-switcher', () => ({ RemoteSwitcher: () => null }))

const HELP_DESTINATIONS = [
  ['documentation', 'https://dshtauri.mintlify.site'],
  ['desktop-feedback', 'https://github.com/dsh-tauri/deepseek-harness-desktop/issues'],
  ['harness-feedback', 'https://trtgsjkv6r.feishu.cn/share/base/form/shrcnlCoGElW7MQznGy9r3YYXcg?hide_uid=1&hide_device_info=1&hide_harness_version=1'],
] as const

async function selectHelpLink(id: string) {
  render(<Navbar onRemoteChange={vi.fn()} />)
  fireEvent.click(screen.getByTestId('dsh-navbar-menu-help'))
  fireEvent.click(await screen.findByTestId(`dsh-navbar-item-${id}`))
}

beforeEach(() => {
  vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/[^\w-]/g, character => `\\${character}`) })
  openUrl.mockReset().mockResolvedValue(undefined)
  writeText.mockReset().mockResolvedValue(undefined)
  toggleDevtools.mockReset().mockResolvedValue(undefined)
  toast.mockClear()
  mockWindows('main')
  mockIPC((command, args) => {
    switch (command) {
      case 'open_external_url':
        return openUrl(args as { url: string })
      case 'write_clipboard_text':
        return writeText(args as { text: string })
      case 'toggle_devtools':
        return toggleDevtools()
      case 'plugin:event|listen':
        return (args as { handler: number }).handler
      case 'plugin:event|unlisten':
      case 'sync_view_menu':
        return
      case 'plugin:window|is_maximized':
        return false
      default:
        throw new Error(`Unexpected native command: ${command}`)
    }
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

afterAll(() => {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent })
})

describe('help menu links', () => {
  it.each(HELP_DESTINATIONS)('opens the %s destination from the dropdown', async (id, url) => {
    await selectHelpLink(id)
    await waitFor(() => expect(openUrl).toHaveBeenCalledExactlyOnceWith({ url }))
    expect(toast).not.toHaveBeenCalled()
  })

  it.each(HELP_DESTINATIONS)('offers a copy action when opening %s fails', async (id, url) => {
    const failure = new Error('browser unavailable')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    openUrl.mockRejectedValue(failure)

    await selectHelpLink(id)

    await waitFor(() => expect(toast).toHaveBeenCalledExactlyOnceWith('messages.open_link_failed', expect.objectContaining({
      variant: 'danger',
      description: expect.any(Object),
      actionProps: { children: 'buttons.copy_link', onPress: expect.any(Function) },
    })))
    render(<>{toast.mock.calls[0]![1]!.description}</>)
    expect(screen.getByText(url).textContent).toBe(url)
    expect(log).toHaveBeenCalledExactlyOnceWith(`[Navbar] failed to open ${id}:`, failure)
  })

  it.each(HELP_DESTINATIONS)('copies the failed %s destination through the native clipboard', async (id, url) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    openUrl.mockRejectedValue(new Error('browser unavailable'))
    await selectHelpLink(id)
    await waitFor(() => expect(toast).toHaveBeenCalledOnce())

    await act(async () => toast.mock.calls[0]![1]!.actionProps!.onPress())

    await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith({ text: url }))
    expect(toast.mock.calls.map(([title]) => title)).toEqual(['messages.open_link_failed', 'messages.copy_success'])
  })

  it('toggles the developer tools from the item above the task manager', async () => {
    render(<Navbar onRemoteChange={vi.fn()} />)
    fireEvent.click(screen.getByTestId('dsh-navbar-menu-help'))
    const devtools = await screen.findByTestId('dsh-navbar-item-toggle-devtools')
    const taskManager = screen.getByTestId('dsh-navbar-item-task-manager')
    expect(devtools.compareDocumentPosition(taskManager) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    fireEvent.click(devtools)

    await waitFor(() => expect(toggleDevtools).toHaveBeenCalledExactlyOnceWith())
    expect(toast).not.toHaveBeenCalled()
  })

  it('reports a developer tools failure once', async () => {
    const failure = new Error('devtools unavailable')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    toggleDevtools.mockRejectedValue(failure)

    render(<Navbar onRemoteChange={vi.fn()} />)
    fireEvent.click(screen.getByTestId('dsh-navbar-menu-help'))
    fireEvent.click(await screen.findByTestId('dsh-navbar-item-toggle-devtools'))

    await waitFor(() => expect(log).toHaveBeenCalledExactlyOnceWith('[Navbar] failed to toggle devtools:', failure))
    expect(toast).not.toHaveBeenCalled()
  })

  it('reports a clipboard failure once when copying a failed feedback link', async () => {
    const failure = new Error('clipboard unavailable')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    openUrl.mockRejectedValue(new Error('browser unavailable'))
    writeText.mockRejectedValue(failure)
    await selectHelpLink('desktop-feedback')
    await waitFor(() => expect(toast).toHaveBeenCalledOnce())

    await act(async () => toast.mock.calls[0]![1]!.actionProps!.onPress())

    await waitFor(() => expect(log).toHaveBeenLastCalledWith('[Navbar] failed to copy help link:', failure))
    expect(toast.mock.calls.map(([title]) => title)).toEqual(['messages.open_link_failed', 'messages.clipboard_failed'])
    expect(toast).toHaveBeenLastCalledWith('messages.clipboard_failed', { variant: 'danger' })
  })
})
