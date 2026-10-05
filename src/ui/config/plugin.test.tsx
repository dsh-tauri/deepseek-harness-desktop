// @vitest-environment jsdom
import type { ReactNode } from 'react'
import type { Plugin } from '@/store/modules/plugins'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigPlugin } from './plugin'

const { manager, openDialog, mocks, hmrStatus } = vi.hoisted(() => ({
  manager: { installed: [] as Plugin[], processes: [], loading: false, error: '', disable: vi.fn(), enable: vi.fn(), search: vi.fn(), install: vi.fn() },
  openDialog: vi.fn(),
  mocks: {
    invoke: vi.fn(),
    toast: Object.assign(vi.fn(), { close: vi.fn() }),
    restart: vi.fn(),
    setQueryData: vi.fn(),
    invalidate: vi.fn(),
  },
  hmrStatus: { data: undefined as { enabled: boolean, watching: boolean, patchPath: string | null, roots: string[] } | undefined, isFetching: false },
}))

vi.mock('@/hooks/use-plugins-manager', () => ({ useDshPluginsManager: () => manager }))
vi.mock('@overlastic/react', () => ({ useOverlay: () => [null, openDialog] }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
// useMutation 桩会真正执行传入的 mutationFn：命令名与参数由用例断言，而不是断言「调用了 mutate」。
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate, setQueryData: mocks.setQueryData }),
  useQuery: () => hmrStatus,
  useMutation: (options: { mutationFn?: (variables: never) => Promise<unknown>, onSuccess?: (data: unknown) => void, onError?: (error: unknown) => void } = {}) => ({
    mutate: (variables: never) => {
      void Promise.resolve(options.mutationFn?.(variables))
        .then(data => options.onSuccess?.(data))
        .catch(error => options.onError?.(error))
    },
    mutateAsync: (variables: never) => Promise.resolve(options.mutationFn?.(variables)),
    isPending: false,
  }),
}))
vi.mock('@/store', () => ({ store: { preinstall: { open: vi.fn(), installing: false }, harness: { restart: mocks.restart } } }))
vi.mock('@/utils/toast', () => ({ toast: mocks.toast }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@/components/modal', () => ({ Modal: () => null }))
vi.mock('@/components/item', () => ({ Item: ({ left, right }: { left: ReactNode, right: ReactNode }) => (
  <div>
    {left}
    {right}
  </div>
) }))
vi.mock('@/components/ellipsis', () => ({ Ellipsis: ({ children }: { children: ReactNode }) => <span>{children}</span> }))
vi.mock('@/components/panel', () => ({ Panel: { Header: () => null, Loadable: ({ children }: { children: ReactNode }) => <div>{children}</div> } }))
vi.mock('@heroui/react', () => ({
  Chip: ({ children, onClick }: { children: ReactNode, onClick?: () => void }) => <button type="button" onClick={onClick}>{children}</button>,
  Button: ({ children, onPress, isDisabled, 'aria-label': ariaLabel }: { 'children': ReactNode, 'onPress'?: () => void, 'isDisabled'?: boolean, 'aria-label'?: string }) => (
    <button type="button" aria-label={ariaLabel} disabled={isDisabled} onClick={onPress}>{children}</button>
  ),
  Description: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Input: ({ value, onChange, placeholder, 'aria-label': ariaLabel }: { 'value'?: string, 'onChange'?: (event: { target: { value: string } }) => void, 'placeholder'?: string, 'aria-label'?: string }) => (
    <input aria-label={ariaLabel} placeholder={placeholder} value={value} onChange={event => onChange?.(event)} />
  ),
  Label: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Spinner: () => null,
  // Switch 的复合结构在桩里展开成原生 switch，好让用例断言选中态与回调值。
  Switch: Object.assign(
    ({ children, isSelected, isDisabled, onChange, 'aria-label': ariaLabel }: { 'children'?: ReactNode, 'isSelected'?: boolean, 'isDisabled'?: boolean, 'onChange'?: (selected: boolean) => void, 'aria-label'?: string }) => (
      <button type="button" role="switch" aria-label={ariaLabel} aria-checked={isSelected} disabled={isDisabled} onClick={() => onChange?.(!isSelected)}>{children}</button>
    ),
    { Content: ({ children }: { children: ReactNode }) => <>{children}</>, Control: ({ children }: { children: ReactNode }) => <>{children}</>, Thumb: () => null },
  ),
  Tooltip: Object.assign(
    ({ children }: { children: ReactNode }) => <>{children}</>,
    { Content: () => null },
  ),
}))

function plugin(overrides: Partial<Plugin> = {}): Plugin {
  return {
    id: 'dsh-tauri-pet',
    name: 'Desktop Pet',
    internal: true,
    disabled: false,
    patchDisabled: false,
    version: '1.0.0',
    description: '',
    repoUrl: '',
    bundled: true,
    recommended: false,
    fix: false,
    hasSnapshot: false,
    error: null,
    latest: null,
    updateAvailable: false,
    incompatible: false,
    latestIncompatible: false,
    ...overrides,
  }
}

function showBuiltIn() {
  render(<ConfigPlugin />)
  fireEvent.click(screen.getByRole('button', { name: 'plugins.builtin_title' }))
}

beforeEach(() => {
  manager.installed = [plugin()]
  manager.disable.mockReset().mockResolvedValue(undefined)
  manager.enable.mockReset().mockResolvedValue(undefined)
  manager.search.mockReset().mockResolvedValue([])
  manager.install.mockReset().mockResolvedValue(undefined)
  openDialog.mockReset()
  mocks.invoke.mockReset().mockResolvedValue(null)
  mocks.toast.mockReset()
  mocks.toast.close.mockReset()
  mocks.restart.mockReset()
  mocks.setQueryData.mockReset()
  mocks.invalidate.mockReset()
  hmrStatus.data = undefined
  hmrStatus.isFetching = false
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('built-in plugin toggles', () => {
  it('waits for risk confirmation before disabling a built-in plugin', async () => {
    let confirm: () => void = () => {}
    openDialog.mockImplementation(() => new Promise<void>((resolve) => {
      confirm = resolve
    }))
    showBuiltIn()
    fireEvent.click(screen.getByRole('button', { name: 'plugins.disable' }))
    expect(openDialog).toHaveBeenCalledWith(expect.objectContaining({
      status: 'warning',
      title: 'plugins.disable_builtin_confirm_title',
      confirmText: 'plugins.disable',
    }))
    expect(manager.disable).not.toHaveBeenCalled()
    await act(async () => confirm())
    expect(manager.disable).toHaveBeenCalledExactlyOnceWith('dsh-tauri-pet')
  })

  it('does not disable when the risk dialog is cancelled', async () => {
    openDialog.mockRejectedValue(new Error('cancelled'))
    showBuiltIn()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'plugins.disable' })))
    expect(openDialog).toHaveBeenCalledTimes(1)
    expect(manager.disable).not.toHaveBeenCalled()
  })

  it('enables a desktop-disabled built-in without showing a disable action', async () => {
    manager.installed = [plugin({ disabled: true })]
    showBuiltIn()
    expect(screen.queryByRole('button', { name: 'plugins.disable' })).toBeNull()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'plugins.enable' })))
    expect(manager.enable).toHaveBeenCalledExactlyOnceWith('dsh-tauri-pet', { clearConfigOverride: false })
    expect(openDialog).not.toHaveBeenCalled()
  })

  it('keeps explicit confirmation for enabling a config-disabled built-in', async () => {
    manager.installed = [plugin({ patchDisabled: true })]
    openDialog.mockResolvedValue(undefined)
    showBuiltIn()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'plugins.enable' })))
    expect(openDialog).toHaveBeenCalledWith(expect.objectContaining({ title: 'plugins.enable_override_confirm_title' }))
    expect(manager.enable).toHaveBeenCalledExactlyOnceWith('dsh-tauri-pet', { clearConfigOverride: true })
  })

  it('keeps non-built-in disabling direct', async () => {
    manager.installed = [plugin({ internal: false })]
    render(<ConfigPlugin />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'plugins.disable' })))
    expect(manager.disable).toHaveBeenCalledExactlyOnceWith('dsh-tauri-pet')
    expect(openDialog).not.toHaveBeenCalled()
  })
})

describe('local plugin folder picking', () => {
  /** 目录选择器由宿主在三平台各用原生实现，这里让 get_local_plugin_hmr 与 pick 各自返回固定值。 */
  function mockLocalCommands(picked: string | null) {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_local_plugin_hmr')
        return { enabled: false, watching: false, patchPath: null, roots: [] }
      if (command === 'pick_local_plugin_dir')
        return picked
      throw new Error(`Unexpected command: ${command}`)
    })
  }

  it('offers the folder picker on every platform', () => {
    render(<ConfigPlugin />)
    expect(screen.getByRole('button', { name: 'plugins.local_dir' })).toBeTruthy()
  })

  it('installs the picked folder as a link spec through the normal install chain', async () => {
    mockLocalCommands('link:D:/plugins/mine')
    render(<ConfigPlugin />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'plugins.local_dir' })))
    const input = screen.getByPlaceholderText('plugins.install_placeholder') as HTMLInputElement
    expect(input.value).toBe('link:D:/plugins/mine')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'plugins.install' })))
    await waitFor(() => expect(manager.search).toHaveBeenCalledExactlyOnceWith(['link:D:/plugins/mine']))
    expect(manager.install).toHaveBeenCalledExactlyOnceWith(['link:D:/plugins/mine'])
  })

  it('keeps the install box untouched when the folder picker is cancelled', async () => {
    mockLocalCommands(null)
    render(<ConfigPlugin />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'plugins.local_dir' })))
    expect(mocks.invoke).toHaveBeenCalledWith('pick_local_plugin_dir')
    expect((screen.getByPlaceholderText('plugins.install_placeholder') as HTMLInputElement).value).toBe('')
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('reports a failed folder picker instead of silently doing nothing', async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_local_plugin_hmr')
        return { enabled: false, watching: false, patchPath: null, roots: [] }
      if (command === 'pick_local_plugin_dir')
        throw new Error('PLUGIN_PICK_FOLDER_FAILED: boom')
      throw new Error(`Unexpected command: ${command}`)
    })
    render(<ConfigPlugin />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'plugins.local_dir' })))
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('plugins.local_dir_failed', { variant: 'danger' }))
  })
})

describe('local plugin hot reload switch', () => {
  it('sends the new value to the host and offers a restart', async () => {
    hmrStatus.data = { enabled: false, watching: false, patchPath: null, roots: [] }
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_local_plugin_hmr')
        return { enabled: false, watching: false, patchPath: null, roots: [] }
      if (command === 'set_local_plugin_hmr')
        return { enabled: true, watching: true, patchPath: 'D:/home/cordis.hmr.patch.yml', roots: ['D:/plugins/mine'] }
      throw new Error(`Unexpected command: ${command}`)
    })
    render(<ConfigPlugin />)
    await act(async () => fireEvent.click(screen.getByRole('switch', { name: 'plugins.hmr' })))
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('set_local_plugin_hmr', { enabled: true }))
    expect(mocks.setQueryData).toHaveBeenCalledWith(['local_plugin_hmr'], expect.objectContaining({ enabled: true }))
    expect(mocks.toast).toHaveBeenCalledWith('plugins.hmr_restart_hint', expect.objectContaining({ variant: 'accent' }))
  })

  it('surfaces a failed hot reload update to the user', async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_local_plugin_hmr')
        return { enabled: true, watching: true, patchPath: null, roots: ['D:/plugins/mine'] }
      if (command === 'set_local_plugin_hmr')
        throw new Error('HMR_LAYER_WRITE_FAILED: disk full')
      throw new Error(`Unexpected command: ${command}`)
    })
    render(<ConfigPlugin />)
    await act(async () => fireEvent.click(screen.getByRole('switch', { name: 'plugins.hmr' })))
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('plugins.hmr_save_failed', { variant: 'danger' }))
    expect(mocks.toast).not.toHaveBeenCalledWith('plugins.hmr_restart_hint', expect.anything())
  })
})
