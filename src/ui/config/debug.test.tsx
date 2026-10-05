// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigDebug } from './debug'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  toast: vi.fn(),
  update: vi.fn(),
  build: vi.fn(),
  settingState: { proxy_url: '', port: 3080, zoom_factor: 1, harness_max_heap_mb: null } as Record<string, unknown>,
  harnessState: { serviceRunning: true, busyAction: null } as Record<string, unknown>,
  harnessUpdaterState: { updateInfo: null } as Record<string, unknown>,
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('@/utils/toast', () => ({ toast: mocks.toast }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN', changeLanguage: vi.fn() } }),
}))
vi.mock('@/hooks/use-listen', () => ({ useListen: () => {} }))
vi.mock('@/ui/config/components/close-action', () => ({ ConfigCloseAction: () => null }))
vi.mock('@/ui/config/components/launch-on-login', () => ({ ConfigLaunchOnLogin: () => null }))
vi.mock('@/ui/config/hooks/use-core-breaking-confirm', () => ({
  useCoreBreakingConfirm: () => ({ holder: null, confirmCoreBreaking: vi.fn() }),
}))
vi.mock('@/ui/config/hooks/use-core-profile-switch', () => ({
  useCoreProfileSwitch: () => ({ holder: null, guardCoreUpgrade: vi.fn() }),
}))
vi.mock('valtio-define', () => {
  const store = (state: unknown) => ({
    $state: state,
    update: mocks.update,
    build: mocks.build,
    refresh: vi.fn(),
    launchAndWait: vi.fn(),
  })
  return {
    defineStore: (name: unknown) => store(name),
    useStore: (value: { $state: Record<string, unknown> }) => value.$state,
  }
})
vi.mock('@/store/modules/setting', () => ({
  HARNESS_HEAP_MIN_MB: 512,
  HARNESS_HEAP_MAX_MB: 32768,
  setting: { $state: mocks.settingState, update: mocks.update },
}))
vi.mock('@/store/modules/harness', () => ({
  harness: { $state: mocks.harnessState, restart: vi.fn(), shutdown: vi.fn(), openBrowser: vi.fn() },
}))
vi.mock('@/store/modules/harness-updater', () => ({
  harnessUpdater: { $state: mocks.harnessUpdaterState, showToast: vi.fn(), handleUpdate: vi.fn() },
}))
vi.mock('@/store', () => ({
  store: {
    setting: { $state: mocks.settingState, update: mocks.update },
    harness: { $state: mocks.harnessState, restart: vi.fn(), shutdown: vi.fn(), openBrowser: vi.fn() },
    harnessUpdater: { $state: mocks.harnessUpdaterState, showToast: vi.fn(), handleUpdate: vi.fn() },
  },
}))

const SAVED = 'socks5h://127.0.0.1:1080'
const EDITED = 'http://127.0.0.1:7897'

/** 让 `store.setting.update` 挂起，模拟「保存仍在途」。 */
function deferUpdate() {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = () => resolve()
  })
  mocks.update.mockReturnValue(pending)
  return release
}

function renderDebug() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ConfigDebug />
    </QueryClientProvider>,
  )
}

function proxyInput(): HTMLInputElement {
  return screen.getByTestId('dsh-proxy-url') as HTMLInputElement
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.settingState.proxy_url = SAVED
  mocks.settingState.port = 3080
  mocks.settingState.zoom_factor = 1
  mocks.settingState.harness_max_heap_mb = null
  mocks.harnessState.serviceRunning = true
  mocks.harnessState.busyAction = null
  mocks.harnessUpdaterState.updateInfo = null
  mocks.invoke.mockImplementation((command: string) => {
    if (command === 'get_app_config')
      return Promise.resolve({ ...mocks.settingState })
    if (command === 'get_runtime_info')
      return Promise.resolve({ app_version: '1.0.0', dsh_version: '1.0.0', node_version: '22.0.0', platform: 'linux', arch: 'x64', service_url: 'http://127.0.0.1:3080', harness_path: '', data_dir: '', node_path: '', pnpm_path: '' })
    if (command === 'get_cli_link_status')
      return Promise.resolve({ enabled: false, shim_exists: false, path_registered: false, user_dsh_preserved: false, bin_dir: '', shim_path: '' })
    return Promise.resolve(null)
  })
})

afterEach(() => {
  cleanup()
})

describe('配置面板代理地址保存', () => {
  it('代理地址以普通文本输入框呈现，不做密码遮掩', async () => {
    renderDebug()

    await waitFor(() => expect(proxyInput().value).toBe(SAVED))

    expect(proxyInput().type).toBe('text')
  })

  it('保存成功且期间未再编辑时，输入框回落到已保存值', async () => {
    const release = deferUpdate()
    renderDebug()

    await waitFor(() => expect(proxyInput().value).toBe(SAVED))

    fireEvent.change(proxyInput(), { target: { value: EDITED } })
    fireEvent.click(screen.getByTestId('dsh-proxy-save'))
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ proxyUrl: EDITED }))

    await act(async () => {
      release()
      await Promise.resolve()
    })

    await waitFor(() => expect(proxyInput().value).toBe(SAVED))
  })

  it('保存期间用户又改了输入时，不抹掉在途的新输入', async () => {
    const release = deferUpdate()
    renderDebug()

    await waitFor(() => expect(proxyInput().value).toBe(SAVED))

    fireEvent.change(proxyInput(), { target: { value: EDITED } })
    fireEvent.click(screen.getByTestId('dsh-proxy-save'))
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ proxyUrl: EDITED }))

    const inflight = 'https://user:secret@proxy.example:8443'
    fireEvent.change(proxyInput(), { target: { value: inflight } })

    await act(async () => {
      release()
      await Promise.resolve()
    })

    expect(proxyInput().value).toBe(inflight)
  })

  it('保存期间改回与提交值一致时，仍按已保存值收拢编辑态', async () => {
    const release = deferUpdate()
    renderDebug()

    await waitFor(() => expect(proxyInput().value).toBe(SAVED))

    fireEvent.change(proxyInput(), { target: { value: EDITED } })
    fireEvent.click(screen.getByTestId('dsh-proxy-save'))
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ proxyUrl: EDITED }))

    fireEvent.change(proxyInput(), { target: { value: `  ${EDITED}  ` } })

    await act(async () => {
      release()
      await Promise.resolve()
    })

    await waitFor(() => expect(proxyInput().value).toBe(SAVED))
  })
})
