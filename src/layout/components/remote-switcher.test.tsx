// @vitest-environment jsdom
import type { SshMachineRow } from '@/store/modules/remote'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindSshApiForTests, disposeRemoteForTests, remote } from '@/store/modules/remote'
import { RemoteSwitcher } from './remote-switcher'

// jsdom 未实现 CSS.escape（react-aria 可选集合的焦点定位依赖）；按 CSS 规范转义特殊字符
if (typeof globalThis.CSS === 'undefined') {
  Object.assign(globalThis, {
    CSS: {
      escape: (value: string) => value.replace(/[^\w-]/g, c => `\\${c}`),
    },
  })
}

// i18n 直通（key 即文案）；toast 捕获调用参数
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
const toastSpy = vi.fn()
const manageSpy = vi.fn()
const invokeSpy = vi.fn(async (..._args: unknown[]) => undefined)
vi.mock('@/utils/toast', () => ({
  toast: (...args: unknown[]) => { toastSpy(...args) },
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeSpy(...args),
}))

function machineOf(partial: Partial<SshMachineRow>): SshMachineRow {
  return { id: 'm1', name: 'machine', state: 'disconnected', ...partial }
}

/** 本轮引擎返回的机器列表（boot 的首次 refresh 会异步覆写 store，须同源）。 */
let engineMachines: SshMachineRow[] = []
/** 本轮引擎回报的 SSH 开关（false = 插件未启用，壳层不渲染控件）。 */
let engineEnabled = true
/** 是否模拟本地实例不可达（/api-ssh 抛错 → 降级态）。 */
let engineUnreachable = false

let disconnectSpy = vi.fn(async () => undefined)

function bindEngine() {
  disconnectSpy = vi.fn(async () => undefined)
  bindSshApiForTests({
    listMachines: vi.fn(async () => {
      if (engineUnreachable)
        throw new TypeError('fetch failed')
      return { enabled: engineEnabled, machines: engineMachines }
    }),
    connect: vi.fn(async () => ({ tunnelBaseUrl: 'http://127.0.0.1:4001' })),
    disconnect: disconnectSpy,
  })
}

/** 打开下拉并等待菜单出现在 portal 中。 */
async function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'remote.switcher' }))
  await waitFor(() => {
    expect(screen.getByRole('menu')).toBeTruthy()
  })
  return screen.getByRole('menu')
}

/** 设定机器列表（store 与 mock 引擎同源，避免 boot 首刷覆写）。 */
function seedMachines(machines: SshMachineRow[]) {
  engineMachines = machines
  engineEnabled = true
  remote.enabled = true
  remote.machines = machines
}

beforeEach(() => {
  disposeRemoteForTests()
  toastSpy.mockClear()
  manageSpy.mockClear()
  invokeSpy.mockClear()
  engineMachines = []
  engineEnabled = true
  engineUnreachable = false
  bindEngine()
})

afterEach(() => {
  cleanup()
  disposeRemoteForTests()
  vi.restoreAllMocks()
})

describe('remoteSwitcher 渲染', () => {
  it('空态：本地项 + 空态引导 + 管理入口（打开壳层管理面板）', async () => {
    render(<RemoteSwitcher onManage={manageSpy} />)
    await openMenu()
    const menu = screen.getByRole('menu')
    expect(within(menu).getByText('remote.local')).toBeTruthy()
    expect(within(menu).getByText('remote.empty')).toBeTruthy()

    fireEvent.click(within(menu).getByText('remote.manage'))
    await waitFor(() => {
      expect(manageSpy).toHaveBeenCalled()
    })
  })

  it('操作区：管理机器与同步到远端同级且各自回调；缺回调时双双置灰', async () => {
    const syncSpy = vi.fn()
    const { unmount } = render(<RemoteSwitcher onManage={manageSpy} onSync={syncSpy} />)
    const menu = await openMenu()
    fireEvent.click(within(menu).getByText('remote.sync'))
    await waitFor(() => {
      expect(syncSpy).toHaveBeenCalled()
    })
    expect(within(menu).getByText('remote.manage')).toBeTruthy()
    unmount()

    render(<RemoteSwitcher />)
    const bare = await openMenu()
    expect(within(bare).getByText('remote.manage').closest('[role="menuitem"]')?.getAttribute('aria-disabled')).toBe('true')
    expect(within(bare).getByText('remote.sync').closest('[role="menuitem"]')?.getAttribute('aria-disabled')).toBe('true')
  })

  it('机器项：状态点语义（标识色优先内联 / 已连接绿 / 重连琥珀 / 放弃红）与状态文案', async () => {
    seedMachines([
      machineOf({ id: 'colored', name: 'colored', color: '#ff00ff', state: 'reconnecting' }),
      machineOf({ id: 'green', name: 'green', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' }),
      machineOf({ id: 'amber', name: 'amber', state: 'connecting' }),
      machineOf({ id: 'red', name: 'red', state: 'given-up', lastError: 'connect failed after 3 attempt(s): refused' }),
    ])
    render(<RemoteSwitcher onManage={manageSpy} />)
    await openMenu()

    const colored = screen.getByText('colored').closest('[role="menuitem"]')?.querySelector('[class*="rounded-full"]')
    expect(colored?.getAttribute('style')).toContain('rgb(255, 0, 255)')

    const green = screen.getByText('green').closest('[role="menuitem"]')?.querySelector('[class*="rounded-full"]')
    expect(green?.className).toContain('bg-success')
    expect(screen.getByText('remote.state.connected')).toBeTruthy()

    const amber = screen.getByText('amber').closest('[role="menuitem"]')?.querySelector('[class*="rounded-full"]')
    expect(amber?.className).toContain('bg-warning')

    const red = screen.getByText('red').closest('[role="menuitem"]')?.querySelector('[class*="rounded-full"]')
    expect(red?.className).toContain('bg-danger')
    // 放弃态的原因入口（title 提示）
    expect(screen.getByText('red').closest('[title]')?.getAttribute('title')).toContain('refused')
  })

  it('触发按钮显示活动机器名与标识色点；无活动时显示本地', async () => {
    seedMachines([machineOf({ id: 'm1', name: 'alpha', color: '#123456', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })])
    remote.activeId = 'm1'
    remote.activeTunnelUrl = 'http://127.0.0.1:4001'
    const { unmount } = render(<RemoteSwitcher onManage={manageSpy} />)
    const trigger = screen.getByRole('button', { name: 'remote.switcher' })
    expect(trigger.textContent).toContain('alpha')
    // jsdom 将内联色归一为 rgb()（#123456 → rgb(18, 52, 86)）
    expect(trigger.querySelector('span[class*="rounded-full"]')?.getAttribute('style')).toContain('rgb(18, 52, 86)')
    unmount()

    remote.activeId = null
    remote.activeTunnelUrl = ''
    render(<RemoteSwitcher onManage={manageSpy} />)
    expect(screen.getByRole('button', { name: 'remote.switcher' }).textContent).toContain('remote.local')
  })
})

describe('remoteSwitcher 交互与降级', () => {
  it('未启用（或插件未加载）时壳层不渲染「本地」控件；启用后随下一轮轮询出现', async () => {
    engineEnabled = false
    remote.enabled = false
    render(<RemoteSwitcher onManage={manageSpy} />)
    // boot 首刷回报未启用：整枚控件缺席（不是禁用的死按钮）
    await vi.waitFor(() => {
      expect(remote.available).toBe(true)
    })
    expect(screen.queryByRole('button', { name: 'remote.switcher' })).toBeNull()

    // 用户在设置页启用后：聚焦触发的即时刷新让控件出现
    engineEnabled = true
    window.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => {
      expect(screen.getByRole('button', { name: 'remote.switcher' })).toBeTruthy()
    })
  })

  it('点击已连接机器项：切换视图（activeId/隧道 URL）', async () => {
    seedMachines([machineOf({ id: 'm1', name: 'alpha', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })])
    render(<RemoteSwitcher onManage={manageSpy} />)
    const menu = await openMenu()
    fireEvent.click(within(menu).getByText('alpha'))
    await waitFor(() => {
      expect(remote.activeId).toBe('m1')
      expect(remote.activeTunnelUrl).toBe('http://127.0.0.1:4001')
    })
  })

  it('点击本地项：回本地并撤销挂起切换', async () => {
    seedMachines([machineOf({ id: 'm1', name: 'alpha', state: 'connecting' })])
    remote.activeId = 'm1'
    remote.activeTunnelUrl = 'http://127.0.0.1:4001'
    remote.pendingId = 'm1'
    render(<RemoteSwitcher onManage={manageSpy} />)
    const menu = await openMenu()
    fireEvent.click(within(menu).getByText('remote.local'))
    await waitFor(() => {
      expect(remote.activeId).toBeNull()
      expect(remote.activeTunnelUrl).toBe('')
      expect(remote.pendingId).toBeNull()
    })
  })

  it('本地实例不可达：降级提示 + 远端项禁用（不弹错误风暴），恢复后自动复原', async () => {
    seedMachines([machineOf({ id: 'm1', name: 'alpha', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })])
    engineUnreachable = true
    render(<RemoteSwitcher onManage={manageSpy} />)
    // boot 首刷即不可达 → 降级
    await vi.waitFor(() => {
      expect(remote.available).toBe(false)
    })
    const menu = await openMenu()
    expect(within(menu).getByText('remote.degraded')).toBeTruthy()
    const item = within(menu).getByText('alpha').closest('[role="menuitem"]')
    expect(item?.getAttribute('aria-disabled')).toBe('true')

    // 轮询恢复（引擎重新可达）：窗口聚焦触发的即时刷新让切换器立即复原
    engineUnreachable = false
    window.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => {
      expect(remote.available).toBe(true)
    })
    await vi.waitFor(() => {
      expect(screen.queryByText('remote.degraded')).toBeNull()
    })
  })
})

describe('remoteSwitcher 增强（4.4）', () => {
  it('活动机器：状态点强制绿色 + 底部「断开当前连接」一键断开并回本地', async () => {
    seedMachines([machineOf({ id: 'm1', name: 'alpha', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })])
    remote.activeId = 'm1'
    remote.activeTunnelUrl = 'http://127.0.0.1:4001'
    render(<RemoteSwitcher onManage={manageSpy} />)
    const menu = await openMenu()

    const dot = within(menu).getByText('alpha').closest('[role="menuitem"]')?.querySelector('[class*="rounded-full"]')
    expect(dot?.className).toContain('bg-success')

    fireEvent.click(within(menu).getByText('remote.disconnect_active'))
    await waitFor(() => {
      expect(disconnectSpy).toHaveBeenCalledWith('m1')
    })
    expect(remote.activeId).toBeNull()
    expect(remote.activeTunnelUrl).toBe('')
  })

  it('无活动机器时不出现断开项', async () => {
    seedMachines([machineOf({ id: 'm1', name: 'alpha', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })])
    render(<RemoteSwitcher onManage={manageSpy} />)
    const menu = await openMenu()
    expect(within(menu).queryByText('remote.disconnect_active')).toBeNull()
  })

  it('重连机器显示重试倒计时；已知凭据类型缀在状态后', async () => {
    seedMachines([
      machineOf({ id: 'm1', name: 'alpha', state: 'reconnecting', nextRetryAt: Date.now() + 42_000 }),
      machineOf({ id: 'm2', name: 'beta', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4002', authMethod: 'key' }),
    ])
    render(<RemoteSwitcher onManage={manageSpy} />)
    const menu = await openMenu()
    const alpha = within(menu).getByText('alpha').closest('[role="menuitem"]')
    expect(alpha?.textContent).toContain('remote.retry_in')
    const beta = within(menu).getByText('beta').closest('[role="menuitem"]')
    expect(beta?.textContent).toContain('remote.auth.key')
  })
})

describe('remoteSwitcher 行内双动作（当前窗口 vs 新窗口）', () => {
  it('新窗口按钮常驻所有机器行：点击只发 remote_open_window，不触发切换', async () => {
    seedMachines([
      machineOf({ id: 'm1', name: 'alpha', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' }),
      machineOf({ id: 'm2', name: 'beta', state: 'disconnected' }),
    ])
    render(<RemoteSwitcher onManage={manageSpy} />)
    const menu = await openMenu()
    // 已连接与未连接行都有按钮（未连接开窗后由新窗口内壳层发起连接）
    const buttons = within(menu).getAllByRole('button', { name: 'remote.open_new_window' })
    expect(buttons.length).toBe(2)
    fireEvent.click(buttons[0]!)
    await waitFor(() => {
      expect(invokeSpy).toHaveBeenCalledWith('remote_open_window', { machineId: 'm1', url: 'http://127.0.0.1:4001' })
    })
    // 行本体语义未被连带触发：视图仍是本地
    expect(remote.activeId).toBeNull()
    expect(remote.pendingId).toBeNull()
  })

  it('未连接机器的新窗口按钮：url 置空（窗口内启动连接流程）', async () => {
    seedMachines([machineOf({ id: 'm2', name: 'beta', state: 'disconnected' })])
    render(<RemoteSwitcher onManage={manageSpy} />)
    const menu = await openMenu()
    const button = within(menu).getByRole('button', { name: 'remote.open_new_window' })
    fireEvent.click(button)
    await waitFor(() => {
      expect(invokeSpy).toHaveBeenCalledWith('remote_open_window', { machineId: 'm2', url: '' })
    })
    expect(remote.activeId).toBeNull()
  })

  it('机器行显示 user@host:port 副标题', async () => {
    seedMachines([machineOf({ id: 'm1', name: 'alpha', host: '10.1.1.1', port: 22, user: 'root', state: 'disconnected' })])
    render(<RemoteSwitcher onManage={manageSpy} />)
    const menu = await openMenu()
    expect(within(menu).getByText('root@10.1.1.1:22')).toBeTruthy()
  })
})
