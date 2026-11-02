// @vitest-environment jsdom
import type { SettingsLauncherOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ComponentType } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { registerMobilePreferences } from '../packages/builtin-plugin-mobile-ui/src/client/register/preferences'

const disposers: (() => void)[] = []

afterEach(() => {
  cleanup()
  for (const dispose of disposers.splice(0)) dispose()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function source<T>(initial: T) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(value: T) {
      snapshot = value
      for (const listener of listeners) listener()
    },
    listeners,
  }
}

function client({ mobile = true, hydrated = true } = {}) {
  vi.stubGlobal('matchMedia', (media: string) => ({ media, matches: mobile }))
  const host = { transcriptView: 'detailed' }
  const setTranscriptView = vi.fn((value: string) => {
    host.transcriptView = value
  })
  const form = source({ status: hydrated ? 'ready' : 'loading' })
  const rows = source(hydrated)
  const theme = source({ active: { colorScheme: 'light' } })
  const locale = source({ active: 'en', locales: [{ id: 'en', label: 'English' }, { id: 'zh', label: '中文' }] })
  const launchers = new Map<string, ComponentType<SettingsLauncherOwnerProps>>()
  const context = {
    configForms: { get: () => form },
    theme: {
      getTheme: theme.getSnapshot,
      setTheme: (id: string) => theme.set({ active: { colorScheme: id } }),
    },
    locale: {
      ...locale,
      bind: (namespace: string) => (key: string) => `${namespace}.${key}`,
      setLocale: (id: string) => locale.set({ ...locale.getSnapshot(), active: id }),
    },
    on: (_event: string, listener: () => void) => theme.subscribe(listener),
    slots: {
      entriesOfSlot: () => rows.getSnapshot() ? [{ options: { id: 'transcript-view' }, inject: () => ({ setTranscriptView }) }] : [],
      subscribe: (_name: string, listener: () => void) => rows.subscribe(listener),
      inject: (_name: string, setup: () => () => void) => setup(),
      register(options: { name: string }, component: ComponentType<SettingsLauncherOwnerProps>) {
        launchers.set(options.name, component)
        return () => {
          launchers.delete(options.name)
        }
      },
    },
    inject: vi.fn((dependencies: string[], setup: (ctx: unknown) => () => void) => {
      const dispose = dependencies.every(name => context[name as keyof typeof context] !== undefined)
        ? setup(context)
        : () => {}
      return { dispose }
    }),
  }
  function mount() {
    const dispose = registerMobilePreferences.call(context)
    disposers.push(dispose)
    return dispose
  }
  function hydrate() {
    form.set({ status: 'ready' })
    rows.set(true)
  }
  return { context, host, setTranscriptView, form, rows, theme, locale, launchers, mount, hydrate }
}

it.each([true, false])('preserves the shared desktop transcript preference across mobile visits (hydrated: %s)', (hydrated) => {
  vi.useFakeTimers()
  const fixture = client({ hydrated })
  const dispose = fixture.mount()
  vi.runAllTimers()
  expect(fixture.host.transcriptView).toBe('detailed')
  fixture.hydrate()
  vi.runAllTimers()
  expect(fixture.host.transcriptView).toBe('detailed')
  expect(fixture.setTranscriptView).not.toHaveBeenCalled()

  dispose()
  fixture.mount()
  vi.runAllTimers()
  expect(fixture.host.transcriptView).toBe('detailed')
  expect(fixture.setTranscriptView).not.toHaveBeenCalled()
})

it('keeps mobile launcher controls functional until they are disposed', () => {
  const fixture = client()
  const dispose = fixture.mount()
  expect([...fixture.launchers.keys()]).toEqual(['settings.launcher'])
  const Launcher = fixture.launchers.get('settings.launcher')!
  const openSettings = vi.fn()
  const props = { openSettings, openOnboarding: vi.fn(), wide: false }
  const view = render(<Launcher {...props} settingsOpen={false} />)

  fireEvent.click(screen.getByRole('button', { name: 'settings.theme.appearance.title' }))
  fireEvent.click(screen.getByText('settings.theme.appearance.dark'))
  expect(fixture.theme.getSnapshot().active.colorScheme).toBe('dark')
  expect(screen.getByRole('button', { name: 'settings.theme.appearance.title' }).textContent).toContain('settings.theme.appearance.dark')

  fireEvent.click(screen.getByRole('button', { name: 'settings.locale.language.title' }))
  fireEvent.click(screen.getByText('中文'))
  expect(fixture.locale.getSnapshot().active).toBe('zh')
  expect(screen.getByRole('button', { name: 'settings.locale.language.title' }).textContent).toContain('中文')

  fireEvent.click(screen.getByRole('button', { name: 'settings.trigger' }))
  expect(openSettings).toHaveBeenCalledOnce()
  view.rerender(<Launcher {...props} settingsOpen />)
  expect(screen.getByRole('button', { name: 'settings.trigger' }).getAttribute('aria-expanded')).toBe('true')

  view.unmount()
  dispose()
  expect(fixture.launchers.size).toBe(0)
  expect(fixture.theme.listeners.size).toBe(0)
  expect(fixture.locale.listeners.size).toBe(0)
  expect(fixture.form.listeners.size).toBe(0)
  expect(fixture.rows.listeners.size).toBe(0)
})

it('leaves the desktop launcher and shared transcript preference untouched', () => {
  vi.useFakeTimers()
  const fixture = client({ mobile: false })
  fixture.mount()
  vi.runAllTimers()
  expect(fixture.context.inject).not.toHaveBeenCalled()
  expect(fixture.launchers.size).toBe(0)
  expect(fixture.host.transcriptView).toBe('detailed')
  expect(fixture.setTranscriptView).not.toHaveBeenCalled()
})
