// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { applyHostedTitlebar, frameMode, SHELL_NAVBAR_HEIGHT } from './window-frame'

afterEach(() => {
  delete document.documentElement.dataset.windowsTitlebar
  document.documentElement.style.removeProperty('--dsh-windows-titlebar-height')
  document.documentElement.style.removeProperty('--dsh-frame-chrome-top')
})

describe('applyHostedTitlebar', () => {
  it('reserves the navbar height for the hosted document', () => {
    applyHostedTitlebar(true, false)
    expect(document.documentElement.hasAttribute('data-windows-titlebar')).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--dsh-windows-titlebar-height')).toBe(`${SHELL_NAVBAR_HEIGHT}px`)
  })

  it('zeroes the chrome-top inset so modal masks cover the navbar', () => {
    // DSH 的模态遮罩用 inset: var(--dsh-frame-chrome-top) 让出原生标题栏；壳层导航栏
    // 属于内容区，遮罩必须盖住它，否则弹窗打开时导航栏仍露在外面且可点击。
    applyHostedTitlebar(true, false)
    expect(document.documentElement.style.getPropertyValue('--dsh-frame-chrome-top')).toBe('0px')
  })

  it('clears the chrome-top inset together with the titlebar', () => {
    applyHostedTitlebar(true, false)
    applyHostedTitlebar(true, true)
    expect(document.documentElement.style.getPropertyValue('--dsh-frame-chrome-top')).toBe('')
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

describe('hosted titlebar and drag band', () => {
  it('reserves the navbar strip through the titlebar variable', () => {
    applyHostedTitlebar(true, false)
    expect(document.documentElement.style.getPropertyValue('--dsh-windows-titlebar-height')).toBe(`${SHELL_NAVBAR_HEIGHT}px`)
  })
})
