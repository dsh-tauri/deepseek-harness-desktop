// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { defineStore } from 'valtio-define'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APPEARANCE_DEFAULTS } from '../../../packages/dsh-tauri/src/shared/appearance'
import { ConfigAppearance } from './appearance'

const mocks = vi.hoisted(() => ({ setting: {} as any, toast: vi.fn() }))
vi.mock('@/store', () => ({ store: { get setting() {
  return mocks.setting
} } }))
vi.mock('@/utils/toast', () => ({ toast: mocks.toast }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

afterEach(() => {
  cleanup()
  delete (window as any).__DSH_TRANSPARENT__
  vi.clearAllMocks()
})

function setup(fail = false, opacity = 70) {
  const update = vi.fn(async (value) => {
    if (fail)
      throw new Error('disk write failed')
    mocks.setting.$patch(value)
  })
  mocks.setting = defineStore({
    state: () => ({ appearance: { palette: 'nord', terminal: false, opacity }, zoom_factor: 1 }),
    actions: { update },
  })
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  render(<QueryClientProvider client={client}><ConfigAppearance /></QueryClientProvider>)
  return update
}

describe('appearance settings controls', () => {
  it('keeps native transparency enabled at 100% without requesting a restart', async () => {
    ;(window as any).__DSH_TRANSPARENT__ = true
    const update = setup()
    const slider = screen.getByRole('slider', { name: 'appearance.opacity' })
    fireEvent.keyDown(slider, { key: 'End' })
    fireEvent.keyUp(slider, { key: 'End' })
    await waitFor(() => expect(update).toHaveBeenLastCalledWith({ appearance: expect.objectContaining({ transparency: true, opacity: 100 }) }))
    await waitFor(() => expect(screen.queryByTestId('dsh-appearance-restart')).toBeNull())
    expect((screen.getByRole('switch', { name: 'appearance.transparency' }) as HTMLInputElement).checked).toBe(true)
  })

  it('hides opacity controls when native transparency is switched off and remembers the opacity', async () => {
    const update = setup()
    fireEvent.click(screen.getByRole('switch', { name: 'appearance.transparency' }))
    await waitFor(() => expect(update).toHaveBeenLastCalledWith({ appearance: expect.objectContaining({ transparency: false, opacity: 70 }) }))
    await waitFor(() => expect(screen.queryByRole('slider')).toBeNull())
    expect(screen.queryByRole('switch', { name: 'appearance.sidebar_only' })).toBeNull()
  })

  it('applies the transparent-mode defaults when native transparency is switched on', async () => {
    const update = setup()
    const toggle = screen.getByRole('switch', { name: 'appearance.transparency' })
    fireEvent.click(toggle)
    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(false))
    fireEvent.click(toggle)
    await waitFor(() => expect(update).toHaveBeenLastCalledWith({ appearance: expect.objectContaining({ transparency: true, opacity: 80, blur: true, sidebarOnly: true }) }))
    await waitFor(() => expect((screen.getByRole('switch', { name: 'appearance.sidebar_only' }) as HTMLInputElement).checked).toBe(true))
  })

  it('restores the saved slider value when persistence fails', async () => {
    setup(true)
    const slider = screen.getByRole('slider', { name: 'appearance.opacity' })
    fireEvent.keyDown(slider, { key: 'End' })
    fireEvent.keyUp(slider, { key: 'End' })
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('appearance.save_failed', { variant: 'danger' }))
    expect((slider as HTMLInputElement).value).toBe('70')
  })

  it.each([21, 78, 99])('displays saved opacity %i even when it is between preset steps', async (opacity) => {
    setup(false, opacity)
    await waitFor(() => expect(screen.getByTestId('dsh-appearance-opacity').textContent).toContain(`${opacity}%`))
  })

  it('persists the opaque session option', async () => {
    const update = setup()
    fireEvent.click(screen.getByRole('switch', { name: 'appearance.sidebar_only' }))
    await waitFor(() => expect(update).toHaveBeenLastCalledWith({ appearance: expect.objectContaining({ sidebarOnly: true }) }))
    await waitFor(() => expect((screen.getByRole('switch', { name: 'appearance.sidebar_only' }) as HTMLInputElement).checked).toBe(true))
  })

  it('persists blur in the same native appearance setting', async () => {
    const update = setup()
    fireEvent.click(screen.getByRole('switch', { name: 'appearance.blur' }))
    await waitFor(() => expect(update).toHaveBeenLastCalledWith({ appearance: expect.objectContaining({ blur: true }) }))
  })

  it('exposes the existing device-local zoom in Appearance', async () => {
    const update = setup()
    const select = screen.getByTestId('dsh-appearance-zoom').closest('[data-slot="select"]')!.querySelector('select')!
    fireEvent.change(select, { target: { value: '1.2' } })
    await waitFor(() => expect(update).toHaveBeenLastCalledWith({ zoomFactor: 1.2 }))
    expect(screen.getByText('appearance.zoom_description')).toBeTruthy()
  })

  it('provides an operable terminal switch and resets all preferences', async () => {
    const update = setup()
    const toggle = screen.getByRole('switch', { name: 'appearance.terminal' })
    fireEvent.click(toggle)
    await waitFor(() => expect(update).toHaveBeenCalledWith({ appearance: { palette: 'nord', terminal: true, transparency: true, opacity: 70, blur: false, sidebarOnly: false } }))
    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(true))
    expect(screen.getByTestId('dsh-appearance-restart').textContent).toBe('appearance.restart')
    const reset = screen.getByRole('button', { name: 'appearance.reset' }) as HTMLButtonElement
    await waitFor(() => expect(reset.disabled).toBe(false))
    fireEvent.click(reset)
    await waitFor(() => expect(update).toHaveBeenLastCalledWith({ appearance: APPEARANCE_DEFAULTS, zoomFactor: 1 }))
    await waitFor(() => expect(screen.queryByTestId('dsh-appearance-restart')).toBeNull())
    expect((toggle as HTMLInputElement).checked).toBe(false)
  })

  it('reports a failed save and keeps the previously saved preference', async () => {
    setup(true)
    const toggle = screen.getByRole('switch', { name: 'appearance.terminal' })
    fireEvent.click(toggle)
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('appearance.save_failed', { variant: 'danger' }))
    expect((toggle as HTMLInputElement).checked).toBe(false)
    expect(mocks.setting.appearance.terminal).toBe(false)
  })
})
