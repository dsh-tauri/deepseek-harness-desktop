// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyFrameMode, frameMode } from '@/utils/window-frame'
import { useFrameChrome, useFullscreen, useMaximized } from './use-window-chrome'

const mocks = vi.hoisted(() => ({
  isFullscreen: vi.fn(),
  isMaximized: vi.fn(),
  onResized: vi.fn(),
}))

vi.mock('@/utils/window-frame', async importOriginal => ({
  ...await importOriginal<typeof import('@/utils/window-frame')>(),
  IS_MACOS: true,
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isFullscreen: mocks.isFullscreen,
    isMaximized: mocks.isMaximized,
    onResized: mocks.onResized,
  }),
}))

afterEach(() => {
  cleanup()
  delete (window as any).__DSH_FRAME__
  delete (window as any).__TAURI_INTERNALS__
  delete document.documentElement.dataset.dshFrame
  vi.resetAllMocks()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.windowsTitlebar
  document.documentElement.style.cssText = ''
})

describe('rounded frame chrome mode', () => {
  it('removes hosted navbar clearance when an unframed macOS window enters fullscreen', async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', {})
    vi.stubGlobal('__DSH_HOSTED__', true)
    let resize: (() => void) | undefined
    mocks.onResized.mockImplementation(async (handler) => {
      resize = handler
      return vi.fn()
    })
    mocks.isFullscreen.mockResolvedValue(false)
    renderHook(useFrameChrome)
    await waitFor(() => expect(mocks.isFullscreen).toHaveBeenCalled())
    expect(document.documentElement.style.getPropertyValue('--dsh-windows-titlebar-height')).toBe('44px')
    mocks.isFullscreen.mockResolvedValue(true)
    await act(async () => resize!())
    await waitFor(() => expect(document.documentElement.hasAttribute('data-windows-titlebar')).toBe(false))
  })

  it('stays off without the native frame flag', () => {
    ;(window as any).__DSH_FRAME__ = false
    expect(frameMode(false)).toBe('')
    expect(frameMode(true)).toBe('')
    applyFrameMode(true)
    expect(document.documentElement.dataset.dshFrame).toBeUndefined()
  })

  it('keeps the frame flush and flattens it while maximized or fullscreen', () => {
    ;(window as any).__DSH_FRAME__ = true
    expect(frameMode(false)).toBe('border')
    expect(frameMode(true)).toBe('flat')
    expect(frameMode(false, true)).toBe('flat')
    applyFrameMode(false)
    expect(document.documentElement.dataset.dshFrame).toBe('border')
    applyFrameMode(true)
    expect(document.documentElement.dataset.dshFrame).toBe('flat')
    applyFrameMode(false, true)
    expect(document.documentElement.dataset.dshFrame).toBe('flat')
  })

  it.each(['maximized', 'fullscreen'] as const)('subscribes to resize before reading %s state', async (state) => {
    const calls: string[] = []
    ;(window as any).__TAURI_INTERNALS__ = {}
    mocks.onResized.mockImplementation(async () => {
      calls.push('listen')
      return vi.fn()
    })
    const query = state === 'maximized' ? mocks.isMaximized : mocks.isFullscreen
    query.mockImplementation(async () => {
      calls.push('query')
      return false
    })
    const useHook = state === 'maximized' ? useMaximized : useFullscreen
    const { result } = renderHook(() => useHook())
    await waitFor(() => expect(calls).toEqual(['listen', 'query']))
    expect(result.current).toBe(false)
  })
})
