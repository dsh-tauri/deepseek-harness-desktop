// @vitest-environment jsdom
import type { HarnessCore } from '@/types'
import { OverlaysProvider } from '@overlastic/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import enUS from '@/i18n/locales/en-US.json'
import { ConfigCore } from './core'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  restart: vi.fn(),
  toast: Object.assign(vi.fn(), { close: vi.fn() }),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('@/store', () => ({ store: { harness: { restart: mocks.restart } } }))
vi.mock('@/utils/toast', () => ({ toast: mocks.toast }))

const localFixture: HarnessCore = {
  id: 'local',
  source: 'local',
  version: '0.2.2-rc.1',
  tag: '',
  path: '/fixture/local/bin.js',
  dir: '/fixture/local',
  present: true,
  active: false,
  removable: false,
  preview: false,
  orphaned: false,
  bundled: false,
}
const managedFixture: HarnessCore = {
  id: 'app-dsh-0.2.2-rc.2-41234040595',
  source: 'app',
  version: '0.2.2-rc.2',
  tag: 'dsh-0.2.2-rc.2-41234040595',
  path: '/fixture/managed',
  dir: '/fixture/managed',
  present: true,
  active: true,
  removable: false,
  preview: false,
  orphaned: false,
  bundled: false,
}
const clients = new Set<QueryClient>()
let cores: HarnessCore[]
let translations = createInstance()
let updateVersion: string
let updateError: string | Error | null
let coreAsar: boolean
let coreAsarError: string | Error | null

function renderCore() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.add(client)
  return render(
    <I18nextProvider i18n={translations}>
      <QueryClientProvider client={client}>
        <OverlaysProvider>
          <ConfigCore />
        </OverlaysProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  )
}

function expectNoCoreOrProfileSwitch() {
  const commands = mocks.invoke.mock.calls.map(([command]) => command)
  expect(commands).not.toContain('set_active_core')
  expect(commands).not.toContain('create_profile')
  expect(commands).not.toContain('set_active_profile')
  expect(mocks.restart).not.toHaveBeenCalled()
}

function expectManagedWarning() {
  expect(mocks.toast).toHaveBeenCalledWith('Switch to a managed core before updating', {
    variant: 'warning',
    description: 'The package manager chooses the target version. Switch to a downloaded managed core first, update, then switch back manually.',
    timeout: 10_000,
  })
}

beforeEach(async () => {
  vi.clearAllMocks()
  cores = [{ ...localFixture }, { ...managedFixture }]
  updateVersion = '0.2.3-rc.1'
  updateError = null
  coreAsar = true
  coreAsarError = null
  translations = createInstance()
  await translations.init({
    lng: 'en-US',
    fallbackLng: 'en-US',
    resources: { 'en-US': { translation: enUS } },
    interpolation: { escapeValue: false },
  })
  mocks.restart.mockResolvedValue(undefined)
  mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'get_cores')
      return cores.map(core => ({ ...core }))
    if (command === 'get_core_asar')
      return coreAsar
    if (command === 'set_core_asar') {
      if (coreAsarError)
        throw coreAsarError
      coreAsar = args?.enabled === true
      return undefined
    }
    if (command === 'set_active_core')
      return { ...managedFixture, active: true }
    if (command === 'update_local_core') {
      if (updateError)
        throw updateError
      cores[0] = { ...cores[0], version: updateVersion }
      return updateVersion
    }
    if (command === 'get_profiles')
      return [{ id: 'core-0.2.1', name: 'Core-0.2.1', active: true }]
    throw new Error(`Unexpected command: ${command}`)
  })
})

afterEach(() => {
  cleanup()
  for (const client of clients)
    client.clear()
  clients.clear()
  vi.restoreAllMocks()
})

describe('核心激活兼容性', () => {
  it.each([
    ['CORE_VERSION_LEGACY_DIRECTORY', 'This core uses an unsupported directory format. Download a current core.'],
    ['CORE_VERSION_LEGACY_DIRECTORY: directory cores are unsupported', 'This core uses an unsupported directory format. Download a current core.'],
    ['CORE_VERSION_INVALID_ASAR: invalid archive', 'This core is unavailable. Download it again.'],
    ['CORE_VERSION_LEGACY_DIRECTORY_EXTRA: other failure', 'This core is unavailable. Download it again.'],
  ])('有错误的 app 行不可通过复选框或行点击激活：%s', async (error, hint) => {
    cores = [{ ...managedFixture, active: false, removable: true, orphaned: true, error }]
    renderCore()

    const checkbox = await screen.findByRole('checkbox', { name: '0.2.2-rc.2' })
    expect((checkbox as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByText(hint).textContent).toBe(hint)
    fireEvent.click(checkbox)
    fireEvent.click(screen.getByText('0.2.2-rc.2'))

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expectNoCoreOrProfileSwitch()
    expect((screen.getByRole('button', { name: 'Uninstall' }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: 'Open folder' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it.each(['0.2.1', '0.2.3-rc.1', '0.2.3'])('范围外的 app 版本不能激活：%s', async (version) => {
    cores = [{ ...managedFixture, version, active: false }]
    renderCore()
    fireEvent.click(await screen.findByRole('button', { name: 'Incompatible versions (1)' }))

    const checkbox = screen.getByRole('checkbox', { name: version })
    expect((checkbox as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(checkbox)
    fireEvent.click(screen.getByText(version))

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expectNoCoreOrProfileSwitch()
  })

  it.each(['row', 'checkbox'])('远程已移除但无错误的 orphaned asar 核心仍可通过 %s 激活', async (target) => {
    cores = [{ ...managedFixture, path: '/fixture/managed/core.asar', active: false, orphaned: true, error: null }]
    renderCore()

    const checkbox = await screen.findByRole('checkbox', { name: '0.2.2-rc.2' })
    expect((checkbox as HTMLInputElement).disabled).toBe(false)
    fireEvent.click(target === 'row' ? screen.getByText('0.2.2-rc.2') : checkbox)

    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }))

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('set_active_core', { id: managedFixture.id }))
    await waitFor(() => expect(mocks.restart).toHaveBeenCalledTimes(1))
  })
})

describe('本地核心更新档案安全', () => {
  it('在用本地核心不可原地更新，提示先切受管核心且不发送更新命令', async () => {
    cores[0].active = true
    cores[1].active = false
    renderCore()

    fireEvent.click(await screen.findByRole('button', { name: 'Update Local Core' }))

    await waitFor(expectManagedWarning)
    expect(mocks.invoke).not.toHaveBeenCalledWith('update_local_core')
    expectNoCoreOrProfileSwitch()
  })

  it('未在用的本地核心可更新至包管理器实际版本，保持受管核心并提示手动切回', async () => {
    renderCore()

    fireEvent.click(await screen.findByRole('button', { name: 'Update Local Core' }))

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Local core updated: 0.2.3-rc.1', {
      variant: 'success',
      description: 'The desktop will keep using the current managed core. Switch back to the local core manually.',
      timeout: 10_000,
    }))
    expect(mocks.invoke).toHaveBeenCalledWith('update_local_core')
    expect((screen.getByRole('checkbox', { name: '0.2.2-rc.2' }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Incompatible versions (1)' }))
    const updatedLocal = screen.getByRole('checkbox', { name: '0.2.3-rc.1' })
    expect((updatedLocal as HTMLInputElement).checked).toBe(false)
    fireEvent.click(updatedLocal)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(mocks.toast).toHaveBeenLastCalledWith('Local core version is unsupported', {
      variant: 'warning',
      description: 'This desktop supports only dsh 0.2.2, starting from 0.2.2-rc.1. Install a supported local version before switching back.',
      timeout: 10_000,
    })
    expectNoCoreOrProfileSwitch()
  })

  it('旧本地核心已回退受管核心时仍可更新，不把低于下限误当在用', async () => {
    cores[0].version = '0.1.6'
    renderCore()
    fireEvent.click(await screen.findByRole('button', { name: 'Incompatible versions (1)' }))

    fireEvent.click(screen.getByRole('button', { name: 'Update Local Core' }))

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Local core updated: 0.2.3-rc.1', {
      variant: 'success',
      description: 'The desktop will keep using the current managed core. Switch back to the local core manually.',
      timeout: 10_000,
    }))
    expect(mocks.invoke).toHaveBeenCalledWith('update_local_core')
    expectNoCoreOrProfileSwitch()
  })

  it.each([
    'CORE_LOCAL_UPDATE_REQUIRES_APP',
    new Error('CORE_LOCAL_UPDATE_REQUIRES_APP'),
    'CORE_LOCAL_UPDATE_REQUIRES_APP: switch to a supported managed core before updating the local core',
    new Error('CORE_LOCAL_UPDATE_REQUIRES_APP: switch to a supported managed core before updating the local core'),
    'CORE_LOCAL_UPDATE_REQUIRES_APP: a supported managed core must be installed before updating the local core',
    new Error('CORE_LOCAL_UPDATE_REQUIRES_APP: a supported managed core must be installed before updating the local core'),
  ])('列表过期但 Native 拒绝在用本地更新时映射可操作警告，不改档案或重启（%s）', async (error) => {
    updateError = error
    renderCore()

    fireEvent.click(await screen.findByRole('button', { name: 'Update Local Core' }))

    await waitFor(expectManagedWarning)
    expect(mocks.invoke).toHaveBeenCalledWith('update_local_core')
    expect(mocks.toast).toHaveBeenCalledTimes(1)
    expectNoCoreOrProfileSwitch()
    expect((screen.getByRole('button', { name: 'Update Local Core' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it.each([
    'npm exited with code 1',
    new Error('npm exited with code 1'),
    'CORE_LOCAL_UPDATE_REQUIRES_APPENDED: unrelated failure',
    new Error('CORE_LOCAL_UPDATE_REQUIRES_APPENDED: unrelated failure'),
    'npm failed: CORE_LOCAL_UPDATE_REQUIRES_APP',
    new Error('npm failed: CORE_LOCAL_UPDATE_REQUIRES_APP'),
  ])('非契约错误保持原核心及档案，保留通用失败提示和重试状态（%s）', async (error) => {
    updateError = error
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    renderCore()

    fireEvent.click(await screen.findByRole('button', { name: 'Update Local Core' }))

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Failed to update the local core', {}))
    expect(errorLog).toHaveBeenCalledWith('[ConfigCore] update local core failed:', error)
    expectNoCoreOrProfileSwitch()
    expect((screen.getByRole('checkbox', { name: '0.2.2-rc.1' }) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByRole('button', { name: 'Update Local Core' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('更新为受支持的本地版本后手动切回只显示普通确认，取消不切核心', async () => {
    updateVersion = '0.2.2'
    renderCore()
    fireEvent.click(await screen.findByRole('button', { name: 'Update Local Core' }))
    const updatedLocal = await screen.findByRole('checkbox', { name: '0.2.2' })
    fireEvent.click(updatedLocal)

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).queryByRole('textbox')).toBeNull()
    expect(within(dialog).getByRole('heading').textContent).toBe('Switch version')
    expectNoCoreOrProfileSwitch()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expectNoCoreOrProfileSwitch()
  })
})

describe('核心格式（ASAR）开关', () => {
  async function openAdvanced() {
    renderCore()
    fireEvent.click(await screen.findByRole('switch', { name: 'Advanced options' }))
    const toggle = await screen.findByRole('switch', { name: 'ASAR' })
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false))
    return toggle
  }

  it('高级选项默认收起，展开后显示默认开启的 ASAR 开关', async () => {
    renderCore()
    expect(screen.queryByRole('switch', { name: 'ASAR' })).toBeNull()

    fireEvent.click(await screen.findByRole('switch', { name: 'Advanced options' }))

    const toggle = await screen.findByRole('switch', { name: 'ASAR' })
    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(true))
    const hint = enUS['core.asar_hint']
    expect(screen.getByText(hint).textContent).toBe(hint)
  })

  it('关闭 ASAR 先确认，确认后切换格式并重启服务', async () => {
    const toggle = await openAdvanced()
    fireEvent.click(toggle)

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByRole('heading').textContent).toBe(enUS['core.asar_confirm_title'])
    const description = enUS['core.asar_confirm_desc']
    expect(within(dialog).getByText(description).textContent).toBe(description)
    expect(mocks.invoke).not.toHaveBeenCalledWith('set_core_asar', expect.anything())

    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }))

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('set_core_asar', { enabled: false }))
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Switched to the directory core', {
      variant: 'accent',
      description: 'Core switched — restarting the service…',
      timeout: 10_000,
    }))
    await waitFor(() => expect(mocks.restart).toHaveBeenCalledTimes(1))
    expect((toggle as HTMLInputElement).checked).toBe(false)
  })

  it('取消确认框不切换格式、不重启', async () => {
    const toggle = await openAdvanced()
    fireEvent.click(toggle)

    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(mocks.invoke).not.toHaveBeenCalledWith('set_core_asar', expect.anything())
    expect(mocks.restart).not.toHaveBeenCalled()
    expect((toggle as HTMLInputElement).checked).toBe(true)
  })

  it('随包内核构建禁用 ASAR 开关', async () => {
    cores = [{ ...managedFixture, id: 'app-bundled', bundled: true }]
    renderCore()
    fireEvent.click(await screen.findByRole('switch', { name: 'Advanced options' }))

    const toggle = await screen.findByRole('switch', { name: 'ASAR' })
    expect((toggle as HTMLButtonElement).disabled).toBe(true)
  })

  it('本地核心生效时禁用 ASAR 开关', async () => {
    cores = [{ ...localFixture, active: true }, { ...managedFixture, active: false }]
    renderCore()
    fireEvent.click(await screen.findByRole('switch', { name: 'Advanced options' }))
    expect((await screen.findByRole('switch', { name: 'ASAR' }) as HTMLInputElement).disabled).toBe(true)
  })

  it('切换失败时提示失败并保留原格式', async () => {
    coreAsarError = 'CORE_ASAR_SWITCH_FAILED: download unavailable'
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const toggle = await openAdvanced()
    fireEvent.click(toggle)
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Confirm' }))

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Failed to switch the core format', { variant: 'danger', description: coreAsarError }))
    expect(errorLog).toHaveBeenCalledWith('[ConfigCore] switch core format failed:', coreAsarError)
    expect(mocks.restart).not.toHaveBeenCalled()
    expect((toggle as HTMLInputElement).checked).toBe(true)
  })
})
