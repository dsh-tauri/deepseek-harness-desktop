import type { CoreOperation, CoreTaskAccepted, CoreTaskEvent, CoreTaskEventPage, CoreTaskState } from '../../shared/core'
import { defineService } from 'dsh-tauri'
import { EVENT_RING_CAPACITY } from '../config/constants'

interface TaskState {
  taskId: string
  operation: CoreOperation
  targetId: string
  state: CoreTaskState
  seq: number
  events: CoreTaskEvent[]
}

const taskStates = new Map<string, TaskState>()
let taskCounter = 0

function create(operation: CoreOperation, targetId: string): CoreTaskAccepted {
  taskCounter += 1
  const taskId = `task-${Date.now().toString(36)}-${taskCounter.toString(36)}`
  taskStates.set(taskId, { taskId, operation, targetId, state: 'queued', seq: 0, events: [] })
  return { taskId }
}

function append(taskId: string, stage: string, line: string, options: { terminal?: 'success' | 'failed', reason?: string } = {}): CoreTaskEvent | undefined {
  const state = taskStates.get(taskId)
  if (state === undefined)
    return undefined
  state.seq += 1
  state.state = options.terminal === 'success' ? 'succeeded' : options.terminal === 'failed' ? 'failed' : 'running'
  const event: CoreTaskEvent = {
    taskId,
    seq: state.seq,
    ts: new Date().toISOString(),
    state: state.state,
    stage,
    line,
    ...options.terminal === undefined ? {} : { terminal: options.terminal },
    ...options.reason === undefined ? {} : { reason: options.reason },
  }
  state.events.push(event)
  if (state.events.length > EVENT_RING_CAPACITY)
    state.events.splice(0, state.events.length - EVENT_RING_CAPACITY)
  return event
}

function since(taskId: string, sinceSeq?: number): CoreTaskEventPage {
  const state = taskStates.get(taskId)
  if (state === undefined)
    return { events: [], nextSeq: 1 }
  const after = sinceSeq === undefined ? 0 : Math.max(0, sinceSeq)
  return {
    events: state.events.filter(event => event.seq > after),
    nextSeq: state.seq + 1,
  }
}

function forget(taskId: string): void {
  taskStates.delete(taskId)
}

export const tasks = defineService({ create, append, since, forget })
