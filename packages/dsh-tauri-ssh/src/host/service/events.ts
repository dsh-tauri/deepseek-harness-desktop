/**
 * The machine-level log/progress event channel (`/api-ssh` method
 * `machine.events`): a per-machine ring buffer of bootstrap stages, drained
 * by polling (no SSE/WebSocket — the settings page polls `sinceSeq`
 * incrementally). Owned by this plugin's bootstrap plane; the connection
 * lifecycle stages (S3) extend the same stage union on this channel.
 * @module dsh-tauri-ssh/host/service/events
 */

import type { MachineId, SshMachineEvent, SshMachineEventsPage, SshMachineStage, SshMachineTerminal } from '../types/index'

export type { SshMachineEvent, SshMachineEventsPage, SshMachineStage, SshMachineTerminal }

/** Events kept per machine before the oldest are dropped. */
export const EVENT_RING_CAPACITY = 500

/**
 * The per-machine ring buffer. Appends are serialized through a monotonic
 * per-machine counter; reads never mutate. One instance is shared by the
 * manager and the `/api-ssh` route.
 */
export class SshMachineEvents {
  private readonly buffers = new Map<MachineId, { seq: number, events: SshMachineEvent[] }>()

  /**
   * @param capacity - events kept per machine (defaults to
   * {@link EVENT_RING_CAPACITY}).
   */
  constructor(private readonly capacity: number = EVENT_RING_CAPACITY) {}

  /**
   * Append one event.
   * @param machineId - the machine the event is about.
   * @param stage - the pipeline stage.
   * @param line - the displayable log line.
   * @param options - the terminal verdict and failure reason, when present.
   * @param options.terminal - the terminal verdict, when the event settles an operation.
   * @param options.reason - the failure reason, on `terminal: 'failed'`.
   * @returns the stored event (with its assigned `seq`).
   */
  append(machineId: MachineId, stage: SshMachineStage, line: string, options: { terminal?: SshMachineTerminal, reason?: string } = {}): SshMachineEvent {
    const buffer = this.ensure(machineId)
    buffer.seq += 1
    const event: SshMachineEvent = {
      seq: buffer.seq,
      ts: new Date().toISOString(),
      machineId,
      stage,
      line,
      ...options.terminal === undefined ? {} : { terminal: options.terminal },
      ...options.reason === undefined ? {} : { reason: options.reason },
    }
    buffer.events.push(event)
    if (buffer.events.length > this.capacity)
      buffer.events.splice(0, buffer.events.length - this.capacity)
    return event
  }

  /**
   * Drain one machine's events after `sinceSeq` (inclusive lower bound is
   * `sinceSeq + 1`; omit it to read from the beginning).
   * @param machineId - the machine to read.
   * @param sinceSeq - the last seq the caller already saw.
   * @returns the drained slice and the next poll cursor; unknown machines
   * report an empty page anchored at `nextSeq: 1` (the first event's seq).
   */
  since(machineId: MachineId, sinceSeq?: number): SshMachineEventsPage {
    const buffer = this.buffers.get(machineId)
    if (buffer === undefined)
      return { events: [], nextSeq: 1 }
    const after = sinceSeq === undefined ? 0 : Math.max(0, sinceSeq)
    return {
      events: buffer.events.filter(event => event.seq > after),
      nextSeq: buffer.seq + 1,
    }
  }

  /** Forget one machine's buffer (profile removed). */
  forget(machineId: MachineId): void {
    this.buffers.delete(machineId)
  }

  private ensure(machineId: MachineId): { seq: number, events: SshMachineEvent[] } {
    let buffer = this.buffers.get(machineId)
    if (buffer === undefined) {
      buffer = { seq: 0, events: [] }
      this.buffers.set(machineId, buffer)
    }
    return buffer
  }
}
