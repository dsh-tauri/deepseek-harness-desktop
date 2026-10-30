// @vitest-environment jsdom
import type { ConfigFormSnapshot, SettingsLauncherOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ButtonProps, SelectProps } from 'dsh-tauri-ui/client'
import type { ComponentType } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectMobileDevice } from '../../../../builtin-plugin-tauri/src/client/utils/device'
import { registerMobilePreferences } from './preferences'

vi.mock('dsh-tauri/client', () => ({
  detectMobileDevice,
  defineRegister: (setup: (controller: unknown, ctx: unknown) => void) => function (this: unknown) {
    const disposers: Array<() => void> = []
    setup({
      add: (dispose: () => void) => disposers.push(dispose),
      timeout: (callback: () => void, ms: number) => {
        const timer = setTimeout(callback, ms)
        const cancel = () => clearTimeout(timer)
        disposers.push(cancel)
        return cancel
      },
    }, this)
    return () => disposers.splice(0).reverse().forEach(dispose => dispose())
  },
}))
vi.mock('dsh-tauri-ui/client', () => ({
  Select: ({ label, value, options, onChange }: SelectProps) => (
    <select aria-label={label} value={value} onChange={event => onChange(event.target.value)}>
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  ),
  Gear: () => <svg />,
  Button: ({ icon, children, ...props }: ButtonProps) => (
    <button {...props}>
      {icon}
      {children}
    </button>
  ),
}))

const effectDisposers: Array<() => void> = []

afterEach(() => {
  cleanup()
  effectDisposers.splice(0).reverse().forEach(dispose => dispose())
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function setup(mobile: boolean, status: ConfigFormSnapshot<unknown>['status'] = 'unavailable', rowAvailable = true) {
  vi.useFakeTimers()
  vi.stubGlobal('matchMedia', () => ({ matches: mobile }))
  let Component: ComponentType<SettingsLauncherOwnerProps> | undefined
  let theme = { active: { colorScheme: 'light' } }
  let locale = { active: 'en', locales: [{ id: 'en', label: 'English' }, { id: 'zh', label: '简体中文' }] }
  let mode = 'detailed'
  let formSnapshot = { status, value: status === 'ready' ? { transcriptView: 'detailed' } : undefined }
  const themeListeners = new Set<() => void>()
  const localeListeners = new Set<() => void>()
  const formListeners = new Set<() => void>()
  const slotListeners = new Set<() => void>()
  const registered = vi.fn()
  const disposeSlot = vi.fn()
  const setTranscriptView = vi.fn((next: string) => {
    mode = next
  })
  const row = { options: { id: 'transcript-view' }, inject: () => ({ setTranscriptView }) }
  let entries: typeof row[] = rowAvailable ? [row] : []
  const form = {
    getSnapshot: () => formSnapshot,
    subscribe: (listener: () => void) => {
      formListeners.add(listener)
      return () => formListeners.delete(listener)
    },
    set: vi.fn(() => Promise.resolve(false)),
  }
  let activateScope: (() => void) | undefined
  let disposeScope: (() => void) | undefined
  const ctx = {
    inject: vi.fn((_services: string[], callback: (scoped: unknown) => () => void) => {
      activateScope = () => {
        disposeScope = callback(ctx)
      }
      activateScope()
      return { dispose: () => disposeScope?.() }
    }),
    on: (_event: string, listener: () => void) => {
      themeListeners.add(listener)
      return () => themeListeners.delete(listener)
    },
    theme: {
      getTheme: () => theme,
      setTheme: vi.fn((id: string) => {
        theme = { active: { colorScheme: id } }
        themeListeners.forEach(listener => listener())
      }),
    },
    locale: {
      getSnapshot: () => locale,
      subscribe: (listener: () => void) => {
        localeListeners.add(listener)
        return () => localeListeners.delete(listener)
      },
      bind: () => (key: string) => `${locale.active}:${key}`,
      setLocale: vi.fn((id: string) => {
        locale = { ...locale, active: id }
        localeListeners.forEach(listener => listener())
      }),
    },
    configForms: { get: vi.fn(() => form) },
    slots: {
      inject: vi.fn((_slot: string, activate: () => () => void) => activate()),
      register: (options: unknown, component: ComponentType<SettingsLauncherOwnerProps>) => {
        registered(options)
        Component = component
        return disposeSlot
      },
      entriesOfSlot: vi.fn(() => entries),
      subscribe: vi.fn((_slot: string, listener: () => void) => {
        slotListeners.add(listener)
        return () => slotListeners.delete(listener)
      }),
    },
  }
  const dispose = registerMobilePreferences.call(ctx)
  effectDisposers.push(dispose)
  vi.runAllTimers()
  return {
    ctx,
    Component,
    dispose,
    disposeSlot,
    registered,
    themeListeners,
    localeListeners,
    formListeners,
    slotListeners,
    setTranscriptView,
    reactivate: () => {
      disposeScope?.()
      activateScope?.()
      vi.runAllTimers()
    },
    mode: () => mode,
    form,
    queueRow: () => {
      entries = [row]
      slotListeners.forEach(listener => listener())
    },
    deactivate: () => disposeScope?.(),
    hydrate: () => {
      mode = 'detailed'
      formSnapshot = { status: 'ready', value: { transcriptView: 'detailed' } }
      formListeners.forEach(listener => listener())
      vi.runAllTimers()
    },
    registerRow: () => {
      entries = [row]
      slotListeners.forEach(listener => listener())
      vi.runAllTimers()
    },
    notify: () => {
      formListeners.forEach(listener => listener())
      slotListeners.forEach(listener => listener())
      vi.runAllTimers()
    },
  }
}

function launcherProps(): SettingsLauncherOwnerProps {
  return { wide: true, settingsOpen: false, openSettings: vi.fn(), openOnboarding: vi.fn() }
}

describe('mobile sidebar preferences', () => {
  it('does not replace the desktop settings seat or transcript choice', () => {
    const { ctx, registered, setTranscriptView } = setup(false)
    expect(ctx.inject).not.toHaveBeenCalled()
    expect(registered).not.toHaveBeenCalled()
    expect(setTranscriptView).not.toHaveBeenCalled()
  })

  it('uses the native launcher without replacing the settings shell and tracks core preferences', () => {
    const { ctx, Component, registered, dispose, disposeSlot, themeListeners, localeListeners } = setup(true)
    expect(registered).toHaveBeenCalledWith({ name: 'settings.launcher', priority: -1, registrant: 'dsh-tauri-mobile-ui' })
    expect(ctx.slots.inject).toHaveBeenCalledWith('settings.launcher', expect.any(Function))
    if (!Component)
      throw new Error('Mobile preferences component was not registered')
    const view = render(<Component {...launcherProps()} />)
    expect(screen.getAllByRole('combobox')).toHaveLength(2)
    fireEvent.change(screen.getByLabelText('en:appearance.title'), { target: { value: 'dark' } })
    expect(ctx.theme.setTheme).toHaveBeenCalledWith('dark')
    expect((screen.getByLabelText('en:appearance.title') as HTMLSelectElement).value).toBe('dark')
    fireEvent.change(screen.getByLabelText('en:language.title'), { target: { value: 'zh' } })
    expect(ctx.locale.setLocale).toHaveBeenCalledWith('zh')
    expect((screen.getByLabelText('zh:language.title') as HTMLSelectElement).value).toBe('zh')
    act(() => ctx.theme.setTheme('light'))
    expect((screen.getByLabelText('zh:appearance.title') as HTMLSelectElement).value).toBe('light')
    view.unmount()
    expect(themeListeners.size).toBe(0)
    expect(localeListeners.size).toBe(0)
    dispose()
    expect(disposeSlot).toHaveBeenCalledOnce()
  })

  it('opens native settings from the rightmost accessible icon and reflects dialog state', () => {
    const { Component, ctx } = setup(true)
    if (!Component)
      throw new Error('Mobile preferences component was not registered')
    const props = launcherProps()
    const view = render(<Component {...props} />)
    const settings = screen.getByRole('button', { name: 'en:trigger' })
    expect(settings).toBe(settings.parentElement?.lastElementChild)
    expect(settings.parentElement?.hasAttribute('data-dsh-mobile-preferences')).toBe(true)
    expect(settings.querySelector('svg')).not.toBeNull()
    expect(settings.textContent).toBe('')
    expect(settings.getAttribute('aria-haspopup')).toBe('dialog')
    expect(settings.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(settings)
    expect(props.openSettings).toHaveBeenCalledOnce()
    view.rerender(<Component {...props} settingsOpen />)
    expect(settings.getAttribute('aria-expanded')).toBe('true')
    act(() => ctx.locale.setLocale('zh'))
    expect(screen.getByRole('button', { name: 'zh:trigger' })).toBe(settings)
  })

  it('selects Standard through the native setter on a process-local mobile client', () => {
    const { ctx, mode, form, setTranscriptView } = setup(true)
    expect(ctx.configForms.get).toHaveBeenCalledWith('ui-chat')
    expect(mode()).toBe('standard')
    expect(setTranscriptView).toHaveBeenCalledExactlyOnceWith('standard')
    expect(form.set).not.toHaveBeenCalled()
  })

  it('waits for hydration, applies Standard once, and does not lock subsequent user choices', () => {
    const { hydrate, notify, mode, setTranscriptView } = setup(true, 'loading')
    expect(mode()).toBe('detailed')
    expect(setTranscriptView).not.toHaveBeenCalled()
    hydrate()
    expect(mode()).toBe('standard')
    expect(setTranscriptView).toHaveBeenCalledExactlyOnceWith('standard')
    setTranscriptView('verbose')
    notify()
    expect(mode()).toBe('verbose')
    expect(setTranscriptView).toHaveBeenCalledTimes(2)
  })

  it('preserves a later choice across injected service reactivation', () => {
    const { reactivate, mode, setTranscriptView } = setup(true)
    setTranscriptView('verbose')
    reactivate()
    expect(mode()).toBe('verbose')
    expect(setTranscriptView).toHaveBeenCalledTimes(2)
  })

  it('handles the native transcript row becoming available after hydration', () => {
    const { hydrate, registerRow, mode, setTranscriptView } = setup(true, 'loading', false)
    hydrate()
    expect(setTranscriptView).not.toHaveBeenCalled()
    registerRow()
    expect(mode()).toBe('standard')
    expect(setTranscriptView).toHaveBeenCalledExactlyOnceWith('standard')
  })

  it('cancels a queued selection when injected services disappear', () => {
    const { queueRow, deactivate, reactivate, formListeners, slotListeners, setTranscriptView } = setup(true, 'ready', false)
    queueRow()
    expect(vi.getTimerCount()).toBe(1)
    deactivate()
    expect(vi.getTimerCount()).toBe(0)
    expect(formListeners.size).toBe(0)
    expect(slotListeners.size).toBe(0)
    vi.runAllTimers()
    expect(setTranscriptView).not.toHaveBeenCalled()
    reactivate()
    expect(setTranscriptView).toHaveBeenCalledExactlyOnceWith('standard')
  })

  it('unsubscribes on unload and cannot select a mode when the native row arrives afterwards', () => {
    const { dispose, hydrate, registerRow, formListeners, slotListeners, setTranscriptView, disposeSlot } = setup(true, 'loading', false)
    expect(formListeners.size).toBe(1)
    expect(slotListeners.size).toBe(1)
    dispose()
    expect(formListeners.size).toBe(0)
    expect(slotListeners.size).toBe(0)
    expect(disposeSlot).toHaveBeenCalledOnce()
    hydrate()
    registerRow()
    expect(setTranscriptView).not.toHaveBeenCalled()
  })
})
