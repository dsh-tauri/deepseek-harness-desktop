// @vitest-environment jsdom
import type { HarnessCore } from '@/types'
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
  version: '0.2.1-rc.4',
  tag: '',
  path: '/fixture/local/bin.js',
  dir: '/fixture/local',
  present: true,
  active: false,
  removable: false,
  preview: false,
  aboveRecommended: false,
  orphaned: false,
  bundled: false,
  recommendedVersion: '0.2.1-rc.4',
}
const managedFixture: HarnessCore = {
  id: 'app-dsh-0.2.1-rc.5-40372188763',
  source: 'app',
  version: '0.2.1-rc.5',
  tag: 'dsh-0.2.1-rc.5-40372188763',
  path: '/fixture/managed',
  dir: '/fixture/managed',
  present: true,
  active: true,
  removable: false,
  preview: false,
  aboveRecommended: false,
  orphaned: false,
  bundled: false,
  recommendedVersion: '0.2.1-rc.4',
}
const clients = new Set<QueryClient>()
let cores: HarnessCore[]
let translations = createInstance()
let updateVersion: string
let updateError: string | Error | null

function renderCore() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.add(client)
  return render(
    <I18nextProvider i18n={translations}>
      <QueryClientProvider client={client}>
        <ConfigCore />
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
  updateVersion = '0.2.2-rc.1'
  updateError = null
  translations = createInstance()
  await translations.init({
    lng: 'en-US',
    fallbackLng: 'en-US',
    resources: { 'en-US': { translation: enUS } },
    interpolation: { escapeValue: false },
  })
  mocks.restart.mockResolvedValue(undefined)
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === 'get_cores')
      return cores.map(core => ({ ...core }))
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

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Local core updated: 0.2.2-rc.1', {
      variant: 'success',
      description: 'The desktop will keep using the current managed core. Switch back to the local core manually.',
      timeout: 10_000,
    }))
    expect(mocks.invoke).toHaveBeenCalledWith('update_local_core')
    expect((screen.getByRole('checkbox', { name: '0.2.1-rc.5' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('checkbox', { name: '0.2.2-rc.1' }) as HTMLInputElement).checked).toBe(false)
    expectNoCoreOrProfileSwitch()
  })

  it('旧本地核心已回退受管核心时仍可更新，不把低于下限误当在用', async () => {
    cores[0].version = '0.1.6'
    renderCore()
    fireEvent.click(await screen.findByRole('button', { name: 'Incompatible versions (1)' }))

    fireEvent.click(screen.getByRole('button', { name: 'Update Local Core' }))

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Local core updated: 0.2.2-rc.1', {
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
    expect((screen.getByRole('checkbox', { name: '0.2.1-rc.4' }) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByRole('button', { name: 'Update Local Core' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('更新后手动切回只显示普通确认，取消不切核心', async () => {
    renderCore()
    fireEvent.click(await screen.findByRole('button', { name: 'Update Local Core' }))
    const updatedLocal = await screen.findByRole('checkbox', { name: '0.2.2-rc.1' })
    fireEvent.click(updatedLocal)

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).queryByRole('textbox')).toBeNull()
    expect(within(dialog).getByRole('heading').textContent).toBe('Warning')
    expectNoCoreOrProfileSwitch()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expectNoCoreOrProfileSwitch()
  })
})
