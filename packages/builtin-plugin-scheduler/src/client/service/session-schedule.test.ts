import type { TaskView } from '../types'
import { describe, expect, it } from 'vitest'
import { activeSessionTasks, isTaskOverdue, orderSessionTasks } from './session-schedule'

function task(id: string, changes: Partial<TaskView> = {}): TaskView {
  return {
    id,
    name: id,
    prompt: 'Reminder',
    delivery: 'this-session',
    status: 'active',
    sessionId: 'owner',
    enabled: true,
    schedule: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...changes,
  }
}

describe('shared session catalog projection', () => {
  it('keeps only enabled active this-session tasks bound to the seat owner', () => {
    const tasks = [
      task('match'),
      task('other-owner', { sessionId: 'elsewhere' }),
      task('unbound', { sessionId: undefined }),
      task('new-session', { delivery: 'new-session' }),
      task('inactive', { status: 'inactive' }),
      task('disabled', { enabled: false }),
    ]
    expect(activeSessionTasks(tasks, 'owner').map(value => value.id)).toEqual(['match'])
    expect(activeSessionTasks(tasks, 'elsewhere').map(value => value.id)).toEqual(['other-owner'])
    expect(activeSessionTasks(tasks, undefined)).toEqual([])
    expect(activeSessionTasks(tasks, '')).toEqual([])
  })

  it('orders overdue first, then nearest next run, with stable missing deadlines and no mutation', () => {
    const now = Date.parse('2026-10-10T09:00:00Z')
    const tasks = Object.freeze([
      task('later', { nextRunAt: '2026-10-10T10:00:00Z' }),
      task('missing'),
      task('overdue-near', { nextRunAt: '2026-10-10T08:59:00Z' }),
      task('overdue-old', { nextRunAt: '2026-10-09T09:00:00Z' }),
      task('due', { nextRunAt: '2026-10-10T09:00:00Z' }),
      task('invalid', { nextRunAt: 'invalid' }),
      task('soon', { nextRunAt: '2026-10-10T09:05:00Z' }),
    ])
    expect(orderSessionTasks(tasks, now).map(value => value.id)).toEqual([
      'overdue-old',
      'overdue-near',
      'due',
      'soon',
      'later',
      'missing',
      'invalid',
    ])
    expect(tasks.map(value => value.id)).toEqual(['later', 'missing', 'overdue-near', 'overdue-old', 'due', 'invalid', 'soon'])
    expect(isTaskOverdue(task('due', { nextRunAt: '2026-10-10T09:00:00Z' }), now)).toBe(true)
    expect(isTaskOverdue(task('missing'), now)).toBe(false)
    expect(isTaskOverdue(task('invalid', { nextRunAt: 'invalid' }), now)).toBe(false)
  })
})
