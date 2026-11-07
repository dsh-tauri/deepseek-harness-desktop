// @vitest-environment jsdom
import type { ReactNode } from 'react'
import type { Plugin, PluginProcess } from '@/store/modules/plugins'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigPlugin } from './plugin'

const { manager, openDialog, mocks, hmrStatus } = vi.hoisted(() => ({
  manager: { installed: [] as Plugin[], processes: [] as PluginProcess[], loading: false, error: '', disable: vi.fn(), enable: vi.fn(), search: vi.fn(), install: vi.fn(), upgrade: vi.fn() },
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
vi.mock('@overlastic/react', () => ({ useOverlay: () => openDialog }))
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
vi.mock('@/components/panel', () => ({ Panel: {
  Header: ({ action }: { action: ReactNode }) => <div>{action}</div>,
  Loadable: ({ children }: { children: ReactNode }) => <div>{children}</div>,
} }))
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
    id: 'dsh-tauri-archive',
    name: 'DSH Tauri Archive',
    internal: true,
    disabled: false,
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

function showAdvanced() {
  fireEvent.click(screen.getByRole('switch', { name: 'plugins.advanced_options' }))
}

beforeEach(() => {
  manager.installed = [plugin()]
  manager.processes = []
  manager.upgrade.mockReset().mockResolvedValue([])
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
    expect(manager.disable).toHaveBeenCalledExactlyOnceWith('dsh-tauri-archive')
  })

  it('does not disable when the risk dialog is cancelled', async () => {
    openDialog.mockRejectedValue(new Error('cancelled'))
    showBuiltIn()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'plugins.disable' })))
    expect(openDialog).toHaveBeenCalledTimes(1)
    expect(manager.disable).not.toHaveBeenCalled()
  })

  it('enables a disabled built-in without showing a disable action', async () => {
    manager.installed = [plugin({ disabled: true })]
    showBuiltIn()
    expect(screen.queryByRole('button', { name: 'plugins.disable' })).toBeNull()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'plugins.enable' })))
    expect(manager.enable).toHaveBeenCalledExactlyOnceWith('dsh-tauri-archive')
    expect(openDialog).not.toHaveBeenCalled()
  })

  it('keeps non-built-in disabling direct', async () => {
    manager.installed = [plugin({ internal: false })]
    render(<ConfigPlugin />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'plugins.disable' })))
    expect(manager.disable).toHaveBeenCalledExactlyOnceWith('dsh-tauri-archive')
    expect(openDialog).not.toHaveBeenCalled()
  })
})

describe('one-click plugin upgrade', () => {
  it('shows the bulk upgrade right before open preset without enabling advanced options', () => {
    manager.installed = [plugin({ id: 'updated', internal: false, updateAvailable: true, latest: '2.0.0' })]
    render(<ConfigPlugin />)
    const preset = screen.getByRole('button', { name: 'preinstall.open_preset' })
    const upgradeAll = screen.getByRole('button', { name: 'plugins.upgrade_all' })
    expect(upgradeAll.nextElementSibling).toBe(preset)
    expect(screen.getByRole('switch', { name: 'plugins.advanced_options' }).getAttribute('aria-checked')).toBe('false')
  })

  it.each([
    ['no plugins', []],
    ['only current managed plugins', [plugin({ internal: false })]],
    ['only built-in updates', [plugin({ updateAvailable: true, latest: '2.0.0' })]],
  ] as const)('hides bulk upgrade with %s', (_case, installed) => {
    manager.installed = [...installed]
    render(<ConfigPlugin />)
    expect(screen.queryByRole('button', { name: 'plugins.upgrade_all' })).toBeNull()
    expect(manager.upgrade).not.toHaveBeenCalled()
  })

  it('submits managed updates and repairs as one group with the displayed target versions', async () => {
    manager.installed = [
      plugin({ id: 'updated', internal: false, updateAvailable: true, latest: '2.0.0' }),
      plugin({ id: 'unresolved', internal: false, updateAvailable: true }),
      plugin({ id: 'broken', internal: false, error: { message: 'broken', action: 'runtime', at: '1' } }),
      plugin({ id: 'current', internal: false }),
      plugin({ id: 'built-in', updateAvailable: true, latest: '2.0.0' }),
    ]
    render(<ConfigPlugin />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'plugins.upgrade_all' })))
    expect(manager.upgrade).toHaveBeenCalledExactlyOnceWith([
      { spec: 'updated', version: '2.0.0' },
      'unresolved',
      'broken',
    ])
    expect(mocks.toast).not.toHaveBeenCalled()
    expect(mocks.restart).not.toHaveBeenCalled()
  })

  it('prevents duplicate bulk and row submissions until the group settles', async () => {
    let settle: () => void = () => {}
    manager.upgrade.mockImplementationOnce(() => new Promise<void>((resolve) => {
      settle = resolve
    }))
    manager.installed = [plugin({ id: 'updated', internal: false, updateAvailable: true, latest: '2.0.0' })]
    render(<ConfigPlugin />)
    fireEvent.click(screen.getByRole('button', { name: 'plugins.upgrade_all' }))
    expect(screen.queryByRole('button', { name: 'plugins.upgrade_all' })).toBeNull()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'plugins.upgrade 2.0.0' })))
    expect(manager.upgrade).toHaveBeenCalledExactlyOnceWith([{ spec: 'updated', version: '2.0.0' }])

    await act(async () => settle())
    expect((screen.getByRole('button', { name: 'plugins.upgrade_all' }) as HTMLButtonElement).disabled).toBe(false)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'plugins.upgrade 2.0.0' })))
    expect(manager.upgrade).toHaveBeenCalledTimes(2)
    expect(manager.upgrade).toHaveBeenLastCalledWith({ spec: 'updated', version: '2.0.0' })
  })

  it('excludes plugins already queued while allowing other updates', async () => {
    manager.installed = [
      plugin({ id: 'queued', internal: false, updateAvailable: true, latest: '2.0.0' }),
      plugin({ id: 'available', internal: false, updateAvailable: true, latest: '3.0.0' }),
    ]
    manager.processes = [{ id: 'p1', groupId: 'g1', name: 'queued', spec: 'queued@2.0.0', type: 'upgrade', status: 'unauthorized' }]
    const { rerender } = render(<ConfigPlugin />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'plugins.upgrade_all' })))
    expect(manager.upgrade).toHaveBeenCalledExactlyOnceWith([{ spec: 'available', version: '3.0.0' }])

    manager.installed = [plugin({ id: 'queued', internal: false, updateAvailable: true })]
    rerender(<ConfigPlugin />)
    expect(screen.queryByRole('button', { name: 'plugins.upgrade_all' })).toBeNull()
  })

  it('excludes a row whose local action is still pending', async () => {
    let settle: () => void = () => {}
    manager.disable.mockImplementationOnce(() => new Promise<void>((resolve) => {
      settle = resolve
    }))
    manager.installed = [plugin({ id: 'updated', internal: false, updateAvailable: true, latest: '2.0.0' })]
    render(<ConfigPlugin />)
    fireEvent.click(screen.getByRole('button', { name: 'plugins.disable' }))
    expect(screen.queryByRole('button', { name: 'plugins.upgrade_all' })).toBeNull()
    await act(async () => settle())
    expect((screen.getByRole('button', { name: 'plugins.upgrade_all' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('releases the bulk and row guards after a manager failure without duplicating its toast', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    manager.upgrade.mockRejectedValueOnce(new Error('UPGRADE_FAILED'))
    manager.installed = [plugin({ id: 'updated', internal: false, updateAvailable: true })]
    render(<ConfigPlugin />)
    const upgradeAll = screen.getByRole('button', { name: 'plugins.upgrade_all' }) as HTMLButtonElement
    await act(async () => fireEvent.click(upgradeAll))
    expect((screen.getByRole('button', { name: 'plugins.upgrade_all' }) as HTMLButtonElement).disabled).toBe(false)
    expect(mocks.toast).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'plugins.upgrade' })))
    expect(manager.upgrade.mock.calls).toEqual([[['updated']], ['updated']])
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

  it('keeps a picked path containing spaces as one spec', async () => {
    mockLocalCommands('link:D:/My Plugins/mine')
    render(<ConfigPlugin />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'plugins.local_dir' })))
    const input = screen.getByPlaceholderText('plugins.install_placeholder') as HTMLInputElement
    expect(input.value).toBe('link:D:/My Plugins/mine')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'plugins.install' })))
    await waitFor(() => expect(manager.search).toHaveBeenCalledExactlyOnceWith(['link:D:/My Plugins/mine']))
    expect(manager.install).toHaveBeenCalledExactlyOnceWith(['link:D:/My Plugins/mine'])
  })

  it('splits specs again once the picked path is edited by hand', async () => {
    mockLocalCommands('link:D:/My Plugins/mine')
    render(<ConfigPlugin />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'plugins.local_dir' })))
    const input = screen.getByPlaceholderText('plugins.install_placeholder') as HTMLInputElement
    await act(async () => fireEvent.change(input, { target: { value: 'dsh-a, dsh-b  dsh-c' } }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'plugins.install' })))
    await waitFor(() => expect(manager.search).toHaveBeenCalledExactlyOnceWith(['dsh-a', 'dsh-b', 'dsh-c']))
    expect(manager.install).toHaveBeenCalledExactlyOnceWith(['dsh-a', 'dsh-b', 'dsh-c'])
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

describe('incompatible plugin install', () => {
  /** 不兼容的 spec 必须照样入队：授权气泡由管理器弹，面板不能提前拦截成一条错误提示。 */
  it('still hands an incompatible spec to the manager instead of failing it at the panel', async () => {
    manager.search.mockResolvedValue([
      { spec: 'dsh-a', name: 'dsh-a', version: '1.0.0', compatible: false },
    ])
    render(<ConfigPlugin />)
    const input = screen.getByPlaceholderText('plugins.install_placeholder')
    await act(async () => fireEvent.change(input, { target: { value: 'dsh-a' } }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'plugins.install' })))

    await waitFor(() => expect(manager.install).toHaveBeenCalledExactlyOnceWith(['dsh-a']))
    // 面板既不拦也不报错：授权与否留给管理器那条气泡。
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('shows the resolved version of an incompatible spec without blocking the install', async () => {
    manager.search.mockResolvedValue([
      { spec: 'dsh-a', name: 'dsh-a', version: '1.0.0', compatible: false },
    ])
    render(<ConfigPlugin />)
    const input = screen.getByPlaceholderText('plugins.install_placeholder')
    await act(async () => fireEvent.change(input, { target: { value: 'dsh-a' } }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'plugins.install' })))

    expect(await screen.findByText('plugins.search_incompatible_badge')).toBeTruthy()
    expect(manager.install).toHaveBeenCalledWith(['dsh-a'])
  })
})

describe('non-registry spec search results', () => {
  /** 宿主对 `github:` 简写与 git URL 不做 registry 解析，面板只转述它给出的结论，不得自己判定 spec 非法。 */
  it('renders a github spec without a problem label and still installs it', async () => {
    manager.search.mockResolvedValue([
      { spec: 'github:MengYuil/dsh-ponytail', compatible: null },
    ])
    const { container } = render(<ConfigPlugin />)
    const input = screen.getByPlaceholderText('plugins.install_placeholder')
    await act(async () => fireEvent.change(input, { target: { value: 'github:MengYuil/dsh-ponytail' } }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'plugins.install' })))

    await waitFor(() => expect(manager.install).toHaveBeenCalledExactlyOnceWith(['github:MengYuil/dsh-ponytail']))
    expect(container.querySelector('.text-danger')).toBeNull()
    expect(screen.getByText('github:MengYuil/dsh-ponytail')).toBeTruthy()
  })
})

describe('local plugin hot reload switch', () => {
  it('hides the whole hot reload block unless advanced options are enabled', () => {
    hmrStatus.data = { enabled: true, watching: false, patchPath: null, roots: [] }
    render(<ConfigPlugin />)
    expect(screen.getByRole('switch', { name: 'plugins.advanced_options' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByRole('switch', { name: 'plugins.hmr' })).toBeNull()
    expect(screen.queryByText('plugins.hmr')).toBeNull()
    expect(screen.queryByText('plugins.hmr_hint')).toBeNull()
    expect(screen.queryByText('plugins.hmr_idle')).toBeNull()

    showAdvanced()
    expect(screen.getByRole('switch', { name: 'plugins.hmr' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('plugins.hmr_hint').textContent).toBe('plugins.hmr_hint')
    expect(screen.getByText('plugins.hmr_idle').textContent).toBe('plugins.hmr_idle')

    showAdvanced()
    expect(screen.queryByRole('switch', { name: 'plugins.hmr' })).toBeNull()
    expect(screen.queryByText('plugins.hmr_hint')).toBeNull()
    expect(screen.queryByText('plugins.hmr_idle')).toBeNull()
    expect(mocks.invoke).not.toHaveBeenCalledWith('set_local_plugin_hmr', expect.anything())
  })

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
    showAdvanced()
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
    showAdvanced()
    await act(async () => fireEvent.click(screen.getByRole('switch', { name: 'plugins.hmr' })))
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('plugins.hmr_save_failed', { variant: 'danger' }))
    expect(mocks.toast).not.toHaveBeenCalledWith('plugins.hmr_restart_hint', expect.anything())
  })
})
