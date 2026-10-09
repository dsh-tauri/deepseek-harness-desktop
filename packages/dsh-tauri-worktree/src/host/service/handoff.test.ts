import type { Agent, AgentSetupCommit } from '@deepseek-ai/dsh-agent'
import type { NativeSessionBridge } from 'dsh-tauri'
import type { Binding, PendingHandoff } from '../types'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pendingWorktreeTitles, resetRuntime } from '../config/runtime'
import { server } from '../server'
import { checkoutContext } from './checkout-context'
import { handoff } from './handoff'
import { worktree } from './worktree'

const disposers: Array<() => void> = []

function disposeServers(): void {
  for (const dispose of disposers.splice(0))
    dispose()
}

vi.mock('dsh-tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('dsh-tauri')>()
  const { testDshHome: home } = await import('../../../../.test/test-utils')
  return { ...actual, DSH_HOME: home }
})

/** 源会话只有策略/生命周期事件，没有人类消息（工作树模式发送首条消息的形态）。 */
const emptyEvents = [
  { type: 'permission/preset', seq: 0, time: 1, data: { preset: 'danger-full-access' } },
  { type: 'sandbox/mode', seq: 1, time: 2, data: { mode: 'danger-full-access' } },
  { type: 'approval/policy', seq: 2, time: 3, data: { policy: 'never' } },
]

/** 源会话已有对话（会话中途换到工作树的形态）。 */
const conversationEvents = [
  { type: 'user/message', seq: 0, time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } },
  { type: 'turn/end', seq: 1, time: 2, data: { reason: { kind: 'completed' } } },
]

function sourceAgent(events: readonly unknown[] = conversationEvents): unknown {
  return {
    session: {
      id: 'session-source',
      header: { agentPreset: 'default' },
      snapshotEvents: () => events,
    },
  }
}

interface SetupOptions {
  session?: unknown
  warn?: (message: string) => void
  create?: (options: any) => Promise<unknown>
  presets?: unknown
  sourceContext?: unknown
  getAgent?: (id: string) => unknown
  bridge?: NativeSessionBridge
  projections?: unknown
  workspace?: unknown
  storedSession?: unknown
}

function setup(options: SetupOptions = {}): { created: any[] } {
  const created: any[] = []
  disposers.push(server({
    agents: {
      get: options.getAgent ?? ((id: string) => (id === 'session-source'
        ? { session: options.session ?? (sourceAgent() as any).session, ctx: options.sourceContext ?? {}, options: {} }
        : undefined)),
      create: async (value: any) => {
        created.push(value)
        return options.create?.(value)
      },
    },
    get: (key: string) => key === 'agentPresets' ? options.presets : key === 'nativeSessionBridge' ? options.bridge : key === 'sessionProjections' ? options.projections : undefined,
    workspaceRegistry: { resolveByPath: async () => options.workspace },
    sessions: { get: (id: string) => id === 'session-source' ? options.storedSession : undefined, list: () => [] },
    logger: { warn: options.warn ?? (() => {}) },
    webServer: { register: () => () => {} },
  } as never))
  return { created }
}

function sessionOf(events: readonly unknown[]): unknown {
  return { id: 'session-source', header: { agentPreset: 'default' }, snapshotEvents: () => events }
}

afterEach(() => {
  disposeServers()
  resetRuntime()
  vi.restoreAllMocks()
})

describe('handoff.inherit', () => {
  it('composes the source preset without returning its id as an agent setup commit', async () => {
    const sourceContext = { preset: 'source' }
    const targetContext = { preset: 'target' }
    const composeFrom = vi.fn(() => 'composed')
    const composedPreset = vi.fn(() => 'composed')
    const { created } = setup({
      sourceContext,
      presets: { composedPreset, composeFrom },
      create: async (options) => {
        (await options.setup?.(targetContext, { ctx: targetContext }))?.commit()
      },
    })

    expect(await handoff.inherit('session-source', 'session-target', 'C:/worktrees/w1')).toEqual({
      ok: true,
      targetSessionId: 'session-target',
      seedLength: 2,
    })
    expect(created).toHaveLength(1)
    expect(created[0].meta).toEqual({
      cwd: 'C:/worktrees/w1',
      parentSession: 'session-source',
      isSeeded: true,
      agentPreset: 'composed',
    })
    expect(composedPreset).toHaveBeenCalledExactlyOnceWith(sourceContext)
    expect(composeFrom).toHaveBeenCalledExactlyOnceWith(targetContext, sourceContext)
  })

  it('awaits bridge preparation and returns its exact commit to the official factory before publication', async () => {
    const targetContext = new Context()
    try {
      const sessions = new SessionStore(targetContext)
      const source = Session.create(SessionId('session-source'))
      source.append('user/message', { id: MessageId('message-source'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'source history' }] }, { surfaceOp: 'append' })
      const sourceContext = { preset: 'source' }
      const order: string[] = []
      const entered = Promise.withResolvers<void>()
      const ack = Promise.withResolvers<void>()
      const commit: AgentSetupCommit = { commit: vi.fn(() => order.push('commit')) }
      let target: Agent | undefined
      let nativeSignal: AbortSignal | undefined
      const create = vi.fn<NativeSessionBridge['create']>(async (_source, createChild) => {
        order.push('lock')
        const handle = await createChild()
        order.push('unlock')
        return handle
      })
      const prepare = vi.fn<NativeSessionBridge['prepare']>(async (forkSource, agent, signal) => {
        expect(forkSource).toBe(source)
        expect(agent.ctx).toBe(targetContext)
        expect(agent.session.header).toMatchObject({ cwd: resolve('worktrees/w1'), parentSession: 'session-source', isSeeded: true })
        expect(agent.session.inheritedEventCount).toBe(1)
        nativeSignal = signal
        order.push('prepare')
        entered.resolve()
        await ack.promise
        signal.throwIfAborted()
        order.push('ack')
        return commit
      })
      const { created } = setup({
        session: source,
        sourceContext,
        bridge: { create, prepare },
        presets: { composedPreset: () => 'default', composeFrom: vi.fn(() => order.push('compose')) },
        create: async (options) => {
          const session = sessions.prepare(SessionId(options.sessionId), options)
          target = { id: session.id, session, ctx: targetContext } as Agent
          const returned = await options.setup(targetContext, target)
          expect(returned).toBe(commit)
          expect(commit.commit).not.toHaveBeenCalled()
          returned.commit()
          order.push('durable')
          order.push('publish')
          return { agent: target }
        },
      })
      const pending = handoff.inherit('session-source', 'session-target', resolve('worktrees/w1'))
      await Promise.race([entered.promise, pending.then((result) => {
        throw new Error(`Bridge setup was bypassed: ${JSON.stringify(result)}`)
      })])
      expect(order).toEqual(['lock', 'compose', 'prepare'])
      expect(commit.commit).not.toHaveBeenCalled()
      expect(nativeSignal?.aborted).toBe(false)
      expect(pendingWorktreeTitles.size).toBe(0)
      ack.resolve()
      expect(await pending).toEqual({ ok: true, targetSessionId: 'session-target', seedLength: 1 })
      expect(created).toHaveLength(1)
      expect(create).toHaveBeenCalledExactlyOnceWith(source, expect.any(Function))
      expect(prepare).toHaveBeenCalledExactlyOnceWith(source, target, nativeSignal)
      expect(order).toEqual(['lock', 'compose', 'prepare', 'ack', 'commit', 'durable', 'publish', 'unlock'])
      expect(commit.commit).toHaveBeenCalledTimes(1)
    }
    finally {
      await targetContext.fiber.dispose()
    }
  })

  it('forwards the exact bridge factory signal and prepares with the scoped cancellation signal', async () => {
    const context = new Context()
    try {
      const sessions = new SessionStore(context)
      const source = Session.create(SessionId('session-source'))
      source.append('turn/start', { turn: 0 })
      const lifetime = new AbortController()
      const commit = vi.fn()
      let preparingSignal: AbortSignal | undefined
      const { created } = setup({
        session: source,
        bridge: {
          create: async (_source, createChild) => createChild(lifetime.signal),
          prepare: async (_source, _agent, signal) => {
            preparingSignal = signal
            return { commit }
          },
        },
        create: async (options) => {
          expect(options.signal).toBe(lifetime.signal)
          const session = sessions.prepare(SessionId(options.sessionId), options)
          const agent = { id: session.id, session, ctx: context } as Agent
          const prepared = await options.setup(context, agent)
          prepared.commit()
          return { agent }
        },
      })
      expect(await handoff.inherit('session-source', 'session-target', 'C:/work')).toEqual({ ok: true, targetSessionId: 'session-target', seedLength: 1 })
      expect(created).toHaveLength(1)
      expect(created[0].signal).toBe(lifetime.signal)
      expect(preparingSignal).toBeInstanceOf(AbortSignal)
      expect(preparingSignal).not.toBe(lifetime.signal)
      expect(preparingSignal?.aborted).toBe(false)
      expect(commit).toHaveBeenCalledTimes(1)
    }
    finally {
      await context.fiber.dispose()
    }
  })

  it('rejects an already aborted bridge factory signal before reading or creating the child', async () => {
    const source = Session.create(SessionId('session-source'))
    source.append('turn/start', { turn: 0 })
    const snapshot = vi.spyOn(source, 'snapshotEvents')
    const lifetime = new AbortController()
    lifetime.abort(new Error('BRIDGE_DISPOSED: The bridge creation lifetime ended'))
    const prepare = vi.fn<NativeSessionBridge['prepare']>(async () => {})
    const { created } = setup({
      session: source,
      bridge: { create: async (_source, createChild) => createChild(lifetime.signal), prepare },
    })
    expect(await handoff.inherit('session-source', 'session-target', 'C:/work')).toEqual({ ok: false, error: 'BRIDGE_DISPOSED: The bridge creation lifetime ended' })
    expect(snapshot).not.toHaveBeenCalled()
    expect(created).toHaveLength(0)
    expect(prepare).not.toHaveBeenCalled()
    expect(pendingWorktreeTitles.size).toBe(0)
  })

  it('rejects a late native ACK after the captured bridge lifetime aborts without committing or publishing', async () => {
    const context = new Context()
    try {
      const sessions = new SessionStore(context)
      const source = Session.create(SessionId('session-source'))
      source.append('turn/start', { turn: 0 })
      const maintenance = new AbortController()
      const lifetime = new AbortController()
      const factorySignal = AbortSignal.any([maintenance.signal, lifetime.signal])
      const entered = Promise.withResolvers<void>()
      const ack = Promise.withResolvers<void>()
      const commit = vi.fn()
      const published = vi.fn()
      const reason = new Error('BRIDGE_DISPOSED: The captured bridge was unloaded')
      let preparingSignal: AbortSignal | undefined
      const { created } = setup({
        session: source,
        bridge: {
          create: async (_source, createChild) => createChild(factorySignal),
          prepare: async (_source, _agent, signal) => {
            preparingSignal = signal
            entered.resolve()
            await ack.promise
            return { commit }
          },
        },
        create: async (options) => {
          expect(options.signal).toBe(factorySignal)
          const session = sessions.prepare(SessionId(options.sessionId), options)
          const agent = { id: session.id, session, ctx: context } as Agent
          const prepared = await options.setup(context, agent)
          prepared.commit()
          published()
          return { agent }
        },
      })
      const pending = handoff.inherit('session-source', 'session-target', 'C:/work')
      await Promise.race([entered.promise, pending.then((result) => {
        throw new Error(`Native preparation was bypassed: ${JSON.stringify(result)}`)
      })])
      expect(preparingSignal?.aborted).toBe(false)
      lifetime.abort(reason)
      expect(factorySignal.aborted).toBe(true)
      expect(preparingSignal?.aborted).toBe(true)
      expect(preparingSignal?.reason).toBe(reason)
      expect(() => context.fiber.assertActive()).not.toThrow()
      ack.resolve()
      expect(await pending).toEqual({ ok: false, error: reason.message })
      expect(created).toHaveLength(1)
      expect(created[0].signal).toBe(factorySignal)
      expect(commit).not.toHaveBeenCalled()
      expect(published).not.toHaveBeenCalled()
      expect(pendingWorktreeTitles.size).toBe(0)
    }
    finally {
      await context.fiber.dispose()
    }
  })

  it('captures the latest source prefix inside the bridge creation lock instead of using the offered snapshot', async () => {
    const context = new Context()
    try {
      const sessions = new SessionStore(context)
      const source = Session.create(SessionId('session-source'))
      source.append('turn/start', { turn: 0 })
      const snapshot = vi.spyOn(source, 'snapshotEvents')
      const bridge: NativeSessionBridge = {
        create: vi.fn(async (_source, createChild) => {
          expect(snapshot).not.toHaveBeenCalled()
          source.append('user/message', { id: MessageId('message-late'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'arrived before the fork lock' }] }, { surfaceOp: 'append' })
          source.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
          return createChild()
        }),
        prepare: vi.fn(async () => {}),
      }
      const { created } = setup({
        session: source,
        bridge,
        create: async (options) => {
          const target = sessions.prepare(SessionId(options.sessionId), options)
          const agent = { id: target.id, session: target, ctx: context } as Agent
          const commit = await options.setup(context, agent)
          commit?.commit()
          return { agent }
        },
      })
      expect(await handoff.inherit('session-source', 'session-target', resolve('worktrees/w1'))).toEqual({ ok: true, targetSessionId: 'session-target', seedLength: 3 })
      expect(created).toHaveLength(1)
      expect(snapshot).toHaveBeenCalledTimes(1)
      expect(created[0].seed).toEqual(source.snapshotEvents())
      expect(created[0].inheritedEventCount).toBe(3)
      expect(pendingWorktreeTitles.size).toBe(0)
      expect(bridge.create).toHaveBeenCalledExactlyOnceWith(source, expect.any(Function))
      expect(bridge.prepare).toHaveBeenCalledTimes(1)
    }
    finally {
      await context.fiber.dispose()
    }
  })

  it.each([
    { ownerSessionId: 'session-source', inheritedEventCount: 0, inheritedBinding: null, binding: { backend: 'codex', nativeSessionId: 'native-source', sessionId: 'session-source' } },
    { ownerSessionId: 'session-source', inheritedEventCount: 1, inheritedBinding: { backend: 'claude', nativeSessionId: 'native-parent', sessionId: 'session-parent' }, binding: null },
    { backend: 'codex', nativeSessionId: 'native-source', sessionId: 'session-source' },
  ])('rejects a native projection without a bridge capability before creating a child: %j', async (projected) => {
    const stateOf = vi.fn(() => projected)
    const { created } = setup({ projections: { stateOf } })
    expect(await handoff.inherit('session-source', 'session-target', 'C:/work')).toEqual({ ok: false, error: 'BRIDGE_CORE_UNAVAILABLE: Native session inheritance requires the native session fork capability' })
    expect(created).toHaveLength(0)
    expect(stateOf).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'session-source' }), 'bridgeKernel')
    expect(pendingWorktreeTitles.size).toBe(0)
  })

  it('rejects a native request header after the bridge projection and capability were unloaded', async () => {
    const session = { ...sessionOf(conversationEvents) as object, requestHeader: () => ({ config: { provider: 'dsh-tauri-bridge', model: 'claude' } }) }
    const { created } = setup({ session })
    expect(await handoff.inherit('session-source', 'session-target', 'C:/work')).toEqual({ ok: false, error: 'BRIDGE_CORE_UNAVAILABLE: Native session inheritance requires the native session fork capability' })
    expect(created).toHaveLength(0)
    expect(pendingWorktreeTitles.size).toBe(0)
  })

  it('rejects a native source selected before any binding or request was committed when its bridge capability is absent', async () => {
    const session = sessionOf(emptyEvents)
    const { created } = setup({ getAgent: () => ({ session, ctx: {}, options: { provider: 'dsh-tauri-bridge', model: 'codex' } }) })
    expect(await handoff.inherit('session-source', 'session-target', 'C:/work')).toEqual({ ok: false, error: 'BRIDGE_CORE_UNAVAILABLE: Native session inheritance requires the native session fork capability' })
    expect(created).toHaveLength(0)
    expect(pendingWorktreeTitles.size).toBe(0)
  })

  it('rejects a cold native kernel marker after both the projection and capability were unloaded without reading its binding payload', async () => {
    const payload = vi.fn(() => {
      throw new Error('A capability guard must not parse a native identity from raw history')
    })
    const marker = {
      type: 'plugin:dsh-tauri-bridge/kernel',
      seq: 2,
      time: 3,
      ignorable: true,
      get data() {
        return payload()
      },
    }
    const session = sessionOf([...conversationEvents, marker])
    const { created } = setup({ getAgent: () => undefined, storedSession: session })
    expect(await handoff.inherit('session-source', 'session-target', 'C:/work')).toEqual({ ok: false, error: 'BRIDGE_CORE_UNAVAILABLE: Native session inheritance requires the native session fork capability' })
    expect(payload).not.toHaveBeenCalled()
    expect(created).toHaveLength(0)
    expect(pendingWorktreeTitles.size).toBe(0)
  })

  it.each([
    { type: 'plugin:dsh-tauri-bridge/kernel', seq: 2, time: 3, data: {} },
    { type: 'plugin:another/kernel', seq: 2, time: 3, data: {}, ignorable: true },
  ])('does not classify unrelated or non-ignorable records as a native capability marker: %j', async (marker) => {
    const session = sessionOf([...conversationEvents, marker])
    const { created } = setup({ session })
    expect(await handoff.inherit('session-source', 'session-target', 'C:/work')).toEqual({ ok: true, targetSessionId: 'session-target', seedLength: 3 })
    expect(created).toHaveLength(1)
    expect(created[0].setup).toBeUndefined()
  })

  it('reports a bridge preparation failure without committing or attaching the inherited child', async () => {
    const context = new Context()
    try {
      const commit = vi.fn()
      const attachSession = vi.fn()
      const published = vi.fn()
      const prepare = vi.fn<NativeSessionBridge['prepare']>(async () => {
        throw new Error('BRIDGE_FORK_UNAVAILABLE: Native CLI cannot fork stored history')
      })
      setup({
        session: sessionOf(emptyEvents),
        bridge: { create: async (_source, createChild) => createChild(), prepare },
        workspace: { attachSession },
        create: async (options) => {
          const agent = { session: { id: options.sessionId }, ctx: context } as Agent
          const returned = await options.setup(context, agent)
          returned?.commit()
          commit()
          published()
          return { agent }
        },
      })
      expect(await handoff.handback('session-source', 'C:/project')).toEqual({ ok: false, error: 'BRIDGE_FORK_UNAVAILABLE: Native CLI cannot fork stored history' })
      expect(prepare).toHaveBeenCalledTimes(1)
      expect(commit).not.toHaveBeenCalled()
      expect(published).not.toHaveBeenCalled()
      expect(attachSession).not.toHaveBeenCalled()
      expect(pendingWorktreeTitles.size).toBe(0)
    }
    finally {
      await context.fiber.dispose()
    }
  })

  it('aborts native preparation when the official child setup scope is disposed', async () => {
    const context = new Context()
    try {
      const entered = Promise.withResolvers<void>()
      const ack = Promise.withResolvers<void>()
      const commit = vi.fn()
      let signal: AbortSignal | undefined
      setup({
        session: sessionOf(emptyEvents),
        bridge: {
          create: async (_source, createChild) => createChild(),
          prepare: async (_source, _agent, preparingSignal) => {
            signal = preparingSignal
            entered.resolve()
            await ack.promise
            return { commit }
          },
        },
        create: async (options) => {
          const agent = { session: { id: options.sessionId }, ctx: context } as Agent
          const returned = await options.setup(context, agent)
          returned?.commit()
          return { agent }
        },
      })
      const pending = handoff.inherit('session-source', 'session-target', 'C:/work')
      await Promise.race([entered.promise, pending.then((result) => {
        throw new Error(`Native preparation was bypassed: ${JSON.stringify(result)}`)
      })])
      expect(signal?.aborted).toBe(false)
      await context.fiber.dispose()
      expect(signal?.aborted).toBe(true)
      ack.resolve()
      expect(await pending).toEqual({ ok: false, error: 'BRIDGE_DISPOSED: The inherited agent setup was disposed' })
      expect(commit).not.toHaveBeenCalled()
      expect(pendingWorktreeTitles.size).toBe(0)
    }
    finally {
      await context.fiber.dispose()
    }
  })

  it('replays the actual kernel history with seeded lineage and an end-seed marker', async () => {
    const context = new Context()
    try {
      const sessions = new SessionStore(context)
      const source = Session.create(SessionId('session-source'))
      source.append('user/message', {
        id: MessageId('message-first'),
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: '你好' }],
      }, { surfaceOp: 'append' })
      source.append('assistant/message', {
        turn: 0,
        step: 0,
        message: {
          id: MessageId('message-reply'),
          role: 'assistant',
          source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
          content: [{ type: 'text', text: '你好，有什么可以帮你？' }],
        },
        stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [0], texts: ['你好，有什么可以帮你？'] }],
      }, { surfaceOp: 'append' })
      source.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
      const targets: Session[] = []
      const cwd = resolve('worktrees/w1')
      setup({
        session: source,
        presets: { composedPreset: () => 'default', composeFrom: () => 'default' },
        create: async (options) => {
          const target = sessions.prepare(SessionId(options.sessionId), options)
          const commit = await options.setup?.(context, { session: target })
          commit?.commit()
          targets.push(target)
        },
      })

      expect(await handoff.inherit('session-source', 'session-target', cwd)).toEqual({
        ok: true,
        targetSessionId: 'session-target',
        seedLength: 3,
      })
      expect(targets).toHaveLength(1)
      expect(targets[0]!.header).toMatchObject({ cwd, parentSession: 'session-source', isSeeded: true, agentPreset: 'default' })
      expect(targets[0]!.snapshotEvents()).toEqual([
        ...source.snapshotEvents(),
        expect.objectContaining({ type: 'session/end-seed', seq: 3, data: { inherited: true } }),
      ])
    }
    finally {
      await context.fiber.dispose()
    }
  })

  it('returns the snapshot read error before attempting target agent creation', async () => {
    const warn = vi.fn()
    const { created } = setup({
      session: {
        id: 'session-source',
        snapshotEvents: () => {
          throw new Error('snapshot unavailable')
        },
      },
      warn,
    })

    expect(await handoff.inherit('session-source', 'session-target', 'C:/work')).toEqual({
      ok: false,
      error: 'snapshot unavailable',
    })
    expect(created).toHaveLength(0)
    expect(pendingWorktreeTitles.size).toBe(0)
    expect(warn).toHaveBeenCalledExactlyOnceWith('dsh-tauri-worktree: session inheritance failed for session-target: snapshot unavailable')
  })

  it('reports a missing source session before attempting target agent creation', async () => {
    const { created } = setup({ getAgent: () => undefined })

    expect(await handoff.inherit('session-source', 'session-target', 'C:/work')).toEqual({
      ok: false,
      error: '未找到源会话：session-source',
    })
    expect(created).toHaveLength(0)
  })

  it('seeds the target session from the kernel snapshot log', async () => {
    const { created } = setup()
    const outcome = await handoff.inherit('session-source', 'session-target', 'C:/worktrees/w1')
    expect(outcome).toEqual({ ok: true, targetSessionId: 'session-target', seedLength: conversationEvents.length })
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({
      sessionId: 'session-target',
      seed: conversationEvents,
      inheritedEventCount: conversationEvents.length,
      meta: {
        cwd: 'C:/worktrees/w1',
        parentSession: 'session-source',
        isSeeded: true,
        agentPreset: 'default',
      },
    })
  })

  it('继承前缀里没有人类消息时登记一次显式标题：内核不会给 fork 子会话自动生成标题', async () => {
    setup({ session: sessionOf(emptyEvents) })
    await handoff.inherit('session-source', 'session-target', 'C:/worktrees/w1')

    expect([...pendingWorktreeTitles]).toEqual(['session-target'])
  })

  it('继承前缀里已有对话时不登记：继承标题由内核负责', async () => {
    setup()
    await handoff.inherit('session-source', 'session-target', 'C:/worktrees/w1')

    expect(pendingWorktreeTitles.size).toBe(0)
  })

  it('只认带正文的人类消息：空白正文与其它来源都不算对话', async () => {
    const blank = [
      { type: 'user/message', seq: 0, time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '   ' }] } },
    ]
    const notice = [
      { type: 'user/message', seq: 0, time: 1, data: { source: { kind: 'tool-jobs' }, content: [{ type: 'text', text: 'job done' }] } },
    ]
    for (const seed of [blank, notice]) {
      resetRuntime()
      setup({ session: sessionOf(seed) })
      await handoff.inherit('session-source', 'session-target', 'C:/work')
      expect([...pendingWorktreeTitles]).toEqual(['session-target'])
    }
  })

  it('inheritance 失败时不登记标题', async () => {
    setup({
      session: sessionOf(emptyEvents),
      create: async () => {
        throw new Error('boom')
      },
    })
    const outcome = await handoff.inherit('session-source', 'session-target', 'C:/work')

    expect(outcome).toEqual({ ok: false, error: 'boom' })
    expect(pendingWorktreeTitles.size).toBe(0)
  })

  it('reads the log through the legacy fallbacks', async () => {
    const legacy = [
      { id: 'session-source', header: {}, log: conversationEvents },
      { id: 'session-source', header: {}, events: conversationEvents },
    ]
    for (const session of legacy) {
      const { created } = setup({ session })
      expect(await handoff.inherit('session-source', 'session-target', 'C:/work')).toEqual({
        ok: true,
        targetSessionId: 'session-target',
        seedLength: conversationEvents.length,
      })
      expect(created[0]?.seed).toEqual(conversationEvents)
    }
  })

  it('reports a source session without a readable log', async () => {
    const { created } = setup({ session: { id: 'session-source', header: {} } })
    expect(await handoff.inherit('session-source', 'session-target', 'C:/work')).toEqual({
      ok: false,
      error: '源会话没有可继承的事件：session-source',
    })
    expect(created).toHaveLength(0)
  })

  it('warns when inheritance fails so the silent client fallback stays diagnosable', async () => {
    const warn = vi.fn()
    setup({ session: { id: 'session-source', header: {} }, warn })
    await handoff.inherit('session-source', 'session-target', 'C:/work')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('session-target'))
  })
})

describe('handoff.handback', () => {
  it('publishes the prepared native child before attaching it and saving checkout context', async () => {
    const context = new Context()
    try {
      const sessions = new SessionStore(context)
      const source = Session.create(SessionId('session-source'))
      source.append('turn/start', { turn: 0 })
      source.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
      const order: string[] = []
      const commit = vi.fn(() => order.push('commit'))
      const attachSession = vi.fn(async () => {
        order.push('attach')
      })
      const save = vi.spyOn(checkoutContext, 'save').mockImplementation(async () => {
        order.push('save')
      })
      setup({
        session: source,
        workspace: { attachSession },
        bridge: {
          create: async (_source, createChild) => {
            order.push('lock')
            const handle = await createChild()
            order.push('unlock')
            return handle
          },
          prepare: async (_source, agent) => {
            expect(agent.session.header).toMatchObject({ cwd: resolve('local-project'), parentSession: source.id, isSeeded: true })
            order.push('prepare')
            return { commit }
          },
        },
        create: async (options) => {
          const session = sessions.prepare(SessionId(options.sessionId), options)
          const agent = { id: session.id, session, ctx: context } as Agent
          const prepared = await options.setup(context, agent)
          prepared.commit()
          order.push('publish')
          return { agent }
        },
      })
      const outcome = await handoff.handback(source.id, resolve('local-project'), { branch: 'feature-child', worktreePath: 'C:/worktrees/w1' })
      expect(outcome).toEqual({ ok: true, targetSessionId: expect.stringMatching(/^session-/) })
      if (!outcome.ok)
        throw new Error(`The native handback failed: ${outcome.error}`)
      expect(order).toEqual(['lock', 'prepare', 'commit', 'publish', 'unlock', 'attach', 'save'])
      expect(commit).toHaveBeenCalledTimes(1)
      expect(attachSession).toHaveBeenCalledExactlyOnceWith(outcome.targetSessionId)
      expect(save).toHaveBeenCalledExactlyOnceWith(outcome.targetSessionId, { projectPath: resolve('local-project'), branch: 'feature-child', worktreePath: 'C:/worktrees/w1', checkedOutAt: expect.any(String) })
    }
    finally {
      await context.fiber.dispose()
    }
  })
})

describe('handoff.complete', () => {
  it('removes an unpublished worktree child after native preparation fails and never queues followup', async () => {
    const context = new Context()
    try {
      const sessions = new SessionStore(context)
      const source = Session.create(SessionId('session-source'))
      source.append('turn/start', { turn: 0 })
      const remove = vi.spyOn(worktree, 'remove').mockResolvedValue({ ok: true, worktreePath: 'C:/worktrees/w1' })
      const followup = vi.fn()
      const attachSession = vi.fn()
      const error = vi.fn()
      let published: Agent | undefined
      disposers.push(server({
        agents: {
          get: () => published,
          create: async (options: any) => {
            const session = sessions.prepare(SessionId(options.sessionId), options)
            const agent = { session, ctx: context, followup } as unknown as Agent
            const prepared = await options.setup(context, agent)
            prepared?.commit()
            published = agent
            return { agent }
          },
        },
        get: (key: string) => key === 'nativeSessionBridge'
          ? {
              create: async (_source: unknown, createChild: () => Promise<unknown>) => createChild(),
              prepare: async () => {
                throw new Error('BRIDGE_FORK_UNAVAILABLE: The native CLI cannot fork')
              },
            }
          : undefined,
        workspaceRegistry: { resolveByPath: async () => ({ attachSession }) },
        logger: { error },
        webServer: { register: () => () => {} },
      } as never))
      await handoff.complete({ sourceAgent: { session: source, ctx: context, options: {} }, targetSessionId: 'session-target', binding: { worktreePath: 'C:/worktrees/w1', projectPath: 'C:/project' } as Binding })
      expect(remove).toHaveBeenCalledExactlyOnceWith('session-target')
      expect(followup).not.toHaveBeenCalled()
      expect(attachSession).not.toHaveBeenCalled()
      expect(published).toBeUndefined()
      expect(error).toHaveBeenCalledExactlyOnceWith('create_worktree handoff failed for session-target: BRIDGE_FORK_UNAVAILABLE: The native CLI cannot fork')
      expect(pendingWorktreeTitles.size).toBe(0)
    }
    finally {
      await context.fiber.dispose()
    }
  })

  it('retains a published child and worktree when workspace attachment fails after preparation', async () => {
    const context = new Context()
    try {
      const sessions = new SessionStore(context)
      const source = Session.create(SessionId('session-source'))
      source.append('turn/start', { turn: 0 })
      const remove = vi.spyOn(worktree, 'remove').mockResolvedValue({ ok: true, worktreePath: 'C:/worktrees/w1' })
      const followup = vi.fn()
      const commit = vi.fn()
      const error = vi.fn()
      let published: Agent | undefined
      disposers.push(server({
        agents: {
          get: () => published,
          create: async (options: any) => {
            const session = sessions.prepare(SessionId(options.sessionId), options)
            const agent = { session, ctx: context, followup } as unknown as Agent
            const prepared = await options.setup(context, agent)
            prepared.commit()
            published = agent
            return { agent }
          },
        },
        get: (key: string) => key === 'nativeSessionBridge'
          ? { create: async (_source: unknown, createChild: () => Promise<unknown>) => createChild(), prepare: async () => ({ commit }) }
          : undefined,
        workspaceRegistry: {
          resolveByPath: async () => ({
            attachSession: async () => {
              throw new Error('workspace attachment failed')
            },
          }),
        },
        logger: { error },
        webServer: { register: () => () => {} },
      } as never))
      await handoff.complete({ sourceAgent: { session: source, ctx: context, options: {} }, targetSessionId: 'session-target', binding: { worktreePath: 'C:/worktrees/w1', projectPath: 'C:/project' } as Binding })
      expect(commit).toHaveBeenCalledTimes(1)
      expect(published?.session.id).toBe('session-target')
      expect(remove).not.toHaveBeenCalled()
      expect(followup).not.toHaveBeenCalled()
      expect(error).toHaveBeenCalledExactlyOnceWith('create_worktree handoff failed for session-target: workspace attachment failed')
      expect(pendingWorktreeTitles.size).toBe(0)
    }
    finally {
      await context.fiber.dispose()
    }
  })

  it('uses the pending source agent even when it is no longer registered', async () => {
    const followup = vi.fn()
    const create = vi.fn(async (_options: any) => ({ agent: { followup } }))
    const sourceContext = { preset: 'source' }
    const composeFrom = vi.fn(() => 'composed')
    const composedPreset = vi.fn(() => 'composed')
    const attachSession = vi.fn(async () => {})
    disposers.push(server({
      agents: { get: () => undefined, create },
      get: (key: string) => key === 'agentPresets' ? { composedPreset, composeFrom } : undefined,
      workspaceRegistry: { resolveByPath: async () => ({ attachSession }) },
      webServer: { register: () => () => {} },
    } as never))
    await handoff.complete({
      sourceAgent: { ...(sourceAgent() as object), ctx: sourceContext, options: { model: 'inherited' } },
      targetSessionId: 'session-target',
      binding: { worktreePath: 'C:/worktrees/w1', projectPath: 'C:/project' } as Binding,
    })
    expect(create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      sessionId: 'session-target',
      seed: conversationEvents,
      meta: expect.objectContaining({ cwd: 'C:/worktrees/w1', agentPreset: 'composed' }),
      agentOptions: { model: 'inherited' },
    }))
    expect(composedPreset).toHaveBeenCalledWith(sourceContext)
    const targetContext = { preset: 'target' }
    expect(await create.mock.calls[0]![0].setup(targetContext)).toBeUndefined()
    expect(composeFrom).toHaveBeenCalledExactlyOnceWith(targetContext, sourceContext)
    expect(attachSession).toHaveBeenCalledWith('session-target')
    expect(followup).toHaveBeenCalledTimes(1)
  })

  it('hands the inherited log to the worktree agent', async () => {
    const followup = vi.fn()
    const { created } = setup({ create: async () => ({ agent: { followup } }) })
    const pending: PendingHandoff = {
      sourceAgent: sourceAgent(),
      targetSessionId: 'session-target',
      binding: { worktreePath: 'C:/worktrees/w1', projectPath: 'C:/project' } as Binding,
    }

    await handoff.complete(pending)

    expect(created[0]).toMatchObject({
      sessionId: 'session-target',
      seed: conversationEvents,
      inheritedEventCount: conversationEvents.length,
      meta: {
        cwd: 'C:/worktrees/w1',
        parentSession: 'session-source',
        isSeeded: true,
        agentPreset: 'default',
      },
    })
    expect(pendingWorktreeTitles.size).toBe(0)
    expect(followup).toHaveBeenCalledTimes(1)
    const followupMessage = followup.mock.calls[0][0]
    const text = followupMessage.content.map((block: any) => block.text).join('')
    expect(text).toContain('is_worktree: true')
    expect(text).toContain('Worktree path: C:/worktrees/w1')
    expect(text).toContain('Project path: C:/project')
    expect(text).toContain('The task has moved to this isolated worktree session.')
  })

  it('空会话直接调用工具时同样登记显式标题', async () => {
    const followup = vi.fn()
    setup({ create: async () => ({ agent: { followup } }) })
    const pending: PendingHandoff = {
      sourceAgent: sourceAgent(emptyEvents),
      targetSessionId: 'session-target',
      binding: { worktreePath: 'C:/worktrees/w1', projectPath: 'C:/project' } as Binding,
    }

    await handoff.complete(pending)

    expect([...pendingWorktreeTitles]).toEqual(['session-target'])
  })
})
