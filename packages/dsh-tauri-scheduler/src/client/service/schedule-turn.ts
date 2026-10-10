import type { ConversationNodeDefinition, TurnLocation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TaskView } from '../types'
import { decodeCreatedTask } from './schedule-created'

export interface ScheduleCreatedTask {
  readonly seq: number
  readonly time: number
  readonly callId: string
  readonly task: TaskView
}

export interface ScheduleTurnData {
  readonly created: readonly ScheduleCreatedTask[]
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    'schedule-created': ScheduleTurnData
  }
}

export interface ScheduleTurnOwner {
  readonly turn: TurnLocation
  readonly seq: number
  readonly openFile: (path: string) => void
}

interface ScheduleCall {
  readonly name: string
}

export interface ScheduleTurnState {
  readonly turn: number
  readonly calls: ReadonlyMap<string, ScheduleCall>
  readonly created: readonly ScheduleCreatedTask[]
}

export function scheduleTasksForClosing(
  data: Readonly<ScheduleTurnData> | undefined,
  seq = Number.POSITIVE_INFINITY,
): readonly ScheduleCreatedTask[] {
  return data === undefined ? [] : data.created.filter(created => created.seq <= seq)
}

export function selectScheduleTasks(owner: ScheduleTurnOwner): ScheduleTurnData | null {
  const created = scheduleTasksForClosing(owner.turn.data.get('schedule-created'), owner.turn.end?.seq ?? owner.seq)
  return created.length === 0 ? null : { created }
}

export const scheduleTurnDefinition: ConversationNodeDefinition<ScheduleTurnState> = {
  kind: 'schedule-created',
  match: (event) => {
    if (event.type === 'turn/start')
      return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'tool/call')
      return { id: String(event.data.turn), role: 'update' }
    if (event.type === 'tool/result' && event.surfaceOp === 'append')
      return { id: String(event.data.turn), role: 'update' }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start')
      throw new Error('schedule-created start requires turn/start')
    return { turn: match.event.data.turn, calls: new Map(), created: [] }
  },
  update: (context, match) => {
    if (match.event.type === 'tool/call') {
      if (match.event.data.turn !== context.state.turn)
        return context.state
      const calls = new Map(context.state.calls)
      calls.set(String(match.event.data.callId), { name: match.event.data.name })
      return { ...context.state, calls }
    }
    if (match.event.type !== 'tool/result' || match.event.data.turn !== context.state.turn)
      return context.state
    const message = match.event.data.message
    const callId = String(message.source.callId)
    if (context.state.calls.get(callId)?.name !== 'scheduler_create' || message.isError === true)
      return context.state
    if (context.state.created.some(created => created.callId === callId))
      return context.state
    const task = decodeCreatedTask(message.content)
    return task === undefined
      ? context.state
      : { ...context.state, created: [...context.state.created, { seq: match.event.seq, time: match.event.time, callId, task }] }
  },
  buildLocationData: (context, scope, previous) => {
    if (scope !== 'turn' || context.state === undefined)
      return null
    if (previous?.kind === 'turn' && previous.turn === context.state.turn
      && previous.key === 'schedule-created' && previous.value.created === context.state.created) {
      return previous
    }
    return { kind: 'turn', turn: context.state.turn, key: 'schedule-created', value: { created: context.state.created } }
  },
}
