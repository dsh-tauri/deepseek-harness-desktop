import type { SessionId, SessionListState, WorkspaceSnapshot } from 'dsh-tauri/client'
import type { Translate } from '../locales/index.types'
import type { HistoryPage, HistoryRecord, SchedulerOptions, TaskFormState, TaskView } from '../types'

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

export const translate: Translate = (key, params) => key === 'picker.locale'
  ? 'en-US'
  : key === 'history.pruned'
    ? `${key}:days=${params?.days};records=${params?.records}`
    : key

export function optionsFixture(overrides: Partial<SchedulerOptions> = {}): SchedulerOptions {
  return {
    workspaces: [{ id: 'workspace-a', title: 'Workspace A', path: '/isolated/workspace-a' }],
    permissions: [{ value: 'workspace-write', name: 'Write' }, { value: 'read-only', name: 'Read' }],
    defaultPermission: 'workspace-write',
    models: [],
    failures: [],
    defaultModel: { provider: 'provider-a', providerLabel: 'Provider A', model: 'model-a', label: 'Model A', reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } },
    ...overrides,
  }
}

export function taskFixture(overrides: Partial<TaskView> = {}): TaskView {
  return {
    id: 'task-a',
    name: 'Task A',
    prompt: 'Original instruction',
    delivery: 'new-session',
    status: 'active',
    enabled: true,
    schedule: { kind: 'weekly', weekdays: ['MO', 'WE', 'FR'], time: '09:30', timeZone: 'Asia/Shanghai' },
    recommendationId: 'recommendation-a',
    workspaceId: 'workspace-a',
    permission: 'workspace-write',
    provider: 'provider-a',
    model: 'model-a',
    reasoningEffort: 'high',
    createdAt: '2030-01-01T00:00:00.000Z',
    updatedAt: '2030-01-02T00:00:00.000Z',
    ...overrides,
  }
}

export function formFixture(overrides: Partial<TaskFormState> = {}): TaskFormState {
  return {
    name: 'Draft task',
    prompt: 'Draft instruction',
    delivery: 'new-session',
    sessionId: 'session-a',
    enabled: true,
    schedule: { kind: 'daily', time: '09:30', timeZone: 'Asia/Shanghai' },
    recommendationId: 'recommendation-a',
    workspaceId: 'workspace-a',
    permission: 'workspace-write',
    provider: 'provider-a',
    model: 'model-a',
    reasoningEffort: 'high',
    ...overrides,
  }
}

export function sessionsFixture(overrides: Partial<SessionListState> = {}): SessionListState {
  const id = 'session-a' as SessionId
  return {
    ids: [id],
    phase: 'ready',
    projectionsBySession: {},
    byId: { [id]: { id, title: 'Session A', displayTitle: 'Session A', running: false, blank: false, updatedAt: 0, retainedBy: {} } },
    ...overrides,
  }
}

export function workspacesFixture(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return { items: [], archivedSessionIds: [], pinnedSessionIds: [], phase: 'ready', state: 'idle', error: null, ...overrides }
}

export function deliveryFixture(id: string, overrides: Partial<Extract<HistoryRecord, { delivery: 'this-session' }>> = {}): Extract<HistoryRecord, { delivery: 'this-session' }> {
  return {
    id,
    taskId: 'task-a',
    taskName: 'Task A',
    delivery: 'this-session',
    occurrence: `occurrence-${id}`,
    trigger: 'schedule',
    sessionId: 'session-a',
    scheduledAt: '2030-01-02T01:00:00.000Z',
    deliveredAt: '2030-01-02T01:00:02.000Z',
    messageId: `message-${id}`,
    prompt: `Prompt ${id}`,
    ...overrides,
  }
}

export function runFixture(id: string, overrides: Partial<Extract<HistoryRecord, { delivery: 'new-session' }>> = {}): Extract<HistoryRecord, { delivery: 'new-session' }> {
  return {
    id,
    taskId: 'task-a',
    taskName: 'Task A',
    delivery: 'new-session',
    occurrence: `occurrence-${id}`,
    trigger: 'manual',
    status: 'failed',
    sessionId: 'session-a',
    scheduledFor: '2030-01-02T02:00:00.000Z',
    startedAt: '2030-01-02T02:00:03.000Z',
    finishedAt: '2030-01-02T02:00:07.000Z',
    error: 'Run failed',
    prompt: `Prompt ${id}`,
    ...overrides,
  }
}

export function pageFixture(records: HistoryRecord[] = [], overrides: Partial<HistoryPage> = {}): HistoryPage {
  return { records, earlierRecordsUnavailable: false, earlierRecordsPruned: false, retention: { days: 30, records: 500 }, ...overrides }
}
