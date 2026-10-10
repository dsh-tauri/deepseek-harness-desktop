import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { RegisterEffect } from 'dsh-tauri/client'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ScheduleCatalogAction } from '../components/schedule-catalog-action'
import { ScheduleDeletionOverlay } from '../components/schedule-deletion-overlay'
import { ScheduleTurnCard } from '../components/schedule-turn-card'
import { SessionScheduleHover } from '../components/session-schedule-hover'
import { SessionScheduleMark } from '../components/session-schedule-mark'
import { scheduleTurnDefinition } from '../service/schedule-turn'
import { store } from '../store'
import { ambientFeature } from './ambient'

vi.mock('dsh-tauri/client', async () => ({
  ...await import('../../../../dsh-tauri/src/client/register'),
  ...await import('../../../../dsh-tauri/src/client/modules/valtio-define'),
  ...await import('../../../../dsh-tauri/src/client/locale'),
  noop: () => {},
}))
vi.mock('../components/schedule-catalog-action', () => ({ ScheduleCatalogAction: () => null }))
vi.mock('../components/schedule-deletion-overlay', () => ({ ScheduleDeletionOverlay: () => null }))
vi.mock('../components/schedule-turn-card', () => ({ ScheduleTurnCard: () => null }))
vi.mock('../components/session-schedule-mark', () => ({ SessionScheduleMark: () => null }))
vi.mock('../components/session-schedule-hover', () => ({ SessionScheduleHover: () => null }))

interface Entry {
  name: string
  id: string
  locale: string
  order?: number
  inject?: (sessionId: string) => { sessionId?: string, openTaskDetail?: (id: string) => void }
}

const seats = {
  'conversation.chat.turnTail': { kind: 'list', scope: 'session' },
  'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
  'sidebar.session.row.leading': { kind: 'list', scope: 'root' },
  'sidebar.session.row.hover': { kind: 'list', scope: 'root' },
  'shell.overlay': { kind: 'list', scope: 'root' },
}

function runtime(initial: Record<string, { kind: string, scope: string }> = seats) {
  const specs = new Map(Object.entries(initial))
  const pending = new Map<string, { setup: () => () => void, active?: () => void }>()
  const active = new Map<string, { entry: Entry, component: unknown }>()
  const entryDisposals = vi.fn()
  const injectDisposals = vi.fn()
  const slots = {
    spec: vi.fn((name: string) => specs.get(name)),
    inject: vi.fn((name: string, setup: () => () => void) => {
      const record = { setup, active: specs.has(name) ? setup() : undefined }
      pending.set(name, record)
      return () => {
        if (pending.get(name) !== record)
          return
        record.active?.()
        record.active = undefined
        pending.delete(name)
        injectDisposals(name)
      }
    }),
    register: vi.fn((entry: Entry, component: unknown) => {
      active.set(entry.id, { entry, component })
      let disposed = false
      return () => {
        if (disposed)
          return
        disposed = true
        active.delete(entry.id)
        entryDisposals(entry.id)
      }
    }),
  }
  const eventDisposal = vi.fn()
  const events = { register: vi.fn(() => eventDisposal) }
  return {
    slots,
    events,
    active,
    pending,
    entryDisposals,
    injectDisposals,
    eventDisposal,
    context: { slots, uiConversation: { events } },
    declare(name: string, spec = { kind: 'list', scope: 'root' }) {
      pending.get(name)?.active?.()
      specs.set(name, spec)
      const waiting = pending.get(name)
      if (waiting)
        waiting.active = waiting.setup()
    },
    collapse(name: string) {
      const waiting = pending.get(name)
      waiting?.active?.()
      if (waiting)
        waiting.active = undefined
      specs.delete(name)
    },
  }
}

const cleanups: (() => void)[] = []

function mount(context: object) {
  const dispose = ambientFeature.call(context)
  cleanups.push(dispose)
  return dispose
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  store.navigation.$patch({ target: null, seq: 0, error: '' })
})

afterEach(() => {
  for (const dispose of cleanups.splice(0))
    dispose()
  vi.restoreAllMocks()
})

describe('ambient public registration lifecycle', () => {
  it('keeps its deletion overlay alongside the official native schedule entry without stealing its id', () => {
    const core = new SlotCore()
    const root = core.register({ name: 'root', children: { 'shell.overlay': { kind: 'list', scope: 'root' } } }, (props: PropsRenderSlots<'shell.overlay'>) => props.renderSlot('shell.overlay', {}))
    cleanups.push(root)
    const native = core.register({ name: 'shell.overlay', id: 'schedule.delete-toast' }, () => null)
    cleanups.push(native)
    const slots = {
      spec: core.specDynamic.bind(core),
      inject: (name: string, setup: () => () => void) => core.specDynamic(name) ? setup() : () => {},
      register: core.register.bind(core),
    }
    const dispose = mount({ slots })
    expect(core.entriesOfSlot('shell.overlay').map(entry => entry.options.id)).toEqual(['schedule.delete-toast', 'dsh-tauri-scheduler.delete-toast'])
    dispose()
    expect(core.entriesOfSlot('shell.overlay').map(entry => entry.options.id)).toEqual(['schedule.delete-toast'])
  })

  it('registers exact public entries and the state-only turn definition', () => {
    const host = runtime()
    mount(host.context)
    expect(host.events.register).toHaveBeenCalledExactlyOnceWith(scheduleTurnDefinition)
    expect(host.slots.register.mock.calls.map(([entry, component]) => [entry.name, entry.id, entry.order, entry.locale, component])).toEqual([
      ['conversation.chat.turnTail', 'schedule-created', 20, 'dsh-tauri-scheduler', ScheduleTurnCard],
      ['conversation.session.header.utilities', 'schedule-catalog', -5, 'dsh-tauri-scheduler', ScheduleCatalogAction],
      ['sidebar.session.row.leading', 'schedule-mark', 10, 'dsh-tauri-scheduler', SessionScheduleMark],
      ['sidebar.session.row.hover', 'schedule-tasks', 10, 'dsh-tauri-scheduler', SessionScheduleHover],
      ['shell.overlay', 'dsh-tauri-scheduler.delete-toast', undefined, 'dsh-tauri-scheduler', ScheduleDeletionOverlay],
    ])
    expect(console.warn).not.toHaveBeenCalled()
    host.active.get('schedule-created')!.entry.inject!('owner').openTaskDetail!('created-task')
    expect(store.navigation.target).toEqual({ id: 'created-task', sessionId: 'owner' })
    const header = host.active.get('schedule-catalog')!.entry.inject!('other-owner')
    expect(header.sessionId).toBe('other-owner')
    header.openTaskDetail!('existing-task')
    expect(store.navigation.target).toEqual({ id: 'existing-task', sessionId: 'other-owner' })
  })

  it('owns all slot/event disposers, is idempotent, and leaves no duplicate entries after HMR', () => {
    const host = runtime()
    const dispose = mount(host.context)
    expect(host.active.size).toBe(5)
    dispose()
    dispose()
    expect(host.active.size).toBe(0)
    expect(host.pending.size).toBe(0)
    expect(host.entryDisposals).toHaveBeenCalledTimes(5)
    expect(host.injectDisposals).toHaveBeenCalledTimes(5)
    expect(host.eventDisposal).toHaveBeenCalledTimes(1)
    mount(host.context)
    expect(host.active.size).toBe(5)
    expect(host.pending.size).toBe(5)
    expect(host.events.register).toHaveBeenCalledTimes(2)
  })

  it('waits for late seat declaration and tears down a collapsed seat without DOM fallback', () => {
    const { 'sidebar.session.row.leading': _leading, ...initial } = seats
    const host = runtime(initial)
    mount(host.context)
    expect(host.active.has('schedule-mark')).toBe(false)
    expect(console.warn).toHaveBeenCalledWith('[scheduler ambient] Public seat sidebar.session.row.leading unavailable; disabled until declared.')
    host.declare('sidebar.session.row.leading')
    expect(host.active.has('schedule-mark')).toBe(true)
    host.collapse('sidebar.session.row.leading')
    expect(host.active.has('schedule-mark')).toBe(false)
    host.declare('sidebar.session.row.leading')
    expect(host.active.has('schedule-mark')).toBe(true)
    expect(host.entryDisposals).toHaveBeenCalledWith('schedule-mark')
  })

  it('warns and disables optional missing services or incompatible seats instead of guessing internals', () => {
    mount({})
    expect(console.warn).toHaveBeenCalledWith('[scheduler ambient] Public slot spec/inject/register capability unavailable; ambient surfaces disabled.')
    const host = runtime({ ...seats, 'sidebar.session.row.hover': { kind: 'slot', scope: 'session' } })
    mount({ slots: host.slots })
    expect(host.active.has('schedule-created')).toBe(false)
    expect(host.active.has('schedule-tasks')).toBe(false)
    expect(host.active.has('schedule-catalog')).toBe(true)
    expect(host.active.has('dsh-tauri-scheduler.delete-toast')).toBe(true)
    expect(console.warn).toHaveBeenCalledWith('[scheduler ambient] uiConversation.events.register unavailable; created turn cards disabled.')
    expect(console.warn).toHaveBeenCalledWith('[scheduler ambient] Public seat sidebar.session.row.hover incompatible; expected list/root.')
  })

  it('isolates a failed seat registration while keeping other optional surfaces usable', () => {
    const host = runtime()
    const register = host.slots.register.getMockImplementation()!
    host.slots.register.mockImplementation((entry, component) => {
      if (entry.id === 'schedule-mark')
        throw new Error('unsupported owner')
      return register(entry, component)
    })
    expect(() => mount(host.context)).not.toThrow()
    expect(host.active.has('schedule-mark')).toBe(false)
    expect(host.active.has('schedule-tasks')).toBe(true)
    expect(console.warn).toHaveBeenCalledWith('[scheduler ambient] Public seat sidebar.session.row.leading registration failed; surface disabled.', expect.objectContaining({ message: 'unsupported owner' }))
  })

  it('defers turn definition until uiConversation arrives and disposes it on service replacement/unload', () => {
    const host = runtime()
    let available = false
    let dependency: ((scope: object) => unknown) | undefined
    let effectCleanup: (() => void) | undefined
    const fiberDisposal = vi.fn(() => {
      effectCleanup?.()
      effectCleanup = undefined
    })
    const context = {
      slots: host.slots,
      get: (name: string) => name === 'slots' ? host.slots : name === 'uiConversation' && available ? { events: host.events } : undefined,
      effect: (effect: RegisterEffect) => {
        effectCleanup = effect.call(context)
        return effectCleanup
      },
      inject: vi.fn((services: string[], callback: (scope: object) => unknown) => {
        expect(services).toEqual(['uiConversation'])
        dependency = callback
        return { dispose: fiberDisposal }
      }),
    }
    const dispose = mount(context)
    expect(host.events.register).not.toHaveBeenCalled()
    expect(host.active.has('schedule-created')).toBe(false)
    expect(console.warn).toHaveBeenCalledWith('[scheduler ambient] uiConversation unavailable; created turn cards disabled until declared.')
    available = true
    dependency!(context)
    expect(host.events.register).toHaveBeenCalledTimes(1)
    expect(host.active.has('schedule-created')).toBe(true)
    effectCleanup!()
    expect(host.active.has('schedule-created')).toBe(false)
    expect(host.eventDisposal).toHaveBeenCalledTimes(1)
    dependency!(context)
    expect(host.active.has('schedule-created')).toBe(true)
    dispose()
    expect(fiberDisposal).toHaveBeenCalledTimes(1)
    expect(host.eventDisposal).toHaveBeenCalledTimes(2)
    expect(host.active.size).toBe(0)
    dependency!(context)
    expect(host.events.register).toHaveBeenCalledTimes(2)
    expect(host.active.size).toBe(0)
  })
})
