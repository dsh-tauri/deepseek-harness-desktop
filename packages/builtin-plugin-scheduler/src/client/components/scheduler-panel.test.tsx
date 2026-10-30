// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { loadOptions, loadScheduler, updateTask } from '../service/scheduler'
import { store } from '../store'
import { optionsFixture, sessionsFixture, taskFixture, translate, workspacesFixture } from './scheduler-client.test.harness'
import { SchedulerPanel } from './scheduler-panel'

vi.mock('../service/scheduler', () => ({ createTask: vi.fn(), updateTask: vi.fn(), runTask: vi.fn(), toggleTask: vi.fn(), loadScheduler: vi.fn(), loadOptions: vi.fn(), loadTaskHistory: vi.fn(async () => ({ records: [], earlierRecordsUnavailable: false, earlierRecordsPruned: false, retention: { days: 30, records: 200 } })) }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const ui = await import('./scheduler-client.test.ui')
  return { Button: ui.PrimitiveButton, Input: ui.PrimitiveInput, Menu: ui.PrimitiveMenu }
})
vi.mock('dsh-tauri-ui/client', async () => (await import('./scheduler-client.test.ui')).schedulerClientUi())

const sessions = sessionsFixture()
const workspaces = workspacesFixture()
function source<T>(value: T) {
  return {
    value,
    getSnapshot() {
      return this.value
    },
    subscribe(_listener: () => void) {
      expect(this.value).toBe(value)
      return () => {}
    },
  }
}
const runtime = { sessionsRuntime: { list: source(sessions) }, workspacesRuntime: { list: source(workspaces) }, openHistorySession: vi.fn(async () => ({ ok: true })) }

beforeEach(() => {
  vi.mocked(loadScheduler).mockResolvedValue(undefined)
  vi.mocked(loadOptions).mockResolvedValue(undefined)
  store.scheduler.$patch({ options: optionsFixture() })
  store.scheduler.$patch({ tasks: [], loading: false, error: '' })
  store.navigation.$patch({ target: null, seq: 0, error: '' })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('renders the task catalog without redundant page tabs and keeps both creation actions', () => {
  const onViaChat = vi.fn()
  const view = render(<SchedulerPanel {...runtime} t={translate} onViaChat={onViaChat} />)
  expect(view.queryByRole('tablist')).toBeNull()
  fireEvent.click(view.getByRole('button', { name: 'createManual' }))
  expect(store.navigation.target).toBeNull()
  expect(view.getByRole('complementary', { name: 'createDialogTitle' })).not.toBeNull()
  fireEvent.click(view.getByRole('button', { name: 'viaChat' }))
  expect(onViaChat).toHaveBeenCalledTimes(1)
})

it.each(['new-session', 'this-session'] as const)('opens a %s task inside the catalog without requesting session navigation', async (delivery) => {
  const task = taskFixture({ delivery, sessionId: delivery === 'this-session' ? 'session-a' : undefined })
  store.scheduler.$patch({ tasks: [task] })
  const view = render(<SchedulerPanel {...runtime} t={translate} onViaChat={vi.fn()} />)
  await act(async () => {
    fireEvent.click(view.getByText('Task A'))
  })
  expect(store.navigation.seq).toBe(0)
  expect(store.navigation.target).toBeNull()
  expect(runtime.openHistorySession).not.toHaveBeenCalled()
  const detail = view.getByRole('complementary', { name: 'Task A' })
  expect(view.getByRole('heading', { name: 'scheduler', level: 1 })).not.toBeNull()
  fireEvent.click(within(detail).getByRole('button', { name: 'close' }))
  expect(view.queryByRole('complementary')).toBeNull()
})

it('reseeds the exact expected snapshot after a save so a second edit does not conflict or cancel to old values', async () => {
  const task = taskFixture()
  store.scheduler.$patch({ tasks: [task] })
  const saved = { ...task, name: 'First save', updatedAt: '2030-05-06T08:08:09.000Z' }
  vi.mocked(updateTask).mockResolvedValueOnce({ ok: true, task: saved }).mockResolvedValueOnce({ ok: true, task: { ...saved, name: 'Second save' } })
  const view = render(<SchedulerPanel {...runtime} t={translate} onViaChat={vi.fn()} />)
  await act(async () => {
    fireEvent.click(view.getByText('Task A'))
  })
  const name = () => view.getByRole('textbox', { name: 'taskName' }) as HTMLInputElement
  fireEvent.change(name(), { target: { value: 'First save' } })
  await act(async () => {
    fireEvent.submit(name().closest('form')!)
  })
  expect(name().value).toBe('First save')
  expect(view.queryByRole('button', { name: 'save' })).toBeNull()
  fireEvent.change(name(), { target: { value: 'Second save' } })
  await act(async () => {
    fireEvent.submit(name().closest('form')!)
  })
  expect(vi.mocked(updateTask).mock.calls[1]![2]).toEqual(saved)
  expect(name().value).toBe('Second save')
  fireEvent.change(name(), { target: { value: 'Discard me' } })
  fireEvent.click(view.getByRole('button', { name: 'cancel' }))
  expect(name().value).toBe('Second save')
})

it('puts a small session chip after the reminder title and keeps global task titles unmarked', () => {
  store.scheduler.$patch({ tasks: [taskFixture({ name: 'Global task' }), taskFixture({ id: 'reminder', name: 'Reminder', delivery: 'this-session', sessionId: 'session-a' })] })
  const view = render(<SchedulerPanel {...runtime} t={translate} onViaChat={vi.fn()} />)
  const global = view.getByText('Global task').closest('li')!
  const reminder = view.getByText('Reminder').closest('li')!
  expect(within(global).queryByLabelText('delivery.new-session')).toBeNull()
  const chip = within(reminder).getByText('task.session')
  expect(chip.querySelector('svg')).toBeNull()
  expect(chip.classList.contains('h-[18px]')).toBe(true)
  expect(view.getByText('Reminder').compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  expect(within(global).queryByText('task.session')).toBeNull()
  expect(within(reminder).queryByLabelText('delivery.this-session')).toBeNull()
  fireEvent.change(view.getByRole('searchbox'), { target: { value: 'Reminder' } })
  expect(view.queryByText('Global task')).toBeNull()
  expect(view.getByText('Reminder').textContent).toBe('Reminder')
})
