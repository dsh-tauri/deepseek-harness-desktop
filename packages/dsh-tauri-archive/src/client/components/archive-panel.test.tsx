// @vitest-environment jsdom
import type { ChangeEventHandler, ReactNode } from 'react'
import type { ArchiveState } from '../store/modules/archive.types'
import type { ArchivePanelProps } from './archive-panel.types'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../apis'
import { store } from '../store'
import { ArchivePanel } from './archive-panel'

vi.mock('dsh-tauri/client', async () => {
  const lodash = await import('../../../../dsh-tauri/src/client/modules/lodash-es')
  const valtio = await import('valtio-define')
  const reause = await import('@reause/core')
  const dates = await import('../../../../dsh-tauri/src/client/modules/date-fns')
  return {
    ...lodash,
    defineStore: valtio.defineStore,
    useStore: valtio.useStore,
    useWatchImmediate: reause.useWatchImmediate,
    format: dates.format,
    defineLocale: (_id: string, languages: Record<string, Record<string, string>>) => ({
      useLocale: () => {},
      isEnglishLocale: () => true,
      text: (key: string, values: Record<string, unknown> = {}) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), languages.en![key]!),
    }),
  }
})

vi.mock('dsh-tauri-ui/client', async () => {
  const Button = ({ children, onClick, disabled, 'aria-label': label }: { 'children'?: ReactNode, 'onClick'?: () => void, 'disabled'?: boolean, 'aria-label'?: string }) => (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label}>{children}</button>
  )
  return {
    Action: Button,
    Button,
    Icon: () => null,
    Ellipsis: () => null,
    FolderOpen: () => null,
    Magnifier: () => null,
    TrashBin: () => null,
    Input: ({ value, onChange, 'aria-label': label }: { 'value': string, 'onChange': ChangeEventHandler<HTMLInputElement>, 'aria-label': string }) => <input value={value} onChange={onChange} aria-label={label} />,
    Select: () => null,
    Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
    Toast: () => null,
    Menu: ({ open, anchor, onSelect }: { open: boolean, anchor: ReactNode, onSelect: (id: string) => void }) => (
      <>
        {anchor}
        {open && <button type="button" onClick={() => onSelect('delete')}>Delete project</button>}
      </>
    ),
    Modal: ({ open, onClose, title, description, footer, closeLabel }: { open: boolean, onClose: () => void, title: string, description: string, footer: ReactNode, closeLabel: string }) => open
      ? (
          <div role="dialog" aria-label={title}>
            <p>{description}</p>
            <button type="button" onClick={onClose}>{closeLabel}</button>
            {footer}
          </div>
        )
      : null,
  }
})

vi.mock('../apis', () => ({
  getSessionArchive: vi.fn(),
  deleteSessionArchive: vi.fn(),
  deleteSessionWorkspaceArchive: vi.fn(),
  postSessionArchiveClear: vi.fn(),
  postSessionArchive: vi.fn(),
  postSessionArchiveRestore: vi.fn(),
  postSessionOpenPath: vi.fn(),
  postSessionWorkspaceArchive: vi.fn(),
}))

function mount() {
  const sessions = { ids: [], byId: {} }
  const workspaces = { items: [{ workspaceId: 'project', title: 'Project', path: '/project', sessionIds: ['a', 'b'] }], archivedSessionIds: ['a', 'b', 'c'] }
  const props = {
    sessionsRuntime: { list: { subscribe: () => () => {}, getSnapshot: () => sessions }, refresh: vi.fn(async () => {}) },
    workspacesRuntime: { list: { subscribe: () => () => {}, getSnapshot: () => workspaces }, manager: { refresh: vi.fn(async () => {}) } },
  } as unknown as ArchivePanelProps
  const view = render(<ArchivePanel {...props} />)
  return { ...view, props }
}

function expectNoDelete() {
  expect(api.deleteSessionArchive).not.toHaveBeenCalled()
  expect(api.deleteSessionWorkspaceArchive).not.toHaveBeenCalled()
  expect(api.postSessionArchiveClear).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  const state: ArchiveState = {
    archived: { archivedSessionIds: [], meta: {} },
    sort: 'updatedAt',
    query: '',
    workspaceId: 'all',
    loading: false,
    pending: false,
    error: '',
    suppressedSessionIds: [],
    titleById: {},
    refreshGeneration: 0,
  }
  Object.assign(store.archive, state)
  vi.mocked(api.getSessionArchive).mockResolvedValue({
    archivedSessionIds: ['a', 'b', 'c'],
    meta: { a: { title: 'Alpha', cwd: '/project' }, b: { title: 'Beta', cwd: '/project' }, c: { title: 'Other', cwd: '/other' } },
  })
  vi.mocked(api.deleteSessionArchive).mockResolvedValue({ ok: true })
  vi.mocked(api.deleteSessionWorkspaceArchive).mockResolvedValue({ ok: true })
  vi.mocked(api.postSessionArchiveClear).mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('archive deletion confirmation', () => {
  it('single mode preserves title, body, close/cancel and single-session action with runtime resync', async () => {
    const { props } = mount()
    await screen.findByRole('button', { name: 'Open directory: Alpha' })
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete this session' })[0]!)
    let dialog = screen.getByRole('dialog', { name: 'Delete archived chat?' })
    expect(within(dialog).getByText('This will permanently delete the archived chat.')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expectNoDelete()
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete this session' })[0]!)
    dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expectNoDelete()
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete this session' })[0]!)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(api.deleteSessionArchive).toHaveBeenCalledExactlyOnceWith({ sessionId: 'a' }))
    await waitFor(() => expect(store.archive.pending).toBe(false))
    expect(props.sessionsRuntime.refresh).toHaveBeenCalledOnce()
    expect(props.workspacesRuntime.manager?.refresh).toHaveBeenCalledOnce()
    expect(api.deleteSessionWorkspaceArchive).not.toHaveBeenCalled()
    expect(api.postSessionArchiveClear).not.toHaveBeenCalled()
  })

  it('all mode preserves title and description and calls only clear', async () => {
    mount()
    await screen.findByRole('button', { name: 'Open directory: Alpha' })
    fireEvent.click(screen.getByRole('button', { name: 'Delete all' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete all archived chats?' })
    expect(within(dialog).getByText('This will permanently delete all locally archived chat records.')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.postSessionArchiveClear).toHaveBeenCalledExactlyOnceWith())
    await waitFor(() => expect(store.archive.pending).toBe(false))
    expect(api.deleteSessionArchive).not.toHaveBeenCalled()
    expect(api.deleteSessionWorkspaceArchive).not.toHaveBeenCalled()
  })

  it('workspace mode includes all project sessions even when search hides members', async () => {
    mount()
    await screen.findByRole('button', { name: 'Open directory: Alpha' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Search archived chats' }), { target: { value: 'Alpha' } })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open directory: Beta' })).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Project actions' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete project' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete all chats in this project?' })
    expect(within(dialog).getByText('This will permanently delete 2 locally archived chats in "Project".')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.deleteSessionWorkspaceArchive).toHaveBeenCalledExactlyOnceWith({ sessionIds: ['a', 'b'] }))
    await waitFor(() => expect(store.archive.pending).toBe(false))
    expect(api.deleteSessionArchive).not.toHaveBeenCalled()
    expect(api.postSessionArchiveClear).not.toHaveBeenCalled()
  })

  it('ungrouped workspace deletion keeps the ungrouped label and ids', async () => {
    mount()
    await screen.findByRole('button', { name: 'Open directory: Other' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Search archived chats' }), { target: { value: 'Other' } })
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Project actions' })).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: 'Project actions' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete project' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('This will permanently delete 1 locally archived chats in "Ungrouped".')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.deleteSessionWorkspaceArchive).toHaveBeenCalledExactlyOnceWith({ sessionIds: ['c'] }))
    await waitFor(() => expect(store.archive.pending).toBe(false))
  })

  it('pending disables confirmation without changing an already opened dialog', async () => {
    let resolveClear!: () => void
    vi.mocked(api.postSessionArchiveClear).mockImplementation(() => new Promise((resolve) => {
      resolveClear = () => resolve({ ok: true })
    }))
    mount()
    await screen.findByRole('button', { name: 'Open directory: Alpha' })
    fireEvent.click(screen.getByRole('button', { name: 'Delete all' }))
    const { clearArchive } = await import('../service/archive')
    const pending = clearArchive()
    await waitFor(() => expect((within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(true))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
    expect(api.postSessionArchiveClear).toHaveBeenCalledOnce()
    resolveClear()
    await pending
  })
})
