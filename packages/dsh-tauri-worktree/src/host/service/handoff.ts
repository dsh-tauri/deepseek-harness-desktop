import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentSetupCommit } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { NativeSessionBridge } from 'dsh-tauri'
import type { CheckoutInfo, HostContext, OperationResult, PendingHandoff } from '../types'
import { randomUUID } from 'node:crypto'
import { getServerContext } from 'dsh-h3/utils'
import { defineService } from 'dsh-tauri'
import { get } from 'lodash-es'
import { pendingWorktreeTitles } from '../config/runtime'
import { server } from '../server'
import { worktreeHandoffText } from '../utils/worktree-facts'
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

  async complete(pending: PendingHandoff): Promise<void> {
    const ctx = getServerContext<HostContext>(server)
    const { sourceAgent, targetSessionId, binding } = pending
    const sourceSession = sourceAgent.session
    try {
      const inherited = await createAgent(sourceSession, sourceAgent, targetSessionId, binding.worktreePath)
      const { handle, seed } = inherited
      const workspace = await ctx.workspaceRegistry.resolveByPath(binding.projectPath)
      if (workspace)
        await workspace.attachSession(targetSessionId)
      if (!hasInheritedConversation(seed))
        pendingWorktreeTitles.add(targetSessionId)
      handle.agent.followup({
        id: `message-${randomUUID()}` as MessageId,
        role: 'user',
        content: [{
          type: 'text',
          text: worktreeHandoffText(binding),
        }],
        source: { kind: 'user' },
      })
    }
    catch (error) {
      if (!ctx.agents.get(targetSessionId))
        await worktree.remove(targetSessionId)
      const message = get(error, 'message', String(error))
      ctx.logger?.error?.(`create_worktree handoff failed for ${targetSessionId}: ${message}`)
    }
  },
})

// --- internal ---

/** 内核不给 fork 子会话生成标题，无人类对话的继承前缀需显式登记。 */
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
  const bridge: NativeSessionBridge | undefined = ctx.get?.('nativeSessionBridge')
  if (bridge && (typeof bridge.create !== 'function' || typeof bridge.prepare !== 'function'))
    throw new Error('BRIDGE_CORE_UNAVAILABLE: The native session fork capability is unavailable')
  let inheritedSeed: readonly unknown[] = []
  const create = (signal?: AbortSignal): Promise<AgentHandle> => {
    signal?.throwIfAborted()
    inheritedSeed = sessionEvents(sourceSession)
    if (options.requireEvents && inheritedSeed.length === 0)
      throw new Error(`源会话没有可继承的事件：${sourceSession.id}`)
    if (!bridge) {
      const projected = ctx.get?.('sessionProjections')?.stateOf?.(sourceSession, 'bridgeKernel')
      const hasNativeRecord = inheritedSeed.some((value) => {
        const event = value as { type?: unknown, ignorable?: unknown }
        return event?.type === 'plugin:dsh-tauri-bridge/kernel' && event.ignorable === true
      })
      if (hasNativeRecord || projected?.binding || projected?.inheritedBinding || projected?.nativeSessionId || sourceSession.requestHeader?.()?.config?.provider === 'dsh-tauri-bridge' || sourceAgent?.options?.provider === 'dsh-tauri-bridge')
        throw new Error('BRIDGE_CORE_UNAVAILABLE: Native session inheritance requires the native session fork capability')
    }
    const presets = ctx.get?.('agentPresets')
    const parentPreset = sourceAgent
      ? (presets?.composedPreset(sourceAgent.ctx) ?? sourceSession.header?.agentPreset)
      : sourceSession.header?.agentPreset
    return ctx.agents.create({
      sessionId: targetSessionId,
      seed: inheritedSeed,
      ...(signal ? { signal } : {}),
      meta: {
        cwd,
        parentSession: options.parentSession ?? sourceSession.id,
        isSeeded: true,
        ...(parentPreset ? { agentPreset: parentPreset } : {}),
      },
      inheritedEventCount: inheritedSeed.length,
      agentOptions: sourceAgent?.options ?? {},
      ...(bridge || (sourceAgent && presets && parentPreset)
        ? {
            setup: async (agentCtx: Context, agent: Agent): Promise<AgentSetupCommit | void> => {
              if (sourceAgent && presets && parentPreset)
                presets.composeFrom(agentCtx, sourceAgent.ctx)
              if (!bridge)
                return
              const controller = new AbortController()
              agentCtx.effect(() => () => controller.abort(new Error('BRIDGE_DISPOSED: The inherited agent setup was disposed')))
              const scoped = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
              scoped.throwIfAborted()
              const commit = await bridge.prepare(sourceSession as Session, agent, scoped)
              scoped.throwIfAborted()
              return commit
            },
          }
        : {}),
    })
  }
  const handle = bridge ? await bridge.create(sourceSession as Session, create) : await create()
  return { handle, seed: inheritedSeed }
}

/** 内核 0.1.2-rc.1 移除 events，旧版本以 log/events 兼容。 */
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
  if (Array.isArray(session.log))
    return session.log
  return Array.isArray(session.events) ? session.events : []
}
