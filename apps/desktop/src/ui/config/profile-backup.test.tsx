// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ConfigProfile } from './profile'

const calls = vi.hoisted(() => ({ invoke: vi.fn(), switchProfile: vi.fn(), toast: vi.fn(), backedUp: [] as string[] }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: calls.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('@overlastic/react', () => ({ useOverlay: () => [null, vi.fn()] }))
vi.mock('@/store', () => ({ store: { harness: { switchProfile: calls.switchProfile, restart: vi.fn() } } }))
vi.mock('@/store/modules/harness', () => ({ waitForHarnessStopped: vi.fn() }))
vi.mock('@/ui/dialog/profile-migrate', () => ({ ProfileMigrateDialog: () => null }))
vi.mock('@/utils/toast', () => ({ toast: calls.toast }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

let client: QueryClient
afterEach(() => {
  cleanup()
  client.clear()
  calls.invoke.mockReset()
  calls.switchProfile.mockReset()
  calls.toast.mockReset()
  calls.backedUp.length = 0
  vi.restoreAllMocks()
})

it('creates a backup for the profile whose Manage backups entry was selected', async () => {
  const active = 'profile-a'
  calls.invoke.mockImplementation(async (command: string, args: unknown) => {
    if (command === 'get_profiles') {
      return [
        { id: active, name: 'Profile A', active: true, builtin: false },
        { id: 'profile-b', name: 'Profile B', active: false, builtin: false },
      ]
    }
    if (command === 'list_backups')
      return []
    if (command === 'backup_profile') {
      calls.backedUp.push((args as { profileId?: string } | undefined)?.profileId ?? active)
      return { timestamp: 'audit', path: '/fixture/audit.tar.zst', size: 10, includeCredentials: false }
    }
    throw new Error(`Unexpected command: ${command}`)
  })
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } })
  render(<QueryClientProvider client={client}><ConfigProfile /></QueryClientProvider>)
  await screen.findByText('Profile B')
  fireEvent.click(screen.getByRole('switch', { name: 'profiles.advanced_options' }))
  fireEvent.click(screen.getAllByText('backup.manage')[1])
  await screen.findByText('backup.empty_title')
  fireEvent.click(screen.getByRole('button', { name: 'backup.now' }))
  await waitFor(() => expect(calls.backedUp).toHaveLength(1))
  expect(calls.switchProfile).not.toHaveBeenCalled()
  expect(calls.backedUp).toEqual(['profile-b'])
})

it('restores the selected inactive profile without stopping or launching the window profile', async () => {
  calls.invoke.mockImplementation(async (command: string) => {
    if (command === 'get_profiles') {
      return [
        { id: 'profile-a', name: 'Profile A', active: true, builtin: false },
        { id: 'profile-b', name: 'Profile B', active: false, builtin: false },
      ]
    }
    if (command === 'list_backups')
      return [{ timestamp: '20261105120000', path: '/fixture/b.tar.zst', size: 10, includeCredentials: false }]
    if (command === 'restore_profile')
      return undefined
    throw new Error(`Unexpected command: ${command}`)
  })
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } })
  render(<QueryClientProvider client={client}><ConfigProfile /></QueryClientProvider>)
  await screen.findByText('Profile B')
  fireEvent.click(screen.getByRole('switch', { name: 'profiles.advanced_options' }))
  fireEvent.click(screen.getAllByText('backup.manage')[1])
  fireEvent.click(await screen.findByRole('button', { name: 'backup.restore' }))
  await waitFor(() => expect(calls.toast).toHaveBeenCalledWith('backup.restored_toast', {
    variant: 'accent',
    timeout: 5000,
  }))
  expect(calls.invoke).toHaveBeenCalledWith('restore_profile', {
    profileId: 'profile-b',
    timestamp: '20261105120000',
    asNew: false,
  })
  expect(calls.invoke).toHaveBeenCalledWith('list_backups', { profileId: 'profile-b' })
  expect(calls.invoke).not.toHaveBeenCalledWith('shutdown_harness')
  expect(calls.invoke).not.toHaveBeenCalledWith('launch_harness')
  expect(calls.switchProfile).not.toHaveBeenCalled()
})

it('relaunches the active profile after its restore succeeds', async () => {
  let finishRestore!: () => void
  calls.invoke.mockImplementation(async (command: string) => {
    if (command === 'get_profiles') {
      return [
        { id: 'profile-a', name: 'Profile A', active: true, builtin: false },
        { id: 'profile-b', name: 'Profile B', active: false, builtin: false },
      ]
    }
    if (command === 'list_backups')
      return [{ timestamp: '20261105120000', path: '/fixture/a.tar.zst', size: 10, includeCredentials: false }]
    if (command === 'restore_profile') {
      return new Promise<void>((resolve) => {
        finishRestore = resolve
      })
    }
    if (command === 'launch_harness')
      return undefined
    throw new Error(`Unexpected command: ${command}`)
  })
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } })
  render(<QueryClientProvider client={client}><ConfigProfile /></QueryClientProvider>)
  await screen.findByText('Profile A')
  fireEvent.click(screen.getByRole('switch', { name: 'profiles.advanced_options' }))
  fireEvent.click(screen.getAllByText('backup.manage')[0])
  fireEvent.click(await screen.findByRole('button', { name: 'backup.restore' }))
  await waitFor(() => expect(calls.invoke).toHaveBeenCalledWith('restore_profile', {
    profileId: 'profile-a',
    timestamp: '20261105120000',
    asNew: false,
  }))
  expect(calls.invoke).not.toHaveBeenCalledWith('launch_harness')
  await act(async () => {
    finishRestore()
  })
  await waitFor(() => expect(calls.toast).toHaveBeenCalledWith('backup.restored_toast', {
    variant: 'accent',
    timeout: 10_000,
    actionProps: { children: 'app.restart', onPress: expect.any(Function) },
  }))
  expect(calls.invoke).toHaveBeenCalledWith('launch_harness')
  expect(calls.invoke).not.toHaveBeenCalledWith('shutdown_harness')
  expect(calls.switchProfile).not.toHaveBeenCalled()
})
