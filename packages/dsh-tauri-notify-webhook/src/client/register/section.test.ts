// @vitest-environment node
import type { ClientContext } from 'dsh-tauri/client'
import { describe, expect, it, vi } from 'vitest'

import { PLUGIN_ID } from '../../shared/constants'
import { SETTINGS_SECTION_ID, SETTINGS_SECTION_ORDER, SETTINGS_SECTION_SLOT } from '../constants/index'
import { en } from '../locales/index'
import { sectionFeature } from './section'

// 真 `defineRegister` 在 effect 运行时才创建控制器与适配器；这里只验注册形状，
// 直接拿 setup 回调调用即可（与 `dsh-tauri-notification` 的注册测试同一套路）。
vi.mock('dsh-tauri/client', () => ({
  defineRegister: (setup: unknown) => setup,
  defineLocale: (namespace: string, dicts: { en: Record<string, string> }) => ({
    NS: namespace,
    text: (key: string) => dicts.en[key] ?? key,
    activeLocale: () => 'en',
    isEnglishLocale: () => true,
    useLocale: () => 'en',
    registerLocale: () => () => {},
  }),
}))

vi.mock('../components/notify-webhook-section', () => ({ NotifyWebhookSection: () => null }))

interface ScriptedCtx {
  controller: { add: ReturnType<typeof vi.fn> }
  ctx: ClientContext
  inject: ReturnType<typeof vi.fn>
  register: ReturnType<typeof vi.fn>
}

/** 只记账的槽位上下文：`inject` 立刻回放注册回调，注册形状当场可见。 */
function scriptedCtx(): ScriptedCtx {
  const inject = vi.fn((_slot: string, contribute: () => unknown) => contribute())
  const register = vi.fn((_options: unknown, _component: unknown) => 'registration')
  return {
    controller: { add: vi.fn() },
    ctx: { slots: { inject, register } } as unknown as ClientContext,
    inject,
    register,
  }
}

const run = sectionFeature as unknown as (controller: unknown, ctxValue: unknown) => void

describe('notify-webhook settings section registration', () => {
  it('把推送分区挂进设置页的区块槽位，并带上导航 label 与命名空间', () => {
    const { controller, ctx, inject, register } = scriptedCtx()
    run(controller, ctx)

    expect(inject).toHaveBeenCalledTimes(1)
    expect(inject.mock.calls[0]?.[0]).toBe(SETTINGS_SECTION_SLOT)
    expect(SETTINGS_SECTION_SLOT).toBe('settings.section')

    const options = register.mock.calls[0]?.[0] as Record<string, unknown>
    expect(options.name).toBe(SETTINGS_SECTION_SLOT)
    expect(options.id).toBe(SETTINGS_SECTION_ID)
    expect(SETTINGS_SECTION_ID).toBe(PLUGIN_ID)
    expect(options.order).toBe(SETTINGS_SECTION_ORDER)
    expect(SETTINGS_SECTION_ORDER).toBe(60)
    expect((options.label as () => string)()).toBe(en.nav)
    expect(options.locale).toBe(PLUGIN_ID)
  })

  it('分区注册句柄交给控制器回收，插件自己不另立清理路径', () => {
    const { controller, ctx, inject } = scriptedCtx()
    const unregister = vi.fn()
    inject.mockReturnValue(unregister)
    run(controller, ctx)
    expect(controller.add).toHaveBeenCalledTimes(1)
    expect(controller.add).toHaveBeenCalledWith(unregister)
  })
})
