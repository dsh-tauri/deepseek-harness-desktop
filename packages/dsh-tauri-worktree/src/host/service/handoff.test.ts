import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pendingWorktreeTitles, resetRuntime } from '../config/runtime'
import { server } from '../server'
import { handoff } from './handoff'

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
    get: () => options.presets,
    workspaceRegistry: { resolveByPath: async () => undefined },
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
