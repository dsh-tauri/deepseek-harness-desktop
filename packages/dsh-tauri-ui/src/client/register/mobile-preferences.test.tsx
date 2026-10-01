// @vitest-environment jsdom
import type { ComponentType } from 'react'
import type { SelectProps } from '../components/select'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerMobilePreferences } from './mobile-preferences'

vi.mock('dsh-tauri/client', () => ({
  defineRegister: (setup: (controller: unknown, ctx: unknown) => void) => function (this: unknown) {
    const disposers: Array<() => void> = []
    setup({ add: (dispose: () => void) => disposers.push(dispose) }, this)
    return () => disposers.reverse().forEach(dispose => dispose())
  },
}))
vi.mock('../components/select', () => ({
  Select: ({ label, value, options, onChange }: SelectProps) => (
    <select aria-label={label} value={value} onChange={event => onChange(event.target.value)}>
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  ),
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function setup(mobile: boolean) {
  vi.stubGlobal('matchMedia', () => ({ matches: mobile }))
  let Component: ComponentType | undefined
  let theme = { active: { colorScheme: 'light' } }
  let locale = { active: 'en', locales: [{ id: 'en', label: 'English' }, { id: 'zh', label: '简体中文' }] }
  const themeListeners = new Set<() => void>()
  const localeListeners = new Set<() => void>()
  const registered = vi.fn()
  const disposeSlot = vi.fn()
  const ctx = {
    inject: vi.fn((_services: string[], callback: (scoped: unknown) => () => void) => ({ dispose: callback(ctx) })),
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
    slots: {
      inject: vi.fn((_slot: string, activate: () => () => void) => activate()),
      register: (options: unknown, component: ComponentType) => {
        registered(options)
        Component = component
        return disposeSlot
      },
    },
  }
  const dispose = (registerMobilePreferences as unknown as (this: unknown) => () => void).call(ctx)
  return { ctx, Component, dispose, disposeSlot, registered, themeListeners, localeListeners }
}

describe('mobile sidebar preferences', () => {
  it('does not replace the desktop settings seat', () => {
    const { ctx, registered } = setup(false)
    expect(ctx.inject).not.toHaveBeenCalled()
    expect(registered).not.toHaveBeenCalled()
  })

  it('replaces only the mobile settings seat, writes through core services and tracks external changes', () => {
    const { ctx, Component, registered, dispose, disposeSlot, themeListeners, localeListeners } = setup(true)
    expect(registered).toHaveBeenCalledWith({ name: 'sidebar.settings', priority: -1, registrant: 'dsh-tauri-ui' })
    expect(ctx.slots.inject).toHaveBeenCalledTimes(1)
    expect(Component).toBeTypeOf('function')
    if (!Component)
      throw new Error('Mobile preferences component was not registered')
    const view = render(<Component />)
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
})
