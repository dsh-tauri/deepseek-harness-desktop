// @vitest-environment jsdom
import type { GetApiTauriRemoteCoreCurrentResponse } from '@/apis/remote.types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/config/query-keys'
import enUS from '@/i18n/locales/en-US.json'
import { RemoteCoreList } from './remote-core'

const mocks = vi.hoisted(() => ({
  getCoreCurrent: vi.fn(),
  getCoreProfiles: vi.fn(),
  getCoreTasksEvents: vi.fn(),
  getCoreVersions: vi.fn(),
  loadRemoteMachines: vi.fn(),
  openDialog: vi.fn(),
  postCoreInstall: vi.fn(),
  postCoreSwitch: vi.fn(),
  writeClipboardText: vi.fn(),
  toast: vi.fn(),
}))

vi.mock('@/apis/remote', () => ({
  getCoreCurrent: mocks.getCoreCurrent,
  getCoreProfiles: mocks.getCoreProfiles,
  getCoreTasksEvents: mocks.getCoreTasksEvents,
  getCoreVersions: mocks.getCoreVersions,
  postCoreInstall: mocks.postCoreInstall,
  postCoreSwitch: mocks.postCoreSwitch,
}))
vi.mock('@overlastic/react', () => ({ useOverlay: () => mocks.openDialog }))
vi.mock('@/hooks/use-remote', () => ({
  dotClassOf: () => 'bg-success',
  loadRemoteMachines: mocks.loadRemoteMachines,
}))
vi.mock('@/utils/clipboard', () => ({
  writeClipboardText: mocks.writeClipboardText,
}))
vi.mock('@/utils/toast', () => ({
  toast: mocks.toast,
}))

type CoreTarget = NonNullable<GetApiTauriRemoteCoreCurrentResponse['item']>
type CoreSlot = Extract<CoreTarget, { availability: 'present' }>['slots'][number]
type UnreadableCoreSlot = Extract<CoreTarget, { availability: 'unreadable' }>['slots'][number]
type TargetState
  = | { availability: 'absent', slots: [] }
    | { availability: 'present', slots: CoreSlot[] }
    | { availability: 'unreadable', error: string, path?: string, slots: UnreadableCoreSlot[] }

const clients = new Set<QueryClient>()
let translations = createInstance()

function remoteCoreUi(machineId: string, client: QueryClient) {
  return (
    <I18nextProvider i18n={translations}>
      <QueryClientProvider client={client}>
        <RemoteCoreList machineId={machineId} />
      </QueryClientProvider>
    </I18nextProvider>
  )
}

function renderRemoteCore(machineId = 'build') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.add(client)
  const view = render(remoteCoreUi(machineId, client))
  return { client, ...view }
}

function targetOf(machineId: string, target: TargetState): CoreTarget {
  return {
    id: `remote:${machineId}:remote`,
    scope: 'remote',
    machineId,
    remoteProfile: 'remote',
    capabilities: ['listVersions', 'installVersion', 'activate'],
    platforms: ['linux-x64'],
    ...target,
  } as CoreTarget
}

function isDisabled(element: HTMLElement): boolean {
  return (element as HTMLButtonElement).disabled
    || element.getAttribute('aria-disabled') === 'true'
    || element.getAttribute('data-disabled') === 'true'
}

/** 两份已下载的副本 + 当前使用的那份：够用来试「换一个版本切换」。 */
function twoCopiesTarget(): CoreTarget {
  return targetOf('build', {
    availability: 'present',
    slots: [
      {
        kind: 'installed',
        slotKey: 'dsh',
        version: '0.2.4',
        dir: '/home/remote/.dsh-desktop/dependencies/dsh',
        active: true,
        removable: false,
        preview: false,
      },
      {
        kind: 'installed',
        slotKey: 'dsh-0.2.6-1',
        tag: 'dsh-0.2.6-1',
        version: '0.2.6',
        dir: '/home/remote/.dsh-desktop/dependencies/dsh-0.2.6-1',
        active: false,
        removable: true,
        preview: false,
      },
      {
        kind: 'installed',
        slotKey: 'dsh-0.2.5-beta.1-2',
        tag: 'dsh-0.2.5-beta.1-2',
        version: '0.2.5-beta.1',
        dir: '/home/remote/.dsh-desktop/dependencies/dsh-0.2.5-beta.1-2',
        active: false,
        removable: true,
        preview: true,
      },
    ],
  })
}

beforeEach(async () => {
  vi.clearAllMocks()
  translations = createInstance()
  await translations.init({
    lng: 'en-US',
    fallbackLng: 'en-US',
    resources: { 'en-US': { translation: enUS } },
    interpolation: { escapeValue: false },
  })
  mocks.loadRemoteMachines.mockResolvedValue({
    enabled: true,
    machines: [
      { id: 'build', name: 'Build box', state: 'connected' },
      { id: 'ops', name: 'Ops box', state: 'disconnected' },
    ],
  })
  mocks.getCoreVersions.mockResolvedValue({
    items: [
      { version: '0.2.6', tag: 'dsh-0.2.6-1', preview: false },
      { version: '0.2.5-beta.1', tag: 'dsh-0.2.5-beta.1-2', preview: true },
      { version: '0.2.4', tag: 'dsh-0.2.4-1', preview: false },
    ],
  })
  mocks.getCoreProfiles.mockImplementation(async ({ machineId }: { machineId: string }) => ({
    items: [
      { name: 'remote', configured: true },
      { name: `${machineId}-alt`, configured: false },
    ],
  }))
  mocks.getCoreTasksEvents.mockResolvedValue({ items: [] })
  mocks.openDialog.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  for (const client of clients)
    client.clear()
  clients.clear()
  vi.restoreAllMocks()
})

describe('远端核心清单', () => {
  it('keeps downloadable versions visible when the remote has no core yet', async () => {
    mocks.getCoreCurrent.mockResolvedValue({
      item: targetOf('build', { availability: 'absent', slots: [] }),
    })
    renderRemoteCore()

    const list = await screen.findByTestId('dsh-core-remote-list')
    expect(await within(list).findByText('Remote core is not installed')).toBeTruthy()
    expect(within(list).getAllByRole('button', { name: 'Download' })).toHaveLength(3)
  })

  it('lists the copy in use, the downloaded copies and the versions still to download', async () => {
    mocks.getCoreCurrent.mockResolvedValue({
      item: targetOf('build', {
        availability: 'present',
        slots: [
          {
            kind: 'installed',
            slotKey: 'dsh',
            version: '0.2.4',
            dir: '/home/remote/.dsh-desktop/dependencies/dsh',
            active: true,
            removable: false,
            preview: false,
          },
          {
            kind: 'installed',
            slotKey: 'dsh-0.2.5-beta.1-2',
            tag: 'dsh-0.2.5-beta.1-2',
            version: '0.2.5-beta.1',
            dir: '/home/remote/.dsh-desktop/dependencies/dsh-0.2.5-beta.1-2',
            active: false,
            removable: true,
            preview: true,
          },
        ],
      }),
    })
    renderRemoteCore()

    const list = await screen.findByTestId('dsh-core-remote-list')
    expect(await within(list).findByText('0.2.4')).toBeTruthy()
    expect(within(list).getByText('0.2.5-beta.1')).toBeTruthy()
    expect(within(list).getByText('0.2.6')).toBeTruthy()
    expect(within(list).getByText('Active')).toBeTruthy()
    expect(within(list).getByText('not downloaded')).toBeTruthy()
    expect(within(list).getByText('Preview')).toBeTruthy()
    expect(screen.getAllByText('Profile: remote').length).toBeGreaterThan(0)
    expect(within(list).queryByRole('button', { name: 'Uninstall' })).toBeNull()
  })

  it('offers a download button only for versions that are not on the machine yet', async () => {
    mocks.getCoreCurrent.mockResolvedValue({
      item: targetOf('build', {
        availability: 'present',
        slots: [{
          kind: 'installed',
          slotKey: 'dsh',
          version: '0.2.4',
          tag: 'dsh-0.2.4-1',
          dir: '/home/remote/.dsh-desktop/dependencies/dsh',
          active: true,
          removable: false,
          preview: false,
        }],
      }),
    })
    renderRemoteCore()

    const list = await screen.findByTestId('dsh-core-remote-list')
    const downloads = await within(list).findAllByRole('button', { name: 'Download' })
    expect(downloads.length).toBe(2)
  })

  it('groups unsupported copies apart and keeps retired copies in their own group', async () => {
    mocks.getCoreCurrent.mockResolvedValue({
      item: targetOf('build', {
        availability: 'present',
        slots: [
          {
            kind: 'installed',
            slotKey: 'dsh',
            version: '0.2.4',
            dir: '/home/remote/.dsh-desktop/dependencies/dsh',
            active: true,
            removable: false,
            preview: false,
          },
          {
            kind: 'unsupported',
            slotKey: 'dsh-0.2.1-1',
            version: '0.2.1',
            tag: 'dsh-0.2.1-1',
            error: 'REMOTE_DSH_VERSION_UNSUPPORTED',
          },
          {
            kind: 'installed',
            slotKey: 'dsh-0.2.0-1',
            tag: 'dsh-0.2.0-1',
            version: '0.2.0',
            dir: '/home/remote/.dsh-desktop/dependencies/dsh-0.2.0-1',
            active: false,
            removable: true,
            preview: false,
          },
        ],
      }),
    })
    renderRemoteCore()

    const list = await screen.findByTestId('dsh-core-remote-list')
    expect(await within(list).findByText('Incompatible versions (1)')).toBeTruthy()
    expect(within(list).getByText('Retired remote versions')).toBeTruthy()
    expect(within(list).getByText('Orphaned')).toBeTruthy()
    expect(within(list).getByText('Unsupported')).toBeTruthy()
  })

  it('copies the path of a remote copy instead of opening a folder', async () => {
    mocks.getCoreCurrent.mockResolvedValue({
      item: targetOf('build', {
        availability: 'present',
        slots: [{
          kind: 'installed',
          slotKey: 'dsh',
          version: '0.2.4',
          dir: '/home/remote/.dsh-desktop/dependencies/dsh',
          active: true,
          removable: false,
          preview: false,
        }],
      }),
    })
    renderRemoteCore()

    const list = await screen.findByTestId('dsh-core-remote-list')
    const copy = await within(list).findByRole('button', { name: 'Copy path' })
    fireEvent.click(copy)
    expect(mocks.writeClipboardText).toHaveBeenCalledWith('/home/remote/.dsh-desktop/dependencies/dsh')
  })

  it('downloads a version and follows the task until it finishes', async () => {
    mocks.getCoreCurrent.mockResolvedValue({
      item: targetOf('build', {
        availability: 'present',
        slots: [{
          kind: 'installed',
          slotKey: 'dsh',
          version: '0.2.4',
          dir: '/home/remote/.dsh-desktop/dependencies/dsh',
          active: true,
          removable: false,
          preview: false,
        }],
      }),
    })
    mocks.postCoreInstall.mockResolvedValue({ taskId: 'task-1' })
    mocks.getCoreTasksEvents.mockResolvedValue({
      items: [
        { taskId: 'task-1', seq: 1, ts: '', state: 'running', stage: 'probe', line: '准备下载核心版本 dsh-0.2.6-1' },
        { taskId: 'task-1', seq: 2, ts: '', state: 'succeeded', stage: 'install', line: '已下载核心版本 dsh-0.2.6-1', terminal: 'success' },
      ],
    })
    renderRemoteCore()

    const list = await screen.findByTestId('dsh-core-remote-list')
    const downloads = await within(list).findAllByRole('button', { name: 'Download' })
    fireEvent.click(downloads[0])

    await waitFor(() => expect(mocks.postCoreInstall).toHaveBeenCalledWith({ machineId: 'build', tag: 'dsh-0.2.6-1' }))
    await waitFor(() => expect(mocks.getCoreTasksEvents).toHaveBeenCalledWith({ taskId: 'task-1' }))
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Downloaded version 0.2.6'))
  })

  it('reports a failed download with the reason from the task', async () => {
    mocks.getCoreCurrent.mockResolvedValue({
      item: targetOf('build', {
        availability: 'present',
        slots: [{
          kind: 'installed',
          slotKey: 'dsh',
          version: '0.2.4',
          dir: '/home/remote/.dsh-desktop/dependencies/dsh',
          active: true,
          removable: false,
          preview: false,
        }],
      }),
    })
    mocks.postCoreInstall.mockResolvedValue({ taskId: 'task-2' })
    mocks.getCoreTasksEvents.mockResolvedValue({
      items: [
        { taskId: 'task-2', seq: 1, ts: '', state: 'failed', stage: 'failed', line: '安装失败', terminal: 'failed', reason: 'REMOTE_CORE_INSTALL_FAILED' },
      ],
    })
    renderRemoteCore()

    const list = await screen.findByTestId('dsh-core-remote-list')
    const downloads = await within(list).findAllByRole('button', { name: 'Download' })
    fireEvent.click(downloads[0])

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Failed to download the core version', expect.objectContaining({ variant: 'danger' })))
  })

  it('confirms and switches to a downloaded remote core version', async () => {
    mocks.getCoreCurrent.mockResolvedValue({
      item: targetOf('build', {
        availability: 'present',
        slots: [
          {
            kind: 'installed',
            slotKey: 'dsh',
            version: '0.2.4',
            dir: '/home/remote/.dsh-desktop/dependencies/dsh',
            active: true,
            removable: false,
            preview: false,
          },
          {
            kind: 'installed',
            slotKey: 'dsh-0.2.6-1',
            tag: 'dsh-0.2.6-1',
            version: '0.2.6',
            dir: '/home/remote/.dsh-desktop/dependencies/dsh-0.2.6-1',
            active: false,
            removable: true,
            preview: false,
          },
        ],
      }),
    })
    mocks.postCoreSwitch.mockResolvedValue({ taskId: 'task-switch' })
    mocks.getCoreTasksEvents.mockResolvedValue({
      items: [
        { taskId: 'task-switch', seq: 1, ts: '', state: 'running', stage: 'switch', line: '停止远端核心实例' },
        { taskId: 'task-switch', seq: 2, ts: '', state: 'succeeded', stage: 'switch', line: '核心已切换至 0.2.6', terminal: 'success' },
      ],
    })
    renderRemoteCore()

    const list = await screen.findByTestId('dsh-core-remote-list')
    fireEvent.click(await within(list).findByRole('checkbox', { name: '0.2.6' }))

    await waitFor(() => expect(mocks.openDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Switch version',
      description: expect.anything(),
    })))
    await waitFor(() => expect(mocks.postCoreSwitch).toHaveBeenCalledWith({ machineId: 'build', slotKey: 'dsh-0.2.6-1' }))
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Switched to 0.2.6', {
      variant: 'accent',
      description: 'Core switched — restarting the service…',
      timeout: 10_000,
    }))
  })

  it('does not switch when the remote core confirmation is dismissed', async () => {
    mocks.getCoreCurrent.mockResolvedValue({
      item: targetOf('build', {
        availability: 'present',
        slots: [
          {
            kind: 'installed',
            slotKey: 'dsh',
            version: '0.2.4',
            dir: '/home/remote/.dsh-desktop/dependencies/dsh',
            active: true,
            removable: false,
            preview: false,
          },
          {
            kind: 'installed',
            slotKey: 'dsh-0.2.6-1',
            tag: 'dsh-0.2.6-1',
            version: '0.2.6',
            dir: '/home/remote/.dsh-desktop/dependencies/dsh-0.2.6-1',
            active: false,
            removable: true,
            preview: false,
          },
        ],
      }),
    })
    mocks.openDialog.mockRejectedValue(new Error('cancelled'))
    renderRemoteCore()

    const list = await screen.findByTestId('dsh-core-remote-list')
    fireEvent.click(await within(list).findByRole('checkbox', { name: '0.2.6' }))

    await waitFor(() => expect(mocks.openDialog).toHaveBeenCalledOnce())
    expect(mocks.postCoreSwitch).not.toHaveBeenCalled()
  })

  it('does not allow another download while one machine is already downloading', async () => {
    mocks.getCoreCurrent.mockImplementation(async ({ machineId }: { machineId: string }) => ({
      item: targetOf(machineId, {
        availability: 'present',
        slots: [{
          kind: 'installed',
          slotKey: 'dsh',
          version: '0.2.4',
          dir: `/home/remote/${machineId}/.dsh-desktop/dependencies/dsh`,
          active: true,
          removable: false,
          preview: false,
        }],
      }),
    }))
    mocks.postCoreInstall.mockResolvedValue({ taskId: 'task-pending' })
    mocks.getCoreTasksEvents.mockImplementation(() => new Promise(() => {}))
    const view = renderRemoteCore('build')

    const firstList = await screen.findByTestId('dsh-core-remote-list')
    fireEvent.click((await within(firstList).findAllByRole('button', { name: 'Download' }))[0])
    await waitFor(() => expect(mocks.postCoreInstall).toHaveBeenCalledWith({ machineId: 'build', tag: 'dsh-0.2.6-1' }))
    await waitFor(() => expect(mocks.getCoreTasksEvents).toHaveBeenCalledWith({ taskId: 'task-pending' }))

    view.rerender(remoteCoreUi('ops', view.client))
    await waitFor(() => expect(mocks.getCoreCurrent).toHaveBeenCalledWith({ machineId: 'ops' }))
    const secondList = await screen.findByTestId('dsh-core-remote-list')
    const downloads = await within(secondList).findAllByRole('button', { name: 'Download' })
    expect(downloads.every(button =>
      (button as HTMLButtonElement).disabled
      || button.getAttribute('aria-disabled') === 'true'
      || button.getAttribute('data-disabled') === 'true')).toBe(true)
    fireEvent.click(downloads[0])
    expect(mocks.postCoreInstall).toHaveBeenCalledTimes(1)
  })

  it('keeps watching the same task when reading the task events fails transiently', async () => {
    mocks.getCoreCurrent.mockResolvedValue({
      item: targetOf('build', {
        availability: 'present',
        slots: [
          {
            kind: 'installed',
            slotKey: 'dsh',
            version: '0.2.4',
            dir: '/home/remote/.dsh-desktop/dependencies/dsh',
            active: true,
            removable: false,
            preview: false,
          },
          {
            kind: 'installed',
            slotKey: 'dsh-0.2.6-1',
            tag: 'dsh-0.2.6-1',
            version: '0.2.6',
            dir: '/home/remote/.dsh-desktop/dependencies/dsh-0.2.6-1',
            active: false,
            removable: true,
            preview: false,
          },
        ],
      }),
    })
    mocks.postCoreSwitch.mockResolvedValue({ taskId: 'task-retry' })
    mocks.getCoreTasksEvents
      .mockResolvedValueOnce({ error: 'REMOTE_TASK_READ_FAILED' })
      .mockResolvedValue({
        items: [
          { taskId: 'task-retry', seq: 1, ts: '', state: 'succeeded', stage: 'switch', line: '核心已切换至 0.2.6', terminal: 'success' },
        ],
      })
    renderRemoteCore()

    const list = await screen.findByTestId('dsh-core-remote-list')
    fireEvent.click(await within(list).findByRole('checkbox', { name: '0.2.6' }))

    await waitFor(() => expect(mocks.postCoreSwitch).toHaveBeenCalledTimes(1), { timeout: 15_000 })
    await waitFor(() => expect(mocks.getCoreTasksEvents).toHaveBeenCalledTimes(2), { timeout: 15_000 })
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Switched to 0.2.6', expect.objectContaining({ variant: 'accent' })), { timeout: 15_000 })
    expect(mocks.toast).not.toHaveBeenCalledWith('Failed to switch the core', expect.anything())
    expect(mocks.toast).not.toHaveBeenCalledWith('Switch result unknown', expect.anything())
  })

  it('reports an unknown switch result and checks the same task again instead of switching twice', async () => {
    mocks.getCoreCurrent.mockResolvedValue({
      item: targetOf('build', {
        availability: 'present',
        slots: [
          {
            kind: 'installed',
            slotKey: 'dsh',
            version: '0.2.4',
            dir: '/home/remote/.dsh-desktop/dependencies/dsh',
            active: true,
            removable: false,
            preview: false,
          },
          {
            kind: 'installed',
            slotKey: 'dsh-0.2.6-1',
            tag: 'dsh-0.2.6-1',
            version: '0.2.6',
            dir: '/home/remote/.dsh-desktop/dependencies/dsh-0.2.6-1',
            active: false,
            removable: true,
            preview: false,
          },
        ],
      }),
    })
    mocks.postCoreSwitch.mockResolvedValue({ taskId: 'task-unknown' })
    mocks.getCoreTasksEvents.mockResolvedValue({ error: 'REMOTE_TASK_READ_FAILED' })
    renderRemoteCore()

    const list = await screen.findByTestId('dsh-core-remote-list')
    fireEvent.click(await within(list).findByRole('checkbox', { name: '0.2.6' }))

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Switch result unknown', expect.objectContaining({ variant: 'warning' })), { timeout: 20_000 })
    expect(mocks.toast).not.toHaveBeenCalledWith('Failed to switch the core', expect.anything())

    const recheck = await within(list).findByRole('button', { name: 'Check again' })
    mocks.getCoreTasksEvents.mockResolvedValue({
      items: [
        { taskId: 'task-unknown', seq: 1, ts: '', state: 'succeeded', stage: 'switch', line: '核心已切换至 0.2.6', terminal: 'success' },
      ],
    })
    fireEvent.click(recheck)

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Switched to 0.2.6', expect.objectContaining({ variant: 'accent' })), { timeout: 15_000 })
    expect(mocks.postCoreSwitch).toHaveBeenCalledTimes(1)
    expect(mocks.getCoreTasksEvents).toHaveBeenLastCalledWith({ taskId: 'task-unknown' })
  })

  it('reports an unreadable target instead of an empty list', async () => {
    mocks.getCoreCurrent.mockResolvedValue({
      item: targetOf('build', {
        availability: 'unreadable',
        error: 'REMOTE_DSH_PACKAGE_UNREADABLE: permission denied',
        slots: [],
      }),
    })
    renderRemoteCore()

    expect(await screen.findByText('Remote core information is unavailable')).toBeTruthy()
    expect(screen.getByText('REMOTE_DSH_PACKAGE_UNREADABLE: permission denied')).toBeTruthy()
  })

  it('keeps the pending switch task instead of overwriting it with another switch', async () => {
    mocks.getCoreCurrent.mockResolvedValue({ item: twoCopiesTarget() })
    mocks.postCoreSwitch.mockResolvedValue({ taskId: 'task-unknown' })
    mocks.getCoreTasksEvents.mockResolvedValue({ error: 'REMOTE_TASK_READ_FAILED' })
    renderRemoteCore()

    const list = await screen.findByTestId('dsh-core-remote-list')
    fireEvent.click(await within(list).findByRole('checkbox', { name: '0.2.6' }))
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Switch result unknown', expect.objectContaining({ variant: 'warning' })), { timeout: 20_000 })

    // 结果未知时这台机器不能再来一次切换：原任务还要留着让用户查结果。
    const other = await within(list).findByRole('checkbox', { name: '0.2.5-beta.1' })
    expect(isDisabled(other)).toBe(true)
    fireEvent.click(other)
    expect(mocks.postCoreSwitch).toHaveBeenCalledTimes(1)

    // 原任务没被覆盖，还能按同一个任务号查结果。
    const recheck = await within(list).findByRole('button', { name: 'Check again' })
    mocks.getCoreTasksEvents.mockResolvedValue({
      items: [
        { taskId: 'task-unknown', seq: 1, ts: '', state: 'succeeded', stage: 'switch', line: '核心已切换至 0.2.6', terminal: 'success' },
      ],
    })
    fireEvent.click(recheck)
    await waitFor(() => expect(mocks.getCoreTasksEvents).toHaveBeenLastCalledWith({ taskId: 'task-unknown' }))
    expect(mocks.postCoreSwitch).toHaveBeenCalledTimes(1)
  })

  it('keeps the re-check entry available when the version list cannot be read', async () => {
    mocks.getCoreCurrent.mockResolvedValue({ item: twoCopiesTarget() })
    mocks.postCoreSwitch.mockResolvedValue({ taskId: 'task-unknown' })
    mocks.getCoreTasksEvents.mockResolvedValue({ error: 'REMOTE_TASK_READ_FAILED' })
    const view = renderRemoteCore()

    const list = await screen.findByTestId('dsh-core-remote-list')
    fireEvent.click(await within(list).findByRole('checkbox', { name: '0.2.6' }))
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Switch result unknown', expect.objectContaining({ variant: 'warning' })), { timeout: 20_000 })

    // 远端又读不出来了：清单没了，重查入口还得能用。
    mocks.getCoreCurrent.mockResolvedValue({
      item: targetOf('build', {
        availability: 'unreadable',
        error: 'REMOTE_DSH_PACKAGE_UNREADABLE: permission denied',
        slots: [],
      }),
    })
    await view.client.invalidateQueries({ queryKey: queryKeys.remoteCoreTarget('build') })
    expect(await screen.findByText('Remote core information is unavailable')).toBeTruthy()

    const recheck = await screen.findByRole('button', { name: 'Check again' })
    mocks.getCoreTasksEvents.mockResolvedValue({
      items: [
        { taskId: 'task-unknown', seq: 1, ts: '', state: 'succeeded', stage: 'switch', line: '核心已切换至 0.2.6', terminal: 'success' },
      ],
    })
    fireEvent.click(recheck)
    await waitFor(() => expect(mocks.getCoreTasksEvents).toHaveBeenLastCalledWith({ taskId: 'task-unknown' }))
    // 重查只读原任务，不会再发一次切换。
    expect(mocks.postCoreSwitch).toHaveBeenCalledTimes(1)
  })
})
