import type { TaskFormState } from '../types'
import type { TaskTabPage } from '../types/task-tab'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskTabBindings, taskTabParams } from './task-tab-bindings'

const PAGE: TaskTabPage = { id: 'page-1', kind: 'scheduleTask', contentId: 'task-content' }
const OTHER_PAGE: TaskTabPage = { id: 'page-2', kind: 'scheduleTask', contentId: 'other-content' }
const KEY = 'dsh.schedule.task-tab.v1.owner'

function storage() {
  const values = new Map<string, string>()
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value) }),
    removeItem: vi.fn((key: string) => { values.delete(key) }),
  }
}

function form(): TaskFormState {
  return {
    delivery: 'this-session',
    sessionId: 'linked',
    enabled: true,
    name: 'Private draft title',
    prompt: 'Private draft prompt',
    schedule: { kind: 'daily', time: '08:00', timeZone: 'UTC' },
    workspaceId: '',
    permission: '',
    provider: '',
    model: '',
    reasoningEffort: '',
  }
}

let persisted: ReturnType<typeof storage>

beforeEach(() => {
  persisted = storage()
  vi.stubGlobal('localStorage', persisted)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('taskTabBindings identity persistence', () => {
  it('restores only identity after reload rather than a task snapshot', () => {
    const bindings = new TaskTabBindings()
    const target = { id: 'task-1', sessionId: 'linked', name: 'Private title', prompt: 'Private prompt', enabled: false }
    bindings.write('owner', PAGE, target)

    expect(JSON.parse(persisted.values.get(KEY)!)).toEqual({
      'page-1': { kind: 'scheduleTask', contentId: 'task-content', id: 'task-1', sessionId: 'linked' },
    })
    expect(new TaskTabBindings().read('owner', PAGE)).toEqual({ id: 'task-1', sessionId: 'linked' })
    expect(persisted.values.get(KEY)).not.toContain('Private')
    expect(persisted.values.get(KEY)).not.toContain('enabled')
  })

  it('isolates page identity by owning session and page id', () => {
    const bindings = new TaskTabBindings()
    bindings.write('owner', PAGE, { id: 'task-1' })
    bindings.write('other-owner', PAGE, { id: 'task-2', sessionId: 'other-link' })
    bindings.write('owner', OTHER_PAGE, { id: 'task-3' })

    const reloaded = new TaskTabBindings()
    expect(reloaded.read('owner', PAGE)).toEqual({ id: 'task-1', sessionId: undefined })
    expect(reloaded.read('other-owner', PAGE)).toEqual({ id: 'task-2', sessionId: 'other-link' })
    expect(reloaded.read('owner', OTHER_PAGE)).toEqual({ id: 'task-3', sessionId: undefined })
    expect(reloaded.read('missing-owner', PAGE)).toBeUndefined()
    expect(reloaded.read('owner', { ...PAGE, id: 'missing-page' })).toBeUndefined()
  })

  it('does not persist draft contents or their initial form', () => {
    const bindings = new TaskTabBindings()
    bindings.write('owner', PAGE, { draft: true, sessionId: 'linked', initial: form() })

    expect(bindings.read('owner', PAGE)).toBeUndefined()
    expect(new TaskTabBindings().read('owner', PAGE)).toBeUndefined()
    expect(persisted.values.size).toBe(0)
    expect(persisted.setItem).not.toHaveBeenCalled()
  })

  it('ignores a draft write without replacing the existing durable identity', () => {
    const bindings = new TaskTabBindings()
    bindings.write('owner', PAGE, { id: 'task-1' })
    const original = persisted.values.get(KEY)
    bindings.write('owner', PAGE, { draft: true, initial: form() })

    expect(bindings.read('owner', PAGE)).toEqual({ id: 'task-1', sessionId: undefined })
    expect(persisted.values.get(KEY)).toBe(original)
    expect(persisted.setItem).toHaveBeenCalledTimes(1)
  })

  it('returns a fresh identity value so caller mutation cannot alter the cached binding', () => {
    const bindings = new TaskTabBindings()
    bindings.write('owner', PAGE, { id: 'task-1', sessionId: 'linked' })
    const returned = bindings.read('owner', PAGE)!
    if (!returned.draft)
      returned.id = 'mutated'
    returned.sessionId = 'mutated'

    expect(bindings.read('owner', PAGE)).toEqual({ id: 'task-1', sessionId: 'linked' })
  })

  it('clears only in-memory cache, preserving stored identities for a new registration', () => {
    const bindings = new TaskTabBindings()
    bindings.write('owner', PAGE, { id: 'task-1' })
    persisted.values.set(KEY, JSON.stringify({
      'page-1': { kind: 'scheduleTask', contentId: 'task-content', id: 'task-2' },
    }))
    expect(bindings.read('owner', PAGE)).toEqual({ id: 'task-1', sessionId: undefined })

    bindings.clear()
    expect(bindings.read('owner', PAGE)).toEqual({ id: 'task-2', sessionId: undefined })
    expect(persisted.removeItem).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'kind', replacement: { ...PAGE, kind: 'other-kind' } },
    { name: 'content id', replacement: { ...PAGE, contentId: 'other-content' } },
  ])('rejects and drops a reused page whose $name changed', ({ replacement }) => {
    const bindings = new TaskTabBindings()
    bindings.write('owner', PAGE, { id: 'task-1' })
    bindings.write('owner', OTHER_PAGE, { id: 'task-2' })
    expect(bindings.read('owner', replacement)).toBeUndefined()

    bindings.dropMismatched('owner', replacement)
    expect(bindings.read('owner', PAGE)).toBeUndefined()
    expect(new TaskTabBindings().read('owner', PAGE)).toBeUndefined()
    expect(bindings.read('owner', OTHER_PAGE)).toEqual({ id: 'task-2', sessionId: undefined })
  })

  it('keeps a matching page and does not write when dropping an absent page', () => {
    const bindings = new TaskTabBindings()
    bindings.write('owner', PAGE, { id: 'task-1' })
    bindings.dropMismatched('owner', PAGE)
    bindings.dropMismatched('owner', OTHER_PAGE)

    expect(bindings.read('owner', PAGE)).toEqual({ id: 'task-1', sessionId: undefined })
    expect(persisted.setItem).toHaveBeenCalledTimes(1)
  })

  it('forgets only the selected page and removes the storage document when empty', () => {
    const bindings = new TaskTabBindings()
    bindings.write('owner', PAGE, { id: 'task-1' })
    bindings.write('owner', OTHER_PAGE, { id: 'task-2' })
    bindings.forget('owner', PAGE)
    expect(new TaskTabBindings().read('owner', OTHER_PAGE)).toEqual({ id: 'task-2', sessionId: undefined })
    expect(new TaskTabBindings().read('owner', PAGE)).toBeUndefined()

    bindings.forget('owner', OTHER_PAGE)
    expect(persisted.values.has(KEY)).toBe(false)
    expect(persisted.removeItem).toHaveBeenCalledExactlyOnceWith(KEY)
  })
})

describe('taskTabBindings public live-tab pruning', () => {
  it('prunes stale pages only when a nonempty live-tab list is available', () => {
    let live: readonly string[] | undefined
    const liveTabIds = vi.fn((_sessionId: string) => live)
    const bindings = new TaskTabBindings(liveTabIds)
    bindings.write('owner', PAGE, { id: 'task-1' })
    bindings.write('owner', OTHER_PAGE, { id: 'task-2' })
    live = ['page-2']
    bindings.write('owner', OTHER_PAGE, { id: 'task-2-updated' })

    expect(liveTabIds).toHaveBeenLastCalledWith('owner')
    expect(bindings.read('owner', PAGE)).toBeUndefined()
    expect(new TaskTabBindings().read('owner', PAGE)).toBeUndefined()
    expect(new TaskTabBindings().read('owner', OTHER_PAGE)).toEqual({ id: 'task-2-updated', sessionId: undefined })
    expect(Object.keys(JSON.parse(persisted.values.get(KEY)!))).toEqual(['page-2'])
  })

  it.each([undefined, []])('does not erase restored identities while live tabs are unknown or empty (%j)', (live) => {
    const bindings = new TaskTabBindings(() => live)
    bindings.write('owner', PAGE, { id: 'task-1' })
    bindings.write('owner', OTHER_PAGE, { id: 'task-2' })

    const reloaded = new TaskTabBindings()
    expect(reloaded.read('owner', PAGE)).toEqual({ id: 'task-1', sessionId: undefined })
    expect(reloaded.read('owner', OTHER_PAGE)).toEqual({ id: 'task-2', sessionId: undefined })
  })

  it('also prunes stale siblings when forgetting an unrelated page', () => {
    const bindings = new TaskTabBindings()
    bindings.write('owner', PAGE, { id: 'task-1' })
    bindings.write('owner', OTHER_PAGE, { id: 'task-2' })
    const reloaded = new TaskTabBindings(() => ['page-2'])
    reloaded.forget('owner', { ...PAGE, id: 'absent' })

    expect(reloaded.read('owner', PAGE)).toBeUndefined()
    expect(new TaskTabBindings().read('owner', PAGE)).toBeUndefined()
    expect(reloaded.read('owner', OTHER_PAGE)).toEqual({ id: 'task-2', sessionId: undefined })
  })
})

describe('taskTabBindings unavailable or malformed storage', () => {
  it('works in memory without localStorage and clears that transient state on disposal', () => {
    vi.stubGlobal('localStorage', undefined)
    const bindings = new TaskTabBindings()
    bindings.write('owner', PAGE, { id: 'task-1' })
    expect(bindings.read('owner', PAGE)).toEqual({ id: 'task-1', sessionId: undefined })
    expect(new TaskTabBindings().read('owner', PAGE)).toBeUndefined()

    bindings.clear()
    expect(bindings.read('owner', PAGE)).toBeUndefined()
    bindings.write('owner', PAGE, { id: 'task-2' })
    bindings.forget('owner', PAGE)
    expect(bindings.read('owner', PAGE)).toBeUndefined()
  })

  it('retains new bindings in memory when reading storage throws', () => {
    persisted.getItem.mockImplementation(() => {
      throw new Error('storage blocked')
    })
    const bindings = new TaskTabBindings()
    expect(bindings.read('owner', PAGE)).toBeUndefined()
    bindings.write('owner', PAGE, { id: 'task-1' })

    expect(bindings.read('owner', PAGE)).toEqual({ id: 'task-1', sessionId: undefined })
    expect(persisted.values.has(KEY)).toBe(true)
  })

  it('retains memory state and reports a quota failure rather than throwing', () => {
    const error = new Error('quota exceeded')
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    persisted.setItem.mockImplementation(() => {
      throw error
    })
    const bindings = new TaskTabBindings()
    expect(() => bindings.write('owner', PAGE, { id: 'task-1' })).not.toThrow()

    expect(bindings.read('owner', PAGE)).toEqual({ id: 'task-1', sessionId: undefined })
    expect(report).toHaveBeenCalledExactlyOnceWith('Task tab binding persistence failed:', error)
    expect(new TaskTabBindings().read('owner', PAGE)).toBeUndefined()
  })

  it('forgets in memory even when removing the storage document throws', () => {
    const bindings = new TaskTabBindings()
    bindings.write('owner', PAGE, { id: 'task-1' })
    const error = new Error('storage remove blocked')
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    persisted.removeItem.mockImplementation(() => {
      throw error
    })

    expect(() => bindings.forget('owner', PAGE)).not.toThrow()
    expect(bindings.read('owner', PAGE)).toBeUndefined()
    expect(report).toHaveBeenCalledExactlyOnceWith('Task tab binding persistence failed:', error)
  })

  it.each(['{', 'null', '[]', '1', '"text"', 'false'])('ignores a malformed storage document (%s)', (raw) => {
    persisted.values.set(KEY, raw)
    const bindings = new TaskTabBindings()
    expect(bindings.read('owner', PAGE)).toBeUndefined()
    expect(persisted.values.get(KEY)).toBe(raw)

    bindings.write('owner', PAGE, { id: 'task-1' })
    expect(new TaskTabBindings().read('owner', PAGE)).toEqual({ id: 'task-1', sessionId: undefined })
  })

  it.each([
    null,
    'text',
    { kind: 1, contentId: 'task-content', id: 'task-1' },
    { kind: 'scheduleTask', contentId: 1, id: 'task-1' },
    { kind: 'scheduleTask', contentId: 'task-content', id: 1 },
    { kind: 'scheduleTask', contentId: 'task-content', id: 'task-1', sessionId: null },
    { kind: 'scheduleTask', contentId: 'task-content', id: '' },
    { kind: 'scheduleTask', contentId: 'task-content', id: '   ' },
    { kind: 'scheduleTask', contentId: 'task-content', id: 'task-1', sessionId: '' },
    { kind: 'scheduleTask', contentId: 'task-content', id: 'task-1', sessionId: '   ' },
  ])('drops a malformed stored entry but preserves its valid sibling (%j)', (bad) => {
    persisted.values.set(KEY, JSON.stringify({
      'page-1': bad,
      'page-2': { kind: 'scheduleTask', contentId: 'other-content', id: 'task-2', prompt: 'not identity' },
    }))
    const bindings = new TaskTabBindings()
    expect(bindings.read('owner', PAGE)).toBeUndefined()
    expect(bindings.read('owner', OTHER_PAGE)).toEqual({ id: 'task-2', sessionId: undefined })

    bindings.write('owner', OTHER_PAGE, { id: 'task-2' })
    expect(JSON.parse(persisted.values.get(KEY)!)).toEqual({
      'page-2': { kind: 'scheduleTask', contentId: 'other-content', id: 'task-2' },
    })
  })
})

describe('taskTabParams', () => {
  it('projects an existing task navigation down to identity only', () => {
    expect(taskTabParams({ id: 'task-1', sessionId: 'linked', name: 'Private', prompt: 'Private', initial: form() }))
      .toEqual({ id: 'task-1', sessionId: 'linked' })
    expect(taskTabParams({ id: 'task-1', draft: false })).toEqual({ id: 'task-1', sessionId: undefined })
  })

  it('accepts a draft with no initial form or a structurally valid editable form', () => {
    expect(taskTabParams({ draft: true })).toEqual({ draft: true, sessionId: undefined, initial: undefined })
    const initial = form()
    expect(taskTabParams({ draft: true, sessionId: 'linked', initial })).toEqual({ draft: true, sessionId: 'linked', initial })
  })

  it('preserves optional recommendation identity and editable schedule options in a valid draft', () => {
    const initial: TaskFormState = {
      ...form(),
      recommendationId: 'recommendation-1',
      schedule: { kind: 'custom', everyDays: 2, time: '', anchor: '', timeZone: '' },
    }
    expect(taskTabParams({ draft: true, initial })).toEqual({ draft: true, sessionId: undefined, initial })
  })

  it('preserves nonblank identity exactly without trimming it into another identity', () => {
    expect(taskTabParams({ id: ' task-1 ', sessionId: ' linked ' })).toEqual({ id: ' task-1 ', sessionId: ' linked ' })
  })

  it('does not restore an existing id when the explicit navigation requests a draft', () => {
    expect(taskTabParams({ draft: true, id: 'old-task' })).toEqual({ draft: true, sessionId: undefined, initial: undefined })
  })

  it.each([
    undefined,
    null,
    false,
    1,
    'task-1',
    [],
    {},
    { id: 1 },
    { draft: 'true' },
    { id: 'task-1', sessionId: 1 },
    { draft: true, sessionId: null },
  ])('rejects invalid explicit navigation (%j)', (value) => {
    expect(taskTabParams(value)).toBeUndefined()
  })

  it.each([
    { id: '' },
    { id: '   ' },
    { id: 'task-1', sessionId: '' },
    { id: 'task-1', sessionId: '   ' },
    { id: 'task-1', draft: 'true' },
    { id: 'task-1', draft: null },
    { id: 'task-1', draft: 1 },
    { draft: true, sessionId: '' },
    { draft: true, sessionId: '   ' },
  ])('rejects empty identity or an invalid navigation discriminant (%j)', (value) => {
    expect(taskTabParams(value)).toBeUndefined()
  })

  it.each([
    undefined,
    null,
    1,
    [],
    {},
    { ...form(), enabled: 'true' },
    { ...form(), delivery: 'other' },
    { ...form(), prompt: 1 },
    { ...form(), schedule: null },
    { ...form(), recommendationId: 1 },
    { ...form(), recommendationId: null },
  ])('opens an empty draft rather than accepting malformed initial form (%j)', (initial) => {
    expect(taskTabParams({ draft: true, sessionId: 'linked', initial })).toEqual({
      draft: true,
      sessionId: 'linked',
      initial: undefined,
    })
  })

  it.each([
    { kind: 'unknown' },
    { kind: 1 },
    { kind: 'once', at: 1 },
    { kind: 'hourly', minute: '0' },
    { kind: 'daily', time: 800 },
    { kind: 'interval', everyMinutes: '15' },
    { kind: 'interval', everyMinutes: 15, anchor: 1 },
    { kind: 'workdays', time: undefined },
    { kind: 'weekly', weekdays: 'MO', time: '08:00' },
    { kind: 'weekly', weekdays: [1], time: '08:00' },
    { kind: 'weekly', weekdays: ['XX'], time: '08:00' },
    { kind: 'monthly', day: '31', time: '08:00' },
    { kind: 'custom', everyDays: '2', time: '08:00' },
    { kind: 'custom', everyDays: 2, time: '08:00', anchor: 1 },
    { kind: 'daily', time: '08:00', timeZone: 1 },
  ])('rejects malformed schedule structure without discarding the draft entry (%j)', (schedule) => {
    expect(taskTabParams({ draft: true, initial: { ...form(), schedule } })).toEqual({
      draft: true,
      sessionId: undefined,
      initial: undefined,
    })
  })

  it.each([
    { kind: 'once', at: '' },
    { kind: 'hourly', minute: 0 },
    { kind: 'daily', time: '' },
    { kind: 'interval', everyMinutes: 15 },
    { kind: 'workdays', time: '08:00' },
    { kind: 'weekly', weekdays: [], time: '08:00' },
    { kind: 'monthly', day: 31, time: '08:00' },
    { kind: 'custom', everyDays: 2, time: '08:00' },
  ] satisfies TaskFormState['schedule'][])('keeps structurally editable $kind draft fields without validating business values', (schedule) => {
    const initial = { ...form(), schedule }
    expect(taskTabParams({ draft: true, initial })).toEqual({ draft: true, sessionId: undefined, initial })
  })
})
