// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { useTimers } from './use-timers'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('runs delayed callbacks after StrictMode replays the lifecycle', () => {
  vi.useFakeTimers()
  const callback = vi.fn()
  const { result } = renderHook(useTimers, { wrapper: StrictMode })
  result.current.later(callback, 10)
  act(() => vi.advanceTimersByTime(10))
  expect(callback).toHaveBeenCalledExactlyOnceWith()
  expect(result.current.mounted.current).toBe(true)
})

it('cancels all pending callbacks when the consumer unmounts', () => {
  vi.useFakeTimers()
  const callback = vi.fn()
  const { result, unmount } = renderHook(useTimers)
  result.current.later(callback, 10)
  result.current.later(callback, 20)
  unmount()
  expect(result.current.mounted.current).toBe(false)
  act(() => vi.runAllTimers())
  expect(callback).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
