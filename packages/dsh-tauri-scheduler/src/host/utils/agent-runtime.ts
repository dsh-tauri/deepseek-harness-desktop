import type { PlatformModuleLoader, SchedulerRuntimeModules, SetupAgentLike } from './agent-runtime.types'
import { isFunction } from 'lodash-es'
import { withSessionDeadline } from './session-deadline'

type RuntimeModuleExports = Partial<SchedulerRuntimeModules>

export async function loadSchedulerRuntimeModules(loader: PlatformModuleLoader): Promise<SchedulerRuntimeModules> {
  const [agent, llm, approval] = await Promise.all([
    loader.import('@deepseek-ai/dsh-agent'),
    loader.import('@deepseek-ai/dsh-llm'),
    loader.import('@deepseek-ai/dsh-user-approval'),
  ])
  return {
    installModelSelection: resolveRuntimeExport(loader, agent, 'installModelSelection'),
    createUserMessage: resolveRuntimeExport(loader, llm, 'createUserMessage'),
    setApprovalPolicy: resolveRuntimeExport(loader, approval, 'setApprovalPolicy'),
  }
}

export async function loadSchedulerMessageFactory(loader: PlatformModuleLoader): Promise<SchedulerRuntimeModules['createUserMessage']> {
  const llm = await loader.import('@deepseek-ai/dsh-llm')
  return resolveRuntimeExport(loader, llm, 'createUserMessage')
}

export async function isSchedulerSessionNotFound(loader: PlatformModuleLoader | undefined, error: unknown): Promise<boolean> {
  if (typeof error !== 'object' || error === null)
    return false
  if ((error as { code?: unknown }).code === 'session/not-found')
    return true
  if (typeof loader?.import !== 'function')
    return false
  try {
    const exports = await withSessionDeadline(loader.import('@deepseek-ai/dsh-api-session-controller'))
    const direct = (exports as { ApiSessionNotFound?: unknown } | null)?.ApiSessionNotFound
    const constructor = typeof direct === 'function' ? direct : (loader.unwrapExports(exports) as { ApiSessionNotFound?: unknown } | null)?.ApiSessionNotFound
    return typeof constructor === 'function' && error instanceof constructor
  }
  catch {
    return false
  }
}

export function resolveSetupAgent(
  agentCtx: unknown,
  createdAgent?: SetupAgentLike,
): SetupAgentLike | undefined {
  return createdAgent ?? (agentCtx as { agent?: SetupAgentLike } | undefined)?.agent
}

// --- internal ---

function resolveRuntimeExport<T extends keyof SchedulerRuntimeModules>(
  loader: PlatformModuleLoader,
  moduleExports: unknown,
  name: T,
): SchedulerRuntimeModules[T] {
  const direct = (moduleExports as RuntimeModuleExports | null)?.[name]
  if (isFunction(direct))
    return direct as SchedulerRuntimeModules[T]

  const unwrapped = loader.unwrapExports(moduleExports) as RuntimeModuleExports | null
  const fallback = unwrapped?.[name]
  if (!isFunction(fallback))
    throw new TypeError(`SCHEDULER_RUNTIME_EXPORT_MISSING: ${String(name)}`)
  return fallback as SchedulerRuntimeModules[T]
}
