// @vitest-environment jsdom
import type { GetApiTauriRemoteCoreCurrentResponse } from '@/apis/remote.types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import enUS from '@/i18n/locales/en-US.json'
import { RemoteCoreSection } from './remote-core'

const mocks = vi.hoisted(() => ({
  getCoreCurrent: vi.fn(),
  getCoreProfiles: vi.fn(),
  getCoreVersions: vi.fn(),
  loadRemoteMachines: vi.fn(),
}))

vi.mock('@/apis/remote', () => ({
  getCoreCurrent: mocks.getCoreCurrent,
  getCoreProfiles: mocks.getCoreProfiles,
  getCoreVersions: mocks.getCoreVersions,
}))
vi.mock('@/hooks/use-remote', () => ({ loadRemoteMachines: mocks.loadRemoteMachines }))

type CoreTarget = NonNullable<GetApiTauriRemoteCoreCurrentResponse['item']>
type CoreSlot = Extract<CoreTarget, { availability: 'present' }>['slots'][number]
type TargetState
  = | { availability: 'absent', slots: [] }
    | { availability: 'present', slots: CoreSlot[] }
    | { availability: 'unreadable', error: string, path?: string, slots: [] }

const clients = new Set<QueryClient>()
let translations = createInstance()

function renderRemoteCore() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.add(client)
  return render(
    <I18nextProvider i18n={translations}>
      <QueryClientProvider client={client}>
        <RemoteCoreSection />
      </QueryClientProvider>
    </I18nextProvider>,
  )
}

function targetOf(machineId: string, target: TargetState): CoreTarget {
  return {
    id: `remote:${machineId}:remote`,
    scope: 'remote',
    machineId,
    remoteProfile: 'remote',
    capabilities: ['listVersions'],
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
      { version: '0.2.4', tag: 'dsh-0.2.4-1', preview: false },
      { version: '0.2.5-beta.1', tag: 'dsh-0.2.5-beta.1-2', preview: true },
    ],
  })
  mocks.getCoreProfiles.mockImplementation(async ({ machineId }: { machineId: string }) => ({
    items: [
      { name: 'remote', configured: true },
      { name: `${machineId}-alt`, configured: false },
    ],
  }))
})

afterEach(() => {
  cleanup()
  for (const client of clients)
    client.clear()
  clients.clear()
  vi.restoreAllMocks()
})

describe('远端核心只读列表', () => {
  it('renders every slot state and exposes no core mutation controls', async () => {
    mocks.getCoreCurrent.mockImplementation(async ({ machineId }: { machineId: string }) => ({
      item: machineId === 'build'
        ? targetOf('build', {
            availability: 'present',
            slots: [
              {
                kind: 'installed',
                slotKey: 'current',
                version: '0.2.3',
                tag: 'dsh-0.2.3-1',
                active: true,
                preview: false,
              },
              {
                kind: 'unsupported',
                slotKey: 'old',
                version: '0.2.1',
                error: 'REMOTE_DSH_VERSION_UNSUPPORTED',
              },
              {
                kind: 'unreadable',
                slotKey: 'broken',
                error: 'REMOTE_DSH_PACKAGE_INVALID',
              },
            ],
          })
        : targetOf('ops', { availability: 'absent', slots: [] }),
    }))
    renderRemoteCore()

    expect(await screen.findByText('0.2.3')).toBeTruthy()
    expect(screen.getByTestId('dsh-core-remote-machine-build')).toBeTruthy()
    expect(screen.getByTestId('dsh-core-remote-machine-ops')).toBeTruthy()
    expect(screen.getByText('0.2.4')).toBeTruthy()
    expect(screen.getAllByText('Capabilities: listVersions').length).toBeGreaterThan(0)
    expect(screen.getByText('build-alt')).toBeTruthy()
    expect(screen.getByText('ops-alt')).toBeTruthy()
    expect(screen.getByText('Active')).toBeTruthy()
    expect(screen.getByText('Unsupported')).toBeTruthy()
    expect(screen.getByText('Unreadable')).toBeTruthy()
    expect(screen.getByText('Slot: current')).toBeTruthy()
    expect(screen.getByText('Slot: old')).toBeTruthy()
    expect(screen.getByText('Slot: broken')).toBeTruthy()
    expect(screen.getAllByText('Profile: remote').length).toBeGreaterThan(0)
    expect(screen.getByText('Read only')).toBeTruthy()
    expect(screen.getByText('Remote core is not installed')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Uninstall' })).toBeNull()
  })

  it('switches machines and distinguishes absent from unreadable targets', async () => {
    mocks.getCoreCurrent.mockImplementation(async ({ machineId }: { machineId: string }) => ({
      item: machineId === 'build'
        ? targetOf('build', { availability: 'absent', slots: [] })
        : targetOf('ops', {
            availability: 'unreadable',
            error: 'REMOTE_DSH_PACKAGE_UNREADABLE: permission denied',
            slots: [],
          }),
    }))
    renderRemoteCore()

    expect(await screen.findByText('Remote core is not installed')).toBeTruthy()
    const select = screen.getByTestId('dsh-core-remote-target')
      .closest('[data-slot="select"]')
      ?.querySelector('select')
    expect(select).not.toBeNull()
    fireEvent.change(select!, { target: { value: 'ops' } })

    await waitFor(() => expect(mocks.getCoreCurrent).toHaveBeenCalledWith({ machineId: 'ops' }))
    expect(await screen.findByText('Remote core information is unavailable')).toBeTruthy()
    expect(screen.getByText('REMOTE_DSH_PACKAGE_UNREADABLE: permission denied')).toBeTruthy()
  })

  it('stays hidden when the remote API is unavailable', async () => {
    mocks.loadRemoteMachines.mockResolvedValue({ enabled: false, machines: [] })
    renderRemoteCore()

    await waitFor(() => expect(mocks.loadRemoteMachines).toHaveBeenCalledOnce())
    expect(screen.queryByTestId('dsh-core-remote-section')).toBeNull()
  })

  it('shows an empty state when no remote machines are configured', async () => {
    mocks.loadRemoteMachines.mockResolvedValue({ enabled: true, machines: [] })
    renderRemoteCore()

    expect(await screen.findByText('No remote machines configured')).toBeTruthy()
    expect(screen.queryByTestId('dsh-core-remote-target')).toBeNull()
  })
})
