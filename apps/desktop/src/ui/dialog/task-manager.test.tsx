// @vitest-environment jsdom
import { OverlaysProvider, useOverlay } from '@overlastic/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { mockIPC } from '@tauri-apps/api/mocks'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskManagerDialog } from './task-manager'

const { restart, toast } = vi.hoisted(() => ({ restart: vi.fn(), toast: vi.fn() }))

vi.mock('@/store', () => ({ store: { harness: { busyAction: null, restart } } }))
vi.mock('valtio-define', () => ({ useStore: (value: unknown) => value }))
vi.mock('@/utils/toast', () => ({ toast }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }))

let client: QueryClient
let rows: ReturnType<typeof fixtures>
let failRead: boolean
let ended: unknown[]

function fixtures() {
  return [
    { pid: 10, parent_pid: null, name: 'desktop', kind: 'desktop', cpu_percent: 1, memory_bytes: 104857600, run_time: 3601, start_time: 100, can_end: false },
    { pid: 20, parent_pid: 10, name: 'harness', kind: 'harness', cpu_percent: 12.5, memory_bytes: 209715200, run_time: 120, start_time: 101, can_end: false },
    { pid: 30, parent_pid: 20, name: 'worker', kind: 'child', cpu_percent: 2, memory_bytes: 52428800, run_time: 61, start_time: 102, can_end: true },
    { pid: 40, parent_pid: 20, name: 'helper', kind: 'child', cpu_percent: 3, memory_bytes: 314572800, run_time: 30, start_time: 103, can_end: true },
  ]
}

function Launcher() {
  const open = useOverlay(TaskManagerDialog)
  function handleOpen() {
    void open().catch(() => {})
  }
  return <button onClick={handleOpen}>Open tasks</button>
}

async function openManager() {
  render(<StrictMode><QueryClientProvider client={client}><OverlaysProvider><Launcher /></OverlaysProvider></QueryClientProvider></StrictMode>)
  fireEvent.click(screen.getByText('Open tasks'))
  await screen.findByRole('button', { name: 'desktop task_manager.kind.desktop' })
}

function expand() {
  fireEvent.click(screen.getByTestId('dsh-task-manager-toggle-10'))
}

function rowPids() {
  return within(screen.getByRole('table')).getAllByRole('row').slice(1).map(row => within(row).getAllByRole('cell')[1].textContent)
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } })
  rows = fixtures()
  failRead = false
  ended = []
  restart.mockReset()
  toast.mockReset()
  mockIPC((command, args) => {
    if (command === 'get_task_manager_processes') {
      if (failRead)
        throw new Error('collector unavailable')
      return structuredClone(rows)
    }
    if (command === 'end_task_manager_process') {
      ended.push(args)
      rows = rows.filter(row => row.pid !== (args as { pid: number }).pid)
      return
    }
    if (command === 'read_run_logs')
      return 'Harness service started'
    throw new Error(`Unexpected command: ${command}`)
  })
})

afterEach(() => {
  cleanup()
  client.clear()
  vi.restoreAllMocks()
})

describe('task manager', () => {
  it('folds every child process into the app root and expands in one level', async () => {
    await openManager()
    const table = screen.getByRole('table')
    expect(rowPids()).toEqual(['10'])
    expect(within(table).getByText('(4)')).toBeTruthy()
    expand()
    expect(rowPids()).toEqual(['10', '40', '20', '30'])
    expand()
    expect(rowPids()).toEqual(['10'])
  })

  it('sorts the folded children and filters by PID', async () => {
    await openManager()
    expand()
    expect(rowPids()).toEqual(['10', '40', '20', '30'])
    fireEvent.click(screen.getByRole('button', { name: 'task_manager.pid' }))
    expect(rowPids()).toEqual(['10', '20', '30', '40'])
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '30' } })
    expect(rowPids()).toEqual(['10', '30'])
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'missing' } })
    expect(screen.getByText('task_manager.empty')).toBeTruthy()
  })

  it('keeps the app root on top even when its parent link points elsewhere', async () => {
    rows[0].parent_pid = 30
    await openManager()
    expect(rowPids()).toEqual(['10'])
    expand()
    expect(rowPids()).toEqual(['10', '40', '20', '30'])
  })

  it('protects the desktop and Harness roots from termination', async () => {
    await openManager()
    expand()
    const end = screen.getByRole<HTMLButtonElement>('button', { name: 'task_manager.end' })
    expect(end.disabled).toBe(true)
    for (const name of ['desktop task_manager.kind.desktop', 'harness task_manager.kind.harness']) {
      fireEvent.click(screen.getByRole('button', { name }))
      expect(end.disabled).toBe(true)
    }
    expect(ended).toEqual([])
  })

  it('cancels without terminating and submits the confirmed process identity', async () => {
    await openManager()
    expand()
    fireEvent.click(screen.getByRole('button', { name: 'worker task_manager.kind.child' }))
    fireEvent.click(screen.getByRole('button', { name: 'task_manager.end' }))
    const confirmation = await screen.findByRole('alertdialog')
    fireEvent.click(within(confirmation).getByRole('button', { name: 'buttons.cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(ended).toEqual([])
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'task_manager.end' }).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'task_manager.end' }))
    const second = await screen.findByRole('alertdialog')
    fireEvent.click(within(second).getByRole('button', { name: 'task_manager.end' }))
    await waitFor(() => expect(ended).toEqual([{ pid: 30, startTime: 102 }]))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'worker task_manager.kind.child' })).toBeNull())
  })

  it('clears an actionable selection when its PID is reused', async () => {
    await openManager()
    expand()
    fireEvent.click(screen.getByRole('button', { name: 'worker task_manager.kind.child' }))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'task_manager.end' }).disabled).toBe(false)
    rows[2].start_time = 200
    fireEvent.click(screen.getByRole('button', { name: 'task_manager.refresh' }))
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'task_manager.end' }).disabled).toBe(true))
    expect(ended).toEqual([])
  })

  it('shows refresh failures and disables termination on stale data', async () => {
    await openManager()
    expand()
    fireEvent.click(screen.getByRole('button', { name: 'worker task_manager.kind.child' }))
    failRead = true
    fireEvent.click(screen.getByRole('button', { name: 'task_manager.refresh' }))
    expect((await screen.findByRole('alert')).textContent).toBe('task_manager.load_failed')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'task_manager.end' }).disabled).toBe(true)
    expect(ended).toEqual([])
  })

  it('restarts through the existing lifecycle only after confirmation', async () => {
    await openManager()
    fireEvent.click(screen.getByRole('button', { name: 'task_manager.restart' }))
    const confirmation = await screen.findByRole('alertdialog')
    expect(restart).not.toHaveBeenCalled()
    fireEvent.click(within(confirmation).getByRole('button', { name: 'app.restart' }))
    await waitFor(() => expect(restart).toHaveBeenCalledExactlyOnceWith())
  })

  it('pauses and resumes automatic refresh through its control', async () => {
    await openManager()
    const toggle = screen.getByRole('button', { name: 'task_manager.auto_refresh' })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
  })

  it('loads run logs when expanded', async () => {
    await openManager()
    fireEvent.click(screen.getByRole('button', { name: 'menu.run_logs' }))
    expect(await screen.findByText('Harness service started')).toBeTruthy()
  })
})
