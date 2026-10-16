// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { apply, inject, name } from './index'
import { locale } from './locales'
import { installBridgeConfig, registerBridgeConfig } from './register/bridge'
import { registerMobileKeyboard } from './register/keyboard'
import { registerMobilePreferences } from './register/preferences'
import { registerMobileSettings } from './register/settings'
import { registerMobileSidebar } from './register/sidebar'
import { registerStyles } from './register/styles'

vi.mock('./locales', () => ({
  locale: { registerLocale: vi.fn() },
}))
vi.mock('./register/bridge', () => ({
  installBridgeConfig: vi.fn(() => {
    window.__DSH_BRIDGE_CONFIG__ = { disablePageTweaks: true }
  }),
  registerBridgeConfig: vi.fn(),
}))
vi.mock('./register/keyboard', () => ({ registerMobileKeyboard: vi.fn() }))
vi.mock('./register/preferences', () => ({ registerMobilePreferences: vi.fn() }))
vi.mock('./register/sidebar', () => ({ registerMobileSidebar: vi.fn() }))
vi.mock('./register/settings', () => ({ registerMobileSettings: vi.fn() }))
vi.mock('./register/styles', () => ({ registerStyles: vi.fn() }))

afterEach(() => {
  delete window.__DSH_BRIDGE_CONFIG__
  vi.restoreAllMocks()
})

it('assembles mobile-only effects and yields bridge page tweaks early', () => {
  const effect = vi.fn()
  apply({ effect } as unknown as Parameters<typeof apply>[0])
  expect(name).toBe('dsh-tauri-mobile-ui')
  expect(inject).toEqual(['slots', 'layout', 'locale', 'sessions'])
  expect(installBridgeConfig).toHaveBeenCalledTimes(1)
  expect(window.__DSH_BRIDGE_CONFIG__).toEqual({ disablePageTweaks: true })
  expect(effect.mock.calls).toEqual([
    [registerBridgeConfig, 'dsh-tauri-mobile-ui: bridge'],
    [locale.registerLocale, 'dsh-tauri-mobile-ui: locale'],
    [registerStyles, 'dsh-tauri-mobile-ui: styles'],
    [registerMobileKeyboard, 'dsh-tauri-mobile-ui: keyboard'],
    [registerMobilePreferences, 'dsh-tauri-mobile-ui: preferences'],
    [registerMobileSidebar, 'dsh-tauri-mobile-ui: sidebar'],
    [registerMobileSettings, 'dsh-tauri-mobile-ui: settings'],
  ])
})
