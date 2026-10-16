import type { MachineId, RemoteMachineEvent, RemoteMachineEventsPage, RemoteMachineStage, RemoteMachineTerminal } from '../types/index'
import { defineService } from 'dsh-tauri'
import { eventBuffers, eventRingCapacity } from '../config/runtime'

export const events = defineService({
  append(machineId: MachineId, stage: RemoteMachineStage, line: string, options: { terminal?: RemoteMachineTerminal, reason?: string } = {}): RemoteMachineEvent {
    const buffer = ensureBuffer(machineId)
    buffer.seq += 1
    const event: RemoteMachineEvent = {
      seq: buffer.seq,
      ts: new Date().toISOString(),
      machineId,
      stage,
      line,
      ...options.terminal === undefined ? {} : { terminal: options.terminal },
      ...options.reason === undefined ? {} : { reason: options.reason },
    }
    buffer.events.push(event)
    const capacity = eventRingCapacity()
    if (buffer.events.length > capacity)
      buffer.events.splice(0, buffer.events.length - capacity)
    return event
  },

  since(machineId: MachineId, sinceSeq?: number): RemoteMachineEventsPage {
    const buffer = eventBuffers.get(machineId)
    if (buffer === undefined)
      return { events: [], nextSeq: 1 }
    const after = sinceSeq === undefined ? 0 : Math.max(0, sinceSeq)
    return {
      events: buffer.events.filter(event => event.seq > after),
      nextSeq: buffer.seq + 1,
    }
  },

  forget(machineId: MachineId): void {
    eventBuffers.delete(machineId)
  },
})

function ensureBuffer(machineId: MachineId): { seq: number, events: RemoteMachineEvent[] } {
  let buffer = eventBuffers.get(machineId)
  if (buffer === undefined) {
    buffer = { seq: 0, events: [] }
    eventBuffers.set(machineId, buffer)
  }
  return buffer
}
