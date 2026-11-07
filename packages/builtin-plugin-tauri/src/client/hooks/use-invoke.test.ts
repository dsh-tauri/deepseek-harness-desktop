// @vitest-environment jsdom
import type { UseInvokeResult } from './use-invoke'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useInvoke } from './use-invoke'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../service/tauri', () => ({ invoke }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useInvoke request lifecycle', () => {
  it('derives loading and cleared errors on the first render of a new command while retaining data', async () => {
    const first = deferred<string>()
    const failed = deferred<string>()
    const retry = deferred<string>()
    invoke.mockReturnValueOnce(first.promise).mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise)
    const renders: UseInvokeResult<string>[] = []
    const { result, rerender } = renderHook(({ cmd }) => {
      const state = useInvoke<string>(cmd)
      renders.push(state)
      return state
    }, { initialProps: { cmd: 'first' } })

    expect(result.current).toEqual({ data: null, loading: true, error: null })
    await act(async () => first.resolve('saved'))
    expect(result.current).toEqual({ data: 'saved', loading: false, error: null })
    rerender({ cmd: 'failed' })
    await act(async () => failed.reject(new Error('offline')))
    expect(result.current).toEqual({ data: 'saved', loading: false, error: 'offline' })

    renders.length = 0
    rerender({ cmd: 'retry' })
    expect(renders[0]).toEqual({ data: 'saved', loading: true, error: null })
    expect(invoke.mock.calls.map(([cmd]) => cmd)).toEqual(['first', 'failed', 'retry'])
    await act(async () => retry.resolve('fresh'))
    expect(result.current).toEqual({ data: 'fresh', loading: false, error: null })
  })

  it('reinvokes only for command or serialized argument changes using the latest options', async () => {
    const first = deferred<number>()
    const next = deferred<number>()
    const changed = deferred<number>()
    invoke.mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise).mockReturnValueOnce(changed.promise)
    const { result, rerender } = renderHook(({ cmd, args, options }) => useInvoke<number>(cmd, args, options), {
      initialProps: { cmd: 'read', args: { id: 1 }, options: { headers: { token: 'first' } } },
    })
    expect(invoke).toHaveBeenCalledExactlyOnceWith('read', { id: 1 }, { headers: { token: 'first' } })
    await act(async () => first.resolve(1))
    rerender({ cmd: 'read', args: { id: 1 }, options: { headers: { token: 'next' } } })
    expect(invoke).toHaveBeenCalledTimes(1)
    rerender({ cmd: 'read', args: { id: 2 }, options: { headers: { token: 'next' } } })
    expect(invoke).toHaveBeenNthCalledWith(2, 'read', { id: 2 }, { headers: { token: 'next' } })
    expect(result.current).toEqual({ data: 1, loading: true, error: null })
    await act(async () => next.resolve(2))
    rerender({ cmd: 'changed', args: { id: 2 }, options: { headers: { token: 'latest' } } })
    expect(invoke).toHaveBeenNthCalledWith(3, 'changed', { id: 2 }, { headers: { token: 'latest' } })
    await act(async () => changed.resolve(3))
    expect(result.current).toEqual({ data: 3, loading: false, error: null })
  })

  it.each(['resolve', 'reject'] as const)('ignores a superseded request that will %s while the latest is pending', async (settlement) => {
    const old = deferred<string>()
    const latest = deferred<string>()
    invoke.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise)
    const { result, rerender } = renderHook(({ id }) => useInvoke<string>('read', { id }), { initialProps: { id: 1 } })
    rerender({ id: 2 })
    await act(async () => settlement === 'resolve' ? old.resolve('stale') : old.reject(new Error('stale')))
    expect(result.current).toEqual({ data: null, loading: true, error: null })
    expect(console.error).not.toHaveBeenCalled()
    await act(async () => latest.resolve('latest'))
    expect(result.current).toEqual({ data: 'latest', loading: false, error: null })
  })

  it.each(['resolve', 'reject'] as const)('ignores a superseded request that will %s after the latest has settled', async (settlement) => {
    const old = deferred<string>()
    const latest = deferred<string>()
    invoke.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise)
    const { result, rerender } = renderHook(({ cmd }) => useInvoke<string>(cmd), { initialProps: { cmd: 'old' } })
    rerender({ cmd: 'latest' })
    await act(async () => latest.resolve('latest'))
    await act(async () => settlement === 'resolve' ? old.resolve('stale') : old.reject('stale'))
    expect(result.current).toEqual({ data: 'latest', loading: false, error: null })
    expect(console.error).not.toHaveBeenCalled()
  })

  it('treats returning to earlier command arguments as a new pending request', async () => {
    const first = deferred<string>()
    const middle = deferred<string>()
    const last = deferred<string>()
    invoke.mockReturnValueOnce(first.promise).mockReturnValueOnce(middle.promise).mockReturnValueOnce(last.promise)
    const { result, rerender } = renderHook(({ id }) => useInvoke<string>('read', { id }), { initialProps: { id: 1 } })
    await act(async () => first.resolve('cached'))
    rerender({ id: 2 })
    rerender({ id: 1 })
    expect(result.current).toEqual({ data: 'cached', loading: true, error: null })
    await act(async () => middle.resolve('stale'))
    expect(result.current).toEqual({ data: 'cached', loading: true, error: null })
    await act(async () => last.resolve('new'))
    expect(result.current).toEqual({ data: 'new', loading: false, error: null })
  })

  it.each([[new Error('offline'), 'offline'], ['offline', 'offline'], [42, '42'], [null, 'null']])('normalizes rejection %s to a string', async (reason, error) => {
    const pending = deferred<string>()
    invoke.mockReturnValueOnce(pending.promise)
    const { result } = renderHook(() => useInvoke<string>('read'))
    await act(async () => pending.reject(reason))
    expect(result.current).toEqual({ data: null, loading: false, error })
    expect(console.error).toHaveBeenCalledExactlyOnceWith('[useInvoke] read failed:', reason)
  })

  it('settles synchronous invoke failures as errors', async () => {
    invoke.mockImplementation(() => {
      throw new Error('unavailable')
    })
    const { result } = renderHook(() => useInvoke<string>('read'))
    await act(async () => {})
    expect(result.current).toEqual({ data: null, loading: false, error: 'unavailable' })
  })

  it.each(['resolve', 'reject'] as const)('ignores a pending request that will %s after unmount', async (settlement) => {
    const pending = deferred<string>()
    invoke.mockReturnValueOnce(pending.promise)
    const rendered = vi.fn(() => useInvoke<string>('read'))
    const { result, unmount } = renderHook(rendered)
    const beforeUnmount = result.current
    unmount()
    const renderCount = rendered.mock.calls.length
    await act(async () => settlement === 'resolve' ? pending.resolve('late') : pending.reject(new Error('late')))
    expect(result.current).toBe(beforeUnmount)
    expect(rendered).toHaveBeenCalledTimes(renderCount)
    expect(console.error).not.toHaveBeenCalled()
  })

  it('ignores StrictMode cancelled setup results and accepts the active setup', async () => {
    const cancelled = deferred<string>()
    const active = deferred<string>()
    invoke.mockReturnValueOnce(cancelled.promise).mockReturnValueOnce(active.promise)
    const { result } = renderHook(() => useInvoke<string>('read'), { reactStrictMode: true })
    await act(async () => cancelled.reject('cancelled'))
    expect(result.current).toEqual({ data: null, loading: true, error: null })
    expect(console.error).not.toHaveBeenCalled()
    await act(async () => active.resolve('active'))
    expect(result.current).toEqual({ data: 'active', loading: false, error: null })
  })
})
