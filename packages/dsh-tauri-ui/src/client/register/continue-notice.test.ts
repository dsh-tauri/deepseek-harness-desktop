import type { ComponentType } from 'react'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { createElement, memo } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerContinueNotice } from './continue-notice'

vi.mock('dsh-tauri/client', async () => ({
  ...await import('../../../../dsh-tauri/src/client/register'),
  ...await import('../../../../dsh-tauri/src/client/modules/lodash-es'),
}))

const SLOT = 'conversation.chat.node'
const cleanups: Array<() => void> = []

function setup(declared = true) {
  const core = new SlotCore()
  const declare = () => core.register({
    name: 'root',
    children: { [SLOT]: { kind: 'keyed', scope: 'session' } },
  } as never, (() => null) as never)
  const slots = {
    spec: core.spec.bind(core),
    entries: core.entries.bind(core),
    entriesOfSlot: core.entriesOfSlot.bind(core),
    subscribe: core.subscribe.bind(core),
    register: vi.fn(core.register.bind(core)),
    inject(key: string, callback: () => Iterable<() => void>) {
      let disposers: Array<() => void> = []
      const clear = () => {
        for (const dispose of disposers.splice(0).reverse())
          dispose()
      }
      const sync = () => {
        clear()
        if (core.specDynamic(key) !== undefined)
          disposers = [...callback()]
      }
      const unsubscribe = core.subscribeDeclaration(key, sync)
      sync()
      return () => {
        unsubscribe()
        clear()
      }
    },
  }
  const undeclare = declared ? declare() : undefined
  const ctx = { get: (name: string) => name === 'slots' ? slots : undefined }
  const dispose = registerContinueNotice.call(ctx)
  cleanups.push(dispose)
  const add = (key: string, priority = 0, extra = {}) => core.register({
    name: SLOT,
    key,
    priority,
    locale: 'chat',
    registrant: 'official-chat',
    ...extra,
  } as never, memo((props: Record<string, unknown>) => createElement('button', {}, String(props.label))) as never)
  const render = (key: string, source: unknown, label = 'Original request') => {
    const entry = core.entriesOfSlot(SLOT).find(entry => entry.options.key === key)
    expect(entry, `Missing ${key} renderer`).not.toBeUndefined()
    return renderToStaticMarkup(createElement(entry!.component as ComponentType<Record<string, unknown>>, {
      node: Object.freeze({ data: Object.freeze({ source }) }),
      label,
    }))
  }
  return { core, slots, add, render, dispose, declare, undeclare, ctx }
}

afterEach(() => {
  for (const dispose of cleanups.splice(0))
    dispose()
  vi.restoreAllMocks()
})

describe('continue notice rendering', () => {
  it.each(['turn-trigger', 'context'])('hides only the continue source in %s', async (key) => {
    const h = setup()
    h.add(key)
    await Promise.resolve()
    expect(h.render(key, Object.freeze({ kind: 'continue' }))).toBe('<span data-dsh-tauri-ui-continue-notice="" hidden=""></span>')
    expect(h.render(key, { kind: 'continue', recovery: 'content-risk' })).not.toContain('Original request')
    expect(h.render(key, { kind: 'schedule' })).toBe('<button>Original request</button>')
    expect(h.render(key, { kind: 'content-risk-recovery' }, 'Safe recovery boundary')).toBe('<button>Safe recovery boundary</button>')
    expect(h.render(key, { kind: 'user' }, '继续')).toBe('<button>继续</button>')
    expect(h.render(key, undefined)).toBe('<button>Original request</button>')
  })

  it('waits for the declaration and preserves the original registration shares', async () => {
    const h = setup(false)
    expect(h.slots.register).not.toHaveBeenCalled()
    h.declare()
    const inject = () => ({ extra: 'injected' })
    h.add('turn-trigger', -4, { inject })
    await Promise.resolve()
    expect(h.slots.register.mock.calls[0]?.[0]).toMatchObject({
      name: SLOT,
      key: 'turn-trigger',
      priority: -5,
      locale: 'chat',
      inject,
    })
    expect(h.render('turn-trigger', { kind: 'continue' })).not.toContain('Original request')
  })

  it('rebinds after replacement without repeatedly registering itself', async () => {
    const h = setup()
    const remove = h.add('turn-trigger')
    await Promise.resolve()
    const first = h.core.entriesOfSlot(SLOT)[0]
    await Promise.resolve()
    expect(h.slots.register).toHaveBeenCalledTimes(1)
    remove()
    h.add('turn-trigger', -2)
    await Promise.resolve()
    expect(h.core.entriesOfSlot(SLOT)[0]).not.toBe(first)
    expect(h.slots.register).toHaveBeenCalledTimes(2)
    await Promise.resolve()
    expect(h.slots.register).toHaveBeenCalledTimes(2)
  })

  it('unloads the wrapper when the original disappears or the plugin disposes', async () => {
    const h = setup()
    const remove = h.add('turn-trigger')
    await Promise.resolve()
    remove()
    await Promise.resolve()
    expect(h.core.entries(SLOT)).toEqual([])
    h.add('turn-trigger')
    await Promise.resolve()
    h.dispose()
    await Promise.resolve()
    expect(h.core.entries(SLOT)).toHaveLength(1)
    expect(h.render('turn-trigger', { kind: 'continue' })).toBe('<button>Original request</button>')
  })

  it.each(['install', 'replacement'])('preserves the live fallback when the raw head retired before %s', async (phase) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = setup()
    if (phase === 'install') {
      h.dispose()
    }
    else {
      const remove = h.add('turn-trigger')
      await Promise.resolve()
      remove()
      h.slots.register.mockClear()
    }
    h.add('turn-trigger', -2)
    h.core.register({ name: SLOT, key: 'turn-trigger', priority: 1 } as never, (() => createElement('button', {}, 'Survivor')) as never)
    const retired = h.core.entries(SLOT).find(entry => entry.options.priority === -2)!
    h.core.reportEntryError(SLOT, retired, new Error('Retired renderer'), { abdicate: true })
    if (phase === 'install')
      cleanups.push(registerContinueNotice.call(h.ctx))
    await Promise.resolve()
    expect(h.render('turn-trigger', { kind: 'schedule' })).toBe('<button>Survivor</button>')
    expect(h.render('turn-trigger', { kind: 'continue' })).toBe('<button>Survivor</button>')
    expect(h.slots.register).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('continue'))
  })

  it('does not shadow a renderer that owns child slots', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = setup()
    h.add('turn-trigger', 0, { children: { 'notice.child': { kind: 'single', scope: 'session' } } })
    await Promise.resolve()
    expect(h.slots.register).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('continue'))
    expect(h.render('turn-trigger', { kind: 'schedule' })).toBe('<button>Original request</button>')
  })
})
