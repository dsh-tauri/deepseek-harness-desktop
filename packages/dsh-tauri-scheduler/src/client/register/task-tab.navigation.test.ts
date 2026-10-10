import type { ILayout, MainPanelId, SessionId, SessionListState, WorkspaceSnapshot } from 'dsh-tauri/client'
import type { Translate } from '../locales/index.types'
import type { TaskTabNavigation } from '../types/task-tab'
import { getEventListeners } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLifecycleController } from '../../../../dsh-tauri/src/client/controller'
import { defineAdapter } from '../../../../dsh-tauri/src/client/register/index.adapter'
import { liveTaskTabIds, openTaskTab } from './task-tab.navigation'

function observable<T>(initial: T) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    listeners,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    publish(value: T) {
      snapshot = value
      for (const listener of [...listeners])
        listener()
    },
  }
}

function deferred() {
  let resolve = () => {}
  let reject = (_error: unknown) => {}
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const cleanups: Array<() => void> = []
const sessionId = (value: string) => value as SessionId
const translate = ((key: string) => key) as Translate

function runtime(options: { ids?: string[], current?: string, original?: string, mounted?: string, archived?: string[] } = {}) {
  const ids = (options.ids ?? ['original', 'current', 'first']).map(sessionId)
  const list = observable<SessionListState & { current?: string }>({
    ids,
    byId: Object.fromEntries(ids.map(id => [id, {
      id,
      displayTitle: id,
      running: false,
      retainedBy: {},
      blank: false,
      updatedAt: 0,
    }])),
    phase: 'ready',
    projectionsBySession: {},
    current: options.current ?? 'current',
  })
  const workspaces = observable<WorkspaceSnapshot>({
    items: [],
    archivedSessionIds: (options.archived ?? []).map(sessionId),
    pinnedSessionIds: [],
    state: 'idle',
    phase: 'ready',
    error: null,
  })
  const mounted = observable<SessionId | undefined>(options.mounted ? sessionId(options.mounted) : undefined)
  const panelInfo = observable<{ activePanelId: MainPanelId | null }>({ activePanelId: 'scheduler' as MainPanelId })
  const calls: string[] = []
  const openSession = vi.fn((id: string): unknown => {
    calls.push(`session:${id}`)
    return undefined
  })
  const startSession = vi.fn((): unknown => {
    calls.push('start')
    return undefined
  })
  const openTab = vi.fn((_kind: string, _options: { params: TaskTabNavigation }) => {
    calls.push('tab')
  })
  const layout: ILayout = {
    panelInfo,
    selectPanel: vi.fn((id: MainPanelId | null) => {
      calls.push(`panel:${id}`)
      panelInfo.publish({ activePanelId: id })
    }),
    beginNavigation: () => new AbortController().signal,
    toggleSidebar: vi.fn(),
    openRightbar: vi.fn(),
    closeRightbar: vi.fn(),
  }
  const uiWorkspace: { openSession?: typeof openSession, startSession?: typeof startSession } = { openSession, startSession }
  const sessions: { list: typeof list, create?: () => Promise<SessionId> } = { list }
  const adapter = defineAdapter({ sessions, workspaces: { list: workspaces }, uiWorkspace }, { onWarn: vi.fn() })
  const controller = createLifecycleController()
  const abort = new AbortController()
  const target: TaskTabNavigation = { id: 'task-1', sessionId: options.original ?? 'original' }
  const input = {
    controller,
    adapter,
    layout,
    sidebar: { mounted, openTab },
    target,
    signal: abort.signal,
    t: translate,
    sessions: list.getSnapshot,
    workspaces: workspaces.getSnapshot,
  }
  cleanups.push(() => {
    abort.abort()
    controller.dispose()
  })
  return { input, controller, abort, list, sessions, workspaces, mounted, panelInfo, calls, openSession, startSession, openTab, layout, uiWorkspace }
}

function observe(promise: Promise<void>) {
  let result: { status: 'opened' } | { status: 'failed', error: unknown } | undefined
  const settled = promise.then(
    () => { result = { status: 'opened' } as const },
    (error) => { result = { status: 'failed', error } as const },
  )
  return { settled, result: () => result }
}

function expectClean(fixture: ReturnType<typeof runtime>) {
  expect(fixture.mounted.listeners.size).toBe(0)
  expect(fixture.panelInfo.listeners.size).toBe(0)
  expect(fixture.list.listeners.size).toBe(0)
  expect(fixture.workspaces.listeners.size).toBe(0)
  expect(getEventListeners(fixture.abort.signal, 'abort')).toHaveLength(0)
  expect(vi.getTimerCount()).toBe(0)
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanups.splice(0).reverse().forEach(cleanup => cleanup())
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('openTaskTab pending public navigation', () => {
  it('bounds an unresolved openSession promise by the five-second navigation deadline', async () => {
    const fixture = runtime()
    const opening = deferred()
    fixture.openSession.mockReturnValue(opening.promise)
    const request = observe(openTaskTab(fixture.input))

    await vi.advanceTimersByTimeAsync(4_999)
    expect(request.result()).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(request.result()).toEqual({ status: 'failed', error: new Error('navigation.failed') })
    expect(fixture.openTab).not.toHaveBeenCalled()
    expectClean(fixture)
  })

  it('aborts without waiting for an unresolved openSession promise', async () => {
    const fixture = runtime()
    fixture.openSession.mockReturnValue(deferred().promise)
    const request = observe(openTaskTab(fixture.input))
    const reason = new Error('replaced navigation')

    fixture.abort.abort(reason)
    await vi.advanceTimersByTimeAsync(0)
    expect(request.result()).toEqual({ status: 'failed', error: reason })
    expect(fixture.openTab).not.toHaveBeenCalled()
    expectClean(fixture)
  })

  it('disposes a request whose openSession promise never resolves', async () => {
    const fixture = runtime()
    fixture.openSession.mockReturnValue(deferred().promise)
    const request = observe(openTaskTab(fixture.input))

    fixture.controller.dispose()
    await vi.advanceTimersByTimeAsync(0)
    expect(request.result()).toEqual({ status: 'failed', error: new Error('navigation.failed') })
    expect(fixture.openTab).not.toHaveBeenCalled()
    expectClean(fixture)
  })

  it('keeps the deadline measured from request creation even when catalog arrival starts navigation late', async () => {
    const fixture = runtime()
    fixture.list.publish({ ...fixture.list.getSnapshot(), phase: 'pending' })
    fixture.openSession.mockReturnValue(deferred().promise)
    const request = observe(openTaskTab(fixture.input))
    await vi.advanceTimersByTimeAsync(4_970)
    expect(fixture.openSession).not.toHaveBeenCalled()
    fixture.list.publish({ ...fixture.list.getSnapshot(), phase: 'ready' })
    await vi.advanceTimersByTimeAsync(5)
    expect(fixture.openSession).toHaveBeenCalledExactlyOnceWith('original')
    await vi.advanceTimersByTimeAsync(24)
    expect(request.result()).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)

    expect(request.result()).toEqual({ status: 'failed', error: new Error('navigation.failed') })
    expect(fixture.openTab).not.toHaveBeenCalled()
    expectClean(fixture)
  })

  it('ignores a late successful public navigation after its deadline expires', async () => {
    const fixture = runtime({ mounted: 'original' })
    const opening = deferred()
    fixture.openSession.mockReturnValue(opening.promise)
    const request = observe(openTaskTab(fixture.input))
    await vi.advanceTimersByTimeAsync(5_000)
    opening.resolve()
    await vi.advanceTimersByTimeAsync(0)

    expect(request.result()).toEqual({ status: 'failed', error: new Error('navigation.failed') })
    expect(fixture.openTab).not.toHaveBeenCalled()
    expectClean(fixture)
  })

  it('bounds an unresolved startSession promise by the same navigation deadline', async () => {
    const fixture = runtime({ ids: [] })
    fixture.startSession.mockReturnValue(deferred().promise)
    const request = observe(openTaskTab(fixture.input))

    await vi.advanceTimersByTimeAsync(5_000)
    expect(request.result()).toEqual({ status: 'failed', error: new Error('navigation.failed') })
    expect(fixture.startSession).toHaveBeenCalledTimes(1)
    expect(fixture.openTab).not.toHaveBeenCalled()
    expectClean(fixture)
  })
})

describe('openTaskTab public session selection', () => {
  it.each([
    { name: 'available original', options: { mounted: 'original' }, owner: 'original' },
    { name: 'current when original is missing', options: { original: 'missing', mounted: 'current' }, owner: 'current' },
    { name: 'current when original is archived', options: { archived: ['original'], mounted: 'current' }, owner: 'current' },
    { name: 'first when current and original are missing', options: { original: 'missing', current: 'missing', mounted: 'original' }, owner: 'original' },
    { name: 'first non-archived when earlier ids are archived', options: { original: 'missing', archived: ['original', 'current'], mounted: 'first' }, owner: 'first' },
    { name: 'first when no current is selected', options: { original: 'missing', current: '', mounted: 'original' }, owner: 'original' },
  ])('closes the main panel before opening the $name', async ({ options, owner }) => {
    const fixture = runtime(options)
    fixture.sessions.create = vi.fn(async () => sessionId('unneeded'))
    await openTaskTab(fixture.input)

    expect(fixture.sessions.create).not.toHaveBeenCalled()
    expect(fixture.calls).toEqual(['panel:null', `session:${owner}`, 'tab'])
    expect(fixture.openSession).toHaveBeenCalledExactlyOnceWith(owner)
    expect(fixture.startSession).not.toHaveBeenCalled()
    expect(fixture.openTab).toHaveBeenCalledExactlyOnceWith('scheduleTask', { params: { id: 'task-1', sessionId: options.original ?? 'original' } })
    expectClean(fixture)
  })

  it('starts a new session only when the ready catalog contains no available session', async () => {
    const fixture = runtime({ ids: [], mounted: undefined })
    const request = observe(openTaskTab(fixture.input))
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.calls).toEqual(['panel:null', 'start'])
    expect(fixture.openSession).not.toHaveBeenCalled()
    expect(request.result()).toBeUndefined()

    fixture.list.publish({ ...fixture.list.getSnapshot(), ids: [sessionId('created')] })
    fixture.mounted.publish(sessionId('created'))
    await request.settled
    expect(request.result()).toEqual({ status: 'opened' })
    expect(fixture.calls).toEqual(['panel:null', 'start', 'tab'])
    expectClean(fixture)
  })

  it('creates and opens a real session when workspace navigation would only show the empty hero', async () => {
    const fixture = runtime({ ids: [] })
    fixture.sessions.create = vi.fn(async () => {
      fixture.calls.push('create')
      fixture.list.publish({ ...fixture.list.getSnapshot(), ids: [sessionId('created')] })
      return sessionId('created')
    })
    fixture.openSession.mockImplementation((id) => {
      fixture.calls.push(`session:${id}`)
      fixture.mounted.publish(sessionId(id))
    })

    await openTaskTab(fixture.input)

    expect(fixture.calls).toEqual(['panel:null', 'create', 'session:created', 'tab'])
    expect(fixture.sessions.create).toHaveBeenCalledExactlyOnceWith()
    expect(fixture.startSession).not.toHaveBeenCalled()
    expect(fixture.openTab).toHaveBeenCalledExactlyOnceWith('scheduleTask', { params: fixture.input.target })
    expectClean(fixture)
  })

  it.each(['abort', 'dispose', 'deadline'] as const)('does not navigate after session creation completes past %s', async (cancel) => {
    const fixture = runtime({ ids: [] })
    let complete = (_id: SessionId) => {}
    fixture.sessions.create = vi.fn(() => new Promise<SessionId>((resolve) => {
      complete = resolve
    }))
    const request = observe(openTaskTab(fixture.input))
    if (cancel === 'abort')
      fixture.abort.abort(new Error('cancelled'))
    else if (cancel === 'dispose')
      fixture.controller.dispose()
    else
      await vi.advanceTimersByTimeAsync(5_000)
    complete(sessionId('created'))
    await request.settled
    await vi.advanceTimersByTimeAsync(0)

    expect(request.result()?.status).toBe('failed')
    expect(fixture.openSession).not.toHaveBeenCalled()
    expect(fixture.startSession).not.toHaveBeenCalled()
    expect(fixture.openTab).not.toHaveBeenCalled()
    expectClean(fixture)
  })

  it('does not create an orphan session when the public opening capability is unavailable', async () => {
    const fixture = runtime({ ids: [] })
    fixture.sessions.create = vi.fn(async () => sessionId('created'))
    const adapter = defineAdapter({ sessions: fixture.sessions, workspaces: { list: fixture.workspaces } }, { onWarn: vi.fn() })

    await expect(openTaskTab({ ...fixture.input, adapter })).rejects.toThrow('navigation.unavailable')

    expect(fixture.sessions.create).not.toHaveBeenCalled()
    expect(fixture.startSession).not.toHaveBeenCalled()
    expect(fixture.openTab).not.toHaveBeenCalled()
    expectClean(fixture)
  })

  it('propagates public session creation failure without opening a hero or a task tab', async () => {
    const fixture = runtime({ ids: [] })
    const error = new Error('session creation failed')
    fixture.sessions.create = vi.fn(async () => {
      throw error
    })

    await expect(openTaskTab(fixture.input)).rejects.toBe(error)

    expect(fixture.openSession).not.toHaveBeenCalled()
    expect(fixture.startSession).not.toHaveBeenCalled()
    expect(fixture.openTab).not.toHaveBeenCalled()
    expectClean(fixture)
  })

  it('does not treat archived rows or a missing current id as live sessions', async () => {
    const fixture = runtime({ ids: ['archived'], archived: ['archived'], original: 'archived', current: 'missing' })
    const request = observe(openTaskTab(fixture.input))
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.openSession).not.toHaveBeenCalled()
    expect(fixture.startSession).toHaveBeenCalledTimes(1)

    fixture.list.publish({ ...fixture.list.getSnapshot(), ids: [sessionId('created')] })
    fixture.mounted.publish(sessionId('created'))
    await request.settled
    expect(request.result()).toEqual({ status: 'opened' })
    expectClean(fixture)
  })

  it.each(['sessions', 'workspaces'] as const)('waits for pending %s resources instead of starting another session', async (pending) => {
    const fixture = runtime({ mounted: 'original' })
    if (pending === 'sessions')
      fixture.list.publish({ ...fixture.list.getSnapshot(), phase: 'pending' })
    else
      fixture.workspaces.publish({ ...fixture.workspaces.getSnapshot(), phase: 'pending' })
    const request = observe(openTaskTab(fixture.input))
    await vi.advanceTimersByTimeAsync(24)
    expect(fixture.openSession).not.toHaveBeenCalled()
    expect(fixture.startSession).not.toHaveBeenCalled()
    expect(fixture.openTab).not.toHaveBeenCalled()

    fixture.list.publish({ ...fixture.list.getSnapshot(), phase: 'ready' })
    fixture.workspaces.publish({ ...fixture.workspaces.getSnapshot(), phase: 'ready' })
    await vi.advanceTimersByTimeAsync(25)
    await request.settled
    expect(request.result()).toEqual({ status: 'opened' })
    expect(fixture.calls).toEqual(['panel:null', 'session:original', 'tab'])
    expectClean(fixture)
  })

  it('reports a visible failure if starting a session shows only a hero with no mounted surface', async () => {
    const fixture = runtime({ ids: [] })
    const request = observe(openTaskTab(fixture.input))
    await vi.advanceTimersByTimeAsync(5_000)

    expect(request.result()).toEqual({ status: 'failed', error: new Error('navigation.failed') })
    expect(fixture.startSession).toHaveBeenCalledTimes(1)
    expect(fixture.openTab).not.toHaveBeenCalled()
    expectClean(fixture)
  })
})

describe('openTaskTab mounted session and public surface readiness', () => {
  it('waits for the selected session to replace the previous mounted session', async () => {
    const fixture = runtime({ mounted: 'current' })
    const request = observe(openTaskTab(fixture.input))
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.openTab).not.toHaveBeenCalled()
    expect(fixture.mounted.listeners.size).toBe(1)

    fixture.mounted.publish(sessionId('original'))
    await request.settled
    expect(request.result()).toEqual({ status: 'opened' })
    expect(fixture.openTab).toHaveBeenCalledTimes(1)
    expectClean(fixture)
  })

  it('rejects a different new mounted session rather than opening on the wrong owner', async () => {
    const fixture = runtime({ mounted: 'current' })
    const request = observe(openTaskTab(fixture.input))
    await vi.advanceTimersByTimeAsync(0)
    fixture.mounted.publish(sessionId('first'))
    await request.settled

    expect(request.result()).toEqual({ status: 'failed', error: new Error('navigation.failed') })
    expect(fixture.openTab).not.toHaveBeenCalled()
    expectClean(fixture)
  })

  it('bounds a permanently missing mounted session and removes all readiness subscriptions', async () => {
    const fixture = runtime()
    const request = observe(openTaskTab(fixture.input))
    await vi.advanceTimersByTimeAsync(4_999)
    expect(request.result()).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)

    expect(request.result()).toEqual({ status: 'failed', error: new Error('navigation.failed') })
    expect(fixture.openTab).not.toHaveBeenCalled()
    expectClean(fixture)
  })

  it('retries the documented no-session-surface race after 25ms and cleans the deadline', async () => {
    const fixture = runtime({ mounted: 'original' })
    fixture.openTab.mockImplementationOnce(() => {
      throw new Error('sidebarRight: no session surface is mounted')
    })
    const request = observe(openTaskTab(fixture.input))
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.openTab).toHaveBeenCalledTimes(1)
    expect(request.result()).toBeUndefined()
    await vi.advanceTimersByTimeAsync(24)
    expect(fixture.openTab).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)

    expect(request.result()).toEqual({ status: 'opened' })
    expect(fixture.openTab).toHaveBeenCalledTimes(2)
    expectClean(fixture)
  })

  it('bounds a no-session-surface race that never becomes ready', async () => {
    const fixture = runtime({ mounted: 'original' })
    fixture.openTab.mockImplementation(() => {
      throw new Error('sidebarRight: no session surface is mounted')
    })
    const request = observe(openTaskTab(fixture.input))
    await vi.advanceTimersByTimeAsync(5_000)

    expect(request.result()).toEqual({ status: 'failed', error: new Error('navigation.failed') })
    expect(fixture.openTab.mock.calls.length).toBeGreaterThan(1)
    expectClean(fixture)
  })

  it('does not retry an unrelated public openTab failure', async () => {
    const fixture = runtime({ mounted: 'original' })
    const error = new Error('registration missing')
    fixture.openTab.mockImplementation(() => {
      throw error
    })
    await expect(openTaskTab(fixture.input)).rejects.toBe(error)

    expect(fixture.openTab).toHaveBeenCalledTimes(1)
    expectClean(fixture)
  })

  it('rechecks archive status after opening instead of committing on a newly archived surface', async () => {
    const fixture = runtime({ mounted: 'original' })
    const opening = deferred()
    fixture.openSession.mockReturnValue(opening.promise)
    const request = observe(openTaskTab(fixture.input))
    fixture.workspaces.publish({ ...fixture.workspaces.getSnapshot(), archivedSessionIds: [sessionId('original')] })
    opening.resolve()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(request.result()).toEqual({ status: 'failed', error: new Error('navigation.failed') })
    expect(fixture.openTab).not.toHaveBeenCalled()
    expectClean(fixture)
  })

  it('waits for a started session to appear in the ready catalog before opening its mounted tab', async () => {
    const fixture = runtime({ ids: [] })
    const request = observe(openTaskTab(fixture.input))
    await vi.advanceTimersByTimeAsync(0)
    fixture.mounted.publish(sessionId('created'))
    expect(fixture.openTab).not.toHaveBeenCalled()
    fixture.list.publish({ ...fixture.list.getSnapshot(), ids: [sessionId('created')] })
    await vi.advanceTimersByTimeAsync(25)

    expect(request.result()).toEqual({ status: 'opened' })
    expect(fixture.openTab).toHaveBeenCalledTimes(1)
    expectClean(fixture)
  })
})

describe('openTaskTab cancellation and cleanup', () => {
  it('rejects an already-aborted request without changing panel or session', async () => {
    const fixture = runtime({ mounted: 'original' })
    const reason = new Error('already replaced')
    fixture.abort.abort(reason)
    await expect(openTaskTab(fixture.input)).rejects.toBe(reason)

    expect(fixture.calls).toEqual([])
    expectClean(fixture)
  })

  it('rejects a disposed controller before acquiring any public navigation resources', async () => {
    const fixture = runtime({ mounted: 'original' })
    fixture.controller.dispose()
    await expect(openTaskTab(fixture.input)).rejects.toThrow('navigation.failed')

    expect(fixture.calls).toEqual([])
    expectClean(fixture)
  })

  it('aborts while waiting for a mounted session and ignores its later mount', async () => {
    const fixture = runtime()
    const request = observe(openTaskTab(fixture.input))
    await vi.advanceTimersByTimeAsync(0)
    const reason = new Error('cancelled request')
    fixture.abort.abort(reason)
    await request.settled
    fixture.mounted.publish(sessionId('original'))
    await vi.advanceTimersByTimeAsync(25)

    expect(request.result()).toEqual({ status: 'failed', error: reason })
    expect(fixture.openTab).not.toHaveBeenCalled()
    expectClean(fixture)
  })

  it('cancels a scheduled surface retry immediately when the request aborts', async () => {
    const fixture = runtime({ mounted: 'original' })
    fixture.openTab.mockImplementation(() => {
      throw new Error('sidebarRight: no session surface is mounted')
    })
    const request = observe(openTaskTab(fixture.input))
    await vi.advanceTimersByTimeAsync(0)
    fixture.abort.abort(new Error('replaced'))
    await request.settled
    await vi.advanceTimersByTimeAsync(100)

    expect(fixture.openTab).toHaveBeenCalledTimes(1)
    expectClean(fixture)
  })

  it('settles and unsubscribes immediately when its real lifecycle controller is disposed', async () => {
    const fixture = runtime()
    const request = observe(openTaskTab(fixture.input))
    await vi.advanceTimersByTimeAsync(0)
    fixture.controller.dispose()
    await request.settled
    fixture.mounted.publish(sessionId('original'))

    expect(request.result()).toEqual({ status: 'failed', error: new Error('navigation.failed') })
    expect(fixture.openTab).not.toHaveBeenCalled()
    expectClean(fixture)
  })

  it('rejects when a main panel replaces the navigation while waiting for a surface', async () => {
    const fixture = runtime()
    const request = observe(openTaskTab(fixture.input))
    await vi.advanceTimersByTimeAsync(0)
    fixture.panelInfo.publish({ activePanelId: 'other-panel' as MainPanelId })
    await request.settled
    fixture.mounted.publish(sessionId('original'))

    expect(request.result()).toEqual({ status: 'failed', error: new Error('navigation.failed') })
    expect(fixture.openTab).not.toHaveBeenCalled()
    expectClean(fixture)
  })

  it.each(['resolve', 'reject'] as const)('ignores a late public promise %s after abort without leaking listeners or retry timers', async (settle) => {
    const fixture = runtime({ mounted: 'original' })
    const opening = deferred()
    fixture.openSession.mockReturnValue(opening.promise)
    const request = observe(openTaskTab(fixture.input))
    const reason = new Error('superseded')
    fixture.abort.abort(reason)
    await vi.advanceTimersByTimeAsync(0)
    if (settle === 'resolve')
      opening.resolve()
    else
      opening.reject(new Error('late service failure'))
    await vi.advanceTimersByTimeAsync(0)

    expect(request.result()).toEqual({ status: 'failed', error: reason })
    expect(fixture.openTab).not.toHaveBeenCalled()
    expectClean(fixture)
  })

  it('lets a replacement request open exactly its new target while the old public promise is still pending', async () => {
    const fixture = runtime({ mounted: 'original' })
    const opening = deferred()
    fixture.openSession.mockReturnValueOnce(opening.promise)
    const first = observe(openTaskTab(fixture.input))
    fixture.abort.abort(new Error('new request'))
    const replacement = new AbortController()
    await openTaskTab({ ...fixture.input, signal: replacement.signal, target: { id: 'task-2', sessionId: 'original' } })
    opening.resolve()
    await vi.advanceTimersByTimeAsync(0)

    expect(first.result()?.status).toBe('failed')
    expect(fixture.openTab).toHaveBeenCalledExactlyOnceWith('scheduleTask', { params: { id: 'task-2', sessionId: 'original' } })
    expect(getEventListeners(replacement.signal, 'abort')).toHaveLength(0)
    expectClean(fixture)
  })

  it('does not let disposing a completed controller affect a later independent navigation', async () => {
    const first = runtime({ mounted: 'original' })
    await openTaskTab(first.input)
    const second = runtime()
    const request = observe(openTaskTab(second.input))
    await vi.advanceTimersByTimeAsync(0)
    first.controller.dispose()
    expect(request.result()).toBeUndefined()
    second.mounted.publish(sessionId('original'))
    await request.settled

    expect(request.result()).toEqual({ status: 'opened' })
    expect(first.openTab).toHaveBeenCalledTimes(1)
    expect(second.openTab).toHaveBeenCalledTimes(1)
    expectClean(first)
    expectClean(second)
  })
})

describe('openTaskTab public service failures', () => {
  it('fails closed on an unavailable workspace snapshot instead of starting a new session', async () => {
    const fixture = runtime()
    fixture.workspaces.publish({ ...fixture.workspaces.getSnapshot(), state: 'error' })
    const request = observe(openTaskTab(fixture.input))
    await vi.advanceTimersByTimeAsync(0)

    expect(request.result()).toEqual({ status: 'failed', error: new Error('navigation.unavailable') })
    expect(fixture.openSession).not.toHaveBeenCalled()
    expect(fixture.startSession).not.toHaveBeenCalled()
    expect(fixture.openTab).not.toHaveBeenCalled()
    expectClean(fixture)
  })

  it.each(['open', 'start'] as const)('cleans all resources when the public %s service throws', async (service) => {
    const fixture = runtime(service === 'start' ? { ids: [] } : {})
    const error = new Error(`${service} failed`)
    const ability = service === 'start' ? fixture.startSession : fixture.openSession
    ability.mockImplementation(() => {
      throw error
    })
    await expect(openTaskTab(fixture.input)).rejects.toBe(error)

    expect(fixture.openTab).not.toHaveBeenCalled()
    expectClean(fixture)
  })

  it.each(['open', 'start'] as const)('cleans all resources when the public %s service promise rejects', async (service) => {
    const fixture = runtime(service === 'start' ? { ids: [] } : {})
    const error = new Error(`${service} rejected`)
    const ability = service === 'start' ? fixture.startSession : fixture.openSession
    ability.mockImplementation(() => Promise.reject(error))
    await expect(openTaskTab(fixture.input)).rejects.toBe(error)

    expect(fixture.openTab).not.toHaveBeenCalled()
    expectClean(fixture)
  })

  it('cleans resources if selecting the registered main panel throws', async () => {
    const fixture = runtime()
    const error = new Error('layout unavailable')
    vi.mocked(fixture.layout.selectPanel).mockImplementation(() => {
      throw error
    })
    await expect(openTaskTab(fixture.input)).rejects.toBe(error)

    expect(fixture.openSession).not.toHaveBeenCalled()
    expect(fixture.startSession).not.toHaveBeenCalled()
    expectClean(fixture)
  })

  it('does not report success for a public navigation promise rejected without a reason', async () => {
    const fixture = runtime({ mounted: 'original' })
    const opening = deferred()
    fixture.openSession.mockReturnValue(opening.promise)
    const request = observe(openTaskTab(fixture.input))
    opening.reject(undefined)
    await vi.advanceTimersByTimeAsync(0)

    expect(request.result()?.status).toBe('failed')
    expect(fixture.openTab).not.toHaveBeenCalled()
    expectClean(fixture)
  })

  it('removes already-acquired lifecycle resources if the public mounted subscription throws', async () => {
    const fixture = runtime()
    const error = new Error('mounted service disposed')
    vi.spyOn(fixture.mounted, 'subscribe').mockImplementation(() => {
      throw error
    })
    await expect(openTaskTab(fixture.input)).rejects.toBe(error)

    expect(fixture.openSession).not.toHaveBeenCalled()
    expect(fixture.openTab).not.toHaveBeenCalled()
    expectClean(fixture)
  })

  it('removes an acquired mounted subscription if the public panel subscription throws', async () => {
    const fixture = runtime()
    const error = new Error('layout service disposed')
    vi.spyOn(fixture.panelInfo, 'subscribe').mockImplementation(() => {
      throw error
    })
    await expect(openTaskTab(fixture.input)).rejects.toBe(error)

    expect(fixture.openSession).not.toHaveBeenCalled()
    expect(fixture.openTab).not.toHaveBeenCalled()
    expectClean(fixture)
  })

  it('reports unavailable instead of trying to start when the selected session cannot be opened', async () => {
    const fixture = runtime()
    delete fixture.uiWorkspace.openSession
    const adapter = defineAdapter({ sessions: { list: fixture.list }, workspaces: { list: fixture.workspaces } }, { onWarn: vi.fn() })
    await expect(openTaskTab({ ...fixture.input, adapter })).rejects.toThrow('navigation.unavailable')

    expect(fixture.openTab).not.toHaveBeenCalled()
    expect(fixture.startSession).not.toHaveBeenCalled()
    expectClean(fixture)
  })

  it('reports unavailable when a ready empty catalog has no public startSession capability', async () => {
    const fixture = runtime({ ids: [] })
    const adapter = defineAdapter({ sessions: { list: fixture.list }, workspaces: { list: fixture.workspaces } }, { onWarn: vi.fn() })
    await expect(openTaskTab({ ...fixture.input, adapter })).rejects.toThrow('navigation.unavailable')

    expect(fixture.openTab).not.toHaveBeenCalled()
    expectClean(fixture)
  })
})

describe('liveTaskTabIds', () => {
  it('reads only public tab page ids from the requested session', () => {
    const tabsIn = vi.fn(() => [
      { id: 'page-1', kind: 'scheduleTask', contentId: 'content-1' },
      { id: 'page-2', kind: 'files', contentId: 'content-2' },
    ])
    const fixture = runtime()
    expect(liveTaskTabIds({ ...fixture.input.sidebar, tabsIn }, 'owner')).toEqual(['page-1', 'page-2'])
    expect(tabsIn).toHaveBeenCalledExactlyOnceWith('owner')
  })

  it('preserves unknown vs empty capability results for conservative pruning', () => {
    const fixture = runtime()
    expect(liveTaskTabIds(undefined, 'owner')).toBeUndefined()
    expect(liveTaskTabIds(fixture.input.sidebar, 'owner')).toBeUndefined()
    expect(liveTaskTabIds({ ...fixture.input.sidebar, tabsIn: () => [] }, 'owner')).toEqual([])
  })
})
