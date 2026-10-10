import type { ConversationMatch, ConversationNodeContext, ConversationTurnDataMap, TurnLocation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { TaskView } from '../types'
import type { ScheduleTurnData, ScheduleTurnState } from './schedule-turn'
import { describe, expect, it } from 'vitest'
import { scheduleTasksForClosing, scheduleTurnDefinition, selectScheduleTasks } from './schedule-turn'

function seq(value: number): SessionEvent['seq'] {
  return value as SessionEvent['seq']
}

function task(id = 'task-created'): TaskView {
  return {
    id,
    name: 'Scheduled report',
    prompt: 'Write a report',
    delivery: 'this-session',
    status: 'active',
    sessionId: 'owner',
    enabled: true,
    schedule: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
    createdAt: '2026-10-10T00:00:00Z',
    updatedAt: '2026-10-10T00:00:00Z',
  }
}

function start(turn = 3): SessionEvent<'turn/start'> {
  return { type: 'turn/start', seq: seq(1), time: 100, data: { turn } }
}

function call(callId = 'create', name = 'scheduler_create', turn = 3): SessionEvent<'tool/call'> {
  return {
    type: 'tool/call',
    seq: seq(2),
    time: 200,
    data: { turn, step: 1, callId: callId as SessionEvent<'tool/call'>['data']['callId'], name, arguments: '{}' },
  }
}

function result(callId = 'create', at = 4, changes: Partial<SessionEvent<'tool/result'>['data']['message']> = {}, turn = 3): SessionEvent<'tool/result'> {
  return {
    type: 'tool/result',
    seq: seq(at),
    time: 1700000000123 + at,
    surfaceOp: 'append',
    data: {
      turn,
      step: 1,
      message: {
        id: `message-${callId}` as SessionEvent<'tool/result'>['data']['message']['id'],
        role: 'tool',
        source: { kind: 'tool', callId: callId as SessionEvent<'tool/call'>['data']['callId'] },
        toolCallId: callId as SessionEvent<'tool/call'>['data']['callId'],
        content: [{ type: 'text', text: JSON.stringify({ ok: true, taskId: 'task-created', task: task() }) }],
        ...changes,
      },
    },
  }
}

function context(state: ScheduleTurnState): ConversationNodeContext<ScheduleTurnState> & { state: ScheduleTurnState } {
  return { key: 'schedule-created:3', kind: 'schedule-created', id: '3', matches: [], start: undefined, state, current: new Map() }
}

function initialize(): ScheduleTurnState {
  return scheduleTurnDefinition.start(
    { ...context({ turn: 3, calls: new Map(), created: [] }), state: undefined },
    { event: start(), role: 'start', location: { kind: 'unresolved' } },
    { previous: () => undefined },
  )
}

function update(state: ScheduleTurnState, event: SessionEvent): ScheduleTurnState {
  const accepted = scheduleTurnDefinition.match(event)
  if (accepted === null)
    return state
  const match: ConversationMatch = { event, role: accepted.role, location: { kind: 'unresolved' } }
  return scheduleTurnDefinition.update(context(state), match)
}

function owner(data: ScheduleTurnData | undefined, cursor = 5, end?: number) {
  const values: Partial<ConversationTurnDataMap> = { 'schedule-created': data }
  const turn: TurnLocation = {
    turn: 3,
    start: start(),
    end: end === undefined ? undefined : { type: 'turn/end', seq: seq(end), time: 999, data: { turn: 3, reason: { kind: 'completed' } } },
    status: end === undefined ? 'open' : 'closed',
    steps: [],
    data: { get: key => values[key], source: key => ({ getSnapshot: () => values[key], subscribe: () => () => {} }) },
  }
  return { turn, seq: cursor, openFile: () => {} }
}

describe('scheduler_create turn-tail definition', () => {
  it('publishes no tool-call view and accepts only start, call, and appended settled result events', () => {
    expect(scheduleTurnDefinition.kind).toBe('schedule-created')
    expect(scheduleTurnDefinition.target).toBeUndefined()
    expect(scheduleTurnDefinition.match(start())).toEqual({ id: '3', role: 'start' })
    expect(scheduleTurnDefinition.match(call())).toEqual({ id: '3', role: 'update' })
    expect(scheduleTurnDefinition.match(result())).toEqual({ id: '3', role: 'update' })
    expect(scheduleTurnDefinition.match({ ...result(), surfaceOp: { op: 'replace', startSeq: seq(1), endSeq: seq(2) } })).toBeNull()
    expect(scheduleTurnDefinition.match({ type: 'turn/end', seq: seq(5), time: 500, data: { turn: 3, reason: { kind: 'completed' } } })).toBeNull()
  })

  it('pairs calls by source callId and publishes immutable complete creation facts with event time', () => {
    const initial = initialize()
    const called = update(initial, call())
    expect(initial.calls.size).toBe(0)
    expect(initial.created).toEqual([])
    expect(called.calls.get('create')).toEqual({ name: 'scheduler_create' })
    const settled = update(called, result())
    expect(called.created).toEqual([])
    expect(settled.created).toEqual([{ seq: 4, time: 1700000000127, callId: 'create', task: task() }])
    expect(update(settled, result('create', 5))).toBe(settled)
    const secondCalled = update(settled, call('second'))
    const second = update(secondCalled, result('second', 6))
    expect(second.created.map(created => created.callId)).toEqual(['create', 'second'])
    expect(settled.created).toHaveLength(1)
  })

  it('ignores unmatched, different tools, failed, malformed, and wrong-turn results', () => {
    const initial = initialize()
    expect(update(initial, result())).toBe(initial)
    const wrongTool = update(initial, call('create', 'scheduler_update'))
    expect(update(wrongTool, result())).toBe(wrongTool)
    const called = update(initial, call())
    expect(update(called, result('create', 4, { isError: true }))).toBe(called)
    expect(update(called, result('create', 4, { content: [{ type: 'text', text: '{' }] }))).toBe(called)
    expect(update(called, result('create', 4, {}, 4))).toBe(called)
    expect(update(called, call('other', 'scheduler_create', 4))).toBe(called)
    expect(update(called, result('missing-source'))).toBe(called)
  })

  it('publishes only turn data, preserves unchanged identity, and does not require chat tool expansion', () => {
    const settled = update(update(initialize(), call()), result())
    const publish = scheduleTurnDefinition.buildLocationData!
    expect(publish(context(settled), 'step', null)).toBeNull()
    expect(publish({ ...context(settled), state: undefined }, 'turn', null)).toBeNull()
    const data = publish(context(settled), 'turn', null)
    expect(data).toEqual({ kind: 'turn', turn: 3, key: 'schedule-created', value: { created: settled.created } })
    expect(publish(context(settled), 'turn', data)).toBe(data)
    const next = update(update(settled, call('second')), result('second', 8))
    expect(publish(context(next), 'turn', data)).not.toBe(data)
  })

  it('bounds created cards to an open cursor or closed turn end without leaking later creations', () => {
    const data: ScheduleTurnData = {
      created: [
        { seq: 4, time: 1004, callId: 'first', task: task('first-task') },
        { seq: 8, time: 1008, callId: 'second', task: task('second-task') },
      ],
    }
    expect(selectScheduleTasks(owner(undefined))).toBeNull()
    expect(selectScheduleTasks(owner(data, 3))).toBeNull()
    expect(selectScheduleTasks(owner(data, 5))?.created.map(created => created.callId)).toEqual(['first'])
    expect(selectScheduleTasks(owner(data, 100, 5))?.created.map(created => created.callId)).toEqual(['first'])
    expect(selectScheduleTasks(owner(data, 2, 10))?.created.map(created => created.callId)).toEqual(['first', 'second'])
    expect(scheduleTasksForClosing(data).map(created => created.callId)).toEqual(['first', 'second'])
    expect(scheduleTasksForClosing(undefined)).toEqual([])
  })
})
