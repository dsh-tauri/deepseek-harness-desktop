// @vitest-environment jsdom
import type { SshKey } from '../locales/index'
import type { WireCall, WireReply } from '../test-utils/client-mock'
import type { MachineRow, RemoteBridge } from '../types/index'
import { fireEvent, screen, waitFor, within } from '@testing-library/dom'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { en } from '../locales/index'
import * as service from '../service/machines'
import { store } from '../store/index'
import { answer, replies, resetWire, sent } from '../test-utils/client-mock'
import { MachinesSection } from './machines-section'

const baseURL = '/api/tauri/ssh'

vi.mock('dsh-tauri-ui/client', async () => (await import('../test-utils/ui-mock')).uiMock)
vi.mock('dsh-tauri/client', async () => (await import('../test-utils/client-mock')).clientMock)

interface SavePayload {
  machineId: string
  row: Record<string, unknown>
  secrets?: Record<string, unknown>
}

const t = ((key: string) => (en as Record<string, string>)[key] ?? key) as (key: SshKey) => string

const unreachableBridge: RemoteBridge = {
  probe: () => Promise.reject(new Error('NODE_NOT_ANSWERED: invoke remote_bridge_ping timed out')),
  openWindow: () => Promise.reject(new Error('no bridge')),
}

function desktopBridge(openWindow: RemoteBridge['openWindow'] = vi.fn(async () => undefined)): RemoteBridge {
  return { probe: async () => true, openWindow }
}

const machineA: MachineRow = {
  id: 'a',
  name: 'alpha',
  host: '10.0.0.1',
  port: 22,
  user: 'root',
  hasPassword: true,
  hasPassphrase: false,
  remotePort: 3080,
}

let queued: WireReply[] = []
let route: (call: WireCall) => WireReply = () => replies.ok({ items: [] })

function once(...next: WireReply[]): void {
  queued.push(...next)
}

beforeEach(() => {
  resetWire()
  store.machines.reset()
  queued = []
  route = () => replies.ok({ items: [] })
  answer(call => queued.shift() ?? route(call))
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function mount(overrides: { value?: unknown, bridge?: RemoteBridge, route?: (call: WireCall) => WireReply } = {}) {
  if (overrides.route !== undefined)
    route = overrides.route
  else if (overrides.value !== undefined)
    route = () => replies.ok(overrides.value)
  return render(
    <MachinesSection t={t} {...overrides.bridge === undefined ? {} : { bridge: overrides.bridge }} />,
  )
}

describe('machinesSection', () => {
  it('renders the read-only SSH-in-progress banner on a remote target and hides management', async () => {
    mount({
      route: call => call.url === `${baseURL}/session/role`
        ? replies.ok({ remote: true, origin: 'ops' })
        : replies.ok({ items: [{ ...machineA, state: 'disconnected' }] }),
    })
    await waitFor(() => expect(screen.getByTestId('remote-session-banner')).toBeTruthy())
    expect(screen.getByText('Currently in an SSH session')).toBeTruthy()
    expect(screen.getByText(/over SSH from ops/)).toBeTruthy()
    expect(screen.getByTestId('remote-session-sync-hint').textContent).toContain('Sync to remote')
    expect(screen.queryByText('Add machine')).toBeNull()
    expect(screen.queryByText('Refresh')).toBeNull()
    expect(screen.queryByText(/Connect straight through your local/)).toBeNull()
    expect(screen.queryByTestId('machine-a')).toBeNull()
  })

  it('renders the loaded machine cards with statuses', async () => {
    mount({
      value: { items: [{ ...machineA, state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:49152' }] },
    })
    await waitFor(() => expect(screen.getByTestId('machine-a')).toBeTruthy())
    const card = screen.getByTestId('machine-a')
    expect(within(card).getByText('alpha')).toBeTruthy()
    expect(screen.getByTestId('status-a').textContent).toContain('Connected')
    expect(screen.getByText('http://127.0.0.1:49152')).toBeTruthy()
    fireEvent.click(withinButton(card, 'Edit'))
    expect(screen.getByPlaceholderText('set')).toBeTruthy()
    expect(sent.some(call => call.url === `${baseURL}/machines` && call.http === 'GET')).toBe(true)
  })

  it('opens the add dialog and saves the new machine immediately', async () => {
    mount()
    await waitFor(() => expect(screen.getByText(/No SSH machines yet/)).toBeTruthy())
    fireEvent.click(screen.getByText('Add machine'))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Add machine' })).toBeTruthy())
    const dialog = within(screen.getByRole('dialog', { name: 'Add machine' }))
    fireEvent.change(dialog.getByLabelText('Host or config alias'), { target: { value: 'ops@10.1.1.1' } })
    fireEvent.change(dialog.getByLabelText('Name'), { target: { value: 'newton' } })
    fireEvent.change(dialog.getByLabelText('User (optional)'), { target: { value: 'ops' } })
    expect(dialog.getByLabelText('ID')).toHaveProperty('value', '10-1-1-1')
    once(replies.ok({}))
    once(replies.ok({
      items: [{ id: '10-1-1-1', name: 'newton', host: 'ops@10.1.1.1', port: 22, user: 'ops', hasPassword: false, hasPassphrase: false, remotePort: 3080, state: 'disconnected' }],
    }))
    fireEvent.click(dialog.getByText('Add & save'))
    await waitFor(() => expect(savePayloads()).toHaveLength(1))
    const payload = savePayloads()[0]
    expect(payload?.machineId).toBe('10-1-1-1')
    expect(payload?.row).toMatchObject({ name: 'newton', host: 'ops@10.1.1.1', user: 'ops' })
    const card = await screen.findByTestId('machine-10-1-1-1')
    expect(screen.queryByRole('dialog', { name: 'Add machine' })).toBeNull()
    fireEvent.click(withinButton(card, 'Edit'))
    expect(within(screen.getByTestId('editor-10-1-1-1')).getByLabelText('Name')).toHaveProperty('value', 'newton')
  })

  it('derives a unique auto id and validates taken ids inline', async () => {
    mount({ value: { items: [{ ...machineA, state: 'disconnected' }] } })
    await waitFor(() => expect(screen.getByText('alpha')).toBeTruthy())
    fireEvent.click(screen.getByText('Add machine'))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Add machine' })).toBeTruthy())
    const dialog = within(screen.getByRole('dialog', { name: 'Add machine' }))
    fireEvent.change(dialog.getByLabelText('Host or config alias'), { target: { value: 'alpha.internal' } })
    expect(dialog.getByLabelText('ID')).toHaveProperty('value', 'alpha-internal')
    fireEvent.change(dialog.getByLabelText('ID'), { target: { value: 'a' } })
    await waitFor(() => expect(dialog.getByText('ID already in use')).toBeTruthy())
    expect(dialog.getByText('Add & save').closest('button')?.hasAttribute('disabled')).toBe(true)
  })

  it('blocks submit while the host is empty', async () => {
    mount()
    await waitFor(() => expect(screen.getByText(/No SSH machines yet/)).toBeTruthy())
    fireEvent.click(screen.getByText('Add machine'))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Add machine' })).toBeTruthy())
    const dialog = within(screen.getByRole('dialog', { name: 'Add machine' }))
    expect(dialog.getByText('Host is required')).toBeTruthy()
    expect(dialog.getByText('Add & save').closest('button')?.hasAttribute('disabled')).toBe(true)
  })

  it('persists edits through the store', async () => {
    mount({ value: { items: [{ ...machineA, state: 'disconnected' }] } })
    await waitFor(() => expect(screen.getByTestId('machine-a')).toBeTruthy())
    const card = screen.getByTestId('machine-a')
    fireEvent.click(withinButton(card, 'Edit'))
    const editor = screen.getByTestId('editor-a')
    fireEvent.change(within(editor).getByLabelText('Name'), { target: { value: 'alpha-2' } })
    fireEvent.change(within(editor).getByLabelText('Password (optional)'), { target: { value: 'sekrit' } })
    fireEvent.click(within(editor).getByText('Save'))
    await waitFor(() => expect(savePayloads()).toHaveLength(1))
    const payload = savePayloads()[0]
    expect(payload?.row).toMatchObject({ name: 'alpha-2' })
    expect(payload?.secrets).toMatchObject({ password: 'sekrit' })
    await waitFor(() => expect(screen.queryByTestId('editor-a')).toBeNull())
  })

  it('keeps the open draft across refresh and discards it on cancel before reopening the latest saved row', async () => {
    mount({ value: { items: [{ ...machineA, state: 'disconnected' }] } })
    const card = await screen.findByTestId('machine-a')
    fireEvent.click(withinButton(card, 'Edit'))
    const editor = within(screen.getByTestId('editor-a'))
    fireEvent.change(editor.getByLabelText('Name'), { target: { value: 'unsaved' } })
    fireEvent.change(editor.getByLabelText('Password (optional)'), { target: { value: 'unsaved-secret' } })
    fireEvent.change(editor.getByLabelText('Key passphrase (optional)'), { target: { value: 'unsaved-phrase' } })

    route = () => replies.ok({ items: [{ ...machineA, name: 'refreshed', hasPassword: false, hasPassphrase: true, state: 'disconnected' }] })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(within(card).getByText('refreshed')).toBeTruthy())
    expect(editor.getByLabelText('Name')).toHaveProperty('value', 'unsaved')
    expect(editor.getByLabelText('Password (optional)')).toHaveProperty('value', 'unsaved-secret')
    expect(editor.getByLabelText('Password (optional)').getAttribute('placeholder')).toBe('not set')
    expect(editor.getByLabelText('Key passphrase (optional)')).toHaveProperty('value', 'unsaved-phrase')
    expect(editor.getByLabelText('Key passphrase (optional)').getAttribute('placeholder')).toBe('set')

    fireEvent.click(editor.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('editor-a')).toBeNull()
    fireEvent.click(withinButton(card, 'Edit'))
    const reopened = within(screen.getByTestId('editor-a'))
    expect(reopened.getByLabelText('Name')).toHaveProperty('value', 'refreshed')
    expect(reopened.getByLabelText('Password (optional)')).toHaveProperty('value', '')
    expect(reopened.getByLabelText('Key passphrase (optional)')).toHaveProperty('value', '')
    expect(savePayloads()).toHaveLength(0)
  })

  it('removes a machine immediately through the confirmation modal', async () => {
    mount({
      value: { items: [{ ...machineA, state: 'disconnected' }, { ...machineA, id: 'b', name: 'beta', state: 'disconnected' }] },
    })
    await waitFor(() => expect(screen.getByText('alpha')).toBeTruthy())
    const betaCard = screen.getByTestId('machine-b')
    fireEvent.click(withinButton(betaCard, 'Remove'))
    await waitFor(() => expect(screen.getByText(/This removes the "beta" machine profile/)).toBeTruthy())
    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.getByTestId('machine-b')).toBeTruthy()
    fireEvent.click(withinButton(betaCard, 'Remove'))
    await waitFor(() => expect(screen.getByText('Remove it')).toBeTruthy())
    once(replies.ok({}))
    once(replies.ok({ items: [{ ...machineA, state: 'disconnected' }] }))
    fireEvent.click(screen.getByText('Remove it'))
    await waitFor(() => expect(removePayloads()).toHaveLength(1))
    expect(sent).toContainEqual({ url: `${baseURL}/machines`, http: 'DELETE', body: { machineId: 'b' }, params: {} })
    await waitFor(() => expect(screen.queryByTestId('machine-b')).toBeNull())
  })

  it('tests, connects, opens through the desktop bridge, and disconnects a machine', async () => {
    const openWindow = vi.fn(async () => undefined)
    mount({ value: { items: [{ ...machineA, state: 'disconnected' }] }, bridge: desktopBridge(openWindow) })
    await waitFor(() => expect(screen.getByTestId('machine-a')).toBeTruthy())

    once(replies.ok({ ok: true, banner: 'Linux alpha' }))
    fireEvent.click(withinButton(screen.getByTestId('machine-a'), 'Test'))
    await waitFor(() => expect(screen.getByTestId('notice').textContent).toContain('Linux alpha'))

    once(replies.ok({ tunnelBaseUrl: 'http://127.0.0.1:49152' }))
    fireEvent.click(withinButton(screen.getByTestId('machine-a'), 'Connect'))
    await waitFor(() => expect(withinButton(screen.getByTestId('machine-a'), 'Open')).toBeTruthy())
    fireEvent.click(withinButton(screen.getByTestId('machine-a'), 'Open'))
    await waitFor(() => expect(openWindow).toHaveBeenCalledWith('a', 'http://127.0.0.1:49152'))
    expect(screen.queryByTestId('bridge-error-a')).toBeNull()

    once(replies.ok({}))
    fireEvent.click(withinButton(screen.getByTestId('machine-a'), 'Disconnect'))
    await waitFor(() => expect(withinButton(screen.getByTestId('machine-a'), 'Connect')).toBeTruthy())
  })

  it('hides the open button entirely in the pure-web environment', async () => {
    const openWindow = vi.fn(async () => undefined)
    mount({
      bridge: unreachableBridge,
      value: { items: [{ ...machineA, state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:49152' }] },
    })
    await waitFor(() => expect(screen.getByTestId('status-a').textContent).toContain('Connected'))
    await waitFor(() => expect(screen.queryByText('Open')).toBeNull())
    expect(openWindow).not.toHaveBeenCalled()
  })

  it('surfaces a failed bridge open call as a visible error', async () => {
    const openWindow = vi.fn(() => Promise.reject(new Error('window refused')))
    mount({
      bridge: desktopBridge(openWindow),
      value: { items: [{ ...machineA, state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:49152' }] },
    })
    fireEvent.click(await screen.findByText('Open'))
    await waitFor(() => expect(screen.getByTestId('bridge-error-a').textContent).toContain('window refused'))
  })

  it('shows an in-flight opening state and settles back afterwards', async () => {
    let release: () => void = () => {}
    const openWindow = vi.fn(() => new Promise<void>((resolve) => {
      release = resolve
    }))
    mount({
      bridge: desktopBridge(openWindow),
      value: { items: [{ ...machineA, state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:49152' }] },
    })
    fireEvent.click(await screen.findByText('Open'))
    await waitFor(() => expect(screen.getByText('Opening…').closest('button')?.hasAttribute('disabled')).toBe(true))
    act(() => release())
    await waitFor(() => expect(withinButton(screen.getByTestId('machine-a'), 'Open')).toBeTruthy())
  })

  it('renders the connecting state with the connect action disabled', async () => {
    mount({ value: { items: [{ ...machineA, state: 'connecting' }] } })
    await waitFor(() => expect(screen.getByText('alpha')).toBeTruthy())
    expect(screen.getByTestId('status-a').textContent).toContain('Connecting')
    expect(withinButton(screen.getByTestId('machine-a'), 'Connect').hasAttribute('disabled')).toBe(true)
  })

  it('renders the testing and reconnecting states with the retry hint', async () => {
    mount({ value: { items: [{ ...machineA, state: 'testing' }] } })
    await waitFor(() => expect(screen.getByTestId('status-a').textContent).toContain('Testing'))

    cleanup()
    mount({ value: { items: [{ ...machineA, state: 'reconnecting', nextRetryAt: Date.now() + 8_000 }] } })
    await waitFor(() => expect(screen.getByTestId('status-a').textContent).toContain('Reconnecting'))
    expect(screen.getByTestId('status-a').textContent).toContain('next retry: in 8s')
    expect(withinButton(screen.getByTestId('machine-a'), 'Connect').hasAttribute('disabled')).toBe(true)
  })

  it('renders a due retry as now instead of a negative countdown', async () => {
    mount({ value: { items: [{ ...machineA, state: 'reconnecting', nextRetryAt: Date.now() - 2_000 }] } })
    await waitFor(() => expect(screen.getByTestId('status-a').textContent).toContain('Reconnecting'))
    expect(screen.getByTestId('status-a').textContent).toContain('next retry: now')
  })

  it('renders the given-up state and lets the operator retry the connect', async () => {
    mount({ value: { items: [{ ...machineA, state: 'given-up', lastError: 'auth failed after 10 tries' }] } })
    await waitFor(() => expect(screen.getByTestId('status-a').textContent).toContain('Given up'))
    expect(screen.getByText('auth failed after 10 tries')).toBeTruthy()
    expect(withinButton(screen.getByTestId('machine-a'), 'Connect').hasAttribute('disabled')).toBe(false)
  })

  it('edits every config field and falls back on malformed numbers', async () => {
    mount({ value: { items: [{ ...machineA, state: 'disconnected' }] } })
    await waitFor(() => expect(screen.getByTestId('machine-a')).toBeTruthy())
    fireEvent.click(withinButton(screen.getByTestId('machine-a'), 'Edit'))
    const editor = screen.getByTestId('editor-a')
    fireEvent.change(within(editor).getByLabelText('Port'), { target: { value: '2222' } })
    fireEvent.change(within(editor).getByLabelText('Remote port'), { target: { value: 'abc' } })
    fireEvent.change(within(editor).getByLabelText('Start command (optional)'), { target: { value: 'dsh web --port 3000' } })
    fireEvent.change(within(editor).getByLabelText('Key passphrase (optional)'), { target: { value: 'phrase' } })
    fireEvent.click(within(editor).getByText('Save'))
    await waitFor(() => expect(savePayloads()).toHaveLength(1))
    const payload = savePayloads()[0]
    expect(payload?.row).toMatchObject({
      port: 2222,
      remotePort: 3080,
      startCommand: 'dsh web --port 3000',
    })
    expect(payload?.secrets).toMatchObject({ passphrase: 'phrase' })
  })

  it('masks the secret inputs and keeps the write-only direction', async () => {
    mount({ value: { items: [{ ...machineA, state: 'disconnected' }] } })
    await waitFor(() => expect(screen.getByTestId('machine-a')).toBeTruthy())
    fireEvent.click(withinButton(screen.getByTestId('machine-a'), 'Edit'))
    const editor = screen.getByTestId('editor-a')
    const password = within(editor).getByLabelText('Password (optional)')
    const passphrase = within(editor).getByLabelText('Key passphrase (optional)')
    expect(password.getAttribute('type')).toBe('password')
    expect(passphrase.getAttribute('type')).toBe('password')
    expect(password.getAttribute('placeholder')).toBe('set')
    expect(passphrase.getAttribute('placeholder')).toBe('not set')
  })

  it('opens nothing when a connected machine has no tunnel url', async () => {
    const openWindow = vi.fn(async () => undefined)
    mount({
      bridge: desktopBridge(openWindow),
      value: { items: [{ ...machineA, state: 'connected' }] },
    })
    fireEvent.click(await screen.findByText('Open'))
    expect(openWindow).not.toHaveBeenCalled()
  })

  it('persists the identity color and the border tint switch', async () => {
    mount({ value: { items: [{ ...machineA, state: 'disconnected' }] } })
    await waitFor(() => expect(screen.getByTestId('machine-a')).toBeTruthy())
    const card = screen.getByTestId('machine-a')
    fireEvent.click(withinButton(card, 'Edit'))
    const editor = screen.getByTestId('editor-a')
    const tintSwitch = within(editor).getByRole('switch', { name: 'Also tint the border', checked: false })
    expect(tintSwitch.hasAttribute('disabled')).toBe(true)
    fireEvent.click(tintSwitch)
    expect(tintSwitch.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(within(editor).getByLabelText('Color: #4176E6'))
    expect(tintSwitch.hasAttribute('disabled')).toBe(false)
    fireEvent.click(tintSwitch)
    expect(tintSwitch.getAttribute('aria-checked')).toBe('true')
    once(replies.ok({}))
    once(replies.ok({ items: [{ ...machineA, state: 'disconnected', color: '#4176E6', tintBorder: true }] }))
    fireEvent.click(within(editor).getByText('Save'))
    await waitFor(() => expect(savePayloads()).toHaveLength(1))
    expect(savePayloads()[0]?.row).toMatchObject({ color: '#4176E6', tintBorder: true })
    await waitFor(() => expect(card.style.borderLeftColor).toBe('rgb(65, 118, 230)'))
  })

  it('resets color and border tint through the default swatch', async () => {
    mount({
      value: { items: [{ ...machineA, state: 'disconnected', color: '#4176E6', tintBorder: true }] },
    })
    await waitFor(() => expect(screen.getByTestId('machine-a')).toBeTruthy())
    expect(screen.getByTestId('machine-a').style.borderLeftColor).toBe('rgb(65, 118, 230)')
    fireEvent.click(withinButton(screen.getByTestId('machine-a'), 'Edit'))
    const editor = screen.getByTestId('editor-a')
    fireEvent.click(within(editor).getByLabelText('Default'))
    fireEvent.click(within(editor).getByText('Save'))
    await waitFor(() => expect(savePayloads()).toHaveLength(1))
    const row = savePayloads()[0]?.row ?? {}
    expect(row.color).toBeUndefined()
    expect(row.tintBorder).toBeUndefined()
  })

  it('shows the live progress text of an in-flight operation', async () => {
    mount({ value: { items: [{ ...machineA, state: 'connecting', progress: { phase: 'probing', attempt: 2, total: 30 } }] } })
    await waitFor(() => expect(screen.getByTestId('status-a').textContent).toContain('Health check 2/30'))
  })

  it('shows the handshake progress phase', async () => {
    mount({ value: { items: [{ ...machineA, state: 'connecting', progress: { phase: 'handshake' } }] } })
    await waitFor(() => expect(screen.getByTestId('status-a').textContent).toContain('Connecting over SSH'))
  })

  it('renders the step rail with the observed phases, latest highlighted', async () => {
    mount({ value: { items: [{ ...machineA, state: 'connecting', progress: { phase: 'handshake' } }] } })
    await waitFor(() => expect(screen.getByTestId('step-rail').textContent).toBe('Handshake'))
    once(replies.ok({ items: [{ ...machineA, state: 'connecting', progress: { phase: 'probing', attempt: 1, total: 3 } }] }))
    once(replies.ok({ items: [] }))
    await act(async () => {
      await service.poll()
    })
    await waitFor(() => expect(screen.getByTestId('step-rail').textContent).toBe('HandshakeProbe'))
    once(replies.ok({ items: [{ ...machineA, state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:1' }] }))
    once(replies.ok({ items: [] }))
    await act(async () => {
      await service.poll()
    })
    await waitFor(() => expect(screen.queryByTestId('step-rail')).toBeNull())
  })

  it.each([
    { phase: 'probing', text: 'Health check ?/?…' },
    { phase: 'syncing', text: 'Syncing item ?/?…' },
  ])('falls back to question marks when $phase progress has no numbers', async ({ phase, text }) => {
    mount({ value: { items: [{ ...machineA, state: 'connecting', progress: { phase } }] } })
    await waitFor(() => expect(screen.getByTestId('status-a').textContent).toBe(text))
  })

  it('shows the starting progress phase', async () => {
    mount({ value: { items: [{ ...machineA, state: 'connecting', progress: { phase: 'starting' } }] } })
    await waitFor(() => expect(screen.getByTestId('status-a').textContent).toContain('Starting the remote instance'))
  })

  it('streams the install log through the unified log surface', async () => {
    mount({ value: { items: [{ ...machineA, state: 'disconnected' }] } })
    await waitFor(() => expect(screen.getByText('alpha')).toBeTruthy())
    act(() => {
      store.machines.busy.a = 'install'
      store.machines.statuses.a = {
        state: 'disconnected',
        dshMissing: true,
        progress: { phase: 'installing', log: '==> Checking dependencies\ngit ... ok' },
      }
    })
    await waitFor(() => expect(screen.getAllByText(/Installing dsh/).length).toBeGreaterThan(0))
    const log = screen.getByTestId('machine-log-a')
    expect(log.textContent).toContain('==> Checking dependencies')
    expect(log.textContent).toContain('git ... ok')
  })

  it('prefers the machine.events lines over the progress log', async () => {
    mount({ value: { items: [{ ...machineA, state: 'connecting' }] } })
    await waitFor(() => expect(screen.getByText('alpha')).toBeTruthy())
    act(() => {
      store.machines.logs.a = ['[bootstrap] cloning dsh source', '[bootstrap] pnpm install']
      store.machines.statuses.a = { state: 'connecting', progress: { phase: 'starting', log: 'old progress text' } }
    })
    await waitFor(() => expect(screen.getByTestId('machine-log-a').textContent).toContain('[bootstrap] cloning dsh source'))
    const log = screen.getByTestId('machine-log-a')
    expect(log.textContent).toContain('[bootstrap] pnpm install')
    expect(log.textContent).not.toContain('old progress text')
  })

  it('shows per-machine failures and the page error banner', async () => {
    mount({
      value: { items: [{ ...machineA, state: 'disconnected', lastError: 'auth failed' }] },
    })
    await waitFor(() => expect(screen.getByText('auth failed')).toBeTruthy())
    act(() => {
      store.machines.error = 'boom'
    })
    await waitFor(() => expect(screen.getByText(/Error: boom/)).toBeTruthy())
  })

  it('renders the load-failure state with a retry affordance instead of a blank page', async () => {
    mount({ route: () => replies.fail('route down') })
    await waitFor(() => expect(screen.getByText('The panel failed to load.')).toBeTruthy())
    expect(screen.getAllByText('Refresh').length).toBeGreaterThan(0)
  })

  it('renders discovered config aliases as read-only cards with working actions', async () => {
    mount({
      value: {
        items: [],
        discovered: [{ ...machineA, id: 'dev', name: 'dev', host: 'dev', user: 'root', hasPassword: false, state: 'disconnected' }],
      },
    })
    await waitFor(() => expect(screen.getByText('dev')).toBeTruthy())
    expect(screen.getByText('Hosts from ~/.ssh/config')).toBeTruthy()
    const card = screen.getByTestId('machine-dev')
    expect(within(card).queryByLabelText('ID')).toBeNull()
    expect(within(card).queryByText('Remove')).toBeNull()
    once(replies.ok({ ok: true, banner: 'Linux dev' }))
    fireEvent.click(withinButton(card, 'Test'))
    await waitFor(() => expect(screen.getByTestId('notice').textContent).toContain('Linux dev'))
  })

  it('connects and opens a discovered config alias through the bridge', async () => {
    const openWindow = vi.fn(async () => undefined)
    mount({
      bridge: desktopBridge(openWindow),
      value: {
        items: [],
        discovered: [{ ...machineA, id: 'dev', name: 'dev', host: 'dev', user: '', hasPassword: false, state: 'disconnected' }],
      },
    })
    await waitFor(() => expect(screen.getByText('dev')).toBeTruthy())
    once(replies.ok({ tunnelBaseUrl: 'http://127.0.0.1:49152' }))
    fireEvent.click(withinButton(screen.getByTestId('machine-dev'), 'Connect'))
    await waitFor(() => expect(withinButton(screen.getByTestId('machine-dev'), 'Open')).toBeTruthy())
    fireEvent.click(withinButton(screen.getByTestId('machine-dev'), 'Open'))
    await waitFor(() => expect(openWindow).toHaveBeenCalledWith('dev', 'http://127.0.0.1:49152'))
    once(replies.ok({}))
    fireEvent.click(withinButton(screen.getByTestId('machine-dev'), 'Disconnect'))
    await waitFor(() => expect(withinButton(screen.getByTestId('machine-dev'), 'Connect')).toBeTruthy())
  })

  it('opens nothing for a discovered card without a tunnel url', async () => {
    const openWindow = vi.fn(async () => undefined)
    mount({
      bridge: desktopBridge(openWindow),
      value: { items: [], discovered: [{ ...machineA, id: 'dev', name: 'dev', host: 'dev', user: '', hasPassword: false, state: 'connected' }] },
    })
    fireEvent.click(await screen.findByText('Open'))
    expect(openWindow).not.toHaveBeenCalled()
  })

  it('disables connect while a discovered alias is connecting', async () => {
    mount({ value: { discovered: [{ ...machineA, id: 'dev', name: 'dev', host: 'dev', user: '', hasPassword: false, state: 'connecting' }] } })
    await waitFor(() => expect(screen.getByTestId('status-dev').textContent).toContain('Connecting'))
    expect(withinButton(screen.getByTestId('machine-dev'), 'Connect').hasAttribute('disabled')).toBe(true)
  })

  it('shows a discovered alias failure inline', async () => {
    mount({ value: { discovered: [{ ...machineA, id: 'dev', name: 'dev', host: 'dev', user: '', hasPassword: false, state: 'disconnected', lastError: 'auth failed' }] } })
    await waitFor(() => expect(screen.getByText('auth failed')).toBeTruthy())
  })

  it('shows the empty state only when no manual or discovered machines exist', async () => {
    mount({ value: { discovered: [{ ...machineA, id: 'dev', name: 'dev', host: 'dev', user: '', state: 'disconnected' }] } })
    await waitFor(() => expect(screen.getByText('dev')).toBeTruthy())
    expect(screen.queryByText(/No SSH machines yet/)).toBeNull()
  })

  it('refreshes on demand', async () => {
    mount()
    await waitFor(() => expect(screen.getByText(/No SSH machines yet/)).toBeTruthy())
    const before = listCalls()
    fireEvent.click(screen.getByText('Refresh'))
    await waitFor(() => expect(listCalls()).toBe(before + 1))
  })

  it('shows the one-click install surface when dsh is missing and installs on click', async () => {
    mount({
      value: { items: [{ ...machineA, state: 'disconnected', lastError: 'dsh is not installed', dshMissing: true }] },
    })
    await waitFor(() => expect(screen.getByText('alpha')).toBeTruthy())
    expect(screen.getByText(/No dsh found on the remote/)).toBeTruthy()
    expect(screen.getByText('Install dsh')).toBeTruthy()
    once(replies.ok({ dshPath: '/home/root/.local/bin/dsh', credentialsCopied: true }))
    once(replies.ok({ items: [{ ...machineA, state: 'disconnected', dshMissing: false }] }))
    fireEvent.click(screen.getByText('Install dsh'))
    await waitFor(() => expect(installPayloads()).toHaveLength(1))
    expect(installPayloads()[0]).toEqual({ machineId: 'a' })
  })

  it('shows the install outcome note under the card', async () => {
    mount({ value: { items: [{ ...machineA, state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:1' }] } })
    await waitFor(() => expect(screen.getByTestId('machine-a')).toBeTruthy())
    act(() => {
      store.machines.installResults.a = { dshPath: '/home/root/.local/bin/dsh', credentialsCopied: true }
    })
    await waitFor(() => expect(screen.getByTestId('install-note-a').textContent).toContain('API key was copied'))
  })

  it('shows the install note when no local key exists', async () => {
    mount({ value: { items: [{ ...machineA, state: 'disconnected' }] } })
    await waitFor(() => expect(screen.getByText('alpha')).toBeTruthy())
    act(() => {
      store.machines.installResults.a = { dshPath: '/home/root/.local/bin/dsh', credentialsCopied: false }
    })
    await waitFor(() => expect(screen.getByTestId('install-note-a').textContent).toContain('No DEEPSEEK_API_KEY found locally'))
  })

  it('shows the install note with a credentials copy failure', async () => {
    mount({ value: { items: [{ ...machineA, state: 'disconnected' }] } })
    await waitFor(() => expect(screen.getByText('alpha')).toBeTruthy())
    act(() => {
      store.machines.installResults.a = {
        dshPath: '/home/root/.local/bin/dsh',
        credentialsCopied: false,
        credentialsError: 'disk full',
      }
    })
    await waitFor(() => expect(screen.getByTestId('install-note-a').textContent).toContain('disk full'))
  })

  it('offers the one-click install on a discovered alias too', async () => {
    mount({
      value: {
        discovered: [{
          id: 'dev',
          name: 'dev',
          host: 'dev',
          port: 22,
          user: 'root',
          hasPassword: false,
          hasPassphrase: false,
          remotePort: 3080,
          state: 'disconnected',
          dshMissing: true,
          lastError: 'dsh is not installed',
        }],
      },
    })
    await waitFor(() => expect(screen.getByText('dev')).toBeTruthy())
    expect(screen.getByText(/No dsh found on the remote/)).toBeTruthy()
    once(replies.ok({ dshPath: '/home/root/.local/bin/dsh', credentialsCopied: true }))
    once(replies.ok({ discovered: [{ id: 'dev', name: 'dev', host: 'dev', port: 22, user: 'root', hasPassword: false, hasPassphrase: false, remotePort: 3080, state: 'disconnected' }] }))
    fireEvent.click(screen.getByText('Install dsh'))
    await waitFor(() => expect(installPayloads()).toHaveLength(1))
    expect(installPayloads()[0]).toEqual({ machineId: 'dev' })
  })
})

function listCalls(): number {
  return sent.filter(call => call.url === `${baseURL}/machines` && call.http === 'GET').length
}

function savePayloads(): SavePayload[] {
  return sent.filter(call => call.url === `${baseURL}/machines` && call.http === 'POST').map(call => call.body as unknown as SavePayload)
}

function removePayloads(): Array<{ machineId: string }> {
  return sent.filter(call => call.url === `${baseURL}/machines` && call.http === 'DELETE').map(call => call.body as unknown as { machineId: string })
}

function installPayloads(): Array<{ machineId: string }> {
  return sent.filter(call => call.url === `${baseURL}/machines/install`).map(call => call.body as unknown as { machineId: string })
}

function withinButton(container: HTMLElement, text: string): HTMLButtonElement {
  return within(container).getByRole('button', { name: text }) as HTMLButtonElement
}
