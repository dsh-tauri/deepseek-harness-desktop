// @vitest-environment jsdom
import type { PetGeometry, PetRef } from 'dsh-pet-component'
import type { InteractionConfig, InteractionFrame } from './use-pet-autonomy'
import type { PetSource } from './use-pet-source'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { interactionPlayback, usePetAutonomy } from './use-pet-autonomy'

const { invoke, report } = vi.hoisted(() => ({ invoke: vi.fn(), report: vi.fn(),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('../utils/log', () => ({ reportPetIssue: report }))
vi.mock('dsh-pet-component', () => ({ useConfig: (config: InteractionConfig) => ({ config }) }))

const pet = { geometry: { body: { left: 20, top: 40, right: 100, bottom: 120 } } } as PetRef
const geometry: PetGeometry = { x: 10, y: 20, width: 200, height: 100, body: { left: 60, top: 30, right: 160, bottom: 115 } }
const walking: InteractionFrame = { action: 'walk', direction: 'right', edge: 'left', contact: null }

function fixture() {
  const config: InteractionConfig = {
    motions: { idle: 'idle', working: 'work' },
    interactions: {
      version: 1,
      fallback: 'idle',
      actions: {
        walk: { animation: 'walk', canvas: [100, 100], foot: [0.5, 0.9], facing: 'left', mirror: true },
        squeeze: { animation: 'push', canvas: [100, 100], contact: [0.2, 0.5], facing: 'left', offset: [0.1, -0.1] },
        stretch: { animation: 'pull' },
        move: { animation: 'move' },
      },
    },
  }
  const source: PetSource = { kind: 'dsh', config, uri: '/webm', cache: true, width: 200, aspect: 0.5 }
  const controlled = { geometry, motion: vi.fn(), clear: vi.fn() } as unknown as PetRef
  return { config, source, controlled }
}

beforeEach(() => {
  vi.useFakeTimers()
  invoke.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
})

describe('autonomous pet polling', () => {
  it('reports asset failures even when window interactions are disabled', () => {
    const { source, controlled } = fixture()
    const { result, unmount } = renderHook(() => usePetAutonomy(controlled, false, () => false, source))
    const failure = new Error('missing idle video')
    act(() => result.current.onError(failure))
    expect(report).toHaveBeenCalledExactlyOnceWith('asset', failure)
    unmount()
  })

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
    let busy = false
    const { unmount } = renderHook(() => usePetAutonomy(pet, true, () => busy))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledTimes(1)
    busy = true
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(invoke).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(18_100)
    })
    expect(invoke.mock.calls.length).toBeGreaterThan(1)
    unmount()
  })
})

describe('interaction animation and placement', () => {
  it('uses independent slots and keeps the source configuration unchanged', () => {
    const { config } = fixture()
    for (const [action, name] of [['walk', 'walk'], ['squeeze', 'push'], ['stretch', 'pull'], ['move', 'move']] as const) {
      const result = interactionPlayback(config, { ...walking, action }, geometry)
      expect(result.config?.motions?.['moving-left']).toBe(name)
      expect(result.config?.motions?.working).toBe('work')
      expect(result.active).toBe(true)
    }
    expect(config.motions).toEqual({ idle: 'idle', working: 'work' })
    expect(interactionPlayback(config, null, geometry).config).toBe(config)
  })

  it('falls back to idle without applying the unconfigured or failed pose', () => {
    const { config } = fixture()
    for (const animation of [null, '', 'missing']) {
      config.interactions!.actions!.walk = { animation, offset: [1, 1], contact: [0, 0], facing: 'left' }
      expect(interactionPlayback(config, walking, geometry, ['missing'])).toMatchObject({ animation: 'idle', configured: false, mirrored: false, style: {} })
    }
    expect(interactionPlayback({ animations: { idle: ['legacy-idle'] } }, walking, geometry).animation).toBe('legacy-idle')
    expect(interactionPlayback({}, walking, geometry).active).toBe(false)
  })

  it('aligns feet and mirrored hands using letterboxed video coordinates', () => {
    const { config } = fixture()
    expect(interactionPlayback(config, walking, geometry)).toMatchObject({ mirrored: true, style: { '--pet-interaction-x': '0px', '--pet-interaction-y': '5px' } })
    const pushing: InteractionFrame = { ...walking, action: 'squeeze', contact: { x: 160, y: 70 } }
    expect(interactionPlayback(config, pushing, geometry).style).toEqual({ '--pet-interaction-x': '30px', '--pet-interaction-y': '-10px' })
  })

  it('supports direction overrides and rejects invalid pose coordinates', () => {
    const { config } = fixture()
    config.interactions!.actions!.walk!.directions = { up: { animation: 'walk-up', facing: 'up', canvas: [0, 100], foot: [NaN, 1], offset: [3, 0] } }
    expect(interactionPlayback(config, { ...walking, direction: 'up' }, geometry)).toMatchObject({
      animation: 'walk-up',
      mirrored: false,
      style: { '--pet-interaction-x': '0px', '--pet-interaction-y': '-5px' },
    })
    config.interactions!.actions!.walk!.directions!.up = { animation: null }
    expect(interactionPlayback(config, { ...walking, direction: 'up' }, geometry).animation).toBe('idle')
  })

  it('starts only on stage changes, follows contact updates, and releases on rest', async () => {
    const { source, controlled } = fixture()
    invoke.mockResolvedValue(walking)
    const { result, unmount } = renderHook(() => usePetAutonomy(controlled, true, () => false, source))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(controlled.motion).toHaveBeenCalledTimes(1)
    expect(controlled.motion).toHaveBeenLastCalledWith({ type: 'moving-left', loop: true, replay: true })
    invoke.mockResolvedValue({ ...walking, action: 'squeeze', contact: { x: 160, y: 70 } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(controlled.motion).toHaveBeenCalledTimes(2)
    expect(result.current.animation).toBe('push')
    invoke.mockResolvedValue({ ...walking, action: 'squeeze', contact: { x: 162, y: 70 } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(result.current.style['--pet-interaction-x']).toBe('32px')
    expect(controlled.motion).toHaveBeenCalledTimes(2)
    invoke.mockResolvedValue(null)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(controlled.clear).toHaveBeenCalledTimes(1)
    expect(result.current.active).toBe(false)
    unmount()
  })

  it('falls back after asset failure and gives manual gestures priority over interaction', async () => {
    const { source, controlled } = fixture()
    let busy = false
    invoke.mockResolvedValue(walking)
    const { result, unmount } = renderHook(() => usePetAutonomy(controlled, true, () => busy, source))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    act(() => result.current.onError(new DOMException('video replaced', 'AbortError')))
    expect(result.current.animation).toBe('walk')
    act(() => result.current.onError(new Error('missing video')))
    expect(result.current.animation).toBe('idle')
    expect(result.current.style).toEqual({})
    act(() => result.current.onMotionChange('working'))
    expect(controlled.motion).toHaveBeenLastCalledWith({ type: 'moving-left', loop: true })
    const count = vi.mocked(controlled.motion).mock.calls.length
    busy = true
    act(() => result.current.onMotionChange('dragging'))
    expect(controlled.motion).toHaveBeenCalledTimes(count)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(result.current.active).toBe(false)
    expect(controlled.clear).toHaveBeenCalledOnce()
    unmount()
  })

  it('discards in-flight responses after disable and immediately pauses the native target', async () => {
    const { source, controlled } = fixture()
    let resolve!: (frame: InteractionFrame) => void
    invoke.mockReturnValueOnce(new Promise<InteractionFrame>((done) => {
      resolve = done
    }))
    const { result, rerender, unmount } = renderHook(({ enabled }) => usePetAutonomy(controlled, enabled, () => false, source), { initialProps: { enabled: true } })
    rerender({ enabled: false })
    await act(async () => {
      resolve(walking)
    })
    expect(result.current.active).toBe(false)
    expect(controlled.motion).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(invoke).toHaveBeenLastCalledWith('step_pet_autonomy', { body: geometry.body, paused: true })
    unmount()
  })

  it('clears placement and retries failed assets when changing pet sources', async () => {
    const { source, controlled } = fixture()
    invoke.mockResolvedValue(walking)
    const { result, rerender, unmount } = renderHook(({ activeSource }) => usePetAutonomy(controlled, true, () => false, activeSource), { initialProps: { activeSource: source } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    act(() => result.current.onError(new Error('missing video')))
    rerender({ activeSource: { ...source, uri: '/other' } })
    await act(async () => {})
    expect(result.current.active).toBe(false)
    expect(invoke).toHaveBeenLastCalledWith('step_pet_autonomy', { body: geometry.body, paused: true })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(result.current.animation).toBe('walk')
    unmount()
  })
})
