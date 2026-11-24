// @vitest-environment jsdom
import type { GetApiTauriRemoteCoreCurrentResponse } from '@/apis/remote.types'
import type { RemoteMachineRow } from '@/hooks/use-remote'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import enUS from '@/i18n/locales/en-US.json'
import { RemoteApplication } from './remote-application'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getCoreCurrent: vi.fn(),
  loadRemoteMachines: vi.fn(),
  postMachinesDisconnect: vi.fn(),
  postMachinesRestart: vi.fn(),
  writeClipboardText: vi.fn(),
  toast: vi.fn(),
  reload: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@/apis/remote', () => ({
  getCoreCurrent: mocks.getCoreCurrent,
  postMachinesDisconnect: mocks.postMachinesDisconnect,
  postMachinesRestart: mocks.postMachinesRestart,
}))
vi.mock('@/hooks/use-remote', () => ({ loadRemoteMachines: mocks.loadRemoteMachines }))
vi.mock('@/utils/clipboard', () => ({ writeClipboardText: mocks.writeClipboardText }))
vi.mock('@/utils/toast', () => ({ toast: mocks.toast }))
vi.mock('@/i18n', () => ({ changeLanguage: vi.fn(async () => {}) }))
vi.mock('@/ui/config/components/auto-update', () => ({ ConfigAutoUpdate: () => null }))
vi.mock('@/ui/config/components/launch-on-login', () => ({ ConfigLaunchOnLogin: () => null }))
vi.mock('@/ui/config/components/close-action', () => ({ ConfigCloseAction: () => null }))

type CoreTarget = NonNullable<GetApiTauriRemoteCoreCurrentResponse['item']>

const TUNNEL = 'http://127.0.0.1:41234'

const clients = new Set<QueryClient>()
let translations = createInstance()

function machineOf(overrides: Partial<RemoteMachineRow> = {}): RemoteMachineRow {
  return { id: 'build', name: 'Build box', state: 'connected', tunnelBaseUrl: TUNNEL, ...overrides }
}

function targetOf(overrides: Record<string, unknown> = {}): CoreTarget {
  return {
    id: 'remote:build:remote',
    scope: 'remote',
    machineId: 'build',
    remoteProfile: 'remote',
    capabilities: ['listVersions', 'installVersion'],
    platforms: ['linux-x64'],
    availability: 'present',
    slots: [
      { kind: 'installed', slotKey: 'dsh-0.32.0', version: '0.32.0', active: false },
      { kind: 'installed', slotKey: 'dsh', version: '0.33.1', active: true },
    ],
    ...overrides,
  } as CoreTarget
}

function addressInput(): HTMLInputElement {
  return screen.getByTestId('dsh-config-remote-address') as HTMLInputElement
}

function renderRemoteApplication(machineId = 'build') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.add(client)
  const view = render(
    <I18nextProvider i18n={translations}>
      <QueryClientProvider client={client}>
        <RemoteApplication machineId={machineId} />
      </QueryClientProvider>
    </I18nextProvider>,
  )
  return { client, ...view }
}

beforeEach(async () => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'location', { configurable: true, writable: true, value: { reload: mocks.reload } })
  translations = createInstance()
  await translations.init({
    lng: 'en-US',
    fallbackLng: 'en-US',
    resources: { 'en-US': { translation: enUS } },
    interpolation: { escapeValue: false },
  })
  mocks.invoke.mockResolvedValue(undefined)
  mocks.getCoreCurrent.mockResolvedValue({ item: targetOf() })
  mocks.loadRemoteMachines.mockResolvedValue({ enabled: true, machines: [machineOf()] })
  mocks.postMachinesDisconnect.mockResolvedValue({})
  mocks.postMachinesRestart.mockResolvedValue({})
  mocks.writeClipboardText.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  for (const client of clients)
    client.clear()
  clients.clear()
  vi.restoreAllMocks()
})

describe('远端窗口的「应用」面板', () => {
  it('shows the tunnel address of the remote machine instead of the local service address', async () => {
    renderRemoteApplication()

    await waitFor(() => expect(addressInput().value).toBe(TUNNEL))
    expect(screen.queryByDisplayValue('http://127.0.0.1:3080')).toBeNull()
  })

  it('reads the version of the active remote core slot', async () => {
    renderRemoteApplication()

    await waitFor(() => expect(screen.getByTestId('dsh-config-remote-version').textContent).toBe('0.33.1'))
    expect(screen.getByTestId('dsh-config-remote-profile').textContent).toBe('remote')
    expect(mocks.getCoreCurrent).toHaveBeenCalledWith({ machineId: 'build' })
  })

  it('shows the remote connection state rather than the local service state', async () => {
    mocks.loadRemoteMachines.mockResolvedValue({ enabled: true, machines: [machineOf({ state: 'reconnecting' })] })
    renderRemoteApplication()

    expect(await screen.findByText('Reconnecting')).toBeTruthy()
    expect(screen.queryByText('Running')).toBeNull()
  })

  it('reports a machine list read failure instead of claiming the machine is disconnected', async () => {
    mocks.loadRemoteMachines.mockRejectedValue(new Error('REMOTE_API_MISSING: 404'))
    renderRemoteApplication()

    expect(await screen.findByText('State unknown')).toBeTruthy()
    expect(screen.queryByText('Disconnected')).toBeNull()
    expect(await screen.findByText(/REMOTE_API_MISSING/)).toBeTruthy()
  })

  it('copies the tunnel address', async () => {
    renderRemoteApplication()

    await waitFor(() => expect(addressInput().value).toBe(TUNNEL))
    fireEvent.click(screen.getByTestId('dsh-config-remote-copy'))

    await waitFor(() => expect(mocks.writeClipboardText).toHaveBeenCalledWith(TUNNEL, expect.any(String)))
  })

  it('opens the tunnel address in the system browser', async () => {
    renderRemoteApplication()

    await waitFor(() => expect(addressInput().value).toBe(TUNNEL))
    fireEvent.click(screen.getByTestId('dsh-config-remote-open-browser'))

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('open_external_url', { url: TUNNEL }))
  })

  it('restarts the remote instance and reloads the document instead of restarting the local core', async () => {
    renderRemoteApplication()

    await waitFor(() => expect(addressInput().value).toBe(TUNNEL))
    fireEvent.click(screen.getByTestId('dsh-config-remote-restart'))

    await waitFor(() => expect(mocks.postMachinesRestart).toHaveBeenCalledWith({ machineId: 'build' }))
    await waitFor(() => expect(mocks.reload).toHaveBeenCalledOnce())
    expect(mocks.invoke).not.toHaveBeenCalledWith('begin_harness_restart', expect.anything())
    expect(mocks.invoke).not.toHaveBeenCalledWith('shutdown_harness', expect.anything())
  })

  it('keeps the page as is and reports a failed remote restart', async () => {
    mocks.postMachinesRestart.mockRejectedValue(new Error('REMOTE_INSTANCE_STOP_FAILED: 端口被占用'))
    renderRemoteApplication()

    await waitFor(() => expect(addressInput().value).toBe(TUNNEL))
    fireEvent.click(screen.getByTestId('dsh-config-remote-restart'))

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Could not restart the remote instance', expect.objectContaining({ variant: 'danger' })))
    expect(mocks.reload).not.toHaveBeenCalled()
  })

  it('returns this window to the local document before disconnecting the machine', async () => {
    const order: string[] = []
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'navigate_remote_harness') {
        order.push('navigate')
        return undefined
      }
    })
    mocks.postMachinesDisconnect.mockImplementation(async () => {
      order.push('disconnect')
      return {}
    })
    renderRemoteApplication()

    await waitFor(() => expect(addressInput().value).toBe(TUNNEL))
    fireEvent.click(screen.getByTestId('dsh-config-remote-disconnect'))

    await waitFor(() => expect(mocks.postMachinesDisconnect).toHaveBeenCalledWith({ machineId: 'build' }))
    expect(order).toEqual(['navigate', 'disconnect'])
  })

  it('does not disconnect the machine when the local navigation fails', async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'navigate_remote_harness')
        throw new Error('HARNESS_NAVIGATE_FAILED')
    })
    renderRemoteApplication()

    await waitFor(() => expect(addressInput().value).toBe(TUNNEL))
    fireEvent.click(screen.getByTestId('dsh-config-remote-disconnect'))

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Could not disconnect the remote machine', expect.objectContaining({ variant: 'danger' })))
    expect(mocks.postMachinesDisconnect).not.toHaveBeenCalled()
  })

  it('keeps the local core lifecycle out of the remote window', async () => {
    renderRemoteApplication()

    await waitFor(() => expect(addressInput().value).toBe(TUNNEL))
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    expect(screen.queryByTestId('dsh-config-reload-page')).toBeNull()
    expect(mocks.invoke).not.toHaveBeenCalledWith('get_runtime_info')
  })

  it('reports a failed remote core read instead of showing a stale version', async () => {
    mocks.getCoreCurrent.mockResolvedValue({ error: 'REMOTE_MACHINE_NOT_CONNECTED' })
    renderRemoteApplication()

    expect(await screen.findByText(/REMOTE_MACHINE_NOT_CONNECTED/)).toBeTruthy()
    expect(screen.getByTestId('dsh-config-remote-version').textContent).toBe('-')
  })
})
