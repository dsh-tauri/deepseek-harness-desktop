// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { frameMode } from './window-frame'

describe('frameMode', () => {
  it('stays off without the native frame flag', () => {
    expect(frameMode(false)).toBe('')
    expect(frameMode(true)).toBe('')
  })

  it('flattens while maximized or fullscreen', () => {
    ;(window as Window & { __DSH_FRAME__?: boolean }).__DSH_FRAME__ = true
    try {
      expect(frameMode(false)).toBe('border')
      expect(frameMode(true)).toBe('flat')
      expect(frameMode(false, true)).toBe('flat')
    }
    finally {
      delete (window as Window & { __DSH_FRAME__?: boolean }).__DSH_FRAME__
    }
  })
})
