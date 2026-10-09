import type { GetApiTauriWorktreeBindingsResponse as WorktreeBindings } from '../apis/index.type'
import { createLifecycleController } from 'dsh-tauri/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DISCARD_POLL_DELAY_MS, HYDRATION_RETRY_BUDGET_PER_SECOND, HYDRATION_RETRY_WINDOW_MS, SESSION_RECONCILE_MIN_INTERVAL_MS } from '../constants'
import { store } from '../store'
import { registerWorktreeHydration } from './hydration'

const BASE_URL = '/api/tauri/worktree'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn<(url: string, options?: { method?: string, body?: unknown, baseURL?: string, params?: Record<string, string> }) => Promise<unknown>>(),
}))

vi.mock('dsh-tauri/client', async () => {
  const lodash = await import('lodash-es')
  const createLifecycleController = () => {
    let disposed = false
    const disposers = new Set<() => void>()
    const timers = new Set<ReturnType<typeof setTimeout>>()
    return {
      add: (disposer: () => void) => {
        disposers.add(disposer)
      },
      timeout: (fn: () => void, ms: number) => {
        if (disposed)
          return () => {}
        const timer = setTimeout(() => {
          timers.delete(timer)
          if (!disposed)
            fn()
        }, ms)
        timers.add(timer)
        return () => {
          timers.delete(timer)
          clearTimeout(timer)
        }
      },
      interval: () => () => {},
      listen: () => () => {},
      observe: () => ({ disconnect: () => {} }),
      isDisposed: () => disposed,
      dispose: () => {
        if (disposed)
          return
        disposed = true
        for (const timer of timers)
          clearTimeout(timer)
        timers.clear()
        for (const disposer of [...disposers])
          disposer()
        disposers.clear()
      },
    }
  }

  const defineStore = (options: {
    state: () => Record<string, unknown>
    actions?: Record<string, (...args: unknown[]) => unknown>
  }) => {
    const state = options.state()
    const listeners = new Set<() => void>()
    const notify = (): void => {
      for (const listener of [...listeners])
        listener()
    }
    const store: Record<string, unknown> = { ...state, $state: state }
    for (const [name, action] of Object.entries(options.actions ?? {})) {
      store[name] = (...args: unknown[]) => {
        const result = action.apply(state, args)
        notify()
        return result
      }
    }
    store.$subscribe = (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
    store.$subscribeKey = () => () => {}
    store.$patch = (patch: Record<string, unknown>) => {
      Object.assign(state, patch)
      notify()
    }
    return store
  }

  return {
    fetch: mocks.fetch,
    ofetch: mocks.fetch,
    defineLocale: (namespace: string) => ({
      NS: namespace,
      text: (key: string) => key,
      activeLocale: () => 'en',
      isEnglishLocale: () => true,
      useLocale: () => 'en',
      registerLocale: () => () => {},
    }),
    defineStore,
    useStore: () => ({}),
    defineRegister: (ctxOrSetup: unknown, maybeSetup?: unknown) => {
      const setup = (typeof maybeSetup === 'function' ? maybeSetup : ctxOrSetup) as
        (controller: unknown, ctx: unknown, adapter: unknown) => void
      return function registerEffect(this: unknown): () => void {
        const controller = createLifecycleController()
        setup(controller, this, { sessions: {}, workspaces: {} })
        return () => controller.dispose()
      }
    },
    createLifecycleController,
    compact: lodash.compact,
    difference: lodash.difference,
    filter: lodash.filter,
    find: lodash.find,
    findKey: lodash.findKey,
    findLast: lodash.findLast,
    forEach: lodash.forEach,
    get: lodash.get,
    isEmpty: lodash.isEmpty,
    isEqual: lodash.isEqual,
    isString: lodash.isString,
    keyBy: lodash.keyBy,
    map: lodash.map,
    partition: lodash.partition,
    reject: lodash.reject,
    throttle: lodash.throttle,
    trimEnd: lodash.trimEnd,
    uniqBy: lodash.uniqBy,
  }
})

function snapshotSource<T>(initial: T) {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    publish: (next: T) => {
      state = next
      for (const listener of [...listeners])
        listener()
    },
  }
}

async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++)
    await Promise.resolve()
}

interface HarnessOptions {
  bindings?: WorktreeBindings
  holdStatus?: boolean
  runningBit?: boolean
  archived?: string[]
}

interface Harness {
  dispose: () => void
  emitSessionEvent: (sessionId?: string) => void
  setRunning: (sessionId: string, running: boolean) => void
  publishList: () => void
  publishWorkspaces: () => void
  setArchived: (ids: string[]) => void
  setCurrent: (sessionId: string) => void
  setSessionIds: (ids: string[]) => void
  statusCalls: () => number
  bindingsCalls: () => number
  discardCalls: () => number
  callsFor: (sessionId: string) => number
  subscribeCount: (sessionId: string) => number
  releaseStatus: () => void
}

const EMPTY_BINDINGS: WorktreeBindings = { bindings: [], jobs: [] }

function harness(
  statusFor: (sessionId: string) => Record<string, unknown>,
  sessionIds: string[] = ['s-1'],
  options: HarnessOptions = {},
): Harness {
  const runningBit = options.runningBit ?? true
  const listenersBySession = new Map<string, Set<() => void>>()
  const subscribeCalls = new Map<string, number>()
  const runningBySession = new Map<string, boolean>()
  let releaseHeld: (() => void) | null = null
  let current: string | undefined = sessionIds[0]
  let ids = [...sessionIds]
  const list = snapshotSource<{ ids: string[], current?: string }>({ ids, current })
  const workspaces = snapshotSource({ archivedSessionIds: [...(options.archived ?? [])] as string[] })

  mocks.fetch.mockImplementation(async (url: string, request?: { params?: Record<string, string> }) => {
    const target = String(url)
    if (target.includes('/bindings'))
      return options.bindings ?? EMPTY_BINDINGS
    const sessionId = request?.params?.sessionId
    if (!target.includes('/status') || typeof sessionId !== 'string')
      return { ok: true }
    const payload = statusFor(sessionId)
    if (options.holdStatus)
      await new Promise<void>((resolve) => { releaseHeld = resolve })
    return payload
  })

  const listenersOf = (id: string): Set<() => void> => {
    let listeners = listenersBySession.get(id)
    if (!listeners) {
      listeners = new Set()
      listenersBySession.set(id, listeners)
    }
    return listeners
  }

  const notify = (id: string): void => {
    for (const listener of [...listenersOf(id)])
      listener()
  }

  const ctx = {
    sessions: {
      list,
      binding: (id: string) => ids.includes(id)
        ? {
            session: {
              subscribe: (listener: () => void) => {
                subscribeCalls.set(id, (subscribeCalls.get(id) ?? 0) + 1)
                const listeners = listenersOf(id)
                listeners.add(listener)
                return () => listeners.delete(listener)
              },
              ...(runningBit ? { getSnapshot: () => ({ running: runningBySession.get(id) ?? false }) } : {}),
            },
          }
        : undefined,
      open: () => {},
      refresh: async () => {},
    },
    workspaces: { list: workspaces },
  }

  const urls = (): string[] => mocks.fetch.mock.calls.map(call => String(call[0]))
  const deleteCalls = (): number => mocks.fetch.mock.calls
    .filter(call => call[0] === BASE_URL && call[1]?.method?.toUpperCase() === 'DELETE')
    .length
  const controller = createLifecycleController()
  registerWorktreeHydration(controller as never, ctx.sessions as never, ctx.workspaces as never)
  return {
    dispose: () => controller.dispose(),
    emitSessionEvent: (sessionId = ids[0]) => notify(sessionId),
    setRunning: (sessionId: string, running: boolean) => {
      runningBySession.set(sessionId, running)
      notify(sessionId)
    },
    publishList: () => list.publish({ ids: [...ids], current }),
    setCurrent: (sessionId: string) => {
      current = sessionId
      list.publish({ ids: [...ids], current: sessionId })
    },
    setSessionIds: (next: string[]) => {
      ids = [...next]
      list.publish({ ids: [...ids], current })
    },
    statusCalls: () => urls().filter(url => url.includes('/status')).length,
    bindingsCalls: () => urls().filter(url => url.includes('/bindings')).length,
    discardCalls: deleteCalls,
    publishWorkspaces: () => workspaces.publish({ archivedSessionIds: [...(workspaces.getSnapshot().archivedSessionIds)] }),
    setArchived: (next: string[]) => workspaces.publish({ archivedSessionIds: [...next] }),
    callsFor: (sessionId: string) => mocks.fetch.mock.calls
      .filter(call => String(call[0]).includes('/status') && call[1]?.params?.sessionId === sessionId)
      .length,
    subscribeCount: (sessionId: string) => subscribeCalls.get(sessionId) ?? 0,
    releaseStatus: () => {
      const release = releaseHeld
      releaseHeld = null
      release?.()
    },
  }
}

function bindingsFor(sessionIds: string[]): WorktreeBindings {
  return {
    bindings: sessionIds.map(sessionId => ({
      sessionId,
      sourceSessionId: `src-${sessionId}`,
      hash: 'h',
      dirname: 'd',
      worktreeKey: 'h/d',
      worktreePath: `C:/wt/${sessionId}`,
      projectPath: 'C:/repo',
      log: [],
    })),
    jobs: [],
  }
}

const WORKTREE_STATUS = { mode: 'worktree', worktreeKey: 'h/d', worktreePath: 'C:/wt', projectPath: 'C:/repo', log: [], isGit: true }
const LOCAL_STATUS = { mode: 'local', projectPath: 'C:/repo', isGit: true }

describe('registerWorktreeHydration 请求量', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.fetch.mockReset()
    store.worktree.$state.bySession = {}
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('首次加载：400 个会话只产生 1 次 /bindings（当前会话是工作树会话时 0 次 /status）', async () => {
    const ids = Array.from({ length: 400 }, (_, i) => `s-${i}`)
    const h = harness(() => WORKTREE_STATUS, ids, { bindings: bindingsFor(['s-0']) })
    await flushMicrotasks()

    expect(h.bindingsCalls()).toBe(1)
    expect(h.statusCalls()).toBe(0)
    h.dispose()
  })

  it('首次加载：当前会话是本地会话时 = 1 次 /bindings + 1 次 /status', async () => {
    const ids = Array.from({ length: 400 }, (_, i) => `s-${i}`)
    const h = harness(() => LOCAL_STATUS, ids)
    await flushMicrotasks()

    expect(h.bindingsCalls()).toBe(1)
    expect(h.statusCalls()).toBe(1)
    expect(h.callsFor('s-0')).toBe(1)
    h.dispose()
  })

  it('列表快照风暴（会话集合不变）不产生任何请求', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `s-${i}`)
    const h = harness(() => LOCAL_STATUS, ids, { bindings: bindingsFor(['s-0']) })
    await flushMicrotasks()
    const before = { bindings: h.bindingsCalls(), status: h.statusCalls() }

    for (let window = 0; window < 10; window++) {
      for (let i = 0; i < 500; i++) h.publishList()
      await vi.advanceTimersByTimeAsync(SESSION_RECONCILE_MIN_INTERVAL_MS)
    }
    expect(h.bindingsCalls()).toBe(before.bindings)
    expect(h.statusCalls()).toBe(before.status)
    h.dispose()
  })

  it('新增会话才触发一次 /bindings', async () => {
    const h = harness(() => LOCAL_STATUS, ['s-0'], { bindings: bindingsFor(['s-0']) })
    await flushMicrotasks()
    expect(h.bindingsCalls()).toBe(1)

    h.setSessionIds(['s-0', 's-1'])
    await vi.advanceTimersByTimeAsync(SESSION_RECONCILE_MIN_INTERVAL_MS)
    expect(h.bindingsCalls()).toBe(2)

    for (let i = 0; i < 50; i++) h.publishList()
    await vi.advanceTimersByTimeAsync(SESSION_RECONCILE_MIN_INTERVAL_MS * 3)
    expect(h.bindingsCalls()).toBe(2)
    h.dispose()
  })

  it('工作树会话：一个回合只在结束时复核一次（running true → false 边沿）', async () => {
    const h = harness(() => WORKTREE_STATUS, ['s-0'], { bindings: bindingsFor(['s-0']) })
    await flushMicrotasks()
    expect(h.statusCalls()).toBe(0)

    h.setRunning('s-0', true)
    for (let i = 0; i < 300; i++) h.emitSessionEvent('s-0')
    expect(h.statusCalls()).toBe(0)

    h.setRunning('s-0', false)
    expect(h.statusCalls()).toBe(1)

    for (let i = 0; i < 300; i++) h.emitSessionEvent('s-0')
    await vi.advanceTimersByTimeAsync(SESSION_RECONCILE_MIN_INTERVAL_MS * 3)
    expect(h.statusCalls()).toBe(1)

    h.setRunning('s-0', true)
    h.setRunning('s-0', false)
    await vi.advanceTimersByTimeAsync(SESSION_RECONCILE_MIN_INTERVAL_MS)
    expect(h.statusCalls()).toBe(2)
    h.dispose()
  })

  it('核心无 running 位时退回事件驱动 + 节流（功能不退化）', async () => {
    const h = harness(() => WORKTREE_STATUS, ['s-0'], { bindings: bindingsFor(['s-0']), runningBit: false })
    await flushMicrotasks()
    for (let i = 0; i < 500; i++) h.emitSessionEvent('s-0')
    expect(h.statusCalls()).toBe(1)
    await vi.advanceTimersByTimeAsync(SESSION_RECONCILE_MIN_INTERVAL_MS)
    expect(h.statusCalls()).toBe(2)
    await vi.advanceTimersByTimeAsync(SESSION_RECONCILE_MIN_INTERVAL_MS * 3)
    expect(h.statusCalls()).toBe(2)
    h.dispose()
  })

  it('本地会话的回合结束不触发复核（工具建的新会话由 /bindings 发现）', async () => {
    const h = harness(() => LOCAL_STATUS, ['s-0'], { bindings: bindingsFor([]) })
    await flushMicrotasks()
    expect(h.statusCalls()).toBe(1) // 当前会话校准

    h.setRunning('s-0', true)
    h.setRunning('s-0', false)
    await vi.advanceTimersByTimeAsync(SESSION_RECONCILE_MIN_INTERVAL_MS)
    expect(h.statusCalls()).toBe(1)
    h.dispose()
  })

  it('宿主解析不出的当前会话：重试有界、窗口后归零、无定时器残留', async () => {
    const h = harness(() => ({ mode: 'local', projectPath: '', isGit: null }), ['s-0'])
    await flushMicrotasks()
    expect(h.statusCalls()).toBe(1)

    for (let i = 0; i < 15; i++) {
      h.publishList()
      await vi.advanceTimersByTimeAsync(1000)
    }
    const afterWindow = h.statusCalls()
    expect(afterWindow).toBeLessThanOrEqual(1 + HYDRATION_RETRY_BUDGET_PER_SECOND * 10 + 5)

    for (let i = 0; i < 30; i++) {
      for (let n = 0; n < 100; n++) {
        h.publishList()
        h.emitSessionEvent('s-0')
      }
      await vi.advanceTimersByTimeAsync(1000)
    }
    expect(h.statusCalls()).toBe(afterWindow)
    expect(vi.getTimerCount()).toBe(0)
    h.dispose()
  })

  it('切回某会话时重新校准一次（放弃的会话可恢复）', async () => {
    const h = harness(() => ({ mode: 'local', projectPath: '', isGit: null }), ['s-0', 's-1'])
    await flushMicrotasks()
    expect(h.callsFor('s-0')).toBe(1)
    await vi.advanceTimersByTimeAsync(HYDRATION_RETRY_WINDOW_MS + 5_000)
    const settled = h.callsFor('s-0')

    h.setCurrent('s-1')
    await flushMicrotasks()
    h.setCurrent('s-0')
    await flushMicrotasks()
    expect(h.callsFor('s-0')).toBe(settled + 1)
    h.dispose()
  })

  it('同一会话只绑定一次事件订阅（binding() 每次返回新实例也不重复绑定）', async () => {
    const ids = ['s-0', 's-1', 's-2']
    const h = harness(() => WORKTREE_STATUS, ids, { bindings: bindingsFor(ids) })
    await flushMicrotasks()
    for (let i = 0; i < 200; i++) {
      h.publishList()
      await vi.advanceTimersByTimeAsync(10)
    }
    for (const id of ids)
      expect(h.subscribeCount(id)).toBe(1)
    h.dispose()
  })

  it('在途期间到达的复核经节流器：不会出现「上一次刚结束下一次立刻发」', async () => {
    const h = harness(() => WORKTREE_STATUS, ['s-0'], { bindings: bindingsFor(['s-0']), holdStatus: true })
    await flushMicrotasks()
    h.setRunning('s-0', true)
    h.setRunning('s-0', false)
    expect(h.statusCalls()).toBe(1)

    h.setRunning('s-0', true)
    h.setRunning('s-0', false)
    await vi.advanceTimersByTimeAsync(SESSION_RECONCILE_MIN_INTERVAL_MS)
    expect(h.statusCalls()).toBe(1)

    h.releaseStatus()
    await flushMicrotasks()
    expect(h.statusCalls()).toBe(1)

    await vi.advanceTimersByTimeAsync(SESSION_RECONCILE_MIN_INTERVAL_MS)
    expect(h.statusCalls()).toBe(2)
    h.releaseStatus()
    await flushMicrotasks()
    h.dispose()
  })

  it('归档会话完全不参与检测：即使批量绑定里持有工作树，也零请求', async () => {
    const archived = Array.from({ length: 30 }, (_, i) => `archived-${i}`)
    const ids = ['s-0', ...archived]
    const h = harness(() => LOCAL_STATUS, ids, { bindings: bindingsFor(archived), archived })
    await flushMicrotasks()
    for (let i = 0; i < 20; i++) h.publishWorkspaces()
    await vi.advanceTimersByTimeAsync(SESSION_RECONCILE_MIN_INTERVAL_MS * 3)

    expect(h.statusCalls()).toBe(1) // 只有当前会话 s-0 的 isGit 校准
    expect(h.discardCalls()).toBe(0) // 归档会话一次 discard 都没有
    expect(h.bindingsCalls()).toBe(1)
    h.dispose()
  })

  it('仅「本次归档且本端已知是工作树」发一次 discard，不轮询不重放', async () => {
    const h = harness(() => LOCAL_STATUS, ['s-0', 's-a'], { bindings: bindingsFor(['s-a']) })
    await flushMicrotasks()
    expect(h.discardCalls()).toBe(0)

    h.setArchived(['s-a'])
    await flushMicrotasks()
    expect(h.discardCalls()).toBe(1)
    const statusAfterArchive = h.statusCalls()

    for (let i = 0; i < 20; i++) h.publishWorkspaces()
    await vi.advanceTimersByTimeAsync(DISCARD_POLL_DELAY_MS * 10)
    expect(h.discardCalls()).toBe(1)
    expect(h.statusCalls()).toBe(statusAfterArchive)
    h.dispose()
  })

  it('dispose 取消待执行的拖尾复核', async () => {
    const h = harness(() => WORKTREE_STATUS, ['s-0'], { bindings: bindingsFor(['s-0']), runningBit: false })
    await flushMicrotasks()
    h.emitSessionEvent('s-0')
    expect(h.statusCalls()).toBe(1)
    for (let i = 0; i < 100; i++) h.emitSessionEvent('s-0')
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    h.dispose()
    await vi.advanceTimersByTimeAsync(SESSION_RECONCILE_MIN_INTERVAL_MS * 5)
    expect(h.statusCalls()).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
