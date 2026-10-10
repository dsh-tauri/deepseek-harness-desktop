/**
 * register/index.adapter.test.ts — DSH 升级迁移适配层的边界测试。
 *
 * 覆盖：modern / legacy 两种服务布局的世代探测与投影、方法 this 绑定与 list 引用稳定性、
 * Cordis inject 守卫抛错与属性回退、DOM 退级与「不可用」明确回报、`addWorkspace` 全流程与
 * 用户取消、自定义迁移的追加顺序、单条迁移失败不中断装配。
 *
 * 用例只用 `ctx.get` / `ctx[name]` 的返回形态构造上下文（与真实探测路径一致）；
 * DOM 依赖用 `vi.stubGlobal('document', …)` 提供最小假实现（仓库未装 jsdom）。
 */
import type { AdapterAddWorkspaceRuntime, AdapterRuntimeObject, ClientAdapter, DshMigration } from './index'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineAdapter } from './index'

/** 假 ObservableSnapshot（`list.subscribe` / `list.getSnapshot`）。 */
function makeList(snapshot: unknown = { ids: [] }): {
  getSnapshot: ReturnType<typeof vi.fn>
  subscribe: ReturnType<typeof vi.fn>
} {
  const listeners = new Set<() => void>()
  return {
    getSnapshot: vi.fn(() => snapshot),
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
  }
}

/** 只带 `ctx.get` 的最小客户端上下文（探测完全基于它的返回形态）。 */
function makeContext(services: Record<string, unknown>): unknown {
  return { get: (name: string) => services[name] }
}

/** 可变 ObservableSnapshot：测试里能主动 publish，验证投影的订阅扇出与引用稳定。 */
function makeLiveList<T>(initial: T): {
  getSnapshot: () => T
  subscribe: (listener: () => void) => () => void
  publish: (next: T) => void
} {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    publish: (next) => {
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/** 非空收窄（tsc / lint 友好的断言辅助，不用 `!`）。 */
function requireAddWorkspace(adapter: ClientAdapter): AdapterAddWorkspaceRuntime {
  const runtime = adapter.resolveAddWorkspace()
  if (runtime === undefined)
    throw new Error('resolveAddWorkspace returned undefined')
  return runtime
}

/** 每个用例一个安静告警出口：只记录，不打印。 */
function makeWarn() {
  return vi.fn<(message: string, error?: unknown) => void>()
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('defineAdapter — 世代探测与内置迁移', () => {
  it('modern 布局：sessions.list 即投影，导航与目录选择都在 workspaces', () => {
    const sessionsList = makeList()
    const workspacesList = makeList()
    const adapter = defineAdapter(makeContext({
      sessions: { list: sessionsList },
      workspaces: {
        list: workspacesList,
        create: vi.fn(),
        pickDirectory: vi.fn(),
        startSession: vi.fn(),
      },
    }))

    expect(adapter.generation).toBe('modern')
    // 工作区导航投影无条件安装、候选能力在调用期解析：判定「uiWorkspace 创建期在不在场」
    // 会让晚激活的服务永远接不上（issue #756），因此 modern 布局同样装上投影。
    expect(adapter.migrations).toContain('services:auto-bind')
    expect(adapter.migrations).toContain('sessions:list-projection')
    expect(adapter.migrations).toContain('legacy:workspaces-navigation')
    expect(adapter.migrations).not.toContain('sessions:provide-info-bridge')
    expect(adapter.migrations).toContain('navigation:resolve-start-session')
    expect(adapter.migrations).toContain('workspace:resolve-add-workspace')
    expect(adapter.failures).toEqual([])

    // 顶层别名是同一份 feed 的转发（老写法读 ctx.sessions.getSnapshot 也能用）
    expect(adapter.sessions.getSnapshot?.()).toEqual({ ids: [] })
    expect(adapter.sessions.list?.getSnapshot()).toEqual({ ids: [] })

    expect(adapter.has('sessions.list')).toBe(true)
    expect(adapter.has('workspaces.list')).toBe(true)
    expect(adapter.has('workspaces.create')).toBe(true)
    expect(adapter.has('navigation.startSession')).toBe(true)
    expect(adapter.has('navigation.addWorkspace')).toBe(true)
    // modern 的 sessions 面没有 legacy 的 per-session 查询，且无 uiSession 桥可用
    expect(adapter.has('sessions.provideInfo')).toBe(false)
  })

  it('legacy 布局：uiWorkspace 提供导航与目录选择，sessions 嵌套投影被补齐', () => {
    const snapshot = { ids: ['s1'] }
    const list = makeList(snapshot)
    const startSession = vi.fn()
    const connectWorkspace = vi.fn()
    const pickDirectory = vi.fn()
    const resolve = vi.fn(() => ({ props: { inputActions: { submit: true } } }))
    const adapter = defineAdapter(makeContext({
      sessions: { list, binding: vi.fn(() => ({})) },
      uiWorkspace: { startSession, connectWorkspace, pickDirectory },
      uiSession: { adapter: { resolve } },
    }))

    expect(adapter.generation).toBe('legacy')
    expect(adapter.migrations).toContain('sessions:list-projection')
    expect(adapter.migrations).toContain('sessions:provide-info-bridge')
    expect(adapter.migrations).toContain('legacy:workspaces-navigation')

    // 嵌套投影补齐成与新版同形的 getSnapshot / subscribe（订阅转发：核心列表发布即通知消费方）
    expect(adapter.sessions.getSnapshot?.()).toEqual(snapshot)
    const listener = vi.fn()
    adapter.sessions.subscribe?.(listener)
    expect(list.subscribe).toHaveBeenCalledTimes(1)
    list.subscribe.mock.calls[0]?.[0]?.()
    expect(listener).toHaveBeenCalledTimes(1)

    // per-session 信息：legacy 走 binding + uiSession.adapter.resolve 投影
    expect(adapter.has('sessions.provideInfo')).toBe(true)
    expect(adapter.sessions.provideInfo?.('s1')).toEqual({ props: { inputActions: { submit: true } } })
    expect(resolve).toHaveBeenCalledWith('s1')

    // 导航能力落到 uiWorkspace，且 this 必须绑回该服务
    adapter.workspaces.startSession?.('w1')
    expect(startSession).toHaveBeenCalledWith('w1')
    expect(startSession.mock.instances[0]).toMatchObject({ startSession })

    adapter.workspaces.connectWorkspace?.('w1')
    expect(connectWorkspace).toHaveBeenCalledWith('w1')

    adapter.resolveStartSession()?.('w2')
    expect(startSession).toHaveBeenCalledWith('w2')
  })

  it('工作区导航投影：创建期 uiWorkspace 尚未激活，服务到达后 connectWorkspace / startSession 照常可用', () => {
    const connectWorkspace = vi.fn(() => 's1')
    const startSession = vi.fn()
    const list = makeList()
    // `dsh-client-ui-workspace` 额外等 ui-session / connection，可能晚于 dsh-tauri-pet 创建：
    // 创建期读不到 uiWorkspace 是常态，投影的安装判据不能依赖它（issue #756）。
    const services: Record<string, unknown> = { sessions: { list }, workspaces: { list, create: vi.fn() } }
    const adapter = defineAdapter(makeContext(services))

    expect(adapter.migrations).toContain('legacy:workspaces-navigation')
    // 两个候选都没有该能力时诚实缺席，而不是给一个调用即崩的假投影
    expect(adapter.workspaces.connectWorkspace).toBeUndefined()
    expect(adapter.has('navigation.startSession')).toBe(false)
    expect(adapter.resolveStartSession()).toBeUndefined()
    expect(adapter.has('navigation.addWorkspace')).toBe(false)

    // uiWorkspace 稍后激活：投影在调用期重读服务，无需重建适配层
    services.uiWorkspace = { connectWorkspace, startSession, pickDirectory: vi.fn().mockResolvedValue('D:/work/demo') }
    expect(adapter.workspaces.connectWorkspace?.('w1')).toBe('s1')
    expect(connectWorkspace).toHaveBeenCalledWith('w1')
    expect(connectWorkspace.mock.instances[0]).toMatchObject({ connectWorkspace })

    expect(adapter.has('navigation.startSession')).toBe(true)
    adapter.resolveStartSession()?.('w2')
    expect(startSession).toHaveBeenCalledWith('w2')
    adapter.workspaces.startSession?.('w3')
    expect(startSession).toHaveBeenCalledWith('w3')
    expect(startSession.mock.instances[0]).toMatchObject({ startSession })

    // 目录选择是工作区侧原生实现：晚到的 uiWorkspace 也要能接上聚合出的 addWorkspace
    expect(adapter.has('navigation.addWorkspace')).toBe(true)
    expect(requireAddWorkspace(adapter).pickDirectory).toBeTypeOf('function')
  })

  it('provideInfo 桥原生优先：原生只覆盖部分会话时回退 binding + uiSession 投影', () => {
    const resolve = vi.fn(() => ({ props: { inputActions: { submit: true } } }))
    const adapter = defineAdapter(makeContext({
      sessions: {
        list: makeList(),
        // 原生实现只认 'native'：其余会话交给兼容桥
        provideInfo: vi.fn((sessionId: string) => (sessionId === 'native' ? { props: { native: true } } : undefined)),
        binding: vi.fn(() => ({})),
      },
      uiSession: { adapter: { resolve } },
    }))

    expect(adapter.migrations).toContain('sessions:provide-info-bridge')
    expect(adapter.sessions.provideInfo?.('native')).toEqual({ props: { native: true } })
    expect(resolve).not.toHaveBeenCalled()

    expect(adapter.sessions.provideInfo?.('s1')).toEqual({ props: { inputActions: { submit: true } } })
    expect(resolve).toHaveBeenCalledWith('s1')
  })

  it('uiWorkspace 只有目录选择时，导航回退到 workspaces 原生实现（不静默吞掉）', () => {
    const nativeStart = vi.fn()
    const pickDirectory = vi.fn().mockResolvedValue('D:/work/demo')
    const create = vi.fn().mockResolvedValue({ workspaceId: 'w1' })
    const adapter = defineAdapter(makeContext({
      uiWorkspace: { pickDirectory },
      workspaces: { startSession: nativeStart, create },
    }))

    expect(adapter.generation).toBe('legacy')
    // uiWorkspace 缺席 startSession，不该因此丢掉 workspaces 的原生导航
    expect(adapter.has('navigation.startSession')).toBe(true)
    adapter.resolveStartSession()?.('w1')
    expect(nativeStart).toHaveBeenCalledWith('w1')

    // 目录选择来自 uiWorkspace、建工作区/开会话来自 workspaces：混合宿主也能聚合
    const runtime = requireAddWorkspace(adapter)
    expect(runtime.pickDirectory).toBeTypeOf('function')
    expect(adapter.has('navigation.addWorkspace')).toBe(true)
  })

  it('官方服务方法绑定到原对象（解构后仍可用），list 投影引用稳定', () => {
    const list = makeList()
    const startSession = vi.fn()
    const adapter = defineAdapter(makeContext({
      sessions: { list, refresh: vi.fn() },
      workspaces: { list, startSession, create: vi.fn() },
    }))

    const { startSession: detached } = adapter.workspaces
    detached?.('w1')
    expect(startSession.mock.instances[0]).toMatchObject({ startSession })

    // uSES 快照比较依赖 list 引用稳定：同一服务多次读取必须是同一个投影
    expect(adapter.sessions.list).toBe(adapter.sessions.list)
    expect(adapter.workspaces.list).toBe(adapter.workspaces.list)
  })

  it('ctx 投影替换 sessions/workspaces，其余成员透传；服务缺失时返回空投影', () => {
    const list = makeList()
    const ctx: AdapterRuntimeObject = { sessions: { list }, marker: 'keep-me', get: () => undefined }
    const adapter = defineAdapter(ctx)

    expect((adapter.ctx as AdapterRuntimeObject).sessions).toBe(adapter.sessions)
    expect((adapter.ctx as AdapterRuntimeObject).workspaces).toBe(adapter.workspaces)
    expect((adapter.ctx as AdapterRuntimeObject).marker).toBe('keep-me')

    const bare = defineAdapter({ get: () => undefined })
    expect(bare.generation).toBe('unknown')
    expect(bare.has('sessions.list')).toBe(false)
    expect(bare.has('navigation.startSession')).toBe(false)
    expect(bare.sessions.getSnapshot).toBeUndefined()
  })

  it('ctx 是 undefined / 非对象 / inject 守卫抛错时都不抛，按服务缺失处理', () => {
    expect(() => defineAdapter(undefined)).not.toThrow()
    expect(() => defineAdapter(42)).not.toThrow()
    expect(defineAdapter(undefined).generation).toBe('unknown')

    // Cordis 对未声明键的 inject-only 守卫会抛错：探测必须吞掉并当作服务不存在
    const guarded = defineAdapter({
      get: (name: string) => {
        if (name === 'sessions')
          throw new Error('inject-only property')
        return name === 'uiWorkspace' ? { startSession: vi.fn() } : undefined
      },
    })
    expect(guarded.generation).toBe('legacy')
    expect(guarded.sessions.getSnapshot).toBeUndefined()
    expect(guarded.has('navigation.startSession')).toBe(true)

    // 没有 ctx.get 时回退属性读取（非 cordis 宿主的兼容路径）
    const list = makeList()
    const attribute = defineAdapter({ sessions: { list } })
    expect(attribute.generation).toBe('modern')
    expect(attribute.sessions.list).toBeDefined()
  })
})

describe('defineAdapter — 退级阶梯（官方服务 → DOM → 明确不可用）', () => {
  it('startSession：官方服务优先，thenable 才 await', async () => {
    const startSession = vi.fn().mockResolvedValue('ok')
    const adapter = defineAdapter(makeContext({ uiWorkspace: { startSession } }), { onWarn: makeWarn() })

    await expect(adapter.startSession('w1')).resolves.toEqual({ status: 'started', value: 'ok' })
    expect(startSession).toHaveBeenCalledWith('w1')

    // 同步返回值不做无意义等待：outcome 立刻可用
    const sync = vi.fn()
    const syncAdapter = defineAdapter(makeContext({ uiWorkspace: { startSession: sync } }), { onWarn: makeWarn() })
    await expect(syncAdapter.startSession()).resolves.toEqual({ status: 'started', value: undefined })
  })

  it('startSession：服务缺席时点官方按钮，按钮也缺席才回报不可用并告警', async () => {
    const click = vi.fn()
    vi.stubGlobal('document', { querySelector: vi.fn(() => ({ click })) })
    const delegated = defineAdapter(undefined, { onWarn: makeWarn() })
    expect(delegated.has('dom.newSession')).toBe(true)
    await expect(delegated.startSession()).resolves.toEqual({ status: 'delegated' })
    expect(click).toHaveBeenCalledTimes(1)

    vi.stubGlobal('document', { querySelector: vi.fn(() => null) })
    const warn = makeWarn()
    const unavailable = defineAdapter(undefined, { onWarn: warn })
    const outcome = await unavailable.startSession()
    expect(outcome.status).toBe('unavailable')
    expect(warn.mock.calls[0][0]).toContain('startSession unavailable')
  })

  it('composer.workspace-less：只认桌面壳补丁写在 <html> 上的能力标记', () => {
    vi.stubGlobal('document', { documentElement: { getAttribute: () => '1' } })
    expect(defineAdapter(undefined, { onWarn: makeWarn() }).has('composer.workspace-less')).toBe(true)

    vi.stubGlobal('document', { documentElement: { getAttribute: () => null } })
    expect(defineAdapter(undefined, { onWarn: makeWarn() }).has('composer.workspace-less')).toBe(false)
  })

  it('addWorkspace：官方三段能力全流程', async () => {
    const pickDirectory = vi.fn().mockResolvedValue('D:/work/demo')
    const create = vi.fn().mockResolvedValue({ workspaceId: 'w1' })
    const startSession = vi.fn()
    const adapter = defineAdapter(
      makeContext({ workspaces: { pickDirectory, create, startSession } }),
      { onWarn: makeWarn() },
    )

    await expect(adapter.addWorkspace()).resolves.toEqual({
      status: 'created',
      workspaceId: 'w1',
      path: 'D:/work/demo',
      sessionStarted: true,
    })
    expect(create).toHaveBeenCalledWith({ path: 'D:/work/demo' })
    expect(startSession).toHaveBeenCalledWith('w1')
    // 方法必须绑到各自的服务实例上
    expect(pickDirectory.mock.instances[0]).toMatchObject({ pickDirectory })
    expect(startSession.mock.instances[0]).toMatchObject({ startSession })
  })

  it('addWorkspace：用户取消是正常结果；openSession:false 不建会话', async () => {
    const create = vi.fn()
    const startSession = vi.fn()
    const cancelled = defineAdapter(
      makeContext({ workspaces: { pickDirectory: vi.fn().mockResolvedValue(null), create, startSession } }),
      { onWarn: makeWarn() },
    )
    await expect(cancelled.addWorkspace()).resolves.toEqual({ status: 'cancelled' })
    expect(create).not.toHaveBeenCalled()

    const adapter = defineAdapter(
      makeContext({
        workspaces: {
          pickDirectory: vi.fn().mockResolvedValue('D:/work/demo'),
          create: vi.fn().mockResolvedValue({ workspaceId: 'w1' }),
          startSession,
        },
      }),
      { onWarn: makeWarn() },
    )
    await expect(adapter.addWorkspace({ openSession: false })).resolves.toMatchObject({
      status: 'created',
      sessionStarted: false,
    })
    expect(startSession).not.toHaveBeenCalled()
  })

  it('addWorkspace：三段能力缺一时点官方按钮，按钮也缺席才回报不可用', async () => {
    // 缺 workspaces.create
    vi.stubGlobal('document', { querySelector: vi.fn(() => ({ click: vi.fn() })) })
    const delegated = defineAdapter(
      makeContext({ workspaces: { pickDirectory: vi.fn(), startSession: vi.fn() } }),
      { onWarn: makeWarn() },
    )
    expect(delegated.has('navigation.addWorkspace')).toBe(false)
    await expect(delegated.addWorkspace()).resolves.toEqual({ status: 'delegated' })

    vi.stubGlobal('document', { querySelector: vi.fn(() => null) })
    const warn = makeWarn()
    const unavailable = defineAdapter(undefined, { onWarn: warn })
    const outcome = await unavailable.addWorkspace()
    expect(outcome.status).toBe('unavailable')
    expect(warn.mock.calls[0][0]).toContain('addWorkspace unavailable')
  })
})

describe('defineAdapter — 迁移注册表', () => {
  it('自定义迁移在默认迁移之后执行，可覆盖既有投影', async () => {
    const custom = vi.fn()
    const migration: DshMigration = {
      id: 'test:custom-navigation',
      detect: () => true,
      apply(surface) {
        surface.startSession = () => custom()
      },
    }
    const adapter = defineAdapter(makeContext({ uiWorkspace: { startSession: vi.fn() } }), {
      migrations: [migration],
      onWarn: makeWarn(),
    })

    expect(adapter.migrations.at(-1)).toBe('test:custom-navigation')
    await adapter.startSession('w1')
    expect(custom).toHaveBeenCalledTimes(1)
  })

  it('detect 为 false 的迁移不执行、不记入 migrations', () => {
    const apply = vi.fn()
    const adapter = defineAdapter(undefined, {
      migrations: [{ id: 'test:skipped', detect: () => false, apply }],
      onWarn: makeWarn(),
    })

    expect(apply).not.toHaveBeenCalled()
    expect(adapter.migrations).not.toContain('test:skipped')
    expect(adapter.failures).toEqual([])
  })

  it('单条迁移失败只记录 failures 并告警，后续迁移与装配照常', () => {
    const late = vi.fn()
    const warn = makeWarn()
    const adapter = defineAdapter(undefined, {
      migrations: [
        {
          id: 'test:boom',
          detect: () => true,
          apply: () => {
            throw new Error('projection failed')
          },
        },
        { id: 'test:late', detect: () => true, apply: surface => void (surface.startSession = () => late()) },
      ],
      onWarn: warn,
    })

    expect(adapter.failures.map(failure => failure.migration)).toEqual(['test:boom'])
    expect(adapter.migrations).not.toContain('test:boom')
    expect(adapter.migrations).toContain('test:late')
    expect(warn.mock.calls[0][0]).toContain('test:boom')
    expect(adapter.has('navigation.startSession')).toBe(true)
  })
})

describe('defineAdapter — openSession 能力', () => {
  it('0.1.6-alpha.2 布局：导航落在 uiWorkspace.openSession', () => {
    const openSession = vi.fn()
    const adapter = defineAdapter(makeContext({
      sessions: { list: makeList() },
      workspaces: { list: makeList(), open: vi.fn() },
      uiWorkspace: { openSession },
    }))

    expect(adapter.migrations).toContain('navigation:resolve-open-session')
    expect(adapter.has('navigation.openSession')).toBe(true)
    expect(adapter.openSession('s-2').status).toBe('opened')
    expect(openSession).toHaveBeenCalledWith('s-2')
  })

  it('初始候选缺席时：workspaces.open 优先于 sessions.open', () => {
    const workspaceOpen = vi.fn()
    const sessionOpen = vi.fn()
    const adapter = defineAdapter(makeContext({
      sessions: { list: makeList(), open: sessionOpen },
      workspaces: { list: makeList(), open: workspaceOpen },
    }))

    adapter.openSession('s-3')
    expect(workspaceOpen).toHaveBeenCalledWith('s-3')
    expect(sessionOpen).not.toHaveBeenCalled()
  })

  it('旧核心：uiWorkspace 缺席时回退 sessions.open', () => {
    const open = vi.fn()
    const adapter = defineAdapter(makeContext({
      sessions: { list: makeList(), open },
    }))

    expect(adapter.resolveOpenSession()).toBeDefined()
    expect(adapter.openSession('s-4').status).toBe('opened')
    expect(open).toHaveBeenCalledWith('s-4')
  })

  it('能力全缺：明确回报 unavailable 并告警', () => {
    const warn = makeWarn()
    const adapter = defineAdapter(makeContext({ sessions: { list: makeList() } }), { onWarn: warn })

    expect(adapter.has('navigation.openSession')).toBe(false)
    expect(adapter.openSession('s-5').status).toBe('unavailable')
    expect(warn.mock.calls[0][0]).toContain('openSession unavailable')
  })
})

describe('defineAdapter — 0.1.6-alpha.2 会话面投影', () => {
  it('provideInfo：binding + uiSession.adapter.bindingSource 补出输入面', () => {
    const inputActions = { submit: vi.fn() }
    const binding = { sessionId: 's1' }
    const source = makeLiveList({ key: 's1', props: { inputActions } })
    const bindingSource = vi.fn(() => source)
    const adapter = defineAdapter(makeContext({
      sessions: { list: makeList(), binding: vi.fn(() => binding) },
      uiSession: { adapter: { bindingSource, current: makeLiveList({ key: 's1' }) } },
    }))

    expect(adapter.migrations).toContain('sessions:provide-info-bridge')
    expect(adapter.has('sessions.provideInfo')).toBe(true)
    expect(adapter.sessions.provideInfo?.('s1')).toEqual({ props: { inputActions } })
    expect(bindingSource).toHaveBeenCalledWith({ sessionId: 's1', binding })
  })

  it('provideInfo：未被保留（binding 缺席）的会话诚实回报不可用', () => {
    const bindingSource = vi.fn()
    const adapter = defineAdapter(makeContext({
      sessions: { list: makeList(), binding: vi.fn(() => undefined) },
      uiSession: { adapter: { bindingSource, current: makeLiveList({ key: undefined }) } },
    }))

    expect(adapter.sessions.provideInfo?.('s1')).toBeUndefined()
    expect(bindingSource).not.toHaveBeenCalled()
  })

  it('current 投影：核心快照缺 current 时由 uiSession.adapter.current 补齐', () => {
    const list = makeLiveList<Record<string, unknown>>({ ids: ['s1'], byId: {} })
    const current = makeLiveList<{ key?: string }>({ key: 's1' })
    const adapter = defineAdapter(makeContext({
      sessions: { list },
      uiSession: { adapter: { bindingSource: vi.fn(), current } },
    }))

    expect(adapter.migrations).toContain('sessions:current-projection')
    const projected = adapter.sessions.list
    expect(projected?.getSnapshot()).toEqual({ ids: ['s1'], byId: {}, current: 's1' })
    // uSES 依赖 getSnapshot 引用稳定：同一份核心快照 + 同一个 current 必须返回同一对象
    expect(projected?.getSnapshot()).toBe(projected?.getSnapshot())
    // list 投影本身也引用稳定（消费方按引用比较 / 作为订阅源）
    expect(adapter.sessions.list).toBe(projected)

    // 订阅扇出：核心列表变化与 current 变化都要通知消费方
    const listener = vi.fn()
    const off = projected?.subscribe(listener)
    list.publish({ ids: ['s1', 's2'], byId: {} })
    expect(listener).toHaveBeenCalledTimes(1)
    current.publish({ key: 's2' })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(projected?.getSnapshot()).toEqual({ ids: ['s1', 's2'], byId: {}, current: 's2' })
    off?.()
    current.publish({ key: 's3' })
    expect(listener).toHaveBeenCalledTimes(2)

    // 顶层别名与 list 同源：老写法读 sessions.getSnapshot 也拿到 current
    expect(adapter.sessions.getSnapshot?.()).toEqual({ ids: ['s1', 's2'], byId: {}, current: 's3' })
  })

  it('current 投影：创建期 uiSession 尚未激活，服务到达后仍补齐 current', () => {
    const list = makeLiveList<Record<string, unknown>>({ ids: ['s1'], byId: {} })
    const current = makeLiveList<{ key?: string }>({ key: undefined })
    // `dsh-tauri-ui` 只声明 sessions，会早于 ui-session 激活：创建期读不到 uiSession 是常态
    const services: Record<string, unknown> = { sessions: { list } }
    const adapter = defineAdapter(makeContext(services))

    expect(adapter.migrations).toContain('sessions:current-projection')
    const projected = adapter.sessions.list
    const currentOf = (): unknown => (projected?.getSnapshot() as { current?: unknown } | undefined)?.current
    expect(currentOf()).toBeUndefined()

    // ui-session 稍后激活：投影在调用期重读服务，无需重建适配层
    services.uiSession = { adapter: { bindingSource: vi.fn(), current } }
    current.publish({ key: 's1' })
    expect(currentOf()).toBe('s1')

    // 订阅侧同样自愈：源到达前订阅，到达后 current 变化仍要通知消费方
    const listener = vi.fn()
    const off = projected?.subscribe(listener)
    list.publish({ ids: ['s1', 's2'], byId: {} })
    expect(listener).toHaveBeenCalledTimes(1)
    current.publish({ key: 's2' })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(currentOf()).toBe('s2')
    off?.()
    current.publish({ key: 's3' })
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('provideInfo：创建期 uiSession 尚未激活，服务到达后桥照常解析', () => {
    const inputActions = { submit: vi.fn() }
    const binding = { sessionId: 's1' }
    const source = makeLiveList({ key: 's1', props: { inputActions } })
    const services: Record<string, unknown> = {
      sessions: { list: makeList(), binding: vi.fn(() => binding) },
    }
    const adapter = defineAdapter(makeContext(services))

    expect(adapter.migrations).toContain('sessions:provide-info-bridge')
    expect(adapter.has('sessions.provideInfo')).toBe(true)
    // 投影源未到达：诚实回报不可用，而不是抛错
    expect(adapter.sessions.provideInfo?.('s1')).toBeUndefined()

    const bindingSource = vi.fn(() => source)
    services.uiSession = { adapter: { bindingSource, current: makeLiveList({ key: 's1' }) } }
    expect(adapter.sessions.provideInfo?.('s1')).toEqual({ props: { inputActions } })
    expect(bindingSource).toHaveBeenCalledWith({ sessionId: 's1', binding })
  })

  it('current 投影：0.1.5 布局（核心自带 current）不装投影，原样保留', () => {
    const adapter = defineAdapter(makeContext({
      sessions: { list: makeList({ ids: ['s1'], current: 's1' }) },
      uiSession: { adapter: { current: makeList({ key: 's9' }) } },
    }))

    expect(adapter.migrations).not.toContain('sessions:current-projection')
    expect(adapter.sessions.list?.getSnapshot()).toEqual({ ids: ['s1'], current: 's1' })
  })

  it('open 桥：0.1.6 布局下 sessions.open 由 uiWorkspace.openSession 补齐', () => {
    const openSession = vi.fn()
    const adapter = defineAdapter(makeContext({
      sessions: { list: makeList() },
      uiWorkspace: { openSession },
    }))

    expect(adapter.migrations).toContain('sessions:open-bridge')
    adapter.sessions.open?.('s1')
    expect(openSession).toHaveBeenCalledWith('s1')
  })

  it('open 桥：创建期 uiWorkspace 尚未激活，服务到达后 sessions.open 照常切换', () => {
    const openSession = vi.fn()
    // `dsh-client-ui-workspace` 额外等 ui-session / connection，可能晚于本适配层创建：
    // 创建期读不到 uiWorkspace 是常态，桥的安装判据不能依赖它。
    const services: Record<string, unknown> = { sessions: { list: makeList() } }
    const adapter = defineAdapter(makeContext(services))

    expect(adapter.migrations).toContain('sessions:open-bridge')
    expect(adapter.has('navigation.openSession')).toBe(false)
    expect(adapter.openSession('s1').status).toBe('unavailable')

    services.uiWorkspace = { openSession }
    expect(adapter.has('navigation.openSession')).toBe(true)
    adapter.sessions.open?.('s1')
    expect(openSession).toHaveBeenCalledWith('s1')
    expect(adapter.openSession('s2').status).toBe('opened')
    expect(openSession).toHaveBeenCalledWith('s2')
  })

  it('open 桥：能力全缺时 sessions.open 明确抛错，不静默吞掉切换请求', () => {
    const adapter = defineAdapter(makeContext({ sessions: { list: makeList() } }))

    expect(adapter.migrations).toContain('sessions:open-bridge')
    expect(() => adapter.sessions.open?.('s1')).toThrow(/sessions\.open is unavailable/)
  })

  it('open 桥：桥装好后核心才补上原生 sessions.open，原生优先于桥', () => {
    const native = vi.fn()
    // 服务延迟物化：装桥时核心还没有 open，之后才补上。
    const sessions: Record<string, unknown> = { list: makeList() }
    const adapter = defineAdapter(makeContext({ sessions }))

    expect(adapter.migrations).toContain('sessions:open-bridge')
    expect(() => adapter.sessions.open?.('s1')).toThrow(/sessions\.open is unavailable/)

    sessions.open = native
    expect(adapter.has('navigation.openSession')).toBe(true)
    adapter.sessions.open?.('s2')
    expect(native).toHaveBeenCalledWith('s2')
  })

  it('open 桥：原生 sessions.open 在场时不覆盖', () => {
    const open = vi.fn()
    const openSession = vi.fn()
    const adapter = defineAdapter(makeContext({
      sessions: { list: makeList(), open },
      uiWorkspace: { openSession },
    }))

    expect(adapter.migrations).not.toContain('sessions:open-bridge')
    adapter.sessions.open?.('s1')
    expect(open).toHaveBeenCalledWith('s1')
    expect(openSession).not.toHaveBeenCalled()
  })
})

describe('defineAdapter — official session APIs', () => {
  it('create and catalog refresh capabilities bind only existing official methods', async () => {
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
    }
    const adapter = defineAdapter(makeContext({ sessions: owner }))
    expect(adapter.has('sessions.create')).toBe(true)
    expect(adapter.has('sessions.refresh')).toBe(true)
    await expect(adapter.sessions.create?.({ cwd: '/project' })).resolves.toBe('official-session')
    await adapter.sessions.refresh?.()
    expect(owner.refresh).toHaveBeenCalledOnce()
    const unavailable = defineAdapter(makeContext({ sessions: {} }))
    expect(unavailable.has('sessions.create')).toBe(false)
    expect(unavailable.has('sessions.refresh')).toBe(false)
  })

  it('projection refresh capability binds only the official existing method', async () => {
    const owner = {
      refreshProjections: vi.fn(function (this: object, id: string) {
        expect(this).toBe(owner)
        expect(id).toBe('session-a')
        return Promise.resolve()
      }),
    }
    const adapter = defineAdapter(makeContext({ sessions: owner }))
    expect(adapter.has('sessions.refreshProjections')).toBe(true)
    await adapter.sessions.refreshProjections?.('session-a')
    expect(owner.refreshProjections).toHaveBeenCalledOnce()
    expect(defineAdapter(makeContext({ sessions: {} })).has('sessions.refreshProjections')).toBe(false)
  })
})

describe('defineAdapter — sessionList 投影', () => {
  it('sessionList：过滤非字符串 id、只带字符串 current，subscribe 转发到核心列表', () => {
    const list = makeLiveList<{ ids: unknown[], current?: unknown }>({ ids: ['s1', 7, 's2', null], current: 's2' })
    const adapter = defineAdapter(makeContext({ sessions: { list } }))

    const projection = adapter.sessionList()
    expect(projection?.ids).toEqual(['s1', 's2'])
    expect(projection?.current).toBe('s2')

    const listener = vi.fn()
    const off = projection?.subscribe(listener)
    list.publish({ ids: ['s3'], current: 's3' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(adapter.sessionList()?.ids).toEqual(['s3'])
    expect(adapter.sessionList()?.current).toBe('s3')
    off?.()
    list.publish({ ids: ['s4'], current: 's4' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(adapter.sessionList()?.ids).toEqual(['s4'])
  })

  it('sessionList：快照非对象时按「无法判断」返回 undefined，ids 非数组时退化为空列表', () => {
    const nullSnapshot = makeLiveList<unknown>(null)
    expect(defineAdapter(makeContext({ sessions: { list: nullSnapshot } })).sessionList()).toBeUndefined()

    const stringIds = makeLiveList<unknown>({ ids: 's1' })
    expect(defineAdapter(makeContext({ sessions: { list: stringIds } })).sessionList())
      .toEqual({ ids: [], subscribe: expect.any(Function) })

    // current 只认字符串：非字符串一律当缺席，不猜一个结论
    const numericCurrent = makeLiveList<unknown>({ ids: ['s1'], current: 42 })
    expect(defineAdapter(makeContext({ sessions: { list: numericCurrent } })).sessionList())
      .toEqual({ ids: ['s1'], subscribe: expect.any(Function) })
  })

  it('sessionList：核心没有 list 投影时返回 undefined', () => {
    const adapter = defineAdapter(makeContext({ sessions: { getSnapshot: vi.fn() } }))

    expect(adapter.has('sessions.list')).toBe(false)
    expect(adapter.sessionList()).toBeUndefined()
  })
})
