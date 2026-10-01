import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from './index'
import { registerMobilePreferences } from './register/mobile-preferences'
import { registerSettings } from './register/settings'

vi.mock('./components', () => ({}))
vi.mock('./components/panel', () => ({}))
vi.mock('./components/segmented-control', () => ({}))
vi.mock('./hooks/use-mount-style', () => ({}))
vi.mock('./locales', () => ({ locale: { registerLocale: vi.fn() } }))
vi.mock('./register/composer-resume', () => ({ composerResumeFeature: vi.fn() }))
vi.mock('./register/hero-workspace', () => ({ heroWorkspaceFeature: vi.fn() }))
vi.mock('./register/im-panel', () => ({ registerImPanel: vi.fn() }))
vi.mock('./register/mobile-preferences', () => ({ registerMobilePreferences: vi.fn() }))
vi.mock('./register/new-session', () => ({ sidebarNewSessionFeature: vi.fn(), ungroupedNewSessionFeature: vi.fn() }))
vi.mock('./register/obstructions', () => ({ registerSettingsObstructions: vi.fn() }))
vi.mock('./register/sections', () => ({ registerSettingsSections: vi.fn() }))
vi.mock('./register/settings', () => ({ registerSettings: vi.fn() }))
vi.mock('./register/settings-open', () => ({ registerSettingsOpen: vi.fn() }))
vi.mock('./register/styles', () => ({ registerStyles: vi.fn() }))
vi.mock('./utils/style', () => ({}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ui client settings effect registration', () => {
  it('does not register the settings effect on mobile', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) })
    const effect = vi.fn()

    apply({ effect } as unknown as Parameters<typeof apply>[0])

    expect(effect).not.toHaveBeenCalledWith(registerSettings, 'dsh-tauri-ui: settings panel')
    expect(effect).toHaveBeenCalledWith(registerMobilePreferences, 'dsh-tauri-ui: mobile preferences')
    expect(effect).toHaveBeenCalledTimes(11)
    expect(effect).toHaveBeenCalledWith(expect.any(Function), 'dsh-tauri-ui: styles')
  })

  it.each([
    ['mouse desktop', false, false, false],
    ['touchscreen laptop', false, true, false],
    ['tablet with a mouse', true, true, false],
  ])('registers the settings effect on %s', (_, hoverNone, coarsePointer, anyHoverNone) => {
    const answers: Record<string, boolean> = {
      '(hover: none)': hoverNone as boolean,
      '(any-pointer: coarse)': coarsePointer as boolean,
      '(any-hover: none)': anyHoverNone as boolean,
    }
    vi.stubGlobal('window', { matchMedia: (query: string) => ({ matches: answers[query] }) })
    const effect = vi.fn()

    apply({ effect } as unknown as Parameters<typeof apply>[0])

    expect(effect).toHaveBeenCalledWith(registerSettings, 'dsh-tauri-ui: settings panel')
    expect(effect).not.toHaveBeenCalledWith(registerMobilePreferences, 'dsh-tauri-ui: mobile preferences')
    expect(effect).toHaveBeenCalledTimes(11)
  })

  it('registers the settings effect without matchMedia', () => {
    vi.stubGlobal('window', {})
    const effect = vi.fn()

    apply({ effect } as unknown as Parameters<typeof apply>[0])

    expect(effect).toHaveBeenCalledWith(registerSettings, 'dsh-tauri-ui: settings panel')
    expect(effect).not.toHaveBeenCalledWith(registerMobilePreferences, 'dsh-tauri-ui: mobile preferences')
  })
})
