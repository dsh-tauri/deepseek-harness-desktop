// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import desktopStyle from '../../../../dsh-tauri-ui/src/client/styles/global.cssr'
import { cssr } from '../../../../dsh-tauri-ui/src/client/utils/cssr'
import { mountStyle } from '../../../../dsh-tauri-ui/src/client/utils/style'
import { MOBILE_MEDIA_QUERIES, MOBILE_POINTER_QUERIES } from '../../../../dsh-tauri/src/client/utils/device'
import { registerStyles } from './styles'

vi.mock('dsh-tauri/client', () => ({
  MOBILE_MEDIA_QUERIES,
  MOBILE_POINTER_QUERIES,
  defineRegister: (setup: (controller: unknown) => void) => () => {
    const disposers: Array<() => void> = []
    setup({ add: (dispose: () => void) => disposers.push(dispose) })
    return () => disposers.reverse().forEach(dispose => dispose())
  },
}))
vi.mock('dsh-tauri-ui/client', () => ({ cssr, mountStyle }))

afterEach(() => {
  document.querySelectorAll('style[data-plugin="dsh-tauri-mobile-ui"]').forEach(element => element.remove())
  document.documentElement.removeAttribute('data-dsh-mobile-ui')
  vi.restoreAllMocks()
})

it('owns mobile styles and composer activation until unload, and can reload cleanly', () => {
  const register = registerStyles as unknown as () => () => void
  for (let cycle = 0; cycle < 2; cycle++) {
    const dispose = register()
    const style = document.querySelector('style[cssr-id="dsh-tauri-mobile-ui-styles"]')
    expect(style?.getAttribute('data-plugin')).toBe('dsh-tauri-mobile-ui')
    expect(style?.textContent).toContain(`@media ${MOBILE_MEDIA_QUERIES.join(' and ')}`)
    for (const selector of [
      '[data-dsh-mobile-preferences]',
      '[data-slot="conversation.composer.bar"] [class$="_dock"]',
      '[class$="_composerStack"] > [data-slot="conversation.input.dock"]',
      '[class$="_turnErrorCode"]',
      '[data-slot="conversation.header"] [class$="_header"]',
      '[data-slot="main"] header[class*="_pageHead"]',
      '[data-slot="conversation.view"] [class$="_scroll"]',
      '[class*="_userStack"]',
      '[data-slot="main"] [data-conversation-scroll]',
    ]) {
      expect(style?.textContent).toContain(selector)
    }
    const settingsStyle = document.querySelector('style[cssr-id="dsh-tauri-mobile-ui-settings-styles"]')
    expect(settingsStyle?.getAttribute('data-plugin')).toBe('dsh-tauri-mobile-ui')
    expect(settingsStyle?.textContent).toContain('(max-width: 767px)')
    expect(settingsStyle?.textContent).toContain('[data-dsh-mobile-settings]')
    expect(document.documentElement.hasAttribute('data-dsh-mobile-ui')).toBe(true)
    dispose()
    expect(style?.isConnected).toBe(false)
    expect(settingsStyle?.isConnected).toBe(false)
    expect(document.documentElement.hasAttribute('data-dsh-mobile-ui')).toBe(false)
  }
})

it('keeps desktop shared styles free of mobile overrides', () => {
  const css = desktopStyle.render()
  expect(css).not.toContain('(any-pointer: coarse)')
  expect(css).not.toContain('_turnErrorCode')
  expect(css).toContain('conversation.input.dock')
})
