import type { SessionId, SessionsRuntimeLike, WorkspaceId, WorkspacesRuntimeLike, WorkspaceViewLike } from '../types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { postOpenPath, postOpenUrl } from '../apis'
import {
  archiveSession,
  archiveSessions,
  deleteWorkspace,
  forkSession,
  isSessionPinned,
  loadUngroupedSessions,
  loadWorkspaceSessions,
  openExternalUrl,
  openInExplorer,
  renameSession,
  startWorkspaceSession,
  supportsSessionPin,
  togglePinSession,
} from './menu'

vi.mock('../apis', () => ({ postOpenPath: vi.fn(), postOpenUrl: vi.fn() }))

const sid = (value: string): SessionId => value as SessionId

/** 只替代表达层：locale 的真身经 `dsh-tauri/client` 拉入浏览器运行时，node 下无法加载。 */
vi.mock('../locales', () => ({
  locale: {
    text: (key: string, params: Record<string, unknown> = {}) =>
      params.reason ? `${key}: ${params.reason}` : key,
  },
}))

/** `dsh-tauri/client` 的真身是浏览器 bundle，node 下无法加载；此处只补被测路径涉及的 lodash helpers。 */
vi.mock('dsh-tauri/client', async () => {
  const lodash = await import('lodash-es')
  return {
    difference: lodash.difference,
    filter: lodash.filter,
    get: lodash.get,
    includes: lodash.includes,
  }
})

const postOpenPathMock = vi.mocked(postOpenPath)
const postOpenUrlMock = vi.mocked(postOpenUrl)

const WORKSPACE_ID = 'ws-1' as WorkspaceId

beforeEach(() => {
  vi.clearAllMocks()
})

describe('openInExplorer', () => {
  it('posts the directory to the plugin-owned open/path route', async () => {
    postOpenPathMock.mockResolvedValue({ ok: true })

    await expect(openInExplorer({ path: 'C:\\workspace' })).resolves.toEqual({ ok: true })
    expect(postOpenPathMock).toHaveBeenCalledWith({ path: 'C:\\workspace' })
  })

  it('surfaces the route error instead of a JSON SyntaxError', async () => {
    postOpenPathMock.mockResolvedValue({ ok: false, error: 'not-a-directory' })

    const outcome = await openInExplorer({ path: 'C:\\workspace' })

    expect(outcome.ok).toBe(false)
    expect(outcome.error).toMatch(/openFailed: not-a-directory/)
  })

  it('falls back to the generic error when the route reports no detail', async () => {
    postOpenPathMock.mockResolvedValue({ ok: false })

    const outcome = await openInExplorer({ path: 'C:\\workspace' })

    expect(outcome.ok).toBe(false)
    expect(outcome.error).toMatch(/openFailed: unknownError/)
  })
})

describe('openExternalUrl', () => {
  it('only forwards http(s) links, normalized through URL', async () => {
    postOpenUrlMock.mockResolvedValue({ ok: true })

    await expect(openExternalUrl({ url: 'https://example.com' })).resolves.toEqual({ ok: true })
    expect(postOpenUrlMock).toHaveBeenCalledWith({ url: 'https://example.com/' })
  })

  it('rejects non-http schemes without touching the route', async () => {
    await expect(openExternalUrl({ url: 'javascript:alert(1)' }))
      .resolves
      .toEqual({ ok: false, error: 'openFailed: invalidLink' })
    await expect(openExternalUrl({ url: 'file:///etc/passwd' }))
      .resolves
      .toEqual({ ok: false, error: 'openFailed: invalidLink' })
    expect(postOpenUrlMock).not.toHaveBeenCalled()
  })

  it('surfaces the route error and the generic fallback', async () => {
    postOpenUrlMock.mockResolvedValue({ ok: false, error: 'blocked-by-policy' })
    await expect(openExternalUrl({ url: 'https://example.com' }))
      .resolves
      .toEqual({ ok: false, error: 'openFailed: blocked-by-policy' })

    postOpenUrlMock.mockResolvedValue({ ok: false })
    await expect(openExternalUrl({ url: 'https://example.com' }))
      .resolves
      .toEqual({ ok: false, error: 'openFailed: unknownError' })
  })

  it('returns the thrown message instead of rejecting', async () => {
    postOpenUrlMock.mockRejectedValue(new Error('socket closed'))

    await expect(openExternalUrl({ url: 'https://example.com' }))
      .resolves
      .toEqual({ ok: false, error: 'socket closed' })
  })
})

describe('renameSession', () => {
  const sessionsWith = (binding: unknown): SessionsRuntimeLike =>
    ({ binding: () => binding }) as unknown as SessionsRuntimeLike

  it('renames through the session binding when one exists', async () => {
    const rename = vi.fn(async () => ({ ok: true }))
    const outcome = await renameSession({
      sessions: sessionsWith({ session: { rename } }),
      sessionId: sid('s-1'),
      title: 'renamed',
    })

    expect(outcome).toEqual({ ok: true })
    expect(rename).toHaveBeenCalledWith('renamed')
  })

  it('reports the unavailable service when no binding is found', async () => {
    await expect(renameSession({ sessions: sessionsWith(undefined), sessionId: sid('s-1'), title: 'x' }))
      .resolves
      .toEqual({ ok: false, error: 'sessionServiceUnavailable' })
  })

  it('maps a failed rename to its message, falling back to renameFailed', async () => {
    const failing = sessionsWith({ session: { rename: async () => ({ ok: false, error: { message: 'locked' } }) } })
    await expect(renameSession({ sessions: failing, sessionId: sid('s-1'), title: 'x' }))
      .resolves
      .toEqual({ ok: false, error: 'locked' })

    const bare = sessionsWith({ session: { rename: async () => ({ ok: false }) } })
    await expect(renameSession({ sessions: bare, sessionId: sid('s-1'), title: 'x' }))
      .resolves
      .toEqual({ ok: false, error: 'renameFailed' })
  })

  it('returns the thrown message when rename rejects', async () => {
    const throwing = sessionsWith({
      session: {
        rename: async () => {
          throw new Error('offline')
        },
      },
    })

    await expect(renameSession({ sessions: throwing, sessionId: sid('s-1'), title: 'x' }))
      .resolves
      .toEqual({ ok: false, error: 'offline' })
  })
})

describe('archiveSession', () => {
  it('archives the given session id', async () => {
    const archive = vi.fn(async () => undefined)
    const outcome = await archiveSession({
      workspaces: { archiveSession: archive } as unknown as WorkspacesRuntimeLike,
      sessionId: sid('s-1'),
    })

    expect(outcome).toEqual({ ok: true })
    expect(archive).toHaveBeenCalledWith('s-1')
  })

  it('returns the thrown message when archiving rejects', async () => {
    const workspaces = {
      archiveSession: async () => {
        throw new Error('readonly')
      },
    } as unknown as WorkspacesRuntimeLike

    await expect(archiveSession({ workspaces, sessionId: sid('s-1') }))
      .resolves
      .toEqual({ ok: false, error: 'readonly' })
  })
})

describe('forkSession', () => {
  it('opens the forked child with increaseTitle', async () => {
    const open = vi.fn()
    const fork = vi.fn(async () => 's-child')
    const sessions = { fork, open } as unknown as SessionsRuntimeLike

    await expect(forkSession({ sessions, sessionId: sid('s-1') })).resolves.toEqual({ ok: true })
    expect(fork).toHaveBeenCalledWith({ sessionId: sid('s-1'), increaseTitle: true })
    expect(open).toHaveBeenCalledWith('s-child')
  })

  it('does not open anything when fork rejects', async () => {
    const open = vi.fn()
    const sessions = {
      fork: async () => {
        throw new Error('fork failed')
      },
      open,
    } as unknown as SessionsRuntimeLike

    await expect(forkSession({ sessions, sessionId: sid('s-1') }))
      .resolves
      .toEqual({ ok: false, error: 'fork failed' })
    expect(open).not.toHaveBeenCalled()
  })
})

describe('loadUngroupedSessions', () => {
  it('keeps only non-blank ids outside workspaces and the archive', async () => {
    const workspaces = {
      list: { getSnapshot: () => ({ items: [{ sessionIds: (['a', 'b'] as SessionId[]) }], archivedSessionIds: ['c'] }) },
    } as unknown as WorkspacesRuntimeLike
    const sessions = {
      list: {
        getSnapshot: () => ({
          ids: ['a', 'b', 'c', 'd', 'e', 'f'],
          byId: { a: {}, b: {}, c: {}, d: { blank: true }, e: {}, f: {} },
        }),
      },
    } as unknown as SessionsRuntimeLike

    await expect(loadUngroupedSessions({ workspaces, sessions })).resolves.toEqual(['e', 'f'])
  })

  it('excludes subagent sessions from the batch archive candidates (issue #1151)', async () => {
    const workspaces = {
      list: { getSnapshot: () => ({ items: [], archivedSessionIds: [] }) },
    } as unknown as WorkspacesRuntimeLike
    const sessions = {
      list: {
        getSnapshot: () => ({
          ids: ['formal', 'sub-1', 'sub-2'],
          byId: { 'formal': {}, 'sub-1': { origin: 'subagent' }, 'sub-2': { origin: 'subagent' } },
        }),
      },
    } as unknown as SessionsRuntimeLike

    await expect(loadUngroupedSessions({ workspaces, sessions })).resolves.toEqual(['formal'])
  })
})

describe('loadWorkspaceSessions', () => {
  const sessionsWith = (ids: string[]): SessionsRuntimeLike => ({
    list: { getSnapshot: () => ({ ids, byId: Object.fromEntries(ids.map(id => [id, {}])) }) },
  } as unknown as SessionsRuntimeLike)

  it('preserves order and duplicates without mutating either snapshot', async () => {
    const sessionIds = [sid('b'), sid('a'), sid('b'), sid('archived')]
    const archivedSessionIds = [sid('archived')]
    const workspaces = { list: { getSnapshot: () => ({ archivedSessionIds }) } } as unknown as WorkspacesRuntimeLike
    const workspace = { sessionIds } as unknown as WorkspaceViewLike

    await expect(loadWorkspaceSessions({ workspaces, sessions: sessionsWith(['a', 'b', 'archived']), workspace }))
      .resolves
      .toEqual(['b', 'a', 'b'])
    expect(sessionIds).toEqual(['b', 'a', 'b', 'archived'])
    expect(archivedSessionIds).toEqual(['archived'])
  })

  it('removes archived sessions from the workspace listing', async () => {
    const workspaces = {
      list: { getSnapshot: () => ({ items: [], archivedSessionIds: ['s2'] }) },
    } as unknown as WorkspacesRuntimeLike
    const workspace = { sessionIds: (['s1', 's2', 's3'] as SessionId[]) } as unknown as WorkspaceViewLike

    await expect(loadWorkspaceSessions({ workspaces, sessions: sessionsWith(['s1', 's2', 's3']), workspace }))
      .resolves
      .toEqual(['s1', 's3'])
  })

  it('excludes subagent and blank members the sidebar never renders', async () => {
    const workspaces = {
      list: { getSnapshot: () => ({ items: [], archivedSessionIds: [] }) },
    } as unknown as WorkspacesRuntimeLike
    const workspace = { sessionIds: (['formal', 'sub', 'blank', 'missing'] as SessionId[]) } as unknown as WorkspaceViewLike
    const sessions = {
      list: {
        getSnapshot: () => ({
          ids: ['formal', 'sub', 'blank'],
          byId: { formal: {}, sub: { origin: 'subagent' }, blank: { blank: true } },
        }),
      },
    } as unknown as SessionsRuntimeLike

    await expect(loadWorkspaceSessions({ workspaces, sessions, workspace })).resolves.toEqual(['formal'])
  })
})

describe('archiveSessions', () => {
  it('archives every id in order', async () => {
    const archiveSessionMock = vi.fn(async () => undefined)
    const outcome = await archiveSessions({
      workspaces: { archiveSession: archiveSessionMock } as unknown as WorkspacesRuntimeLike,
      sessionIds: (['s1', 's2'] as SessionId[]),
    })

    expect(outcome).toEqual({ ok: true })
    expect(archiveSessionMock).toHaveBeenNthCalledWith(1, 's1')
    expect(archiveSessionMock).toHaveBeenNthCalledWith(2, 's2')
  })

  it('stops at the first failure and reports it', async () => {
    const archiveSessionMock = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('locked'))

    await expect(archiveSessions({
      workspaces: { archiveSession: archiveSessionMock } as unknown as WorkspacesRuntimeLike,
      sessionIds: (['s1', 's2', 's3'] as SessionId[]),
    })).resolves.toEqual({ ok: false, error: 'locked' })
    expect(archiveSessionMock).toHaveBeenCalledTimes(2)
  })
})

describe('deleteWorkspace', () => {
  it('removes only the registration', async () => {
    const remove = vi.fn(async () => undefined)
    const outcome = await deleteWorkspace({
      workspaces: { delete: remove } as unknown as WorkspacesRuntimeLike,
      workspaceId: WORKSPACE_ID,
    })

    expect(outcome).toEqual({ ok: true })
    expect(remove).toHaveBeenCalledWith('ws-1')
  })

  it('returns the thrown message when deletion rejects', async () => {
    const workspaces = {
      delete: async () => {
        throw new Error('busy')
      },
    } as unknown as WorkspacesRuntimeLike

    await expect(deleteWorkspace({ workspaces, workspaceId: WORKSPACE_ID }))
      .resolves
      .toEqual({ ok: false, error: 'busy' })
  })
})

describe('session pin (official 0.1.7 capability)', () => {
  const workspacesWith = (
    overrides: Record<string, unknown>,
    pinnedSessionIds?: SessionId[],
  ): WorkspacesRuntimeLike =>
    ({
      ...overrides,
      list: { getSnapshot: () => ({ items: [], archivedSessionIds: [], pinnedSessionIds }) },
    }) as unknown as WorkspacesRuntimeLike

  it('reports the capability only when pin and unpin both exist', () => {
    expect(supportsSessionPin(workspacesWith({ pinSession: vi.fn(), unpinSession: vi.fn() }))).toBe(true)
    expect(supportsSessionPin(workspacesWith({ pinSession: vi.fn() }))).toBe(false)
    expect(supportsSessionPin(workspacesWith({ unpinSession: vi.fn() }))).toBe(false)
    expect(supportsSessionPin(workspacesWith({}))).toBe(false)
  })

  it('reads the pinned set from the workspace snapshot', () => {
    const workspaces = workspacesWith({}, [sid('s-1')])
    expect(isSessionPinned({ workspaces, sessionId: sid('s-1') })).toBe(true)
    expect(isSessionPinned({ workspaces, sessionId: sid('s-2') })).toBe(false)
  })

  it('treats a pre-0.1.7 snapshot without a pinned set as unpinned', () => {
    const workspaces = {
      list: { getSnapshot: () => ({ items: [], archivedSessionIds: [] }) },
    } as unknown as WorkspacesRuntimeLike

    expect(isSessionPinned({ workspaces, sessionId: sid('s-1') })).toBe(false)
  })

  it('pins an unpinned session and unpins a pinned one', async () => {
    const pinSession = vi.fn(async () => undefined)
    const unpinSession = vi.fn(async () => undefined)
    const workspaces = workspacesWith({ pinSession, unpinSession })

    await expect(togglePinSession({ workspaces, sessionId: sid('s-1'), pinned: false }))
      .resolves
      .toEqual({ ok: true })
    expect(pinSession).toHaveBeenCalledWith('s-1')
    expect(unpinSession).not.toHaveBeenCalled()

    await expect(togglePinSession({ workspaces, sessionId: sid('s-1'), pinned: true }))
      .resolves
      .toEqual({ ok: true })
    expect(unpinSession).toHaveBeenCalledWith('s-1')
  })

  it('invokes the official method with the service as receiver', async () => {
    const seen: unknown[] = []
    const workspaces = workspacesWith({
      pinSession(sessionId: SessionId) {
        seen.push(this)
        expect(sessionId).toBe('s-1')
        return Promise.resolve()
      },
      unpinSession: async () => undefined,
    })

    await togglePinSession({ workspaces, sessionId: sid('s-1'), pinned: false })
    expect(seen[0]).toBe(workspaces)
  })

  it('refuses to run when the capability is absent', async () => {
    await expect(togglePinSession({ workspaces: workspacesWith({}), sessionId: sid('s-1'), pinned: false }))
      .resolves
      .toEqual({ ok: false, error: 'pinSessionUnavailable' })
  })

  it('returns the thrown message when the official call rejects', async () => {
    const workspaces = workspacesWith({
      pinSession: async () => {
        throw new Error('archive-conflict')
      },
      unpinSession: async () => undefined,
    })

    await expect(togglePinSession({ workspaces, sessionId: sid('s-1'), pinned: false }))
      .resolves
      .toEqual({ ok: false, error: 'archive-conflict' })
  })
})

describe('startWorkspaceSession', () => {
  it('reports the missing navigation capability instead of silently doing nothing', async () => {
    // legacy 投影在两份候选服务都没有 startSession 时把该属性读为 undefined（不是抛错）；
    // 旧实现用 `startSession?.()` 可选链，点击菜单项后完全没有反馈（issue #780）。
    const workspaces = {
      list: { getSnapshot: () => ({ items: [], archivedSessionIds: [] }) },
    } as unknown as WorkspacesRuntimeLike

    await expect(startWorkspaceSession({ workspaces, workspaceId: WORKSPACE_ID }))
      .resolves
      .toEqual({ ok: false, error: 'newSessionUnavailable' })
  })

  it('starts the session in the requested workspace with the service as receiver', async () => {
    const seen: unknown[] = []
    const startSession = vi.fn(function (this: unknown, workspaceId: WorkspaceId) {
      seen.push(this)
      expect(workspaceId).toBe(WORKSPACE_ID)
    })
    const workspaces = { startSession } as unknown as WorkspacesRuntimeLike

    await expect(startWorkspaceSession({ workspaces, workspaceId: WORKSPACE_ID }))
      .resolves
      .toEqual({ ok: true })
    expect(startSession).toHaveBeenCalledWith(WORKSPACE_ID)
    expect(seen[0]).toBe(workspaces)
  })

  it('awaits an async official implementation and surfaces its rejection', async () => {
    const workspaces = {
      startSession: async () => {
        throw new Error('workspace-locked')
      },
    } as unknown as WorkspacesRuntimeLike

    await expect(startWorkspaceSession({ workspaces, workspaceId: WORKSPACE_ID }))
      .resolves
      .toEqual({ ok: false, error: 'workspace-locked' })
  })
})
