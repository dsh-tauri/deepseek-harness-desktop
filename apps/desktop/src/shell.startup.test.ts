// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { startShell } from './shell'

const boundary = vi.hoisted(() => ({ createRoot: vi.fn(), render: vi.fn() }))
vi.mock('react-dom/client', () => ({ createRoot: boundary.createRoot }))
vi.mock('@/layout', () => ({ App: () => null }))
vi.mock('@/config/client', () => ({ queryClient: {} }))
vi.mock('@/components/toast-provider', () => ({ ToastProvider: () => null }))
vi.mock('@/utils/logger', () => ({}))
vi.mock('@/hooks/use-theme-adaptive', () => ({ getInitialTheme: () => 'light' }))

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  document.querySelector('[data-dsh-shell-host]')?.remove()
})

it('defers the real shell entry until the document root exists', () => {
  boundary.createRoot.mockReturnValue({ render: boundary.render })
  const root = document.documentElement
  document.removeChild(root)
  try {
    expect(() => startShell()).not.toThrow()
    expect(boundary.createRoot).not.toHaveBeenCalled()
  }
  finally {
    document.appendChild(root)
  }
  document.dispatchEvent(new Event('DOMContentLoaded'))
  expect(root.dataset.theme).toBe('light')
  expect(document.body.querySelector('[data-dsh-shell-host]')).not.toBeNull()
  expect(document.querySelector('[data-dsh-shell-host]')?.shadowRoot?.getElementById('dsh-shell-root')).not.toBeNull()
  expect(boundary.createRoot).toHaveBeenCalledTimes(1)
  expect(boundary.render).toHaveBeenCalledTimes(1)
})
