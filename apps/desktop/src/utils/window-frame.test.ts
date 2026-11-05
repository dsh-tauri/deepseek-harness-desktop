// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { applyHostedTitlebar, frameMode, SHELL_NAVBAR_HEIGHT } from './window-frame'

afterEach(() => {
  delete document.documentElement.dataset.windowsTitlebar
  document.documentElement.style.removeProperty('--dsh-windows-titlebar-height')
})

describe('applyHostedTitlebar', () => {
  it('reserves the navbar height for the hosted document', () => {
    applyHostedTitlebar(true, false)
    expect(document.documentElement.hasAttribute('data-windows-titlebar')).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--dsh-windows-titlebar-height')).toBe(`${SHELL_NAVBAR_HEIGHT}px`)
  })

  it('clears the reservation when the navbar is hidden', () => {
    applyHostedTitlebar(true, false)
    applyHostedTitlebar(true, true)
    expect(document.documentElement.hasAttribute('data-windows-titlebar')).toBe(false)
    expect(document.documentElement.style.getPropertyValue('--dsh-windows-titlebar-height')).toBe('')
  })

  it('never touches the native shell page', () => {
    applyHostedTitlebar(false, false)
    expect(document.documentElement.hasAttribute('data-windows-titlebar')).toBe(false)
  })
})

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
