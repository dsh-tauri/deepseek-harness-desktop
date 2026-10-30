import type {
  AdapterAddWorkspaceOptions,
  AdapterAddWorkspaceOutcome,
  AdapterAddWorkspaceRuntime,
  AdapterCapability,
  AdapterContext,
  AdapterGeneration,
  AdapterListProjection,
  AdapterMigrationFailure,
  AdapterOpenSession,
  AdapterOpenSessionOutcome,
  AdapterProbe,
  AdapterRuntimeObject,
  AdapterSessionId,
  AdapterSessionList,
  AdapterSessions,
  AdapterStartSession,
  AdapterStartSessionOutcome,
  AdapterSurface,
  AdapterWorkspaceId,
  AdapterWorkspaces,
  ClientAdapter,
  DefineAdapterOptions,
  DshMigration,
} from '../types/adapter'
import { NEW_SESSION_SELECTOR } from '../constants'
import { clickIfPresent } from '../utils/browser'

export type * from '../types/adapter'

const ADD_WORKSPACE_SELECTOR = 'button[aria-label="添加工作区"],button[aria-label="Add workspace"]'
const COMPOSER_CWD_ATTRIBUTE = 'data-dsh-composer-cwd'
type AdapterWarn = (message: string, error?: unknown) => void

const defaultWarn: AdapterWarn = (message, error) => {
  if (error === undefined)
    console.warn(message)
  else
    console.warn(message, error)
}

function readService(ctx: unknown, name: string): unknown {
  if (ctx === null || ctx === undefined)
    return undefined
  const kind = typeof ctx
  if (kind !== 'object' && kind !== 'function')
    return undefined
  const runtime = ctx as { get?: (name: string) => unknown } & AdapterRuntimeObject
  try {
    return typeof runtime.get === 'function' ? runtime.get(name) : runtime[name]
  }
  catch {
    return undefined
  }
}

function bindMembers<T extends object>(target: T): T {
  return new Proxy(target, {
    get(t, prop) {
      const member = Reflect.get(t, prop)
      return typeof member === 'function' ? member.bind(t) : member
    },
  })
}

function adaptService<T extends object>(service: T): T {
  const boundLists = new WeakMap<object, object>()
  return new Proxy(service, {
    get(t, prop) {
      const member = Reflect.get(t, prop)
      if (prop === 'list' && member !== null && typeof member === 'object') {
        const cached = boundLists.get(member)
        if (cached !== undefined)
          return cached
        const bound = bindMembers(member as object)
        boundLists.set(member, bound)
        return bound
      }
      return typeof member === 'function' ? member.bind(t) : member
    },
  })
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function'))
    return false
  return typeof (value as PromiseLike<unknown>).then === 'function'
}

function readInputActions(projected: unknown): unknown {
  if (projected === null || typeof projected !== 'object')
    return undefined
  const props = (projected as { props?: unknown }).props
  if (props === null || typeof props !== 'object')
    return undefined
  const inputActions = (props as { inputActions?: unknown }).inputActions
  return inputActions === undefined ? undefined : { props: { inputActions } }
}

function uiSessionAdapter(probe: AdapterProbe): AdapterRuntimeObject | undefined {
  return probe.service<AdapterRuntimeObject>('uiSession')?.adapter as AdapterRuntimeObject | undefined
}

function resolveProvideInfo(
  sessions: AdapterRuntimeObject,
  sessionId: string,
  probe: AdapterProbe,
): unknown {
  const native = sessions.provideInfo
  if (typeof native === 'function') {
    let value: unknown
    try {
      value = native.call(sessions, sessionId)
    }
    catch {
      value = undefined
    }
    if (value !== undefined)
      return value
  }
  try {
    const bindingFn = sessions.binding
    const binding = typeof bindingFn === 'function' ? bindingFn.call(sessions, sessionId) : undefined
    if (binding === undefined)
      return undefined
    const adapter = uiSessionAdapter(probe)
    const bindingSource = adapter?.bindingSource
    if (typeof bindingSource !== 'function')
      return undefined
    const source = bindingSource.call(adapter, { sessionId, binding }) as AdapterListProjection | undefined
    return readInputActions(typeof source?.getSnapshot === 'function' ? source.getSnapshot() : undefined)
  }
  catch {
    return undefined
  }
}

function detectGeneration(service: AdapterProbe['service']): AdapterGeneration {
  return ['sessions', 'workspaces', 'uiWorkspace'].some(name => service(name) !== undefined) ? 'modern' : 'unknown'
}

const SERVICES_AUTO_BIND_MIGRATION: DshMigration = {
  id: 'services:auto-bind',
  description: '官方 sessions / workspaces 服务方法自动绑定 this',
  detect: () => true,
  apply(surface) {
    if (surface.sessions !== undefined)
      surface.sessions = adaptService(surface.sessions)
    if (surface.workspaces !== undefined)
      surface.workspaces = adaptService(surface.workspaces)
  },
}

const SESSIONS_LIST_PROJECTION_MIGRATION: DshMigration = {
  id: 'sessions:list-projection',
  description: 'sessions.list 投影 → sessions.getSnapshot / subscribe 顶层别名',
  detect: (_probe, surface) =>
    surface.sessions?.list !== undefined && typeof surface.sessions.getSnapshot !== 'function',
  apply(surface) {
    const sessions = surface.sessions
    const list = sessions?.list as AdapterListProjection | undefined
    if (sessions === undefined || list === undefined)
      return
    surface.sessions = new Proxy(sessions as object, {
      get(target, prop) {
        if (prop === 'list')
          return list
        if (prop === 'getSnapshot')
          return () => list.getSnapshot()
        if (prop === 'subscribe')
          return (listener: () => void) => list.subscribe(listener)
        const member = Reflect.get(target, prop)
        return typeof member === 'function' ? member.bind(target) : member
      },
    }) as AdapterSessions
  },
}

function projectListCurrent(
  list: AdapterListProjection,
  resolveCurrent: () => AdapterListProjection | undefined,
): AdapterListProjection {
  let lastSnapshot: unknown
  let lastCurrent: unknown
  let lastProjected: unknown
  const currentId = (): unknown => {
    const source = resolveCurrent()
    if (source === undefined)
      return undefined
    const value = source.getSnapshot()
    return value !== null && typeof value === 'object' ? (value as { key?: unknown }).key : undefined
  }
  return {
    getSnapshot: () => {
      const snapshot = list.getSnapshot()
      const selected = currentId()
      if (snapshot === lastSnapshot && selected === lastCurrent)
        return lastProjected
      lastSnapshot = snapshot
      lastCurrent = selected
      lastProjected = snapshot !== null && typeof snapshot === 'object' ? { ...snapshot, current: selected } : snapshot
      return lastProjected
    },
    subscribe: (listener) => {
      let offCurrent: (() => void) | undefined
      let boundCurrent: AdapterListProjection | undefined
      const followCurrent = (): void => {
        const source = resolveCurrent()
        if (source === boundCurrent)
          return
        offCurrent?.()
        boundCurrent = source
        offCurrent = typeof source?.subscribe === 'function' ? source.subscribe(listener) : undefined
      }
      const offList = list.subscribe(() => {
        followCurrent()
        listener()
      })
      followCurrent()
      return () => {
        offList()
        offCurrent?.()
      }
    },
  }
}

const SESSIONS_CURRENT_PROJECTION_MIGRATION: DshMigration = {
  id: 'sessions:current-projection',
  description: 'uiSession.adapter.current → sessions.list 快照的 current 投影',
  detect: (_probe, surface) => surface.sessions?.list !== undefined,
  apply(surface, probe) {
    const sessions = surface.sessions
    const list = sessions?.list as AdapterListProjection | undefined
    if (sessions === undefined || list === undefined)
      return
    const projected = projectListCurrent(list, () => currentSourceOf(probe))
    surface.sessions = new Proxy(sessions as object, {
      get(target, prop) {
        if (prop === 'list')
          return projected
        if (prop === 'getSnapshot')
          return () => projected.getSnapshot()
        if (prop === 'subscribe')
          return (listener: () => void) => projected.subscribe(listener)
        const member = Reflect.get(target, prop)
        return typeof member === 'function' ? member.bind(target) : member
      },
    }) as AdapterSessions
  },
}

function currentSourceOf(probe: AdapterProbe): AdapterListProjection | undefined {
  const current = uiSessionAdapter(probe)?.current as AdapterListProjection | undefined
  return current !== undefined && typeof current.getSnapshot === 'function' ? current : undefined
}

const SESSIONS_PROVIDE_INFO_MIGRATION: DshMigration = {
  id: 'sessions:provide-info-bridge',
  description: 'sessions.binding + uiSession.adapter.bindingSource → sessions.provideInfo',
  detect: (_probe, surface) => typeof surface.sessions?.binding === 'function',
  apply(surface, probe) {
    const sessions = surface.sessions
    if (sessions === undefined)
      return
    surface.sessions = new Proxy(sessions as object, {
      get(target, prop) {
        if (prop === 'provideInfo')
          return (sessionId: string) => resolveProvideInfo(target as AdapterRuntimeObject, sessionId, probe)
        const member = Reflect.get(target, prop)
        return typeof member === 'function' ? member.bind(target) : member
      },
    }) as AdapterSessions
  },
}

function resolveStartSessionCapability(surface: AdapterSurface): AdapterStartSession | undefined {
  const owner = surface.uiWorkspace
  const fn = owner?.startSession
  return typeof fn === 'function' ? (workspaceId?: AdapterWorkspaceId) => fn.call(owner, workspaceId) : undefined
}

function surfaceStartSession(surface: AdapterSurface): AdapterStartSession | undefined {
  return surface.startSession ?? resolveStartSessionCapability(surface)
}

const WORKSPACES_NAVIGATION_MIGRATION: DshMigration = {
  id: 'workspaces:navigation',
  description: 'uiWorkspace.startSession / connectWorkspace → workspaces 导航投影',
  detect: () => true,
  apply(surface) {
    const workspaces = surface.workspaces
    if (workspaces === undefined)
      return
    surface.workspaces = new Proxy(workspaces as object, {
      get(target, prop) {
        if (prop === 'startSession' || prop === 'connectWorkspace') {
          if (typeof surface.uiWorkspace?.[prop] !== 'function')
            return undefined
          return (...args: unknown[]) => {
            const owner = surface.uiWorkspace
            const fn = owner?.[prop]
            if (typeof fn !== 'function')
              throw new Error(`uiWorkspace.${prop} is unavailable`)
            return fn.call(owner, ...args)
          }
        }
        const member = Reflect.get(target, prop)
        return typeof member === 'function' ? member.bind(target) : member
      },
    }) as AdapterWorkspaces
  },
}

const NAVIGATION_MIGRATION: DshMigration = {
  id: 'navigation:resolve-start-session',
  description: 'uiWorkspace.startSession → surface.startSession',
  detect: () => true,
  apply(surface) {
    if (resolveStartSessionCapability(surface) === undefined)
      return
    surface.startSession = (workspaceId?: AdapterWorkspaceId) => {
      const start = resolveStartSessionCapability(surface)
      if (start === undefined)
        throw new Error('startSession is unavailable: no uiWorkspace.startSession capability')
      return start(workspaceId)
    }
  },
}

function surfaceOpenSession(surface: AdapterSurface): AdapterOpenSession | undefined {
  const owner = surface.uiWorkspace
  const fn = owner?.openSession
  return typeof fn === 'function' ? sessionId => fn.call(owner, sessionId) : surface.openSession
}

const SESSIONS_OPEN_MIGRATION: DshMigration = {
  id: 'sessions:open-bridge',
  description: 'uiWorkspace.openSession → sessions.open',
  detect: () => true,
  apply(surface) {
    const sessions = surface.sessions
    if (sessions === undefined)
      return
    const bridge: AdapterOpenSession = (sessionId) => {
      const open = surfaceOpenSession(surface)
      if (open === undefined)
        throw new Error('sessions.open is unavailable: no uiWorkspace.openSession capability')
      return open(sessionId)
    }
    surface.sessions = new Proxy(sessions as object, {
      get(target, prop) {
        if (prop === 'open')
          return bridge
        const member = Reflect.get(target, prop)
        return typeof member === 'function' ? member.bind(target) : member
      },
    }) as AdapterSessions
  },
}

function addWorkspaceAt(surface: AdapterSurface): AdapterAddWorkspaceRuntime | undefined {
  const workspaces = surface.workspaces
  const create = workspaces?.create
  const pickOwner = surface.uiWorkspace
  const pickDirectory = pickOwner?.pickDirectory
  const startSession = surfaceStartSession(surface)
  if (typeof pickDirectory !== 'function' || typeof create !== 'function' || startSession === undefined)
    return undefined
  return {
    pickDirectory: () => pickDirectory.call(pickOwner) as Promise<string | null | undefined>,
    createWorkspace: input => create.call(workspaces, input),
    startSession: workspaceId => startSession(workspaceId),
  }
}

function surfaceAddWorkspace(surface: AdapterSurface): AdapterAddWorkspaceRuntime | undefined {
  return surface.addWorkspace ?? addWorkspaceAt(surface)
}

const WORKSPACE_ADD_MIGRATION: DshMigration = {
  id: 'workspace:resolve-add-workspace',
  description: 'uiWorkspace.pickDirectory + workspaces.create + startSession → surface.addWorkspace',
  detect: () => true,
  apply(surface) {
    const runtime = addWorkspaceAt(surface)
    if (runtime !== undefined)
      surface.addWorkspace = runtime
  },
}

export const DEFAULT_DSH_MIGRATIONS: readonly DshMigration[] = [
  SERVICES_AUTO_BIND_MIGRATION,
  SESSIONS_LIST_PROJECTION_MIGRATION,
  SESSIONS_CURRENT_PROJECTION_MIGRATION,
  SESSIONS_PROVIDE_INFO_MIGRATION,
  WORKSPACES_NAVIGATION_MIGRATION,
  NAVIGATION_MIGRATION,
  SESSIONS_OPEN_MIGRATION,
  WORKSPACE_ADD_MIGRATION,
]

function createAdapterContext(
  ctx: unknown,
  sessions: AdapterSessions,
  workspaces: AdapterWorkspaces,
): AdapterContext {
  const kind = typeof ctx
  const base = (ctx !== null && (kind === 'object' || kind === 'function') ? ctx : {}) as AdapterRuntimeObject
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'sessions')
        return sessions
      if (prop === 'workspaces')
        return workspaces
      try {
        return Reflect.get(target, prop, receiver)
      }
      catch {
        return undefined
      }
    },
  }) as AdapterContext
}

async function runStartSession(
  surface: AdapterSurface,
  workspaceId: AdapterWorkspaceId | undefined,
  warn: AdapterWarn,
): Promise<AdapterStartSessionOutcome> {
  const start = surfaceStartSession(surface)
  if (start !== undefined) {
    const value = start(workspaceId)
    return { status: 'started', value: isThenable(value) ? await value : value }
  }
  if (clickIfPresent(NEW_SESSION_SELECTOR))
    return { status: 'delegated' }
  const reason = 'no workspace navigation service and no official new-session button'
  warn(`[dsh-adapter] startSession unavailable: ${reason}`)
  return { status: 'unavailable', reason }
}

function readSessionList(surface: AdapterSurface): AdapterSessionList | undefined {
  const list = surface.sessions?.list
  if (list === undefined)
    return undefined
  const value = list.getSnapshot()
  if (value === null || typeof value !== 'object')
    return undefined
  const record = value as { ids?: unknown, current?: unknown }
  return {
    ids: Array.isArray(record.ids) ? record.ids.filter((id): id is string => typeof id === 'string') : [],
    ...(typeof record.current === 'string' ? { current: record.current } : {}),
    subscribe: listener => list.subscribe(listener),
  }
}

function runOpenSession(surface: AdapterSurface, sessionId: AdapterSessionId, warn: AdapterWarn): AdapterOpenSessionOutcome {
  const open = surfaceOpenSession(surface)
  if (open === undefined) {
    const reason = 'no uiWorkspace.openSession capability'
    warn(`[dsh-adapter] openSession unavailable: ${reason}`)
    return { status: 'unavailable', reason }
  }
  return { status: 'opened', value: open(sessionId) }
}

async function runAddWorkspace(
  surface: AdapterSurface,
  options: AdapterAddWorkspaceOptions | undefined,
  warn: AdapterWarn,
): Promise<AdapterAddWorkspaceOutcome> {
  const runtime = surfaceAddWorkspace(surface)
  if (runtime === undefined) {
    if (clickIfPresent(ADD_WORKSPACE_SELECTOR))
      return { status: 'delegated' }
    const reason = 'no pickDirectory/create/startSession capability and no official add-workspace button'
    warn(`[dsh-adapter] addWorkspace unavailable: ${reason}`)
    return { status: 'unavailable', reason }
  }
  const path = await runtime.pickDirectory()
  if (path === null || path === undefined)
    return { status: 'cancelled' }
  const workspace = await runtime.createWorkspace({ path })
  const openSession = options?.openSession ?? true
  if (openSession) {
    const value = runtime.startSession(workspace.workspaceId)
    if (isThenable(value))
      await value
  }
  return { status: 'created', workspaceId: workspace.workspaceId, path, sessionStarted: openSession }
}

export function defineAdapter(ctx: unknown, options: DefineAdapterOptions = {}): ClientAdapter {
  const warn = options.onWarn ?? defaultWarn
  const service = <T = AdapterRuntimeObject>(name: string): T | undefined =>
    readService(ctx, name) as T | undefined
  const probe: AdapterProbe = { generation: detectGeneration(service), service }
  const surface: AdapterSurface = {
    sessions: service<AdapterSessions>('sessions') ?? {},
    workspaces: service<AdapterWorkspaces>('workspaces') ?? {},
    get uiWorkspace() {
      return service<AdapterRuntimeObject>('uiWorkspace')
    },
    get uiSession() {
      return service<AdapterRuntimeObject>('uiSession')
    },
  }
  const migrations: string[] = []
  const failures: AdapterMigrationFailure[] = []
  for (const migration of [...DEFAULT_DSH_MIGRATIONS, ...(options.migrations ?? [])]) {
    try {
      if (!migration.detect(probe, surface))
        continue
      migration.apply(surface, probe)
      migrations.push(migration.id)
    }
    catch (error) {
      failures.push({ migration: migration.id, error })
      warn(`[dsh-adapter] migration "${migration.id}" failed; projection kept as-is`, error)
    }
  }
  const sessions = surface.sessions ?? {}
  const workspaces = surface.workspaces ?? {}
  const capabilityChecks: Record<AdapterCapability, () => boolean> = {
    'sessions.list': () => typeof sessions.list?.getSnapshot === 'function',
    'sessions.provideInfo': () => typeof sessions.provideInfo === 'function',
    'sessions.create': () => typeof sessions.create === 'function',
    'sessions.refresh': () => typeof sessions.refresh === 'function',
    'sessions.refreshProjections': () => typeof sessions.refreshProjections === 'function',
    'workspaces.list': () => typeof workspaces.list?.getSnapshot === 'function',
    'workspaces.create': () => typeof workspaces.create === 'function',
    'navigation.startSession': () => surfaceStartSession(surface) !== undefined,
    'navigation.openSession': () => surfaceOpenSession(surface) !== undefined,
    'navigation.addWorkspace': () => surfaceAddWorkspace(surface) !== undefined,
    'composer.workspace-less': () =>
      typeof document !== 'undefined'
      && document.documentElement.getAttribute(COMPOSER_CWD_ATTRIBUTE) === '1',
    'dom.newSession': () => typeof document !== 'undefined' && document.querySelector(NEW_SESSION_SELECTOR) !== null,
    'dom.addWorkspace': () => typeof document !== 'undefined' && document.querySelector(ADD_WORKSPACE_SELECTOR) !== null,
  }
  return {
    generation: probe.generation,
    migrations,
    failures,
    ctx: createAdapterContext(ctx, sessions, workspaces),
    sessions,
    workspaces,
    service,
    has: capability => capabilityChecks[capability](),
    resolveStartSession: () => surfaceStartSession(surface),
    resolveOpenSession: () => surfaceOpenSession(surface),
    sessionList: () => readSessionList(surface),
    resolveAddWorkspace: () => surfaceAddWorkspace(surface),
    startSession: workspaceId => runStartSession(surface, workspaceId, warn),
    openSession: sessionId => runOpenSession(surface, sessionId, warn),
    addWorkspace: callOptions => runAddWorkspace(surface, callOptions, warn),
  }
}
