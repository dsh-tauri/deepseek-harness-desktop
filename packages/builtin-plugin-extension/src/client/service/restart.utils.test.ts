import { afterEach, describe, expect, it, vi } from 'vitest'
import { isDesktopHost } from './restart.utils'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isDesktopHost', () => {
  it('requires the restart command rather than the account-only presence marker', () => {
    vi.stubGlobal('window', { dshDesktop: null })
    expect(isDesktopHost()).toBe(false)
  })

  it('recognizes an actual restart command', () => {
    vi.stubGlobal('window', { dshDesktop: { restartSidecar: vi.fn() } })
    expect(isDesktopHost()).toBe(true)
  })

  it('does not recognize standalone web without a window', () => {
    vi.stubGlobal('window', undefined)
    expect(isDesktopHost()).toBe(false)
  })
})
