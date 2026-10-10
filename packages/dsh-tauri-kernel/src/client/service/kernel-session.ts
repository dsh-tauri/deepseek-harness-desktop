import type { AdapterSessionCreateOptions, ClientAdapter, ISessions, SessionId } from 'dsh-tauri/client'
import type { BackendId } from '../../shared/types'
import { postSessions } from '../apis'
import { kernelStore } from '../store/modules/kernel-store'
import { backendFromIdentity, isBackendAvailable, kernelFromList } from './kernel-identity'

export async function createKernelSession(
  adapter: ClientAdapter,
  backend: BackendId,
  options: AdapterSessionCreateOptions,
  active: () => boolean,
  agentPreset?: string,
): Promise<string> {
  if (!active())
    throw new Error('Kernel session creation was cancelled')
  if (options.sessionId !== undefined)
    throw new Error('Existing sessions cannot change kernels')
  if (options.workspaceId !== undefined && options.cwd !== undefined)
    throw new Error('Session creation requires either workspaceId or cwd')
  if (backend === 'dsh') {
    const create = adapter.sessions.create
    if (!adapter.has('sessions.create') || create === undefined)
      throw new Error('Official session creation is unavailable')
    return create(options)
  }
  const detection = kernelStore.$state.backends.find(item => item.id === backend)
  if (kernelStore.$state.phase !== 'ready' || !isBackendAvailable(detection))
    throw new Error('The selected native kernel is unavailable')
  const refreshCatalog = adapter.sessions.refresh
  if (!adapter.has('sessions.refreshProjections') || !adapter.has('sessions.refresh') || refreshCatalog === undefined)
    throw new Error('Official session projection refresh is unavailable')
  const response = await postSessions({
    backend,
    ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(agentPreset === undefined ? {} : { agentPreset }),
  })
  if (typeof response.sessionId !== 'string' || response.sessionId.trim() === '')
    throw new Error('Native kernel creation returned no session identity')
  if (!active())
    throw new Error('Kernel session creation was cancelled')
  await refreshCatalog()
  if (!active())
    throw new Error('Kernel session creation was cancelled')
  const refresh = adapter.sessions.refreshProjections
  if (refresh === undefined)
    throw new Error('Official session projection refresh is unavailable')
  await refresh(response.sessionId)
  if (!active())
    throw new Error('Kernel session creation was cancelled')
  const sessions = adapter.service<ISessions>('sessions')
  const identity = sessions === undefined ? undefined : kernelFromList(sessions.list.getSnapshot(), response.sessionId as SessionId)
  if (backendFromIdentity(identity) !== backend || identity?.sessionId !== response.sessionId)
    throw new Error('The new session has no verified native kernel binding')
  return response.sessionId
}
