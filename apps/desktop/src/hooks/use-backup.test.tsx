// @vitest-environment jsdom
import type { PropsWithChildren } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useBackups } from './use-backup'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))

const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } })
function wrapper({ children }: PropsWithChildren) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

afterEach(() => {
  cleanup()
  client.clear()
  mocks.invoke.mockReset()
  vi.restoreAllMocks()
})

it('keeps backup queries and mutations scoped to the selected profile across navigation', async () => {
  mocks.invoke.mockImplementation(async (command: string, args: { profileId?: string }) => {
    if (command === 'list_backups')
      return [{ timestamp: args.profileId, path: '/fixture/backup.tar.zst', size: 1, includeCredentials: false }]
    if (command === 'backup_profile')
      return { timestamp: 'new', path: '/fixture/new.tar.zst', size: 1, includeCredentials: true }
    if (command === 'restore_profile' || command === 'delete_backup')
      return undefined
    throw new Error(`Unexpected command: ${command}`)
  })
  const { result, rerender } = renderHook(({ id }) => useBackups(id), { initialProps: { id: 'profile-b' }, wrapper })
  await waitFor(() => expect(result.current.backups.map(backup => backup.timestamp)).toEqual(['profile-b']))
  await act(async () => {
    await result.current.createBackup(true)
  })
  await act(async () => {
    await result.current.restoreBackup('saved', true)
  })
  await act(async () => {
    await result.current.deleteBackup('saved')
  })
  expect(mocks.invoke).toHaveBeenCalledWith('backup_profile', { profileId: 'profile-b', includeCredentials: true })
  expect(mocks.invoke).toHaveBeenCalledWith('restore_profile', { profileId: 'profile-b', timestamp: 'saved', asNew: true })
  expect(mocks.invoke).toHaveBeenCalledWith('delete_backup', { profileId: 'profile-b', timestamp: 'saved' })
  rerender({ id: 'profile-a' })
  expect(result.current.backups).toEqual([])
  await waitFor(() => expect(result.current.backups.map(backup => backup.timestamp)).toEqual(['profile-a']))
  await act(async () => {
    await result.current.deleteBackup('different')
  })
  expect(mocks.invoke).toHaveBeenLastCalledWith('list_backups', { profileId: 'profile-a' })
  expect(mocks.invoke).toHaveBeenCalledWith('delete_backup', { profileId: 'profile-a', timestamp: 'different' })
})
