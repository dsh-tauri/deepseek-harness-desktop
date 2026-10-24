// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { defineStore } from 'valtio-define'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigAutoUpdate } from './auto-update'

const mocks = vi.hoisted(() => ({ setting: {} as any, toast: vi.fn(), distroManaged: false }))
vi.mock('@/store', () => ({
  store: {
    get setting() {
      return mocks.setting
    },
  },
}))
vi.mock('@/utils/toast', () => ({ toast: mocks.toast }))
vi.mock('@/hooks/use-distro-managed', () => ({ useDistroManaged: () => mocks.distroManaged }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.distroManaged = false
})

function setup(initial: boolean, fail = false) {
  const update = vi.fn(async (value: { autoUpdate?: boolean }) => {
    if (fail)
      throw new Error('disk write failed')
    mocks.setting.$patch({ auto_update: value.autoUpdate })
  })
  mocks.setting = defineStore({
    state: () => ({ auto_update: initial }),
    actions: { update },
  })
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  render(<QueryClientProvider client={client}><ConfigAutoUpdate /></QueryClientProvider>)
  return update
}

function autoUpdateSwitch(): HTMLInputElement {
  return screen.getByRole('switch', { name: 'ui.auto_update' }) as HTMLInputElement
}

describe('automatic update setting', () => {
  it('reflects the persisted switch value', () => {
    setup(false)

    expect(autoUpdateSwitch().checked).toBe(false)
  })

  it('turns silent download and exit-time installation off through the backend command', async () => {
    const update = setup(true)

    fireEvent.click(autoUpdateSwitch())

    await waitFor(() => expect(update).toHaveBeenLastCalledWith({ autoUpdate: false }))
    await waitFor(() => expect(autoUpdateSwitch().checked).toBe(false))
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('turns the switch back on without a success toast', async () => {
    const update = setup(false)

    fireEvent.click(autoUpdateSwitch())

    await waitFor(() => expect(update).toHaveBeenLastCalledWith({ autoUpdate: true }))
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('surfaces a failed write as a danger toast and keeps the old value', async () => {
    setup(true, true)

    fireEvent.click(autoUpdateSwitch())

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('messages.auto_update_failed', { variant: 'danger' }))
    expect(autoUpdateSwitch().checked).toBe(true)
  })

  it('disables the switch and explains why when the package manager delivers updates', () => {
    mocks.distroManaged = true
    const update = setup(true)

    expect(autoUpdateSwitch().checked).toBe(false)
    expect(autoUpdateSwitch().disabled).toBe(true)
    expect(screen.getByText('ui.auto_update_distro_hint')).toBeTruthy()
    expect(screen.queryByText('ui.auto_update_hint')).toBeNull()
    fireEvent.click(autoUpdateSwitch())
    expect(update).not.toHaveBeenCalled()
  })
})
