import type { SchedulerTask } from '../types'
import { describe, expect, it } from 'vitest'
import { isTaskDue, selectWaitingTaskIds } from './waiting'

const NOW = Date.parse('2026-09-16T10:00:00.000Z')
const DUE = '2026-09-16T09:59:00.000Z'
const FUTURE = '2026-09-16T11:00:00.000Z'

function makeTask(id: string, nextRunAt?: string, overrides: Partial<SchedulerTask> = {}): SchedulerTask {
  return {
    id,
    delivery: 'new-session',
    status: 'active',
    name: id,
    prompt: 'prompt',
    schedule: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
    enabled: true,
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z',
    nextRunAt,
    ...overrides,
  }
}

describe('isTaskDue', () => {
  it('treats an enabled active new-session task with a past target as due', () => {
    expect(isTaskDue(makeTask('a', DUE), NOW)).toBe(true)
  })

  it('includes a new-session target exactly at the decision time', () => {
    expect(isTaskDue(makeTask('a', '2026-09-16T10:00:00.000Z'), NOW)).toBe(true)
  })

  it.each<Partial<SchedulerTask>>([
    { enabled: false },
    { status: 'inactive' },
    { delivery: 'this-session', sessionId: 'session-a' },
  ])('excludes a past target when task eligibility is %j', (overrides) => {
    expect(isTaskDue(makeTask('a', DUE, overrides), NOW)).toBe(false)
  })

  it.each([FUTURE, undefined, 'not-a-date', ''])('excludes a missing, invalid or future target %j', (nextRunAt) => {
    expect(isTaskDue(makeTask('a', nextRunAt), NOW)).toBe(false)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('rejects a non-finite decision %s', (now) => {
    expect(isTaskDue(makeTask('a', DUE), now)).toBe(false)
  })
})

describe('selectWaitingTaskIds', () => {
  it('marks every eligible due task as waiting when no capacity is left', () => {
    const tasks = [makeTask('a', DUE), makeTask('b', DUE)]
    expect([...selectWaitingTaskIds(tasks, new Set(), 0, NOW)]).toEqual(['a', 'b'])
  })

  it('keeps the tasks that this tick can start out of the waiting set', () => {
    const tasks = [makeTask('a', DUE), makeTask('b', DUE), makeTask('c', DUE)]
    expect([...selectWaitingTaskIds(tasks, new Set(), 1, NOW)]).toEqual(['b', 'c'])
  })

  it('uses already-available capacity without subtracting unrelated in-flight runs again', () => {
    const tasks = [makeTask('a', DUE), makeTask('b', DUE)]
    expect([...selectWaitingTaskIds(tasks, new Set(['z']), 1, NOW)]).toEqual(['b'])
  })

  it('never marks running, disabled, inactive, this-session or future tasks as waiting', () => {
    const tasks = [
      makeTask('running', DUE),
      makeTask('disabled', DUE, { enabled: false }),
      makeTask('inactive', DUE, { status: 'inactive' }),
      makeTask('this-session', DUE, { delivery: 'this-session', sessionId: 'session-a' }),
      makeTask('future', FUTURE),
      makeTask('missing'),
      makeTask('invalid', 'not-a-date'),
    ]
    expect([...selectWaitingTaskIds(tasks, new Set(['running']), 0, NOW)]).toEqual([])
  })

  it('does not let this-session or inactive tasks consume new-session capacity', () => {
    const tasks = [
      makeTask('this-session', DUE, { delivery: 'this-session', sessionId: 'session-a' }),
      makeTask('inactive', DUE, { status: 'inactive' }),
      makeTask('a', DUE),
      makeTask('b', DUE),
    ]
    expect([...selectWaitingTaskIds(tasks, new Set(), 1, NOW)]).toEqual(['b'])
  })

  it('removes running tasks before allocating available slots in input order', () => {
    const tasks = [makeTask('running', DUE), makeTask('a', DUE), makeTask('b', DUE)]
    expect([...selectWaitingTaskIds(tasks, new Set(['running']), 1, NOW)]).toEqual(['b'])
  })

  it('treats negative capacity as no available slots', () => {
    const tasks = [makeTask('a', DUE), makeTask('b', DUE)]
    expect([...selectWaitingTaskIds(tasks, new Set(), -1, NOW)]).toEqual(['a', 'b'])
  })

  it('returns no waiting tasks when capacity covers every eligible due task', () => {
    const tasks = [makeTask('a', DUE), makeTask('b', DUE)]
    expect([...selectWaitingTaskIds(tasks, new Set(), 3, NOW)]).toEqual([])
  })

  it('returns an empty waiting set for an empty task list', () => {
    expect([...selectWaitingTaskIds([], new Set(), 0, NOW)]).toEqual([])
  })
})
