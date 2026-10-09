import type { InstallResult, MachineListSnapshot, ProgressPhase } from '../../types/index'
import type { MachineBusyOp, MachinesState } from './machines.types'
import { defineStore } from 'dsh-tauri/client'

const LOG_TAIL_LINES = 300

function initialState(): MachinesState {
  return {
    status: 'idle',
    error: null,
    enabled: null,
    enabling: false,
    machines: [],
    discovered: [],
    statuses: {},
    logs: {},
    trails: {},
    busy: {},
    notice: null,
    installResults: {},
    role: null,
    migrationWarning: null,
    eventCursors: {},
    eventsSupported: true,
  }
}

export const machines = defineStore({
  state: (): MachinesState => initialState(),
  actions: {
    reset(): void {
      Object.assign(this, initialState())
    },
    beginLoad(): void {
      this.status = 'loading'
      this.error = null
    },
    commitList(list: MachineListSnapshot): void {
      this.machines = list.machines
      this.discovered = list.discovered
      this.statuses = list.statuses
      const trails: Record<string, ProgressPhase[]> = {}
      for (const [id, status] of Object.entries(list.statuses)) {
        if (status.progress === undefined)
          continue
        const trail = this.trails[id] ?? []
        trails[id] = trail[trail.length - 1] === status.progress.phase
          ? trail
          : [...trail, status.progress.phase]
      }
      this.trails = trails
      const known = new Set([...list.machines, ...list.discovered].map(row => row.id))
      for (const id of Object.keys(this.eventCursors)) {
        if (!known.has(id))
          delete this.eventCursors[id]
      }
      this.status = 'ready'
      this.error = null
    },
    failList(error: string): void {
      this.status = 'error'
      this.error = error
    },
    fail(error: string): void {
      this.error = error
    },
    clearError(): void {
      this.error = null
    },
    setEnabled(enabled: boolean, error: string | null): void {
      this.enabled = enabled
      this.error = error
    },
    beginEnable(): void {
      this.enabling = true
      this.error = null
    },
    endEnable(): void {
      this.enabling = false
    },
    setRole(role: { remote: boolean, origin?: string }): void {
      this.role = role
    },
    setMigrationWarning(warning: string | null): void {
      this.migrationWarning = warning
    },
    beginOp(id: string, op: MachineBusyOp): void {
      this.busy[id] = op
      this.notice = null
      this.error = null
    },
    endOp(id: string): void {
      delete this.busy[id]
    },
    commitProbeOk(id: string, banner?: string): void {
      this.notice = banner === undefined || banner === '' ? { kind: 'key', key: 'notice.probe_ok' } : { kind: 'text', text: banner }
      if (this.statuses[id] === undefined)
        this.statuses[id] = { state: 'disconnected' }
    },
    commitProbeFailed(id: string, message?: string): void {
      this.notice = message === undefined || message === '' ? { kind: 'key', key: 'notice.probe_failed' } : { kind: 'text', text: message }
      const current = this.statuses[id]
      const lastError = { lastError: message === undefined ? 'failed' : message }
      this.statuses[id] = current === undefined || current.state === 'disconnected'
        ? { state: 'disconnected', ...lastError }
        : { ...current, ...lastError }
    },
    commitConnected(id: string, tunnelBaseUrl: string): void {
      this.statuses[id] = { state: 'connected', tunnelBaseUrl }
      this.notice = { kind: 'key', key: 'notice.connected', params: { url: tunnelBaseUrl } }
    },
    commitDisconnected(id: string): void {
      this.statuses[id] = { state: 'disconnected' }
      this.notice = { kind: 'key', key: 'notice.disconnected' }
    },
    commitInstallResult(id: string, result: InstallResult): void {
      this.installResults[id] = result
    },
    appendLogs(lines: Record<string, string[]>): void {
      for (const [id, incoming] of Object.entries(lines))
        this.logs[id] = [...(this.logs[id] ?? []), ...incoming].slice(-LOG_TAIL_LINES)
    },
    advanceEvents(cursors: Record<string, number>): void {
      for (const [id, seq] of Object.entries(cursors)) {
        const current = this.eventCursors[id]
        if (current === undefined || seq > current)
          this.eventCursors[id] = seq
      }
    },
    disableEvents(): void {
      this.eventsSupported = false
    },
  },
})
