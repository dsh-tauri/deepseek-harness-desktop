import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectMobileDevice, isMobileDevice, MOBILE_MEDIA_QUERIES } from './device'

const MOBILE_QUERIES = [
  '(pointer: coarse)',
  '(any-pointer: coarse)',
  '(any-hover: none)',
  '(max-width: 1023px)',
]

function matcher(answers: Record<string, boolean>) {
  const queries: string[] = []
  const matches = (query: string): boolean => {
    queries.push(query)
    return answers[query] ?? false
  }
  return {
    queries,
    matches,
    matchMedia: (query: string) => ({ matches: matches(query) }),
  }
}

function stubWindow(matchMedia?: (query: string) => { matches: boolean }): void {
  vi.stubGlobal('window', matchMedia === undefined ? undefined : { matchMedia })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isMobileDevice', () => {
  it('treats a narrow touch device with a coarse pointer as mobile', () => {
    const probe = matcher({
      '(pointer: coarse)': true,
      '(any-pointer: coarse)': true,
      '(any-hover: none)': true,
      '(max-width: 1023px)': true,
    })

    expect(isMobileDevice(probe.matches)).toBe(true)
    expect(probe.queries).toEqual(MOBILE_QUERIES)
  })

  it('treats a narrow WebView that misreports hover as mobile', () => {
    const webview = matcher({
      '(pointer: coarse)': true,
      '(any-pointer: coarse)': true,
      '(any-hover: none)': true,
      '(hover: none)': false,
      '(hover: hover)': true,
      '(max-width: 1023px)': true,
    })

    expect(isMobileDevice(webview.matches)).toBe(true)
  })

  it('keeps a touchscreen desktop above the layout breakpoint on the desktop branch', () => {
    const touchDesktop = matcher({
      '(pointer: coarse)': true,
      '(any-pointer: coarse)': true,
      '(any-hover: none)': true,
      '(max-width: 1023px)': false,
    })

    expect(isMobileDevice(touchDesktop.matches)).toBe(false)
  })

  it('keeps every partially matching device on the desktop branch', () => {
    const mouseDesktop = matcher({ '(pointer: coarse)': false, '(any-pointer: coarse)': false, '(max-width: 1023px)': true })
    const touchscreenLaptop = matcher({ '(pointer: coarse)': true, '(any-pointer: coarse)': true, '(any-hover: none)': false, '(max-width: 1023px)': true })
    const hoverTouch = matcher({ '(pointer: coarse)': false, '(any-pointer: coarse)': true, '(any-hover: none)': true, '(max-width: 1023px)': true })

    expect(isMobileDevice(mouseDesktop.matches)).toBe(false)
    expect(isMobileDevice(touchscreenLaptop.matches)).toBe(false)
    expect(isMobileDevice(hoverTouch.matches)).toBe(false)
  })

  it('keeps a touchscreen with a secondary mouse on the desktop branch', () => {
    const tabletWithMouse = matcher({
      '(pointer: coarse)': true,
      '(any-pointer: coarse)': true,
      '(any-hover: hover)': true,
      '(max-width: 1023px)': true,
    })

    expect(isMobileDevice(tabletWithMouse.matches)).toBe(false)
  })

  it('uses the same 1024px breakpoint as the official layout', () => {
    expect(MOBILE_MEDIA_QUERIES).toContain('(max-width: 1023px)')
  })
})

describe('detectMobileDevice', () => {
  it('probes the device capabilities and the layout breakpoint through the kernel matchMedia', () => {
    const probe = matcher({
      '(pointer: coarse)': true,
      '(any-pointer: coarse)': true,
      '(any-hover: none)': true,
      '(max-width: 1023px)': true,
    })
    stubWindow(probe.matchMedia)

    expect(detectMobileDevice()).toBe(true)
    expect(probe.queries).toEqual(MOBILE_QUERIES)
  })

  it('falls back to desktop on a touchscreen desktop window', () => {
    const probe = matcher({
      '(pointer: coarse)': true,
      '(any-pointer: coarse)': true,
      '(any-hover: none)': true,
    })
    stubWindow(probe.matchMedia)

    expect(detectMobileDevice()).toBe(false)
  })

  it.each([undefined, {}])('falls back to desktop when matchMedia is unavailable (%s)', (window) => {
    vi.stubGlobal('window', window)
    expect(detectMobileDevice()).toBe(false)
  })
})
