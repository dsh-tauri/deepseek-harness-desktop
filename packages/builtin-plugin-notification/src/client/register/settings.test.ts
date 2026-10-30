import { describe, expect, it, vi } from 'vitest'
import { PLUGIN_ID } from '../../shared/constants'
import { NotificationSettingsGroup } from '../components/settings-group'
import { SETTINGS_GENERAL_ITEM_ID, SETTINGS_GENERAL_ITEM_ORDER, SETTINGS_GENERAL_ITEM_SLOT } from '../constants'
import { settingsFeature } from './settings'

// 真 `defineRegister` 会在 effect 运行时创建控制器与适配器；这里只验证注册形状，
// 直接拿 setup 回调调用即可（与 `dsh-tauri-remote` 的注册测试同一套路）。
vi.mock('dsh-tauri/client', () => ({
  defineLocale: (ns: string, dictionaries: Record<string, unknown>) => ({ NS: ns, ...dictionaries }),
  defineRegister: (setup: unknown) => setup,
}))

// `dsh-tauri-ui/client` 的 dist bundle 以 ModuleLoader 工厂包裹，脱离宿主加载器无法在 node
// 里求值；分组内容由 e2e 覆盖，这里只需要一个恒等引用。
vi.mock('../components/settings-group', () => ({ NotificationSettingsGroup: () => null }))

/** 只记账的槽位上下文：`inject` 立刻回放注册回调。 */
function scriptedCtx(): {
  controller: { add: ReturnType<typeof vi.fn> }
  ctx: unknown
  inject: ReturnType<typeof vi.fn>
  register: ReturnType<typeof vi.fn>
} {
  const inject = vi.fn((_slot: unknown, contribute: () => unknown) => contribute())
  const register = vi.fn((_options: unknown, _component: unknown) => 'registration')
  return { controller: { add: vi.fn() }, ctx: { slots: { inject, register } }, inject, register }
}

describe('notification settings registration', () => {
  it('把通知分组挂进官方「通用」设置页的条目槽位，且不带导航 label', () => {
    const { controller, ctx, inject, register } = scriptedCtx()
    const run = settingsFeature as unknown as (controller: unknown, ctxValue: unknown) => void
    run(controller, ctx)

    expect(inject).toHaveBeenCalledTimes(1)
    expect(inject.mock.calls[0]?.[0]).toBe(SETTINGS_GENERAL_ITEM_SLOT)
    expect(SETTINGS_GENERAL_ITEM_SLOT).toBe('settings.general.item')
    expect(SETTINGS_GENERAL_ITEM_ID).toBe('notification')
    expect(SETTINGS_GENERAL_ITEM_ORDER).toBe(30)

    const options = register.mock.calls[0]?.[0] as Record<string, unknown>
    expect(options.name).toBe(SETTINGS_GENERAL_ITEM_SLOT)
    expect(options.id).toBe(SETTINGS_GENERAL_ITEM_ID)
    // 夹在官方 developer-tools(15) 与 current-version(100) 之间。
    expect(options.order).toBe(SETTINGS_GENERAL_ITEM_ORDER)
    expect(options.registrant).toBe(PLUGIN_ID)
    expect(options.locale).toBe(PLUGIN_ID)
    expect((options.inject as () => unknown)()).toEqual({})
    // 条目不进左侧导航：官方条目同样没有 label。
    expect('label' in options).toBe(false)
    expect(options.children).toBeUndefined()

    expect(register.mock.calls[0]?.[1]).toBe(NotificationSettingsGroup)
    expect(controller.add).toHaveBeenCalledWith('registration')
  })
})
