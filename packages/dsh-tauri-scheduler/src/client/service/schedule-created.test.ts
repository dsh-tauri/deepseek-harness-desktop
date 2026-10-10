import type { TaskView } from '../types'
import { describe, expect, it } from 'vitest'
import { decodeCreatedTask } from './schedule-created'

function task(schedule: TaskView['schedule'] = { kind: 'daily', time: '09:00', timeZone: 'UTC' }): TaskView {
  return {
    id: 'created-task',
    name: 'Morning report',
    prompt: 'Summarize the overnight changes',
    delivery: 'this-session',
    status: 'active',
    sessionId: 'owner',
    enabled: true,
    schedule,
    createdAt: '2026-10-10T00:00:00Z',
    updatedAt: '2026-10-10T00:00:00Z',
    nextRunAt: '2026-10-11T09:00:00Z',
  }
}

function content(value: unknown) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

describe('durable scheduler_create payload', () => {
  it.each<TaskView['schedule']>([
    { kind: 'once', at: '2026-10-11T09:00:00Z', timeZone: 'UTC' },
    { kind: 'hourly', minute: 15, timeZone: 'UTC' },
    { kind: 'daily', time: '09:00', timeZone: 'UTC' },
    { kind: 'workdays', time: '09:00', timeZone: 'UTC' },
    { kind: 'weekly', time: '09:00', weekdays: ['MO', 'FR'], timeZone: 'UTC' },
    { kind: 'monthly', time: '09:00', day: 31, timeZone: 'UTC' },
    { kind: 'interval', everyMinutes: 30, anchor: '2026-10-10T00:00:00Z', timeZone: 'UTC' },
    { kind: 'custom', time: '09:00', everyDays: 2, anchor: '2026-10-10T00:00:00Z', timeZone: 'Asia/Shanghai' },
    { kind: 'daily', time: ' 8:30 ', timeZone: 'Asia/Shanghai' },
    { kind: 'interval', everyMinutes: 1.5, anchor: '2026-10-10T00:00:00.123Z', timeZone: 'UTC' },
    { kind: 'interval', everyMinutes: 525_600, timeZone: 'UTC' },
    { kind: 'custom', time: '09:00', everyDays: 366, anchor: '2026-10-10T00:00:00Z', timeZone: 'UTC' },
  ])('decodes a complete $kind snapshot without depending on live catalog %#', (schedule) => {
    const snapshot = task(schedule)
    expect(decodeCreatedTask(content({ ok: true, taskId: snapshot.id, nextRunAt: snapshot.nextRunAt, task: snapshot }))).toEqual(snapshot)
  })

  it.each([
    [],
    [{ type: 'text', text: '' }],
    [{ type: 'text', text: '{' }],
    [{ type: 'text', text: '已创建任务' }],
    [{ type: 'image', text: '{}' }],
    [{ type: 'text', text: '{}' }, { type: 'text', text: '{}' }],
    content({ ok: false, task: task() }),
    content({ ok: true, taskId: 'wrong', task: task() }),
    content({ ok: true, taskId: 'legacy-id', nextRunAt: '2026-10-11T09:00:00Z' }),
  ].map(result => ({ result })))('ignores incomplete or failed output %#', ({ result }) => {
    expect(decodeCreatedTask(result)).toBeUndefined()
  })

  it.each([
    { id: '' },
    { name: ' ' },
    { prompt: '' },
    { enabled: 'true' },
    { delivery: 'unknown' },
    { status: 'unknown' },
    { sessionId: 7 },
    { createdAt: 'invalid' },
    { updatedAt: 'invalid' },
    { nextRunAt: 'invalid' },
    { workspaceId: 1 },
    { agentPreset: 1 },
  ])('rejects malformed canonical task fields %#', (changes) => {
    expect(decodeCreatedTask(content({ ok: true, task: { ...task(), ...changes } }))).toBeUndefined()
  })

  it.each([
    { kind: 'daily', time: '09:00' },
    { kind: 'daily', time: '09:00', timeZone: '' },
    { kind: 'daily', time: '09:00', timeZone: ' UTC ' },
    { kind: 'daily', time: '09:00', timeZone: 'Unknown/Zone' },
    { kind: 'daily', time: '24:00', timeZone: 'UTC' },
    { kind: 'daily', time: '09:60', timeZone: 'UTC' },
    { kind: 'hourly', minute: 60, timeZone: 'UTC' },
    { kind: 'hourly', minute: 0.5, timeZone: 'UTC' },
    { kind: 'weekly', time: '09:00', weekdays: [], timeZone: 'UTC' },
    { kind: 'weekly', time: '09:00', weekdays: ['BAD'], timeZone: 'UTC' },
    { kind: 'monthly', time: '09:00', day: 32, timeZone: 'UTC' },
    { kind: 'interval', everyMinutes: 0, timeZone: 'UTC' },
    { kind: 'interval', everyMinutes: 0.5, timeZone: 'UTC' },
    { kind: 'interval', everyMinutes: 525_601, timeZone: 'UTC' },
    { kind: 'interval', everyMinutes: '1.5', timeZone: 'UTC' },
    { kind: 'interval', everyMinutes: 1.5, anchor: 'invalid', timeZone: 'UTC' },
    { kind: 'custom', time: '09:00', everyDays: 2, timeZone: 'UTC' },
    { kind: 'custom', time: '09:00', everyDays: -1, anchor: '2026-10-10T00:00:00Z', timeZone: 'UTC' },
    { kind: 'custom', time: '09:00', everyDays: 367, anchor: '2026-10-10T00:00:00Z', timeZone: 'UTC' },
    { kind: 'custom', time: '09:00', everyDays: 1.5, anchor: '2026-10-10T00:00:00Z', timeZone: 'UTC' },
    { kind: 'once', at: 'invalid', timeZone: 'UTC' },
  ])('rejects malformed canonical schedule fields %#', (schedule) => {
    expect(decodeCreatedTask(content({ ok: true, task: { ...task(), schedule } }))).toBeUndefined()
  })
})
