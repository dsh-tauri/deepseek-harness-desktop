import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SlotRegistry, StoredEntry } from 'dsh-tauri/client'
import type { ComponentType } from 'react'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { createElement, memo, useState } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerSlotDecoration } from './slot-decoration'

const SLOT = 'conversation.hero.agentPreset'
const disposers: (() => void)[] = []

function fixture(declared = true, spec: object = { kind: 'single', scope: 'session-maybe' }, options: { wrap?: boolean, accept?: (entry: StoredEntry) => boolean } = {}) {
  const core = new SlotCore()
  const register = core.register.bind(core) as unknown as (options: Record<string, unknown>, component: ComponentType<Record<string, unknown>>) => () => void
  const declare = () => register({ name: 'root', children: { [SLOT]: spec } }, () => null)
  const slots = {
    spec: core.spec.bind(core),
    entries: core.entries.bind(core),
    entriesOfSlot: core.entriesOfSlot.bind(core),
    subscribe: core.subscribe.bind(core),
    onEntryError: core.onEntryError.bind(core),
    register: vi.fn(register.bind(core)),
    inject(key: string, setup: () => Iterable<() => void>) {
      let cleanups: (() => void)[] = []
      function clear(): void {
        for (const dispose of cleanups.splice(0).reverse())
          dispose()
      }
      function sync(): void {
        clear()
        if (core.specDynamic(key) !== undefined)
          cleanups = [...setup()]
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
  const warn = vi.fn()
  const dispose = registerSlotDecoration<typeof SLOT, { addition: string }>(slots as unknown as SlotRegistry, {
    slot: SLOT,
    scope: 'session-maybe',
    registrant: 'test-decoration',
    ...(options.wrap
      ? {
          mode: 'wrap',
          component: props => createElement(props.Original, { ...props, label: 'Locked' }),
        } as const
      : {
          component: props => createElement('button', {}, String(props.addition)),
        }),
    accept: options.accept,
    inject: () => ({ addition: 'Kernel' }),
    warn,
  })
  disposers.push(dispose)
  function add(priority = 0, extras: Record<string, unknown> = {}, component = memo((props: Record<string, unknown>) => {
    const [value] = useState('official state')
    return createElement('button', {}, `${String(props.label)}:${value}`)
  })) {
    return register({ name: SLOT, priority, locale: 'settings.agentPreset', ...extras }, component)
  }
  function winner(): StoredEntry {
    const entry = core.entriesOfSlot(SLOT)[0]
    if (entry === undefined)
      throw new Error('missing elected renderer')
    return entry
  }
  function render(props: Record<string, unknown> = { label: 'Preset', addition: 'Kernel' }): string {
    return renderToStaticMarkup(createElement(winner().component as ComponentType<Record<string, unknown>>, props))
  }
  return { core, slots, warn, declare, undeclare, dispose, add, winner, render }
}

afterEach(() => {
  for (const dispose of disposers.splice(0))
    dispose()
  vi.restoreAllMocks()
})

describe('official single-slot decoration', () => {
  it('renders the original hook-bearing component before the addition without calling it as a function', async () => {
    const feature = fixture()
    feature.add()
    await Promise.resolve()
    expect(feature.render()).toBe('<button>Preset:official state</button><button>Kernel</button>')
    expect(feature.slots.register).toHaveBeenCalledOnce()
    expect(feature.winner().options.priority).toBe(-1)
  })

  it('preserves locale and shared store and invokes the original inject with its original arguments', async () => {
    const feature = fixture()
    const store = { spec: {} }
    const inject = vi.fn((sessionId: string) => ({ label: `Preset ${sessionId}`, hooks: { preset: 'official-observable' } }))
    feature.add(-4, { store, inject })
    await Promise.resolve()
    const entry = feature.winner()
    expect(entry.locale).toBe('settings.agentPreset')
    expect(entry.store).toBe(store)
    expect(entry.options.priority).toBe(-5)
    const read = entry.inject as ((sessionId: string) => Record<string, unknown>) | undefined
    if (read === undefined)
      throw new Error('missing preserved inject')
    expect(read('session-a')).toEqual({ label: 'Preset session-a', hooks: { preset: 'official-observable' }, addition: 'Kernel' })
    expect(inject).toHaveBeenCalledExactlyOnceWith('session-a')
  })

  it('waits for the official declaration and never declares a private core slot', async () => {
    const feature = fixture(false)
    expect(feature.slots.register).not.toHaveBeenCalled()
    feature.declare()
    feature.add()
    await Promise.resolve()
    expect(feature.winner().registrant).toBe('test-decoration')
    expect(feature.core.snapshot()[0]?.children.map(item => item.name)).toEqual(['conversation.hero.agentPreset'])
  })

  it('replaces the decorator when the original registration changes without creating an update loop', async () => {
    const feature = fixture()
    const remove = feature.add()
    await Promise.resolve()
    const first = feature.winner()
    remove()
    feature.add(-2)
    await Promise.resolve()
    expect(feature.winner()).not.toBe(first)
    expect(feature.winner().options.priority).toBe(-3)
    await Promise.resolve()
    expect(feature.slots.register).toHaveBeenCalledTimes(2)
  })

  it('original unload prevents same-tick stale rendering and removes the decorator on notification', async () => {
    const feature = fixture()
    const remove = feature.add()
    await Promise.resolve()
    remove()
    expect(feature.render()).toBe('')
    await Promise.resolve()
    expect(feature.core.entries(SLOT)).toEqual([])
  })

  it('plugin unload restores only the original occupant and no later subscription recreates the decorator', async () => {
    const feature = fixture()
    feature.add()
    await Promise.resolve()
    feature.dispose()
    await Promise.resolve()
    expect(feature.render()).toBe('<button>Preset:official state</button>')
    expect(feature.core.entries(SLOT)).toHaveLength(1)
    expect(feature.slots.register).toHaveBeenCalledOnce()
  })

  it('declaration collapse disposes the old lifecycle and permits a clean later declaration', async () => {
    const feature = fixture()
    feature.add()
    await Promise.resolve()
    feature.undeclare?.()
    expect(feature.core.entries(SLOT)).toEqual([])
    feature.declare()
    feature.add()
    await Promise.resolve()
    expect(feature.render()).toBe('<button>Preset:official state</button><button>Kernel</button>')
    expect(feature.slots.register).toHaveBeenCalledTimes(2)
  })

  it('does not shadow an original component that declares child slots', async () => {
    const feature = fixture()
    feature.add(0, { children: { 'test.original.child': { kind: 'single', scope: 'session-maybe' } } })
    await Promise.resolve()
    expect(feature.slots.register).not.toHaveBeenCalled()
    expect(feature.warn).toHaveBeenCalledExactlyOnceWith('slot decoration unavailable; the official renderer cannot be safely composed')
    expect(feature.render()).toBe('<button>Preset:official state</button>')
  })

  it.each([{ kind: 'list', scope: 'session-maybe' }, { kind: 'single', scope: 'root' }])('contract %j disables the decorator before registration', (spec) => {
    const feature = fixture(true, spec)
    expect(feature.slots.register).not.toHaveBeenCalled()
    expect(feature.warn).toHaveBeenCalledExactlyOnceWith('slot decoration unavailable; the official slot contract differs')
  })

  it('a retired original keeps its surviving official fallback rather than being revived by a decorator', async () => {
    const feature = fixture()
    feature.add(-2)
    feature.add(1, {}, memo(() => createElement('button', {}, 'Survivor')))
    const entry = feature.core.entries(SLOT).find(item => item.options.priority === -2)
    if (entry === undefined)
      throw new Error('missing original renderer')
    feature.core.reportEntryError(SLOT, entry, new Error('official crashed'), { abdicate: true })
    await Promise.resolve()
    expect(feature.render()).toBe('<button>Survivor</button>')
    expect(feature.slots.register).not.toHaveBeenCalled()
  })

  it('a crashing decorator abdicates without automatic re-registration or loss of the original', async () => {
    const feature = fixture()
    feature.add()
    await Promise.resolve()
    const entry = feature.winner()
    feature.core.reportEntryError(SLOT, entry, new Error('addition crashed'), { abdicate: true })
    await Promise.resolve()
    expect(feature.render()).toBe('<button>Preset:official state</button>')
    expect(feature.slots.register).toHaveBeenCalledOnce()
    expect(feature.core.entries(SLOT)).toHaveLength(1)
    expect(feature.warn).toHaveBeenCalledWith('slot decoration disabled after renderer retirement; the official fallback is preserved')
  })

  it('wrap mode renders the original exactly once through a normal React component boundary', async () => {
    const feature = fixture(true, { kind: 'single', scope: 'session-maybe' }, { wrap: true })
    feature.add()
    await Promise.resolve()
    expect(feature.render()).toBe('<button>Locked:official state</button>')
    expect(feature.winner().options.priority).toBe(-1)
    feature.dispose()
    await Promise.resolve()
    expect(feature.render()).toBe('<button>Preset:official state</button>')
  })

  it('unverified original capabilities keep the original renderer unchanged', async () => {
    const accept = vi.fn(() => false)
    const feature = fixture(true, { kind: 'single', scope: 'session-maybe' }, { accept })
    feature.add()
    await Promise.resolve()
    expect(accept).toHaveBeenCalledOnce()
    expect(feature.slots.register).not.toHaveBeenCalled()
    expect(feature.render()).toBe('<button>Preset:official state</button>')
    expect(feature.warn).toHaveBeenCalledExactlyOnceWith('slot decoration unavailable; the official renderer capability is unverified')
  })

  it('missing public registration APIs do not claim the official slot', () => {
    const warn = vi.fn()
    const dispose = registerSlotDecoration(undefined, { slot: SLOT, scope: 'session-maybe', registrant: 'test', component: () => null, inject: () => ({}), warn })
    dispose()
    expect(warn).toHaveBeenCalledExactlyOnceWith('slot decoration unavailable; official registration APIs are missing')
  })
})
