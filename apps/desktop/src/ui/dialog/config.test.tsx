// @vitest-environment jsdom
import type { ConfigTab } from './config'
import { OverlaysProvider, useOverlay } from '@overlastic/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import enUS from '@/i18n/locales/en-US.json'
import { ConfigDialog } from './config'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  remoteMachineId: null as string | null,
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@/hooks/use-remote-shell', () => ({ useRemoteShellMachine: () => mocks.remoteMachineId }))
vi.mock('@/ui/config/appearance', () => ({ ConfigAppearance: () => <div data-testid="config-appearance" /> }))
vi.mock('@/ui/config/core', () => ({ ConfigCore: () => <div data-testid="config-core-local" /> }))
vi.mock('@/ui/config/components/remote-core', () => ({
  RemoteCoreSection: ({ machineId }: { machineId: string }) => <div data-testid="config-core-remote">{machineId}</div>,
}))
vi.mock('@/ui/config/data-dir', () => ({ ConfigDataDir: () => <div data-testid="config-data-dir" /> }))
vi.mock('@/ui/config/debug', () => ({ ConfigDebug: () => <div data-testid="config-debug" /> }))
vi.mock('@/ui/config/plugin', () => ({ ConfigPlugin: () => <div data-testid="config-plugin" /> }))
vi.mock('@/ui/config/profile', () => ({ ConfigProfile: () => <div data-testid="config-profile" /> }))

let client: QueryClient
let translations = createInstance()

function Launcher({ tab }: { tab: ConfigTab }) {
  const open = useOverlay(ConfigDialog)
  return (
    <button onClick={() => { void open({ tab }).catch(() => {}) }}>
      open config
    </button>
  )
}

async function openConfig(tab: ConfigTab) {
  render(
    <I18nextProvider i18n={translations}>
      <QueryClientProvider client={client}>
        <OverlaysProvider>
          <Launcher tab={tab} />
        </OverlaysProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  )
  fireEvent.click(screen.getByText('open config'))
  await screen.findByTestId('dsh-config-dialog')
}

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.remoteMachineId = null
  mocks.invoke.mockResolvedValue([])
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  translations = createInstance()
  await translations.init({
    lng: 'en-US',
    fallbackLng: 'en-US',
    resources: { 'en-US': { translation: enUS } },
    interpolation: { escapeValue: false },
  })
})

afterEach(() => {
  cleanup()
  client.clear()
  vi.restoreAllMocks()
})

describe('配置面板的核心页', () => {
  it('shows the remote core panel for the machine the window is attached to', async () => {
    mocks.remoteMachineId = 'build'
    await openConfig('harness')

    expect((await screen.findByTestId('config-core-remote')).textContent).toBe('build')
    expect(screen.queryByTestId('config-core-local')).toBeNull()
    expect(screen.queryByTestId('remote-unsupported')).toBeNull()
  })

  it('keeps the local core panel when the window runs the local harness', async () => {
    await openConfig('harness')

    expect(await screen.findByTestId('config-core-local')).toBeTruthy()
    expect(screen.queryByTestId('config-core-remote')).toBeNull()
  })

  it('still reports the unsupported notice for the tabs that manage local state', async () => {
    mocks.remoteMachineId = 'build'
    await openConfig('plugins')

    expect(await screen.findByTestId('remote-unsupported')).toBeTruthy()
    expect(screen.getByTestId('dsh-config-panel-title').textContent).toBe('Plugins')
    expect(screen.queryByTestId('config-plugin')).toBeNull()

    fireEvent.click(screen.getByTestId('dsh-config-nav-dataDir'))
    await waitFor(() => expect(screen.getByTestId('dsh-config-panel-title').textContent).toBe('Data Directory'))
    expect(screen.queryByTestId('config-data-dir')).toBeNull()
  })
})
