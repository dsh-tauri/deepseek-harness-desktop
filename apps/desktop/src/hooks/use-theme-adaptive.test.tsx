// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useDshStyle } from './use-dsh-style'
import { resolveTheme, useThemeAdaptive } from './use-theme-adaptive'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

const env = globalThis as { __DSH_SHELL_THEME__?: string }
let media: MediaQueryList
let resolvePreference: (preference: 'dark' | 'light' | 'system') => void

beforeEach(() => {
  media = Object.assign(new EventTarget(), {
    matches: true,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }) as MediaQueryList
  vi.stubGlobal('matchMedia', vi.fn(() => media))
  mocks.invoke.mockImplementation(() => new Promise((resolve) => {
    resolvePreference = resolve
  }))
})

afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.theme
  delete env.__DSH_SHELL_THEME__
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

it.each([
  ['dark', false, 'dark'],
  ['light', true, 'light'],
  ['system', false, 'light'],
  ['system', true, 'dark'],
  [null, false, 'light'],
  [undefined, true, 'dark'],
] as const)('resolves %s with system dark=%s to %s', (preference, systemDark, theme) => {
  expect(resolveTheme(preference, systemDark)).toBe(theme)
})

function setSystemDark(dark: boolean) {
  Object.assign(media, { matches: dark })
  act(() => media.dispatchEvent(Object.assign(new Event('change'), { matches: dark })))
}

it('follows system changes after the preference resolves to system', async () => {
  env.__DSH_SHELL_THEME__ = 'light'
  renderHook(() => useThemeAdaptive())
  expect(document.documentElement.dataset.theme).toBe('light')
  await act(async () => resolvePreference('system'))
  expect(document.documentElement.dataset.theme).toBe('dark')
  setSystemDark(false)
  expect(document.documentElement.dataset.theme).toBe('light')
  setSystemDark(true)
  expect(document.documentElement.dataset.theme).toBe('dark')
})

it('keeps an explicit light preference when the system appearance changes', async () => {
  renderHook(() => useThemeAdaptive())
  await act(async () => resolvePreference('light'))
  setSystemDark(false)
  setSystemDark(true)
  expect(document.documentElement.dataset.theme).toBe('light')
})

it('gives the embedded color scheme precedence before and after preference hydration', async () => {
  env.__DSH_SHELL_THEME__ = 'light'
  const hook = renderHook(() => {
    useThemeAdaptive()
    return useDshStyle()
  })
  act(() => hook.result.current[1]({ colorScheme: 'dark' }))
  expect(document.documentElement.dataset.theme).toBe('dark')
  await act(async () => resolvePreference('light'))
  expect(document.documentElement.dataset.theme).toBe('dark')
  act(() => hook.result.current[1]({ colorScheme: 'light' }))
  expect(document.documentElement.dataset.theme).toBe('light')
  act(() => hook.result.current[1]({}))
  expect(document.documentElement.dataset.theme).toBe('light')
})

it('uses the current system appearance while preference loading has no injected theme', () => {
  renderHook(() => useThemeAdaptive())
  expect(document.documentElement.dataset.theme).toBe('dark')
})

it('preserves injected light while the saved preference loads under a dark system', async () => {
  env.__DSH_SHELL_THEME__ = 'light'
  document.documentElement.dataset.theme = 'light'
  renderHook(() => useThemeAdaptive())
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('get_dsh_theme', undefined, undefined)
  expect(document.documentElement.dataset.theme).toBe('light')
  await act(async () => resolvePreference('light'))
  expect(document.documentElement.dataset.theme).toBe('light')
})
