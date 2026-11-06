import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useRemote } from './use-remote'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }))
vi.mock('@/utils/window-presentation', () => ({ isHostedDocument: () => true, isHostedServiceDocument: () => true }))
vi.mock('@/apis/remote', () => ({ getMachines: async () => ({ enabled: true, items: [] }), getMachinesEvents: async () => ({ items: [] }), postMachinesConnect: vi.fn(), postMachinesDisconnect: vi.fn() }))
it('returns a disconnected native remote document to local even after its machine selection was cleared', async () => {
  invoke.mockImplementation(async command => command === 'get_remote_shell_state' ? { machineId: 'removed-machine' } : undefined)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const view = renderHook(() => useRemote(), { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> })
  await waitFor(() => expect(view.result.current.enabled).toBe(true))
  expect(view.result.current.activeId).toBeNull()
  act(() => view.result.current.backToLocal())
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('navigate_remote_harness', { machineId: null }))
  view.unmount()
  client.clear()
})
