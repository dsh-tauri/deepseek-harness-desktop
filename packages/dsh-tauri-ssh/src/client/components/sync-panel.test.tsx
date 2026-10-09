// @vitest-environment jsdom
import type { SshKey } from '../locales/index'
import type { MachineRow } from '../types/index'
import { fireEvent, screen, waitFor } from '@testing-library/dom'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { en } from '../locales/index'
import { store } from '../store/index'
import { answer, replies, resetWire, sent } from '../test-utils/client-mock'
import { SyncPanel } from './sync-panel'

const baseURL = '/api/tauri/ssh'

vi.mock('dsh-tauri-ui/client', async () => (await import('../test-utils/ui-mock')).uiMock)

vi.mock('dsh-tauri/client', async () => (await import('../test-utils/client-mock')).clientMock)

beforeEach(() => {
  resetWire()
  store.machines.reset()
  store.sync.reset()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const t = ((key: string) => (en as Record<string, string>)[key] ?? key) as (key: SshKey) => string

const regexOf = (text: string): RegExp => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

function routeWire(routes: Record<string, unknown>, failures: string[] = []): void {
  answer(call => failures.includes(call.url)
    ? replies.fail(`${call.url} broke`)
    : replies.ok(routes[call.url] ?? {}))
}

const preview = {
  plugins: [
    { name: 'dsh-market', spec: 'github:omdsh/dsh-market', syncable: true },
    { name: 'local-thing', spec: 'link:../local', syncable: false, reason: 'local-path dependency; it cannot be resolved on the remote' },
  ],
  skills: [
    { name: 'alpha', root: 'dsh' },
    { name: 'beta', root: 'agents' },
  ],
}

const machineA: MachineRow = {
  id: 'a',
  name: 'alpha',
  host: '10.0.0.1',
  port: 22,
  user: 'root',
  hasPassword: false,
  hasPassphrase: false,
  remotePort: 3080,
}

const connectedStatus = { state: 'connected' as const, tunnelBaseUrl: 'http://127.0.0.1:1' }

function seedConnected(): void {
  store.machines.commitList({ machines: [machineA], discovered: [], statuses: { a: connectedStatus } })
  store.sync.commitPreview(preview)
}

describe('syncPanel', () => {
  it('starts with every syncable item ticked and keeps independent tick state', async () => {
    routeWire({ [`${baseURL}/machines`]: { items: [] } })
    seedConnected()
    render(<SyncPanel t={t} />)
    await waitFor(() => expect(screen.getByTestId('sync-row-dsh-market')).toBeTruthy())
    expect(screen.getByTestId('sync-row-dsh-market').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('sync-row-alpha').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('sync-row-beta').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('sync-row-local-thing').getAttribute('aria-checked')).toBe('false')
    expect(screen.getByTestId('sync-selected').textContent).toContain('1 plugins and 2 skills selected')

    fireEvent.click(screen.getByTestId('sync-row-dsh-market'))
    expect(screen.getByTestId('sync-row-dsh-market').getAttribute('aria-checked')).toBe('false')
    expect(screen.getByTestId('sync-row-alpha').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('sync-selected').textContent).toContain('0 plugins and 2 skills selected')

    fireEvent.click(screen.getByText('Clear'))
    expect(screen.getByTestId('sync-row-alpha').getAttribute('aria-checked')).toBe('false')
    fireEvent.click(screen.getByText('Select all'))
    expect(screen.getByTestId('sync-row-dsh-market').getAttribute('aria-checked')).toBe('true')
  })

  it('disables unsyncable plugins and shows their reason', async () => {
    routeWire({ [`${baseURL}/machines`]: { items: [] } })
    seedConnected()
    render(<SyncPanel t={t} />)
    await waitFor(() => expect(screen.getByTestId('sync-row-local-thing')).toBeTruthy())
    expect(screen.getByTestId('sync-row-local-thing').hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(/local-path dependency/)).toBeTruthy()
  })

  it('sends the whole ticked selection to sync.apply', async () => {
    routeWire({ [`${baseURL}/sync/apply`]: { items: [] } })
    seedConnected()
    render(<SyncPanel t={t} />)
    await waitFor(() => expect(screen.getByTestId('sync-apply')).toBeTruthy())
    fireEvent.click(screen.getByTestId('sync-apply'))
    await waitFor(() => expect(applyCalls()).toHaveLength(1))
    expect(applyCalls()[0]).toEqual({
      machineId: 'a',
      plugins: [{ name: 'dsh-market', spec: 'github:omdsh/dsh-market' }],
      skills: [{ name: 'alpha', root: 'dsh' }, { name: 'beta', root: 'agents' }],
    })
  })

  it('shows per-item live progress while an apply runs', async () => {
    routeWire({ [`${baseURL}/machines`]: { items: [] } })
    seedConnected()
    store.sync.beginApply()
    store.machines.commitList({
      machines: [machineA],
      discovered: [],
      statuses: { a: { ...connectedStatus, progress: { phase: 'syncing', attempt: 3, total: 5, item: 'dsh-tauri-pet' } } },
    })
    render(<SyncPanel t={t} />)
    await waitFor(() => expect(screen.getByTestId('sync-progress')).toBeTruthy())
    expect(screen.getByTestId('sync-progress').textContent).toContain('3/5')
    expect(screen.getByTestId('sync-progress').textContent).toContain('dsh-tauri-pet')
    const fill = screen.getByTestId('sync-progress').querySelector('[class~="bg-brand"]') as HTMLElement
    expect(fill.style.width).toBe('40%')
    expect(screen.getByTestId('sync-apply').textContent).toContain('Syncing')
  })

  it('renders partial failures per item with reasons and a retry that re-sends only them', async () => {
    routeWire({ [`${baseURL}/sync/apply`]: { items: [] }, [`${baseURL}/machines`]: { items: [] } })
    seedConnected()
    store.sync.mergeResults([
      { kind: 'plugin', name: 'dsh-market', ok: true },
      { kind: 'skill', name: 'alpha', root: 'dsh', ok: false, error: 'exit 1: read-only file system' },
    ])
    render(<SyncPanel t={t} />)
    await waitFor(() => expect(screen.getByTestId('sync-results')).toBeTruthy())
    expect(screen.getByTestId('sync-result-dsh-market').dataset.ok).toBe('true')
    const failed = screen.getByTestId('sync-result-alpha')
    expect(failed.dataset.ok).toBe('false')
    expect(failed.textContent).toContain('read-only file system')
    expect(failed.textContent).toContain('(dsh)')
    expect(screen.getByText(/1 succeeded, 1 failed/)).toBeTruthy()

    fireEvent.click(screen.getByTestId('sync-retry'))
    await waitFor(() => expect(applyCalls()).toHaveLength(1))
    expect(applyCalls()[0]).toEqual({
      machineId: 'a',
      plugins: [],
      skills: [{ name: 'alpha', root: 'dsh' }],
    })
  })

  it('keeps the failure headline cause-first and shows the raw output on demand', async () => {
    routeWire({})
    seedConnected()
    store.sync.mergeResults([{
      kind: 'plugin',
      name: 'dsh-better-sidebar',
      ok: false,
      error: 'exit 1: make: *** [pty.target.mk:119] Error 127 | gyp ERR! stack Error: `make` failed with exit code: 2',
      log: 'Progress: resolved 584\nmake: *** [pty.target.mk:119] Error 127\n[ERR_PNPM_PREPARE_PACKAGE] failed',
    }])
    render(<SyncPanel t={t} />)
    await waitFor(() => expect(screen.getByTestId('sync-results')).toBeTruthy())
    const row = screen.getByTestId('sync-result-dsh-better-sidebar')
    expect(row.textContent).toContain('Error 127')
    expect(row.textContent).not.toContain('Progress: resolved')
    const toggle = screen.getByTestId('sync-log-toggle-dsh-better-sidebar')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('sync-log')).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByTestId('sync-log-toggle-dsh-better-sidebar').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('sync-log').textContent).toContain('ERR_PNPM_PREPARE_PACKAGE')
  })

  it('renders a complete failure with every reason visible', async () => {
    routeWire({})
    seedConnected()
    store.sync.mergeResults([
      { kind: 'plugin', name: 'dsh-market', ok: false, error: 'exit 1: ERR_PNPM_NO_MATCH' },
      { kind: 'skill', name: 'alpha', root: 'dsh', ok: false, error: 'exit 1: read-only file system' },
    ])
    render(<SyncPanel t={t} />)
    await waitFor(() => expect(screen.getByTestId('sync-results')).toBeTruthy())
    expect(screen.getByText(/0 succeeded, 2 failed/)).toBeTruthy()
    expect(screen.getByTestId('sync-result-dsh-market').textContent).toContain('ERR_PNPM_NO_MATCH')
    expect(screen.getByTestId('sync-result-alpha').textContent).toContain('read-only file system')
  })

  it('surfaces a request-level failure without swallowing previous results', async () => {
    routeWire({ [`${baseURL}/sync/apply`]: { items: [] } }, [`${baseURL}/sync/apply`])
    seedConnected()
    store.sync.mergeResults([{ kind: 'plugin', name: 'dsh-market', ok: true }])
    render(<SyncPanel t={t} />)
    await waitFor(() => expect(screen.getByTestId('sync-apply')).toBeTruthy())
    fireEvent.click(screen.getByTestId('sync-apply'))
    await waitFor(() => expect(screen.getByText(regexOf(`The sync request failed: ${baseURL}/sync/apply broke`))).toBeTruthy())
    expect(screen.getByTestId('sync-result-dsh-market')).toBeTruthy()
  })

  it('disables apply with an empty tick set', async () => {
    routeWire({ [`${baseURL}/machines`]: { items: [] } })
    seedConnected()
    render(<SyncPanel t={t} />)
    await waitFor(() => expect(screen.getByText('Clear')).toBeTruthy())
    fireEvent.click(screen.getByText('Clear'))
    expect(screen.getByTestId('sync-apply').hasAttribute('disabled')).toBe(true)
  })

  it('loads the machine list itself and offers the connected machine as the target', async () => {
    routeWire({
      [`${baseURL}/machines`]: { items: [{ ...machineA, state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:1' }] },
      [`${baseURL}/sync/preview`]: preview,
    })
    render(<SyncPanel t={t} />)
    await waitFor(() => expect(screen.getByTestId('sync-target-a')).toBeTruthy())
    expect(apiMethods()).toContain(`${baseURL}/machines`)
    expect(screen.getByTestId('sync-apply').textContent).toContain('Sync to alpha')
    expect(screen.queryByTestId('sync-empty')).toBeNull()
  })

  it('points a remote-session instance back at the initiating machine', async () => {
    routeWire({ [`${baseURL}/machines`]: { items: [] }, [`${baseURL}/session/role`]: { remote: true, origin: 'ops' } })
    render(<SyncPanel t={t} />)
    await waitFor(() => expect(screen.getByTestId('sync-remote-note')).toBeTruthy())
    expect(screen.getByTestId('sync-remote-note').textContent).toContain('Sync to remote')
    expect(screen.queryByTestId('sync-apply')).toBeNull()
  })

  it('shows the not-connected note when no machine is connected', async () => {
    routeWire({})
    store.machines.commitList({ machines: [machineA], discovered: [], statuses: { a: { state: 'disconnected' } } })
    store.sync.commitPreview(preview)
    render(<SyncPanel t={t} />)
    await waitFor(() => expect(screen.getByTestId('sync-empty')).toBeTruthy())
    expect(screen.getByTestId('sync-empty').textContent).toContain('No connected machines')
    expect(screen.queryByTestId('sync-apply')).toBeNull()
  })

  it('shows the preview load failure with the reason', async () => {
    routeWire({}, [`${baseURL}/sync/preview`])
    store.machines.commitList({ machines: [], discovered: [], statuses: {} })
    render(<SyncPanel t={t} />)
    await waitFor(() => expect(screen.getByText(regexOf(`Failed to load the sync list: ${baseURL}/sync/preview broke`))).toBeTruthy())
  })
})

function apiMethods(): string[] {
  return sent.map(call => call.url)
}

function applyCalls(): Array<Record<string, unknown>> {
  return sent.filter(call => call.url === `${baseURL}/sync/apply`).map(call => call.body)
}
