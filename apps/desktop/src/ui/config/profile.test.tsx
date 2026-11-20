// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/config/query-keys'
import { ConfigProfile } from './profile'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), getCoreProfiles: vi.fn(), loadRemoteMachines: vi.fn(), toast: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@/utils/toast', () => ({ toast: mocks.toast }))
vi.mock('@/store', () => ({ store: { harness: { switchProfile: vi.fn(), restart: vi.fn() } } }))
vi.mock('@/store/modules/harness', () => ({ waitForHarnessStopped: vi.fn() }))
vi.mock('@/hooks/use-invalidate-on-setting-updated', () => ({ useInvalidateOnSettingUpdated: () => {} }))
vi.mock('@/hooks/use-remote', () => ({
  dotClassOf: () => 'bg-success',
  loadRemoteMachines: mocks.loadRemoteMachines,
}))
vi.mock('@/apis/remote', () => ({ getCoreProfiles: mocks.getCoreProfiles }))
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
vi.mock('@heroui/react', async () => {
  const { isValidElement } = await import('react')

  const SelectTrigger = ({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>) => (
    <span {...rest}>{children}</span>
  )
  const ListBoxItem = ({ id, children }: { id: string, children?: ReactNode }) => (
    <option value={id}>{children}</option>
  )

  /** 从 Select 的子元素里取出触发器与选项，模拟真实 Select 暴露的原生下拉。 */
  function collect(node: ReactNode, acc: { trigger: ReactNode, items: { id: string, label: ReactNode }[] }) {
    if (Array.isArray(node)) {
      node.forEach(child => collect(child, acc))
      return
    }
    if (!isValidElement(node))
      return
    const props = node.props as { id?: string, children?: ReactNode }
    if (node.type === SelectTrigger) {
      acc.trigger = node
      return
    }
    if (node.type === ListBoxItem) {
      acc.items.push({ id: props.id ?? '', label: props.children })
      return
    }
    collect(props.children, acc)
  }

  const Select = ({ children, selectedKey, onSelectionChange, 'aria-label': ariaLabel }: {
    'children'?: ReactNode
    'selectedKey'?: string
    'onSelectionChange'?: (key: string) => void
    'aria-label'?: string
  }) => {
    const acc = { trigger: null, items: [] as { id: string, label: ReactNode }[] }
    collect(children, acc)
    return (
      <div>
        {acc.trigger}
        <select
          aria-label={ariaLabel}
          value={selectedKey}
          onChange={event => onSelectionChange?.(event.target.value)}
        >
          {acc.items.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </div>
    )
  }

  return {
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
    Button: ({ children, onPress, isDisabled, variant, size, ...rest }: { children: ReactNode, onPress?: () => void, isDisabled?: boolean, variant?: string, size?: string } & Record<string, unknown>) => (
      <button type="button" {...rest} disabled={isDisabled} onClick={onPress}>{children}</button>
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
    Chip: ({ children, onClick, variant, color, size, ...rest }: { children: ReactNode, onClick?: (event: { stopPropagation: () => void }) => void, variant?: string, color?: string, size?: string } & Record<string, unknown>) => (
      <button type="button" {...rest} onClick={() => onClick?.({ stopPropagation: () => {} })}>{children}</button>
    ),
    Description: ({ children }: { children: ReactNode }) => <span>{children}</span>,
    Input: ({ value, onChange, placeholder }: { value?: string, onChange?: (event: { target: { value: string } }) => void, placeholder?: string }) => (
      <input placeholder={placeholder} value={value} onChange={event => onChange?.({ target: { value: event.target.value } })} />
    ),
    Label: ({ children }: { children: ReactNode }) => <span>{children}</span>,
    Spinner: () => <span />,
    Switch: Object.assign(
      ({ children, isSelected, onChange, 'aria-label': ariaLabel }: { 'children'?: ReactNode, 'isSelected'?: boolean, 'onChange'?: () => void, 'aria-label'?: string }) => (
        <button type="button" role="switch" aria-label={ariaLabel} aria-checked={isSelected} onClick={() => onChange?.()}>{children}</button>
      ),
      { Content: ({ children }: { children: ReactNode }) => <div>{children}</div>, Control: ({ children }: { children: ReactNode }) => <div>{children}</div>, Thumb: () => null },
    ),
    Select: Object.assign(Select, {
      Trigger: SelectTrigger,
      Value: () => null,
      Indicator: () => null,
      Popover: ({ children }: { children?: ReactNode }) => <>{children}</>,
    }),
    ListBox: Object.assign(
      ({ children }: { children?: ReactNode }) => <>{children}</>,
      { Item: ListBoxItem },
    ),
  }
})

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
  mocks.loadRemoteMachines.mockReset().mockResolvedValue({ enabled: false, machines: [] })
  mocks.getCoreProfiles.mockReset().mockResolvedValue({ items: [{ name: 'remote', configured: true }] })
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

describe('档案作用域', () => {
  const REMOTE_MACHINE = { id: 'build', name: 'Build box', state: 'connected' }

  it('keeps the full desktop shell on the local scope', async () => {
    mocks.loadRemoteMachines.mockResolvedValue({ enabled: true, machines: [REMOTE_MACHINE] })
    await mount()

    expect(screen.getByText('Web 1')).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'profiles.advanced_options' })).toBeTruthy()
    expect(screen.getByTestId('dsh-profile-migrate-open')).toBeTruthy()
    expect(screen.queryByTestId('dsh-profile-remote-section')).toBeNull()
  })

  it('shows the selected remote machine as a read-only view', async () => {
    mocks.loadRemoteMachines.mockResolvedValue({ enabled: true, machines: [REMOTE_MACHINE] })
    await mount()
    await screen.findByTestId('dsh-config-profile-target')
    await screen.findByRole('option', { name: 'Build box' })

    fireEvent.change(screen.getByLabelText('core.scope'), { target: { value: 'remote:build' } })

    expect(await screen.findByTestId('dsh-profile-remote-build-remote')).toBeTruthy()
    expect(mocks.getCoreProfiles).toHaveBeenCalledWith({ machineId: 'build' })
    expect(screen.queryByText('Web 1')).toBeNull()
    expect(screen.queryByRole('switch', { name: 'profiles.advanced_options' })).toBeNull()
    expect(screen.queryByTestId('dsh-profile-migrate-open')).toBeNull()
  })

  it('keeps a remote machine named local apart from the local scope', async () => {
    const localNamedMachine = { id: 'local', name: 'Local box', state: 'connected' }
    mocks.loadRemoteMachines.mockResolvedValue({ enabled: true, machines: [localNamedMachine] })
    mocks.getCoreProfiles.mockResolvedValue({ items: [{ name: 'remote', configured: true }] })
    await mount()
    await screen.findByTestId('dsh-config-profile-target')
    await screen.findByRole('option', { name: 'Local box' })

    fireEvent.change(screen.getByLabelText('core.scope'), { target: { value: 'remote:local' } })

    expect(await screen.findByTestId('dsh-profile-remote-local-remote')).toBeTruthy()
    expect(mocks.getCoreProfiles).toHaveBeenCalledWith({ machineId: 'local' })
    expect(screen.queryByText('Web 1')).toBeNull()
  })

  it('falls back to the local scope when the selected remote machine disappears', async () => {
    mocks.loadRemoteMachines.mockResolvedValue({ enabled: true, machines: [REMOTE_MACHINE] })
    await mount()
    await screen.findByTestId('dsh-config-profile-target')
    await screen.findByRole('option', { name: 'Build box' })
    fireEvent.change(screen.getByLabelText('core.scope'), { target: { value: 'remote:build' } })
    await screen.findByTestId('dsh-profile-remote-build-remote')

    mocks.loadRemoteMachines.mockResolvedValue({ enabled: true, machines: [] })
    await client.invalidateQueries({ queryKey: queryKeys.remoteMachines })

    expect(await screen.findByText('Web 1')).toBeTruthy()
    expect(screen.queryByTestId('dsh-profile-remote-section')).toBeNull()
  })
})

describe('面板头部控件顺序', () => {
  it('高级选项开关排在管理范围（远端切换器）之前', async () => {
    await mount()

    const advanced = screen.getByRole('switch', { name: 'profiles.advanced_options' })
    const scope = screen.getByTestId('dsh-config-profile-target')

    expect(advanced.compareDocumentPosition(scope) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
