import type { HostContext, OperationResult } from '../types'
import { getServerContext } from 'dsh-h3/utils'
import { defineService } from 'dsh-tauri'
import { server } from '../server'
import { ledger } from './ledger'

export const workspace = defineService({
  async attach(sessionId: string): Promise<OperationResult<{ workspaceId: string }>> {
    const binding = ledger.load(sessionId)
    if (!binding)
      return { ok: false, error: '未找到绑定的工作树' }
    const project = await workspaceOf(binding.projectPath)
    if (!project)
      return { ok: false, error: `未找到源工作区：${binding.projectPath}` }
    await project.attachSession(sessionId)
    return { ok: true, workspaceId: project.id }
  },

  async unregister(path: string): Promise<void> {
    const registry = registryOf()
    if (!registry)
      return
    const project = await registry.resolveByPath(path).catch(() => null)
    if (project?.id)
      await registry.delete(project.id).catch(() => {})
  },

  async unregisterLegacy(): Promise<void> {
    await Promise.all(ledger.list().map(binding => workspace.unregister(binding.worktreePath)))
  },
})

// --- internal ---

interface WorkspaceRegistry {
  resolveByPath: (path: string) => Promise<{ id?: string } | null | undefined>
  delete: (workspaceId: string) => Promise<unknown>
}

function registryOf(): WorkspaceRegistry | undefined {
  try {
    return getServerContext<HostContext>(server).workspaceRegistry as WorkspaceRegistry
  }
  catch {
    return undefined
  }
}

async function workspaceOf(path: string): Promise<any> {
  try {
    return await getServerContext<HostContext>(server).workspaceRegistry.resolveByPath(path)
  }
  catch {
    return null
  }
}
