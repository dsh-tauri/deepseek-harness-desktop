// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { apply, inject, name } from './index'
import { locale } from './locales'
import { registerMobileKeyboard } from './register/keyboard'
import { registerMobilePreferences } from './register/preferences'
import { registerMobileSettings } from './register/settings'
import { registerMobileSidebar } from './register/sidebar'
import { registerStyles } from './register/styles'

vi.mock('./locales', () => ({
  locale: { registerLocale: vi.fn() },
}))
vi.mock('./register/keyboard', () => ({ registerMobileKeyboard: vi.fn() }))
vi.mock('./register/preferences', () => ({ registerMobilePreferences: vi.fn() }))
vi.mock('./register/sidebar', () => ({ registerMobileSidebar: vi.fn() }))
vi.mock('./register/settings', () => ({ registerMobileSettings: vi.fn() }))
vi.mock('./register/styles', () => ({ registerStyles: vi.fn() }))

afterEach(() => {
  vi.restoreAllMocks()
})

it('assembles mobile-only effects', () => {
  const effect = vi.fn()
  apply({ effect } as unknown as Parameters<typeof apply>[0])
  expect(name).toBe('dsh-tauri-mobile-ui')
  expect(inject).toEqual(['slots', 'layout', 'locale', 'sessions'])
  expect(effect.mock.calls).toEqual([
    [locale.registerLocale, 'dsh-tauri-mobile-ui: locale'],
    [registerStyles, 'dsh-tauri-mobile-ui: styles'],
    [registerMobileKeyboard, 'dsh-tauri-mobile-ui: keyboard'],
    [registerMobilePreferences, 'dsh-tauri-mobile-ui: preferences'],
    [registerMobileSidebar, 'dsh-tauri-mobile-ui: sidebar'],
    [registerMobileSettings, 'dsh-tauri-mobile-ui: settings'],
  ])
})
