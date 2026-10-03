// @vitest-environment jsdom
import type { DataDirEntry, DataDirStatus, MigrationOutcome, MigrationPlan } from '@/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigDataDir } from './data-dir'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), dialog: vi.fn(), toast: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@overlastic/react', () => ({ useOverlay: () => [null, mocks.dialog] }))
vi.mock('@/store', () => ({ store: { harness: { restart: vi.fn() } } }))
vi.mock('@/utils/toast', () => ({ toast: mocks.toast }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

/** 当前数据目录（默认位置，用于断言「原地不动」的分支） */
const DATA_DIR = 'C:\\DSHHome'
/** 用户在主目录选择器里挑中的父目录 */
const PICKED = 'D:\\NewHome'
/** 迁移目标：父目录 + 目录名 */
const TARGET = 'D:\\NewHome\\DSHHome'
/** 迁移后旧目录被改名成的备份 */
const BACKUP = 'C:\\Users\\me\\.dsh.moved-2026-10-02T21-33-14'

const PLAN: MigrationPlan = {
  source: DATA_DIR,
  target: TARGET,
  totalFiles: 12,
  totalBytes: 2048,
  links: 0,
  targetFreeBytes: 1024 * 1024 * 1024,
  enoughSpace: true,
  parentExists: true,
  remembered: false,
}

const OUTCOME: MigrationOutcome = {
  source: DATA_DIR,
  target: TARGET,
  movedTo: BACKUP,
  files: 12,
  bytes: 2048,
  links: 0,
  sessions: 3,
}

function statusOf(overrides: Partial<DataDirStatus> = {}): DataDirStatus {
  return {
    supported: true,
    dataDir: DATA_DIR,
    defaultDir: 'C:\\Users\\me\\.dsh',
    envOverride: DATA_DIR,
    rollbackAvailable: false,
    backups: [],
    debugBuild: false,
    ...overrides,
  }
}

let client: QueryClient
let backend: { status: DataDirStatus, entries: DataDirEntry[], plan: MigrationPlan, outcome: MigrationOutcome }

beforeEach(() => {
  backend = { status: statusOf(), entries: [], plan: PLAN, outcome: OUTCOME }
  mocks.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === 'get_data_dir_status')
      return backend.status
    if (command === 'list_data_dir_entries')
      return backend.entries
    if (command === 'pick_data_dir')
      return PICKED
    if (command === 'preview_data_dir_migration')
      return backend.plan
    if (command === 'migrate_data_dir' || command === 'rollback_data_dir')
      return backend.outcome
    if (command === 'launch_harness' || command === 'reveal_in_folder')
      return null
    throw new Error(`Unexpected command: ${command}`)
  })
  mocks.dialog.mockReset().mockResolvedValue(undefined)
  mocks.toast.mockReset().mockReturnValue('toast-key')
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } })
})

afterEach(() => {
  cleanup()
  client.clear()
  vi.restoreAllMocks()
})

async function mount() {
  render(<QueryClientProvider client={client}><ConfigDataDir /></QueryClientProvider>)
  // data_dir.current 只在 status 查询落地后渲染，用它把首帧的 pending 状态等过去
  await screen.findByText('data_dir.current')
}

/** 走完「选父目录 → 预检」两步，返回已可点击的迁移按钮 */
async function readyToMigrate() {
  await mount()
  fireEvent.click(screen.getByRole('button', { name: 'data_dir.pick' }))
  await screen.findByText(PICKED)
  fireEvent.click(screen.getByRole('button', { name: 'data_dir.preview' }))
  await screen.findByText(TARGET)
  return screen.getByRole('button', { name: 'data_dir.migrate_action' }) as HTMLButtonElement
}

describe('data directory panel', () => {
  it('hides every migration control in a debug build and explains why', async () => {
    backend.status = statusOf({ supported: false, debugBuild: true })
    await mount()
    expect(screen.getByTestId('dsh-data-dir-unsupported').textContent).toBe('data_dir.debug_hint')
    expect(screen.queryByText('data_dir.migrate_title')).toBeNull()
    expect(screen.queryByText('data_dir.rollback_title')).toBeNull()
  })

  it('shows the current directory and says so when no DSH_HOME override is set', async () => {
    backend.status = statusOf({ envOverride: '' })
    await mount()
    expect(screen.getByText(DATA_DIR).textContent).toBe(DATA_DIR)
    expect(screen.getByText('data_dir.env_unset')).toBeTruthy()
  })

  it('keeps the previous parent when the folder picker is cancelled', async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_data_dir_status')
        return backend.status
      if (command === 'list_data_dir_entries')
        return backend.entries
      if (command === 'pick_data_dir')
        return null
      throw new Error(`Unexpected command: ${command}`)
    })
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'data_dir.pick' }))
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('pick_data_dir'))
    expect(screen.getByText('data_dir.parent_unset')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'data_dir.preview' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('blocks the preview while the folder name is not a single path segment', async () => {
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'data_dir.pick' }))
    await screen.findByText(PICKED)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'nested/leaf' } })
    expect(screen.getByText('data_dir.leaf_invalid')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'data_dir.preview' }) as HTMLButtonElement).disabled).toBe(true)
    expect(mocks.invoke).not.toHaveBeenCalledWith('preview_data_dir_migration', expect.anything())
  })

  it('offers the migrate action only after a preview that fits the disk', async () => {
    const migrate = await readyToMigrate()
    expect(mocks.invoke).toHaveBeenCalledWith('preview_data_dir_migration', { parent: PICKED, leaf: 'DSHHome' })
    expect(migrate.disabled).toBe(false)
    expect(screen.getByText('data_dir.plan_source')).toBeTruthy()
    expect(screen.getByText('2.0 KB')).toBeTruthy()
    expect(screen.getByText('1.0 GB')).toBeTruthy()
    expect(screen.getByText('12')).toBeTruthy()
  })

  it('blocks the migrate action when the target has not enough free space', async () => {
    backend.plan = { ...PLAN, enoughSpace: false, parentExists: false, remembered: true }
    const migrate = await readyToMigrate()
    expect(migrate.disabled).toBe(true)
    expect(screen.getByText('data_dir.plan_no_space')).toBeTruthy()
    expect(screen.getByText('data_dir.plan_parent_missing')).toBeTruthy()
    expect(screen.getByText('data_dir.plan_remembered')).toBeTruthy()
  })

  it('does not migrate when the confirmation is dismissed', async () => {
    mocks.dialog.mockRejectedValue(new Error('cancelled'))
    const migrate = await readyToMigrate()
    fireEvent.click(migrate)
    await waitFor(() => expect(mocks.dialog).toHaveBeenCalledTimes(1))
    expect(mocks.invoke).not.toHaveBeenCalledWith('migrate_data_dir', expect.anything())
  })

  it('migrates only after confirmation and restarts the harness', async () => {
    let confirm!: () => void
    mocks.dialog.mockImplementation(() => new Promise<void>((resolve) => {
      confirm = resolve
    }))
    const migrate = await readyToMigrate()
    fireEvent.click(migrate)
    await waitFor(() => expect(mocks.dialog).toHaveBeenCalledWith(expect.objectContaining({ title: 'data_dir.migrate_confirm_title' })))
    expect(mocks.invoke).not.toHaveBeenCalledWith('migrate_data_dir', expect.anything())
    await act(async () => {
      confirm()
    })
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('migrate_data_dir', { parent: PICKED, leaf: 'DSHHome' }))
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('launch_harness'))
    expect(mocks.toast).toHaveBeenCalledWith('data_dir.migrate_done_toast', expect.objectContaining({ variant: 'accent' }))
  })

  it('reports a failed migration without restarting the harness', async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_data_dir_status')
        return backend.status
      if (command === 'list_data_dir_entries')
        return backend.entries
      if (command === 'pick_data_dir')
        return PICKED
      if (command === 'preview_data_dir_migration')
        return backend.plan
      throw new Error('DATA_DIR_COPY_INCOMPLETE: 12/34')
    })
    const migrate = await readyToMigrate()
    fireEvent.click(migrate)
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('DATA_DIR_COPY_INCOMPLETE'), { variant: 'danger' }))
    expect(mocks.invoke).not.toHaveBeenCalledWith('launch_harness')
  })

  it('warns about a backup that carries no session and rolls back the picked one', async () => {
    const empty = { path: 'C:\\Users\\me\\.dsh.moved-2026-09-01T10-00-00', stamp: '2026-09-01T10-00-00', sessions: 0 }
    const full = { path: BACKUP, stamp: '2026-10-02T21-33-14', sessions: 3 }
    backend.status = statusOf({ rollbackAvailable: true, backups: [empty, full] })
    backend.outcome = { ...OUTCOME, movedTo: '' }
    await mount()
    expect(screen.getByText('data_dir.backup_no_sessions')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'data_dir.rollback_action' })[1])
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('rollback_data_dir', { backup: BACKUP }))
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('launch_harness'))
    expect(mocks.toast).toHaveBeenCalledWith('data_dir.rollback_done_clean', expect.objectContaining({ variant: 'accent' }))
  })

  it('does not roll back when the confirmation is dismissed', async () => {
    mocks.dialog.mockRejectedValue(new Error('cancelled'))
    backend.status = statusOf({ rollbackAvailable: true, backups: [{ path: BACKUP, stamp: '2026-10-02T21-33-14', sessions: 3 }] })
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'data_dir.rollback_action' }))
    await waitFor(() => expect(mocks.dialog).toHaveBeenCalledTimes(1))
    expect(mocks.invoke).not.toHaveBeenCalledWith('rollback_data_dir', expect.anything())
  })

  it('lists what the data directory holds', async () => {
    backend.entries = [{ name: 'sessions', path: 'C:\\DSHHome\\sessions', files: 900, bytes: 4096 }]
    await mount()
    expect(await screen.findByText('sessions')).toBeTruthy()
    // 体积走 formatBytes；文件数走 t(key, {count})，被 mock 的 t 只回显 key，
    // 两者被 ' · ' 拼在同一个 <Description> 里，因此用函数匹配器断言整段文本
    expect(screen.getByText((_, element) => element?.tagName === 'SPAN' && element.textContent === '4.0 KB · data_dir.entry_files')).toBeTruthy()
    expect(screen.queryByText('data_dir.entries_empty')).toBeNull()
  })

  it('falls back to the empty state when the data directory has no sub-directory', async () => {
    await mount()
    expect(await screen.findByText('data_dir.entries_empty')).toBeTruthy()
  })
})
