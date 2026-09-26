import type { SshKey } from '../locales/index'
import type { FetchFn, MachineRow } from '../store/index'
import { fireEvent, screen, waitFor } from '@testing-library/dom'
import { cleanup, render } from '@testing-library/react'
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { en } from '../locales/index'
import { MachinesStore } from '../store/index'
import { SyncPanel } from './sync-panel'

// dsh-tauri-ui/client 的 dist bundle 以 ModuleLoader 工厂包裹，脱离宿主加载器
// 无法在 node 求值；mock 到同一 cssr 实例的源文件（与 dsh-tauri-panel 同款做法），
// 组件渲染只消费 cls 字符串，不需要真实样式；通用控件转发官方 primitives 真实实现。
vi.mock('dsh-tauri-ui/client', async () => {
  const mod = await import('../../../../dsh-tauri-ui/src/client/utils/cssr.ts')
  const primitives = await import('@deepseek-ai/dsh-client-ui-primitives')
  return { cssr: mod.cssr, ...primitives }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const t = ((key: string) => (en as Record<string, string>)[key] ?? key) as (key: SshKey) => string

type FetchMock = ReturnType<typeof vi.fn<FetchFn>>

/** A fetch mock dispatching by /api-ssh method name. */
function routeFetch(routes: Record<string, unknown>, failures: string[] = []): FetchMock {
  return vi.fn<FetchFn>(async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { method: string }
    if (failures.includes(body.method)) {
      return { json: async () => ({ ok: false, error: { code: 'internal', message: `${body.method} broke` } }) } as unknown as Response
    }
    const value = routes[body.method] ?? {}
    return { json: async () => ({ ok: true, value }) } as unknown as Response
  })
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

/** A store preloaded with one connected machine and a landed sync preview. */
function connectedStore(fetchFn: FetchMock): MachinesStore {
  const store = new MachinesStore(fetchFn)
  store.store.update((state) => {
    state.status = 'ready'
    state.machines = [machineA]
    state.statuses = { a: { state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:1' } }
    state.sync = { status: 'ready', error: null, preview, applying: false, results: null }
  })
  return store
}

describe('syncPanel', () => {
  it('starts with every syncable item ticked and keeps independent tick state', async () => {
    const store = connectedStore(routeFetch({ 'machine.list': { items: [] } }))
    render(<SyncPanel store={store} t={t} />)
    await waitFor(() => expect(screen.getByTestId('sync-row-dsh-market')).toBeTruthy())
    // 默认=全选可同步项（不可同步的 local-thing 恒不勾）
    expect(screen.getByTestId('sync-row-dsh-market').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('sync-row-alpha').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('sync-row-beta').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('sync-row-local-thing').getAttribute('aria-checked')).toBe('false')
    expect(screen.getByTestId('sync-selected').textContent).toContain('1 plugins and 2 skills selected')

    // 取消一项不动其它项（多选而非单选）
    fireEvent.click(screen.getByTestId('sync-row-dsh-market'))
    expect(screen.getByTestId('sync-row-dsh-market').getAttribute('aria-checked')).toBe('false')
    expect(screen.getByTestId('sync-row-alpha').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('sync-selected').textContent).toContain('0 plugins and 2 skills selected')

    // 清空 → 全选回来，计数复位
    fireEvent.click(screen.getByText('Clear'))
    expect(screen.getByTestId('sync-row-alpha').getAttribute('aria-checked')).toBe('false')
    fireEvent.click(screen.getByText('Select all'))
    expect(screen.getByTestId('sync-row-dsh-market').getAttribute('aria-checked')).toBe('true')
  })

  it('disables unsyncable plugins and shows their reason', async () => {
    const store = connectedStore(routeFetch({ 'machine.list': { items: [] } }))
    render(<SyncPanel store={store} t={t} />)
    await waitFor(() => expect(screen.getByTestId('sync-row-local-thing')).toBeTruthy())
    expect(screen.getByTestId('sync-row-local-thing').hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(/local-path dependency/)).toBeTruthy()
  })

  it('sends the whole ticked selection to sync.apply', async () => {
    const fetchFn = routeFetch({ 'sync.apply': { items: [] } })
    const store = connectedStore(fetchFn)
    render(<SyncPanel store={store} t={t} />)
    await waitFor(() => expect(screen.getByTestId('sync-apply')).toBeTruthy())
    // 默认全选：一次点击就该带走全部可同步项，不可同步项被排除在外
    fireEvent.click(screen.getByTestId('sync-apply'))
    await waitFor(() => expect(applyCalls(fetchFn)).toHaveLength(1))
    expect(applyCalls(fetchFn)[0]).toEqual({
      machineId: 'a',
      plugins: [{ name: 'dsh-market', spec: 'github:omdsh/dsh-market' }],
      skills: [{ name: 'alpha', root: 'dsh' }, { name: 'beta', root: 'agents' }],
    })
  })

  it('shows per-item live progress while an apply runs', async () => {
    const store = connectedStore(routeFetch({ 'machine.list': { items: [] } }))
    store.store.update((state) => {
      state.sync.applying = true
      state.statuses = { a: { state: 'connected', progress: { phase: 'syncing', attempt: 3, total: 5, item: 'dsh-tauri-ssh-ui' } } }
    })
    render(<SyncPanel store={store} t={t} />)
    await waitFor(() => expect(screen.getByTestId('sync-progress')).toBeTruthy())
    expect(screen.getByTestId('sync-progress').textContent).toContain('3/5')
    expect(screen.getByTestId('sync-progress').textContent).toContain('dsh-tauri-ssh-ui')
    // 3/5 起跑（已完成 2 项）→ 进度条 40%
    const fill = screen.getByTestId('sync-progress').querySelector('[class*="sync-bar-fill"]') as HTMLElement
    expect(fill.style.width).toBe('40%')
    expect(screen.getByTestId('sync-apply').textContent).toContain('Syncing')
  })

  it('renders partial failures per item with reasons and a retry that re-sends only them', async () => {
    const fetchFn = routeFetch({ 'sync.apply': { items: [] }, 'machine.list': { items: [] } })
    const store = connectedStore(fetchFn)
    store.store.update((state) => {
      state.sync.results = [
        { kind: 'plugin', name: 'dsh-market', ok: true },
        { kind: 'skill', name: 'alpha', root: 'dsh', ok: false, error: 'exit 1: read-only file system' },
      ]
    })
    render(<SyncPanel store={store} t={t} />)
    await waitFor(() => expect(screen.getByTestId('sync-results')).toBeTruthy())
    expect(screen.getByTestId('sync-result-dsh-market').dataset.ok).toBe('true')
    const failed = screen.getByTestId('sync-result-alpha')
    expect(failed.dataset.ok).toBe('false')
    expect(failed.textContent).toContain('read-only file system')
    expect(failed.textContent).toContain('(dsh)')
    expect(screen.getByText(/1 succeeded, 1 failed/)).toBeTruthy()

    fireEvent.click(screen.getByTestId('sync-retry'))
    await waitFor(() => expect(applyCalls(fetchFn)).toHaveLength(1))
    expect(applyCalls(fetchFn)[0]).toEqual({
      machineId: 'a',
      plugins: [],
      skills: [{ name: 'alpha', root: 'dsh' }],
    })
  })

  it('keeps the failure headline cause-first and shows the raw output on demand', async () => {
    const store = connectedStore(routeFetch({}))
    store.store.update((state) => {
      state.sync.results = [{
        kind: 'plugin',
        name: 'dsh-better-sidebar',
        ok: false,
        error: 'exit 1: make: *** [pty.target.mk:119] Error 127 | gyp ERR! stack Error: `make` failed with exit code: 2',
        log: 'Progress: resolved 584\nmake: *** [pty.target.mk:119] Error 127\n[ERR_PNPM_PREPARE_PACKAGE] failed',
      }]
    })
    render(<SyncPanel store={store} t={t} />)
    await waitFor(() => expect(screen.getByTestId('sync-results')).toBeTruthy())
    const row = screen.getByTestId('sync-result-dsh-better-sidebar')
    expect(row.textContent).toContain('Error 127')
    expect(row.textContent).not.toContain('Progress: resolved')
    // 完整输出默认收起，点开才显示（长日志不糊在行内）
    const toggle = screen.getByTestId('sync-log-toggle-dsh-better-sidebar')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('sync-log')).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByTestId('sync-log-toggle-dsh-better-sidebar').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('sync-log').textContent).toContain('ERR_PNPM_PREPARE_PACKAGE')
  })

  it('renders a complete failure with every reason visible', async () => {
    const store = connectedStore(routeFetch({}))
    store.store.update((state) => {
      state.sync.results = [
        { kind: 'plugin', name: 'dsh-market', ok: false, error: 'exit 1: ERR_PNPM_NO_MATCH' },
        { kind: 'skill', name: 'alpha', root: 'dsh', ok: false, error: 'exit 1: read-only file system' },
      ]
    })
    render(<SyncPanel store={store} t={t} />)
    await waitFor(() => expect(screen.getByTestId('sync-results')).toBeTruthy())
    expect(screen.getByText(/0 succeeded, 2 failed/)).toBeTruthy()
    expect(screen.getByTestId('sync-result-dsh-market').textContent).toContain('ERR_PNPM_NO_MATCH')
    expect(screen.getByTestId('sync-result-alpha').textContent).toContain('read-only file system')
  })

  it('surfaces a request-level failure without swallowing previous results', async () => {
    const fetchFn = routeFetch({ 'sync.apply': { items: [] } }, ['sync.apply'])
    const store = connectedStore(fetchFn)
    store.store.update((state) => {
      state.sync.results = [{ kind: 'plugin', name: 'dsh-market', ok: true }]
    })
    render(<SyncPanel store={store} t={t} />)
    await waitFor(() => expect(screen.getByTestId('sync-apply')).toBeTruthy())
    fireEvent.click(screen.getByTestId('sync-apply'))
    await waitFor(() => expect(screen.getByText(/The sync request failed: sync.apply broke/)).toBeTruthy())
    expect(screen.getByTestId('sync-result-dsh-market')).toBeTruthy()
  })

  it('disables apply with an empty tick set', async () => {
    const store = connectedStore(routeFetch({ 'machine.list': { items: [] } }))
    render(<SyncPanel store={store} t={t} />)
    await waitFor(() => expect(screen.getByText('Clear')).toBeTruthy())
    fireEvent.click(screen.getByText('Clear'))
    expect(screen.getByTestId('sync-apply').hasAttribute('disabled')).toBe(true)
  })

  it('loads the machine list itself and offers the connected machine as the target', async () => {
    // 本分区可以不经机器页直达：store 还没拉过列表时它必须自己拉一次，
    // 否则已连接的机器在这里看不见（回归：首版漏了这步，页面永远显示空态）。
    const fetchFn = routeFetch({
      'machine.list': { items: [{ ...machineA, state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:1' }] },
      'sync.preview': preview,
    })
    const store = new MachinesStore(fetchFn)
    render(<SyncPanel store={store} t={t} />)
    await waitFor(() => expect(screen.getByTestId('sync-target-a')).toBeTruthy())
    expect(apiMethods(fetchFn)).toContain('machine.list')
    expect(screen.getByTestId('sync-apply').textContent).toContain('Sync to alpha')
    expect(screen.queryByTestId('sync-empty')).toBeNull()
  })

  it('points a remote-session instance back at the initiating machine', async () => {
    const store = new MachinesStore(routeFetch({ 'machine.list': { items: [] }, 'session.role': { remote: true, origin: 'ops' } }))
    render(<SyncPanel store={store} t={t} />)
    await waitFor(() => expect(screen.getByTestId('sync-remote-note')).toBeTruthy())
    expect(screen.getByTestId('sync-remote-note').textContent).toContain('Sync to remote')
    expect(screen.queryByTestId('sync-apply')).toBeNull()
  })

  it('shows the not-connected note when no machine is connected', async () => {
    const store = new MachinesStore(routeFetch({}))
    store.store.update((state) => {
      state.status = 'ready'
      state.machines = [machineA]
      state.statuses = { a: { state: 'disconnected' } }
      state.sync = { status: 'ready', error: null, preview, applying: false, results: null }
    })
    render(<SyncPanel store={store} t={t} />)
    await waitFor(() => expect(screen.getByTestId('sync-empty')).toBeTruthy())
    expect(screen.getByTestId('sync-empty').textContent).toContain('No connected machines')
    expect(screen.queryByTestId('sync-apply')).toBeNull()
  })

  it('shows the preview load failure with the reason', async () => {
    const fetchFn = routeFetch({}, ['sync.preview'])
    const store = new MachinesStore(fetchFn)
    store.store.update((state) => {
      state.status = 'ready'
    })
    render(<SyncPanel store={store} t={t} />)
    await waitFor(() => expect(screen.getByText(/Failed to load the sync list: sync.preview broke/)).toBeTruthy())
  })
})

/** The /api-ssh methods the fake fetch received, in call order. */
function apiMethods(fetchFn: ReturnType<typeof vi.fn>): string[] {
  return fetchFn.mock.calls.map(call => (JSON.parse(String(call[1]?.body)) as { method: string }).method)
}

/** The sync.apply request bodies the fake fetch received. */
function applyCalls(fetchFn: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return fetchFn.mock.calls
    .map(call => JSON.parse(String(call[1]?.body)) as { method: string, payload: Record<string, unknown> })
    .filter(call => call.method === 'sync.apply')
    .map(call => call.payload)
}
