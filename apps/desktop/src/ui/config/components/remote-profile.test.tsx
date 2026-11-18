// @vitest-environment jsdom
import type { RemoteMachineRow } from '@/hooks/use-remote'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import enUS from '@/i18n/locales/en-US.json'
import { RemoteProfileSection } from './remote-profile'

const mocks = vi.hoisted(() => ({ getCoreProfiles: vi.fn() }))

vi.mock('@/apis/remote', () => ({ getCoreProfiles: mocks.getCoreProfiles }))

const clients = new Set<QueryClient>()
let translations = createInstance()

const MACHINE = { id: 'build', name: 'Build box', state: 'connected' } as RemoteMachineRow

function renderRemoteProfiles(machine: RemoteMachineRow = MACHINE) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.add(client)
  const view = render(
    <I18nextProvider i18n={translations}>
      <QueryClientProvider client={client}>
        <RemoteProfileSection machine={machine} />
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
  mocks.getCoreProfiles.mockResolvedValue({
    items: [
      { name: 'remote', configured: true },
      { name: 'build-alt', configured: false },
    ],
  })
})

afterEach(() => {
  cleanup()
  for (const client of clients)
    client.clear()
  clients.clear()
  vi.restoreAllMocks()
})

describe('远端 Profile 只读列表', () => {
  it('shows the profiles of the selected machine and marks the configured one without exposing writes', async () => {
    renderRemoteProfiles()

    expect(await screen.findByTestId('dsh-profile-remote-build-remote')).toBeTruthy()
    expect(screen.getByTestId('dsh-profile-remote-build-build-alt')).toBeTruthy()
    expect(screen.getAllByText('configured')).toHaveLength(1)
    expect(screen.getByText('Read only')).toBeTruthy()
    expect(screen.getByText('Build box')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'profiles.remove' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'profiles.clone' })).toBeNull()
  })

  it('reads only the selected machine', async () => {
    renderRemoteProfiles()

    await screen.findByTestId('dsh-profile-remote-build-remote')
    expect(mocks.getCoreProfiles).toHaveBeenCalledWith({ machineId: 'build' })
  })

  it('shows an empty state when the machine has no profiles', async () => {
    mocks.getCoreProfiles.mockResolvedValue({ items: [] })
    renderRemoteProfiles()

    const empty = await screen.findByText('No profiles on this machine')
    // 空状态确实可见，而不是留在页面里的隐藏节点
    expect(empty.closest('[hidden]')).toBeNull()
    expect(getComputedStyle(empty).display).not.toBe('none')
    expect(getComputedStyle(empty).visibility).not.toBe('hidden')
    // 档案列表没有残留
    expect(screen.queryByTestId('dsh-profile-remote-build-remote')).toBeNull()
  })

  it('re-reads the remote profiles when the refresh button is pressed', async () => {
    renderRemoteProfiles()

    await screen.findByTestId('dsh-profile-remote-build-remote')
    expect(mocks.getCoreProfiles).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Refresh remote profiles' }))
    await waitFor(() => expect(mocks.getCoreProfiles).toHaveBeenCalledTimes(2))
  })

  it('reports a failed read instead of showing an empty list', async () => {
    mocks.getCoreProfiles.mockRejectedValue(new Error('REMOTE_UNREACHABLE'))
    renderRemoteProfiles()

    expect(await screen.findByText(/REMOTE_UNREACHABLE/)).toBeTruthy()
    expect(screen.queryByText('No profiles on this machine')).toBeNull()
  })
})
