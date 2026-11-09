// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useZoom } from './use-zoom'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  setting: { zoom_factor: 1, hydrated: true, zoom: vi.fn() },
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: mocks.listen.mockImplementation(async (event: string, handler: (e: { payload: unknown }) => void) => {
    mocks.listeners.set(event, handler)
    return () => {}
  }),
}))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }))
vi.mock('valtio-define', () => ({ useStore: () => mocks.setting }))
vi.mock('@/store', () => ({ store: { setting: mocks.setting } }))

describe('useZoom', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listeners.clear()
    mocks.setting.zoom_factor = 1
    mocks.setting.hydrated = true
  })

  it('applies the persisted factor on mount', async () => {
    mocks.setting.zoom_factor = 1.4
    renderHook(() => useZoom())
    await vi.waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('set_harness_zoom', { zoomFactor: 1.4 })
    })
  })

  it('does not apply before the store is hydrated', async () => {
    mocks.setting.hydrated = false
    renderHook(() => useZoom())
    await new Promise(r => setTimeout(r, 20))
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('routes dsh://zoom-shortcut into setting.zoom', async () => {
    renderHook(() => useZoom())
    await vi.waitFor(() => expect(mocks.listeners.has('dsh://zoom-shortcut')).toBe(true))
    mocks.listeners.get('dsh://zoom-shortcut')!({ payload: { action: 'increase' } })
    expect(mocks.setting.zoom).toHaveBeenCalledWith('increase')
  })
})
