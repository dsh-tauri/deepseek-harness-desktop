import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { PlatformModuleLoader, SchedulerRuntimeModules } from './agent-runtime.types'
import { isFunction } from 'lodash-es'
import { withSessionDeadline } from './session-deadline'

type RuntimeModuleExports = Partial<SchedulerRuntimeModules>

/** 会话查询服务的最小面（0.2.2-rc.1 起 `SessionController.inspect` 被移除，统一走它）。 */
export interface SessionQueryLike {
  observeSession: (
    sessionId: SessionId,
    options?: { readonly signal?: AbortSignal, readonly projectionMode?: 'all' | 'none' },
  ) => Promise<SessionObservationLike>
}

interface SessionObservationLike {
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
}

/** 一次会话读取，用完调用 `release` 归还租约。 */
export interface ObservedSession {
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
  readonly release: () => void
}

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

/**
 * 读取会话头部与完整事件前缀，不激活它的 Agent（等价于已移除的 `SessionController.inspect`）。
 * @param query - 宿主 `sessionQuery` 服务。
 * @param sessionId - 目标会话。
 * @returns 观察结果与归还租约的回调。
 */
export async function observeSession(query: SessionQueryLike, sessionId: string): Promise<ObservedSession> {
  const controller = new AbortController()
  const pending = query.observeSession(sessionId as SessionId, {
    projectionMode: 'none',
    signal: controller.signal,
  })
  let observed: SessionObservationLike
  try {
    observed = await withSessionDeadline(pending)
  }
  catch (error) {
    // 超时后观察仍可能兑现：注销它，避免租约把冷会话钉在缓存里。
    controller.abort()
    void pending.then(releaseObservation, () => {})
    throw error
  }
  return {
    header: observed.header,
    events: observed.events,
    release: () => releaseObservation(observed),
  }
}

/** 归还一次观察租约（幂等：`Symbol.dispose` 自身只生效一次）。 */
function releaseObservation(observation: SessionObservationLike): void {
  ;(observation as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.()
}

export async function isSchedulerSessionNotFound(loader: PlatformModuleLoader | undefined, error: unknown): Promise<boolean> {
  if (typeof error !== 'object' || error === null)
    return false
  const code = (error as { code?: unknown }).code
  if (code === 'session/not-found' || code === 'SESSION_QUERY_SESSION_NOT_FOUND')
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

function resolveRuntimeExport<T extends keyof SchedulerRuntimeModules>(
  loader: PlatformModuleLoader,
  moduleExports: unknown,
  name: T,
): SchedulerRuntimeModules[T] {
  const direct = (moduleExports as RuntimeModuleExports | null)?.[name]
  const unwrapped = loader.unwrapExports(moduleExports) as RuntimeModuleExports | null
  const resolved = isFunction(direct) ? direct : unwrapped?.[name]
  if (!isFunction(resolved))
    throw new TypeError(`SCHEDULER_RUNTIME_EXPORT_MISSING: ${String(name)}`)
  return resolved as SchedulerRuntimeModules[T]
}
