// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopSettings } from '../ui/desktop-settings'
import { registerDesktopSettings } from './desktop-settings'

const mocks = vi.hoisted(() => ({ mobile: false, invokeParent: vi.fn(), language: 'zh' }))

vi.mock('dsh-tauri/client', () => ({
  defineRegister: (setup: unknown) => setup,
  detectMobileDevice: () => mocks.mobile,
  invokeParent: mocks.invokeParent,
  defineLocale: (_id: string, dictionaries: Record<string, Record<string, string>>) => ({
    NS: 'dsh-tauri-ui',
    useLocale: () => mocks.language,
    text: (key: string) => dictionaries[mocks.language]![key],
  }),
}))
vi.mock('../components/button', async () => ({ Button: (await import('@deepseek-ai/dsh-client-ui-primitives')).Button }))

afterEach(() => {
  cleanup()
  mocks.mobile = false
  mocks.language = 'zh'
  mocks.invokeParent.mockReset()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

function register() {
  const dispose = vi.fn()
  const add = vi.fn()
  const slots = {
    inject: vi.fn((_name: string, contribute: () => unknown) => contribute()),
    register: vi.fn(() => dispose),
  }
  const setup = registerDesktopSettings as unknown as (controller: unknown, ctx: unknown) => void
  setup({ add }, { slots })
  return { slots, add, dispose }
}

describe('desktop general settings entry', () => {
  it('registers before existing general rows without adding navigation and owns disposal', () => {
    vi.stubGlobal('dshDesktop', {})
    const { slots, add, dispose } = register()
    expect(slots.inject).toHaveBeenCalledWith('settings.general.item', expect.any(Function))
    expect(slots.register).toHaveBeenCalledWith({
      name: 'settings.general.item',
      id: 'desktop-settings',
      order: Number.MIN_SAFE_INTEGER,
      registrant: 'dsh-tauri-ui',
      inject: expect.any(Function),
    }, DesktopSettings)
    expect(add).toHaveBeenCalledWith(dispose)
  })

  it.each(['browser', 'mobile'])('does not offer desktop settings in %s', (environment) => {
    if (environment === 'mobile') {
      vi.stubGlobal('dshDesktop', {})
      mocks.mobile = true
    }
    const { slots } = register()
    expect(slots.inject).not.toHaveBeenCalled()
    expect(slots.register).not.toHaveBeenCalled()
  })

  it.each(['rejected', 'missing-host'])('shows an error when the bridge is %s', (failure) => {
    if (failure === 'rejected') {
      mocks.invokeParent.mockReturnValue({ ok: false })
    }
    else {
      mocks.invokeParent.mockImplementation(() => {
        throw new Error('NO_HOST')
      })
    }
    const view = render(<DesktopSettings />)
    fireEvent.click(view.getByRole('button', { name: '打开设置' }))
    expect(view.getByRole('alert').textContent).toBe('打开桌面端设置失败，请重试。')
  })

  it.each([
    ['zh', '桌面端设置', '配置桌面端的开机自启动、窗口关闭行为、服务端口、网络代理及命令行集成等选项。', '打开设置'],
    ['en', 'Desktop settings', 'Configure launch at startup, window close behavior, server port, network proxy, command-line integration, and other desktop options.', 'Open settings'],
  ])('renders %s copy and requests desktop configuration without navigating official settings', (language, title, description, button) => {
    mocks.language = language!
    mocks.invokeParent.mockReturnValue({ ok: true })
    const view = render(<DesktopSettings />)
    expect(view.getByText(title!).textContent).toBe(title)
    expect(view.getByText(description!).textContent).toBe(description)
    fireEvent.click(view.getByRole('button', { name: button }))
    expect(mocks.invokeParent).toHaveBeenCalledExactlyOnceWith({ type: 'dsh://desktop-settings:open' })
    expect(view.getByText(title!).isConnected).toBe(true)
  })
})
