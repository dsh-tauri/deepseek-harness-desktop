import type { ClientContext } from 'dsh-tauri/client'
import { describe, expect, it, vi } from 'vitest'

import { NotifyWebhookSection } from './components/notify-webhook-section.tsx'
import { DELIVER_EFFECT, LOCALE_EFFECT, PLUGIN_ID, SECTION_EFFECT } from './constants/index'
import { apply, inject, name } from './index'

vi.mock('dsh-tauri/client', async () => {
  const seam = await import('./test-utils/client-mock')
  return {
    ...seam.clientMock,
    defineLocale: () => ({ NS: 'dsh-tauri-notify-webhook', text: (key: string) => `t:${key}`, registerLocale: () => () => {} }),
  }
})

vi.mock('dsh-tauri-ui/client', () => ({}))

interface ScriptedCtx {
  ctx: ClientContext
  slots: { inject: ReturnType<typeof vi.fn>, register: ReturnType<typeof vi.fn> }
  effects: { run: (this: unknown) => unknown, label: string }[]
}

function scriptedCtx(sessions?: unknown): ScriptedCtx {
  const slots = {
    inject: vi.fn((_slot: string, _callback: () => unknown) => () => {}),
    register: vi.fn(() => 'registration'),
  }
  const effects: { run: (this: unknown) => unknown, label: string }[] = []
  const ctx = {
    effect: (run: (this: unknown) => unknown, label: string) => { effects.push({ run, label }) },
    get: (key: string) => (key === 'sessions' ? sessions : undefined),
    locale: {},
    slots,
  } as unknown as ClientContext
  return { ctx, slots, effects }
}

describe('dsh-tauri-notify-webhook client plugin', () => {
  it('declares its inject topology and its plugin name', () => {
    expect(inject).toEqual(['slots', 'locale', 'sessions'])
    expect(name).toBe(PLUGIN_ID)
  })

  it('registers three declarative effects on activation and does no eager work', () => {
    const { ctx, slots, effects } = scriptedCtx()
    apply(ctx)
    expect(effects.map(entry => entry.label)).toEqual([LOCALE_EFFECT, SECTION_EFFECT, DELIVER_EFFECT])
    for (const entry of effects)
      expect(entry.run).toBeTypeOf('function')
    expect(slots.inject).not.toHaveBeenCalled()
    expect(slots.register).not.toHaveBeenCalled()
  })

  it('registers the single push settings section through the slots service', () => {
    const { ctx, slots, effects } = scriptedCtx()
    apply(ctx)
    const section = effects.find(entry => entry.label === SECTION_EFFECT)
    const dispose = section?.run.call(ctx)
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
      inject?: unknown
    }
    expect(options.name).toBe('settings.section')
    expect(options.id).toBe(PLUGIN_ID)
    expect(options.order).toBe(60)
    expect(options.label()).toBe('t:nav')
    expect(options.locale).toBe(PLUGIN_ID)
    expect(options.inject).toBeUndefined()
    expect(slots.register.mock.calls[0]?.[1]).toBe(NotifyWebhookSection)
    expect(dispose).toBeTypeOf('function')
    ;(dispose as () => void)()
  })

  it('survives activation without the sessions service', () => {
    const { ctx, effects } = scriptedCtx()
    apply(ctx)
    const deliver = effects.find(entry => entry.label === DELIVER_EFFECT)
    expect(() => deliver?.run.call(ctx)).not.toThrow()
  })

  it('subscribes to the session list and unsubscribes on dispose', () => {
    const listeners: (() => void)[] = []
    const unsubscribe = vi.fn()
    const sessions = {
      list: {
        getSnapshot: () => ({ ids: [], byId: {} }),
        subscribe: (listener: () => void) => {
          listeners.push(listener)
          return unsubscribe
        },
      },
    }
    const { ctx, effects } = scriptedCtx(sessions)
    apply(ctx)
    const deliver = effects.find(entry => entry.label === DELIVER_EFFECT)
    const dispose = deliver?.run.call(ctx) as () => void
    expect(listeners).toHaveLength(1)
    expect(listeners[0]).toBeTypeOf('function')
    dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
