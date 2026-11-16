// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/config/query-keys'
import enUS from '@/i18n/locales/en-US.json'
import { RemoteProfileSection } from './remote-profile'

const mocks = vi.hoisted(() => ({
  getCoreProfiles: vi.fn(),
  loadRemoteMachines: vi.fn(),
}))

vi.mock('@/apis/remote', () => ({ getCoreProfiles: mocks.getCoreProfiles }))
vi.mock('@/hooks/use-remote', () => ({
  dotClassOf: () => 'bg-success',
  loadRemoteMachines: mocks.loadRemoteMachines,
}))

const clients = new Set<QueryClient>()
let translations = createInstance()

function renderRemoteProfiles() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.add(client)
  const view = render(
    <I18nextProvider i18n={translations}>
      <QueryClientProvider client={client}>
        <RemoteProfileSection />
      </QueryClientProvider>
    </I18nextProvider>,
  )
  return { client, ...view }
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

describe('远端 Profile 只读列表', () => {
  it('shows every remote machine and marks the configured profile without exposing writes', async () => {
    renderRemoteProfiles()

    expect(await screen.findByTestId('dsh-profile-remote-machine-build')).toBeTruthy()
    expect(screen.getByTestId('dsh-profile-remote-machine-ops')).toBeTruthy()
    expect(screen.getByTestId('dsh-profile-remote-build-remote')).toBeTruthy()
    expect(screen.getByTestId('dsh-profile-remote-build-build-alt')).toBeTruthy()
    expect(screen.getByTestId('dsh-profile-remote-ops-ops-alt')).toBeTruthy()
    expect(screen.getAllByText('configured')).toHaveLength(2)
    expect(screen.getByText('Read only')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'profiles.remove' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'profiles.clone' })).toBeNull()
  })

  it('filters the profile list through the shared machine picker', async () => {
    renderRemoteProfiles()

    expect(await screen.findByTestId('dsh-profile-remote-machine-build')).toBeTruthy()
    fireEvent.click(screen.getByTestId('dsh-profile-remote-target'))
    const menu = await screen.findByRole('menu')
    fireEvent.click(within(menu).getByText('Ops box'))

    await waitFor(() => expect(screen.queryByTestId('dsh-profile-remote-machine-build')).toBeNull())
    expect(screen.getByTestId('dsh-profile-remote-machine-ops')).toBeTruthy()
  })

  it('clears a stale machine filter after the selected machine disappears', async () => {
    const { client } = renderRemoteProfiles()

    expect(await screen.findByTestId('dsh-profile-remote-machine-build')).toBeTruthy()
    fireEvent.click(screen.getByTestId('dsh-profile-remote-target'))
    fireEvent.click(within(await screen.findByRole('menu')).getByText('Ops box'))
    await waitFor(() => expect(screen.queryByTestId('dsh-profile-remote-machine-build')).toBeNull())

    mocks.loadRemoteMachines.mockResolvedValue({
      enabled: true,
      machines: [{ id: 'build', name: 'Build box', state: 'connected' }],
    })
    await client.invalidateQueries({ queryKey: queryKeys.remoteMachines })

    expect(await screen.findByTestId('dsh-profile-remote-machine-build')).toBeTruthy()
    expect(screen.queryByTestId('dsh-profile-remote-machine-ops')).toBeNull()
    expect(screen.getByTestId('dsh-profile-remote-target').textContent).toContain('All remote machines')
  })

  it('stays hidden when the remote API is unavailable', async () => {
    mocks.loadRemoteMachines.mockResolvedValue({ enabled: false, machines: [] })
    renderRemoteProfiles()

    await waitFor(() => expect(mocks.loadRemoteMachines).toHaveBeenCalledOnce())
    expect(screen.queryByTestId('dsh-profile-remote-section')).toBeNull()
  })
})
