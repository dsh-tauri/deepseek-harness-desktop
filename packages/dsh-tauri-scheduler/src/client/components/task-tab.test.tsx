// @vitest-environment jsdom
import type { SessionId } from 'dsh-tauri/client'
import type { ComponentProps } from 'react'
import type { TaskView } from '../types'
import type { TaskTabInfo } from '../types/task-tab'
import type { DeliveryHistory } from './delivery-history'
import type { TaskForm } from './task-form'
import type { TaskTabProps } from './task-tab'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteTasks, getHistory, getOptions, getTasks, postTasks } from '../apis'
import { loadScheduler } from '../service/scheduler'
import { TaskTabBindings } from '../service/task-tab-bindings'
import { store } from '../store'
import { deferred, formFixture, sessionsFixture, taskFixture, translate, workspacesFixture } from './scheduler-client.test.harness'
import { TaskTab } from './task-tab'

type FormProps = ComponentProps<typeof TaskForm>
type HistoryProps = ComponentProps<typeof DeliveryHistory>
type TasksReply = Awaited<ReturnType<typeof getTasks>>
type HistoryReply = Awaited<ReturnType<typeof getHistory>>
type OptionsReply = Awaited<ReturnType<typeof getOptions>>

const observed = vi.hoisted(() => ({ form: vi.fn<(props: FormProps) => void>(), history: vi.fn<(props: HistoryProps) => void>() }))

vi.mock('../apis', () => ({
  getTasks: vi.fn(),
  getHistory: vi.fn(),
  getOptions: vi.fn(),
  deleteTasks: vi.fn(),
  deleteHistory: vi.fn(),
  postTasks: vi.fn(),
  putTasks: vi.fn(),
  postTasksToggle: vi.fn(),
  postTasksRun: vi.fn(),
  postRunsRecover: vi.fn(),
}))
vi.mock('./task-form', () => ({
  TaskForm(props: FormProps) {
    observed.form(props)
    return (
      <section aria-label="form projection">
        {props.feedback}
        <div hidden={props.view === 'records'}>
          <button type="button" disabled={props.disabled} onClick={() => props.onSaved(taskFixture({ id: 'saved-task', sessionId: 'session-b' }))}>save projection</button>
          <button type="button" onClick={props.onClose}>close projection</button>
          {props.recommendations}
        </div>
        {props.history}
      </section>
    )
  },
}))
vi.mock('./delivery-history', () => ({
  DeliveryHistory(props: HistoryProps) {
    observed.history(props)
    return <section aria-label="history projection">{props.taskId}</section>
  },
}))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const ui = await import('./scheduler-client.test.ui')
  return { Button: ui.PrimitiveButton, Input: ui.PrimitiveInput, Menu: ui.PrimitiveMenu }
})
vi.mock('dsh-tauri-ui/client', async () => {
  const ui = await import('./scheduler-client.test.ui')
  const { Calendar } = await import('../../../../dsh-tauri-ui/src/client/components/icons')
  const { styles } = await import('../../../../dsh-tauri-ui/src/client/constants/theme')
  return { ...await ui.schedulerClientUi(), Calendar, styles }
})

function optionsReply(): OptionsReply {
  return { workspaces: [], permissions: [], defaultPermission: 'read-only', models: [], failures: [], defaultModel: null }
}

function tasksReply(tasks: readonly TaskView[]): TasksReply {
  return { tasks: tasks.map(task => ({ ...task, schedule: task.schedule.kind === 'weekly' ? { ...task.schedule, weekdays: [...task.schedule.weekdays] } : { ...task.schedule } })) }
}

function historyReply(): HistoryReply {
  return { ok: true, records: [], runs: [], earlierRecordsUnavailable: false, earlierRecordsPruned: false, retention: { days: 30, records: 500 } }
}

function resetStores(): void {
  store.scheduler.$patch({ tasks: [], runs: [], options: optionsReply(), loading: false, error: '', refreshedAt: 0, loadToken: 0, successfulReadToken: 0, readAt: 0, readIds: [] })
  store.deletion.$patch({ pendingTask: null, deletingTaskId: null, feedback: null, feedbackSeq: 0 })
  store.navigation.$patch({ target: null, seq: 0, error: '' })
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('localStorage', (globalThis as unknown as { jsdom: { window: Window } }).jsdom.window.localStorage)
  localStorage.clear()
  resetStores()
  vi.mocked(getTasks).mockResolvedValue(tasksReply([taskFixture()]))
  vi.mocked(getHistory).mockResolvedValue(historyReply())
  vi.mocked(getOptions).mockResolvedValue(optionsReply())
})

afterEach(() => {
  cleanup()
  resetStores()
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function snapshotFeed<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  const getSnapshot = () => value
  function useValue(): T {
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  }
  return {
    useValue,
    useSnapshot<S>(select: (snapshot: T) => S): S {
      return select(useValue())
    },
    publish(next: T): void {
      value = next
      listeners.forEach(listener => listener())
    },
  }
}

function tabFixture(navigation: TaskTabInfo['tab']['navigation'] = { params: { id: 'task-a' }, revision: 1 }, overrides: Partial<TaskTabInfo['tab']> = {}): TaskTabInfo['tab'] {
  return {
    id: 'page-a',
    kind: 'scheduleTask',
    contentId: 'content-a',
    title: 'Task tab',
    visible: true,
    navigation,
    signal: new AbortController().signal,
    actions: { close: vi.fn(), openTab: vi.fn(), bindCommands: vi.fn(() => vi.fn()) },
    ...overrides,
  }
}

async function renderTab(tab = tabFixture(), taskBindings = new TaskTabBindings()) {
  const sessions = snapshotFeed(sessionsFixture())
  const workspaces = snapshotFeed(workspacesFixture())
  const tabs = snapshotFeed<TaskTabInfo>({ tab })
  const boundary: Pick<TaskTabProps, 'sessionId' | 't' | 'taskBindings' | 'openHistorySession' | 'useTabInfo' | 'useSessions' | 'useWorkspaces'> = {
    sessionId: 'session-a' as SessionId,
    t: translate,
    taskBindings,
    openHistorySession: vi.fn(async () => ({ ok: true })),
    useTabInfo: tabs.useValue,
    useSessions: sessions.useSnapshot,
    useWorkspaces: workspaces.useSnapshot,
  }
  const props = boundary as TaskTabProps
  const view = render(<TaskTab {...props} />)
  await act(async () => {})
  return { ...view, props, tab, taskBindings, sessions, workspaces, tabs }
}

function lastForm(): FormProps {
  expect(observed.form).toHaveBeenCalled()
  return observed.form.mock.lastCall![0]
}

async function lastHistory(view: Awaited<ReturnType<typeof renderTab>>): Promise<HistoryProps> {
  await act(async () => {
    fireEvent.click(view.getByRole('tab', { name: 'detail.records' }))
  })
  expect(observed.history).toHaveBeenCalled()
  return observed.history.mock.lastCall![0]
}

function pendingRead() {
  const tasks = deferred<TasksReply>()
  const history = deferred<HistoryReply>()
  vi.mocked(getTasks).mockImplementationOnce(() => tasks.promise)
  vi.mocked(getHistory).mockImplementationOnce(() => history.promise)
  return { tasks, history }
}

async function resolveRead(read: ReturnType<typeof pendingRead>, tasks: readonly TaskView[]): Promise<void> {
  await act(async () => {
    read.tasks.resolve(tasksReply(tasks))
    read.history.resolve(historyReply())
    await Promise.all([read.tasks.promise, read.history.promise])
  })
}

function recoveredTab(targetId = 'task-a') {
  const tab = tabFixture({ revision: 1 })
  new TaskTabBindings().write('session-a', tab, { id: targetId, sessionId: 'session-a' })
  return { tab, bindings: new TaskTabBindings() }
}

async function finishDeletion(task: TaskView, outcome: { ok: boolean, error?: string }): Promise<void> {
  await act(async () => {
    store.deletion.request(task)
    expect(store.deletion.begin()?.id).toBe(task.id)
    store.deletion.finish(task, outcome)
  })
}

describe('taskTab fresh reads and retained editing snapshot', () => {
  it('disables cached active task editing after a fresh inactive record without replacing the editing snapshot', async () => {
    const cached = taskFixture()
    store.scheduler.$patch({ tasks: [cached] })
    const read = pendingRead()
    const view = await renderTab()
    expect((view.getByRole('button', { name: 'save projection' }) as HTMLButtonElement).disabled).toBe(false)
    expect(lastForm().task).toEqual(cached)
    expect(lastForm().task).not.toBe(cached)
    const fresh = taskFixture({ status: 'inactive', name: 'Fresh task name', prompt: 'Fresh instruction', lastRunAt: '2030-01-03T12:00:00.000Z', schedule: { kind: 'daily', time: '10:00', timeZone: 'UTC' } })
    await resolveRead(read, [fresh])
    expect(view.getByText('task.inactive').textContent).toBe('task.inactive')
    expect((view.getByRole('button', { name: 'save projection' }) as HTMLButtonElement).disabled).toBe(true)
    expect(lastForm().disabled).toBe(true)
    expect(lastForm().task).toEqual(cached)
    expect(view.getByRole('heading', { name: 'Task A' }).textContent).toBe('Task A')
    expect(view.queryByText('Fresh task name')).toBeNull()
    expect(await lastHistory(view)).toMatchObject({ taskId: 'task-a', refreshKey: '2030-01-03T12:00:00.000Z', timeZone: 'Asia/Shanghai' })
  })

  it('does not treat a pre-mount successful catalog read as the required fresh missing answer', async () => {
    store.scheduler.$patch({ loadToken: 4, successfulReadToken: 4 })
    const read = pendingRead()
    const view = await renderTab()
    expect(view.getByRole('status').textContent).toBe('loading')
    expect(view.queryByText('task.missing')).toBeNull()
    expect(store.scheduler.loadToken).toBe(5)
    await resolveRead(read, [])
    expect(view.getByRole('status').textContent).toBe('task.missing')
    expect(store.scheduler.successfulReadToken).toBe(5)
    expect(observed.form).not.toHaveBeenCalled()
  })

  it.each(['tasks', 'history'] as const)('keeps a recovered binding and never reports missing after a failed %s read', async (failure) => {
    store.scheduler.$patch({ loadToken: 4, successfulReadToken: 4 })
    const { tab, bindings } = recoveredTab()
    const read = pendingRead()
    const view = await renderTab(tab, bindings)
    expect(view.getByRole('status').textContent).toBe('loading')
    await act(async () => {
      if (failure === 'tasks') {
        const error = new Error('Catalog read failed')
        read.tasks.reject(error)
        read.history.resolve(historyReply())
        await expect(read.tasks.promise).rejects.toBe(error)
      }
      else {
        read.tasks.resolve(tasksReply([]))
        read.history.resolve({ ok: false, error: 'Catalog read failed' })
        await Promise.all([read.tasks.promise, read.history.promise])
      }
    })
    expect(view.getByRole('status').textContent).toBe('Catalog read failed')
    expect(view.queryByText('task.missing')).toBeNull()
    expect(store.scheduler.successfulReadToken).toBe(4)
    expect(bindings.read('session-a', tab)).toEqual({ id: 'task-a', sessionId: 'session-a' })
    expect(new TaskTabBindings().read('session-a', tab)).toEqual({ id: 'task-a', sessionId: 'session-a' })
    expect(observed.form).not.toHaveBeenCalled()
  })

  it('preserves a cached form and binding after a failed read instead of disabling it as missing', async () => {
    store.scheduler.$patch({ tasks: [taskFixture()] })
    const { tab, bindings } = recoveredTab()
    const read = pendingRead()
    const view = await renderTab(tab, bindings)
    await act(async () => {
      read.tasks.resolve(tasksReply([]))
      read.history.resolve({ ok: false, error: 'History read failed' })
      await Promise.all([read.tasks.promise, read.history.promise])
    })
    expect(view.getByRole('alert').textContent).toBe('History read failed')
    expect(view.queryByText('task.missing')).toBeNull()
    expect(lastForm().disabled).toBe(false)
    expect(lastForm().task?.id).toBe('task-a')
    expect(bindings.read('session-a', tab)).toEqual({ id: 'task-a', sessionId: 'session-a' })
  })

  it('forgets recovered identity only after a later successful fresh missing read', async () => {
    const { tab, bindings } = recoveredTab()
    const failed = pendingRead()
    const view = await renderTab(tab, bindings)
    await act(async () => {
      failed.tasks.resolve(tasksReply([]))
      failed.history.resolve({ ok: false, error: 'Read failed, retry' })
      await Promise.all([failed.tasks.promise, failed.history.promise])
    })
    expect(bindings.read('session-a', tab)).toEqual({ id: 'task-a', sessionId: 'session-a' })
    const retry = pendingRead()
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'refresh' }))
    })
    expect(view.getByRole('status').textContent).toBe('loading')
    const pendingBinding = bindings.read('session-a', tab)
    if (!pendingBinding || !('id' in pendingBinding))
      throw new Error('Expected the recovered task binding during retry')
    expect(pendingBinding.id).toBe('task-a')
    await resolveRead(retry, [])
    expect(view.getByRole('status').textContent).toBe('task.missing')
    expect(bindings.read('session-a', tab)).toBeUndefined()
    expect(new TaskTabBindings().read('session-a', tab)).toBeUndefined()
    expect(localStorage.getItem('dsh.schedule.task-tab.v1.session-a')).toBeNull()
    expect(getTasks).toHaveBeenCalledTimes(2)
  })

  it('keeps retained content readable but disables editing when a fresh successful read removes the task', async () => {
    const cached = taskFixture()
    store.scheduler.$patch({ tasks: [cached] })
    const { tab, bindings } = recoveredTab()
    const read = pendingRead()
    const view = await renderTab(tab, bindings)
    await resolveRead(read, [])
    expect(view.getByRole('status').textContent).toBe('task.missing')
    expect(view.getByRole('heading', { name: 'Task A' }).textContent).toBe('Task A')
    expect(lastForm().task).toEqual(cached)
    expect(lastForm().disabled).toBe(true)
    expect((await lastHistory(view)).taskId).toBe('task-a')
    expect(bindings.read('session-a', tab)).toBeUndefined()
  })

  it('ignores an older missing response after a newer successful catalog response', async () => {
    store.scheduler.$patch({ tasks: [taskFixture()] })
    const oldRead = pendingRead()
    const view = await renderTab()
    const newRead = pendingRead()
    let loading!: Promise<void>
    await act(async () => {
      loading = loadScheduler()
    })
    await resolveRead(newRead, [taskFixture()])
    await loading
    await resolveRead(oldRead, [])
    expect(store.scheduler.successfulReadToken).toBe(2)
    expect(store.scheduler.tasks.map(task => task.id)).toEqual(['task-a'])
    expect(view.queryByText('task.missing')).toBeNull()
    expect(lastForm().disabled).toBe(false)
  })
})

describe('taskTab navigation and draft binding', () => {
  it('uses explicit navigation instead of an unrelated recovered binding', async () => {
    const tab = tabFixture({ params: { id: 'task-a', sessionId: 'session-a' }, revision: 1 })
    const bindings = new TaskTabBindings()
    bindings.write('session-a', tab, { id: 'task-b', sessionId: 'session-b' })
    const view = await renderTab(tab, bindings)
    expect(lastForm().task?.id).toBe('task-a')
    expect((await lastHistory(view)).taskId).toBe('task-a')
    expect(bindings.read('session-a', tab)).toEqual({ id: 'task-a', sessionId: 'session-a' })
    expect(view.getByRole('heading', { name: 'Task A' }).textContent).toBe('Task A')
  })

  it('does not fall back to a recovered identity when explicit navigation is malformed', async () => {
    const tab = tabFixture({ params: { id: 42 }, revision: 1 })
    const bindings = new TaskTabBindings()
    bindings.write('session-a', tab, { id: 'task-a' })
    const view = await renderTab(tab, bindings)
    expect(view.getByRole('status').textContent).toBe('task.unbound')
    expect(observed.form).not.toHaveBeenCalled()
    expect(observed.history).not.toHaveBeenCalled()
    expect(bindings.read('session-a', tab)).toEqual({ id: 'task-a', sessionId: undefined })
  })

  it('resets the retained editing snapshot when the same tab navigates to another task revision', async () => {
    const first = taskFixture()
    const second = taskFixture({ id: 'task-b', name: 'Task B', prompt: 'Task B instruction' })
    vi.mocked(getTasks).mockResolvedValue(tasksReply([first, second]))
    store.scheduler.$patch({ tasks: [first, second] })
    const view = await renderTab()
    const next = { ...view.tab, navigation: { params: { id: 'task-b' }, revision: 2 } }
    await act(async () => {
      view.tabs.publish({ tab: next })
    })
    expect(view.getByRole('heading', { name: 'Task B' }).textContent).toBe('Task B')
    expect(lastForm().task).toEqual(second)
    expect(lastForm().task).not.toBe(second)
    expect((await lastHistory(view)).taskId).toBe('task-b')
    expect(view.taskBindings.read('session-a', next)).toEqual({ id: 'task-b', sessionId: undefined })
    expect(getOptions).toHaveBeenCalledTimes(2)
  })

  it('forgets previous identity for a draft and passes its initial state without selecting a cached task', async () => {
    const initial = formFixture({ name: 'Draft navigation', schedule: { kind: 'interval', everyMinutes: 1.5, anchor: '2030-01-01T12:00:00.000Z', timeZone: 'UTC' } })
    const tab = tabFixture({ params: { draft: true, sessionId: 'session-a', initial }, revision: 1 })
    const bindings = new TaskTabBindings()
    bindings.write('session-a', tab, { id: 'task-a' })
    const view = await renderTab(tab, bindings)
    expect(view.getByRole('heading', { name: 'createDialogTitle' }).textContent).toBe('createDialogTitle')
    expect(lastForm()).toMatchObject({ initial, defaultSessionId: 'session-a', disabled: false })
    expect(lastForm().task).toBeUndefined()
    expect(bindings.read('session-a', tab)).toBeUndefined()
    expect(new TaskTabBindings().read('session-a', tab)).toBeUndefined()
    expect(view.queryByRole('button', { name: 'delete' })).toBeNull()
    expect(observed.history).not.toHaveBeenCalled()
  })

  it('keeps a draft unbound and displays options failure without rendering a partially initialized form', async () => {
    vi.mocked(getOptions).mockRejectedValueOnce(new Error('Model options unavailable'))
    const tab = tabFixture({ params: { draft: true, initial: formFixture() }, revision: 1 })
    const bindings = new TaskTabBindings()
    bindings.write('session-a', tab, { id: 'task-a' })
    const view = await renderTab(tab, bindings)
    expect(view.getByRole('alert').textContent).toBe('Model options unavailable')
    expect(view.getByRole('heading', { name: 'createDialogTitle' }).textContent).toBe('createDialogTitle')
    expect(view.getByRole('region', { name: 'recommended' })).not.toBeNull()
    expect(observed.form).not.toHaveBeenCalled()
    expect(observed.history).not.toHaveBeenCalled()
    expect(bindings.read('session-a', tab)).toBeUndefined()
    expect(view.tab.actions.close).not.toHaveBeenCalled()
  })

  it('keeps task history readable after options failure without losing its binding', async () => {
    vi.mocked(getOptions).mockRejectedValueOnce(new Error('Options read failed'))
    const view = await renderTab()
    expect(view.getByRole('alert').textContent).toBe('Options read failed')
    expect((await lastHistory(view)).taskId).toBe('task-a')
    expect(observed.form).not.toHaveBeenCalled()
    expect(view.taskBindings.read('session-a', view.tab)).toEqual({ id: 'task-a', sessionId: undefined })
    expect(view.tab.actions.close).not.toHaveBeenCalled()
  })

  it('opens a real recommendation as a draft instead of creating or binding a task', async () => {
    const view = await renderTab(tabFixture({ params: { draft: true }, revision: 1 }))
    await act(async () => {
      fireEvent.click(within(view.getByRole('region', { name: 'recommended' })).getByRole('button', { name: /recReviewName/ }))
    })
    expect(view.tab.actions.openTab).toHaveBeenCalledExactlyOnceWith('scheduleTask', {
      params: { draft: true, sessionId: 'session-a', initial: { delivery: 'new-session', sessionId: '', enabled: false, name: 'recReviewName', schedule: { kind: 'weekly', weekdays: ['FR'], time: '16:00' }, prompt: 'recReviewPrompt', workspaceId: '', permission: 'read-only', provider: '', model: '', reasoningEffort: '', recommendationId: 'weekly-review' } },
    })
    expect(postTasks).not.toHaveBeenCalled()
    expect(view.taskBindings.read('session-a', view.tab)).toBeUndefined()
  })

  it('forwards a saved task and close action through the public tab navigation boundary', async () => {
    const view = await renderTab()
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'save projection' }))
    })
    expect(view.tab.actions.openTab).toHaveBeenCalledExactlyOnceWith('scheduleTask', { params: { id: 'saved-task', sessionId: 'session-b' } })
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'close projection' }))
    })
    expect(view.tab.actions.close).toHaveBeenCalledTimes(1)
  })
})

describe('taskTab deletion feedback and live session feeds', () => {
  it('requests deletion without closing before confirmation and ignores historical or unrelated feedback', async () => {
    const task = taskFixture()
    await finishDeletion(task, { ok: true })
    const view = await renderTab()
    expect(view.tab.actions.close).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'detail.more' }))
    })
    await act(async () => {
      fireEvent.click(view.getByRole('menuitem', { name: 'delete' }))
    })
    expect(store.deletion.pendingTask).toEqual(task)
    expect(view.tab.actions.close).not.toHaveBeenCalled()
    await finishDeletion(taskFixture({ id: 'task-b', name: 'Task B' }), { ok: true })
    expect(view.tab.actions.close).not.toHaveBeenCalled()
    await finishDeletion(task, { ok: false, error: 'Delete failed' })
    expect(view.tab.actions.close).not.toHaveBeenCalled()
    await finishDeletion(task, { ok: true })
    expect(view.tab.actions.close).toHaveBeenCalledTimes(1)
    expect(deleteTasks).not.toHaveBeenCalled()
  })

  it('matches deletion feedback to the new target after the tab navigation revision changes', async () => {
    const first = taskFixture()
    const second = taskFixture({ id: 'task-b', name: 'Task B' })
    vi.mocked(getTasks).mockResolvedValue(tasksReply([first, second]))
    store.scheduler.$patch({ tasks: [first, second] })
    const view = await renderTab()
    const next = { ...view.tab, navigation: { params: { id: 'task-b' }, revision: 2 } }
    await act(async () => {
      view.tabs.publish({ tab: next })
    })
    await finishDeletion(first, { ok: true })
    expect(view.tab.actions.close).not.toHaveBeenCalled()
    await finishDeletion(second, { ok: true })
    expect(view.tab.actions.close).toHaveBeenCalledTimes(1)
  })

  it('updates inherited session availability from real subscription feeds without a catalog reload', async () => {
    const task = taskFixture({ delivery: 'this-session', sessionId: 'session-b', workspaceId: undefined, permission: undefined, provider: undefined, model: undefined, reasoningEffort: undefined })
    vi.mocked(getTasks).mockResolvedValue(tasksReply([task]))
    const view = await renderTab(tabFixture({ params: { id: 'task-a', sessionId: 'session-b' }, revision: 1 }))
    await act(async () => {
      view.sessions.publish(sessionsFixture({ ids: ['session-b' as SessionId], byId: { ['session-b' as SessionId]: { ...sessionsFixture().byId['session-a' as SessionId], id: 'session-b' as SessionId } } }))
    })
    const link = view.getByRole('button', { name: 'session.link: Session A' }) as HTMLButtonElement
    expect(link.disabled).toBe(false)
    vi.mocked(view.props.openHistorySession).mockResolvedValueOnce({ ok: false, error: 'Session open failed' })
    await act(async () => {
      fireEvent.click(link)
    })
    expect(view.props.openHistorySession).toHaveBeenCalledExactlyOnceWith('session-b')
    expect(view.getByRole('alert').textContent).toBe('Session open failed')
    await act(async () => {
      view.workspaces.publish(workspacesFixture({ archivedSessionIds: ['session-b' as SessionId] }))
    })
    expect((view.getByRole('button', { name: 'session.link: Session A' }) as HTMLButtonElement).disabled).toBe(true)
    expect(lastForm().workspaces.archivedSessionIds).toEqual(['session-b'])
    expect((await lastHistory(view)).workspaces.archivedSessionIds).toEqual(['session-b'])
    expect(getTasks).toHaveBeenCalledTimes(1)
    expect(getHistory).toHaveBeenCalledExactlyOnceWith({ limit: 100 })
  })
})
