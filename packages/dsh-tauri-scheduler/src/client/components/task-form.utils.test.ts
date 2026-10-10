import type { ScheduleForm, TaskFormState } from '../types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formFixture, optionsFixture, taskFixture } from './scheduler-client.test.harness'
import { absoluteDateTime, defaultScheduleFor, emptyTaskForm, localDateTime, taskFormInput, taskToForm } from './task-form.utils'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('defaultScheduleFor', () => {
  it('creates a one-off task exactly one hour ahead in the chosen timezone', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-05-06T07:08:09.000Z'))
    expect(defaultScheduleFor('once', 'Pacific/Auckland')).toEqual({ kind: 'once', at: '2030-05-06T08:08:09.000Z', timeZone: 'Pacific/Auckland' })
  })

  it.each([
    ['hourly', { kind: 'hourly', minute: 0 }],
    ['interval', { kind: 'interval', everyMinutes: 30 }],
    ['monthly', { kind: 'monthly', day: 1, time: '09:00' }],
    ['custom', { kind: 'custom', everyDays: 2, time: '09:00' }],
    ['weekly', { kind: 'weekly', weekdays: ['MO'], time: '09:00' }],
    ['workdays', { kind: 'workdays', time: '09:00' }],
    ['daily', { kind: 'daily', time: '09:00' }],
  ] satisfies [ScheduleForm['kind'], ScheduleForm][])('uses explicit defaults for %s without replacing the timezone', (kind, expected) => {
    expect(defaultScheduleFor(kind, 'Europe/Berlin')).toEqual({ ...expected, timeZone: 'Europe/Berlin' })
  })

  it('creates an independent weekday array for each default form', () => {
    const first = defaultScheduleFor('weekly', 'UTC')
    const second = defaultScheduleFor('weekly', 'UTC')
    expect(first).toEqual({ kind: 'weekly', weekdays: ['MO'], time: '09:00', timeZone: 'UTC' })
    expect(second).toEqual({ kind: 'weekly', weekdays: ['MO'], time: '09:00', timeZone: 'UTC' })
    if (first.kind !== 'weekly' || second.kind !== 'weekly')
      throw new Error('Expected weekly defaults')
    expect(first.weekdays).not.toBe(second.weekdays)
  })
})

describe('emptyTaskForm', () => {
  it('uses unattended resource defaults without making the linked session the delivery target', () => {
    expect(emptyTaskForm(optionsFixture(), 'session-a')).toEqual({
      delivery: 'new-session',
      sessionId: 'session-a',
      enabled: true,
      name: '',
      prompt: '',
      schedule: { kind: 'daily', time: '09:00', timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone },
      workspaceId: '',
      permission: 'workspace-write',
      provider: 'provider-a',
      model: 'model-a',
      reasoningEffort: 'high',
    })
  })

  it('falls back to read-only and no model when defaults are absent', () => {
    expect(emptyTaskForm(optionsFixture({ defaultPermission: '', defaultModel: null }))).toEqual({
      delivery: 'new-session',
      sessionId: '',
      enabled: true,
      name: '',
      prompt: '',
      schedule: { kind: 'daily', time: '09:00', timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone },
      workspaceId: '',
      permission: 'read-only',
      provider: '',
      model: '',
      reasoningEffort: '',
    })
  })
})

describe('taskToForm', () => {
  it('copies every selected weekday and timezone independently of later task mutations', () => {
    const task = taskFixture()
    const form = taskToForm(task)
    expect(form.schedule).not.toBe(task.schedule)
    if (task.schedule.kind !== 'weekly' || form.schedule.kind !== 'weekly')
      throw new Error('Expected weekly task fixture')
    expect(form.schedule.weekdays).not.toBe(task.schedule.weekdays)
    task.schedule.time = '18:00'
    task.schedule.timeZone = 'UTC'
    task.prompt = 'External update'
    task.enabled = false
    expect(form).toEqual({
      delivery: 'new-session',
      sessionId: '',
      enabled: true,
      recommendationId: 'recommendation-a',
      name: 'Task A',
      prompt: 'Original instruction',
      schedule: { kind: 'weekly', weekdays: ['MO', 'WE', 'FR'], time: '09:30', timeZone: 'Asia/Shanghai' },
      workspaceId: 'workspace-a',
      permission: 'workspace-write',
      provider: 'provider-a',
      model: 'model-a',
      reasoningEffort: 'high',
    })
  })

  it.each([
    { kind: 'interval', everyMinutes: 17, anchor: '2030-05-01T05:06:07.000Z', timeZone: 'America/New_York' },
    { kind: 'custom', everyDays: 4, anchor: '2030-05-01T05:06:07.000Z', time: '16:45', timeZone: 'Pacific/Auckland' },
  ] satisfies ScheduleForm[])('keeps the persisted anchor for $kind forms', (schedule) => {
    const task = taskFixture({ schedule })
    const form = taskToForm(task)
    expect(form.schedule).toEqual(schedule)
    expect(form.schedule).not.toBe(schedule)
    task.schedule.timeZone = 'UTC'
    expect(form.schedule.timeZone).not.toBe('UTC')
  })

  it('represents an inactive linked-session task without inventing a resource selection', () => {
    expect(taskToForm(taskFixture({
      delivery: 'this-session',
      status: 'inactive',
      sessionId: 'archived-session',
      enabled: false,
      recommendationId: undefined,
      workspaceId: undefined,
      permission: undefined,
      provider: undefined,
      model: undefined,
      reasoningEffort: undefined,
    }))).toEqual({
      delivery: 'this-session',
      sessionId: 'archived-session',
      enabled: false,
      recommendationId: undefined,
      name: 'Task A',
      prompt: 'Original instruction',
      schedule: { kind: 'weekly', weekdays: ['MO', 'WE', 'FR'], time: '09:30', timeZone: 'Asia/Shanghai' },
      workspaceId: '',
      permission: 'read-only',
      provider: '',
      model: '',
      reasoningEffort: '',
    })
  })
})

describe('taskFormInput', () => {
  it('omits all independent resource keys when creating a this-session reminder', () => {
    expect(taskFormInput(formFixture({ delivery: 'this-session' }), false)).toEqual({
      delivery: 'this-session',
      sessionId: 'session-a',
      enabled: true,
      recommendationId: 'recommendation-a',
      name: 'Draft task',
      prompt: 'Draft instruction',
      schedule: { kind: 'daily', time: '09:30', timeZone: 'Asia/Shanghai' },
    })
  })

  it('clears old independent resource keys when converting an edited task to this-session', () => {
    expect(taskFormInput(formFixture({ delivery: 'this-session' }), true)).toEqual({
      delivery: 'this-session',
      sessionId: 'session-a',
      enabled: true,
      recommendationId: 'recommendation-a',
      name: 'Draft task',
      prompt: 'Draft instruction',
      schedule: { kind: 'daily', time: '09:30', timeZone: 'Asia/Shanghai' },
      workspaceId: '',
      permission: '',
      provider: '',
      model: '',
      reasoningEffort: '',
    })
  })

  it('clears the old session binding when converting an edited reminder to new-session', () => {
    expect(taskFormInput(formFixture(), true)).toEqual({
      delivery: 'new-session',
      sessionId: '',
      enabled: true,
      recommendationId: 'recommendation-a',
      name: 'Draft task',
      prompt: 'Draft instruction',
      schedule: { kind: 'daily', time: '09:30', timeZone: 'Asia/Shanghai' },
      workspaceId: 'workspace-a',
      permission: 'workspace-write',
      provider: 'provider-a',
      model: 'model-a',
      reasoningEffort: 'high',
    })
  })

  it('does not send the default linked session when creating an independent task', () => {
    const input = taskFormInput(formFixture(), false)
    expect(input).toEqual({
      delivery: 'new-session',
      sessionId: undefined,
      enabled: true,
      recommendationId: 'recommendation-a',
      name: 'Draft task',
      prompt: 'Draft instruction',
      schedule: { kind: 'daily', time: '09:30', timeZone: 'Asia/Shanghai' },
      workspaceId: 'workspace-a',
      permission: 'workspace-write',
      provider: 'provider-a',
      model: 'model-a',
      reasoningEffort: 'high',
    })
    expect(JSON.parse(JSON.stringify(input))).not.toHaveProperty('sessionId')
  })

  it.each([
    { kind: 'weekly', weekdays: ['TU', 'TH', 'SU'], time: '21:04', timeZone: 'Europe/Berlin' },
    { kind: 'interval', everyMinutes: 17, anchor: '2030-05-01T05:06:07.000Z', timeZone: 'America/New_York' },
    { kind: 'custom', everyDays: 4, anchor: '2030-05-01T05:06:07.000Z', time: '16:45', timeZone: 'Pacific/Auckland' },
  ] satisfies ScheduleForm[])('captures $kind scheduling data independently before a later draft change', (schedule) => {
    const form: TaskFormState = formFixture({ schedule })
    const input = taskFormInput(form, true)
    expect(input.schedule).toEqual(schedule)
    expect(input.schedule).not.toBe(schedule)
    if (form.schedule.kind === 'weekly' && input.schedule.kind === 'weekly')
      expect(input.schedule.weekdays).not.toBe(form.schedule.weekdays)
    form.schedule.timeZone = 'UTC'
    if (form.schedule.kind === 'weekly')
      form.schedule.weekdays = ['MO']
    expect(input.schedule.timeZone).not.toBe('UTC')
    if (input.schedule.kind === 'weekly')
      expect(input.schedule.weekdays).toEqual(['TU', 'TH', 'SU'])
  })
})

describe('datetime form conversion', () => {
  it('reads and writes an absolute task instant in the chosen zone instead of the device zone', () => {
    expect(localDateTime('2030-05-06T07:08:09.000Z', 'Asia/Tokyo')).toBe('2030-05-06T16:08:09')
    expect(absoluteDateTime('2030-05-06T16:08:09', 'Asia/Tokyo')).toBe('2030-05-06T07:08:09.000Z')
    expect(localDateTime('2030-05-06T07:08:09.125Z', 'Asia/Tokyo')).toBe('2030-05-06T16:08:09.125')
    expect(absoluteDateTime('2030-05-06T16:08:09.125', 'Asia/Tokyo')).toBe('2030-05-06T07:08:09.125Z')
  })

  it('rejects skipped wall time and chooses only the earlier repeated instant', () => {
    expect(absoluteDateTime('2030-03-10T02:30:00', 'America/New_York')).toBe('')
    expect(absoluteDateTime('2030-11-03T01:30:00', 'America/New_York')).toBe('2030-11-03T05:30:00.000Z')
    expect(absoluteDateTime('2030-02-30T12:00:00', 'UTC')).toBe('')
    expect(absoluteDateTime('2030-05-06T07:08:09', 'Invalid/Zone')).toBe('')
    expect(absoluteDateTime('0050-05-06T07:08:09', 'UTC')).toBe('0050-05-06T07:08:09.000Z')
  })

  it('shows local datetime components with seconds for an absolute instant', () => {
    const instant = new Date(2030, 4, 6, 7, 8, 9).toISOString()
    expect(localDateTime(instant)).toBe('2030-05-06T07:08:09')
  })

  it('converts a local datetime draft into an absolute ISO instant', () => {
    expect(absoluteDateTime('2030-05-06T07:08:09')).toBe(new Date(2030, 4, 6, 7, 8, 9).toISOString())
  })

  it.each(['', 'invalid-date'])('rejects invalid datetime text %j without inventing an instant', (value) => {
    expect(localDateTime(value)).toBe('')
    expect(absoluteDateTime(value)).toBe('')
  })
})
