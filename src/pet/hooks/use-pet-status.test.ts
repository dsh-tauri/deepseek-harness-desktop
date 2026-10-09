// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePetStatus } from './use-pet-status'

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: native.listen }))
const initial = { enabled: true, visible: true, active_pet: 'old' }
let handler: (event: { payload: typeof initial }) => void
let resolve: (value: typeof initial) => void

beforeEach(() => {
  vi.resetAllMocks()
  native.invoke.mockReturnValue(new Promise((yes) => {
    resolve = yes
  }))
  native.listen.mockImplementation((_name, callback) => {
    handler = callback
    return Promise.resolve(vi.fn())
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('pet status initialization', () => {
  it('keeps a newer event when the initial request resolves late', async () => {
    const { result } = renderHook(() => usePetStatus())
    const current = { enabled: true, visible: true, active_pet: 'new' }
    act(() => {
      handler({ payload: current })
    })
    await act(async () => {
      resolve(initial)
    })
    expect(result.current).toEqual(current)
  })

  it('loads initial status when no newer event has arrived', async () => {
    const { result } = renderHook(() => usePetStatus())
    expect(result.current).toBeNull()
    await act(async () => {
      resolve(initial)
    })
    expect(result.current).toEqual(initial)
  })
})
