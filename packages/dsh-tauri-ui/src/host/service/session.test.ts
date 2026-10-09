import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { HostContext } from '../types'
import type { CreateUserMessage, PlanSession } from './session.types'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { createSystemMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../apply'
import { server } from '../server'
import { session } from './session'

const disposers: Array<() => void> = []

function disposeServers(): void {
  for (const dispose of disposers.splice(0))
    dispose()
}

interface SetupOptions {
  status?: string
  events?: unknown
  session?: unknown
  loader?: unknown
  nextTurn?: UserMessage[]
  nextStep?: UserMessage[]
}

function turnEnd(kind: string) {
  return { type: 'turn/end', seq: 1, time: 0, data: { turn: 1, reason: { kind } } }
}

function setup(options: SetupOptions = {}) {
  const followed: UserMessage[] = []
  const claimed: UserMessage[] = []
  const nextTurn = [...options.nextTurn ?? []]
  const nextStep = [...options.nextStep ?? []]
  const mutations: Array<{ target: string, removed: UserMessage[], inserted: UserMessage[] }> = []
  const discarded: UserMessage[] = []
  const warnings: string[] = []
  const eventContext = new Context()
  eventContext.logger.exporter({
    export(record) {
      if (record.type === 'warn')
        warnings.push(record.args.map(String).join(' '))
    },
  })
  const agent = {
    status: options.status ?? 'idle',
    session: options.session ?? { snapshotEvents: () => options.events ?? [turnEnd('completed')] },
    inbox: {
      nextTurn,
      nextStep,
      splice,
      prepend: (target: 'next-turn' | 'next-step', message: UserMessage) => void splice(target, 0, 0, [message]),
      append: (target: 'next-turn' | 'next-step', message: UserMessage) => void splice(target, Infinity, 0, [message]),
      remove(id: UserMessage['id']) {
        for (const target of ['next-turn', 'next-step'] as const) {
          const queue = target === 'next-turn' ? nextTurn : nextStep
          const index = queue.findIndex(message => message.id === id)
          if (index >= 0) {
            splice(target, index, 1, [])
            return true
          }
        }
        return false
      },
    },
    followup(message: UserMessage) {
      followed.push(message)
      agent.inbox.splice('next-turn', Infinity, 0, [message])
      if (agent.status === 'running')
        return
      agent.status = 'running'
      // ReactLoopInbox.claim drains next-step, then exactly one FIFO next-turn item.
      claimed.push(...nextStep.splice(0), ...nextTurn.splice(0, 1))
    },
  }
  function splice(target: 'next-turn' | 'next-step', start: number, deleteCount: number, inserted: UserMessage[]) {
    const queue = target === 'next-turn' ? nextTurn : nextStep
    const removed = queue.splice(start, deleteCount, ...inserted)
    mutations.push({ target, removed, inserted })
    const events = agentEvents(eventContext, agent as unknown as Agent)
    for (const message of removed) {
      discarded.push(message)
      events.emit('agent/inbox/discarded', { message })
    }
    for (const message of inserted)
      events.emit('agent/inbox/inserted', { message })
    return removed
  }
  const ctx = {
    agents: { get: (id: string) => (id === 'unknown' ? undefined : agent) },
    loader: options.loader ?? {
      import: async () => ({ createUserMessage }),
      unwrapExports: (value: unknown) => value,
    },
    on: eventContext.on.bind(eventContext),
    logger: { warn: () => {} },
  }
  disposers.push(server(Object.assign(ctx, { webServer: { register: () => () => {} } }) as never))
  return { followed, claimed, agent, ctx, mutations, discarded, warnings, eventContext }
}

afterEach(() => {
  disposeServers()
  vi.restoreAllMocks()
})

const interruptedPlan = [
  { content: '调查根因', status: 'completed' },
  { content: '修复继续操作', status: 'in_progress' },
  { content: '验证修复', status: 'pending' },
]

function setupTurn(kind: 'aborted' | 'interrupted' | 'error' = 'aborted') {
  const log = Session.create(SessionId('s1'))
  log.append('turn/start', { turn: 1 })
  const planLog = log as unknown as PlanSession
  planLog.append('todo/write', { todos: interruptedPlan })
  const reason = kind === 'aborted'
    ? { kind, reason: { kind: 'user' as const } }
    : kind === 'error' ? { kind, error: { message: 'test failure', code: 'UNKNOWN' } } : { kind }
  log.append('turn/end', { turn: 1, reason })
  const followed: Array<{ content: unknown, source: unknown }> = []
  const agent = { status: 'idle', session: log, inbox: { nextTurn: [] }, followup: (message: { content: unknown, source: unknown }) => void followed.push(message) }
  const hooks = new Map<string, (payload: unknown, next: () => Promise<unknown>) => unknown>()
  apply({
    agents: { get: () => agent },
    loader: { import: async () => ({ createUserMessage: (input: unknown) => input }), unwrapExports: (value: unknown) => value },
    on: (name: string, callback: (payload: unknown, next: () => Promise<unknown>) => unknown) => hooks.set(name, callback),
    webServer: { register: () => () => {} },
    effect: (callback: () => (() => void) | void) => {
      const dispose = callback()
      if (dispose)
        disposers.push(dispose)
    },
  } as HostContext)
  async function preStep(messages = followed, step = 1, decision: unknown = { kind: 'enter', messages }, signal = new AbortController().signal) {
    const handler = hooks.get('agent/pre-step')
    expect(handler).toBeTypeOf('function')
    const outcome = await handler!({ agent, messages, turn: log.snapshotEvents().filter(event => event.type === 'turn/start').length, step, signal }, async () => decision)
    expect(outcome).toBe(decision)
  }
  return {
    log,
    planLog,
    followed,
    preStep,
    async start(messages = followed, decision?: unknown) {
      const turn = log.snapshotEvents().filter(event => event.type === 'turn/start').length + 1
      log.append('turn/start', { turn })
      await preStep(messages, 1, decision)
    },
  }
}

function projectedTodos(log: Session): unknown {
  return log.snapshotEvents().reduce<unknown>((state, event) => {
    if (event.type === 'turn/start')
      return null
    if ((event.type as string) === 'todo/write')
      return (event.data as { todos: unknown }).todos
    return state
  }, null)
}

describe('continued turn plan', () => {
  it.each(['aborted', 'interrupted', 'error'] as const)('restores every todo and status when continuing an %s turn', async (kind) => {
    const { log, start, preStep } = setupTurn(kind)
    expect(await session.resume('s1')).toEqual({ ok: true })
    await start()
    expect(projectedTodos(log)).toEqual(interruptedPlan)
    expect(log.snapshotEvents().at(-1)).toMatchObject({ type: 'todo/write', data: { todos: interruptedPlan } })
    expect(projectedTodos(Session.create(SessionId('replayed'), log.snapshotEvents()))).toEqual(interruptedPlan)
    await preStep()
    await preStep(undefined, 2)
    expect(log.snapshotEvents().filter(event => (event.type as string) === 'todo/write')).toHaveLength(2)
  })

  it('keeps the normal new-task reset instead of restoring an unrelated plan', async () => {
    const { log, start } = setupTurn()
    await start([{ content: [], source: { kind: 'user' } }])
    expect(projectedTodos(log)).toBeNull()
  })

  it('restores the latest plan instead of an earlier checklist', async () => {
    const { log, planLog, start } = setupTurn()
    log.append('turn/start', { turn: 2 })
    const updated = [{ content: '后续任务', status: 'in_progress' }]
    planLog.append('todo/write', { todos: updated })
    log.append('turn/end', { turn: 2, reason: { kind: 'interrupted' } })
    expect(await session.resume('s1')).toEqual({ ok: true })
    await start()
    expect(projectedTodos(log)).toEqual(updated)
  })

  it('preserves an explicitly emptied checklist', async () => {
    const { log, planLog, start } = setupTurn()
    log.append('turn/start', { turn: 2 })
    planLog.append('todo/write', { todos: [] })
    log.append('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    expect(await session.resume('s1')).toEqual({ ok: true })
    await start()
    expect(projectedTodos(log)).toEqual([])
  })

  it('does not restore for rejected or replaced continuation admission', async () => {
    const { log, start, preStep } = setupTurn()
    expect(await session.resume('s1')).toEqual({ ok: true })
    await start(undefined, { kind: 'reject' })
    expect(projectedTodos(log)).toBeNull()
    await preStep(undefined, 1, { kind: 'enter', messages: [{ source: { kind: 'user' } }] })
    expect(projectedTodos(log)).toBeNull()
  })

  it('restores the plan when continuation is admitted alongside injected context', async () => {
    const { log, followed, start } = setupTurn()
    expect(await session.resume('s1')).toEqual({ ok: true })
    await start([...followed, { content: [], source: { kind: 'model-change', form: 'notice' } }])
    expect(projectedTodos(log)).toEqual(interruptedPlan)
  })

  it('does not overwrite a newer plan or restore on a later step', async () => {
    const { log, planLog, preStep } = setupTurn()
    expect(await session.resume('s1')).toEqual({ ok: true })
    log.append('turn/start', { turn: 2 })
    await preStep(undefined, 2)
    expect(projectedTodos(log)).toBeNull()
    const updated = [{ content: '新计划', status: 'pending' }]
    planLog.append('todo/write', { todos: updated })
    await preStep()
    expect(projectedTodos(log)).toEqual(updated)
    expect(log.snapshotEvents().filter(event => (event.type as string) === 'todo/write')).toHaveLength(2)
  })

  it('does not append after admission was cancelled or the turn already ended', async () => {
    const { log, preStep } = setupTurn()
    expect(await session.resume('s1')).toEqual({ ok: true })
    log.append('turn/start', { turn: 2 })
    const controller = new AbortController()
    controller.abort()
    await preStep(undefined, 1, undefined, controller.signal)
    expect(projectedTodos(log)).toBeNull()
    log.append('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    await preStep()
    expect(projectedTodos(log)).toBeNull()
  })

  it('does not restore a continuation batched with a new user task', async () => {
    const { log, followed, start } = setupTurn()
    expect(await session.resume('s1')).toEqual({ ok: true })
    await start([...followed, { content: [], source: { kind: 'user' } }])
    expect(projectedTodos(log)).toBeNull()
  })

  it('does not resurrect a plan from an earlier task with no plan in the interrupted turn', async () => {
    const { log, start } = setupTurn()
    log.append('turn/start', { turn: 2 })
    log.append('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    expect(await session.resume('s1')).toEqual({ ok: true })
    await start()
    expect(projectedTodos(log)).toBeNull()
    expect(log.snapshotEvents().filter(event => (event.type as string) === 'todo/write')).toHaveLength(1)
  })
})

describe('session.resume', () => {
  it('admits the continuation before queued user messages without moving those messages', async () => {
    const first = createUserMessage({ content: [{ type: 'text', text: '先别发送的任务' }], source: { kind: 'user' } })
    const second = createUserMessage({ content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } })
    const { claimed, followed, agent, mutations } = setup({ events: [turnEnd('aborted')], nextTurn: [first, second] })
    const descriptor = Object.getOwnPropertyDescriptor(agent.inbox, 'splice')

    expect(await session.resume('s1')).toEqual({ ok: true })

    expect(claimed).toEqual([expect.objectContaining({
      role: 'user',
      content: [{ type: 'text', text: 'Continue the interrupted task from where it stopped. Do not repeat work that is already complete.' }],
      source: { kind: 'continue' },
    })])
    expect(claimed[0]).toBe(followed[0])
    expect(agent.inbox.nextTurn).toEqual([first, second])
    expect(agent.inbox.nextTurn[0]).toBe(first)
    expect(agent.inbox.nextTurn[1]).toBe(second)
    expect(mutations.flatMap(mutation => mutation.removed)).not.toContain(first)
    expect(mutations.flatMap(mutation => mutation.removed)).not.toContain(second)
    expect(Object.getOwnPropertyDescriptor(agent.inbox, 'splice')).toEqual(descriptor)
  })

  it('inserts the continuation once without canceling or discarding any message', async () => {
    const queued = createUserMessage({ content: [{ type: 'text', text: '排队任务' }], source: { kind: 'user' } })
    const { agent, followed, mutations, discarded, warnings } = setup({ events: [turnEnd('aborted')], nextTurn: [queued] })

    expect(await session.resume('s1')).toEqual({ ok: true })

    expect(mutations).toEqual([{ target: 'next-turn', removed: [], inserted: [followed[0]] }])
    expect(discarded).toEqual([])
    expect(warnings).toEqual([])
    expect(agent.inbox.nextTurn).toEqual([queued])
  })

  it('admits the continuation before an inserted observer reentrantly sends a user message', async () => {
    const queued = createUserMessage({ content: [{ type: 'text', text: '排队任务' }], source: { kind: 'user' } })
    const unrelated = createUserMessage({ content: [{ type: 'text', text: '重入的用户消息' }], source: { kind: 'user' } })
    const { agent, followed, claimed, eventContext, warnings } = setup({ events: [turnEnd('aborted')], nextTurn: [queued] })
    const originalSplice = agent.inbox.splice
    eventContext.on('agent/inbox/inserted', ({ message }) => {
      if (message.source.kind !== 'user') {
        expect(agent.inbox.splice).toBe(originalSplice)
        agent.followup(unrelated)
      }
    })

    expect(await session.resume('s1')).toEqual({ ok: true })

    expect(claimed).toEqual([followed[0]])
    expect(claimed[0]?.source).toEqual({ kind: 'continue' })
    expect(agent.inbox.nextTurn).toEqual([queued, unrelated])
    expect(warnings).toEqual([])
  })

  it('does not trigger discarded observers while prioritizing the continuation', async () => {
    const queued = createUserMessage({ content: [{ type: 'text', text: '排队任务' }], source: { kind: 'user' } })
    const unrelated = createUserMessage({ content: [{ type: 'text', text: '丢弃观察者的消息' }], source: { kind: 'user' } })
    const { agent, claimed, eventContext, discarded, followed } = setup({ events: [turnEnd('aborted')], nextTurn: [queued] })
    eventContext.on('agent/inbox/discarded', () => agent.followup(unrelated))

    expect(await session.resume('s1')).toEqual({ ok: true })

    expect(discarded).toEqual([])
    expect(claimed).toEqual([followed[0]])
    expect(claimed[0]?.source).toEqual({ kind: 'continue' })
    expect(agent.inbox.nextTurn).toEqual([queued])
  })

  it('admits injected next-step context with the continuation while retaining the queued turn', async () => {
    const queued = createUserMessage({ content: [{ type: 'text', text: '排队任务' }], source: { kind: 'user' } })
    const context = createUserMessage({ content: [{ type: 'text', text: '运行时上下文' }], source: { kind: 'system-prompt' } })
    const { agent, claimed, followed } = setup({ events: [turnEnd('interrupted')], nextTurn: [queued], nextStep: [context] })

    expect(await session.resume('s1')).toEqual({ ok: true })

    expect(claimed).toEqual([context, expect.objectContaining({ source: { kind: 'continue' } })])
    expect(claimed[1]).toBe(followed[0])
    expect(agent.inbox.nextTurn).toEqual([queued])
    expect(agent.inbox.nextStep).toEqual([])
  })

  it('keeps ordinary user followups FIFO after the continuation insertion is restored', async () => {
    const first = createUserMessage({ content: [{ type: 'text', text: '第一项任务' }], source: { kind: 'user' } })
    const second = createUserMessage({ content: [{ type: 'text', text: '第二项任务' }], source: { kind: 'user' } })
    const userContinue = createUserMessage({ content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } })
    const { agent, claimed } = setup({ events: [turnEnd('aborted')], nextTurn: [first, second] })
    const descriptor = Object.getOwnPropertyDescriptor(agent.inbox, 'splice')
    expect(await session.resume('s1')).toEqual({ ok: true })
    expect(Object.getOwnPropertyDescriptor(agent.inbox, 'splice')).toEqual(descriptor)

    agent.status = 'idle'
    agent.followup(userContinue)

    expect(claimed).toEqual([expect.objectContaining({ source: { kind: 'continue' } }), first])
    expect(agent.inbox.nextTurn).toEqual([second, userContinue])
  })

  it('prioritizes only this continuation id and leaves unrelated insertions at their requested position', async () => {
    const first = createUserMessage({ content: [{ type: 'text', text: '排队任务' }], source: { kind: 'user' } })
    const unrelated = (createUserMessage as CreateUserMessage)({ content: [{ type: 'text', text: '另一条继续消息' }], source: { kind: 'continue' } })
    const { agent, claimed } = setup({ events: [turnEnd('aborted')], nextTurn: [first] })
    const followup = agent.followup
    vi.spyOn(agent, 'followup').mockImplementation((message) => {
      agent.inbox.splice('next-turn', Infinity, 0, [unrelated])
      expect(agent.inbox.nextTurn).toEqual([first, unrelated])
      followup(message)
    })

    expect(await session.resume('s1')).toEqual({ ok: true })

    expect(claimed).toEqual([expect.objectContaining({ source: { kind: 'continue' } })])
    expect(claimed[0]?.id).not.toBe(unrelated.id)
    expect(agent.inbox.nextTurn).toEqual([first, unrelated])
  })

  it('restores the original insertion method when followup throws before inserting', async () => {
    const queued = createUserMessage({ content: [{ type: 'text', text: '排队任务' }], source: { kind: 'user' } })
    const { agent, followed } = setup({ events: [turnEnd('aborted')], nextTurn: [queued] })
    const descriptor = Object.getOwnPropertyDescriptor(agent.inbox, 'splice')
    vi.spyOn(agent, 'followup').mockImplementation(() => {
      throw new Error('followup failed')
    })

    expect(await session.resume('s1')).toEqual({ ok: false, code: 500, error: 'Error: followup failed' })

    expect(agent.inbox.nextTurn).toEqual([queued])
    expect(followed).toEqual([])
    expect(Object.getOwnPropertyDescriptor(agent.inbox, 'splice')).toEqual(descriptor)
  })

  it.each(['missing', 'frozen', 'non-extensible'] as const)('refuses queued continuation before dispatch when splice is %s', async (mode) => {
    const queued = createUserMessage({ content: [{ type: 'text', text: '排队任务' }], source: { kind: 'user' } })
    const { agent, ctx, followed, mutations } = setup({ events: [turnEnd('aborted')], nextTurn: [queued] })
    if (mode === 'missing') {
      const unsupportedAgent = { ...agent, inbox: { ...agent.inbox, splice: undefined } }
      disposers.push(server({ ...ctx, agents: { get: () => unsupportedAgent } } as never))
    }
    else if (mode === 'frozen') {
      Object.freeze(agent.inbox)
    }
    else {
      const splice = agent.inbox.splice
      Reflect.deleteProperty(agent.inbox, 'splice')
      Object.setPrototypeOf(agent.inbox, { splice })
      Object.preventExtensions(agent.inbox)
    }

    expect(await session.resume('s1')).toEqual({
      ok: false,
      code: 500,
      error: 'TypeError: DSH_CONTINUE_API_MISSING: writable agent.inbox.splice',
    })

    expect(agent.inbox.nextTurn).toEqual([queued])
    expect(followed).toEqual([])
    expect(mutations).toEqual([])
  })

  it('returns a splice failure without claiming queued work or swallowing it as a notification warning', async () => {
    const queued = createUserMessage({ content: [{ type: 'text', text: '排队任务' }], source: { kind: 'user' } })
    const { agent, claimed, mutations, warnings } = setup({ events: [turnEnd('aborted')], nextTurn: [queued] })
    vi.spyOn(agent.inbox, 'splice').mockImplementation(() => {
      throw new Error('splice failed')
    })
    const descriptor = Object.getOwnPropertyDescriptor(agent.inbox, 'splice')

    expect(await session.resume('s1')).toEqual({ ok: false, code: 500, error: 'Error: splice failed' })

    expect(agent.status).toBe('idle')
    expect(agent.inbox.nextTurn).toEqual([queued])
    expect(claimed).toEqual([])
    expect(mutations).toEqual([])
    expect(warnings).toEqual([])
    expect(Object.getOwnPropertyDescriptor(agent.inbox, 'splice')).toEqual(descriptor)
  })

  it('removes the temporary own shadow when the original insertion method is inherited', async () => {
    const queued = createUserMessage({ content: [{ type: 'text', text: '排队任务' }], source: { kind: 'user' } })
    const { agent, claimed } = setup({ events: [turnEnd('aborted')], nextTurn: [queued] })
    const splice = agent.inbox.splice
    Reflect.deleteProperty(agent.inbox, 'splice')
    Object.setPrototypeOf(agent.inbox, { splice })

    expect(await session.resume('s1')).toEqual({ ok: true })

    expect(claimed).toEqual([expect.objectContaining({ source: { kind: 'continue' } })])
    expect(agent.inbox.nextTurn).toEqual([queued])
    expect(agent.inbox.splice).toBe(splice)
    expect(Object.hasOwn(agent.inbox, 'splice')).toBe(false)
  })

  it.each(['readonly-configurable', 'writable-nonconfigurable', 'accessor-configurable'] as const)('restores the original %s descriptor before insertion observers run', async (mode) => {
    const queued = createUserMessage({ content: [{ type: 'text', text: '排队任务' }], source: { kind: 'user' } })
    const { agent, claimed, eventContext, warnings } = setup({ events: [turnEnd('aborted')], nextTurn: [queued] })
    const splice = agent.inbox.splice
    const descriptor = mode === 'accessor-configurable'
      ? { configurable: true, enumerable: false, get: () => splice }
      : { configurable: mode === 'readonly-configurable', enumerable: false, writable: mode === 'writable-nonconfigurable', value: splice }
    Object.defineProperty(agent.inbox, 'splice', descriptor)
    const original = Object.getOwnPropertyDescriptor(agent.inbox, 'splice')
    const observed: PropertyDescriptor[] = []
    eventContext.on('agent/inbox/inserted', () => observed.push(Object.getOwnPropertyDescriptor(agent.inbox, 'splice')!))

    expect(await session.resume('s1')).toEqual({ ok: true })

    expect(claimed).toEqual([expect.objectContaining({ source: { kind: 'continue' } })])
    expect(agent.inbox.nextTurn).toEqual([queued])
    expect(observed).toEqual([original])
    expect(Object.getOwnPropertyDescriptor(agent.inbox, 'splice')).toEqual(original)
    expect(warnings).toEqual([])
  })

  it('does not overwrite insertion observers that replace the restored method', async () => {
    const queued = createUserMessage({ content: [{ type: 'text', text: '排队任务' }], source: { kind: 'user' } })
    const { agent, eventContext, claimed } = setup({ events: [turnEnd('aborted')], nextTurn: [queued] })
    const replacement = vi.fn(agent.inbox.splice)
    eventContext.on('agent/inbox/inserted', () => {
      agent.inbox.splice = replacement
    })

    expect(await session.resume('s1')).toEqual({ ok: true })

    expect(claimed).toEqual([expect.objectContaining({ source: { kind: 'continue' } })])
    expect(agent.inbox.nextTurn).toEqual([queued])
    expect(agent.inbox.splice).toBe(replacement)
    expect(replacement).not.toHaveBeenCalled()
  })

  it('does not enqueue continuation if the agent starts running during module loading', async () => {
    const { agent, ctx, followed } = setup({ events: [turnEnd('aborted')] })
    ctx.loader = {
      import: async () => {
        agent.status = 'running'
        return { createUserMessage }
      },
      unwrapExports: (value: unknown) => value,
    }

    expect(await session.resume('s1')).toEqual({ ok: false, code: 409, error: '会话状态已变化，请重新尝试继续' })

    expect(followed).toEqual([])
    expect(agent.inbox.nextTurn).toEqual([])
  })

  it('does not enqueue continuation if the agent is replaced during module loading', async () => {
    const { agent, ctx, followed } = setup({ events: [turnEnd('aborted')] })
    ctx.loader = {
      import: async () => {
        ctx.agents.get = () => ({ ...agent })
        return { createUserMessage }
      },
      unwrapExports: (value: unknown) => value,
    }

    expect(await session.resume('s1')).toEqual({ ok: false, code: 409, error: '会话状态已变化，请重新尝试继续' })

    expect(followed).toEqual([])
    expect(agent.inbox.nextTurn).toEqual([])
  })

  it('continues a session whose turn was aborted by the user', async () => {
    const { followed } = setup({ events: [{ type: 'turn/start' }, turnEnd('aborted')] })
    expect(await session.resume('s1')).toEqual({ ok: true })
    expect(followed).toHaveLength(1)
    expect(followed[0]?.source).toEqual({ kind: 'continue' })
  })

  it('continues interrupted and errored turns', async () => {
    setup({ events: [turnEnd('interrupted')] })
    expect(await session.resume('s1')).toEqual({ ok: true })

    const { followed } = setup({ events: [turnEnd('error')] })
    expect(await session.resume('s1')).toEqual({ ok: true })
    expect(followed).toHaveLength(1)
  })

  it('refuses a turn that settled normally, naming the reason', async () => {
    for (const kind of ['completed', 'blocked', 'max-tokens']) {
      const { followed } = setup({ events: [turnEnd(kind)] })
      const outcome = await session.resume('s1')
      expect(outcome).toEqual({ ok: false, code: 409, error: expect.stringContaining(kind) })
      expect(followed).toHaveLength(0)
    }
  })

  it('refuses a running session and an unknown one', async () => {
    setup({ status: 'running' })
    expect(await session.resume('s1')).toEqual({ ok: false, code: 409, error: '会话仍在运行，无需继续' })
    expect(await session.resume('unknown')).toEqual({ ok: false, code: 404, error: '会话不存在或尚未运行' })
  })

  it('reads the log through the legacy fallbacks', async () => {
    const log = [turnEnd('aborted')]
    setup({ session: { log } })
    expect(await session.resume('s1')).toEqual({ ok: true })
    setup({ session: { events: log } })
    expect(await session.resume('s1')).toEqual({ ok: true })
  })

  it('treats an unreadable log as continuable rather than blocking the user', async () => {
    setup({ session: {} })
    expect(await session.resume('s1')).toEqual({ ok: true })
  })

  it('reports a missing runtime module instead of throwing', async () => {
    setup({ events: [turnEnd('aborted')], loader: { import: async () => ({}), unwrapExports: () => ({}) } })
    const outcome = await session.resume('s1')
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.code).toBe(500)
  })

  it('reports 500 with the DSH_LOADER_MISSING literal when the host exposes no loader', async () => {
    const followed: unknown[] = []
    disposers.push(server({
      agents: {
        get: () => ({
          status: 'idle',
          session: { snapshotEvents: () => [turnEnd('aborted')] },
          followup: (message: unknown) => void followed.push(message),
        }),
      },
      logger: { warn: () => {} },
      webServer: { register: () => () => {} },
    } as never))
    expect(await session.resume('s1')).toEqual({
      ok: false,
      code: 500,
      error: 'TypeError: DSH_LOADER_MISSING: ctx.loader',
    })
    expect(followed).toHaveLength(0)
  })

  it('reports 500 with the DSH_LOADER_MISSING literal when the loader lacks import()', async () => {
    setup({ events: [turnEnd('aborted')], loader: { unwrapExports: (value: unknown) => value } })
    expect(await session.resume('s1')).toEqual({
      ok: false,
      code: 500,
      error: 'TypeError: DSH_LOADER_MISSING: ctx.loader',
    })
  })

  it('reports 500 with the DSH_LLM_EXPORT_MISSING literal when import() carries no createUserMessage', async () => {
    const { followed } = setup({
      events: [turnEnd('aborted')],
      loader: { import: async () => ({ createUserMessage: 'not-a-function' }), unwrapExports: () => undefined },
    })
    expect(await session.resume('s1')).toEqual({
      ok: false,
      code: 500,
      error: 'TypeError: DSH_LLM_EXPORT_MISSING: createUserMessage',
    })
    expect(followed).toHaveLength(0)
  })

  it('turns a throwing loader into a 500 naming the thrown error', async () => {
    setup({
      events: [turnEnd('aborted')],
      loader: { import: async () => { throw new Error('boom') }, unwrapExports: (value: unknown) => value },
    })
    expect(await session.resume('s1')).toEqual({ ok: false, code: 500, error: 'Error: boom' })
  })
})

describe('content risk recovery', () => {
  interface RecordedSurfaceEvent {
    type: string
    data: unknown
    intent: unknown
  }

  function contentRiskEvents() {
    return [
      { seq: 0, type: 'turn/start', data: { turn: 1 } },
      { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      { seq: 5, type: 'turn/start', data: { turn: 2 } },
      {
        seq: 9,
        type: 'turn/end',
        data: { turn: 2, reason: { kind: 'error', error: { message: 'Content Exists Risk', code: 'INVALID_REQUEST', status: 400 } } },
      },
    ]
  }

  function recoverySession(events: unknown = contentRiskEvents(), nodes: readonly number[] = [1, 2, 6, 8], extra: Record<string, unknown> = {}) {
    const surfaceEvents: RecordedSurfaceEvent[] = []
    const session = {
      snapshotEvents: () => events,
      surface: { nodes },
      id: 's1',
      seq: 10,
      header: { version: 4 },
      ...extra,
      append(type: string, data: unknown, intent: unknown) {
        surfaceEvents.push({ type, data, intent })
        return { seq: 10 }
      },
    }
    return { session, surfaceEvents }
  }

  it('shadows the refused turn before continuing and keeps the retained context', async () => {
    const { session: log, surfaceEvents } = recoverySession()
    const { followed } = setup({ session: log })

    expect(await session.resume('s1')).toEqual({ ok: true })

    expect(surfaceEvents).toHaveLength(2)
    expect(surfaceEvents[0]?.type).toBe('session-log-deepseek/delivery-accepted')
    expect(surfaceEvents[0]?.data).toEqual({ sessionId: 's1', sessionFormatVersion: 4, throughSeq: 9 })
    expect(surfaceEvents[1]?.type).toBe('user/message')
    expect(surfaceEvents[1]?.intent).toEqual({
      surfaceOp: { op: 'replace', startSeq: 6, endSeq: 8 },
      sourceEventSeqs: [6, 8],
    })
    const marker = surfaceEvents[1]?.data as { content: { text: string }[], source: { kind: string } }
    expect(marker.content[0]?.text.length).toBeGreaterThan(0)
    expect(marker.source.kind).toBe('content-risk-recovery')
    expect(followed).toHaveLength(1)
    expect(followed[0]?.source).toEqual({ kind: 'continue', recovery: 'content-risk' })
    expect((followed[0]?.content as unknown as { text: string }[])[0]?.text).toContain('excluded')
  })

  it('advances the upload watermark to the refused turn end before shadowing it', async () => {
    const { session: log, surfaceEvents } = recoverySession()
    setup({ session: log })

    expect(await session.resume('s1')).toEqual({ ok: true })

    // 先推水位、再写遮蔽标记：两次 append 都落在同一会话上，且水位早于标记。
    expect(surfaceEvents.map(entry => entry.type)).toEqual([
      'session-log-deepseek/delivery-accepted',
      'user/message',
    ])
    expect(surfaceEvents[0]?.intent).toBeUndefined()
  })

  it('keeps an already advanced watermark and never moves it backwards', async () => {
    const events = [
      ...contentRiskEvents(),
      { seq: 10, type: 'session-log-deepseek/delivery-accepted', data: { sessionId: 's1', sessionFormatVersion: 4, throughSeq: 9 } },
    ]
    const { session: log, surfaceEvents } = recoverySession(events)
    setup({ session: log })

    expect(await session.resume('s1')).toEqual({ ok: true })

    expect(surfaceEvents.map(entry => entry.type)).toEqual(['user/message'])
  })

  it('refuses to continue when the upload watermark cannot be written', async () => {
    const { session: log, surfaceEvents } = recoverySession(contentRiskEvents(), [1, 2, 6, 8], { header: {} })
    const { followed } = setup({ session: log })

    expect(await session.resume('s1')).toEqual({
      ok: false,
      code: 409,
      error: '无法确定安全恢复边界，未改写会话。请新建会话重述任务，或检查该回合的工具结果内容后重试。',
    })
    expect(surfaceEvents).toHaveLength(0)
    expect(followed).toHaveLength(0)
  })

  it('refuses to continue when the surface marker cannot be written', async () => {
    const { session: log } = recoverySession()
    const attempted: string[] = []
    const { followed } = setup({
      session: {
        ...log,
        append(type: string) {
          attempted.push(type)
          // 水位写成功、遮蔽标记被内核拒绝（节点漂移 / seq 不连续）：必须退化为人工指引。
          if (type !== 'session-log-deepseek/delivery-accepted')
            throw new Error('surface replace: sourceEventSeqs must include every shadowed surface node')
          return { seq: 10 }
        },
      },
    })

    expect(await session.resume('s1')).toEqual({
      ok: false,
      code: 409,
      error: '无法确定安全恢复边界，未改写会话。请新建会话重述任务，或检查该回合的工具结果内容后重试。',
    })
    expect(attempted).toEqual(['session-log-deepseek/delivery-accepted', 'user/message'])
    expect(followed).toHaveLength(0)
  })

  it('never replays the refused context and leaves an unrelated failure on the plain path', async () => {
    const { session: log, surfaceEvents } = recoverySession([
      { seq: 0, type: 'turn/start', data: { turn: 1 } },
      {
        seq: 4,
        type: 'turn/end',
        data: { turn: 1, reason: { kind: 'error', error: { message: 'Invalid request: prompt too long', code: 'INVALID_REQUEST', status: 400 } } },
      },
    ])
    const { followed } = setup({ session: log })

    expect(await session.resume('s1')).toEqual({ ok: true })

    expect(surfaceEvents).toHaveLength(0)
    expect(followed[0]?.source).toEqual({ kind: 'continue' })
  })

  it('refuses to continue when no safe boundary can be established', async () => {
    const { followed } = setup({ session: { snapshotEvents: contentRiskEvents } })

    expect(await session.resume('s1')).toEqual({
      ok: false,
      code: 409,
      error: '无法确定安全恢复边界，未改写会话。请新建会话重述任务，或检查该回合的工具结果内容后重试。',
    })
    expect(followed).toHaveLength(0)
  })

  it('refuses to continue when the surface would be emptied entirely', async () => {
    const { session: log, surfaceEvents } = recoverySession(contentRiskEvents(), [1])
    const { followed } = setup({ session: log })

    const outcome = await session.resume('s1')

    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.code).toBe(409)
    expect(surfaceEvents).toHaveLength(0)
    expect(followed).toHaveLength(0)
  })

  it('does not resurrect the refused turn plan when recovering', () => {
    const { log, planLog } = setupTurn()
    log.append('turn/start', { turn: 2 })
    const refused = [{ content: '被拒回合的计划', status: 'in_progress' }]
    planLog.append('todo/write', { todos: refused })
    log.append('turn/end', {
      turn: 2,
      reason: { kind: 'error', error: { message: 'Content Exists Risk', code: 'INVALID_REQUEST', status: 400 } },
    })

    log.append('turn/start', { turn: 3 })
    const writes = () => log.snapshotEvents().filter(event => (event.type as string) === 'todo/write').length
    const before = writes()

    session.restorePlan(
      log as unknown as PlanSession,
      [{ content: [], source: { kind: 'continue', recovery: 'content-risk' } }],
      1,
    )

    expect(writes()).toBe(before)

    // 对照组：同一日志位置在普通继续下确实会恢复计划，证明上面的静默来自审核恢复守卫。
    session.restorePlan(log as unknown as PlanSession, [{ content: [], source: { kind: 'continue' } }], 1)
    expect(writes()).toBe(before + 1)
    expect(projectedTodos(log)).toEqual(refused)
  })

  it('rewrites the refused turn out of the model-visible surface on a real log', async () => {
    const log = Session.create(SessionId('s1'))
    log.append('turn/start', { turn: 1 })
    const systemSeq = log.append('system/message', {
      turn: 1,
      step: 1,
      message: createSystemMessage('SYSTEM PROMPT'),
    }, { surfaceOp: 'append' }).seq
    log.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '检查代理配置' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const callId = ToolCallId('c1')
    const callSeq = log.append('tool/call', { turn: 1, step: 1, callId, name: 'read_file', arguments: '{}' }).seq
    log.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: 'proxy: http://127.0.0.1:7890' }],
        isError: false,
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
    const refusedEndSeq = log.append('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { message: 'Content Exists Risk', code: 'INVALID_REQUEST', status: 400 } },
    }).seq
    const { followed } = setup({ session: log })

    expect(await session.resume('s1')).toEqual({ ok: true })

    // 水位必须落在被拒回合的 turn/end 上，且内核折叠时接受这条记录。
    const watermark = log.snapshotEvents().find(event => (event.type as string) === 'session-log-deepseek/delivery-accepted')
    expect(watermark?.data).toEqual({ sessionId: 's1', sessionFormatVersion: 4, throughSeq: refusedEndSeq })

    const nodes = [...log.surface.nodes]
    expect(nodes).toHaveLength(2)
    expect(nodes[0]).toBe(systemSeq)
    const markerSeq = nodes[1]!
    expect(markerSeq).toBeGreaterThan(systemSeq)
    const rendered = log.deriveMessages().map(message => message.content.map(block => 'text' in block ? block.text : block.type).join(''))
    expect(rendered.join('|')).toContain('SYSTEM PROMPT')
    expect(rendered.join('|')).toContain('removed from the visible history')
    expect(rendered.join('|')).not.toContain('检查代理配置')
    expect(rendered.join('|')).not.toContain('7890')
    expect(followed).toHaveLength(1)
  })
})
