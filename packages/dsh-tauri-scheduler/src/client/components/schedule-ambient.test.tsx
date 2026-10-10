// @vitest-environment jsdom
import type { SessionListState } from 'dsh-tauri/client'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { defineStore, useStore } from 'dsh-tauri/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestTaskDeletion } from '../service/deletion'
import { deleteTask, loadScheduler } from '../service/scheduler'
import { store } from '../store'
import { ambientTask, ambientTranslate, ambientTurn } from './ambient-test.harness'
import { ScheduleCatalogAction } from './schedule-catalog-action'
import { ScheduleDeletionOverlay } from './schedule-deletion-overlay'
import { ScheduleTurnCard } from './schedule-turn-card'
import { SessionScheduleHover } from './session-schedule-hover'
import { SessionScheduleMark } from './session-schedule-mark'

vi.mock('dsh-tauri/client', async () => (await import('./ambient-test.harness')).ambientClientFacade())
vi.mock('dsh-tauri-ui/client', async () => (await import('./ambient-test.harness')).ambientUiFacade())
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => ({ Button: (await import('./ambient-test.ui')).PrimitiveButton }))
vi.mock('../service/scheduler', () => ({ loadScheduler: vi.fn(), deleteTask: vi.fn() }))

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-10T09:00:00Z'))
  vi.mocked(loadScheduler).mockReset().mockResolvedValue(undefined)
  vi.mocked(deleteTask).mockReset().mockResolvedValue({ ok: true })
  store.scheduler.$patch({ tasks: [], runs: [], loading: false, error: '', loadToken: 0, successfulReadToken: 0, refreshedAt: 0 })
  store.deletion.$patch({ pendingTask: null, deletingTaskId: null, feedback: null, feedbackSeq: 0 })
  store.navigation.$patch({ target: null, seq: 0, error: '' })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element)
  })
}

async function patchCatalog(patch: Parameters<typeof store.scheduler.$patch>[0]): Promise<void> {
  await act(async () => {
    store.scheduler.$patch(patch)
  })
}

describe('ambient shared catalog surfaces', () => {
  it('hides empty and excluded owners without fetching per row or header', () => {
    store.scheduler.$patch({ tasks: [
      ambientTask('disabled', { enabled: false }),
      ambientTask('inactive', { status: 'inactive' }),
      ambientTask('independent', { delivery: 'new-session' }),
      ambientTask('other', { sessionId: 'other' }),
    ] })
    const view = render(
      <>
        <ScheduleCatalogAction sessionId="owner" openTaskDetail={vi.fn()} t={ambientTranslate} />
        <SessionScheduleMark sessionId="owner" t={ambientTranslate} />
        <SessionScheduleHover sessionId="owner" t={ambientTranslate} />
      </>,
    )
    expect(view.container.childElementCount).toBe(0)
    expect(loadScheduler).not.toHaveBeenCalled()
  })

  it('opens one owner-bound task directly without a menu or per-seat request', async () => {
    store.scheduler.$patch({ tasks: [ambientTask('one'), ambientTask('ignored', { delivery: 'new-session' })] })
    const openTaskDetail = vi.fn()
    const view = render(<ScheduleCatalogAction sessionId="owner" openTaskDetail={openTaskDetail} t={ambientTranslate} />)
    const trigger = view.getByRole('button', { name: 'ambient.trigger.one:1' })
    expect(trigger.getAttribute('aria-haspopup')).toBeNull()
    await click(trigger)
    expect(openTaskDetail).toHaveBeenCalledExactlyOnceWith('one')
    expect(view.queryByRole('menu')).toBeNull()
    expect(loadScheduler).not.toHaveBeenCalled()
  })

  it('orders the multiple-task menu by deadline, renders overdue metadata, and closes on the public onClose contract', async () => {
    store.scheduler.$patch({ tasks: [
      ambientTask('later', { nextRunAt: '2026-10-10T10:00:00Z' }),
      ambientTask('overdue', { nextRunAt: '2026-10-10T08:59:00Z' }),
    ] })
    const view = render(<ScheduleCatalogAction sessionId="owner" openTaskDetail={vi.fn()} t={ambientTranslate} />)
    const trigger = view.getByRole('button', { name: 'ambient.trigger.other:2' })
    trigger.focus()
    await click(trigger)
    const menu = within(document.body).getByRole('menu')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(trigger.querySelector('svg')!.getAttribute('width')).toBe('16')
    expect(trigger.querySelector('span[aria-hidden="true"]')).toBeNull()
    expect(within(menu).getAllByRole('menuitem').map(item => item.getAttribute('aria-label'))).toEqual([
      'ambient.open:Task overdue',
      'delete Task overdue',
      'ambient.open:Task later',
      'delete Task later',
    ])
    expect(within(menu).getByText('ambient.overdue').classList.contains('text-error')).toBe(true)
    expect(menu.querySelector('time')!.getAttribute('datetime')).toBe('2026-10-10T08:59:00Z')
    await act(async () => {
      fireEvent.keyDown(menu, { key: 'Escape' })
    })
    expect(within(document.body).queryByRole('menu')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(loadScheduler).not.toHaveBeenCalled()
  })

  it('updates an opened catalog deadline without refetching and stops its clock when closed', async () => {
    store.scheduler.$patch({ tasks: [ambientTask('soon', { nextRunAt: '2026-10-10T09:00:02Z' }), ambientTask('later', { nextRunAt: '2026-10-10T10:00:00Z' })] })
    const view = render(<ScheduleCatalogAction sessionId="owner" openTaskDetail={vi.fn()} t={ambientTranslate} />)
    await click(view.getByRole('button', { name: 'ambient.trigger.other:2' }))
    const menu = within(document.body).getByRole('menu')
    expect(within(menu).queryByText('ambient.overdue')).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(within(menu).getByText('ambient.overdue')).not.toBeNull()
    await act(async () => {
      fireEvent.keyDown(menu, { key: 'Escape' })
    })
    expect(vi.getTimerCount()).toBe(0)
    expect(loadScheduler).not.toHaveBeenCalled()
  })

  it('closes the menu when its seat owner changes and routes menu items through the common detail callback', async () => {
    store.scheduler.$patch({ tasks: [ambientTask('one'), ambientTask('two'), ambientTask('other', { sessionId: 'other' })] })
    const openTaskDetail = vi.fn()
    const view = render(<ScheduleCatalogAction sessionId="owner" openTaskDetail={openTaskDetail} t={ambientTranslate} />)
    await click(view.getByRole('button', { name: 'ambient.trigger.other:2' }))
    await click(within(document.body).getByRole('menuitem', { name: 'ambient.open:Task two' }))
    expect(openTaskDetail).toHaveBeenCalledExactlyOnceWith('two')
    expect(within(document.body).queryByRole('menu')).toBeNull()
    await click(view.getByRole('button', { name: 'ambient.trigger.other:2' }))
    view.rerender(<ScheduleCatalogAction sessionId="other" openTaskDetail={openTaskDetail} t={ambientTranslate} />)
    expect(within(document.body).queryByRole('menu')).toBeNull()
    await click(view.getByRole('button', { name: 'ambient.trigger.one:1' }))
    expect(openTaskDetail).toHaveBeenLastCalledWith('other')
  })

  it('keeps settled row marks during catalog refresh and does not activate a row when its mark is clicked', async () => {
    store.scheduler.$patch({ tasks: [ambientTask('one')], successfulReadToken: 1, loading: true })
    const activate = vi.fn()
    const view = render(<div onClick={activate}><SessionScheduleMark sessionId="owner" t={ambientTranslate} /></div>)
    const count = view.getByText('ambient.mark.aria:1')
    await click(count)
    expect(activate).not.toHaveBeenCalled()
    await patchCatalog({ tasks: [] })
    expect(view.queryByText('ambient.mark.aria:1')).toBeNull()
    expect(loadScheduler).not.toHaveBeenCalled()
  })

  it('marks scheduled execution sessions from the public durable catalog without run history and preserves reminder facts', async () => {
    const sessions = defineStore({ state: () => ({
      ids: ['execution', 'plain'],
      byId: {
        execution: { projectionValues: { 'dsh-tauri-scheduler.origin': true } },
        plain: { projectionValues: { 'dsh-tauri-scheduler.origin': false } },
      },
    }) })
    function useSessions<Selected>(selector: (snapshot: SessionListState) => Selected): Selected {
      return selector(useStore(sessions) as unknown as SessionListState)
    }
    const props = { sessionId: 'execution', t: ambientTranslate, useSessions }
    const activate = vi.fn()
    const view = render(
      <div onClick={activate}>
        <SessionScheduleMark {...props} />
        <SessionScheduleHover sessionId="execution" t={ambientTranslate} />
      </div>,
    )
    expect(view.getByText('ambient.mark.origin.aria').textContent).toBe('ambient.mark.origin.aria')
    expect(view.container.querySelectorAll('[data-session-schedule-mark]')).toHaveLength(1)
    expect(view.queryByRole('region')).toBeNull()
    await click(view.getByText('ambient.mark.origin.aria'))
    expect(activate).not.toHaveBeenCalled()

    await patchCatalog({ tasks: [ambientTask('reminder', { sessionId: 'execution', nextRunAt: '2026-10-10T09:05:00Z' })], runs: [], loading: true, error: 'History unavailable' })
    expect(view.container.querySelectorAll('[data-session-schedule-mark]')).toHaveLength(1)
    expect(view.getByText('ambient.mark.aria:1').textContent).toBe('ambient.mark.aria:1')
    expect(within(view.getByRole('region', { name: 'ambient.list.aria' })).getByText('Task reminder').textContent).toBe('Task reminder')
    await patchCatalog({ tasks: [], loading: false, error: '' })
    expect(view.getByText('ambient.mark.origin.aria').textContent).toBe('ambient.mark.origin.aria')
    expect(view.queryByRole('region')).toBeNull()

    view.rerender(<SessionScheduleMark {...props} sessionId="plain" />)
    expect(view.container.childElementCount).toBe(0)
    await act(async () => {
      sessions.$patch({ ids: ['plain'], byId: { execution: { projectionValues: { 'dsh-tauri-scheduler.origin': false } }, plain: { projectionValues: { 'dsh-tauri-scheduler.origin': true } } } })
    })
    expect(view.getByText('ambient.mark.origin.aria').textContent).toBe('ambient.mark.origin.aria')
    expect(loadScheduler).not.toHaveBeenCalled()
  })

  it('limits hover facts to two overdue-first owner tasks and reports the exact omitted count', () => {
    store.scheduler.$patch({ tasks: [
      ambientTask('later', { nextRunAt: '2026-10-10T12:00:00Z' }),
      ambientTask('soon', { nextRunAt: '2026-10-10T09:05:00Z' }),
      ambientTask('past', { nextRunAt: '2026-10-10T08:00:00Z' }),
      ambientTask('ignored', { status: 'inactive' }),
    ] })
    const view = render(<SessionScheduleHover sessionId="owner" t={ambientTranslate} />)
    const section = view.getByRole('region', { name: 'ambient.list.aria' })
    expect(within(section).getAllByText(/^Task /).map(label => label.textContent)).toEqual(['Task past', 'Task soon'])
    expect(within(section).getByText('ambient.overdue').classList.contains('text-error')).toBe(true)
    expect(within(section).getByText('5unitMinutes').textContent).toBe('5unitMinutes')
    expect(Array.from(section.querySelectorAll('time'), time => time.getAttribute('datetime'))).toEqual(['2026-10-10T08:00:00Z', '2026-10-10T09:05:00Z'])
    expect(within(section).queryByText('Task later')).toBeNull()
    expect(within(section).queryByText('Task ignored')).toBeNull()
    expect(within(section).getByText('ambient.hover.more:1').textContent).toBe('ambient.hover.more:1')
    expect(loadScheduler).not.toHaveBeenCalled()
  })
})

describe('ambient created turn cards', () => {
  it('retains the durable creation snapshot until a causally newer successful read identifies deletion', async () => {
    store.scheduler.$patch({ loadToken: 7, successfulReadToken: 7, tasks: [] })
    const openTaskDetail = vi.fn()
    const view = render(<ScheduleTurnCard {...ambientTurn([ambientTask('created')])} openTaskDetail={openTaskDetail} t={ambientTranslate} />)
    expect(loadScheduler).toHaveBeenCalledTimes(1)
    await click(view.getByRole('button', { name: 'ambient.open:Task created' }))
    expect(openTaskDetail).toHaveBeenCalledExactlyOnceWith('created')
    await patchCatalog({ loadToken: 8, error: 'Catalog failed' })
    expect(view.queryByText('ambient.card.deleted')).toBeNull()
    expect(view.getByRole('button', { name: 'ambient.open:Task created' }).textContent).toBe('ambient.card.open')
    await patchCatalog({ successfulReadToken: 8, tasks: [], error: '' })
    expect(view.getByText('ambient.card.deleted').textContent).toBe('ambient.card.deleted')
    expect(view.queryByRole('button')).toBeNull()
  })

  it('uses the current catalog record after success and renews its read barrier for later creations in the same turn', async () => {
    store.scheduler.$patch({ loadToken: 4, successfulReadToken: 4 })
    const first = ambientTask('first')
    const second = ambientTask('second')
    const view = render(<ScheduleTurnCard {...ambientTurn([first])} openTaskDetail={vi.fn()} t={ambientTranslate} />)
    await patchCatalog({ tasks: [ambientTask('first', { name: 'Updated title' })], loadToken: 5, successfulReadToken: 5 })
    expect(view.getByText('Updated title').textContent).toBe('Updated title')
    view.rerender(<ScheduleTurnCard {...ambientTurn([first, second])} openTaskDetail={vi.fn()} t={ambientTranslate} />)
    expect(loadScheduler).toHaveBeenCalledTimes(2)
    expect(view.getByRole('button', { name: 'ambient.open:Task second' }).textContent).toBe('ambient.card.open')
    expect(view.queryByText('ambient.card.deleted')).toBeNull()
    await patchCatalog({ loadToken: 6, successfulReadToken: 6, tasks: [first, second] })
    expect(view.getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['ambient.open:Task first', 'ambient.open:Task second'])
  })

  it('does not refresh or render before a creation settles at the visible turn cursor', () => {
    const view = render(<ScheduleTurnCard {...ambientTurn([ambientTask('future')], 3)} openTaskDetail={vi.fn()} t={ambientTranslate} />)
    expect(view.container.childElementCount).toBe(0)
    expect(loadScheduler).not.toHaveBeenCalled()
  })
})

describe('global confirmation and deletion banner', () => {
  it('confirms a menu deletion globally and retains success after the originating surface unmounts', async () => {
    store.scheduler.$patch({ tasks: [ambientTask('one'), ambientTask('two')] })
    const overlay = render(<ScheduleDeletionOverlay t={ambientTranslate} />)
    const origin = render(<ScheduleCatalogAction sessionId="owner" openTaskDetail={vi.fn()} t={ambientTranslate} />)
    await click(origin.getByRole('button', { name: 'ambient.trigger.other:2' }))
    await click(within(document.body).getByRole('menuitem', { name: 'delete Task one' }))
    expect(within(document.body).queryByRole('menu')).toBeNull()
    expect(deleteTask).not.toHaveBeenCalled()
    origin.unmount()
    const dialog = within(document.body).getByRole('dialog', { name: 'deleteConfirmTitle' })
    expect(within(dialog).getByText('Task one').textContent).toBe('Task one')
    await click(within(dialog).getByRole('button', { name: 'deleteConfirmAction' }))
    expect(deleteTask).toHaveBeenCalledExactlyOnceWith('one')
    expect(within(document.body).queryByRole('dialog')).toBeNull()
    const banner = within(document.body).getByRole('alert')
    expect(banner.textContent).toBe('deletion.deleted:Task one')
    expect(overlay.container.contains(banner)).toBe(false)
    expect(store.deletion.feedback?.kind).toBe('deleted')
    await click(within(banner).getByRole('button', { name: 'complete-banner' }))
    expect(within(document.body).queryByRole('alert')).toBeNull()
    expect(store.deletion.feedback).toBeNull()
  })

  it('cancels confirmation without deletion and reports a failed request as a body banner', async () => {
    vi.mocked(deleteTask).mockResolvedValueOnce({ ok: false, error: 'Storage denied' })
    render(<ScheduleDeletionOverlay t={ambientTranslate} />)
    await act(async () => {
      requestTaskDeletion(ambientTask('failed'))
    })
    await click(within(document.body).getByRole('button', { name: 'cancel' }))
    expect(deleteTask).not.toHaveBeenCalled()
    expect(within(document.body).queryByRole('dialog')).toBeNull()
    await act(async () => {
      requestTaskDeletion(ambientTask('failed'))
    })
    await click(within(document.body).getByRole('button', { name: 'deleteConfirmAction' }))
    expect(within(document.body).getByRole('alert').textContent).toBe('deletion.failed:Task failed: Storage denied')
    expect(store.deletion.feedback?.kind).toBe('deleteFailed')
  })

  it('disables duplicate actions while deleting and keeps the in-flight confirmation open on Escape', async () => {
    let resolve!: (value: { ok: boolean }) => void
    vi.mocked(deleteTask).mockReturnValueOnce(new Promise((done) => {
      resolve = done
    }))
    render(<ScheduleDeletionOverlay t={ambientTranslate} />)
    await act(async () => {
      requestTaskDeletion(ambientTask('slow'))
    })
    const confirm = within(document.body).getByRole('button', { name: 'deleteConfirmAction' }) as HTMLButtonElement
    await click(confirm)
    expect(confirm.disabled).toBe(true)
    expect((within(document.body).getByRole('button', { name: 'cancel' }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(document.body).getByRole('status').textContent).toBe('deletion.pending:Task slow')
    await click(confirm)
    await act(async () => {
      fireEvent.keyDown(within(document.body).getByRole('dialog', { name: 'deleteConfirmTitle' }), { key: 'Escape' })
    })
    expect(within(document.body).getByRole('dialog', { name: 'deleteConfirmTitle' }).getAttribute('aria-modal')).toBe('true')
    expect(deleteTask).toHaveBeenCalledExactlyOnceWith('slow')
    await act(async () => {
      resolve({ ok: true })
    })
    expect(within(document.body).getByRole('alert').textContent).toBe('deletion.deleted:Task slow')
  })
})
