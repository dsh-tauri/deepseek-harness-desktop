import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { CheckoutInfo, HostContext, OperationResult } from '../types'
import { randomUUID } from 'node:crypto'
import { getServerContext } from 'dsh-h3/utils'
import { defineService } from 'dsh-tauri'
import { get } from 'lodash-es'
import { pendingWorktreeTitles } from '../config/runtime'
import { server } from '../server'
import { checkoutContext } from './checkout-context'
import { sessionContext } from './session-context'
import { worktree } from './worktree'

export const handoff = defineService({
  async inherit(
    sourceSessionId: string,
    targetSessionId: string,
    cwd: string,
  ): Promise<OperationResult<{ targetSessionId: string, seedLength: number }>> {
    const inherited = await createInherited(sourceSessionId, { cwd, parentSession: sourceSessionId, targetSessionId })
    if (!inherited.ok)
      getServerContext<HostContext>(server).logger?.warn?.(`dsh-tauri-worktree: session inheritance failed for ${targetSessionId}: ${inherited.error}`)
    return inherited
  },

  async handback(
    sessionId: string,
    projectPath: string,
    info: CheckoutInfo = {},
  ): Promise<OperationResult<{ targetSessionId: string }>> {
    const targetSessionId = `session-${randomUUID()}`
    const created = await createInherited(sessionId, {
      cwd: projectPath,
      parentSession: sessionId,
      targetSessionId,
      attach: true,
    })
    if (!created.ok)
      return created
    await checkoutContext.save(targetSessionId, {
      projectPath,
      branch: info.branch,
      worktreePath: info.worktreePath,
      checkedOutAt: new Date().toISOString(),
    })
    return { ok: true, targetSessionId }
  },

  async checkout(
    sessionId: string,
    worktreeKey: string,
    branchName: string,
    carryStaged = false,
  ): Promise<OperationResult<{ branch: string, projectPath: string, targetSessionId?: string }>> {
    let targetSessionId: string | undefined
    const checkout = await worktree.checkout(
      { sessionId, worktree_hash_dirname: worktreeKey, branch_name: branchName },
      {
        carryStaged,
        beforeRemove: async (prepared) => {
          const handback = await handoff.handback(sessionId, prepared.projectPath, {
            branch: prepared.branch,
            worktreePath: prepared.worktreePath,
          })
          if (handback.ok)
            targetSessionId = handback.targetSessionId
          return handback
        },
      },
    )
    if (!checkout.ok)
      return checkout
    return { ok: true, branch: checkout.branch, projectPath: checkout.projectPath, targetSessionId }
  },
})

function hasInheritedConversation(seed: readonly unknown[]): boolean {
  return seed.some((value) => {
    const event = value as { type?: unknown, data?: { source?: { kind?: unknown }, content?: unknown } }
    if (event?.type !== 'user/message' || event.data?.source?.kind !== 'user')
      return false
    return Array.isArray(event.data.content)
      && event.data.content.some((block) => {
        const part = block as { type?: unknown, text?: unknown }
        return part?.type === 'text' && String(part.text ?? '').trim() !== ''
      })
  })
}

async function createInherited(
  sourceSessionId: string,
  options: {
    cwd: string
    parentSession?: string
    attach?: boolean
    targetSessionId?: string
  },
): Promise<OperationResult<{ targetSessionId: string, seedLength: number }>> {
  const ctx = getServerContext<HostContext>(server)
  const agent = ctx.agents?.get?.(sourceSessionId)
  const sourceSession = agent?.session ?? sessionContext.peek(sourceSessionId)
  if (!sourceSession)
    return { ok: false, error: `未找到源会话：${sourceSessionId}` }
  const { cwd, attach = false } = options
  const targetSessionId = options.targetSessionId ?? `session-${randomUUID()}`
  try {
    const inherited = await createAgent(sourceSession, agent, targetSessionId, cwd, { parentSession: options.parentSession, requireEvents: true })
    if (!hasInheritedConversation(inherited.seed))
      pendingWorktreeTitles.add(targetSessionId)
    if (attach) {
      const workspace = await ctx.workspaceRegistry.resolveByPath(cwd)
      if (workspace)
        await workspace.attachSession(targetSessionId)
    }
    return { ok: true, targetSessionId, seedLength: inherited.seed.length }
  }
  catch (error) {
    return { ok: false, error: get(error, 'message', String(error)) }
  }
}

async function createAgent(
  sourceSession: any,
  sourceAgent: any,
  targetSessionId: string,
  cwd: string,
  options: { parentSession?: string, requireEvents?: boolean } = {},
): Promise<{ handle: AgentHandle, seed: readonly unknown[] }> {
  const ctx = getServerContext<HostContext>(server)
  const inheritedSeed = sessionEvents(sourceSession)
  if (options.requireEvents && inheritedSeed.length === 0)
    throw new Error(`源会话没有可继承的事件：${sourceSession.id}`)
  const presets = ctx.get?.('agentPresets')
  const parentPreset = sourceAgent
    ? (presets?.composedPreset(sourceAgent.ctx) ?? sourceSession.header?.agentPreset)
    : sourceSession.header?.agentPreset
  const handle = await ctx.agents.create({
    sessionId: targetSessionId,
    seed: inheritedSeed,
    meta: {
      cwd,
      parentSession: options.parentSession ?? sourceSession.id,
      isSeeded: true,
      ...(parentPreset ? { agentPreset: parentPreset } : {}),
    },
    inheritedEventCount: inheritedSeed.length,
    agentOptions: sourceAgent?.options ?? {},
    ...(sourceAgent && presets && parentPreset
      ? {
          setup: async (agentCtx: Context): Promise<void> => {
            presets.composeFrom(agentCtx, sourceAgent.ctx)
          },
        }
      : {}),
  })
  return { handle, seed: inheritedSeed }
}

function sessionEvents(value: unknown): readonly unknown[] {
  if (typeof value !== 'object' || value === null)
    return []
  const session = value as Record<string, unknown>
  const snapshotEvents = session.snapshotEvents
  if (typeof snapshotEvents === 'function') {
    const snapshot: unknown = Reflect.apply(snapshotEvents, value, [])
    if (Array.isArray(snapshot))
      return snapshot
  }
  return []
}
