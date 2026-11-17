// @vitest-environment jsdom
import type { GetApiTauriRemoteCoreCurrentResponse } from '@/apis/remote.types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import enUS from '@/i18n/locales/en-US.json'
import { RemoteCoreList } from './remote-core'

const mocks = vi.hoisted(() => ({
  getCoreCurrent: vi.fn(),
  getCoreProfiles: vi.fn(),
  getCoreTasksEvents: vi.fn(),
  getCoreVersions: vi.fn(),
  loadRemoteMachines: vi.fn(),
  postCoreInstall: vi.fn(),
  writeClipboardText: vi.fn(),
  toast: vi.fn(),
}))

vi.mock('@/apis/remote', () => ({
  getCoreCurrent: mocks.getCoreCurrent,
  getCoreProfiles: mocks.getCoreProfiles,
  getCoreTasksEvents: mocks.getCoreTasksEvents,
  getCoreVersions: mocks.getCoreVersions,
  postCoreInstall: mocks.postCoreInstall,
}))
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
    capabilities: ['listVersions', 'installVersion'],
    platforms: ['linux-x64'],
    ...target,
  } as CoreTarget
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
})
