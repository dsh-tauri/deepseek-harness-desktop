// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { applyFrameMode, frameMode } from './window-chrome'

afterEach(() => {
  delete (window as any).__DSH_FRAME__
  delete document.documentElement.dataset.dshFrame
})

describe('rounded frame chrome mode', () => {
  it('stays off without the native frame flag', () => {
    ;(window as any).__DSH_FRAME__ = false
    expect(frameMode(false)).toBe('')
    expect(frameMode(true)).toBe('')
    applyFrameMode(true)
    expect(document.documentElement.dataset.dshFrame).toBeUndefined()
  })

  it('insets the framed window and flattens it while maximized or fullscreen', () => {
    ;(window as any).__DSH_FRAME__ = true
    expect(frameMode(false)).toBe('inset')
    expect(frameMode(true)).toBe('flat')
    expect(frameMode(false, true)).toBe('flat')
    applyFrameMode(false)
    expect(document.documentElement.dataset.dshFrame).toBe('inset')
    applyFrameMode(true)
    expect(document.documentElement.dataset.dshFrame).toBe('flat')
    applyFrameMode(false, true)
    expect(document.documentElement.dataset.dshFrame).toBe('flat')
  })

  it('keeps the frame flush to the window edge on Windows', () => {
    ;(window as any).__DSH_FRAME__ = true
    const descriptor = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent')
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/141.0.0.0',
    })
    try {
      expect(frameMode(false)).toBe('border')
      expect(frameMode(true)).toBe('flat')
      applyFrameMode(false)
      expect(document.documentElement.dataset.dshFrame).toBe('border')
    }
    finally {
      if (descriptor)
        Object.defineProperty(window.navigator, 'userAgent', descriptor)
      else
        delete (window.navigator as any).userAgent
    }
  })
})
