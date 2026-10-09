// @vitest-environment jsdom
import type { i18n as I18n } from 'i18next'
import { OverlaysProvider } from '@overlastic/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { getIdentifier } from '@tauri-apps/api/app'
import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createInstance } from 'i18next'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '../src/config/query-keys'
import enUS from '../src/i18n/locales/en-US.json'
import zhCN from '../src/i18n/locales/zh-CN.json'
import { Navbar } from '../src/layout/components/navbar'
import { desktopUpdater } from '../src/store/modules/desktop-updater'

vi.mock('@/store', async () => ({
  store: { desktopUpdater: (await import('../src/store/modules/desktop-updater')).desktopUpdater },
}))
vi.mock('@/layout/components/remote-switcher', () => ({
  RemoteSwitcher: function RemoteSwitcher() { return null },
}))
vi.mock('@/ui/dialog/config', () => ({
  ConfigDialog: function ConfigDialog() { return null },
}))
vi.mock('@/ui/dialog/task-manager', () => ({
  TaskManagerDialog: function TaskManagerDialog() { return null },
}))
vi.mock('@/ui/dialog/about', () => ({
  DesktopAboutDialog: function DesktopAboutDialog() { return null },
}))
vi.mock('@/ui/dialog/update', () => ({
  DesktopUpdateDialog: function DesktopUpdateDialog() {
    return createElement('div', { 'data-testid': 'navbar-test-update-dialog' })
  },
}))

const UPDATE_INFO = {
  version: '0.23.0',
  currentVersion: '0.22.4',
  tag: 'v0.23.0',
  published_at: '2026-10-08T00:00:00Z',
  url: 'https://example.invalid/update.exe',
  asset_name: 'update.exe',
  path: '',
  downloaded: false,
}
const getAppIdentifier = vi.fn<() => Promise<string>>()
const openExternalUrl = vi.fn()
const checkDesktopUpdate = vi.fn()
let client: QueryClient
let i18n: I18n

function renderNavbar() {
  return render(createElement(
    QueryClientProvider,
    { client },
    createElement(
      I18nextProvider,
      { i18n },
      createElement(OverlaysProvider, null, createElement(Navbar, { onRemoteChange: vi.fn() })),
    ),
  ))
}

beforeEach(async () => {
  vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/[^\w-]/g, character => `\\${character}`) })
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  i18n = createInstance()
  await i18n.init({
    lng: 'zh-CN',
    fallbackLng: false,
    resources: { 'zh-CN': { translation: zhCN }, 'en-US': { translation: enUS } },
    interpolation: { escapeValue: false },
  })
  desktopUpdater.updateInfo = null
  getAppIdentifier.mockReset().mockResolvedValue('dsh-tauri')
  openExternalUrl.mockReset()
  checkDesktopUpdate.mockReset().mockResolvedValue(null)
  mockWindows('main')
  mockIPC((command, args) => {
    if (command === 'plugin:app|identifier')
      return getAppIdentifier()
    if (command === 'open_external_url')
      return openExternalUrl(args)
    if (command === 'check_desktop_update')
      return checkDesktopUpdate()
    if (command === 'get_dsh_plugins')
      return []
    if (command === 'plugin:window|is_maximized')
      return false
    throw new Error(`UNEXPECTED_IPC: ${command}`)
  }, { shouldMockEvents: true })
})

afterEach(async () => {
  await act(async () => {
    cleanup()
  })
  client.clear()
  desktopUpdater.updateInfo = null
  clearMocks()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('navbar build channel', () => {
  it.each(['dsh-tauri', 'dsh-tauri-nightly'])('waits for a pending identifier before checking updates for %s', async (identifier) => {
    const pending = Promise.withResolvers<string>()
    getAppIdentifier.mockReturnValue(pending.promise)
    const check = checkDesktopUpdate
    renderNavbar()
    fireEvent.click(await screen.findByTestId('dsh-navbar-menu-help'))
    fireEvent.click(await screen.findByTestId('dsh-navbar-item-check-update'))
    expect(check).not.toHaveBeenCalled()
    expect(openExternalUrl).not.toHaveBeenCalled()

    await act(async () => pending.resolve(identifier))
    if (identifier === 'dsh-tauri-nightly') {
      await waitFor(() => expect(openExternalUrl).toHaveBeenCalledOnce())
      expect(check).not.toHaveBeenCalled()
    }
    else {
      await waitFor(() => expect(check).toHaveBeenCalledOnce())
      expect(openExternalUrl).not.toHaveBeenCalled()
    }
    expect(getAppIdentifier).toHaveBeenCalledOnce()
  })

  it('does not guess the update channel when a pending identifier lookup fails', async () => {
    const pending = Promise.withResolvers<string>()
    getAppIdentifier.mockReturnValue(pending.promise)
    const check = checkDesktopUpdate
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    renderNavbar()
    fireEvent.click(await screen.findByTestId('dsh-navbar-menu-help'))
    fireEvent.click(await screen.findByTestId('dsh-navbar-item-check-update'))
    await act(async () => pending.reject(new Error('IDENTIFIER_FAILED')))
    await waitFor(() => expect(warning).toHaveBeenCalledWith('[Navbar] check update failed:', expect.any(Error)))
    expect(check).not.toHaveBeenCalled()
    expect(openExternalUrl).not.toHaveBeenCalled()
  })

  it('opens the nightly release page instead of checking for a stable installer', async () => {
    getAppIdentifier.mockResolvedValue('dsh-tauri-nightly')
    const check = checkDesktopUpdate
    await client.prefetchQuery({ queryKey: queryKeys.appIdentifier, queryFn: getIdentifier })
    renderNavbar()
    fireEvent.click(await screen.findByTestId('dsh-navbar-menu-help'))
    fireEvent.click(await screen.findByTestId('dsh-navbar-item-check-update'))
    await waitFor(() => expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith({ url: 'https://github.com/dsh-tauri/deepseek-harness-desktop/releases/tag/nightly' }))
    expect(check).not.toHaveBeenCalled()
    expect(screen.queryByTestId('navbar-test-update-dialog')).toBeNull()
  })

  it.each([
    { language: 'zh-CN', label: '夜间构建版本', updateLabel: '更新可用', updateInfo: null },
    { language: 'zh-CN', label: '夜间构建版本', updateLabel: '更新可用', updateInfo: UPDATE_INFO },
    { language: 'en-US', label: 'Nightly build', updateLabel: 'Update available', updateInfo: UPDATE_INFO },
  ])('nightly renders an inert accent chip in $language with updateInfo=$updateInfo', async ({ language, label, updateLabel, updateInfo }) => {
    getAppIdentifier.mockResolvedValue('dsh-tauri-nightly')
    desktopUpdater.updateInfo = updateInfo
    await i18n.changeLanguage(language)
    await client.prefetchQuery({ queryKey: queryKeys.appIdentifier, queryFn: getIdentifier })
    renderNavbar()

    const chip = (await screen.findByText(label)).closest('[data-slot="chip"]')!
    expect([...chip.classList]).toEqual(expect.arrayContaining(['chip--accent', 'chip--sm', 'chip--soft', 'ml-1', 'mr-1', 'text-xs']))
    expect(chip.classList.contains('cursor-pointer')).toBe(false)
    expect(chip.hasAttribute('tabindex')).toBe(false)
    expect(screen.queryByText(updateLabel)).toBeNull()
    fireEvent.click(chip)
    expect(screen.queryByTestId('navbar-test-update-dialog')).toBeNull()
  })

  it('stable keeps its success update chip and opens the update dialog on click', async () => {
    desktopUpdater.updateInfo = UPDATE_INFO
    renderNavbar()

    const chip = (await screen.findByText('更新可用')).closest('[data-slot="chip"]')!
    expect(chip.classList.contains('chip--success')).toBe(true)
    expect(screen.queryByText('夜间构建版本')).toBeNull()
    fireEvent.click(chip)
    await screen.findByTestId('navbar-test-update-dialog')
  })

  it('stable adds and removes the update chip when updateInfo changes', async () => {
    renderNavbar()
    await waitFor(() => expect(client.getQueryState(queryKeys.appIdentifier)?.status).toBe('success'))
    expect(screen.queryByText('更新可用')).toBeNull()
    expect(screen.queryByText('夜间构建版本')).toBeNull()

    act(() => {
      desktopUpdater.updateInfo = UPDATE_INFO
    })
    await screen.findByText('更新可用')
    act(() => {
      desktopUpdater.updateInfo = null
    })
    await waitFor(() => expect(screen.queryByText('更新可用')).toBeNull())
  })

  it.each([
    { identifier: 'dsh-tauri', label: '更新可用', absent: '夜间构建版本' },
    { identifier: 'dsh-tauri-nightly', label: '夜间构建版本', absent: '更新可用' },
  ])('pending identifier hides both chips until $identifier is known', async ({ identifier, label, absent }) => {
    const pending = Promise.withResolvers<string>()
    getAppIdentifier.mockReturnValue(pending.promise)
    desktopUpdater.updateInfo = UPDATE_INFO
    renderNavbar()
    expect(getAppIdentifier).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('更新可用')).toBeNull()
    expect(screen.queryByText('夜间构建版本')).toBeNull()

    await act(async () => {
      pending.resolve(identifier)
    })
    await screen.findByText(label)
    expect(screen.queryByText(absent)).toBeNull()
  })

  it('failed identifier lookup does not expose an update chip or guess the channel', async () => {
    getAppIdentifier.mockRejectedValue(new Error('IDENTIFIER_FAILED'))
    desktopUpdater.updateInfo = UPDATE_INFO
    renderNavbar()
    await waitFor(() => expect(client.getQueryState(queryKeys.appIdentifier)?.status).toBe('error'))
    expect(screen.queryByText('更新可用')).toBeNull()
    expect(screen.queryByText('夜间构建版本')).toBeNull()
    expect(getAppIdentifier).toHaveBeenCalledTimes(1)
  })
})
