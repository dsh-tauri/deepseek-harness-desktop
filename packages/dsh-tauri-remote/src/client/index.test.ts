import type { ClientContext } from 'dsh-tauri/client'
import { describe, expect, it, vi } from 'vitest'

import { RemoteSection } from './components/remote-section.tsx'
import { LOCALE_EFFECT, PLUGIN_ID, POLL_EFFECT, SECTION_EFFECT } from './constants/index'
import { apply, inject, name } from './index'

vi.mock('dsh-tauri/client', async () => {
  const seam = await import('./test-utils/client-mock')
  return {
    ...seam.clientMock,
    defineLocale: () => ({ NS: 'dsh-tauri-remote', text: (key: string) => `t:${key}`, registerLocale: () => () => {} }),
  }
})

vi.mock('dsh-tauri-ui/client', () => ({}))

interface ScriptedCtx {
  ctx: ClientContext
  slots: { inject: ReturnType<typeof vi.fn>, register: ReturnType<typeof vi.fn> }
  effects: { run: (this: unknown) => unknown, label: string }[]
}

function scriptedCtx(): ScriptedCtx {
  const slots = {
    inject: vi.fn((_slot: string, _callback: () => unknown) => () => {}),
    register: vi.fn(() => 'registration'),
  }
  const effects: { run: (this: unknown) => unknown, label: string }[] = []
  const ctx = {
    effect: (run: (this: unknown) => unknown, label: string) => { effects.push({ run, label }) },
    get: () => undefined,
    locale: {},
    slots,
  } as unknown as ClientContext
  return { ctx, slots, effects }
}

describe('dsh-tauri-remote client plugin', () => {
  it('declares its inject topology and its plugin name', () => {
    expect(inject).toEqual(['slots', 'locale'])
    expect(name).toBe(PLUGIN_ID)
  })

  it('registers three declarative effects on activation and does no eager work', () => {
    const { ctx, slots, effects } = scriptedCtx()
    apply(ctx)
    expect(effects.map(entry => entry.label)).toEqual([LOCALE_EFFECT, SECTION_EFFECT, POLL_EFFECT])
    for (const entry of effects)
      expect(entry.run).toBeTypeOf('function')
    expect(slots.inject).not.toHaveBeenCalled()
    expect(slots.register).not.toHaveBeenCalled()
  })

  it('registers the single remote settings section through the slots service', () => {
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
    expect(options.order).toBe(50)
    expect(options.label()).toBe('t:nav')
    expect(options.locale).toBe(PLUGIN_ID)
    expect(options.inject).toBeUndefined()
    expect(slots.register.mock.calls[0]?.[1]).toBe(RemoteSection)
    expect(dispose).toBeTypeOf('function')
    ;(dispose as () => void)()
  })
})
