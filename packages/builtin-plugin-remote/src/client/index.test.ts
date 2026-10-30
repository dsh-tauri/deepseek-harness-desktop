import type { ClientContext } from 'dsh-tauri/client'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import { RemoteSection } from './components/remote-section.tsx'
import { LOCALE_EFFECT, PLUGIN_ID, POLL_EFFECT, SECTION_EFFECT } from './constants/index'
import { apply, inject, name } from './index'
import { store } from './store/index'
import { answer, replies, resetWire, sent } from './test-utils/client-mock'

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
    inject: vi.fn((_slot: string, _callback: () => unknown) => vi.fn()),
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

function activateSection() {
  const { ctx, slots, effects } = scriptedCtx()
  apply(ctx)
  const section = effects.find(entry => entry.label === SECTION_EFFECT)
  expect(section).not.toBeUndefined()
  const dispose = section!.run.call(ctx) as () => void
  onTestFinished(dispose)
  return { slots, dispose }
}

beforeEach(() => {
  resetWire()
  store.machines.reset()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

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
    expect(sent).toEqual([])
  })

  it('registers the remote settings section only after a fresh local role confirmation', async () => {
    store.machines.setRole({ remote: true, origin: 'old' })
    let release!: (reply: ReturnType<typeof replies.ok>) => void
    const pending = new Promise<ReturnType<typeof replies.ok>>((resolve) => {
      release = resolve
    })
    answer(() => pending)
    const { slots, dispose } = activateSection()
    expect(slots.inject).not.toHaveBeenCalled()
    expect(slots.register).not.toHaveBeenCalled()
    expect(sent.map(call => call.url)).toEqual(['/api/tauri/remote/session/role'])

    release(replies.ok({ role: 'local', remote: false }))
    await vi.advanceTimersByTimeAsync(0)
    expect(slots.inject).toHaveBeenCalledTimes(1)
    expect(slots.inject).toHaveBeenCalledWith('settings.section', expect.any(Function))

    const contribution = slots.inject.mock.calls[0][1] as () => unknown
    contribution()
    const options = slots.register.mock.calls[0][0] as {
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
    expect(slots.register.mock.calls[0][1]).toBe(RemoteSection)
    expect(store.machines.role).toEqual({ remote: false })
    dispose()
    dispose()
    expect(slots.inject.mock.results[0].value).toHaveBeenCalledTimes(1)
  })

  it.each([
    replies.ok({ role: 'remote', remote: true, origin: 'ops' }),
    replies.ok({}),
    replies.ok({ remote: false }),
    replies.ok({ role: 'local', remote: true }),
    replies.ok({ role: 'remote', remote: false }),
    replies.ok({ role: 'local', remote: false, error: 'denied' }),
    replies.empty(),
    replies.http(404),
    replies.fail('denied', 403),
  ])('never registers the section from a cached local role when the probe is not local: %j', async (reply) => {
    store.machines.setRole({ remote: false })
    answer(() => reply)
    const { slots } = activateSection()
    await vi.advanceTimersByTimeAsync(0)
    expect(slots.inject).not.toHaveBeenCalled()
    expect(slots.register).not.toHaveBeenCalled()
    expect(sent.map(call => call.url)).toEqual(['/api/tauri/remote/session/role'])
  })

  it('does not register the section when the role request throws', async () => {
    store.machines.setRole({ remote: false })
    answer(() => {
      throw new Error('network offline')
    })
    const { slots } = activateSection()
    await vi.advanceTimersByTimeAsync(0)
    expect(slots.inject).not.toHaveBeenCalled()
    expect(slots.register).not.toHaveBeenCalled()
    expect(sent.map(call => call.url)).toEqual(['/api/tauri/remote/session/role'])
  })

  it('does not register the section after disposal while a local role probe is pending', async () => {
    let release!: (reply: ReturnType<typeof replies.ok>) => void
    const pending = new Promise<ReturnType<typeof replies.ok>>((resolve) => {
      release = resolve
    })
    answer(() => pending)
    const { slots, dispose } = activateSection()
    dispose()
    release(replies.ok({ role: 'local', remote: false }))
    await vi.advanceTimersByTimeAsync(0)
    expect(slots.inject).not.toHaveBeenCalled()
    expect(slots.register).not.toHaveBeenCalled()
    expect(sent.map(call => call.url)).toEqual(['/api/tauri/remote/session/role'])
  })
})
