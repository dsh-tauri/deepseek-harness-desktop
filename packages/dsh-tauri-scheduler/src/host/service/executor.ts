import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { HostContext, RunStatus, RunTrigger, SchedulerTask } from '../types'
import type { PlatformModuleLoader, SetupAgentLike } from '../utils/agent-runtime.types'
import type { PermissionPresetService } from '../utils/permission.types'
import type { SessionEventWatch } from './executor.utils'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import process from 'node:process'
import { getServerContext } from 'dsh-h3/utils'
import { defineService } from 'dsh-tauri'
import { join } from 'pathe'
import { server } from '../server'
import { loadSchedulerRuntimeModules, resolveSetupAgent } from '../utils/agent-runtime'
import { applyUnattendedPermission } from '../utils/permission'
import { decideRunOutcome, isPluginUnloadError, summarizeCollectedRun, waitForTurnStart, watchSessionEvents } from './executor.utils'
import { runs } from './runs'

const SCHEDULER_RUN_TIMEOUT_MS = 30 * 60 * 1000

const SCHEDULER_CANCEL_TIMEOUT_MS = 10_000

const SCHEDULER_AGENT_PRESET = 'standard'

const SCHEDULER_UNGROUPED_DIRECTORY = 'automations'

interface ExecuteOutcome {
  ok: boolean
  sessionId?: string
  error?: string
  model?: string
}

export const executor = defineService({
  async run(task: SchedulerTask, trigger: RunTrigger): Promise<ExecuteOutcome> {
    const ctx = getServerContext<HostContext>(server)
    const runId = `run-${randomUUID()}`
    const scheduledFor = new Date().toISOString()
    const sessionId = `task-${randomUUID()}`

    await runs.save({
      id: runId,
      taskId: task.id,
      taskName: task.name,
      trigger,
      status: 'running',
      scheduledFor,
      startedAt: scheduledFor,
      sessionId,
    })

    let watched: SessionEventWatch | undefined
    try {
      const runtime = await loadSchedulerRuntimeModules(
        (ctx as HostContext & { loader: PlatformModuleLoader }).loader,
      )

      const resolved = await resolveWorkspace(ctx, task)
      if (!resolved.ok) {
        const outcome: ExecuteOutcome = { ok: false, sessionId, error: resolved.error }
        await settle(runId, 'failed', outcome)
        return outcome
      }

      const selection: ModelSelection | undefined = task.provider && task.model
        ? { provider: task.provider, model: task.model, ...(task.reasoningEffort ? { reasoningEffort: task.reasoningEffort as ReasoningEffortId } : {}) }
        : defaultSelection(ctx)

      const agentPreset = task.agentPreset?.trim() || SCHEDULER_AGENT_PRESET
      let timeout: ReturnType<typeof setTimeout> | undefined
      let result: { status: 'succeeded' | 'failed' | 'cancelled', error?: { code: string, message: string } }

      try {
        const handle = await createAgent(ctx, runtime, {
          sessionId,
          cwd: resolved.cwd,
          agentPreset,
          selection,
          permission: task.permission,
        })

        await handle.agent.whenIdle()
        if (resolved.workspace)
          await resolved.workspace.attachSession?.(sessionId)

        await pinTitle(ctx, handle.agent.session, task.name)

        const firstSeq = handle.agent.session.seq
        watched = watchSessionEvents(ctx, handle.agent.session, firstSeq)
        handle.agent.followup(runtime.createUserMessage({
          content: [{ type: 'text', text: task.prompt }],
          source: { kind: 'scheduler', taskId: task.id, runId, scheduledFor },
        }))

        const started = await waitForTurnStart(handle.agent.session, firstSeq)

        let timedOut = false
        const idle = handle.agent.whenIdle()
        const deadline = new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            timedOut = true
            handle.agent.cancel({ kind: 'hook', reason: 'scheduler run timeout' })
            resolve()
          }, SCHEDULER_RUN_TIMEOUT_MS)
        })

        await Promise.race([idle, deadline])

        if (timedOut && !await settlesWithin(idle, SCHEDULER_CANCEL_TIMEOUT_MS)) {
          result = { status: 'failed', error: { code: 'cancel_convergence_timeout', message: '定时任务取消后未能在安全时限内停止。' } }
        }
        else {
          await (ctx.sessions as { flush: (session: unknown) => Promise<unknown> }).flush(handle.agent.session)
          const outcome = summarizeCollectedRun(watched?.events ?? [], handle.agent.session, firstSeq)

          const decision = decideRunOutcome({ started, timedOut, reason: outcome.reason })
          result = decision.error ? { status: 'failed', error: decision.error } : { status: 'succeeded' }
        }
      }
      finally {
        if (timeout !== undefined)
          clearTimeout(timeout)
      }

      const outcome: ExecuteOutcome = {
        ok: result.status === 'succeeded',
        sessionId,
        model: selection?.model,
        ...(result.error ? { error: result.error.message } : {}),
      }

      await settle(runId, result.status, outcome)
      return outcome
    }
    catch (error) {
      const unloaded = isPluginUnloadError(error)
      const outcome: ExecuteOutcome = {
        ok: false,
        sessionId,
        error: unloaded ? '定时任务因插件卸载被取消。' : error instanceof Error ? error.message : String(error),
      }
      await settle(runId, unloaded ? 'cancelled' : 'failed', outcome)
      return outcome
    }
    finally {
      watched?.stop()
    }
  },
})

// --- internal ---

interface ResolvedWorkspace {
  ok: true
  cwd: string
  workspace?: { attachSession?: (id: unknown) => Promise<unknown> }
}

type WorkspaceResolution = ResolvedWorkspace | { ok: false, error: string }

interface AgentHandleLike {
  agent: {
    session: any
    whenIdle: () => Promise<void>
    followup: (message: unknown) => void
    cancel: (reason: { kind: string, reason: string }) => void
  }
}

async function resolveWorkspace(ctx: HostContext, task: SchedulerTask): Promise<WorkspaceResolution> {
  if (task.workspaceId) {
    const record = ctx.workspaceRegistry?.get?.(task.workspaceId) as
      | { path?: string, status?: () => Promise<string>, attachSession?: (id: unknown) => Promise<unknown> }
      | undefined
    if (!record || typeof record.path !== 'string')
      return { ok: false, error: '目标工作区已不存在。' }
    if (await record.status?.() !== 'ok')
      return { ok: false, error: '目标工作区目录不可用或已变更。' }
    return { ok: true, cwd: record.path, workspace: record }
  }

  const env = process.env.DSH_HOME
  const home = env?.trim() ? env.trim() : join(homedir(), '.dsh')
  const cwd = join(home, SCHEDULER_UNGROUPED_DIRECTORY)
  await mkdir(cwd, { recursive: true }).catch(() => {})
  return { ok: true, cwd }
}

function defaultSelection(ctx: HostContext): ModelSelection | undefined {
  try {
    return (ctx.get?.('agentDefaultModel') as { currentSelection?: () => ModelSelection })?.currentSelection?.()
  }
  catch {
    return undefined
  }
}

async function createAgent(
  ctx: HostContext,
  runtime: Awaited<ReturnType<typeof loadSchedulerRuntimeModules>>,
  input: {
    sessionId: string
    cwd: string
    agentPreset: string
    selection: ModelSelection | undefined
    permission: string | undefined
  },
): Promise<AgentHandleLike> {
  const create = () => ctx.agents.create({
    sessionId: input.sessionId,
    meta: { cwd: input.cwd, agentPreset: input.agentPreset },
    agentOptions: input.selection ? { provider: input.selection.provider, model: input.selection.model } : {},
    setup: async (agentCtx: any, createdAgent?: SetupAgentLike) => {
      await (ctx.agentPresets as { mount?: (agentCtx: unknown, presetId: string) => Promise<unknown> } | undefined)?.mount?.(agentCtx, input.agentPreset)
      runtime.installModelSelection(agentCtx, { current: input.selection, assembled: undefined })
      const agent = resolveSetupAgent(agentCtx, createdAgent)
      if (!agent)
        throw new Error('scheduler setup has no scoped Agent')
      applyUnattendedPermission(
        ctx.permissionPresets as PermissionPresetService,
        agent.session,
        input.permission,
        runtime.setApprovalPolicy,
      )
    },
  })

  return ctx.agents.withoutInitiator != null ? await ctx.agents.withoutInitiator(create) : await create()
}

async function pinTitle(ctx: HostContext, session: unknown, taskName: string): Promise<void> {
  try {
    const title = ctx.get?.('sessionTitle') as { rename?: (target: unknown, value: string) => unknown } | undefined
    title?.rename?.(session, taskName)
  }
  catch (error) {
    ctx.logger?.warn?.(`dsh-tauri-scheduler: failed to pin session title: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function settle(id: string, status: RunStatus, outcome: ExecuteOutcome): Promise<void> {
  const current = await runs.load(id)
  if (current === null)
    return
  await runs.save({
    ...current,
    status,
    finishedAt: new Date().toISOString(),
    error: outcome.error,
    sessionId: outcome.sessionId ?? current.sessionId,
  })
}

function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return Promise.race([
      promise.then(() => true, () => false),
      new Promise<false>((resolve) => { timer = setTimeout(resolve, timeoutMs, false) }),
    ])
  }
  finally {
    if (timer !== undefined)
      clearTimeout(timer)
  }
}
