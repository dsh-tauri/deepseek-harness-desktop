import type { AdapterAddWorkspaceRuntime, AdapterRuntimeObject, ClientAdapter, DshMigration } from './index'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineAdapter } from './index'

function makeList(snapshot: unknown = { ids: [] }) {
  const listeners = new Set<() => void>()
  return {
    getSnapshot: vi.fn(() => snapshot),
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
  }
}

function makeContext(services: Record<string, unknown>): unknown {
  return { get: (name: string) => services[name] }
}

function makeLiveList<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    publish: (next: T) => {
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

function requireAddWorkspace(adapter: ClientAdapter): AdapterAddWorkspaceRuntime {
  const runtime = adapter.resolveAddWorkspace()
  if (runtime === undefined)
    throw new Error('resolveAddWorkspace returned undefined')
  return runtime
}

function makeWarn() {
  return vi.fn<(message: string, error?: unknown) => void>()
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('defineAdapter — supported client services', () => {
  it('projects official session lists and uiWorkspace navigation without legacy migrations', () => {
    const sessionsList = makeList()
    const workspacesList = makeList()
    const adapter = defineAdapter(makeContext({
      sessions: { list: sessionsList },
      workspaces: { list: workspacesList, create: vi.fn() },
      uiWorkspace: { pickDirectory: vi.fn(), startSession: vi.fn() },
    }))

    expect(adapter.generation).toBe('modern')
    expect(adapter.migrations).toEqual([
      'services:auto-bind',
      'sessions:list-projection',
      'sessions:current-projection',
      'workspaces:navigation',
      'navigation:resolve-start-session',
      'sessions:open-bridge',
      'workspace:resolve-add-workspace',
    ])
    expect(adapter.failures).toEqual([])
    expect(adapter.sessions.getSnapshot?.()).toEqual({ ids: [] })
    expect(adapter.sessions.list?.getSnapshot()).toEqual({ ids: [] })
    expect(adapter.has('sessions.list')).toBe(true)
    expect(adapter.has('workspaces.list')).toBe(true)
    expect(adapter.has('workspaces.create')).toBe(true)
    expect(adapter.has('navigation.startSession')).toBe(true)
    expect(adapter.has('navigation.addWorkspace')).toBe(true)
    expect(adapter.has('sessions.provideInfo')).toBe(false)
  })

  it('binds navigation and bindingSource to their official owners', () => {
    const list = makeList({ ids: ['s1'] })
    const startSession = vi.fn()
    const connectWorkspace = vi.fn()
    const inputActions = { submit: true }
    const binding = { scope: 'retained' }
    const bindingSource = vi.fn(() => makeList({ props: { inputActions } }))
    const uiWorkspace = { startSession, connectWorkspace }
    const uiAdapter = { bindingSource }
    const adapter = defineAdapter(makeContext({
      sessions: { list, binding: vi.fn(() => binding) },
      uiWorkspace,
      uiSession: { adapter: uiAdapter },
    }))

    const listener = vi.fn()
    const off = adapter.sessions.subscribe?.(listener)
    expect(list.subscribe).toHaveBeenCalledOnce()
    list.subscribe.mock.calls[0]?.[0]?.()
    expect(listener).toHaveBeenCalledOnce()
    off?.()
    expect(adapter.sessions.provideInfo?.('s1')).toEqual({ props: { inputActions } })
    expect(bindingSource).toHaveBeenCalledWith({ sessionId: 's1', binding })
    expect(bindingSource.mock.instances[0]).toBe(uiAdapter)
    adapter.workspaces.startSession?.('w1')
    expect(startSession).toHaveBeenCalledWith('w1')
    expect(startSession.mock.instances[0]).toBe(uiWorkspace)
    adapter.workspaces.connectWorkspace?.('w1')
    expect(connectWorkspace).toHaveBeenCalledWith('w1')
    adapter.resolveStartSession()?.('w2')
    expect(startSession).toHaveBeenCalledWith('w2')
  })

  it('resolves late uiWorkspace navigation and directory selection without rebuilding the adapter', () => {
    const connectWorkspace = vi.fn(() => 's1')
    const startSession = vi.fn()
    const list = makeList()
    const services: Record<string, unknown> = { sessions: { list }, workspaces: { list, create: vi.fn() } }
    const adapter = defineAdapter(makeContext(services))
    expect(adapter.workspaces.connectWorkspace).toBeUndefined()
    expect(adapter.has('navigation.startSession')).toBe(false)
    expect(adapter.resolveStartSession()).toBeUndefined()
    expect(adapter.has('navigation.addWorkspace')).toBe(false)

    const uiWorkspace = { connectWorkspace, startSession, pickDirectory: vi.fn().mockResolvedValue('D:/work/demo') }
    services.uiWorkspace = uiWorkspace
    expect(adapter.workspaces.connectWorkspace?.('w1')).toBe('s1')
    expect(connectWorkspace.mock.instances[0]).toBe(uiWorkspace)
    expect(adapter.has('navigation.startSession')).toBe(true)
    adapter.resolveStartSession()?.('w2')
    expect(startSession).toHaveBeenCalledWith('w2')
    adapter.workspaces.startSession?.('w3')
    expect(startSession).toHaveBeenCalledWith('w3')
    expect(startSession.mock.instances[0]).toBe(uiWorkspace)
    expect(adapter.has('navigation.addWorkspace')).toBe(true)
    expect(requireAddWorkspace(adapter).pickDirectory).toBeTypeOf('function')
  })

  it('preserves native provideInfo results and falls back to bindingSource for missing or failed materialization', () => {
    const binding = {}
    const bindingSource = vi.fn(() => makeList({ props: { inputActions: { submit: true } } }))
    const provideInfo = vi.fn((id: string) => {
      if (id === 'failed')
        throw new Error('materializing')
      return id === 'native' ? { props: { native: true } } : undefined
    })
    const adapter = defineAdapter(makeContext({
      sessions: { list: makeList(), provideInfo, binding: vi.fn(() => binding) },
      uiSession: { adapter: { bindingSource } },
    }))
    expect(adapter.sessions.provideInfo?.('native')).toEqual({ props: { native: true } })
    expect(bindingSource).not.toHaveBeenCalled()
    expect(adapter.sessions.provideInfo?.('s1')).toEqual({ props: { inputActions: { submit: true } } })
    expect(bindingSource).toHaveBeenCalledWith({ sessionId: 's1', binding })
    expect(adapter.sessions.provideInfo?.('failed')).toEqual({ props: { inputActions: { submit: true } } })
  })

  it('does not advertise navigation or directory selection from removed workspaces APIs', () => {
    const nativeStart = vi.fn()
    const adapter = defineAdapter(makeContext({
      uiWorkspace: { pickDirectory: vi.fn() },
      workspaces: { startSession: nativeStart, create: vi.fn() },
    }))
    expect(adapter.generation).toBe('modern')
    expect(adapter.has('navigation.startSession')).toBe(false)
    expect(adapter.resolveStartSession()).toBeUndefined()
    expect(adapter.workspaces.startSession).toBeUndefined()
    expect(adapter.has('navigation.addWorkspace')).toBe(false)
    expect(nativeStart).not.toHaveBeenCalled()
    const misplacedPicker = defineAdapter(makeContext({
      workspaces: { pickDirectory: vi.fn(), create: vi.fn() },
      uiWorkspace: { startSession: vi.fn() },
    }))
    expect(misplacedPicker.has('navigation.addWorkspace')).toBe(false)
  })

  it('binds detached service methods to their original objects and stabilizes list references', () => {
    const list = makeList()
    const sessions = { list, refresh: vi.fn() }
    const uiWorkspace = { startSession: vi.fn() }
    const adapter = defineAdapter(makeContext({ sessions, workspaces: { list }, uiWorkspace }))
    const { refresh } = adapter.sessions
    refresh?.()
    expect(sessions.refresh.mock.instances[0]).toBe(sessions)
    const { startSession } = adapter.workspaces
    startSession?.('w1')
    expect(uiWorkspace.startSession.mock.instances[0]).toBe(uiWorkspace)
    expect(adapter.sessions.list).toBe(adapter.sessions.list)
    expect(adapter.workspaces.list).toBe(adapter.workspaces.list)
  })

  it('replaces projected context services, forwards unrelated members and tolerates missing services', () => {
    const ctx: AdapterRuntimeObject = { sessions: { list: makeList() }, marker: 'keep-me', get: () => undefined }
    const adapter = defineAdapter(ctx)
    expect(adapter.ctx.sessions).toBe(adapter.sessions)
    expect(adapter.ctx.workspaces).toBe(adapter.workspaces)
    expect(adapter.ctx.marker).toBe('keep-me')
    const bare = defineAdapter({ get: () => undefined })
    expect(bare.generation).toBe('unknown')
    expect(bare.has('sessions.list')).toBe(false)
    expect(bare.has('navigation.startSession')).toBe(false)
    expect(bare.sessions.getSnapshot).toBeUndefined()
  })

  it('treats invalid contexts and throwing inject guards as absent capabilities', () => {
    expect(defineAdapter(undefined).generation).toBe('unknown')
    expect(defineAdapter(42).generation).toBe('unknown')
    const guarded = defineAdapter({
      get: (name: string) => {
        if (name === 'sessions')
          throw new Error('inject-only property')
        return name === 'uiWorkspace' ? { startSession: vi.fn() } : undefined
      },
    })
    expect(guarded.generation).toBe('modern')
    expect(guarded.sessions.getSnapshot).toBeUndefined()
    expect(guarded.has('navigation.startSession')).toBe(true)
    const attribute = defineAdapter({ sessions: { list: makeList() } })
    expect(attribute.generation).toBe('modern')
    expect(attribute.has('sessions.list')).toBe(true)
  })
})

describe('defineAdapter — fallback ladder', () => {
  it('prefers official startSession and awaits only thenables', async () => {
    const startSession = vi.fn().mockResolvedValue('ok')
    const adapter = defineAdapter(makeContext({ uiWorkspace: { startSession } }), { onWarn: makeWarn() })
    await expect(adapter.startSession('w1')).resolves.toEqual({ status: 'started', value: 'ok' })
    expect(startSession).toHaveBeenCalledWith('w1')
    const sync = defineAdapter(makeContext({ uiWorkspace: { startSession: vi.fn() } }), { onWarn: makeWarn() })
    await expect(sync.startSession()).resolves.toEqual({ status: 'started', value: undefined })
  })

  it('delegates missing startSession to the official button or reports unavailable', async () => {
    const click = vi.fn()
    vi.stubGlobal('document', { querySelector: vi.fn(() => ({ click })) })
    const delegated = defineAdapter(undefined, { onWarn: makeWarn() })
    expect(delegated.has('dom.newSession')).toBe(true)
    await expect(delegated.startSession()).resolves.toEqual({ status: 'delegated' })
    expect(click).toHaveBeenCalledOnce()
    vi.stubGlobal('document', { querySelector: vi.fn(() => null) })
    const warn = makeWarn()
    const unavailable = defineAdapter(undefined, { onWarn: warn })
    expect((await unavailable.startSession()).status).toBe('unavailable')
    expect(warn.mock.calls[0][0]).toContain('startSession unavailable')
  })

  it('reads workspace-less composer support only from the desktop capability marker', () => {
    vi.stubGlobal('document', { documentElement: { getAttribute: () => '1' } })
    expect(defineAdapter(undefined).has('composer.workspace-less')).toBe(true)
    vi.stubGlobal('document', { documentElement: { getAttribute: () => null } })
    expect(defineAdapter(undefined).has('composer.workspace-less')).toBe(false)
  })

  it('adds a workspace through the official picker, registry and navigation owners', async () => {
    const pickDirectory = vi.fn().mockResolvedValue('D:/work/demo')
    const create = vi.fn().mockResolvedValue({ workspaceId: 'w1' })
    const startSession = vi.fn()
    const workspaces = { create }
    const uiWorkspace = { pickDirectory, startSession }
    const adapter = defineAdapter(makeContext({ workspaces, uiWorkspace }), { onWarn: makeWarn() })
    await expect(adapter.addWorkspace()).resolves.toEqual({ status: 'created', workspaceId: 'w1', path: 'D:/work/demo', sessionStarted: true })
    expect(create).toHaveBeenCalledWith({ path: 'D:/work/demo' })
    expect(create.mock.instances[0]).toBe(workspaces)
    expect(startSession).toHaveBeenCalledWith('w1')
    expect(pickDirectory.mock.instances[0]).toBe(uiWorkspace)
    expect(startSession.mock.instances[0]).toBe(uiWorkspace)
  })

  it('treats directory cancellation as normal and respects openSession:false', async () => {
    const create = vi.fn().mockResolvedValue({ workspaceId: 'w1' })
    const startSession = vi.fn()
    const cancelled = defineAdapter(makeContext({
      workspaces: { create },
      uiWorkspace: { pickDirectory: vi.fn().mockResolvedValue(null), startSession },
    }))
    await expect(cancelled.addWorkspace()).resolves.toEqual({ status: 'cancelled' })
    expect(create).not.toHaveBeenCalled()
    const adapter = defineAdapter(makeContext({
      workspaces: { create },
      uiWorkspace: { pickDirectory: vi.fn().mockResolvedValue('D:/work/demo'), startSession },
    }))
    await expect(adapter.addWorkspace({ openSession: false })).resolves.toEqual({ status: 'created', workspaceId: 'w1', path: 'D:/work/demo', sessionStarted: false })
    expect(startSession).not.toHaveBeenCalled()
  })

  it('delegates an incomplete addWorkspace capability or explicitly reports unavailable', async () => {
    const click = vi.fn()
    vi.stubGlobal('document', { querySelector: vi.fn(() => ({ click })) })
    const delegated = defineAdapter(makeContext({ uiWorkspace: { pickDirectory: vi.fn(), startSession: vi.fn() } }))
    expect(delegated.has('navigation.addWorkspace')).toBe(false)
    await expect(delegated.addWorkspace()).resolves.toEqual({ status: 'delegated' })
    expect(click).toHaveBeenCalledOnce()
    vi.stubGlobal('document', { querySelector: vi.fn(() => null) })
    const warn = makeWarn()
    const unavailable = defineAdapter(undefined, { onWarn: warn })
    expect((await unavailable.addWorkspace()).status).toBe('unavailable')
    expect(warn.mock.calls[0][0]).toContain('addWorkspace unavailable')
  })
})

describe('defineAdapter — migrations', () => {
  it('runs custom migrations last and allows explicit navigation projections', async () => {
    const custom = vi.fn()
    const open = vi.fn()
    const migration: DshMigration = {
      id: 'test:custom-navigation',
      detect: () => true,
      apply(surface) {
        surface.startSession = () => custom()
        surface.openSession = open
      },
    }
    const adapter = defineAdapter(undefined, { migrations: [migration], onWarn: makeWarn() })
    expect(adapter.migrations.at(-1)).toBe('test:custom-navigation')
    await adapter.startSession('w1')
    expect(custom).toHaveBeenCalledOnce()
    expect(adapter.openSession('s1').status).toBe('opened')
    expect(open).toHaveBeenCalledWith('s1')
  })

  it('does not apply or record a migration whose detection returns false', () => {
    const apply = vi.fn()
    const adapter = defineAdapter(undefined, { migrations: [{ id: 'test:skipped', detect: () => false, apply }], onWarn: makeWarn() })
    expect(apply).not.toHaveBeenCalled()
    expect(adapter.migrations).not.toContain('test:skipped')
    expect(adapter.failures).toEqual([])
  })

  it('records failed migrations and warnings while continuing subsequent migrations', () => {
    const late = vi.fn()
    const warn = makeWarn()
    const error = new Error('projection failed')
    const adapter = defineAdapter(undefined, {
      migrations: [
        { id: 'test:boom', detect: () => true, apply: () => { throw error } },
        { id: 'test:late', detect: () => true, apply: surface => void (surface.startSession = () => late()) },
      ],
      onWarn: warn,
    })
    expect(adapter.failures).toEqual([{ migration: 'test:boom', error }])
    expect(adapter.migrations).not.toContain('test:boom')
    expect(adapter.migrations).toContain('test:late')
    expect(warn.mock.calls[0][0]).toContain('test:boom')
    expect(adapter.has('navigation.startSession')).toBe(true)
  })
})

describe('defineAdapter — session navigation and projections', () => {
  it('opens sessions through uiWorkspace rather than removed core navigation methods', () => {
    const openSession = vi.fn()
    const oldOpen = vi.fn()
    const adapter = defineAdapter(makeContext({
      sessions: { list: makeList(), open: oldOpen },
      workspaces: { open: oldOpen },
      uiWorkspace: { openSession },
    }))
    expect(adapter.has('navigation.openSession')).toBe(true)
    expect(adapter.openSession('s2').status).toBe('opened')
    adapter.sessions.open?.('s1')
    expect(openSession).toHaveBeenCalledWith('s1')
    expect(openSession).toHaveBeenCalledWith('s2')
    expect(oldOpen).not.toHaveBeenCalled()
  })

  it('does not mistake removed sessions.open or workspaces.open for supported navigation', () => {
    const oldOpen = vi.fn()
    const warn = makeWarn()
    const adapter = defineAdapter(makeContext({ sessions: { open: oldOpen }, workspaces: { open: oldOpen } }), { onWarn: warn })
    expect(adapter.resolveOpenSession()).toBeUndefined()
    expect(adapter.has('navigation.openSession')).toBe(false)
    expect(adapter.openSession('s1')).toEqual({ status: 'unavailable', reason: 'no uiWorkspace.openSession capability' })
    expect(() => adapter.sessions.open?.('s1')).toThrow('sessions.open is unavailable')
    expect(oldOpen).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledOnce()
  })

  it('resolves late uiWorkspace arrival and rejects calls after its capability disappears', () => {
    const services: Record<string, unknown> = { sessions: { list: makeList() } }
    const adapter = defineAdapter(makeContext(services), { onWarn: makeWarn() })
    expect(adapter.has('navigation.openSession')).toBe(false)
    expect(adapter.openSession('s1').status).toBe('unavailable')
    const uiWorkspace = { openSession: vi.fn() }
    services.uiWorkspace = uiWorkspace
    expect(adapter.has('navigation.openSession')).toBe(true)
    adapter.sessions.open?.('s1')
    expect(uiWorkspace.openSession).toHaveBeenCalledWith('s1')
    expect(uiWorkspace.openSession.mock.instances[0]).toBe(uiWorkspace)
    services.uiWorkspace = undefined
    expect(adapter.has('navigation.openSession')).toBe(false)
    expect(() => adapter.sessions.open?.('s2')).toThrow('sessions.open is unavailable')
  })

  it('projects bindingSource input actions through the retained session reference', () => {
    const inputActions = { submit: vi.fn() }
    const binding = { sessionId: 's1' }
    const bindingSource = vi.fn(() => makeLiveList({ key: 's1', props: { inputActions } }))
    const adapter = defineAdapter(makeContext({
      sessions: { list: makeList(), binding: vi.fn(() => binding) },
      uiSession: { adapter: { bindingSource } },
    }))
    expect(adapter.has('sessions.provideInfo')).toBe(true)
    expect(adapter.sessions.provideInfo?.('s1')).toEqual({ props: { inputActions } })
    expect(bindingSource).toHaveBeenCalledWith({ sessionId: 's1', binding })
  })

  it('does not revive the removed uiSession.adapter.resolve API', () => {
    const resolve = vi.fn(() => ({ props: { inputActions: {} } }))
    const adapter = defineAdapter(makeContext({ sessions: { binding: vi.fn(() => ({})) }, uiSession: { adapter: { resolve } } }))
    expect(adapter.sessions.provideInfo?.('s1')).toBeUndefined()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('returns unavailable for unretained sessions and transient binding failures', () => {
    const bindingSource = vi.fn()
    const binding = vi.fn(() => undefined)
    const adapter = defineAdapter(makeContext({ sessions: { binding }, uiSession: { adapter: { bindingSource } } }))
    expect(adapter.sessions.provideInfo?.('s1')).toBeUndefined()
    binding.mockImplementationOnce(() => {
      throw new Error('released')
    })
    expect(adapter.sessions.provideInfo?.('s1')).toBeUndefined()
    expect(bindingSource).not.toHaveBeenCalled()
  })

  it('keeps current projection snapshots stable and fans out subscriptions with disposal', () => {
    const list = makeLiveList<Record<string, unknown>>({ ids: ['s1'], byId: {} })
    const current = makeLiveList<{ key?: string }>({ key: 's1' })
    const adapter = defineAdapter(makeContext({ sessions: { list }, uiSession: { adapter: { current } } }))
    const projected = adapter.sessions.list
    expect(projected?.getSnapshot()).toEqual({ ids: ['s1'], byId: {}, current: 's1' })
    expect(projected?.getSnapshot()).toBe(projected?.getSnapshot())
    expect(adapter.sessions.list).toBe(projected)
    const listener = vi.fn()
    const off = projected?.subscribe(listener)
    list.publish({ ids: ['s1', 's2'], byId: {} })
    expect(listener).toHaveBeenCalledTimes(1)
    current.publish({ key: 's2' })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(projected?.getSnapshot()).toEqual({ ids: ['s1', 's2'], byId: {}, current: 's2' })
    off?.()
    current.publish({ key: 's3' })
    list.publish({ ids: ['s3'] })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(adapter.sessions.getSnapshot?.()).toEqual({ ids: ['s3'], current: 's3' })
  })

  it('follows late uiSession current sources and replaces subscriptions when their owner changes', () => {
    const list = makeLiveList({ ids: ['s1'] })
    const services: Record<string, unknown> = { sessions: { list } }
    const adapter = defineAdapter(makeContext(services))
    const projected = adapter.sessions.list
    expect(projected?.getSnapshot()).toEqual({ ids: ['s1'] })
    const listener = vi.fn()
    const off = projected?.subscribe(listener)
    const current = makeLiveList({ key: 's1' })
    services.uiSession = { adapter: { current } }
    list.publish({ ids: ['s1', 's2'] })
    current.publish({ key: 's2' })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(projected?.getSnapshot()).toEqual({ ids: ['s1', 's2'], current: 's2' })
    const replacement = makeLiveList({ key: 's3' })
    services.uiSession = { adapter: { current: replacement } }
    list.publish({ ids: ['s3'] })
    current.publish({ key: 'obsolete' })
    expect(listener).toHaveBeenCalledTimes(3)
    replacement.publish({ key: 's4' })
    expect(listener).toHaveBeenCalledTimes(4)
    off?.()
    replacement.publish({ key: 's5' })
    expect(listener).toHaveBeenCalledTimes(4)
  })

  it('resolves late uiSession binding sources without rebuilding the adapter', () => {
    const inputActions = { submit: vi.fn() }
    const binding = { sessionId: 's1' }
    const services: Record<string, unknown> = { sessions: { binding: vi.fn(() => binding) } }
    const adapter = defineAdapter(makeContext(services))
    expect(adapter.sessions.provideInfo?.('s1')).toBeUndefined()
    const bindingSource = vi.fn(() => makeLiveList({ props: { inputActions } }))
    services.uiSession = { adapter: { bindingSource } }
    expect(adapter.sessions.provideInfo?.('s1')).toEqual({ props: { inputActions } })
    expect(bindingSource).toHaveBeenCalledWith({ sessionId: 's1', binding })
  })
})

describe('defineAdapter — official session APIs', () => {
  it('binds existing official create, refresh and refreshProjections methods', async () => {
    const owner = {
      create: vi.fn(function (this: object, input?: unknown) {
        expect(this).toBe(owner)
        expect(input).toEqual({ cwd: '/project' })
        return Promise.resolve('official-session')
      }),
      refresh: vi.fn(function (this: object) {
        expect(this).toBe(owner)
        return Promise.resolve()
      }),
      refreshProjections: vi.fn(function (this: object, id: string) {
        expect(this).toBe(owner)
        expect(id).toBe('session-a')
        return Promise.resolve()
      }),
    }
    const adapter = defineAdapter(makeContext({ sessions: owner }))
    expect(adapter.has('sessions.create')).toBe(true)
    expect(adapter.has('sessions.refresh')).toBe(true)
    expect(adapter.has('sessions.refreshProjections')).toBe(true)
    await expect(adapter.sessions.create?.({ cwd: '/project' })).resolves.toBe('official-session')
    await adapter.sessions.refresh?.()
    await adapter.sessions.refreshProjections?.('session-a')
    expect(owner.refresh).toHaveBeenCalledOnce()
    expect(owner.refreshProjections).toHaveBeenCalledOnce()
    const unavailable = defineAdapter(makeContext({ sessions: {} }))
    expect(unavailable.has('sessions.create')).toBe(false)
    expect(unavailable.has('sessions.refresh')).toBe(false)
    expect(unavailable.has('sessions.refreshProjections')).toBe(false)
  })

  it('filters invalid ids and reads selected sessions from uiSession rather than the core catalog', () => {
    const list = makeLiveList({ ids: ['s1', 7, 's2', null] })
    const current = makeLiveList({ key: 's2' })
    const adapter = defineAdapter(makeContext({ sessions: { list }, uiSession: { adapter: { current } } }))
    const projection = adapter.sessionList()
    expect(projection?.ids).toEqual(['s1', 's2'])
    expect(projection?.current).toBe('s2')
    const listener = vi.fn()
    const off = projection?.subscribe(listener)
    current.publish({ key: 's3' })
    list.publish({ ids: ['s3'] })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(adapter.sessionList()?.ids).toEqual(['s3'])
    expect(adapter.sessionList()?.current).toBe('s3')
    off?.()
    list.publish({ ids: ['s4'] })
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('treats invalid catalog snapshots and nonstring current keys as unprovable state', () => {
    expect(defineAdapter(makeContext({ sessions: { list: makeList(null) } })).sessionList()).toBeUndefined()
    expect(defineAdapter(makeContext({ sessions: { list: makeList({ ids: 's1' }) } })).sessionList()).toEqual({ ids: [], subscribe: expect.any(Function) })
    const numeric = defineAdapter(makeContext({ sessions: { list: makeList({ ids: ['s1'] }) }, uiSession: { adapter: { current: makeList({ key: 42 }) } } }))
    expect(numeric.sessionList()).toEqual({ ids: ['s1'], subscribe: expect.any(Function) })
    const unavailable = defineAdapter(makeContext({ sessions: { getSnapshot: vi.fn() } }))
    expect(unavailable.has('sessions.list')).toBe(false)
    expect(unavailable.sessionList()).toBeUndefined()
  })
})
