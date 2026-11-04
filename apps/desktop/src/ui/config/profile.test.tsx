// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigProfile } from './profile'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@/utils/toast', () => ({ toast: mocks.toast }))
vi.mock('@/store', () => ({ store: { harness: { switchProfile: vi.fn(), restart: vi.fn() } } }))
vi.mock('@/store/modules/harness', () => ({ waitForHarnessStopped: vi.fn() }))
vi.mock('@/hooks/use-invalidate-on-setting-updated', () => ({ useInvalidateOnSettingUpdated: () => {} }))
vi.mock('@/ui/config/backup', () => ({ ConfigBackup: () => null }))
vi.mock('@/ui/dialog/profile-migrate', () => ({ ProfileMigrateDialog: () => null }))
vi.mock('@/components/modal', () => ({ Modal: () => null }))
vi.mock('@/components/ellipsis', () => ({ Ellipsis: ({ children }: { children: ReactNode }) => <span>{children}</span> }))
vi.mock('@/components/item', () => ({ Item: ({ left, right }: { left: ReactNode, right: ReactNode }) => (
  <div>
    {left}
    {right}
  </div>
) }))
vi.mock('@/components/panel', () => ({ Panel: {
  Header: ({ title, action }: { title: ReactNode, action: ReactNode }) => (
    <div>
      {title}
      {action}
    </div>
  ),
  Loadable: ({ children }: { children: ReactNode }) => <div>{children}</div>,
} }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@heroui/react', () => ({
  AlertDialog: Object.assign(
    ({ isOpen, children }: { isOpen: boolean, children: ReactNode }) => <div>{isOpen ? children : null}</div>,
    {
      Backdrop: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Container: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      CloseTrigger: () => null,
      Header: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Icon: () => null,
      Heading: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Body: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Footer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    },
  ),
  Button: ({ children, onPress, isDisabled }: { children: ReactNode, onPress?: () => void, isDisabled?: boolean }) => (
    <button type="button" disabled={isDisabled} onClick={onPress}>{children}</button>
  ),
  Checkbox: Object.assign(
    ({ 'aria-label': ariaLabel, onChange }: { 'aria-label'?: string, 'onChange'?: () => void }) => (
      <button type="button" aria-label={ariaLabel} onClick={onChange} />
    ),
    {
      Content: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Control: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Indicator: () => null,
    },
  ),
  Chip: ({ children, onClick }: { children: ReactNode, onClick?: (event: { stopPropagation: () => void }) => void }) => (
    <button type="button" onClick={() => onClick?.({ stopPropagation: () => {} })}>{children}</button>
  ),
  Description: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Input: ({ value, onChange, placeholder }: { value?: string, onChange?: (event: { target: { value: string } }) => void, placeholder?: string }) => (
    <input placeholder={placeholder} value={value} onChange={event => onChange?.({ target: { value: event.target.value } })} />
  ),
  Label: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Switch: Object.assign(
    ({ children, isSelected, onChange, 'aria-label': ariaLabel }: { 'children'?: ReactNode, 'isSelected'?: boolean, 'onChange'?: () => void, 'aria-label'?: string }) => (
      <button type="button" role="switch" aria-label={ariaLabel} aria-checked={isSelected} onClick={() => onChange?.()}>{children}</button>
    ),
    { Content: ({ children }: { children: ReactNode }) => <div>{children}</div>, Control: ({ children }: { children: ReactNode }) => <div>{children}</div>, Thumb: () => null },
  ),
}))

const PROFILES = [
  { id: 'desktop', name: 'Desktop', default: false, builtin: true, active: true },
  { id: 'web-1', name: 'Web 1', default: false, builtin: false, active: false },
]

let client: QueryClient

beforeEach(() => {
  mocks.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === 'get_profiles')
      return PROFILES
    return null
  })
  mocks.toast.mockReset()
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } })
})

afterEach(() => {
  cleanup()
  client.clear()
  vi.restoreAllMocks()
})

async function mount() {
  render(<QueryClientProvider client={client}><ConfigProfile /></QueryClientProvider>)
  await screen.findByText('Web 1')
}

function toggleAdvanced() {
  fireEvent.click(screen.getByRole('switch', { name: 'profiles.advanced_options' }))
}

describe('profile row actions', () => {
  it('shows open-in-new-window on every profile without enabling advanced options', async () => {
    await mount()
    expect(screen.getByRole('switch', { name: 'profiles.advanced_options' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getAllByRole('button', { name: 'profiles.open_window' })).toHaveLength(PROFILES.length)
    expect(screen.queryByRole('button', { name: 'backup.manage' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'profiles.clone' })).toBeNull()
  })

  it('opens a new window bound to the clicked profile', async () => {
    await mount()
    fireEvent.click(screen.getAllByRole('button', { name: 'profiles.open_window' })[1])
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('create_app_window', { profile: 'web-1' }))
  })

  it('reveals backup and clone only after advanced options are enabled', async () => {
    await mount()
    toggleAdvanced()
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'backup.manage' })).toHaveLength(PROFILES.length))
    expect(screen.getAllByRole('button', { name: 'profiles.clone' })).toHaveLength(PROFILES.length)
  })
})
