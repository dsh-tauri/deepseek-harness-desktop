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
  proxyTestResult: { ok: true, reason: null, status: 200, latency_ms: 12 } as Record<string, unknown>,
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
  mocks.proxyTestResult = { ok: true, reason: null, status: 200, latency_ms: 12 }
  mocks.invoke.mockImplementation((command: string) => {
    if (command === 'get_app_config')
      return Promise.resolve({ ...mocks.settingState })
    if (command === 'get_runtime_info')
      return Promise.resolve({ app_version: '1.0.0', dsh_version: '1.0.0', node_version: '22.0.0', platform: 'linux', arch: 'x64', service_url: 'http://127.0.0.1:3080', harness_path: '', data_dir: '', node_path: '', pnpm_path: '' })
    if (command === 'get_cli_link_status')
      return Promise.resolve({ enabled: false, shim_exists: false, path_registered: false, user_dsh_preserved: false, bin_dir: '', shim_path: '' })
    if (command === 'test_proxy')
      return Promise.resolve({ ...mocks.proxyTestResult })
    return Promise.resolve(null)
  })
})

afterEach(() => {
  cleanup()
})

describe('配置面板代理地址保存', () => {
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
describe('配置面板代理连通性测试', () => {
  it('测试按钮在保存值上直接发起测试并提示成功', async () => {
    renderDebug()

    await waitFor(() => expect(proxyInput().value).toBe(SAVED))

    fireEvent.click(screen.getByTestId('dsh-proxy-test'))

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('test_proxy'))
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('network.test_ok', { variant: 'success' }))
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('输入框有未保存修改时先保存再测试', async () => {
    renderDebug()

    await waitFor(() => expect(proxyInput().value).toBe(SAVED))

    fireEvent.change(proxyInput(), { target: { value: EDITED } })
    fireEvent.click(screen.getByTestId('dsh-proxy-test'))

    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ proxyUrl: EDITED }))
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('test_proxy'))
  })

  it('代理不可达时按失败分类提示', async () => {
    mocks.proxyTestResult = { ok: false, reason: 'connect', status: null, latency_ms: 8 }
    renderDebug()

    await waitFor(() => expect(proxyInput().value).toBe(SAVED))

    fireEvent.click(screen.getByTestId('dsh-proxy-test'))

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('network.test_connect', { variant: 'danger' }))
  })

  it('代理地址为空时禁用测试按钮', async () => {
    mocks.settingState.proxy_url = ''
    renderDebug()

    await waitFor(() => expect(proxyInput().value).toBe(''))
    expect((screen.getByTestId('dsh-proxy-test') as HTMLButtonElement).disabled).toBe(true)
  })
})
