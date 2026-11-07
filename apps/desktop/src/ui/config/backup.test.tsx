// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en-US.json'
import zh from '@/i18n/locales/zh-CN.json'
import { ConfigBackup } from './backup'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), dialog: vi.fn(), toast: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('@overlastic/react', () => ({ useOverlay: () => [null, mocks.dialog] }))
vi.mock('@/store', () => ({ store: { harness: { restart: vi.fn() } } }))
vi.mock('@/utils/toast', () => ({ toast: mocks.toast }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

let client: QueryClient
const exported = { timestamp: '20261002123000', path: '/scratch/recovery/data.tar.zst', size: 1234, includeCredentials: false }

beforeEach(() => {
  mocks.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === 'list_backups')
      return []
    if (command === 'export_recovery_backup')
      return exported
    throw new Error(`Unexpected command: ${command}`)
  })
  mocks.dialog.mockReset().mockResolvedValue(undefined)
  mocks.toast.mockReset()
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } })
})

afterEach(() => {
  cleanup()
  client.clear()
  vi.restoreAllMocks()
})

async function mount() {
  render(<QueryClientProvider client={client}><ConfigBackup profileId="profile-a" active onBack={() => {}} /></QueryClientProvider>)
  await screen.findByText('backup.empty_title')
}

describe('backup recovery controls', () => {
  it('describes profile backups without claiming that they include conversations', () => {
    expect(en['backup.empty_desc']).toContain('do not include conversations')
    expect(zh['backup.empty_desc']).toContain('不包含会话')
  })

  it('does not export when the stop-service confirmation is cancelled', async () => {
    mocks.dialog.mockRejectedValue(new Error('cancelled'))
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'backup.export_recovery' }))
    await waitFor(() => expect(mocks.dialog).toHaveBeenCalledTimes(1))
    expect(mocks.invoke).not.toHaveBeenCalledWith('export_recovery_backup', expect.anything())
  })

  it('exports only after confirmation and displays the saved archive path', async () => {
    let confirm!: () => void
    mocks.dialog.mockImplementation(() => new Promise<void>((resolve) => {
      confirm = resolve
    }))
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'backup.export_recovery' }))
    await waitFor(() => expect(mocks.dialog).toHaveBeenCalledWith(expect.objectContaining({ title: 'backup.recovery_confirm_title' })))
    expect(mocks.invoke).not.toHaveBeenCalledWith('export_recovery_backup', expect.anything())
    await act(async () => {
      confirm()
    })
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('export_recovery_backup', { includeCredentials: false }))
    expect((await screen.findByText(exported.path)).textContent).toBe(exported.path)
    expect(mocks.invoke).not.toHaveBeenCalledWith('restore_profile', expect.anything())
  })

  it('includes credentials only when the user selects the credential option', async () => {
    await mount()
    fireEvent.click(screen.getByRole('checkbox', { name: 'backup.include_credentials' }))
    fireEvent.click(screen.getByRole('button', { name: 'backup.export_recovery' }))
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('export_recovery_backup', { includeCredentials: true }))
  })

  it('keeps backup actions disabled until the recovery export finishes', async () => {
    let finish!: (value: typeof exported) => void
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'list_backups')
        return []
      if (command === 'export_recovery_backup') {
        return new Promise((resolve) => {
          finish = resolve
        })
      }
      throw new Error(`Unexpected command: ${command}`)
    })
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'backup.export_recovery' }))
    await waitFor(() => expect((screen.getByRole('button', { name: 'backup.now' }) as HTMLButtonElement).disabled).toBe(true))
    expect((screen.getByRole('button', { name: /backup.exporting_recovery/ }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {
      finish(exported)
    })
    await waitFor(() => expect((screen.getByRole('button', { name: 'backup.now' }) as HTMLButtonElement).disabled).toBe(false))
  })

  it('reports an export failure without displaying a successful archive', async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'list_backups')
        return []
      throw new Error('RECOVERY_ARCHIVE_FAILED: disk full')
    })
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'backup.export_recovery' }))
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('disk full'), { variant: 'danger' }))
    expect(screen.queryByText(exported.path)).toBeNull()
    expect(mocks.invoke).not.toHaveBeenCalledWith('launch_harness')
  })
})
