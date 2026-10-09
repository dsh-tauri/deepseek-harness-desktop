// @vitest-environment jsdom
import type { PropsWithChildren } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '../src/config/query-keys'
import { useRemote } from '../src/hooks/use-remote'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

let client: QueryClient
let failure: string | undefined
let warn: ReturnType<typeof vi.spyOn>

function Wrapper({ children }: PropsWithChildren) {
  return createElement(QueryClientProvider, { client }, children)
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  failure = 'REMOTE_REQUEST_FAILED: connection refused'
  invoke.mockReset().mockImplementation(async () => {
    if (failure !== undefined)
      throw failure
    return { enabled: false, items: [] }
  })
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  client.clear()
  vi.restoreAllMocks()
})

describe('remote poll logging', () => {
  it('logs an unreachable instance once per outage, not once per poll', async () => {
    const { result } = renderHook(useRemote, { wrapper: Wrapper })
    await waitFor(() => expect(result.current.available).toBe(false))
    for (const attempt of [2, 3]) {
      let rejectRequest!: (reason: unknown) => void
      invoke.mockImplementationOnce(() => new Promise((_resolve, reject) => {
        rejectRequest = reject
      }))
      let resetPromise!: Promise<void>
      act(() => {
        resetPromise = client.resetQueries({ queryKey: queryKeys.remoteMachines, exact: true })
      })
      await waitFor(() => expect(result.current.available).toBe(true))
      rejectRequest(new Error(`REMOTE_REQUEST_FAILED: connection refused (attempt ${attempt})`))
      await act(async () => {
        await resetPromise
      })
      await waitFor(() => expect(result.current.available).toBe(false))
    }
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[remote] ssh api unreachable:', 'REMOTE_REQUEST_FAILED: connection refused')
  })

  it('logs again when a fresh outage follows a recovery', async () => {
    const { result } = renderHook(useRemote, { wrapper: Wrapper })
    await waitFor(() => expect(result.current.available).toBe(false))
    await act(async () => {
      await result.current.refresh()
    })
    failure = undefined
    await act(async () => {
      await result.current.refresh()
    })
    await waitFor(() => expect(result.current.available).toBe(true))
    expect(warn).toHaveBeenCalledTimes(1)
    failure = 'REMOTE_REQUEST_FAILED: connection refused'
    await act(async () => {
      await result.current.refresh()
    })
    await waitFor(() => expect(result.current.available).toBe(false))
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('does not log when the instance is reachable but has no SSH API', async () => {
    failure = 'REMOTE_API_MISSING: 404'
    const { result } = renderHook(useRemote, { wrapper: Wrapper })
    await waitFor(() => expect(client.getQueryState(queryKeys.remoteMachines)?.status).toBe('success'))
    expect(result.current.available).toBe(true)
    expect(result.current.enabled).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })
})
