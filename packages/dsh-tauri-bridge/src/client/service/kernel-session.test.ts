import type { SessionId, SessionListState, SessionSummary } from 'dsh-tauri/client'
import type { BackendDetection, KernelBinding } from '../../shared/types'
import { defineAdapter } from 'dsh-tauri/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { postSessions } from '../apis'
import { kernelStore } from '../store/modules/kernel-store'
import { createKernelSession } from './kernel-session'

vi.hoisted(() => vi.stubGlobal('localStorage', undefined))
vi.mock('../apis', () => ({ postSessions: vi.fn() }))

const BINDING: KernelBinding = { backend: 'codex', nativeSessionId: 'native-a', sessionId: 'bridge-session' }
const BACKENDS: BackendDetection[] = [
  { id: 'dsh', installed: true, auth: 'ok', version: null, drift: false, hint: null },
  { id: 'codex', installed: true, auth: 'ok', version: '1.0', drift: false, hint: null },
  { id: 'claude', installed: false, auth: 'unknown', version: null, drift: false, hint: null },
]

function row(id: string, identity: KernelBinding | null | undefined, patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: id as SessionId,
    displayTitle: id,
    blank: true,
    cwd: '/project',
    running: false,
    retainedBy: {},
    updatedAt: 1,
    projectionValues: identity === undefined ? {} : { bridgeKernel: identity },
    ...patch,
  }
}

function fixture(rows: SessionSummary[] = [], current?: string, grouped = false) {
  let state: SessionListState & { current?: SessionId } = {
    ids: rows.map(item => item.id),
    byId: Object.fromEntries(rows.map(item => [item.id, item])),
    phase: 'ready',
    projectionsBySession: {},
    ...(current === undefined ? {} : { current: current as SessionId }),
  }
  const archivedSessionIds: SessionId[] = []
  const create = vi.fn(async () => 'official-new')
  const refresh = vi.fn(async () => {})
  const refreshProjections = vi.fn(async () => {})
  const sessions = {
    list: { getSnapshot: () => state, subscribe: () => () => {} },
    create,
    refresh,
    refreshProjections,
  }
  const workspaces = {
    list: { getSnapshot: () => ({
      items: grouped ? [{ workspaceId: 'workspace-a', path: '/project', sessionIds: rows.map(item => item.id) }] : [],
      archivedSessionIds,
    }), subscribe: () => () => {} },
  }
  const services: Record<string, unknown> = { sessions, workspaces }
  const adapter = defineAdapter({ get: (name: string) => services[name] })
  function publish(identity: KernelBinding | null | undefined): void {
    const id = 'bridge-session' as SessionId
    state = {
      ...state,
      ids: [...state.ids, id],
      byId: { ...state.byId, [id]: row(id, identity) },
      projectionsBySession: { ...state.projectionsBySession, [id]: { values: identity === undefined ? {} : { bridgeKernel: identity }, state: 'ready', error: null } },
    }
  }
  return { adapter, sessions, services, archivedSessionIds, create, refresh, refreshProjections, publish }
}

beforeEach(() => {
  kernelStore.$patch({ selected: 'dsh', phase: 'ready', error: null, backends: BACKENDS })
  vi.mocked(postSessions).mockReset().mockResolvedValue({ sessionId: 'bridge-session' })
})

afterEach(() => {
  kernelStore.$patch({ selected: 'dsh', phase: 'idle', error: null, backends: [] })
  vi.restoreAllMocks()
})

afterAll(() => vi.unstubAllGlobals())

describe('explicit kernel session creation', () => {
  it('deepseek uses the official fresh factory without a native HTTP request', async () => {
    const { adapter, create } = fixture()
    await expect(createKernelSession(adapter, 'dsh', { workspaceId: 'workspace-a' }, () => true)).resolves.toBe('official-new')
    expect(create).toHaveBeenCalledWith({ workspaceId: 'workspace-a' })
    expect(postSessions).not.toHaveBeenCalled()
  })

  it('native creation sends the generated body then refreshes catalog and verifies the durable projection', async () => {
    const { adapter, create, refresh, refreshProjections, publish } = fixture()
    const calls: string[] = []
    vi.mocked(postSessions).mockImplementation(async () => {
      calls.push('create')
      return { sessionId: 'bridge-session' }
    })
    refresh.mockImplementation(async () => {
      calls.push('catalog')
    })
    refreshProjections.mockImplementation(async () => {
      calls.push('projection')
      publish(BINDING)
    })
    await expect(createKernelSession(adapter, 'codex', { workspaceId: 'workspace-a' }, () => true, 'coding')).resolves.toBe('bridge-session')
    expect(postSessions).toHaveBeenCalledWith({ backend: 'codex', workspaceId: 'workspace-a', agentPreset: 'coding' })
    expect(refreshProjections).toHaveBeenCalledWith('bridge-session')
    expect(calls).toEqual(['create', 'catalog', 'projection'])
    expect(create).not.toHaveBeenCalled()
  })

  it('unavailable detection rejects before either official or native creation', async () => {
    const { adapter, create } = fixture()
    await expect(createKernelSession(adapter, 'claude', {}, () => true)).rejects.toThrow('selected native kernel is unavailable')
    expect(postSessions).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('missing official refresh capability rejects before the native request', async () => {
    const { adapter, sessions } = fixture()
    Reflect.deleteProperty(sessions, 'refreshProjections')
    await expect(createKernelSession(adapter, 'codex', {}, () => true)).rejects.toThrow('Official session projection refresh is unavailable')
    expect(postSessions).not.toHaveBeenCalled()
  })

  it('native request failure never falls back to a DeepSeek session', async () => {
    const failure = new Error('native daemon refused')
    const { adapter, create, refresh } = fixture()
    vi.mocked(postSessions).mockRejectedValue(failure)
    await expect(createKernelSession(adapter, 'codex', {}, () => true)).rejects.toBe(failure)
    expect(create).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('empty created session identity rejects before catalog refresh', async () => {
    const { adapter, refresh } = fixture()
    vi.mocked(postSessions).mockResolvedValue({ sessionId: ' ' })
    await expect(createKernelSession(adapter, 'codex', {}, () => true)).rejects.toThrow('returned no session identity')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('cancelled native creation performs no catalog or projection work', async () => {
    const { adapter, refresh, refreshProjections } = fixture()
    let active = true
    vi.mocked(postSessions).mockImplementation(async () => {
      active = false
      return { sessionId: 'bridge-session' }
    })
    await expect(createKernelSession(adapter, 'codex', {}, () => active)).rejects.toThrow('creation was cancelled')
    expect(refresh).not.toHaveBeenCalled()
    expect(refreshProjections).not.toHaveBeenCalled()
  })

  it('disposal during catalog refresh prevents the next projection request', async () => {
    const { adapter, refresh, refreshProjections } = fixture()
    let active = true
    refresh.mockImplementation(async () => {
      active = false
    })
    await expect(createKernelSession(adapter, 'codex', {}, () => active)).rejects.toThrow('creation was cancelled')
    expect(refreshProjections).not.toHaveBeenCalled()
  })

  it.each([
    ['missing', undefined],
    ['deepseek', null],
    ['inherited owner', { ...BINDING, sessionId: 'parent-session' }],
    ['wrong kernel', { ...BINDING, backend: 'claude' }],
    ['empty native id', { ...BINDING, nativeSessionId: '' }],
  ] as const)('a %s projection cannot validate the created native session', async (_, identity) => {
    const { adapter, create, refreshProjections, publish } = fixture()
    refreshProjections.mockImplementation(async () => publish(identity))
    await expect(createKernelSession(adapter, 'codex', {}, () => true)).rejects.toThrow('no verified native kernel binding')
    expect(create).not.toHaveBeenCalled()
  })

  it('existing-session options are rejected rather than rebinding that session', async () => {
    const { adapter, create } = fixture()
    await expect(createKernelSession(adapter, 'dsh', { sessionId: 'existing' }, () => true)).rejects.toThrow('Existing sessions cannot change kernels')
    expect(create).not.toHaveBeenCalled()
    expect(postSessions).not.toHaveBeenCalled()
  })

  it('ambiguous workspace and cwd options reject before any creation', async () => {
    const { adapter, create } = fixture()
    await expect(createKernelSession(adapter, 'codex', { workspaceId: 'workspace-a', cwd: '/project' }, () => true)).rejects.toThrow('either workspaceId or cwd')
    expect(create).not.toHaveBeenCalled()
    expect(postSessions).not.toHaveBeenCalled()
  })
})
