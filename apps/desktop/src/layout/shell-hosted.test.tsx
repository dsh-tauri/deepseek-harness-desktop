// @vitest-environment jsdom
import { invoke } from '@tauri-apps/api/core'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { harness } from '@/store/modules/harness/store'
import { Shell } from './shell'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}), emitTo: vi.fn(async () => {}) }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }))
vi.mock('@tauri-apps/plugin-os', () => ({ type: () => 'windows' }))
vi.mock('@/config/client', () => ({ queryClient: { invalidateQueries: vi.fn() } }))
vi.mock('@/config/hooks', () => ({ hooks: { 'config.dialog.hidden': { trigger: vi.fn() } } }))
vi.mock('@/utils/toast', () => ({ toast: Object.assign(vi.fn(), { close: vi.fn() }) }))
vi.mock('@/store/modules/harness-updater', () => ({ harnessUpdater: { checkForUpdate: vi.fn() } }))
vi.mock('@/store/modules/plugins', () => import('@/store/modules/plugins/utils'))
vi.mock('@/store/modules/preinstall', () => ({ preinstall: {} }))
vi.mock('@/store/modules/recovery', async () => {
  const { defineStore } = await import('valtio-define')
  return { recovery: defineStore({ state: () => ({ recovery: { required: false } }), actions: { clear: vi.fn(), reset: vi.fn() } }) }
})
vi.mock('@/store/modules/setting', () => ({ setting: { $state: { installed: true }, refresh: vi.fn() } }))
vi.mock('@/store', async () => {
  const { harness } = await import('@/store/modules/harness/store')
  const { recovery } = await import('@/store/modules/recovery')
  return { store: { harness, recovery } }
})
vi.mock('@/hooks/use-appearance', () => ({ useAppearance: () => '' }))
vi.mock('@/hooks/use-dsh-style', () => ({ useDshStyle: () => [{}, vi.fn()] }))
vi.mock('@/hooks/use-dsh-shortcuts', () => ({ DSH_VIEW_COMMANDS: [], shortcutHint: vi.fn(), useDshShortcuts: () => [{ rows: [] }, vi.fn()] }))
vi.mock('@/hooks/use-listen', () => ({ useListen: vi.fn() }))
vi.mock('@/hooks/use-native-notifications', () => ({ useNativeNotifications: () => ({ handleAction: vi.fn(), handleClick: vi.fn() }) }))
vi.mock('@/hooks/use-notification-action', () => ({ useNotificationAction: vi.fn() }))
vi.mock('@/hooks/use-notification-clicked', () => ({ useNotificationClicked: vi.fn() }))
vi.mock('@overlastic/react', () => ({ useOverlay: () => vi.fn() }))
vi.mock('@/ui/dialog/config', () => ({ ConfigDialog: () => null }))
vi.mock('@/ui/plugin/recovery', () => ({ Recovery: () => null }))
vi.mock('./startup/preinstall', () => ({ PreinstallSetup: () => null }))
vi.mock('./navbar/full-sidebar-navbar', () => ({ FullSidebarNavbar: () => null }))
vi.mock('./navbar/navbar', () => ({ Navbar: () => <nav aria-label="Desktop" /> }))
vi.mock('@/components/panel', () => ({ Panel: { Progress: () => null } }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(1)
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('__DSH_HOSTED__', true)
  vi.stubGlobal('__DSH_BOOT__', undefined)
  Object.assign(harness, {
    status: 'ready',
    serviceHealthy: true,
    serviceRunning: true,
    restartPending: false,
    webviewSrc: 'http://127.0.0.1:3081?t=1&dshDesktop=1',
    webviewKey: 0,
    webviewLoaded: false,
    webviewAliveKey: null,
    webviewError: false,
    errorMsg: '',
    errorLogs: [],
    pluginConflictHint: '',
    inotifyLimitHint: '',
    patchLayerHint: '',
    heapOomHint: '',
    busyAction: null,
  })
})

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('shows a recoverable error when hosting a ready service fails in the bootstrap document', async () => {
  const failure = 'HARNESS_AUTH_UNAVAILABLE: authentication request failed'
  vi.mocked(invoke).mockRejectedValueOnce(failure)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const view = render(<Shell />)
  await act(async () => {})
  expect(invoke).toHaveBeenCalledExactlyOnceWith('host_harness_document', { url: 'http://127.0.0.1:3081?t=1&dshDesktop=1' })
  expect(view.getByTestId('dsh-setup-error').textContent).toContain(failure)
  expect(view.getByRole('button', { name: 'app.retry' }).hasAttribute('disabled')).toBe(false)
  expect(view.container.querySelector('main')?.className).toContain('pointer-events-auto')
  expect(harness.serviceRunning).toBe(true)
  vi.mocked(invoke).mockImplementation(async (command) => {
    switch (command) {
      case 'get_runtime_info': return { service_url: 'http://127.0.0.1:3081' }
      case 'runtime_ready': return true
      case 'get_profiles': return [{ id: 'test', active: true }]
      case 'get_preinstall_pending': return false
      case 'proxy_health_check': return 'healthy'
      case 'ensure_internal_plugins':
      case 'launch_harness':
      case 'harness_ownership':
      case 'host_harness_document': return
      default: throw new Error(`Unexpected command: ${command}`)
    }
  })
  await act(async () => {
    fireEvent.click(view.getByRole('button', { name: 'app.retry' }))
  })
  expect(invoke).toHaveBeenCalledWith('proxy_health_check')
  expect(invoke).toHaveBeenCalledWith('harness_ownership')
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'host_harness_document')).toEqual([
    ['host_harness_document', { url: 'http://127.0.0.1:3081?t=1&dshDesktop=1' }],
    ['host_harness_document', { url: 'http://127.0.0.1:3081?t=1&dshDesktop=1' }],
  ])
  expect(view.queryByTestId('dsh-setup-error')).toBeNull()
  expect(view.getByText('status.loading_plugins').textContent).toBe('status.loading_plugins')
})

it.each(['pending', 'accepted'])('keeps the bootstrap loading until the DSH document exists while navigation is %s', async (navigation) => {
  if (navigation === 'pending')
    vi.mocked(invoke).mockReturnValueOnce(new Promise(() => {}))
  const view = render(<Shell />)
  await act(async () => {})
  expect(invoke).toHaveBeenCalledExactlyOnceWith('host_harness_document', { url: 'http://127.0.0.1:3081?t=1&dshDesktop=1' })
  expect(view.getByText('status.loading_plugins').textContent).toBe('status.loading_plugins')
  expect(view.queryByTestId('dsh-setup-error')).toBeNull()
  expect(harness.webviewLoaded).toBe(false)
  expect(harness.webviewAlive).toBe(false)
  expect(view.container.querySelector('main')?.className).toContain('pointer-events-auto')
})

it('keeps an actual hosted service document transparent without rehosting its current origin', async () => {
  const frame = document.createElement('div')
  frame.className = 'layout_frame'
  frame.append(document.createElement('section'))
  document.body.append(frame)
  vi.stubGlobal('__DSH_BOOT__', { entries: [] })
  vi.stubGlobal('location', new URL('http://127.0.0.1:3081/'))
  const view = render(<Shell />)
  await act(async () => {})
  expect(invoke).not.toHaveBeenCalled()
  expect(view.getByTestId('dsh-hosted-document').textContent).toBe('')
  expect(view.queryByText('status.loading_plugins')).toBeNull()
  expect(harness.webviewLoaded).toBe(true)
  expect(harness.webviewAlive).toBe(true)
  expect(view.container.querySelector('main')?.className).toContain('pointer-events-none')
})

it('reloads an actual same-origin document only for a pending native restart', async () => {
  vi.stubGlobal('__DSH_BOOT__', { entries: [] })
  vi.stubGlobal('location', new URL('http://127.0.0.1:3081/?t=old'))
  harness.restartPending = true
  render(<Shell />)
  await act(async () => {})
  expect(invoke).toHaveBeenCalledExactlyOnceWith('host_harness_document', { url: 'http://127.0.0.1:3081?t=1&dshDesktop=1' })
})

it('does not repeat accepted hosted navigation when service health fluctuates', async () => {
  render(<Shell />)
  await act(async () => {})
  await act(async () => {
    harness.serviceHealthy = false
  })
  await act(async () => {
    harness.serviceHealthy = true
  })
  expect(invoke).toHaveBeenCalledExactlyOnceWith('host_harness_document', { url: 'http://127.0.0.1:3081?t=1&dshDesktop=1' })
})

it('keeps service metadata covered until a visible populated DSH frame mounts', async () => {
  vi.stubGlobal('__DSH_BOOT__', { entries: [] })
  vi.stubGlobal('location', new URL('http://127.0.0.1:3081/'))
  const view = render(<Shell />)
  await act(async () => {})
  expect(view.getByText('status.loading_plugins').textContent).toBe('status.loading_plugins')
  expect(harness.webviewLoaded).toBe(false)
  expect(harness.webviewAlive).toBe(false)
  const frame = document.createElement('div')
  frame.className = 'layout_frame'
  await act(async () => {
    document.body.append(frame)
  })
  expect(view.getByText('status.loading_plugins').textContent).toBe('status.loading_plugins')
  await act(async () => {
    frame.style.visibility = 'hidden'
    frame.append(document.createElement('section'))
  })
  expect(view.getByText('status.loading_plugins').textContent).toBe('status.loading_plugins')
  await act(async () => {
    frame.style.visibility = 'visible'
  })
  expect(view.queryByText('status.loading_plugins')).toBeNull()
  expect(harness.webviewLoaded).toBe(true)
  expect(harness.webviewAlive).toBe(true)
  await act(async () => {
    harness.serviceHealthy = false
  })
  expect(view.getByText('status.loading_plugins').textContent).toBe('status.loading_plugins')
  await act(async () => {
    harness.serviceHealthy = true
    harness.restartPending = true
  })
  expect(view.getByTestId('dsh-hosted-loading').className).toContain('pointer-events-auto')
  expect(view.getByText('status.loading_plugins').textContent).toBe('status.loading_plugins')
  await act(async () => {
    harness.restartPending = false
  })
  expect(view.queryByText('status.loading_plugins')).toBeNull()
})
