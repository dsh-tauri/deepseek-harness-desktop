// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import type { SshMachineRow } from '@/hooks/use-remote'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/config/query-keys'
import { RemoteSwitcher } from './remote-switcher'

if (typeof globalThis.CSS === 'undefined') {
  Object.assign(globalThis, {
    CSS: {
      escape: (value: string) => value.replace(/[^\w-]/g, c => `\\${c}`),
    },
  })
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, params?: Record<string, unknown>) => params?.name !== undefined ? `${key}:${String(params.name)}` : key }),
}))
const toastSpy = vi.fn()
const manageSpy = vi.fn()
const changeSpy = vi.fn<(url: string, tint: string | null) => void>()
const { windowInfo } = vi.hoisted(() => ({ windowInfo: { label: 'main' } }))
const invokeSpy = vi.fn<(command: string, args?: { method?: string, payload?: unknown, machineId?: string, url?: string }) => Promise<unknown>>()
vi.mock('@/utils/toast', () => ({
  toast: (...args: unknown[]) => { toastSpy(...args) },
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: Parameters<typeof invokeSpy>) => invokeSpy(...args),
}))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => windowInfo }))

function machineOf(partial: Partial<SshMachineRow>): SshMachineRow {
  return { id: 'm1', name: 'machine', state: 'disconnected', ...partial }
}

let queryClient: QueryClient
let engineMachines: SshMachineRow[]
let engineEnabled: boolean
let engineUnreachable: boolean
let eventItems: { seq: number, line: string }[]

function switcherElement(props: Partial<ComponentProps<typeof RemoteSwitcher>> = {}) {
  return (
    <QueryClientProvider client={queryClient}>
      <RemoteSwitcher onChange={changeSpy} onManage={manageSpy} {...props} />
    </QueryClientProvider>
  )
}

function renderSwitcher(props: Partial<ComponentProps<typeof RemoteSwitcher>> = {}) {
  return render(switcherElement(props))
}

async function openMenu() {
  fireEvent.click(await screen.findByRole('button', { name: 'remote.switcher' }))
  return screen.findByRole('menu')
}

async function selectMachine(name: string) {
  const menu = await openMenu()
  fireEvent.click(within(menu).getByText(name))
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
}

async function refreshMachines() {
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.remoteMachines })
  })
}

function requests(method: string) {
  return invokeSpy.mock.calls.filter(([command, args]) => command === 'remote' && args?.method === method)
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } })
  toastSpy.mockClear()
  manageSpy.mockClear()
  changeSpy.mockClear()
  invokeSpy.mockReset()
  windowInfo.label = 'main'
  engineMachines = []
  engineEnabled = true
  engineUnreachable = false
  eventItems = []
  invokeSpy.mockImplementation(async (command, args) => {
    if (command === 'remote_open_window')
      return undefined
    if (command !== 'remote')
      throw new Error(`Unexpected native command: ${command}`)
    switch (args?.method) {
      case 'GET /api/tauri/ssh/machines':
        if (engineUnreachable)
          throw new TypeError('fetch failed')
        return { enabled: engineEnabled, items: engineMachines, discovered: [] }
      case 'GET /api/tauri/ssh/machines/events': {
        const { sinceSeq } = args.payload as { sinceSeq: number }
        return { items: eventItems.filter(item => item.seq >= sinceSeq) }
      }
      case 'POST /api/tauri/ssh/machines/connect': {
        const { machineId } = args.payload as { machineId: string }
        engineMachines = engineMachines.map(machine => machine.id === machineId ? { ...machine, state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' } : machine)
        return { tunnelBaseUrl: 'http://127.0.0.1:4001' }
      }
      case 'POST /api/tauri/ssh/machines/disconnect': {
        const { machineId } = args.payload as { machineId: string }
        engineMachines = engineMachines.map(machine => machine.id === machineId ? { ...machine, state: 'disconnected', tunnelBaseUrl: undefined } : machine)
        return {}
      }
      default:
        throw new Error(`Unexpected remote request: ${args?.method}`)
    }
  })
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('remoteSwitcher 渲染', () => {
  it('空态：本地项 + 空态引导 + 管理入口（打开壳层管理面板）', async () => {
    renderSwitcher()
    const menu = await openMenu()
    expect(within(menu).getByText('remote.local')).toBeTruthy()
    expect(within(menu).getByText('remote.empty')).toBeTruthy()
    expect(changeSpy).toHaveBeenLastCalledWith('', null)

    fireEvent.click(within(menu).getByText('remote.manage'))
    await waitFor(() => expect(manageSpy).toHaveBeenCalledOnce())
  })

  it('操作区：管理机器与同步到远端同级且各自回调；缺回调时双双置灰', async () => {
    const syncSpy = vi.fn()
    const { unmount } = renderSwitcher({ onSync: syncSpy })
    const menu = await openMenu()
    expect(within(menu).getByText('remote.manage')).toBeTruthy()
    fireEvent.click(within(menu).getByText('remote.sync'))
    await waitFor(() => expect(syncSpy).toHaveBeenCalledOnce())
    expect(manageSpy).not.toHaveBeenCalled()
    fireEvent.click(within(await openMenu()).getByText('remote.manage'))
    await waitFor(() => expect(manageSpy).toHaveBeenCalledOnce())
    expect(syncSpy).toHaveBeenCalledOnce()
    unmount()

    renderSwitcher({ onManage: undefined })
    const bare = await openMenu()
    expect(within(bare).getByText('remote.manage').closest('[role="menuitem"]')?.getAttribute('aria-disabled')).toBe('true')
    expect(within(bare).getByText('remote.sync').closest('[role="menuitem"]')?.getAttribute('aria-disabled')).toBe('true')
  })

  it('机器项：状态点语义（标识色优先内联 / 已连接绿 / 重连琥珀 / 放弃红）与状态文案', async () => {
    engineMachines = [
      machineOf({ id: 'colored', name: 'colored', color: '#ff00ff', state: 'reconnecting' }),
      machineOf({ id: 'green', name: 'green', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' }),
      machineOf({ id: 'amber', name: 'amber', state: 'connecting' }),
      machineOf({ id: 'red', name: 'red', state: 'given-up', lastError: 'connect failed after 3 attempt(s): refused' }),
    ]
    renderSwitcher()
    const menu = await openMenu()

    const colored = within(menu).getByText('colored').closest('[role="menuitem"]')?.querySelector('[class*="rounded-full"]')
    expect(colored?.getAttribute('style')).toContain('rgb(255, 0, 255)')

    const green = within(menu).getByText('green').closest('[role="menuitem"]')?.querySelector('[class*="rounded-full"]')
    expect(green?.className).toContain('bg-success')
    expect(green?.getAttribute('style')).toBeNull()
    expect(within(menu).getByText('remote.state.connected')).toBeTruthy()

    const amber = within(menu).getByText('amber').closest('[role="menuitem"]')?.querySelector('[class*="rounded-full"]')
    expect(amber?.className).toContain('bg-warning')

    const red = within(menu).getByText('red').closest('[role="menuitem"]')?.querySelector('[class*="rounded-full"]')
    expect(red?.className).toContain('bg-danger')
    expect(within(menu).getByText('red').closest('[title]')?.getAttribute('title')).toContain('refused')
  })

  it('触发按钮显示活动机器名与标识色点；无活动时显示本地', async () => {
    engineMachines = [machineOf({ id: 'm1', name: 'alpha', color: '#123456', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })]
    renderSwitcher()
    await selectMachine('alpha')
    const trigger = screen.getByRole('button', { name: 'remote.switcher' })
    expect(trigger.textContent).toContain('alpha')
    expect(trigger.querySelector('span[class*="rounded-full"]')?.getAttribute('style')).toContain('rgb(18, 52, 86)')
    expect(changeSpy).toHaveBeenLastCalledWith('http://127.0.0.1:4001', null)

    fireEvent.click(within(await openMenu()).getByText('remote.local'))
    await waitFor(() => expect(changeSpy).toHaveBeenLastCalledWith('', null))
    expect(screen.getByRole('button', { name: 'remote.switcher' }).textContent).toContain('remote.local')
  })
})

describe('remoteSwitcher 交互与降级', () => {
  it('未启用（或插件未加载）时壳层不渲染「本地」控件；启用后随下一轮轮询出现', async () => {
    engineEnabled = false
    renderSwitcher()
    await waitFor(() => {
      expect(invokeSpy).toHaveBeenCalledWith('remote', { method: 'GET /api/tauri/ssh/machines', payload: null })
      expect(queryClient.getQueryState(queryKeys.remoteMachines)?.status).toBe('success')
      expect(queryClient.getQueryState(queryKeys.remoteMachines)?.fetchStatus).toBe('idle')
    })
    expect(screen.queryByRole('button', { name: 'remote.switcher' })).toBeNull()
    expect(changeSpy).toHaveBeenLastCalledWith('', null)

    engineEnabled = true
    fireEvent(window, new Event('focus'))
    expect(await screen.findByRole('button', { name: 'remote.switcher' })).toBeTruthy()
  })

  it('点击已连接机器项：切换视图（activeId/隧道 URL）', async () => {
    engineMachines = [machineOf({ id: 'm1', name: 'alpha', color: '#123456', tintBorder: true, state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })]
    renderSwitcher()
    await selectMachine('alpha')
    await waitFor(() => expect(changeSpy).toHaveBeenLastCalledWith('http://127.0.0.1:4001', '#123456'))
    expect(screen.getByRole('button', { name: 'remote.switcher' }).textContent).toContain('alpha')
    expect(screen.queryByRole('dialog')).toBeNull()
    const menu = await openMenu()
    expect(within(menu).getByText('alpha').closest('[role="menuitem"]')?.textContent).toContain('remote.state.connected')
    expect(within(menu).getByText('remote.disconnect_active')).toBeTruthy()
    expect(requests('POST /api/tauri/ssh/machines/connect')).toHaveLength(0)
  })

  it('点击本地项：回本地并撤销挂起切换', async () => {
    engineMachines = [
      machineOf({ id: 'm1', name: 'alpha', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' }),
      machineOf({ id: 'm2', name: 'beta', state: 'connecting', progress: { phase: 'installing' } }),
    ]
    renderSwitcher()
    await selectMachine('alpha')
    await selectMachine('beta')
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('remote.connect.title:beta')).toBeTruthy()
    expect(changeSpy).toHaveBeenLastCalledWith('http://127.0.0.1:4001', null)
    fireEvent.click(within(dialog).getByRole('button', { name: 'buttons.close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(within(await openMenu()).getByText('remote.local'))
    await waitFor(() => expect(changeSpy).toHaveBeenLastCalledWith('', null))

    engineMachines = engineMachines.map(machine => machine.id === 'm2' ? { ...machine, state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4002' } : machine)
    await refreshMachines()
    expect(changeSpy).toHaveBeenLastCalledWith('', null)
    expect(screen.getByRole('button', { name: 'remote.switcher' }).textContent).toContain('remote.local')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(requests('POST /api/tauri/ssh/machines/disconnect')).toHaveLength(0)
    const menu = await openMenu()
    expect(within(menu).getByText('beta').closest('[role="menuitem"]')?.getAttribute('aria-disabled')).not.toBe('true')
    expect(within(menu).queryByText('remote.disconnect_active')).toBeNull()
  })

  it('本地实例不可达：降级提示 + 远端项禁用（不弹错误风暴），恢复后自动复原', async () => {
    engineMachines = [machineOf({ id: 'm1', name: 'alpha', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })]
    renderSwitcher()
    await screen.findByRole('button', { name: 'remote.switcher' })
    engineUnreachable = true
    await refreshMachines()
    const menu = await openMenu()
    expect(within(menu).getByText('remote.degraded')).toBeTruthy()
    const item = within(menu).getByText('alpha').closest('[role="menuitem"]')
    expect(item?.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(within(menu).getByText('alpha'))
    expect(changeSpy).toHaveBeenLastCalledWith('', null)
    expect(requests('POST /api/tauri/ssh/machines/connect')).toHaveLength(0)

    engineUnreachable = false
    fireEvent(window, new Event('focus'))
    await waitFor(() => {
      expect(screen.queryByText('remote.degraded')).toBeNull()
      expect(within(menu).getByText('alpha').closest('[role="menuitem"]')?.getAttribute('aria-disabled')).not.toBe('true')
    })
    expect(toastSpy).not.toHaveBeenCalled()
  })

  it('重连保留活动 URL，标识色与描边开关更新立即回报，禁用插件清空视图', async () => {
    engineMachines = [machineOf({ name: 'alpha', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001', color: '#123456', tintBorder: true })]
    renderSwitcher()
    await selectMachine('alpha')
    expect(changeSpy).toHaveBeenLastCalledWith('http://127.0.0.1:4001', '#123456')
    engineMachines = [machineOf({ name: 'alpha', state: 'reconnecting', color: '#654321', tintBorder: true })]
    await refreshMachines()
    await waitFor(() => expect(changeSpy).toHaveBeenLastCalledWith('http://127.0.0.1:4001', '#654321'))
    expect(screen.getByRole('button', { name: 'remote.switcher' }).textContent).toContain('alpha')
    engineMachines = [machineOf({ name: 'alpha', state: 'reconnecting', color: '#654321' })]
    await refreshMachines()
    await waitFor(() => expect(changeSpy).toHaveBeenLastCalledWith('http://127.0.0.1:4001', null))
    engineMachines = [machineOf({ name: 'alpha', state: 'reconnecting', tintBorder: true })]
    await refreshMachines()
    expect(changeSpy).toHaveBeenLastCalledWith('http://127.0.0.1:4001', null)

    engineEnabled = false
    await refreshMachines()
    await waitFor(() => expect(changeSpy).toHaveBeenLastCalledWith('', null))
    expect(screen.queryByRole('button', { name: 'remote.switcher' })).toBeNull()
  })

  it('内部连接弹窗呈现阶段与事件日志，取消向引擎断开且不切换视图', async () => {
    engineMachines = [machineOf({ name: 'alpha', state: 'connecting', progress: { phase: 'installing' } })]
    eventItems = [{ seq: 0, line: '[installing] download 42%' }]
    renderSwitcher()
    await selectMachine('alpha')
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('remote.connect.title:alpha')).toBeTruthy()
    expect(within(dialog).getByText('remote.step.installing')).toBeTruthy()
    expect(await within(dialog).findByText('[installing] download 42%')).toBeTruthy()
    expect(changeSpy).toHaveBeenLastCalledWith('', null)
    fireEvent.click(within(dialog).getByRole('button', { name: 'remote.connect.cancel' }))
    await waitFor(() => {
      expect(invokeSpy).toHaveBeenCalledWith('remote', { method: 'POST /api/tauri/ssh/machines/disconnect', payload: { machineId: 'm1' } })
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    expect(changeSpy).toHaveBeenLastCalledWith('', null)
    expect(screen.queryByText('remote.connect.failed_title')).toBeNull()
  })

  it('隐藏时仍启动远端窗口目标并轮询，显示后保留同一视图，卸载停止请求', async () => {
    vi.useFakeTimers()
    windowInfo.label = 'remote-m1'
    engineMachines = [machineOf({ name: 'alpha', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001', color: '#123456', tintBorder: true })]
    const { rerender, unmount } = renderSwitcher({ visible: false })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(screen.queryByRole('button', { name: 'remote.switcher' })).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(changeSpy).toHaveBeenLastCalledWith('http://127.0.0.1:4001', '#123456')
    expect(requests('GET /api/tauri/ssh/machines')).toHaveLength(1)

    engineMachines = [machineOf({ name: 'alpha', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4002', color: '#654321', tintBorder: true })]
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(requests('GET /api/tauri/ssh/machines')).toHaveLength(2)
    expect(changeSpy).toHaveBeenLastCalledWith('http://127.0.0.1:4002', '#654321')
    rerender(switcherElement())
    expect(screen.getByRole('button', { name: 'remote.switcher' }).textContent).toContain('alpha')
    expect(changeSpy).toHaveBeenLastCalledWith('http://127.0.0.1:4002', '#654321')
    expect(requests('POST /api/tauri/ssh/machines/connect')).toHaveLength(0)
    unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(requests('GET /api/tauri/ssh/machines')).toHaveLength(2)
  })
})

describe('remoteSwitcher 增强（4.4）', () => {
  it('活动机器：状态点强制绿色 + 底部「断开当前连接」一键断开并回本地', async () => {
    engineMachines = [machineOf({ id: 'm1', name: 'alpha', color: '#ff00ff', tintBorder: true, state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })]
    renderSwitcher()
    await selectMachine('alpha')
    const menu = await openMenu()
    const dot = within(menu).getByText('alpha').closest('[role="menuitem"]')?.querySelector('[class*="rounded-full"]')
    expect(dot?.className).toContain('bg-success')
    expect(dot?.getAttribute('style')).toBeNull()

    fireEvent.click(within(menu).getByText('remote.disconnect_active'))
    await waitFor(() => {
      expect(invokeSpy).toHaveBeenCalledWith('remote', { method: 'POST /api/tauri/ssh/machines/disconnect', payload: { machineId: 'm1' } })
      expect(changeSpy).toHaveBeenLastCalledWith('', null)
    })
    expect(screen.getByRole('button', { name: 'remote.switcher' }).textContent).toContain('remote.local')
  })

  it('无活动机器时不出现断开项', async () => {
    engineMachines = [machineOf({ id: 'm1', name: 'alpha', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })]
    renderSwitcher()
    const menu = await openMenu()
    expect(within(menu).queryByText('remote.disconnect_active')).toBeNull()
    expect(changeSpy).toHaveBeenLastCalledWith('', null)
  })

  it('重连机器显示重试倒计时；已知凭据类型缀在状态后', async () => {
    engineMachines = [
      machineOf({ id: 'm1', name: 'alpha', state: 'reconnecting', nextRetryAt: Date.now() + 42_000 }),
      machineOf({ id: 'm2', name: 'beta', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4002', authMethod: 'key' }),
    ]
    renderSwitcher()
    const menu = await openMenu()
    const alpha = within(menu).getByText('alpha').closest('[role="menuitem"]')
    expect(alpha?.textContent).toContain('remote.retry_in')
    const beta = within(menu).getByText('beta').closest('[role="menuitem"]')
    expect(beta?.textContent).toContain('remote.auth.key')
  })
})

describe('remoteSwitcher 行内双动作（当前窗口 vs 新窗口）', () => {
  it('新窗口按钮常驻所有机器行：点击只发 remote_open_window，不触发切换', async () => {
    engineMachines = [
      machineOf({ id: 'm1', name: 'alpha', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' }),
      machineOf({ id: 'm2', name: 'beta', state: 'disconnected' }),
    ]
    renderSwitcher()
    const menu = await openMenu()
    const buttons = within(menu).getAllByRole('button', { name: 'remote.open_new_window' })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[0]!)
    await waitFor(() => expect(invokeSpy).toHaveBeenCalledWith('remote_open_window', { machineId: 'm1', url: 'http://127.0.0.1:4001' }))
    expect(within(menu).queryByText('remote.disconnect_active')).toBeNull()
    fireEvent.keyDown(menu, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(changeSpy).toHaveBeenLastCalledWith('', null)
    expect(screen.getByRole('button', { name: 'remote.switcher' }).textContent).toContain('remote.local')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(requests('POST /api/tauri/ssh/machines/connect')).toHaveLength(0)
  })

  it('未连接机器的新窗口按钮：url 置空（窗口内启动连接流程）', async () => {
    engineMachines = [machineOf({ id: 'm2', name: 'beta', state: 'disconnected' })]
    renderSwitcher()
    const menu = await openMenu()
    fireEvent.click(within(menu).getByRole('button', { name: 'remote.open_new_window' }))
    await waitFor(() => expect(invokeSpy).toHaveBeenCalledWith('remote_open_window', { machineId: 'm2', url: '' }))
    fireEvent.keyDown(menu, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(changeSpy).toHaveBeenLastCalledWith('', null)
    expect(screen.getByRole('button', { name: 'remote.switcher' }).textContent).toContain('remote.local')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(requests('POST /api/tauri/ssh/machines/connect')).toHaveLength(0)
  })

  it('机器行显示 user@host:port 副标题', async () => {
    engineMachines = [machineOf({ id: 'm1', name: 'alpha', host: '10.1.1.1', port: 22, user: 'root', state: 'disconnected' })]
    renderSwitcher()
    const menu = await openMenu()
    expect(within(menu).getByText('root@10.1.1.1:22')).toBeTruthy()
  })
})
