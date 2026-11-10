// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { store } from '@/store'
import { Loadable } from './loadable'

vi.mock('@/store', async () => {
  const { defineStore } = await import('valtio-define')
  return {
    store: {
      harness: defineStore({
        state: () => ({ startupPhase: 'plugin-install' as const, startupReason: '' }),
      }),
    },
  }
})
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/components/panel', () => ({ Panel: { Progress: () => null } }))

beforeEach(() => {
  store.harness.startupPhase = 'plugin-install'
  store.harness.startupReason = ''
})

afterEach(() => {
  cleanup()
})

it('内置插件阶段显示「正在处理 <条目>」而不是固定文案', () => {
  store.harness.startupReason = 'Checking 3 internal plugins. · Working on dsh-tauri'

  const view = render(<Loadable />)

  expect(view.getByText('Checking 3 internal plugins. · Working on dsh-tauri').textContent)
    .toBe('Checking 3 internal plugins. · Working on dsh-tauri')
  expect(view.queryByText('status.loading_plugins')).toBeNull()
})

it('内置插件阶段尚无原因时退回固定文案', () => {
  const view = render(<Loadable />)

  expect(view.getByText('status.loading_plugins').textContent).toBe('status.loading_plugins')
})

it('其它启动阶段不显示插件阶段遗留的原因', () => {
  store.harness.startupPhase = 'process-boot'
  store.harness.startupReason = 'Checking 3 internal plugins. · Working on dsh-tauri'

  const view = render(<Loadable />)

  expect(view.getByText('status.loading_plugins').textContent).toBe('status.loading_plugins')
})

it('显式副标题优先于启动阶段原因', () => {
  store.harness.startupReason = 'Checking 3 internal plugins. · Working on dsh-tauri'

  const view = render(<Loadable subtitle="installing" />)

  expect(view.getByText('installing').textContent).toBe('installing')
})
