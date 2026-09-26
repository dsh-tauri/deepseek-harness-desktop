import type { UiContext } from './types/index'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply as hostApply } from '../index'
import { SshSection } from './components/ssh-section.tsx'
import { apply, inject } from './index'
import { en, zh } from './locales/index'
import { desktopBridge } from './service/bridge'
import { MachinesStore } from './store/index'

// The desktop invoke bridge resolves through the runtime module table, which
// does not exist under vitest; the registrant tests only need its shape.
// (vitest hoists vi.mock above the imports, so placement here is safe.)
vi.mock('dsh-tauri/client', () => ({
  invoke: vi.fn(async () => undefined),
  defineRegister: (feature: (controller: unknown) => void) => feature,
}))

// dsh-tauri-ui/client 的 dist bundle 以 ModuleLoader 工厂包裹，脱离宿主加载器
// 无法在 node 求值；样式挂载只需要一个可观察的 mountStyle 桩，cssr 用源文件
// 实例（与 dsh-tauri-panel 的 cssr 测试同款做法）。
vi.mock('dsh-tauri-ui/client', async () => {
  const mod = await import('../../../dsh-tauri-ui/src/client/utils/cssr.ts')
  return { cssr: mod.cssr, mountStyle: vi.fn(() => () => {}) }
})

function scriptedCtx(): {
  ctx: UiContext
  locale: { register: ReturnType<typeof vi.fn>, bind: ReturnType<typeof vi.fn> }
  slots: { inject: ReturnType<typeof vi.fn>, register: ReturnType<typeof vi.fn> }
  effects: Array<() => void>
} {
  const locale = {
    register: vi.fn(),
    bind: vi.fn(() => (key: string) => `t:${key}`),
  }
  const slots = {
    inject: vi.fn(),
    register: vi.fn(() => 'registration'),
  }
  const effects: Array<() => void> = []
  const ctx = {
    effect: vi.fn((callback: () => void) => { effects.push(callback) }),
    get: vi.fn(() => undefined),
    locale,
    slots,
  } as unknown as UiContext
  return { ctx, locale, slots, effects }
}

describe('ui-ssh client plugin', () => {
  it('host half apply is a no-op', () => {
    expect(hostApply()).toBeUndefined()
  })

  it('declares its inject topology', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers the ssh dictionaries on activation', () => {
    const { ctx, locale, effects } = scriptedCtx()
    apply(ctx)
    expect(effects).toHaveLength(2)
    effects[0]?.()
    expect(locale.register).toHaveBeenCalledWith('ssh', { zh, en })
    expect(locale.bind).toHaveBeenCalledWith('ssh')
  })

  it('registers the single SSH settings section with a store-backed inject face', async () => {
    const { ctx, slots } = scriptedCtx()
    apply(ctx)
    expect(slots.inject).toHaveBeenCalledTimes(1)
    expect(slots.inject).toHaveBeenCalledWith('settings.section', expect.any(Function))
    const contribution = slots.inject.mock.calls[0]?.[1] as () => unknown
    contribution()
    const options = slots.register.mock.calls[0]?.[0] as {
      name: string
      id: string
      order: number
      label: () => string
      locale: string
      inject: () => Record<string, unknown>
    }
    expect(options.name).toBe('settings.section')
    expect(options.id).toBe('dsh-tauri-ssh')
    expect(options.order).toBe(50)
    expect(options.label()).toBe('t:nav')
    expect(options.locale).toBe('ssh')
    const injected = options.inject()
    expect(injected.store).toBeInstanceOf(MachinesStore)
    expect(injected.bridge).toBe(desktopBridge)
    // 机器管理与同步合并在同一个分区内（组件内部用 Tabs 分页）
    expect(slots.register.mock.calls[0]?.[1]).toBe(SshSection)
    // Drive one store load so the window.fetch thunk the plugin installed
    // actually executes (stubbed: no network in tests).
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true, value: { enabled: true, items: [] } }) }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    const store = injected.store as MachinesStore
    await store.load()
    expect(fetchMock).toHaveBeenCalledWith('/api-ssh', expect.objectContaining({ method: 'POST' }))
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})
