import type { ArchiveRegistrySurface, ArchiveTableSurface, SessionHost, SessionLike } from '../types'
import type { ArchiveAccounting, ArchivedListPayload } from './ledger.types'
import { getServerContext } from 'dsh-h3/utils'
import { defineService } from 'dsh-tauri'
import { server } from '../server'
import { session } from './session'

export const ledger = defineService({
  list(): string[] {
    const registry = getServerContext<SessionHost>(server).workspaceRegistry
    requireWritableRegistry(registry)
    requireTable(registry)
    return [...(registry.archivedSessionIds ?? [])]
  },

  load(): ArchivedListPayload {
    const archivedSessionIds: string[] = []
    const meta: ArchivedListPayload['meta'] = {}
    for (const sessionId of getServerContext<SessionHost>(server).workspaceRegistry.archivedSessionIds ?? []) {
      const entry = session.get(sessionId)
      if (entry === null)
        continue
      archivedSessionIds.push(sessionId)
      const title = entry.displayTitle ?? entry.title
      meta[sessionId] = {
        createdAt: entry.header?.createdAt,
        cwd: cwdOf(entry),
        ...(title === undefined ? {} : { title }),
      }
    }
    return { archivedSessionIds, meta }
  },

  async save(sessionId: string): Promise<void> {
    const registry = getServerContext<SessionHost>(server).workspaceRegistry
    const archiveSession = registry.archiveSession
    if (typeof archiveSession !== 'function')
      throw new Error('宿主 workspaceRegistry 未提供 archiveSession（宿主版本不兼容）')
    await archiveSession.call(registry, sessionId)
  },

  async remove(sessionIds: readonly string[], accounting: ArchiveAccounting = 'detach'): Promise<void> {
    const registry = requireWritableRegistry(getServerContext<SessionHost>(server).workspaceRegistry)
    const ids = [...new Set(sessionIds)]
    await registry.enqueueOperation(async () => {
      if (accounting === 'attach')
        await restoreWorkspaceAccounting(registry, ids)
      else
        await detachWorkspaceAccounting(registry, ids)
      const state = registry.requireState()
      const archived = state.archivedSessionIds ?? []
      const next = archived.filter(id => !ids.includes(id))
      if (next.length !== archived.length)
        await registry.setState({ ...state, archivedSessionIds: next })
    })
  },
})

function cwdOf(session: SessionLike | null): string | undefined {
  const cwd = session?.header?.cwd
  return typeof cwd === 'string' && cwd ? cwd : undefined
}

function requireWritableRegistry(registry: ArchiveRegistrySurface): Required<Pick<ArchiveRegistrySurface, 'enqueueOperation' | 'requireState' | 'setState'>> & ArchiveRegistrySurface {
  if (typeof registry.enqueueOperation !== 'function' || typeof registry.requireState !== 'function' || typeof registry.setState !== 'function')
    throw new Error('宿主 workspaceRegistry 未暴露归档集合的变更接口（宿主版本不兼容）')
  return registry as Required<Pick<ArchiveRegistrySurface, 'enqueueOperation' | 'requireState' | 'setState'>> & ArchiveRegistrySurface
}

function requireTable(registry: ArchiveRegistrySurface): ArchiveTableSurface {
  const table = registry.requireTable?.()
  if (!table)
    throw new Error('宿主 workspaceRegistry 未暴露工作区会话记账接口（宿主版本不兼容）')
  return table
}

async function detachWorkspaceAccounting(registry: ArchiveRegistrySurface, sessionIds: readonly string[]): Promise<void> {
  const table = requireTable(registry)
  for (const [workspaceId, record] of table.entries()) {
    const current = record.sessionIds ?? []
    const next = current.filter(id => !sessionIds.includes(id))
    if (next.length !== current.length)
      await table.update(workspaceId, value => ({ ...value, sessionIds: next }))
  }
}

async function restoreWorkspaceAccounting(registry: ArchiveRegistrySurface, sessionIds: readonly string[]): Promise<void> {
  const table = registry.requireTable?.()
  const workspaces = registry.list?.()
  if (!table || !workspaces)
    return
  const byPath = Object.fromEntries(workspaces.map(workspace => [workspace.path, workspace]))
  for (const sessionId of sessionIds) {
    const cwd = cwdOf(session.get(sessionId))
    const workspace = cwd ? byPath[cwd] : undefined
    if (!workspace || workspace.sessionIds?.includes(sessionId))
      continue
    await table.update(workspace.id, current => ({ ...current, sessionIds: [...(current.sessionIds ?? []), sessionId] }))
  }
}
