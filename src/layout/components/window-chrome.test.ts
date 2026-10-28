// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyFrameMode, frameMode, useFullscreen, useMaximized } from './window-chrome'

const mocks = vi.hoisted(() => ({
  isFullscreen: vi.fn(),
  isMaximized: vi.fn(),
  onResized: vi.fn(),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isFullscreen: mocks.isFullscreen,
    isMaximized: mocks.isMaximized,
    onResized: mocks.onResized,
  }),
}))

const frameCss = readFileSync(resolve(process.cwd(), 'src/styles/main.css'), 'utf8')

afterEach(() => {
  cleanup()
  delete (window as any).__DSH_FRAME__
  delete (window as any).__TAURI_INTERNALS__
  delete document.documentElement.dataset.dshFrame
  vi.resetAllMocks()
})

describe('rounded frame chrome mode', () => {
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

  it('limits rounded body clipping to border mode', () => {
    expect(frameCss).toContain('html[data-dsh-frame="border"] body {\n  clip-path: inset(0 round var(--frame-radius));\n}')
    expect(frameCss).not.toMatch(/html\[data-dsh-frame\] body\s*\{[^}]*clip-path/)
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
