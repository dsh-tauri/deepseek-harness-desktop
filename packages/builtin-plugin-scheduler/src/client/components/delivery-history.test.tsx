import type { SessionId } from 'dsh-tauri/client'
// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import type { HistoryPage } from '../types'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadTaskHistory } from '../service/scheduler'
import { DeliveryHistory } from './delivery-history'
import { deferred, deliveryFixture, pageFixture, runFixture, sessionsFixture, translate, workspacesFixture } from './scheduler-client.test.harness'

vi.mock('../service/scheduler', () => ({ loadTaskHistory: vi.fn() }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const ui = await import('./scheduler-client.test.ui')
  return { Button: ui.PrimitiveButton, Input: ui.PrimitiveInput, Menu: ui.PrimitiveMenu }
})
vi.mock('dsh-tauri-ui/client', async () => (await import('./scheduler-client.test.ui')).schedulerClientUi())

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(loadTaskHistory).mockResolvedValue(pageFixture())
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function renderHistory(overrides: Partial<ComponentProps<typeof DeliveryHistory>> = {}, strict = false) {
  const props: ComponentProps<typeof DeliveryHistory> = {
    taskId: 'task-a',
    t: translate,
    timeZone: 'UTC',
    sessions: sessionsFixture(),
    workspaces: workspacesFixture(),
    onOpenSession: vi.fn(),
    ...overrides,
  }
  const view = render(strict ? <StrictMode><DeliveryHistory {...props} /></StrictMode> : <DeliveryHistory {...props} />)
  await act(async () => {})
  return { ...view, props }
}

async function click(view: Awaited<ReturnType<typeof renderHistory>>, name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(view.getByRole('button', { name }))
  })
}

async function resolvePage(response: ReturnType<typeof deferred<HistoryPage>>, page: HistoryPage): Promise<void> {
  await act(async () => {
    response.resolve(page)
    await response.promise
  })
}

async function rejectPage(response: ReturnType<typeof deferred<HistoryPage>>, error: Error): Promise<void> {
  await act(async () => {
    response.reject(error)
    await expect(response.promise).rejects.toBe(error)
  })
}

describe('deliveryHistory rendering and request contract', () => {
  it('keeps the normal timeline to one time and instruction instead of duplicate delivery metadata', async () => {
    vi.mocked(loadTaskHistory).mockResolvedValueOnce(pageFixture([deliveryFixture('compact')]))
    const view = await renderHistory()
    const row = view.getByRole('listitem')
    expect(row.querySelectorAll('time')).toHaveLength(1)
    expect(within(row).getByText('Prompt compact')).not.toBeNull()
    expect(view.queryByText('delivery.this-session · triggerSchedule')).toBeNull()
    expect(row.textContent).not.toContain('history.scheduled')
    expect(row.textContent).not.toContain('history.delivered')
    expect(row.textContent).not.toContain('history.open')
    expect(view.queryByRole('button', { name: 'refresh' })).toBeNull()
  })

  it('accepts its first page after StrictMode effect replay', async () => {
    const response = deferred<HistoryPage>()
    vi.mocked(loadTaskHistory).mockImplementation(() => response.promise)
    const view = await renderHistory({}, true)
    expect(loadTaskHistory).toHaveBeenCalledWith('task-a', 20, undefined)
    await resolvePage(response, pageFixture([deliveryFixture('strict-current')]))
    expect(view.getAllByRole('listitem')).toHaveLength(1)
    expect(view.getByText('Prompt strict-current').textContent).toBe('Prompt strict-current')
    expect(view.queryByText('loading')).toBeNull()
    expect(view.queryByRole('alert')).toBeNull()
  })

  it('loads the explicit task with limit 20 and renders immutable prompts for both delivery modes', async () => {
    const response = deferred<HistoryPage>()
    vi.mocked(loadTaskHistory).mockImplementationOnce(() => response.promise)
    const view = await renderHistory()
    expect(loadTaskHistory).toHaveBeenCalledExactlyOnceWith('task-a', 20, undefined)
    expect(view.getByText('loading').textContent).toBe('loading')
    await resolvePage(response, pageFixture([deliveryFixture('reminder'), runFixture('run')]))
    const records = view.getAllByRole('listitem')
    expect(records).toHaveLength(2)
    expect(within(records[0]!).getByText('Prompt reminder').textContent).toBe('Prompt reminder')
    expect(within(records[1]!).getByText('Prompt run').textContent).toBe('Prompt run')
    expect(within(records[1]!).getByText('Run failed').textContent).toBe('Run failed')
    const format = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })
    expect(records.map(record => record.querySelector('time')!.dateTime)).toEqual(['2030-01-02T01:00:00.000Z', '2030-01-02T02:00:00.000Z'])
    expect(records.map(record => record.querySelector('time')!.textContent)).toEqual(['2030-01-02T01:00:00.000Z', '2030-01-02T02:00:00.000Z'].map(at => format.format(new Date(at))))
    expect(records.map(record => record.querySelectorAll('time').length)).toEqual([1, 1])
    expect(view.queryByText('loading')).toBeNull()
  })

  it('shows the empty state only after a successful empty page', async () => {
    const response = deferred<HistoryPage>()
    vi.mocked(loadTaskHistory).mockImplementationOnce(() => response.promise)
    const view = await renderHistory({ taskId: 'empty-task' })
    expect(view.queryByText('history.empty')).toBeNull()
    await resolvePage(response, pageFixture())
    expect(view.getByText('history.empty').textContent).toBe('history.empty')
    expect(view.queryAllByRole('listitem')).toHaveLength(0)
    expect(loadTaskHistory).toHaveBeenCalledExactlyOnceWith('empty-task', 20, undefined)
  })

  it('falls back to the original timestamp when the configured timezone cannot be formatted', async () => {
    vi.mocked(loadTaskHistory).mockResolvedValueOnce(pageFixture([deliveryFixture('reminder')]))
    const view = await renderHistory({ timeZone: 'Invalid/Timezone' })
    expect(view.container.querySelector('time')!.textContent).toBe('2030-01-02T01:00:00.000Z')
    expect(view.container.querySelectorAll('time')).toHaveLength(1)
  })

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])('renders unavailable=%s and pruned=%s as distinct retention facts', async (earlierRecordsUnavailable, earlierRecordsPruned) => {
    vi.mocked(loadTaskHistory).mockResolvedValueOnce(pageFixture([deliveryFixture('record')], {
      earlierRecordsUnavailable,
      earlierRecordsPruned,
      retention: { days: 7, records: 123 },
    }))
    const view = await renderHistory()
    expect(view.queryAllByText('history.unavailable')).toHaveLength(earlierRecordsUnavailable ? 1 : 0)
    expect(view.queryAllByText('history.pruned:days=7;records=123')).toHaveLength(earlierRecordsPruned ? 1 : 0)
    expect(view.getByText('Prompt record').textContent).toBe('Prompt record')
  })
})

describe('deliveryHistory pagination and recovery', () => {
  it('appends before pages without duplicating existing ids or replacing their original content', async () => {
    const second = deferred<HistoryPage>()
    vi.mocked(loadTaskHistory)
      .mockResolvedValueOnce(pageFixture([deliveryFixture('newest'), runFixture('shared')], { nextBefore: 'cursor-first' }))
      .mockImplementationOnce(() => second.promise)
      .mockResolvedValueOnce(pageFixture([deliveryFixture('oldest')]))
    const view = await renderHistory()
    await click(view, 'history.more')
    expect(vi.mocked(loadTaskHistory).mock.calls).toEqual([['task-a', 20, undefined], ['task-a', 20, 'cursor-first']])
    expect((view.getByRole('button', { name: 'history.more' }) as HTMLButtonElement).disabled).toBe(true)
    await resolvePage(second, pageFixture([runFixture('shared', { prompt: 'Do not replace saved snapshot' }), deliveryFixture('older')], { nextBefore: 'cursor-second' }))
    expect(view.getAllByRole('listitem')).toHaveLength(3)
    expect(view.getAllByRole('listitem').map(item => within(item).getByText(/^Prompt /).textContent)).toEqual(['Prompt newest', 'Prompt shared', 'Prompt older'])
    expect(view.queryByText('Do not replace saved snapshot')).toBeNull()
    await click(view, 'history.more')
    expect(vi.mocked(loadTaskHistory).mock.calls).toEqual([['task-a', 20, undefined], ['task-a', 20, 'cursor-first'], ['task-a', 20, 'cursor-second']])
    expect(view.getAllByRole('listitem').map(item => within(item).getByText(/^Prompt /).textContent)).toEqual(['Prompt newest', 'Prompt shared', 'Prompt older', 'Prompt oldest'])
    expect(view.queryByRole('button', { name: 'history.more' })).toBeNull()
  })

  it('does not launch duplicate pagination requests before the loading state rerenders', async () => {
    const next = deferred<HistoryPage>()
    vi.mocked(loadTaskHistory)
      .mockResolvedValueOnce(pageFixture([deliveryFixture('newest')], { nextBefore: 'cursor-first' }))
      .mockImplementationOnce(() => next.promise)
    const view = await renderHistory()
    const more = view.getByRole('button', { name: 'history.more' })
    await act(async () => {
      fireEvent.click(more)
      fireEvent.click(more)
      fireEvent.click(more)
    })
    expect(loadTaskHistory).toHaveBeenCalledTimes(2)
    await resolvePage(next, pageFixture([deliveryFixture('older')]))
    expect(view.getAllByRole('listitem')).toHaveLength(2)
  })

  it('keeps the failed before cursor and existing records available for retry', async () => {
    const failed = deferred<HistoryPage>()
    vi.mocked(loadTaskHistory)
      .mockResolvedValueOnce(pageFixture([deliveryFixture('newest')], { nextBefore: 'cursor-first' }))
      .mockImplementationOnce(() => failed.promise)
      .mockResolvedValueOnce(pageFixture([deliveryFixture('older')]))
    const view = await renderHistory()
    await click(view, 'history.more')
    await rejectPage(failed, new Error('History storage unavailable'))
    expect(view.getByRole('alert').textContent).toBe('History storage unavailable')
    expect(view.getByText('Prompt newest').textContent).toBe('Prompt newest')
    expect((view.getByRole('button', { name: 'history.more' }) as HTMLButtonElement).disabled).toBe(false)
    await click(view, 'history.more')
    expect(vi.mocked(loadTaskHistory).mock.calls).toEqual([['task-a', 20, undefined], ['task-a', 20, 'cursor-first'], ['task-a', 20, 'cursor-first']])
    expect(view.queryByRole('alert')).toBeNull()
    expect(view.getAllByRole('listitem')).toHaveLength(2)
  })

  it('retries a failed initial read through refresh instead of presenting a false empty result', async () => {
    const failed = deferred<HistoryPage>()
    vi.mocked(loadTaskHistory)
      .mockImplementationOnce(() => failed.promise)
      .mockResolvedValueOnce(pageFixture([deliveryFixture('recovered')]))
    const view = await renderHistory()
    await rejectPage(failed, new Error('Initial read failed'))
    expect(view.getByRole('alert').textContent).toBe('Initial read failed')
    expect(view.queryByText('history.empty')).toBeNull()
    await click(view, 'refresh')
    expect(vi.mocked(loadTaskHistory).mock.calls).toEqual([['task-a', 20, undefined], ['task-a', 20, undefined]])
    expect(view.queryByRole('alert')).toBeNull()
    expect(view.getByText('Prompt recovered').textContent).toBe('Prompt recovered')
  })

  it('refreshes from the first page after pruning makes the before cursor invalid', async () => {
    const pruned = deferred<HistoryPage>()
    const fresh = deferred<HistoryPage>()
    vi.mocked(loadTaskHistory)
      .mockResolvedValueOnce(pageFixture([deliveryFixture('stale')], { nextBefore: 'deleted-cursor' }))
      .mockImplementationOnce(() => pruned.promise)
      .mockImplementationOnce(() => fresh.promise)
    const view = await renderHistory()
    await click(view, 'history.more')
    await rejectPage(pruned, Object.assign(new Error('Cursor no longer retained'), { code: 'delivery_cursor_not_found' }))
    expect(vi.mocked(loadTaskHistory).mock.calls).toEqual([['task-a', 20, undefined], ['task-a', 20, 'deleted-cursor'], ['task-a', 20, undefined]])
    expect(view.queryByText('Prompt stale')).toBeNull()
    expect(view.queryByRole('alert')).toBeNull()
    expect(view.getByText('loading').textContent).toBe('loading')
    await resolvePage(fresh, pageFixture([deliveryFixture('fresh')], { earlierRecordsPruned: true, retention: { days: 2, records: 10 } }))
    expect(view.getByText('Prompt fresh').textContent).toBe('Prompt fresh')
    expect(view.getByText('history.pruned:days=2;records=10').textContent).toBe('history.pruned:days=2;records=10')
    expect(view.queryByText('loading')).toBeNull()
  })
})

describe('deliveryHistory request lifetime isolation', () => {
  it('ignores a delayed previous-task page while the new task is still loading', async () => {
    const previous = deferred<HistoryPage>()
    const current = deferred<HistoryPage>()
    vi.mocked(loadTaskHistory).mockImplementationOnce(() => previous.promise).mockImplementationOnce(() => current.promise)
    const view = await renderHistory()
    await act(async () => {
      view.rerender(<DeliveryHistory {...view.props} taskId="task-b" />)
    })
    expect(vi.mocked(loadTaskHistory).mock.calls).toEqual([['task-a', 20, undefined], ['task-b', 20, undefined]])
    await resolvePage(previous, pageFixture([deliveryFixture('previous', { taskId: 'task-a' })]))
    expect(view.queryAllByRole('listitem')).toHaveLength(0)
    expect(view.getByText('loading').textContent).toBe('loading')
    await resolvePage(current, pageFixture([deliveryFixture('current', { taskId: 'task-b' })]))
    expect(view.queryByText('Prompt previous')).toBeNull()
    expect(view.getByText('Prompt current').textContent).toBe('Prompt current')
  })

  it('ignores an earlier navigation response even when navigation returns to the same task id', async () => {
    const firstA = deferred<HistoryPage>()
    const taskB = deferred<HistoryPage>()
    const latestA = deferred<HistoryPage>()
    vi.mocked(loadTaskHistory).mockImplementationOnce(() => firstA.promise).mockImplementationOnce(() => taskB.promise).mockImplementationOnce(() => latestA.promise)
    const view = await renderHistory()
    await act(async () => {
      view.rerender(<DeliveryHistory {...view.props} taskId="task-b" />)
    })
    await act(async () => {
      view.rerender(<DeliveryHistory {...view.props} taskId="task-a" />)
    })
    await resolvePage(latestA, pageFixture([deliveryFixture('latest-a')]))
    await resolvePage(taskB, pageFixture([deliveryFixture('task-b', { taskId: 'task-b' })]))
    await resolvePage(firstA, pageFixture([deliveryFixture('old-a')]))
    expect(vi.mocked(loadTaskHistory).mock.calls).toEqual([['task-a', 20, undefined], ['task-b', 20, undefined], ['task-a', 20, undefined]])
    expect(view.getAllByRole('listitem')).toHaveLength(1)
    expect(view.getByText('Prompt latest-a').textContent).toBe('Prompt latest-a')
    expect(view.queryByText('Prompt old-a')).toBeNull()
    expect(view.queryByText('Prompt task-b')).toBeNull()
  })

  it('does not merge an earlier before response into a freshly refreshed first page', async () => {
    const older = deferred<HistoryPage>()
    const fresh = deferred<HistoryPage>()
    vi.mocked(loadTaskHistory)
      .mockResolvedValueOnce(pageFixture([deliveryFixture('old-first')], { nextBefore: 'old-cursor' }))
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => fresh.promise)
    const view = await renderHistory()
    await click(view, 'history.more')
    await act(async () => {
      view.rerender(<DeliveryHistory {...view.props} refreshKey="fresh-receipt" />)
    })
    await resolvePage(fresh, pageFixture([deliveryFixture('fresh-first')]))
    await resolvePage(older, pageFixture([deliveryFixture('stale-older')], { nextBefore: 'stale-cursor' }))
    expect(view.getAllByRole('listitem')).toHaveLength(1)
    expect(view.getByText('Prompt fresh-first').textContent).toBe('Prompt fresh-first')
    expect(view.queryByText('Prompt stale-older')).toBeNull()
    expect(view.queryByRole('button', { name: 'history.more' })).toBeNull()
  })

  it('reloads the first page when the successful task refresh key changes', async () => {
    const stale = deferred<HistoryPage>()
    const latest = deferred<HistoryPage>()
    vi.mocked(loadTaskHistory).mockImplementationOnce(() => stale.promise).mockImplementationOnce(() => latest.promise)
    const view = await renderHistory({ refreshKey: 'revision-1' })
    await act(async () => {
      view.rerender(<DeliveryHistory {...view.props} refreshKey="revision-2" />)
    })
    await resolvePage(latest, pageFixture([deliveryFixture('latest')]))
    await resolvePage(stale, pageFixture([deliveryFixture('stale')]))
    expect(loadTaskHistory).toHaveBeenCalledTimes(2)
    expect(view.getByText('Prompt latest').textContent).toBe('Prompt latest')
    expect(view.queryByText('Prompt stale')).toBeNull()
  })

  it('does not allow a stale cursor failure to trigger a refresh in the new task', async () => {
    const stale = deferred<HistoryPage>()
    const current = deferred<HistoryPage>()
    vi.mocked(loadTaskHistory).mockImplementationOnce(() => stale.promise).mockImplementationOnce(() => current.promise)
    const view = await renderHistory()
    await act(async () => {
      view.rerender(<DeliveryHistory {...view.props} taskId="task-b" />)
    })
    await rejectPage(stale, Object.assign(new Error('Old cursor missing'), { code: 'delivery_cursor_not_found' }))
    expect(loadTaskHistory).toHaveBeenCalledTimes(2)
    expect(view.queryByRole('alert')).toBeNull()
    expect(view.getByText('loading').textContent).toBe('loading')
    await resolvePage(current, pageFixture([deliveryFixture('current', { taskId: 'task-b' })]))
    expect(view.getByText('Prompt current').textContent).toBe('Prompt current')
  })

  it('ignores success from an unmounted history component without contaminating its replacement', async () => {
    const stale = deferred<HistoryPage>()
    const current = deferred<HistoryPage>()
    vi.mocked(loadTaskHistory).mockImplementationOnce(() => stale.promise).mockImplementationOnce(() => current.promise)
    const previousView = await renderHistory()
    previousView.unmount()
    const view = await renderHistory({ taskId: 'task-b' })
    await resolvePage(current, pageFixture([deliveryFixture('current', { taskId: 'task-b' })]))
    await resolvePage(stale, pageFixture([deliveryFixture('unmounted')]))
    expect(previousView.container.textContent).toBe('')
    expect(view.getAllByRole('listitem')).toHaveLength(1)
    expect(view.getByText('Prompt current').textContent).toBe('Prompt current')
    expect(view.queryByText('Prompt unmounted')).toBeNull()
    expect(previousView.props.onOpenSession).not.toHaveBeenCalled()
  })

  it.each([false, true])('does not retry a cursor failure after its history component unmounts with StrictMode=%s', async (strict) => {
    const response = deferred<HistoryPage>()
    vi.mocked(loadTaskHistory).mockImplementation(() => response.promise)
    const view = await renderHistory({}, strict)
    expect(loadTaskHistory).toHaveBeenCalledWith('task-a', 20, undefined)
    const requests = vi.mocked(loadTaskHistory).mock.calls.length
    view.unmount()
    await rejectPage(response, Object.assign(new Error('Unmounted cursor missing'), { code: 'delivery_cursor_not_found' }))
    expect(loadTaskHistory).toHaveBeenCalledTimes(requests)
    expect(view.container.textContent).toBe('')
    expect(view.props.onOpenSession).not.toHaveBeenCalled()
  })
})

describe('deliveryHistory linked session reads', () => {
  it.each([
    ['available', sessionsFixture(), workspacesFixture()],
    ['loading', sessionsFixture({ phase: 'pending' }), workspacesFixture()],
    ['loading', sessionsFixture(), workspacesFixture({ phase: 'pending' })],
    ['archived', sessionsFixture(), workspacesFixture({ archivedSessionIds: ['session-a' as SessionId] })],
    ['unavailable', sessionsFixture({ ids: [], byId: {} }), workspacesFixture()],
    ['unavailable', sessionsFixture(), workspacesFixture({ state: 'error' })],
  ] as const)('retains inactive session history while its navigation state is %s', async (state, sessions, workspaces) => {
    vi.mocked(loadTaskHistory).mockResolvedValueOnce(pageFixture([deliveryFixture('record')]))
    const view = await renderHistory({ sessions, workspaces })
    expect(loadTaskHistory).toHaveBeenCalledExactlyOnceWith('task-a', 20, undefined)
    expect(view.getByText('Prompt record').textContent).toBe('Prompt record')
    const button = view.getByRole('button', { name: state === 'unavailable' && sessions.ids.length === 0 ? 'history.open: session-a' : 'history.open: Session A' }) as HTMLButtonElement
    expect(button.title).toBe(`session.${state}`)
    expect(button.disabled).toBe(state !== 'available')
    fireEvent.click(button)
    expect(vi.mocked(view.props.onOpenSession).mock.calls).toEqual(state === 'available' ? [['session-a']] : [])
  })

  it('updates link availability without refetching or discarding the saved history', async () => {
    vi.mocked(loadTaskHistory).mockResolvedValueOnce(pageFixture([deliveryFixture('record')]))
    const view = await renderHistory({ sessions: sessionsFixture({ phase: 'pending', ids: [], byId: {} }) })
    expect((view.getByRole('button', { name: 'history.open: session-a' }) as HTMLButtonElement).disabled).toBe(true)
    view.rerender(<DeliveryHistory {...view.props} sessions={sessionsFixture()} />)
    const available = view.getByRole('button', { name: 'history.open: Session A' }) as HTMLButtonElement
    expect(available.disabled).toBe(false)
    fireEvent.click(available)
    view.rerender(<DeliveryHistory {...view.props} sessions={sessionsFixture()} workspaces={workspacesFixture({ archivedSessionIds: ['session-a' as SessionId] })} />)
    expect((view.getByRole('button', { name: 'history.open: Session A' }) as HTMLButtonElement).disabled).toBe(true)
    expect(view.getByText('Prompt record').textContent).toBe('Prompt record')
    expect(loadTaskHistory).toHaveBeenCalledTimes(1)
    expect(view.props.onOpenSession).toHaveBeenCalledExactlyOnceWith('session-a')
  })

  it('does not invent a navigation control for legacy history without a linked session', async () => {
    vi.mocked(loadTaskHistory).mockResolvedValueOnce(pageFixture([runFixture('legacy', { sessionId: undefined, finishedAt: undefined, error: undefined, prompt: undefined })]))
    const view = await renderHistory()
    expect(view.getAllByRole('listitem')).toHaveLength(1)
    expect(view.queryByRole('button', { name: /^history.open:/ })).toBeNull()
    expect(view.queryByText(/^history.finished:/)).toBeNull()
    expect(view.queryByText('Run failed')).toBeNull()
    expect(view.queryByText('Prompt legacy')).toBeNull()
  })
})
