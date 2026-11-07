// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { shortcutsFeature } from './shortcuts'

const { emit, listen } = vi.hoisted(() => ({
  emit: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn().mockResolvedValue(() => {}),
}))
vi.mock('../service/tauri', () => ({ emit, listen }))

let dispose: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  vi.useRealTimers()
  vi.clearAllMocks()
})

it('publishes the latest catalog after a registration burst and never restores disposed commands', () => {
  vi.useFakeTimers()
  let rows: unknown[] = []
  const subscribers = new Set<() => void>()
  const catalog = {
    getSnapshot: () => rows,
    subscribe: (listener: () => void) => {
      subscribers.add(listener)
      return () => subscribers.delete(listener)
    },
  }
  dispose = shortcutsFeature.call({ get: () => ({ catalog }) })
  expect(emit).toHaveBeenCalledExactlyOnceWith('dsh://shortcuts', { rows: [] })

  for (let index = 0; index < 100; index++) {
    rows = [{ id: 'terminal.new', label: `Terminal ${index}`, keys: ['⌘', 'J'], binding: { code: 'KeyJ', modifiers: ['meta'] } }]
    for (const listener of subscribers) listener()
  }
  vi.advanceTimersByTime(1)
  expect(emit).toHaveBeenCalledTimes(2)
  expect(emit.mock.lastCall).toEqual(['dsh://shortcuts', {
    rows: [{ id: 'terminal.new', label: 'Terminal 99', keys: ['⌘', 'J'], available: true }],
  }])

  rows = [{ id: 'terminal.new', label: 'Terminal disabled', keys: [] }]
  for (const listener of subscribers) listener()
  vi.advanceTimersByTime(1)
  expect(emit.mock.lastCall).toEqual(['dsh://shortcuts', {
    rows: [{ id: 'terminal.new', label: 'Terminal disabled', keys: [], available: false }],
  }])

  rows = [{ id: 'terminal.new', label: 'Stale terminal', keys: ['⌘', 'J'], binding: { code: 'KeyJ', modifiers: ['meta'] } }]
  for (const listener of subscribers) listener()
  dispose()
  expect(subscribers.size).toBe(0)
  expect(emit.mock.lastCall).toEqual(['dsh://shortcuts', { rows: [] }])
  const calls = emit.mock.calls.length
  vi.advanceTimersByTime(100)
  expect(emit).toHaveBeenCalledTimes(calls)
})
