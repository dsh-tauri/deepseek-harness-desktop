// @vitest-environment jsdom
import type { PetRef } from 'dsh-pet-component'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePetAutonomy } from './use-pet-autonomy'

const { invoke, report } = vi.hoisted(() => ({ invoke: vi.fn(), report: vi.fn(),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('../utils/log', () => ({ reportPetIssue: report }))

const pet = { geometry: { body: { left: 20, top: 40, right: 100, bottom: 120 } } } as PetRef

beforeEach(() => {
  vi.useFakeTimers()
  invoke.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
})

describe('autonomous pet polling', () => {
  it('sends actual body bounds and pauses when grabbed or flying', async () => {
    let busy = false
    const { unmount } = renderHook(() => usePetAutonomy(pet, true, () => busy))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(invoke).toHaveBeenLastCalledWith('step_pet_autonomy', { body: pet.geometry?.body, paused: false })
    busy = true
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(invoke).toHaveBeenLastCalledWith('step_pet_autonomy', { body: pet.geometry?.body, paused: true })
    unmount()
    invoke.mockClear()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('does not overlap native requests and stops polling when disabled', async () => {
    let resolve!: () => void
    invoke.mockReturnValueOnce(new Promise<void>((done) => {
      resolve = done
    }))
    const { rerender, unmount } = renderHook(({ enabled }) => usePetAutonomy(pet, enabled, () => false), { initialProps: { enabled: true } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(invoke).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolve()
    })
    rerender({ enabled: false })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(invoke).toHaveBeenLastCalledWith('step_pet_autonomy', { body: pet.geometry?.body, paused: true })
    unmount()
  })

  it('backs off after native failure instead of flooding the bridge', async () => {
    invoke.mockRejectedValueOnce(new Error('native failure'))
    const { unmount } = renderHook(() => usePetAutonomy(pet, true, () => false))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(19_100)
    })
    expect(invoke.mock.calls.length).toBeGreaterThan(1)
    unmount()
  })
})
