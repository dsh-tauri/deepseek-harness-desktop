// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { store } from '../store'
import { SettingsSidebar } from './settings-sidebar'

const observer = vi.hoisted(() => ({ resize: () => {} }))
vi.mock('dsh-tauri/client', async () => ({
  ...await import('../../../../dsh-tauri/src/client/modules/reause'),
  ...await import('../../../../dsh-tauri/src/client/modules/valtio-define'),
  clamp: (value: number, min: number, max: number) => Math.min(Math.max(value, min), max),
  isEmpty: (values: unknown[]) => values.length === 0,
  cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
  useEventListener: () => {},
  useResizeObserver: (_ref: unknown, callback: () => void) => { observer.resize = callback },
}))
vi.mock('../locales', () => ({ locale: { text: (key: string) => key, useLocale: () => 'en' } }))
vi.mock('../components/official', () => ({ Input: 'input' }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ useModalLayer: undefined }))
vi.mock('@deepseek-ai/dsh-client-ui-renderer', () => ({ SlotOutlet: () => <section>Settings</section> }))

beforeEach(() => {
  store.settings.close()
  store.settings.openAt('general')
  store.sections.setRows([{ id: 'general', label: 'General', order: 0 }])
})

afterEach(() => {
  cleanup()
  store.settings.close()
  store.sections.setRows([])
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

it.each([
  [64, undefined],
  [264, 264],
  [320, 320],
  [500, 420],
])('syncs sidebar width %s on initial open and focuses search', (width, expected) => {
  const sidebar = document.createElement('div')
  sidebar.dataset.slot = 'sidebar'
  document.body.append(sidebar)
  const measure = vi.spyOn(sidebar, 'getBoundingClientRect').mockReturnValue({ width } as DOMRect)
  const focus = vi.spyOn(HTMLInputElement.prototype, 'focus')
  const view = render(<SettingsSidebar useSessions={selector => selector({} as never)} />)

  expect(store.settings.railWidth).toBe(expected)
  expect(measure).toHaveBeenCalledTimes(1)
  expect(focus).toHaveBeenCalledTimes(1)
  expect(document.activeElement).toBe(view.getByRole('textbox', { name: 'search' }))
})

it('syncs width and focuses only when opening, including reopening after close', () => {
  store.settings.close()
  const sidebar = document.createElement('div')
  sidebar.dataset.slot = 'sidebar'
  document.body.append(sidebar)
  const measure = vi.spyOn(sidebar, 'getBoundingClientRect').mockReturnValue({ width: 300 } as DOMRect)
  const focus = vi.spyOn(HTMLInputElement.prototype, 'focus')
  const view = render(<SettingsSidebar useSessions={selector => selector({} as never)} />)
  expect(view.queryByRole('dialog')).toBeNull()
  expect(measure).not.toHaveBeenCalled()
  expect(focus).not.toHaveBeenCalled()
  expect(store.settings.railWidth).toBeUndefined()

  act(() => store.settings.openAt('general'))
  expect(store.settings.railWidth).toBe(300)
  expect(document.activeElement).toBe(view.getByRole('textbox', { name: 'search' }))
  const other = document.createElement('button')
  document.body.append(other)
  other.focus()
  act(() => store.settings.setQuery('gen'))
  view.rerender(<SettingsSidebar useSessions={selector => selector({} as never)} />)
  expect(measure).toHaveBeenCalledTimes(1)
  expect(focus).toHaveBeenCalledTimes(1)
  expect(store.settings.railWidth).toBe(300)
  expect(document.activeElement).toBe(other)

  act(() => store.settings.close())
  expect(view.queryByRole('dialog')).toBeNull()
  expect(measure).toHaveBeenCalledTimes(1)
  expect(focus).toHaveBeenCalledTimes(1)
  expect(store.settings.railWidth).toBeUndefined()
  measure.mockReturnValue({ width: 380 } as DOMRect)
  act(() => store.settings.openAt('general'))
  expect(measure).toHaveBeenCalledTimes(2)
  expect(focus).toHaveBeenCalledTimes(2)
  expect(store.settings.railWidth).toBe(380)
  expect(document.activeElement).toBe(view.getByRole('textbox', { name: 'search' }))
})

it('uses the conversation content width on open and resize, excluding settings padding', () => {
  const dock = document.createElement('div')
  dock.dataset.slot = 'conversation.input.dock'
  dock.style.setProperty('--dsh-chat-content-width', '860px')
  document.body.append(dock)
  const view = render(<SettingsSidebar useSessions={selector => selector({} as never)} />)
  const content = view.container.querySelector<HTMLElement>('[data-slot="settings.content"]')!
  observer.resize()
  expect(content.style.getPropertyValue('--dsh-chat-content-width')).toBe('860px')
  const column = content.firstElementChild as HTMLElement
  expect(column.style.maxWidth).toBe('calc(var(--dsh-chat-content-width, 748px) + 72px)')
  expect(column.classList.contains('w-full')).toBe(true)
  expect(column.classList.contains('px-[36px]')).toBe(true)
  dock.style.setProperty('--dsh-chat-content-width', '700px')
  observer.resize()
  expect(content.style.getPropertyValue('--dsh-chat-content-width')).toBe('700px')
  dock.remove()
  observer.resize()
  expect(content.style.getPropertyValue('--dsh-chat-content-width')).toBe('')
})
