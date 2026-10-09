import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from './index'
import { registerContinueNotice } from './register/continue-notice'
import { registerSettings } from './register/settings'

vi.mock('./components', () => ({}))
vi.mock('./components/panel', () => ({}))
vi.mock('./components/segmented-control', () => ({}))
vi.mock('./hooks/use-mount-style', () => ({}))
vi.mock('./locales', () => ({ locale: { registerLocale: vi.fn() } }))
vi.mock('./register/composer-resume', () => ({ composerResumeFeature: vi.fn() }))
vi.mock('./register/continue-notice', () => ({ registerContinueNotice: vi.fn() }))
vi.mock('./register/hero-workspace', () => ({ heroWorkspaceFeature: vi.fn() }))
vi.mock('./register/im-panel', () => ({ registerImPanel: vi.fn() }))
vi.mock('./register/new-session', () => ({ sidebarNewSessionFeature: vi.fn(), ungroupedNewSessionFeature: vi.fn() }))
vi.mock('./register/obstructions', () => ({ registerSettingsObstructions: vi.fn() }))
vi.mock('./register/sections', () => ({ registerSettingsSections: vi.fn() }))
vi.mock('./register/settings', () => ({ registerSettings: vi.fn() }))
vi.mock('./register/settings-open', () => ({ registerSettingsOpen: vi.fn() }))
vi.mock('./register/styles', () => ({ registerStyles: vi.fn() }))
vi.mock('./utils/style', () => ({}))
vi.mock('./utils/cssr', () => ({}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ui client settings effect registration', () => {
  it.each([true, false])('delegates desktop settings filtering to its register on mobile=%s', (mobile) => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: mobile }) })
    const effect = vi.fn()

    apply({ effect } as unknown as Parameters<typeof apply>[0])

    expect(effect).toHaveBeenCalledWith(registerSettings, 'dsh-tauri-ui: settings panel')
    expect(effect).toHaveBeenCalledTimes(12)
    expect(effect).toHaveBeenCalledWith(registerContinueNotice, 'dsh-tauri-ui: continue notice')
    expect(effect).toHaveBeenCalledWith(expect.any(Function), 'dsh-tauri-ui: styles')
    expect(effect.mock.calls.some(([, name]) => name.includes('mobile'))).toBe(false)
  })
})
