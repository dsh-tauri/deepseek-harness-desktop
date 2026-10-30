import type { Context } from '@deepseek-ai/cordis'
import type { ArchiveRegistrySurface, SessionHost, SessionLike, WorkspaceEntryLike } from '../types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { archiveHooks } from '../events'
import { server } from '../server'
import { archive } from './archive'
import { ledger } from './ledger'
import { session } from './session'

const disposers: Array<() => void> = []

function harness(ids = ['a', 'b', 'orphan']) {
  const operations: string[] = []
  let state = { archivedSessionIds: [...ids], extra: 'preserved' }
  const sessions = new Map<string, SessionLike>([
    ['a', { id: 'a', header: { cwd: '/project', createdAt: 1 }, title: 'base', displayTitle: 'display' }],
    ['b', { id: 'b', header: { cwd: '/project', createdAt: 2 } }],
  ])
  const workspaces: WorkspaceEntryLike[] = [
    { id: 'first', path: '/project', sessionIds: ['a', 'b', 'keep'] },
    { id: 'last', path: '/project', sessionIds: ['a', 'b', 'keep'] },
  ]
  const table = {
    entries: () => workspaces.map(workspace => [workspace.id, workspace] as [string, WorkspaceEntryLike]),
    update: vi.fn(async (id: string, update: (value: { sessionIds?: readonly string[] }) => { sessionIds: string[] }) => {
      operations.push(`account:${id}`)
      const workspace = workspaces.find(item => item.id === id)!
      Object.assign(workspace, update(workspace))
    }),
  }
  const registry: ArchiveRegistrySurface = {
    get archivedSessionIds() { return state.archivedSessionIds },
    archiveSession: vi.fn(async (id) => {
      operations.push(`archive:${id}`)
      if (!state.archivedSessionIds.includes(id))
        state.archivedSessionIds.push(id)
    }),
    list: () => workspaces,
    enqueueOperation: vi.fn(async (fn) => {
      operations.push('enqueue')
      await fn()
      operations.push('commit')
    }),
    requireState: () => state,
    requireTable: () => table,
    setState: vi.fn(async (next) => {
      operations.push('state')
      state = next as typeof state
    }),
  }
  const host: SessionHost = {
    sessions: {
      get: id => sessions.get(id),
      remove: vi.fn((id) => {
        operations.push(`memory:${id}`)
        return sessions.delete(id)
      }),
    },
    workspaceRegistry: registry,
    logger: { warn: vi.fn(), info: vi.fn() },
  }
  disposers.push(server({ ...host, webServer: { register: () => () => {} } } as unknown as Context))
  const removeDir = vi.spyOn(session, 'removeDir').mockImplementation((id) => {
    operations.push(`disk:${id}`)
    return id !== 'orphan'
  })
  return { host, registry, table, workspaces, sessions, operations, removeDir, state: () => state }
}

beforeEach(() => {
  archiveHooks.removeAllHooks()
})

afterEach(() => {
  archiveHooks.removeAllHooks()
  disposers.splice(0).forEach(dispose => dispose())
  vi.restoreAllMocks()
})

describe('archive and ledger behavior', () => {
  it('projects resolved sessions, preserves display title and lists orphan ids without mutating snapshots', () => {
    const h = harness()
    const snapshot = ledger.list()
    snapshot.pop()
    expect(ledger.list()).toEqual(['a', 'b', 'orphan'])
    expect(ledger.load()).toEqual({
      archivedSessionIds: ['a', 'b'],
      meta: { a: { cwd: '/project', createdAt: 1, title: 'display' }, b: { cwd: '/project', createdAt: 2 } },
    })
    expect(h.operations).toEqual([])
  })

  it('archives in input order and preserves per-input lifecycle notifications including duplicates', async () => {
    const h = harness([])
    const added = vi.fn()
    archiveHooks.hook('archive:added', added)
    expect(await archive.archiveWorkspace(['b', 'a', 'b'])).toEqual({
      archivedSessionIds: ['b', 'a'],
      meta: { b: { cwd: '/project', createdAt: 2 }, a: { cwd: '/project', createdAt: 1, title: 'display' } },
    })
    await archive.archive('a')
    await Promise.resolve()
    expect(h.operations).toEqual(['archive:b', 'archive:a', 'archive:b', 'archive:a'])
    expect(added.mock.calls).toEqual([['b'], ['a'], ['b'], ['a']])
  })

  it('deduplicates deletes in first-occurrence order, removes all accounting matches and commits before notifying', async () => {
    const h = harness(['a', 'b', 'a', 'orphan'])
    archiveHooks.hook('archive:deleted', ids => h.operations.push(`hook:${ids.join(',')}`))
    expect(await archive.deleteSelected(['', 'b', 'b', 'a'])).toEqual({ ok: true })
    await Promise.resolve()
    expect(h.removeDir.mock.calls).toEqual([['b'], ['a']])
    expect(h.state()).toEqual({ archivedSessionIds: ['orphan'], extra: 'preserved' })
    expect(h.workspaces.map(workspace => workspace.sessionIds)).toEqual([['keep'], ['keep']])
    expect(h.operations).toEqual(['memory:b', 'memory:a', 'disk:b', 'disk:a', 'enqueue', 'account:first', 'account:last', 'state', 'commit', 'hook:b,a'])
  })

  it('delete and deleteAll remain callable public entry points, including unresolved archived ids', async () => {
    const h = harness()
    expect(await archive.delete('a')).toEqual({ ok: true })
    expect(await archive.deleteAll()).toEqual({ ok: true })
    expect(h.removeDir.mock.calls).toEqual([['a'], ['b'], ['orphan']])
    expect(h.state().archivedSessionIds).toEqual([])
    await expect(archive.deleteAll()).rejects.toThrow('缺少 sessionIds')
  })

  it('rejects empty or nonmember ids before any destructive work and reports the first missing id', async () => {
    const h = harness()
    await expect(archive.deleteSelected(['', ''])).rejects.toThrow('缺少 sessionIds')
    await expect(archive.deleteSelected(['b', 'missing', 'other'])).rejects.toThrow('会话 \'missing\' 不在归档集合中，拒绝删除')
    expect(h.operations).toEqual([])
    expect(h.removeDir).not.toHaveBeenCalled()
  })

  it.each(['enqueueOperation', 'requireTable'] as const)('preflights missing %s before memory or disk mutation', async (field) => {
    const h = harness()
    h.registry[field] = undefined
    await expect(archive.delete('a')).rejects.toThrow('宿主 workspaceRegistry 未暴露')
    expect(h.operations).toEqual([])
    expect(h.removeDir).not.toHaveBeenCalled()
  })

  it('checks live SessionStore.remove before disk deletion but does not require it for orphan ids', async () => {
    const h = harness()
    h.host.sessions.remove = undefined
    await expect(archive.delete('a')).rejects.toThrow('宿主未提供 SessionStore.remove，请先更新桌面壳')
    expect(h.operations).toEqual([])
    expect(await archive.delete('orphan')).toEqual({ ok: true })
    expect(h.removeDir).toHaveBeenCalledExactlyOnceWith('orphan')
  })

  it('session.remove checks every input while dropping empty or unresolved ids and preserving live duplicates', () => {
    const h = harness()
    const get = vi.spyOn(h.host.sessions, 'get')
    expect(session.remove(['', 'a', 'missing', 'a'])).toEqual(['a'])
    expect(get.mock.calls).toEqual([[''], ['a'], ['missing'], ['a']])
    expect(h.operations).toEqual(['memory:a', 'memory:a'])
  })

  it('warns on best-effort memory failures while still deleting disk data', async () => {
    const h = harness()
    h.host.sessions.remove = vi.fn(() => false)
    await archive.delete('a')
    expect(h.host.logger?.warn).toHaveBeenCalledExactlyOnceWith('[dsh-tauri-archive] 会话 \'a\' 无法从内存移除，刷新后消失')
    expect(h.removeDir).toHaveBeenCalledExactlyOnceWith('a')
  })

  it('aborts a physical failure before registry mutation or deleted hooks and can retry the unchanged ledger', async () => {
    const h = harness()
    const deleted = vi.fn()
    archiveHooks.hook('archive:deleted', deleted)
    h.removeDir.mockImplementation((id) => {
      if (id === 'b')
        throw new Error('locked')
      return true
    })
    await expect(archive.deleteSelected(['a', 'b'])).rejects.toThrow('删除会话数据失败：b（locked）')
    expect(h.state().archivedSessionIds).toEqual(['a', 'b', 'orphan'])
    expect(h.registry.enqueueOperation).not.toHaveBeenCalled()
    expect(deleted).not.toHaveBeenCalled()
    h.removeDir.mockReturnValue(false)
    await archive.deleteSelected(['a', 'b'])
    await Promise.resolve()
    expect(h.state().archivedSessionIds).toEqual(['orphan'])
    expect(deleted).toHaveBeenCalledExactlyOnceWith(['a', 'b'])
  })

  it('reattaches missing accounting to the last workspace with the same path and avoids duplicate slots', async () => {
    const h = harness()
    h.workspaces[0]!.sessionIds = ['keep']
    h.workspaces[1]!.sessionIds = ['keep']
    const restored = vi.fn()
    archiveHooks.hook('archive:restored', restored)
    expect(await archive.unarchive('a')).toEqual({ ok: true })
    await ledger.remove(['a', 'a'], 'attach')
    await Promise.resolve()
    expect(h.workspaces.map(workspace => workspace.sessionIds)).toEqual([['keep'], ['keep', 'a']])
    expect(h.table.update).toHaveBeenCalledTimes(1)
    expect(h.state().archivedSessionIds).toEqual(['b', 'orphan'])
    expect(restored).toHaveBeenCalledExactlyOnceWith('a')
    expect(h.removeDir).not.toHaveBeenCalled()
  })

  it('restore tolerates missing optional workspace listing and leaves existing accounting intact', async () => {
    const h = harness()
    h.registry.list = undefined
    await ledger.remove(['a'], 'attach')
    expect(h.table.update).not.toHaveBeenCalled()
    expect(h.state().archivedSessionIds).toEqual(['b', 'orphan'])
    expect(h.workspaces[0]!.sessionIds).toEqual(['a', 'b', 'keep'])
  })
})
