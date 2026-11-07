// @vitest-environment jsdom
import type { ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { act } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { startShell } from '../shell'
import { useThemeAdaptive } from './use-theme-adaptive'

const mocks = vi.hoisted(() => ({
  roots: [] as Root[],
  invoke: vi.fn(),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@/utils/logger', () => ({}))
vi.mock('../styles/main.css', () => ({}))
vi.mock('@overlastic/react', () => ({ OverlaysProvider: ({ children }: { children: ReactNode }) => children }))
vi.mock('react-aria', () => ({ UNSAFE_PortalProvider: ({ children }: { children: ReactNode }) => children }))
vi.mock('react-stately/private/flags/flags', () => ({ enableShadowDOM: () => {} }))
vi.mock('@/components/toast-provider', () => ({ ToastProvider: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/layout', () => ({
  App: function App() {
    useThemeAdaptive()
    return null
  },
}))
vi.mock('react-dom/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('react-dom/client')>()
  return {
    ...original,
    createRoot: (...args: Parameters<typeof original.createRoot>) => {
      const root = original.createRoot(...args)
      mocks.roots.push(root)
      return root
    },
  }
})

afterEach(async () => {
  await act(async () => mocks.roots.splice(0).forEach(root => root.unmount()))
  document.querySelectorAll('[data-dsh-shell-host], [data-dsh-shell-drag-neutralizer]').forEach(element => element.remove())
  delete document.documentElement.dataset.theme
  delete (globalThis as { __DSH_SHELL_THEME__?: string }).__DSH_SHELL_THEME__
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

it('keeps native injected light through shell entry and delayed preference hydration on a dark system', async () => {
  ;(globalThis as { __DSH_SHELL_THEME__?: string }).__DSH_SHELL_THEME__ = 'light'
  document.documentElement.dataset.theme = 'light'
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: true }))
  const preference = Promise.withResolvers<'light'>()
  mocks.invoke.mockReturnValue(preference.promise)
  await act(async () => {
    startShell()
    expect(document.documentElement.dataset.theme).toBe('light')
  })
  expect(document.documentElement.dataset.theme).toBe('light')
  expect(document.querySelector('[data-dsh-shell-host]')?.getAttribute('data-theme')).toBe('light')
  expect(mocks.invoke).toHaveBeenCalledWith('get_dsh_theme', undefined, undefined)
  await act(async () => preference.resolve('light'))
  expect(document.documentElement.dataset.theme).toBe('light')
  expect(document.querySelector('[data-dsh-shell-host]')?.getAttribute('data-theme')).toBe('light')
})
