import type { Agent, AgentHandle, AgentSetup, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { NativeSession } from '../backends/types'
import type { HostContext, PlatformLoader, RuntimeModules } from '../types'
import type { DetectedCommand } from '../utils/detection'
import { createRequire } from 'node:module'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import * as llmModule from '@deepseek-ai/dsh-llm'
import { assertContiguous, materializeAppendBatch, materializeCreateHeader, SessionPersistence, SessionPersistenceRevision, validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../apply'
import { createClaudeSession } from '../backends/claude'
import { createCodexSession } from '../backends/codex'
import { BRIDGE_PROVIDER } from '../config/constants'
import { resetRuntime, runtime } from '../config/runtime'
import { detectBackend } from '../utils/detection'
import { adapter } from './adapter'
import { identity } from './identity'
import { session } from './session'

vi.mock('../utils/detection', () => ({ detectBackend: vi.fn() }))
vi.mock('../backends/codex', () => ({ createCodexSession: vi.fn() }))
vi.mock('../backends/claude', () => ({ createClaudeSession: vi.fn() }))

const packageId: string = 'dsh-session-current'
const sessionModule = await import(packageId) as typeof import('@deepseek-ai/dsh-session') & Pick<RuntimeModules, 'appendPluginRecord' | 'pluginRecordOf'>
const require = createRequire(import.meta.url)
const coreRequire = createRequire(require.resolve('@deepseek-ai/dsh-agent-loop'))
const { sessionFormatCatalog } = await import(pathToFileURL(coreRequire.resolve('@deepseek-ai/dsh-session-format-catalog')).href)
const { SessionQueryEngine } = await import(pathToFileURL(coreRequire.resolve('@deepseek-ai/dsh-session-query')).href)
const controllerEntry = pathToFileURL(require.resolve('@deepseek-ai/dsh-api-session-controller'))
const { ApiSessionAgentController } = await import(new URL('./types/agent.js', controllerEntry).href)
const { installModelSelectionProjection } = await import(new URL('./types/model-selection-projection.js', controllerEntry).href)
const promptModule: { SystemPrompt: new (ctx: Context, config: { includeHarnessIdentity: boolean, includeRuntimeContext: boolean }) => Context['systemPrompt'] } = await import(pathToFileURL(coreRequire.resolve('@deepseek-ai/dsh-system-prompt')).href)
const cwd = process.cwd()
const now = 1_791_576_000_000

class MemoryPersistence extends SessionPersistence {
  readonly stored = new Map<Session['id'], { header: Session['header'], inheritedEventCount: Session['inheritedEventCount'], events: readonly SessionEvent[], durable: readonly SessionEvent[], owner?: symbol }>()
  readonly writers = new Map<Session['id'], SessionHandle>()
  barrier: () => Promise<void> = async () => {}

  async create(header: Session['header'], options?: { inheritedEventCount?: Session['inheritedEventCount'], signal?: AbortSignal }): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    if (this.stored.has(header.id))
      throw new Error('worktree memory session already exists')
    this.stored.set(header.id, { header: materializeCreateHeader(header), inheritedEventCount: options?.inheritedEventCount ?? sessionModule.SessionLogOffset(0), events: [], durable: [] })
    return this.open(header.id, 'write', options)
  }

  async open(id: Session['id'], access: SessionHandle['access'], options?: { signal?: AbortSignal }): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    const stored = this.stored.get(id)
    if (!stored || (access === 'write' && stored.owner !== undefined))
      throw new Error('worktree memory session unavailable')
    const owner = Symbol(id)
    if (access === 'write')
      stored.owner = owner
    let closed = false
    const active = () => {
      if (closed || (access === 'write' && stored.owner !== owner))
        throw new Error('worktree memory session owner closed')
    }
    const flush = async () => {
      active()
      if (access !== 'write')
        throw new Error('worktree memory session is read-only')
      await this.barrier()
      stored.durable = validateStoredEvents(stored.header, structuredClone([...stored.events]))
    }
    const close = async () => {
      if (closed)
        return
      if (access === 'write') {
        await flush()
        delete stored.owner
        this.writers.delete(id)
      }
      closed = true
    }
    const handle: SessionHandle = {
      id,
      header: stored.header,
      inheritedEventCount: stored.inheritedEventCount,
      access,
      async read(offset = 0, length, readOptions) {
        active()
        readOptions?.signal?.throwIfAborted()
        return { events: validateStoredEvents(stored.header, structuredClone(stored.events.slice(offset, length === undefined ? undefined : offset + length))), eventState: 'shared-frozen' }
      },
      async append(events, appendOptions) {
        active()
        appendOptions?.signal?.throwIfAborted()
        if (access !== 'write')
          throw new Error('worktree memory session is read-only')
        const batch = materializeAppendBatch(events)
        assertContiguous(id, batch, stored.events.length)
        stored.events = [...stored.events, ...batch]
      },
      async flush(flushOptions) {
        flushOptions?.signal?.throwIfAborted()
        await flush()
      },
      close,
      [Symbol.asyncDispose]: close,
    }
    if (access === 'write')
      this.writers.set(id, handle)
    return handle
  }

  async flush(): Promise<void> {
    await Promise.all([...this.writers.values()].map(handle => handle.flush()))
  }

  async stat(id: Session['id']) {
    const stored = this.stored.get(id)
    return stored === undefined ? undefined : { header: stored.header, eventCount: stored.events.length, revision: SessionPersistenceRevision(`${id}:${stored.events.length}`) }
  }

  async list() {
    return Promise.all([...this.stored.keys()].map(async id => (await this.stat(id))!))
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

function native(id: string) {
  return { id, submit: vi.fn<NativeSession['submit']>().mockResolvedValue(undefined), dispose: vi.fn<NativeSession['dispose']>().mockResolvedValue(undefined) }
}

let context: Context
let agents: AgentRegistry
let sessions: InstanceType<typeof sessionModule.SessionStore>
let projections: SessionProjectionRegistry
let prepared: Session[]
let announced: Agent[]
let errors: unknown[]
let releases: Array<() => void>
let background: Promise<unknown>[]
let mount: ReturnType<typeof vi.fn>
let attachSession: ReturnType<typeof vi.fn>
let officialHandle: AgentHandle | undefined
let disposeLoop: () => Promise<void>
let createAgent: AgentRegistry['create']
let persistence: MemoryPersistence | undefined

beforeEach(async () => {
  await resetRuntime()
  vi.mocked(createCodexSession).mockReset()
  vi.mocked(createClaudeSession).mockReset()
  vi.mocked(detectBackend).mockReset()
  vi.mocked(detectBackend).mockImplementation(async (id): Promise<DetectedCommand> => ({
    detection: { id, installed: true, auth: 'ok', version: 'test', drift: false, hint: null },
    command: { file: 'boundary-only', args: [id] },
  }))
  context = new Context()
  agents = new AgentRegistry(context)
  sessions = new sessionModule.SessionStore(context)
  projections = new SessionProjectionRegistry(context)
  const llm = new llmModule.LlmRuntime(context)
  expect(llm.listProviders()).toEqual([])
  releases = []
  background = []
  prepared = []
  announced = []
  errors = []
  officialHandle = undefined
  persistence = undefined
  const prepare = sessions.prepare.bind(sessions)
  vi.spyOn(sessions, 'prepare').mockImplementation((...args) => {
    const official = prepare(...args)
    prepared.push(official)
    return official
  })
  context.on('agent/created', ({ agent }) => {
    announced.push(agent)
    return undefined
  })
  context.on('agent/error', ({ error }) => {
    errors.push(error)
  })
  createAgent = agents.create.bind(agents)
  vi.spyOn(agents, 'create').mockImplementation(async (...args) => {
    officialHandle = await createAgent(...args)
    return officialHandle
  })
  const prompt = new promptModule.SystemPrompt(context, { includeHarnessIdentity: false, includeRuntimeContext: false })
  const tools = new ToolRuntime(context, { mode: 'native' })
  expect(await prompt.assemble({})).toMatchObject({ tools: [] })
  expect(tools.schemas()).toEqual([])
  const routes = new Map<string, WebRoute>()
  context.provide('webServer', {
    register(route: WebRoute) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  } as unknown as HostContext['webServer'])
  const loader: PlatformLoader = {
    async import(id) {
      if (id === '@deepseek-ai/dsh-session')
        return sessionModule
      if (id === '@deepseek-ai/dsh-llm')
        return llmModule
      throw new Error(`unexpected module: ${id}`)
    },
    unwrapExports: value => value,
  }
  context.provide('loader', loader as HostContext['loader'])
  mount = vi.fn().mockResolvedValue(undefined)
  context.provide('agentPresets', {
    resolve: vi.fn().mockResolvedValue({ id: 'test-preset' }),
    mount,
  } as unknown as HostContext['agentPresets'])
  attachSession = vi.fn().mockResolvedValue(undefined)
  context.provide('workspaceRegistry', {
    get: vi.fn(id => id === 'test-workspace' ? { id, path: cwd, attachSession } : undefined),
  } as unknown as HostContext['workspaceRegistry'])
  const loop = context.plugin(AgentLoop, { agents: [] })
  disposeLoop = () => loop.dispose()
  await loop.await()
  context.plugin((ctx) => {
    apply(ctx as HostContext)
  })
  await vi.waitFor(() => expect(runtime.ready).toBe(true))
})

afterEach(async () => {
  for (const release of releases)
    release()
  await Promise.allSettled(background)
  if (persistence)
    persistence.barrier = async () => {}
  await session.dispose()
  await context.fiber.dispose()
  await resetRuntime()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function creating(id: 'codex' | 'claude' = 'codex', workspace?: string) {
  const task = workspace === undefined ? session.create(id, undefined, cwd) : session.create(id, workspace)
  const observed = task.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
  background.push(observed)
  return task
}

function followup(agent: Agent, text: string) {
  agent.followup(llmModule.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  const idle = agent.whenIdle()
  background.push(idle)
  return idle
}

function restoreSerialized(official: Session) {
  const text = [
    sessionFormatCatalog.encodeCurrentHeader({ ...official.header, delegationDepth: official.header.delegationDepth ?? 0 }, official.inheritedEventCount),
    ...official.snapshotEvents().map(event => sessionFormatCatalog.encodeCurrentEvent(event)),
  ].map(row => JSON.stringify(row)).join('\n')
  const [header, ...events] = text.split('\n').map(row => JSON.parse(row))
  const restore = sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' })
  for (const event of events)
    restore.decodeRow(event)
  const stored = restore.finish()
  const restored = sessionModule.Session.fromRestore(sessionModule.SessionId(stored.header.id), stored.events, stored.header, sessionModule.SessionLogOffset(stored.inheritedEventCount), 'detached')
  expect(restored.header).toEqual({ ...official.header, delegationDepth: official.header.delegationDepth ?? 0 })
  expect(restored.inheritedEventCount).toBe(official.inheritedEventCount)
  expect(restored.snapshotEvents().slice(0, stored.events.length)).toEqual(official.snapshotEvents())
  expect(restored.requestHeader()).toEqual(official.requestHeader())
  expect(restored.deriveMessages()).toEqual(official.deriveMessages())
  return restored
}

function records(official: Session) {
  return official.snapshotEvents().flatMap((event) => {
    const record = sessionModule.pluginRecordOf!(event)
    return record === undefined ? [] : [record]
  })
}

async function conversation(id: 'codex' | 'claude' = 'codex') {
  const connection = native(`worktree-parent-${id}`)
  vi.mocked(id === 'codex' ? createCodexSession : createClaudeSession).mockImplementationOnce(async (_command, _cwd, _storedId, output) => {
    connection.submit.mockImplementation(async () => output.assistant('worktree-source-answer', [{ type: 'text', text: 'source conversation already settled' }]))
    return connection
  })
  await creating(id)
  const handle = officialHandle!
  await followup(handle.agent, 'create the worktree from this real human conversation')
  expect(handle.agent.session.deriveMessages().map(message => ({ role: message.role, content: message.content }))).toEqual([
    { role: 'user', content: [{ type: 'text', text: 'create the worktree from this real human conversation' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'source conversation already settled' }] },
  ])
  expect(connection.submit).toHaveBeenCalledOnce()
  return { handle, connection }
}

function fork(source: Agent, target: string, signal = new AbortController().signal, setup?: AgentSetup) {
  const task = context.nativeSessionBridge.create(source.session, (sourceSignal) => {
    const scoped = sourceSignal === undefined ? signal : AbortSignal.any([signal, sourceSignal])
    const seed = source.session.snapshotEvents()
    return agents.create({
      sessionId: sessionModule.SessionId(target),
      seed,
      inheritedEventCount: sessionModule.SessionLogOffset(seed.length),
      meta: { cwd, parentSession: source.id, isSeeded: true },
      agentOptions: source.options,
      signal: scoped,
      async setup(agentCtx, child) {
        const startup = new AbortController()
        agentCtx.effect(() => () => startup.abort(new Error('worktree test setup disposed')))
        const commit = await context.nativeSessionBridge.prepare(source.session, child, AbortSignal.any([scoped, startup.signal]))
        await setup?.(agentCtx, child)
        return commit
      },
    })
  })
  background.push(task.then(value => ({ value }), error => ({ error })))
  return task
}

function observe(agent: Agent) {
  const events: SessionEvent[] = []
  const frames: AssistantStreamFrame[] = []
  const endEvents: Array<SessionEvent | undefined> = []
  agent.ctx.on('session/event', (official, event) => {
    if (official === agent.session)
      events.push(event)
  })
  agent.ctx.on('agent/assistant-stream', ({ frame }) => {
    frames.push(frame)
    if (frame.type === 'end' && frame.outcome.kind === 'committed') {
      const seq = frame.outcome.seq
      endEvents.push(events.find(event => event.seq === seq))
    }
  })
  return { events, frames, endEvents }
}

describe('independent native worktree session setup', () => {
  beforeEach(() => {
    vi.setSystemTime(now)
    persistence = new MemoryPersistence(context)
    context.on('session/flush', async (official) => {
      const stored = persistence!.stored.get(official.id)!
      const writer = persistence!.writers.get(official.id)!
      const suffix = official.snapshotEvents().slice(stored.events.length)
      if (suffix.length > 0)
        await writer.append(suffix)
      await writer.flush()
    })
  })

  it.each(['codex', 'claude'] as const)('round-trips the official V4 serializer before and after the first %s worktree turn', async (id) => {
    const { handle: parent, connection: original } = await conversation(id)
    const prefix = parent.agent.session.snapshotEvents()
    const connection = native(`serialized-worktree-child-${id}`)
    const factory = vi.mocked(id === 'codex' ? createCodexSession : createClaudeSession)
    factory.mockImplementationOnce(async (_command, _cwd, _storedId, output) => {
      connection.submit.mockImplementation(async () => output.assistant('serialized-worktree-answer', [{ type: 'text', text: 'independent serialized worktree reply' }]))
      return connection
    })
    const child = await fork(parent.agent, `serialized-worktree-official-${id}`)
    const cut = child.agent.session.inheritedEventCount
    expect(() => restoreSerialized(child.agent.session)).not.toThrow()
    expect(child.agent.session.snapshotEvents().slice(cut).map(event => event.type)).toEqual(['session/end-seed', 'plugin:dsh-tauri-bridge/kernel'])
    expect(child.agent.session.requestHeader()).toEqual(parent.agent.session.requestHeader())
    await followup(child.agent, 'persist the first independent worktree reply')
    expect(errors).toEqual([])
    expect(connection.submit).toHaveBeenCalledOnce()
    expect(original.submit).toHaveBeenCalledOnce()
    expect(parent.agent.session.snapshotEvents()).toEqual(prefix)
    expect(child.agent.session.snapshotEvents().slice(cut).filter(event => event.type === 'request/header').map(event => event.data.reason)).toEqual(['resume'])
    const restored = restoreSerialized(child.agent.session)
    expect(records(restored)).toEqual(records(child.agent.session))
    expect(restored.deriveMessages().map(message => ({ role: message.role, content: message.content }))).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'create the worktree from this real human conversation' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'source conversation already settled' }] },
      { role: 'user', content: [{ type: 'text', text: 'persist the first independent worktree reply' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'independent serialized worktree reply' }] },
    ])
  }, 10_000)

  it.each(['codex', 'claude'] as const)('publishes a %s child only after a distinct native fork ACK and its own official identity commit', async (id) => {
    const { handle: parent, connection: original } = await conversation(id)
    const source = parent.agent.session
    const prefix = source.snapshotEvents()
    const cut = source.seq
    const ack = deferred<NativeSession>()
    const started = deferred<void>()
    const childConnection = native(`worktree-child-${id}`)
    releases.push(() => ack.resolve(childConnection))
    const factory = vi.mocked(id === 'codex' ? createCodexSession : createClaudeSession)
    factory.mockImplementationOnce(async () => {
      started.resolve()
      return ack.promise
    })
    const task = fork(parent.agent, `worktree-official-${id}`)
    await started.promise
    const child = prepared[1]!
    expect(child.id).toBe(`worktree-official-${id}`)
    expect(child.header).toMatchObject({ parentSession: source.id, isSeeded: true, cwd })
    expect(child.inheritedEventCount).toBe(cut)
    expect(child.snapshotEvents()).toEqual([...prefix, { seq: cut, time: now, type: 'session/end-seed', data: { inherited: true } }])
    expect(projections.stateOf(child, 'bridgeKernel')).toEqual({
      ownerSessionId: `worktree-official-${id}`,
      inheritedEventCount: cut,
      inheritedBinding: { backend: id, nativeSessionId: `worktree-parent-${id}`, sessionId: source.id },
      binding: null,
    })
    expect(agents.get(child.id)).toBeUndefined()
    expect(sessions.get(child.id)).toBeUndefined()
    expect(announced).toEqual([parent.agent])
    expect(factory).toHaveBeenCalledTimes(2)
    expect(factory.mock.calls[1]![2]).toBeNull()
    expect(factory.mock.calls[1]![5]).toEqual({ forkFrom: `worktree-parent-${id}` })
    expect(childConnection.submit).not.toHaveBeenCalled()
    ack.resolve(childConnection)
    const owned = await task
    expect(owned.agent.session).toBe(child)
    expect(agents.get(child.id)).toBe(owned.agent)
    expect(sessions.get(child.id)).toBe(child)
    expect(announced).toEqual([parent.agent, owned.agent])
    expect(child.snapshotEvents().slice(cut)).toEqual([
      { seq: cut, time: now, type: 'session/end-seed', data: { inherited: true } },
      { seq: cut + 1, time: now, type: 'plugin:dsh-tauri-bridge/kernel', ignorable: true, data: { backend: id, nativeSessionId: `worktree-child-${id}`, sessionId: `worktree-official-${id}` } },
    ])
    expect(identity.resolve(owned.agent)).toEqual({ backend: id, nativeSessionId: `worktree-child-${id}`, sessionId: `worktree-official-${id}` })
    expect(identity.resolve(parent.agent)).toEqual({ backend: id, nativeSessionId: `worktree-parent-${id}`, sessionId: source.id })
    expect(source.snapshotEvents()).toEqual(prefix)
    expect(source.seq).toBe(cut)
    expect(runtime.claims.get(`${id}:worktree-parent-${id}`)).toBe(source.id)
    expect(runtime.claims.get(`${id}:worktree-child-${id}`)).toBe(`worktree-official-${id}`)
    expect(original.submit).toHaveBeenCalledOnce()
    expect(original.dispose).not.toHaveBeenCalled()
    expect(childConnection.submit).not.toHaveBeenCalled()
    expect(errors).toEqual([])
  }, 10_000)

  it('submits the first published worktree prompt exactly once to the new identity through three official native steps', async () => {
    const { handle: parent, connection: original } = await conversation()
    const connection = native('worktree-three-step-child')
    const next = deferred<void>()
    const tail = deferred<void>()
    const stepTwo = deferred<void>()
    const stepThree = deferred<void>()
    releases.push(() => next.resolve(), () => tail.resolve())
    vi.mocked(createCodexSession).mockImplementationOnce(async (_command, _cwd, _storedId, output) => {
      connection.submit.mockImplementation(async () => {
        output.assistant('child-first', [{ type: 'tool-call', id: 'child-call-one', name: 'native_one', arguments: '{}' }])
        output.toolStart('child-call-one', 'native_one', '{}')
        output.toolEnd('child-call-one', 'first child result')
        await next.promise
        output.assistant('child-second', [{ type: 'tool-call', id: 'child-call-two', name: 'native_two', arguments: '{}' }])
        output.toolStart('child-call-two', 'native_two', '{}')
        output.toolEnd('child-call-two', 'second child result')
        await tail.promise
        output.assistant('child-final', [{ type: 'text', text: 'the independent worktree finished' }])
      })
      return connection
    })
    const child = await fork(parent.agent, 'worktree-three-step-official')
    const { events } = observe(child.agent)
    child.agent.ctx.on('session/event', (official, event) => {
      if (official !== child.agent.session)
        return
      if (event.type === 'step/start' && event.data.step === 2)
        stepTwo.resolve()
      if (event.type === 'step/start' && event.data.step === 3)
        stepThree.resolve()
    })
    const turn = followup(child.agent, 'first worktree prompt after setup publication')
    await stepTwo.promise
    expect(connection.submit).toHaveBeenCalledOnce()
    next.resolve()
    await stepThree.promise
    expect(connection.submit).toHaveBeenCalledOnce()
    tail.resolve()
    await turn
    expect(connection.submit).toHaveBeenCalledOnce()
    expect(connection.submit.mock.calls[0]![0]).toMatchObject([{ source: { kind: 'user' }, content: [{ type: 'text', text: 'first worktree prompt after setup publication' }] }])
    expect(connection.submit.mock.calls[0]![2]).toEqual({ model: null, reasoningEffort: null })
    expect(events.filter(event => event.type === 'step/start').map(event => event.data)).toEqual([{ turn: 2, step: 1 }, { turn: 2, step: 2 }, { turn: 2, step: 3 }])
    expect(events.filter(event => event.type === 'tool/call').map(event => event.data.callId)).toEqual(['child-call-one', 'child-call-two'])
    expect(events.filter(event => event.type === 'tool/result').map(event => event.data.message.toolCallId)).toEqual(['child-call-one', 'child-call-two'])
    expect(events.filter(event => event.type === 'turn/end').map(event => event.data)).toEqual([{ turn: 2, reason: { kind: 'completed' } }])
    expect(identity.resolve(child.agent)).toEqual({ backend: 'codex', nativeSessionId: 'worktree-three-step-child', sessionId: 'worktree-three-step-official' })
    expect(original.submit).toHaveBeenCalledOnce()
    expect(createCodexSession).toHaveBeenCalledTimes(2)
    expect(createClaudeSession).not.toHaveBeenCalled()
    expect(errors).toEqual([])
    expect(runtime.exchanges.size).toBe(0)
  }, 10_000)

  it('cold-restores only a child-owned native id without restoring or forking its parent again', async () => {
    const { handle: parent, connection: original } = await conversation()
    const childConnection = native('worktree-cold-child-native')
    vi.mocked(createCodexSession).mockResolvedValueOnce(childConnection)
    const child = await fork(parent.agent, 'worktree-cold-child-official')
    const before = records(child.agent.session)
    await child.dispose()
    await session.remove(child.agent.id)
    const open = vi.spyOn(persistence!, 'open')
    const createStored = vi.spyOn(persistence!, 'create')
    const restored = await agents.resume({ resumeSessionId: child.agent.id, agentOptions: { provider: 'dsh-tauri-bridge', model: 'codex' } })
    const close = vi.spyOn(persistence!.writers.get(child.agent.id)!, 'close')
    expect(open).toHaveBeenCalledExactlyOnceWith(child.agent.id, 'write', { signal: expect.any(AbortSignal) })
    const resumed = native('worktree-cold-child-native')
    vi.mocked(createCodexSession).mockImplementationOnce(async (_command, _cwd, _storedId, output) => {
      resumed.submit.mockImplementation(async () => output.assistant('child-cold-answer', [{ type: 'text', text: 'only child history restored' }]))
      return resumed
    })
    await followup(restored.agent, 'continue only the independent child history')
    expect(open).toHaveBeenCalledTimes(2)
    expect(open.mock.calls[1]).toEqual([child.agent.id, 'read', { signal: expect.any(AbortSignal) }])
    expect(createStored).not.toHaveBeenCalled()
    expect(createCodexSession).toHaveBeenCalledTimes(3)
    expect(vi.mocked(createCodexSession).mock.calls[2]![2]).toBe('worktree-cold-child-native')
    expect(vi.mocked(createCodexSession).mock.calls[2]![5]).toBeUndefined()
    expect(resumed.submit).toHaveBeenCalledOnce()
    expect(original.submit).toHaveBeenCalledOnce()
    expect(original.dispose).not.toHaveBeenCalled()
    expect(identity.resolve(restored.agent)).toEqual({ backend: 'codex', nativeSessionId: 'worktree-cold-child-native', sessionId: 'worktree-cold-child-official' })
    expect(records(restored.agent.session)).toEqual(before)
    expect(projections.stateOf(restored.agent.session, 'bridgeKernel')?.inheritedBinding).toEqual({ backend: 'codex', nativeSessionId: 'worktree-parent-codex', sessionId: parent.agent.id })
    expect(errors).toEqual([])
    await restored.dispose()
    await session.remove(restored.agent.id)
    expect(close).toHaveBeenCalledOnce()
    expect(resumed.dispose).toHaveBeenCalledOnce()
  }, 10_000)

  it.each([false, true])('rejects parent-id ACK without a fallback when parent native ownership was closed=%s', async (closed) => {
    const { handle: parent, connection: original } = await conversation()
    const prefix = parent.agent.session.snapshotEvents()
    if (closed)
      await session.remove(parent.agent.id)
    const duplicate = native('worktree-parent-codex')
    vi.mocked(createCodexSession).mockResolvedValueOnce(duplicate)
    await expect(fork(parent.agent, 'worktree-invalid-same-id')).rejects.toThrow(closed ? 'BRIDGE_FORK_MISMATCH' : 'BRIDGE_NATIVE_OWNER_CONFLICT')
    expect(createCodexSession).toHaveBeenCalledTimes(2)
    expect(vi.mocked(createCodexSession).mock.calls[1]![2]).toBeNull()
    expect(vi.mocked(createCodexSession).mock.calls[1]![5]).toEqual({ forkFrom: 'worktree-parent-codex' })
    expect(createClaudeSession).not.toHaveBeenCalled()
    expect(duplicate.dispose).toHaveBeenCalledOnce()
    expect(duplicate.submit).not.toHaveBeenCalled()
    expect(original.submit).toHaveBeenCalledOnce()
    expect(agents.get(sessionModule.SessionId('worktree-invalid-same-id'))).toBeUndefined()
    expect(sessions.get(sessionModule.SessionId('worktree-invalid-same-id'))).toBeUndefined()
    expect(prepared[1]!.snapshotEvents()).toEqual([...prefix, { seq: prefix.length, time: now, type: 'session/end-seed', data: { inherited: true } }])
    expect(announced).toEqual([parent.agent])
    expect(identity.resolve(parent.agent)).toEqual({ backend: 'codex', nativeSessionId: 'worktree-parent-codex', sessionId: parent.agent.id })
  }, 10_000)

  it('reports a native conversation that no longer exists instead of opening a replacement', async () => {
    const { handle, connection } = await conversation()
    await session.remove(handle.agent.id, handle.agent)
    expect(connection.dispose).toHaveBeenCalledOnce()
    vi.mocked(createCodexSession).mockRejectedValueOnce(new Error('["No conversation found with session ID: gone-native"]'))
    await expect(session.connect(handle.agent, new AbortController().signal)).rejects.toThrow('BRIDGE_SESSION_UNRECOVERABLE: 原生会话记录已不存在，请新建会话。')
    expect(createCodexSession).toHaveBeenCalledTimes(2)
    expect(vi.mocked(createCodexSession).mock.calls[1]![2]).toBe('worktree-parent-codex')
    expect(runtime.sessions.size).toBe(0)
  }, 10_000)

  it('rolls back a rejected native fork without reusing or restoring the parent native session', async () => {
    const { handle: parent, connection: original } = await conversation()
    const prefix = parent.agent.session.snapshotEvents()
    const failure = new Error('native fork refused the source conversation')
    vi.mocked(createCodexSession).mockRejectedValueOnce(failure)
    await expect(fork(parent.agent, 'worktree-refused')).rejects.toBe(failure)
    expect(prepared[1]!.snapshotEvents()).toEqual([...prefix, { seq: prefix.length, time: now, type: 'session/end-seed', data: { inherited: true } }])
    expect(agents.get(sessionModule.SessionId('worktree-refused'))).toBeUndefined()
    expect(sessions.get(sessionModule.SessionId('worktree-refused'))).toBeUndefined()
    expect(announced).toEqual([parent.agent])
    expect(createCodexSession).toHaveBeenCalledTimes(2)
    expect(vi.mocked(createCodexSession).mock.calls[1]![2]).toBeNull()
    expect(vi.mocked(createCodexSession).mock.calls[1]![5]).toEqual({ forkFrom: 'worktree-parent-codex' })
    expect(createClaudeSession).not.toHaveBeenCalled()
    expect(original.dispose).not.toHaveBeenCalled()
    expect(original.submit).toHaveBeenCalledOnce()
    expect(runtime.sessions.size).toBe(1)
    expect(runtime.claims.size).toBe(1)
  }, 10_000)

  it('awaits native disposal when a later unpublished setup hook rejects after the independent ACK', async () => {
    const { handle: parent, connection: original } = await conversation()
    const connection = native('worktree-post-ack-failure')
    const failure = new Error('later unpublished worktree setup refused')
    vi.mocked(createCodexSession).mockResolvedValueOnce(connection)
    await expect(fork(parent.agent, 'worktree-unpublished-failure', new AbortController().signal, async () => {
      throw failure
    })).rejects.toBe(failure)
    expect(connection.dispose).toHaveBeenCalledOnce()
    expect(connection.submit).not.toHaveBeenCalled()
    expect(agents.get(sessionModule.SessionId('worktree-unpublished-failure'))).toBeUndefined()
    expect(sessions.get(sessionModule.SessionId('worktree-unpublished-failure'))).toBeUndefined()
    expect(runtime.claims.has('codex:worktree-post-ack-failure')).toBe(false)
    expect(runtime.sessions.has('worktree-unpublished-failure')).toBe(false)
    expect(announced).toEqual([parent.agent])
    expect(original.dispose).not.toHaveBeenCalled()
    expect(original.submit).toHaveBeenCalledOnce()
  }, 10_000)

  it('does not publish a distinct native ACK when official storage rejects the child seed and setup suffix', async () => {
    const { handle: parent, connection: original } = await conversation()
    const connection = native('worktree-storage-failure')
    const failure = new Error('official worktree append refused')
    const close = vi.fn().mockResolvedValue(undefined)
    const append = vi.fn().mockRejectedValue(failure)
    const createStored = persistence!.create.bind(persistence!)
    vi.spyOn(persistence!, 'create').mockImplementationOnce(async (...args) => {
      const handle = await createStored(...args)
      handle.append = append
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        await close()
        await handle[Symbol.asyncDispose]()
      })
      return handle
    })
    vi.mocked(createCodexSession).mockResolvedValueOnce(connection)
    await expect(fork(parent.agent, 'worktree-storage-official')).rejects.toBe(failure)
    expect(append).toHaveBeenCalledOnce()
    expect(append.mock.calls[0]![0]).toEqual(prepared[1]!.snapshotEvents())
    expect(close).toHaveBeenCalledOnce()
    expect(connection.dispose).toHaveBeenCalledOnce()
    expect(connection.submit).not.toHaveBeenCalled()
    expect(agents.get(sessionModule.SessionId('worktree-storage-official'))).toBeUndefined()
    expect(sessions.get(sessionModule.SessionId('worktree-storage-official'))).toBeUndefined()
    expect(announced).toEqual([parent.agent])
    expect(runtime.claims.has('codex:worktree-storage-failure')).toBe(false)
    expect(original.dispose).not.toHaveBeenCalled()
    expect(original.submit).toHaveBeenCalledOnce()
    expect(createCodexSession).toHaveBeenCalledTimes(2)
  }, 10_000)

  it('blocks the first published child prompt after its own binding checkpoint fails and retries without re-forking', async () => {
    const { handle: parent, connection: original } = await conversation()
    const connection = native('worktree-binding-checkpoint-native')
    vi.mocked(createCodexSession).mockImplementationOnce(async (_command, _cwd, _storedId, output) => {
      connection.submit.mockImplementation(async () => output.assistant('child-durable-answer', [{ type: 'text', text: 'the child-owned binding was saved' }]))
      return connection
    })
    const child = await fork(parent.agent, 'worktree-binding-checkpoint-official')
    const cut = child.agent.session.inheritedEventCount
    const binding = { backend: 'codex', nativeSessionId: 'worktree-binding-checkpoint-native', sessionId: 'worktree-binding-checkpoint-official' }
    const before = records(child.agent.session)
    const failure = new Error('worktree own binding durability refused')
    persistence!.barrier = async () => {
      throw failure
    }
    await followup(child.agent, 'must not run without the saved child identity')
    expect(connection.submit).not.toHaveBeenCalled()
    expect(original.submit).toHaveBeenCalledOnce()
    expect(createCodexSession).toHaveBeenCalledTimes(2)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ name: 'LlmError', code: 'UNKNOWN', message: 'worktree own binding durability refused', failure: { code: 'UNKNOWN', message: 'worktree own binding durability refused' } })
    expect(persistence!.stored.get(child.agent.id)?.durable.some(event => event.seq === cut + 1)).toBe(false)
    expect(identity.resolve(child.agent)).toEqual(binding)
    expect(records(child.agent.session)).toEqual(before)
    expect(runtime.exchanges.size).toBe(0)
    persistence!.barrier = async () => {}
    await followup(child.agent, 'run the same child once its identity is durable')
    expect(connection.submit).toHaveBeenCalledOnce()
    expect(connection.submit.mock.calls[0]![2]).toEqual({ model: null, reasoningEffort: null })
    expect(original.submit).toHaveBeenCalledOnce()
    expect(createCodexSession).toHaveBeenCalledTimes(2)
    expect(vi.mocked(createCodexSession).mock.calls[1]![2]).toBeNull()
    expect(vi.mocked(createCodexSession).mock.calls[1]![5]).toEqual({ forkFrom: 'worktree-parent-codex' })
    expect(persistence!.stored.get(child.agent.id)?.durable.find(event => event.seq === cut + 1)).toEqual({ seq: cut + 1, time: now, type: 'plugin:dsh-tauri-bridge/kernel', ignorable: true, data: binding })
    expect(records(child.agent.session)).toEqual(before)
    expect(errors).toHaveLength(1)
    expect(identity.resolve(parent.agent)).toEqual({ backend: 'codex', nativeSessionId: 'worktree-parent-codex', sessionId: parent.agent.id })
  }, 10_000)

  it('aborts the whole unpublished factory after native ACK when bridge scope ends during a later setup hook', async () => {
    const { handle: parent, connection: original } = await conversation()
    const connection = native('worktree-whole-factory-aborted')
    const setupStarted = deferred<void>()
    const setupGate = deferred<void>()
    const setupFinished = deferred<void>()
    const drainStarted = deferred<void>()
    const drain = deferred<void>()
    releases.push(() => setupGate.resolve(), () => drain.resolve())
    connection.dispose.mockImplementation(async () => {
      drainStarted.resolve()
      await drain.promise
    })
    vi.mocked(createCodexSession).mockResolvedValueOnce(connection)
    const task = fork(parent.agent, 'worktree-whole-factory-official', new AbortController().signal, async () => {
      setupStarted.resolve()
      await setupGate.promise
      setupFinished.resolve()
    })
    const rejected = expect(task).rejects.toThrow('BRIDGE_DISPOSED')
    background.push(rejected)
    let settled = false
    const observed = task.then(() => {
      settled = true
    }, () => {
      settled = true
    })
    background.push(observed)
    await setupStarted.promise
    const child = prepared[1]!
    const before = child.snapshotEvents()
    expect(agents.get(child.id)).toBeUndefined()
    expect(sessions.get(child.id)).toBeUndefined()
    expect(announced).toEqual([parent.agent])
    const closing = session.dispose()
    background.push(closing)
    await drainStarted.promise
    expect(settled).toBe(false)
    expect(vi.mocked(createCodexSession).mock.calls[1]![4].aborted).toBe(true)
    expect(connection.submit).not.toHaveBeenCalled()
    setupGate.resolve()
    await setupFinished.promise
    expect(agents.get(child.id)).toBeUndefined()
    expect(sessions.get(child.id)).toBeUndefined()
    expect(child.snapshotEvents()).toEqual(before)
    drain.resolve()
    await Promise.all([rejected, observed, closing])
    expect(connection.dispose).toHaveBeenCalledOnce()
    expect(connection.submit).not.toHaveBeenCalled()
    expect(announced).toEqual([parent.agent])
    expect(runtime.sessions.has(child.id)).toBe(false)
    expect(runtime.claims.has('codex:worktree-whole-factory-aborted')).toBe(false)
    expect(createCodexSession).toHaveBeenCalledTimes(2)
    expect(original.submit).toHaveBeenCalledOnce()
    expect(errors).toEqual([])
  }, 10_000)

  it('refuses a stale inherited cut before contacting the native fork boundary', async () => {
    const { handle: parent } = await conversation()
    const stale = parent.agent.session.snapshotEvents()
    sessionModule.appendPluginRecord!(parent.agent.session, 'plugin:dsh-tauri-bridge/kernel', identity.resolve(parent.agent))
    const task = context.nativeSessionBridge.create(parent.agent.session, () => agents.create({
      sessionId: sessionModule.SessionId('worktree-stale-cut'),
      seed: stale,
      inheritedEventCount: sessionModule.SessionLogOffset(stale.length),
      meta: { cwd, parentSession: parent.agent.id, isSeeded: true },
      agentOptions: parent.agent.options,
      setup: (_ctx, agent) => context.nativeSessionBridge.prepare(parent.agent.session, agent, new AbortController().signal),
    }))
    await expect(task).rejects.toThrow('BRIDGE_FORK_SOURCE_CHANGED')
    expect(createCodexSession).toHaveBeenCalledOnce()
    expect(createClaudeSession).not.toHaveBeenCalled()
    expect(agents.get(sessionModule.SessionId('worktree-stale-cut'))).toBeUndefined()
    expect(sessions.get(sessionModule.SessionId('worktree-stale-cut'))).toBeUndefined()
    expect(announced).toEqual([parent.agent])
  }, 10_000)

  it('refuses a parent changed during native fork instead of silently inheriting a newer history', async () => {
    const { handle: parent, connection: original } = await conversation()
    const ack = deferred<NativeSession>()
    const started = deferred<void>()
    const connection = native('worktree-raced-source')
    releases.push(() => ack.resolve(connection))
    vi.mocked(createCodexSession).mockImplementationOnce(async () => {
      started.resolve()
      return ack.promise
    })
    const task = fork(parent.agent, 'worktree-raced-official')
    const rejected = expect(task).rejects.toThrow('BRIDGE_FORK_SOURCE_CHANGED')
    background.push(rejected)
    await started.promise
    sessionModule.appendPluginRecord!(parent.agent.session, 'plugin:dsh-tauri-bridge/kernel', identity.resolve(parent.agent))
    ack.resolve(connection)
    await rejected
    expect(connection.dispose).toHaveBeenCalledOnce()
    expect(connection.submit).not.toHaveBeenCalled()
    expect(prepared[1]!.snapshotEvents().slice(prepared[1]!.inheritedEventCount)).toEqual([{ seq: prepared[1]!.inheritedEventCount, time: now, type: 'session/end-seed', data: { inherited: true } }])
    expect(agents.get(sessionModule.SessionId('worktree-raced-official'))).toBeUndefined()
    expect(sessions.get(sessionModule.SessionId('worktree-raced-official'))).toBeUndefined()
    expect(original.dispose).not.toHaveBeenCalled()
    expect(original.submit).toHaveBeenCalledOnce()
    expect(createCodexSession).toHaveBeenCalledTimes(2)
  }, 10_000)

  it.each(['cancel', 'unload'] as const)('aborts an unpublished worktree fork on %s and awaits disposal of a late distinct ACK', async (reason) => {
    const { handle: parent, connection: original } = await conversation()
    const ack = deferred<NativeSession>()
    const started = deferred<void>()
    const drain = deferred<void>()
    const drainStarted = deferred<void>()
    const connection = native(`worktree-late-${reason}`)
    const controller = new AbortController()
    releases.push(() => ack.resolve(connection), () => drain.resolve())
    vi.mocked(createCodexSession).mockImplementationOnce(async () => {
      started.resolve()
      return ack.promise
    })
    connection.dispose.mockImplementation(async () => {
      drainStarted.resolve()
      await drain.promise
    })
    const task = fork(parent.agent, `worktree-late-official-${reason}`, controller.signal)
    const rejected = expect(task).rejects.toThrow(reason === 'cancel' ? 'worktree creation cancelled' : 'BRIDGE_DISPOSED')
    background.push(rejected)
    await started.promise
    const child = prepared[1]!
    let settled = false
    const observed = task.then(() => {
      settled = true
    }, () => {
      settled = true
    })
    background.push(observed)
    let closing: Promise<void> | undefined
    if (reason === 'cancel') {
      controller.abort(new Error('worktree creation cancelled'))
    }
    else {
      closing = session.dispose()
      background.push(closing)
    }
    expect(vi.mocked(createCodexSession).mock.calls[1]![4].aborted).toBe(true)
    expect(agents.get(child.id)).toBeUndefined()
    expect(sessions.get(child.id)).toBeUndefined()
    ack.resolve(connection)
    await drainStarted.promise
    expect(settled).toBe(false)
    expect(connection.submit).not.toHaveBeenCalled()
    expect(child.snapshotEvents().slice(child.inheritedEventCount)).toEqual([{ seq: child.inheritedEventCount, time: now, type: 'session/end-seed', data: { inherited: true } }])
    drain.resolve()
    await Promise.all([rejected, observed, closing])
    expect(connection.dispose).toHaveBeenCalledOnce()
    expect(connection.submit).not.toHaveBeenCalled()
    expect(original.submit).toHaveBeenCalledOnce()
    expect(announced).toEqual([parent.agent])
    expect(runtime.pending.size).toBe(0)
    expect(runtime.sessions.has(child.id)).toBe(false)
    expect(runtime.claims.has(`codex:worktree-late-${reason}`)).toBe(false)
    expect(createCodexSession).toHaveBeenCalledTimes(2)
    expect(createClaudeSession).not.toHaveBeenCalled()
  }, 10_000)
})

describe('official cold native route restoration', () => {
  let controller: InstanceType<typeof ApiSessionAgentController>
  let query: InstanceType<typeof SessionQueryEngine>
  const defaultSelection = { provider: 'cloud-provider', model: 'global-default' }

  beforeEach(() => {
    persistence = new MemoryPersistence(context)
    context.on('session/flush', async (official) => {
      const stored = persistence!.stored.get(official.id)!
      const writer = persistence!.writers.get(official.id)!
      const suffix = official.snapshotEvents().slice(stored.events.length)
      if (suffix.length > 0)
        await writer.append(suffix)
      await writer.flush()
    })
    installModelSelectionProjection(context)
    context.provide('agentDefaultModel', { currentSelection: () => defaultSelection } as HostContext['agentDefaultModel'])
    context.provide('typert', {
      lookups: { configure: vi.fn() },
      contexts: { configureHost: vi.fn() },
    } as unknown as HostContext['typert'])
    query = new SessionQueryEngine(context)
    controller = new ApiSessionAgentController(context)
    context.provide('sessionController', { resolveAgent: controller.resolveAgent.bind(controller) } as HostContext['sessionController'])
  })

  it.each(['codex', 'claude'] as const)('restores the first %s cold request through the real API controller without a setup header', async (id) => {
    const factory = vi.mocked(id === 'codex' ? createCodexSession : createClaudeSession)
    const original = native(`api-cold-${id}`)
    factory.mockResolvedValueOnce(original)
    await creating(id)
    const previous = officialHandle!
    const before = restoreSerialized(previous.agent.session)
    const binding = { backend: id, nativeSessionId: original.id, sessionId: previous.agent.id }
    expect(before.requestHeader()).toBeUndefined()
    await previous.dispose()
    await session.remove(previous.agent.id)
    expect(sessions.get(previous.agent.id)).toBeUndefined()
    expect(agents.get(previous.agent.id)).toBeUndefined()
    const observed = await query.observeSession(previous.agent.id)
    expect(observed.header.id).toBe(previous.agent.id)
    expect(observed.events).toEqual(previous.agent.session.snapshotEvents())
    observed[Symbol.dispose]()
    const found = await controller.resolveAgent(previous.agent.id)
    expect(found).not.toHaveProperty('error')
    if ('error' in found)
      throw found.error
    const restored = found.agent
    expect(restored.session.requestHeader()).toBeUndefined()
    expect(identity.resolve(restored)).toEqual(binding)
    expect(factory).toHaveBeenCalledOnce()
    expect(runtime.coldRoutes.has(restored)).toBe(true)
    const resumed = native(original.id)
    factory.mockImplementationOnce(async (_command, _cwd, storedId, output) => {
      expect(storedId).toBe(original.id)
      resumed.submit.mockImplementation(async () => output.assistant('api-cold-answer', [{ type: 'text', text: 'the bound native session continued' }]))
      return resumed
    })
    await followup(restored, 'continue the cold native session')
    expect(errors).toEqual([])
    expect(restored.options).toMatchObject({ provider: BRIDGE_PROVIDER, model: id })
    expect(factory).toHaveBeenCalledTimes(2)
    expect(resumed.submit).toHaveBeenCalledOnce()
    expect(resumed.submit.mock.calls[0]![2]).toEqual({ model: null, reasoningEffort: null })
    const replayed = restoreSerialized(restored.session)
    expect(replayed.requestHeader()?.config).toEqual({ provider: BRIDGE_PROVIDER, model: id })
    expect(replayed.snapshotEvents().filter(event => event.type === 'request/header').map(event => event.data.reason)).toEqual(['initial'])
    expect(runtime.coldRoutes.has(restored)).toBe(false)
    expect(records(replayed)).toEqual(records(before))
    expect(replayed.deriveMessages().map(message => ({ role: message.role, content: message.content }))).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'continue the cold native session' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'the bound native session continued' }] },
    ])
  }, 10_000)

  it.each([
    { provider: 'cloud-provider', model: 'global-default' },
    { provider: 'dsh-tauri-bridge', model: 'claude' },
    { provider: 'dsh-tauri-bridge', model: 'codex', reasoningEffort: llmModule.ReasoningEffortId('high') },
  ])('rejects an explicit cold model selection instead of restoring over it: %j', async (selected) => {
    const original = native('api-cold-selected')
    vi.mocked(createCodexSession).mockResolvedValueOnce(original)
    await creating()
    const previous = officialHandle!
    await previous.dispose()
    await session.remove(previous.agent.id)
    const found = await controller.resolveAgent(previous.agent.id)
    expect(found).not.toHaveProperty('error')
    if ('error' in found)
      throw found.error
    controller.selectForNextRequest(found.agent, selected)
    await followup(found.agent, 'reject switching the bound native kernel')
    expect(errors).toEqual([expect.objectContaining({ message: 'BRIDGE_KERNEL_IMMUTABLE: 已绑定会话不能切换内核或由 DSH 覆写原生选项。' })])
    expect(createCodexSession).toHaveBeenCalledOnce()
    expect(createClaudeSession).not.toHaveBeenCalled()
    expect(original.submit).not.toHaveBeenCalled()
    expect(found.agent.session.requestHeader()).toBeUndefined()
    expect(found.agent.session.snapshotEvents().filter((event: SessionEvent) => event.type === 'model/selection').map((event: SessionEvent) => event.data)).toEqual([selected])
    expect(identity.resolve(found.agent)).toEqual({ backend: 'codex', nativeSessionId: original.id, sessionId: previous.agent.id })
    expect(runtime.coldRoutes.has(found.agent)).toBe(false)
    expect(() => restoreSerialized(found.agent.session)).not.toThrow()
  }, 10_000)

  it.each([
    { provider: 'foreign-provider', model: 'global-default' },
    { provider: 'cloud-provider', model: 'foreign-model' },
    { provider: 'cloud-provider', model: 'global-default', reasoningEffort: llmModule.ReasoningEffortId('high') },
    { provider: 'cloud-provider', model: 'global-default', maxTokens: 1 },
    { provider: 'cloud-provider', model: 'global-default', temperature: 0 },
    { provider: 'cloud-provider', model: 'global-default', stop: ['stop'] },
  ])('rejects nondefault cold request overrides without a native submission: %j', async (override) => {
    const original = native('api-cold-overrides')
    vi.mocked(createCodexSession).mockResolvedValueOnce(original)
    await creating()
    const previous = officialHandle!
    await previous.dispose()
    await session.remove(previous.agent.id)
    const found = await controller.resolveAgent(previous.agent.id)
    expect(found).not.toHaveProperty('error')
    if ('error' in found)
      throw found.error
    const started = deferred<AbortSignal>()
    const gate = deferred<void>()
    releases.push(() => gate.resolve())
    context.on('agent/pre-step', async ({ signal }) => {
      started.resolve(signal)
      await gate.promise
      return { kind: 'reject' }
    }, { global: true, prepend: true })
    const turn = followup(found.agent, 'reject overriding native options during cold resume')
    const signal = await started.promise
    await expect(adapter.request({ agent: found.agent, signal }, async () => override)).rejects.toThrow('BRIDGE_KERNEL_IMMUTABLE: 已绑定会话不能切换内核或由 DSH 覆写原生选项。')
    expect(createCodexSession).toHaveBeenCalledOnce()
    expect(original.submit).not.toHaveBeenCalled()
    expect(found.agent.session.requestHeader()).toBeUndefined()
    expect(identity.resolve(found.agent)).toEqual({ backend: 'codex', nativeSessionId: original.id, sessionId: previous.agent.id })
    gate.resolve()
    await turn
    expect(errors).toEqual([])
    expect(() => restoreSerialized(found.agent.session)).not.toThrow()
  }, 10_000)

  it.each(['codex', 'claude'] as const)('hydrates an empty %s worktree route from its committed child binding', async (id) => {
    const factory = vi.mocked(id === 'codex' ? createCodexSession : createClaudeSession)
    const original = native(`api-empty-parent-${id}`)
    factory.mockResolvedValueOnce(original)
    await creating(id)
    const previous = officialHandle!
    await previous.dispose()
    await session.remove(previous.agent.id)
    const found = await controller.resolveAgent(previous.agent.id)
    expect(found).not.toHaveProperty('error')
    if ('error' in found)
      throw found.error
    const source = found.agent.session
    const connection = native(`api-empty-child-${id}`)
    factory.mockImplementationOnce(async (_command, _cwd, _storedId, output) => {
      connection.submit.mockImplementation(async () => output.assistant('api-empty-child-answer', [{ type: 'text', text: 'the independent empty-source worktree continued' }]))
      return connection
    })
    const child = await context.nativeSessionBridge.create(source, signal => agents.create({
      sessionId: sessionModule.SessionId(`api-empty-child-official-${id}`),
      seed: source.snapshotEvents(),
      inheritedEventCount: source.seq,
      meta: { cwd, parentSession: source.id, isSeeded: true },
      agentOptions: {},
      signal,
      setup: (_agentCtx, agent) => context.nativeSessionBridge.prepare(source, agent, signal!),
    }))
    expect(identity.resolve(child.agent)).toEqual({ backend: id, nativeSessionId: connection.id, sessionId: child.agent.id })
    expect(child.agent.session.requestHeader()).toBeUndefined()
    expect(() => restoreSerialized(child.agent.session)).not.toThrow()
    await followup(child.agent, 'continue the cold empty-source worktree')
    expect(errors).toEqual([])
    expect(child.agent.options).toEqual({ provider: BRIDGE_PROVIDER, model: id })
    expect(connection.submit).toHaveBeenCalledOnce()
    expect(original.submit).not.toHaveBeenCalled()
    expect(factory).toHaveBeenCalledTimes(2)
    expect(factory.mock.calls[1]![5]).toBeUndefined()
    expect(restoreSerialized(child.agent.session).requestHeader()?.config).toEqual({ provider: BRIDGE_PROVIDER, model: id })
  }, 10_000)
})

describe('official native session lifecycle', () => {
  it.each(['codex', 'claude'] as const)('round-trips the official V4 serializer before and after the first %s native turn', async (id) => {
    const connection = native(`serialized-native-${id}`)
    const factory = vi.mocked(id === 'codex' ? createCodexSession : createClaudeSession)
    factory.mockImplementationOnce(async (_command, _cwd, _storedId, output) => {
      connection.submit.mockImplementation(async () => output.assistant('serialized-native-answer', [{ type: 'text', text: 'serialized native reply' }]))
      return connection
    })
    await creating(id)
    const agent = officialHandle!.agent
    expect(() => restoreSerialized(agent.session)).not.toThrow()
    expect(agent.session.snapshotEvents().map(event => event.type)).toEqual(['plugin:dsh-tauri-bridge/kernel'])
    expect(agent.session.requestHeader()).toBeUndefined()
    expect(agent.options).toMatchObject({ provider: BRIDGE_PROVIDER, model: id })
    expect(connection.submit).not.toHaveBeenCalled()
    await followup(agent, 'persist one real native reply')
    expect(errors).toEqual([])
    expect(connection.submit).toHaveBeenCalledOnce()
    expect(agent.session.snapshotEvents().filter(event => event.type === 'request/header').map(event => event.data.reason)).toEqual(['initial'])
    const restored = restoreSerialized(agent.session)
    expect(restored.requestHeader()?.config).toEqual({ provider: BRIDGE_PROVIDER, model: id })
    expect(records(restored)).toEqual(records(agent.session))
    expect(restored.deriveMessages().map(message => ({ role: message.role, content: message.content }))).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'persist one real native reply' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'serialized native reply' }] },
    ])
  }, 10_000)

  it('connects Codex with unknown login status and leaves provider authentication native-owned', async () => {
    vi.mocked(detectBackend).mockResolvedValue({
      detection: { id: 'codex', installed: true, auth: 'unknown', version: 'test', drift: false, hint: 'Check native provider authentication' },
      command: { file: 'boundary-only', args: ['codex'] },
    })
    const connection = native('custom-provider-thread')
    vi.mocked(createCodexSession).mockResolvedValue(connection)
    const result = await creating()
    expect(identity.resolve(officialHandle!.agent)).toEqual({ backend: 'codex', nativeSessionId: 'custom-provider-thread', sessionId: result.sessionId })
    expect(createCodexSession).toHaveBeenCalledOnce()
    expect(createClaudeSession).not.toHaveBeenCalled()
    expect(connection.submit).not.toHaveBeenCalled()
  }, 10_000)

  it('rejects explicitly missing Claude authentication before starting a native process', async () => {
    vi.mocked(detectBackend).mockResolvedValue({
      detection: { id: 'claude', installed: true, auth: 'missing', version: 'test', drift: false, hint: '请先在终端运行 claude auth login。' },
      command: { file: 'boundary-only', args: ['claude'] },
    })
    await expect(creating('claude')).rejects.toThrow('请先在终端运行 claude auth login。')
    expect(createClaudeSession).not.toHaveBeenCalled()
    expect(createCodexSession).not.toHaveBeenCalled()
    expect(runtime.sessions.size).toBe(0)
  }, 10_000)

  it.each(['codex', 'claude'] as const)('publishes %s only after native ACK and official identity commit', async (id) => {
    const ack = deferred<NativeSession>()
    const started = deferred<void>()
    const connection = native(`native-${id}`)
    releases.push(() => ack.resolve(connection))
    const factory = vi.mocked(id === 'codex' ? createCodexSession : createClaudeSession)
    factory.mockImplementation(async () => {
      started.resolve()
      return ack.promise
    })
    const task = creating(id, 'test-workspace')
    await started.promise
    expect(prepared).toHaveLength(1)
    const official = prepared[0]!
    expect(records(official)).toEqual([])
    expect(projections.stateOf(official, 'bridgeKernel')?.binding).toBeNull()
    expect(official.requestHeader()).toBeUndefined()
    expect(agents.get(official.id)).toBeUndefined()
    expect(sessions.get(official.id)).toBeUndefined()
    expect(announced).toEqual([])
    expect(attachSession).not.toHaveBeenCalled()
    expect(mount).toHaveBeenCalledOnce()
    expect(factory.mock.calls[0]![2]).toBeNull()
    ack.resolve(connection)
    const result = await task
    expect(result).toEqual({ sessionId: official.id })
    expect(officialHandle!.agent.session).toBe(official)
    expect(agents.get(official.id)).toBe(officialHandle!.agent)
    expect(sessions.get(official.id)).toBe(official)
    const binding = { backend: id, nativeSessionId: connection.id, sessionId: official.id }
    expect(records(official)).toMatchObject([{ type: 'plugin:dsh-tauri-bridge/kernel', data: binding }])
    expect(official.snapshotEvents().find(event => (event.type as string) === 'plugin:dsh-tauri-bridge/kernel')).toMatchObject({ ignorable: true, data: binding })
    expect(identity.resolve(officialHandle!.agent)).toEqual(binding)
    expect(official.requestHeader()).toBeUndefined()
    expect(officialHandle!.agent.options).toMatchObject({ provider: BRIDGE_PROVIDER, model: id })
    expect(announced).toEqual([officialHandle!.agent])
    expect(attachSession).toHaveBeenCalledExactlyOnceWith(official.id)
    expect(connection.submit).not.toHaveBeenCalled()
  }, 10_000)

  it('drives two native tool calls through core-owned steps with one native submission', async () => {
    const connection = native('multi-tool-native')
    vi.mocked(createCodexSession).mockImplementation(async (_command, _cwd, _storedId, output) => {
      connection.submit.mockImplementation(async () => {
        output.text('work', 'before tools')
        output.assistant('work', [
          { type: 'text', text: 'before tools' },
          { type: 'tool-call', id: 'native-call-1', name: 'native_first', arguments: '{"path":"one"}' },
          { type: 'tool-call', id: 'native-call-2', name: 'native_second', arguments: '{"path":"two"}' },
        ])
        output.toolStart('native-call-1', 'native_first', '{"path":"one"}')
        output.toolEnd('native-call-1', 'first native result')
        output.toolStart('native-call-2', 'native_second', '{"path":"two"}')
        output.toolEnd('native-call-2', 'second native result')
        output.assistant('tail', [{ type: 'text', text: 'after tools' }])
      })
      return connection
    })
    await creating()
    const agent = officialHandle!.agent
    const { events } = observe(agent)
    await followup(agent, 'complete the native work')
    expect(errors).toEqual([])
    expect(createCodexSession).toHaveBeenCalledOnce()
    expect(connection.submit).toHaveBeenCalledOnce()
    expect(connection.submit.mock.calls[0]![0]).toMatchObject([{ content: [{ type: 'text', text: 'complete the native work' }] }])
    expect(events.filter(event => event.type === 'step/start').map(event => event.data)).toEqual([{ turn: 1, step: 1 }, { turn: 1, step: 2 }])
    expect(events.filter(event => event.type === 'step/end').map(event => event.data)).toEqual([{ turn: 1, step: 1 }, { turn: 1, step: 2 }])
    expect(events.filter(event => event.type === 'assistant/message').map(event => ({ turn: event.data.turn, step: event.data.step, content: event.data.message.content }))).toEqual([
      { turn: 1, step: 1, content: [
        { type: 'text', text: 'before tools' },
        { type: 'tool-call', id: 'native-call-1', name: 'native_first', arguments: '{"path":"one"}' },
        { type: 'tool-call', id: 'native-call-2', name: 'native_second', arguments: '{"path":"two"}' },
      ] },
      { turn: 1, step: 2, content: [{ type: 'text', text: 'after tools' }] },
    ])
    expect(events.filter(event => event.type === 'tool/call').map(event => event.data)).toEqual([
      { turn: 1, step: 1, callId: 'native-call-1', name: 'native_first', arguments: '{"path":"one"}' },
      { turn: 1, step: 1, callId: 'native-call-2', name: 'native_second', arguments: '{"path":"two"}' },
    ])
    expect(events.filter(event => event.type === 'tool/result').map(event => ({ turn: event.data.turn, step: event.data.step, id: event.data.message.toolCallId, content: event.data.message.content, isError: event.data.message.isError === true }))).toEqual([
      { turn: 1, step: 1, id: 'native-call-1', content: [{ type: 'text', text: 'first native result' }], isError: false },
      { turn: 1, step: 1, id: 'native-call-2', content: [{ type: 'text', text: 'second native result' }], isError: false },
    ])
    const firstToolCall = events.findIndex(event => event.type === 'tool/call')
    const lastToolResult = events.findLastIndex(event => event.type === 'tool/result')
    expect(events[firstToolCall - 1]?.type).toBe('assistant/message')
    expect(events.findIndex(event => event.type === 'step/start' && event.data.step === 2)).toBeGreaterThan(lastToolResult)
    expect(events.filter(event => event.type === 'turn/start').map(event => event.data)).toEqual([{ turn: 1 }])
    expect(events.filter(event => event.type === 'turn/end').map(event => event.data)).toEqual([{ turn: 1, reason: { kind: 'completed' } }])
    expect(runtime.exchanges.size).toBe(0)
    expect(connection.dispose).not.toHaveBeenCalled()
  }, 10_000)

  it('waits for native tool results without running a registered DSH tool body', async () => {
    const body = vi.fn().mockResolvedValue('DSH must never execute this')
    const tool: ToolDefinition = {
      name: 'native_file',
      description: 'a real globally registered DSH body',
      parameters: { type: 'object', additionalProperties: true },
      output: { schema: { type: 'string' }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }] },
      execute: body,
    }
    context.tools.register(tool)
    const delivered = deferred<void>()
    const dispatched = deferred<void>()
    const connection = native('wait-only-native')
    releases.push(() => delivered.resolve())
    vi.mocked(createCodexSession).mockImplementation(async (_command, _cwd, _storedId, output) => {
      connection.submit.mockImplementation(async () => {
        output.assistant('tool-request', [{ type: 'tool-call', id: 'native-wait', name: 'native_file', arguments: '{"path":"file.txt"}' }])
        output.toolStart('native-wait', 'native_file', '{"path":"file.txt"}')
        await delivered.promise
        output.toolEnd('native-wait', 'native file content')
        output.assistant('finished', [{ type: 'text', text: 'native task finished' }])
      })
      return connection
    })
    await creating()
    const agent = officialHandle!.agent
    const { events } = observe(agent)
    agent.ctx.on('tools/execute', async (exec, next) => {
      if (exec.callId === 'native-wait')
        dispatched.resolve()
      return next()
    })
    let idle = false
    const turn = followup(agent, 'read through the native kernel').then(() => {
      idle = true
    })
    background.push(turn)
    await dispatched.promise
    expect(idle).toBe(false)
    expect(body).not.toHaveBeenCalled()
    expect(connection.submit).toHaveBeenCalledOnce()
    expect(events.filter(event => event.type === 'tool/result')).toEqual([])
    expect(agent.ctx.tools.get('native_file', agent)?.description).toBe('等待本机内核已经发起的工具结果；不执行 DSH 工具。')
    delivered.resolve()
    await turn
    expect(errors).toEqual([])
    expect(body).not.toHaveBeenCalled()
    expect(events.filter(event => event.type === 'tool/result').map(event => event.data.message)).toMatchObject([
      { role: 'tool', toolCallId: 'native-wait', content: [{ type: 'text', text: 'native file content' }] },
    ])
    expect(agent.ctx.tools.get('native_file', agent)?.description).toBe(tool.description)
    expect(context.tools.get('native_file')?.execute).toBe(body)
    expect(runtime.exchanges.size).toBe(0)
    expect(connection.dispose).not.toHaveBeenCalled()
  }, 10_000)

  it('publishes standard assistant stream frames matching each durable core settlement', async () => {
    const connection = native('stream-frames-native')
    vi.mocked(createCodexSession).mockImplementation(async (_command, _cwd, _storedId, output) => {
      connection.submit.mockImplementation(async () => {
        output.thinking('thought-and-call', 'native reasoning')
        output.text('thought-and-call', 'native preface')
        output.assistant('thought-and-call', [
          { type: 'thinking', text: 'native reasoning' },
          { type: 'text', text: 'native preface' },
          { type: 'tool-call', id: 'frame-call', name: 'native_status', arguments: '{}' },
        ])
        output.toolStart('frame-call', 'native_status', '{}')
        output.toolEnd('frame-call', 'native status ready')
        output.text('final-frame', 'native conclusion')
        output.assistant('final-frame', [{ type: 'text', text: 'native conclusion' }])
      })
      return connection
    })
    await creating()
    const agent = officialHandle!.agent
    const { events, frames, endEvents } = observe(agent)
    await followup(agent, 'stream the native task')
    expect(errors).toEqual([])
    expect(connection.submit).toHaveBeenCalledOnce()
    const starts = frames.filter(frame => frame.type === 'start')
    const ends = frames.filter(frame => frame.type === 'end')
    const assistants = events.filter(event => event.type === 'assistant/message')
    expect(starts.map(frame => ({ revision: frame.revision, turn: frame.turn, step: frame.step }))).toEqual([{ revision: 1, turn: 1, step: 1 }, { revision: 13, turn: 1, step: 2 }])
    expect(frames.map(frame => frame.revision)).toEqual(Array.from({ length: 18 }, (_, index) => index + 1))
    expect(new Set(starts.map(frame => frame.attemptId)).size).toBe(2)
    expect(ends).toHaveLength(2)
    expect(assistants).toHaveLength(2)
    expect(endEvents).toEqual(assistants)
    expect(events.filter(event => event.type === 'assistant/attempt')).toEqual([])
    for (const [index, start] of starts.entries()) {
      const chunks = frames.filter((frame): frame is Extract<AssistantStreamFrame, { type: 'chunk' }> => frame.type === 'chunk' && frame.attemptId === start.attemptId)
      const end = ends[index]!
      const assistant = assistants[index]!
      expect(chunks.map(frame => frame.index)).toEqual(chunks.map((_, chunkIndex) => chunkIndex))
      expect(chunks.map(frame => frame.revision)).toEqual(chunks.map((_, chunkIndex) => start.revision + chunkIndex + 1))
      expect(end).toMatchObject({ attemptId: start.attemptId, revision: start.revision + chunks.length + 1, index: index === 0 ? 10 : 4, outcome: { kind: 'committed', eventType: 'assistant/message', seq: assistant.seq } })
      expect(llmModule.expandAssistantStream(assistant.data.stream)).toEqual(chunks.map(frame => ({ time: frame.time, chunk: frame.chunk })))
      expect(chunks.filter(frame => frame.chunk.type === 'finish').map(frame => frame.chunk)).toEqual([{ type: 'finish', reason: { kind: index === 0 ? 'tool-calls' : 'stop' } }])
      expect(frames.indexOf(end)).toBeGreaterThan(frames.indexOf(chunks[chunks.length - 1]!))
    }
    expect(assistants.map(event => event.data.message.content)).toEqual([
      [{ type: 'reasoning', text: 'native reasoning' }, { type: 'text', text: 'native preface' }, { type: 'tool-call', id: 'frame-call', name: 'native_status', arguments: '{}' }],
      [{ type: 'text', text: 'native conclusion' }],
    ])
    expect(events.filter(event => event.type === 'tool/result').map(event => event.data.message.toolCallId)).toEqual(['frame-call'])
    expect(runtime.exchanges.size).toBe(0)
  }, 10_000)

  it('resumes only the committed native identity through an official followup', async () => {
    const original = native('restored-native')
    const resumed = native(original.id)
    vi.mocked(createCodexSession).mockResolvedValueOnce(original).mockResolvedValueOnce(resumed)
    await creating()
    const agent = officialHandle!.agent
    const recordsBefore = records(agent.session)
    await session.remove(agent.id)
    expect(original.dispose).toHaveBeenCalledOnce()
    await followup(agent, 'resume the native session')
    expect(errors).toEqual([])
    expect(createCodexSession).toHaveBeenCalledTimes(2)
    expect(vi.mocked(createCodexSession).mock.calls[1]![2]).toBe(original.id)
    expect(resumed.submit).toHaveBeenCalledOnce()
    expect(resumed.submit.mock.calls[0]![0]).toMatchObject([{ content: [{ type: 'text', text: 'resume the native session' }] }])
    expect(records(agent.session)).toEqual(recordsBefore)
    expect(identity.resolve(agent).nativeSessionId).toBe(original.id)
    expect(createClaudeSession).not.toHaveBeenCalled()
  }, 10_000)

  it('rejects a restore ACK for another native identity without fallback or rebind', async () => {
    const original = native('bound-native')
    const foreign = native('foreign-native')
    vi.mocked(createCodexSession).mockResolvedValueOnce(original).mockResolvedValueOnce(foreign)
    await creating()
    const agent = officialHandle!.agent
    const recordsBefore = records(agent.session)
    await session.remove(agent.id)
    await followup(agent, 'restore strictly')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ message: expect.stringContaining('BRIDGE_RESUME_MISMATCH') })
    expect(createCodexSession).toHaveBeenCalledTimes(2)
    expect(vi.mocked(createCodexSession).mock.calls[1]![2]).toBe(original.id)
    expect(foreign.dispose).toHaveBeenCalledOnce()
    expect(foreign.submit).not.toHaveBeenCalled()
    expect(createClaudeSession).not.toHaveBeenCalled()
    expect(records(agent.session)).toEqual(recordsBefore)
    expect(identity.resolve(agent).nativeSessionId).toBe(original.id)
    expect(agents.get(agent.id)).toBe(agent)
  }, 10_000)

  it('aborts a pending strict restore and drains its ACK without changing the committed identity', async () => {
    const original = native('aborted-restore')
    const resumed = native(original.id)
    const ack = deferred<NativeSession>()
    const started = deferred<void>()
    const drain = deferred<void>()
    const drainStarted = deferred<void>()
    releases.push(() => ack.resolve(resumed), () => drain.resolve())
    resumed.dispose.mockImplementation(async () => {
      drainStarted.resolve()
      await drain.promise
    })
    vi.mocked(createCodexSession).mockResolvedValueOnce(original).mockImplementationOnce(async () => {
      started.resolve()
      return ack.promise
    })
    await creating()
    const agent = officialHandle!.agent
    const recordsBefore = records(agent.session)
    await session.remove(agent.id)
    const turn = followup(agent, 'restore then close')
    await started.promise
    let closed = false
    const closing = session.remove(agent.id).then(() => {
      closed = true
    })
    background.push(closing)
    expect(vi.mocked(createCodexSession).mock.calls[1]![2]).toBe(original.id)
    expect(vi.mocked(createCodexSession).mock.calls[1]![4].aborted).toBe(true)
    expect(closed).toBe(false)
    ack.resolve(resumed)
    await drainStarted.promise
    expect(closed).toBe(false)
    expect(resumed.submit).not.toHaveBeenCalled()
    expect(records(agent.session)).toEqual(recordsBefore)
    drain.resolve()
    await Promise.all([closing, turn])
    expect(closed).toBe(true)
    expect(resumed.dispose).toHaveBeenCalledOnce()
    expect(createCodexSession).toHaveBeenCalledTimes(2)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ message: expect.stringContaining('BRIDGE_SESSION_DISPOSED') })
    expect(identity.resolve(agent).nativeSessionId).toBe(original.id)
    expect(agents.get(agent.id)).toBe(agent)
  }, 10_000)

  it('restores the committed native identity from a cold official session', async () => {
    const original = native('cold-restored-native')
    const resumed = native(original.id)
    vi.mocked(createCodexSession).mockResolvedValueOnce(original)
    await creating()
    const previous = officialHandle!
    const stored = structuredClone(previous.agent.session.snapshotEvents())
    const recordsBefore = records(previous.agent.session)
    await previous.dispose()
    await session.remove(previous.agent.id)
    const close = vi.fn().mockResolvedValue(undefined)
    const handle = {
      id: previous.agent.id,
      header: previous.agent.session.header,
      inheritedEventCount: previous.agent.session.inheritedEventCount,
      access: 'write',
      read: vi.fn().mockResolvedValue({ events: stored, eventState: 'detached' }),
      append: vi.fn().mockResolvedValue(undefined),
      flush: vi.fn().mockResolvedValue(undefined),
      close,
      [Symbol.asyncDispose]: close,
    }
    const open = vi.fn().mockResolvedValue(handle)
    const create = vi.fn().mockRejectedValue(new Error('cold resume must not create a new stored session'))
    context.extend().provide('sessionPersistence', { open, create })
    const restored = await agents.resume({ resumeSessionId: previous.agent.id, agentOptions: { provider: BRIDGE_PROVIDER, model: 'codex' } })
    expect(open).toHaveBeenCalledExactlyOnceWith(previous.agent.id, 'write', { signal: expect.any(AbortSignal) })
    expect(handle.read).toHaveBeenCalledExactlyOnceWith(0, undefined, { signal: expect.any(AbortSignal) })
    expect(create).not.toHaveBeenCalled()
    expect(restored.agent).not.toBe(previous.agent)
    expect(restored.agent.session).not.toBe(previous.agent.session)
    expect(restored.agent.session.header.cwd).toBe(cwd)
    expect(identity.resolve(restored.agent)).toEqual({ backend: 'codex', nativeSessionId: 'cold-restored-native', sessionId: previous.agent.id })
    expect(records(restored.agent.session)).toEqual(recordsBefore)
    expect(createCodexSession).toHaveBeenCalledOnce()
    vi.mocked(createCodexSession).mockImplementationOnce(async (_command, _cwd, storedId, output) => {
      expect(storedId).toBe('cold-restored-native')
      resumed.submit.mockImplementation(async () => output.assistant('cold-answer', [{ type: 'text', text: 'restored from native history' }]))
      return resumed
    })
    await followup(restored.agent, 'continue the cold session')
    expect(createCodexSession).toHaveBeenCalledTimes(2)
    expect(resumed.submit).toHaveBeenCalledOnce()
    expect(errors).toEqual([])
    expect(records(restored.agent.session)).toEqual(recordsBefore)
    expect(agents.get(previous.agent.id)).toBe(restored.agent)
    await restored.dispose()
    await session.remove(restored.agent.id)
    expect(close).toHaveBeenCalledOnce()
    expect(resumed.dispose).toHaveBeenCalledOnce()
  }, 10_000)

  it('keeps a recreated official owner behind the old native close barrier', async () => {
    const original = native('recreated-native')
    const drain = deferred<void>()
    const drainStarted = deferred<void>()
    releases.push(() => drain.resolve())
    original.dispose.mockImplementation(async () => {
      drainStarted.resolve()
      await drain.promise
    })
    vi.mocked(createCodexSession).mockResolvedValueOnce(original)
    await creating()
    const oldHandle = officialHandle!
    const seed = oldHandle.agent.session.snapshotEvents()
    const recordsBefore = records(oldHandle.agent.session)
    let closed = false
    const oldClosing = oldHandle.dispose().then(() => {
      closed = true
    })
    background.push(oldClosing)
    await drainStarted.promise
    expect(closed).toBe(false)
    expect(agents.get(oldHandle.agent.id)).toBe(oldHandle.agent)
    expect(sessions.get(oldHandle.agent.id)).toBe(oldHandle.agent.session)
    const nativeClosing = session.remove(oldHandle.agent.id)
    background.push(nativeClosing)
    await expect(agents.create({ sessionId: oldHandle.agent.id, seed, meta: { cwd }, agentOptions: { provider: BRIDGE_PROVIDER, model: 'codex' } })).rejects.toThrow(`session "${oldHandle.agent.id}" already exists`)
    expect(createCodexSession).toHaveBeenCalledOnce()
    expect(original.submit).not.toHaveBeenCalled()
    drain.resolve()
    await Promise.all([oldClosing, nativeClosing])
    expect(closed).toBe(true)
    expect(agents.get(oldHandle.agent.id)).toBeUndefined()
    expect(sessions.get(oldHandle.agent.id)).toBeUndefined()
    const replacement = await agents.create({ sessionId: oldHandle.agent.id, seed, meta: { cwd }, agentOptions: { provider: BRIDGE_PROVIDER, model: 'codex' } })
    expect(identity.resolve(replacement.agent)).toEqual({ backend: 'codex', nativeSessionId: 'recreated-native', sessionId: oldHandle.agent.id })
    expect(errors).toEqual([])
    const resumed = native(original.id)
    vi.mocked(createCodexSession).mockImplementationOnce(async (_command, _cwd, _storedId, output) => {
      resumed.submit.mockImplementation(async () => output.assistant('resumed-answer', [{ type: 'text', text: 'native owner restored' }]))
      return resumed
    })
    await followup(replacement.agent, 'restore after drain')
    expect(createCodexSession).toHaveBeenCalledTimes(2)
    expect(vi.mocked(createCodexSession).mock.calls[1]![2]).toBe(original.id)
    expect(resumed.submit).toHaveBeenCalledOnce()
    await followup(replacement.agent, 'reuse the restored owner')
    expect(createCodexSession).toHaveBeenCalledTimes(2)
    expect(resumed.submit).toHaveBeenCalledTimes(2)
    expect(errors).toEqual([])
    expect(records(replacement.agent.session)).toEqual(recordsBefore)
    expect(agents.get(replacement.agent.id)).toBe(replacement.agent)
    expect(resumed.dispose).not.toHaveBeenCalled()
    expect(original.dispose).toHaveBeenCalledOnce()
  }, 10_000)

  it('ignores a late native remove from the previous official owner of the same session id', async () => {
    const original = native('same-id-native')
    const resumed = native(original.id)
    vi.mocked(createCodexSession).mockResolvedValueOnce(original)
    await creating()
    const previous = officialHandle!
    const seed = previous.agent.session.snapshotEvents()
    const recordsBefore = records(previous.agent.session)
    await previous.dispose()
    await session.remove(previous.agent.id)
    expect(original.dispose).toHaveBeenCalledOnce()
    const replacement = await agents.create({ sessionId: previous.agent.id, seed, meta: { cwd }, agentOptions: { provider: BRIDGE_PROVIDER, model: 'codex' } })
    vi.mocked(createCodexSession).mockImplementationOnce(async (_command, _cwd, storedId, output) => {
      expect(storedId).toBe('same-id-native')
      resumed.submit.mockImplementation(async () => output.assistant(`same-id-answer-${resumed.submit.mock.calls.length}`, [{ type: 'text', text: 'current native owner' }]))
      return resumed
    })
    await followup(replacement.agent, 'restore the replacement owner')
    expect(errors).toEqual([])
    expect(createCodexSession).toHaveBeenCalledTimes(2)
    expect(resumed.submit).toHaveBeenCalledOnce()
    await session.remove(previous.agent.id, previous.agent)
    expect(resumed.dispose).not.toHaveBeenCalled()
    await followup(replacement.agent, 'reuse after stale owner cleanup')
    expect(errors).toEqual([])
    expect(createCodexSession).toHaveBeenCalledTimes(2)
    expect(resumed.submit).toHaveBeenCalledTimes(2)
    expect(resumed.dispose).not.toHaveBeenCalled()
    expect(records(replacement.agent.session)).toEqual(recordsBefore)
    expect(identity.resolve(replacement.agent)).toEqual({ backend: 'codex', nativeSessionId: 'same-id-native', sessionId: previous.agent.id })
    expect(agents.get(previous.agent.id)).toBe(replacement.agent)
    expect(sessions.get(previous.agent.id)).toBe(replacement.agent.session)
    expect(original.dispose).toHaveBeenCalledOnce()
  }, 10_000)

  it('never opens or binds native state after the official factory closes during preset setup', async () => {
    const gate = deferred<void>()
    const started = deferred<void>()
    const finished = deferred<void>()
    const setupFinished: Array<Promise<{ value: Awaited<ReturnType<AgentSetup>> } | { error: unknown }>> = []
    releases.push(() => gate.resolve())
    mount.mockImplementation(async () => {
      started.resolve()
      await gate.promise
      finished.resolve()
    })
    vi.mocked(agents.create).mockImplementation(async (options) => {
      const setup = options.setup!
      return createAgent({
        ...options,
        setup(agentCtx, agent) {
          const observed = Promise.resolve(setup(agentCtx, agent)).then(value => ({ value }), error => ({ error }))
          setupFinished.push(observed)
          background.push(observed)
          return observed.then((result) => {
            if ('error' in result)
              throw result.error
            return result.value
          })
        },
      })
    })
    vi.mocked(createCodexSession).mockResolvedValue(native('must-not-open'))
    const task = creating()
    const rejection = expect(task).rejects.toThrow('agent loop is not active')
    background.push(rejection)
    await started.promise
    expect(prepared).toHaveLength(1)
    await disposeLoop()
    await rejection
    expect(runtime.ready).toBe(true)
    expect(createCodexSession).not.toHaveBeenCalled()
    gate.resolve()
    await finished.promise
    const [settled] = await Promise.all(setupFinished)
    expect(settled).toHaveProperty('error')
    expect(records(prepared[0]!)).toEqual([])
    expect(prepared[0]!.requestHeader()).toBeUndefined()
    expect(createCodexSession).not.toHaveBeenCalled()
    expect(createClaudeSession).not.toHaveBeenCalled()
    expect(agents.list()).toEqual([])
    expect(sessions.list()).toEqual([])
    expect(runtime.sessions.size).toBe(0)
    expect(announced).toEqual([])
  }, 10_000)

  it('rolls back a rejected native initialization without publishing or binding', async () => {
    const error = new Error('native initialization rejected')
    vi.mocked(createCodexSession).mockRejectedValue(error)
    await expect(creating()).rejects.toBe(error)
    expect(prepared).toHaveLength(1)
    expect(records(prepared[0]!)).toEqual([])
    expect(agents.list()).toEqual([])
    expect(sessions.list()).toEqual([])
    expect(announced).toEqual([])
    expect(runtime.sessions.size).toBe(0)
  }, 10_000)

  it('disposes a native ACK with no identity rather than starting a fallback thread', async () => {
    const connection = native('')
    vi.mocked(createCodexSession).mockResolvedValue(connection)
    await expect(creating()).rejects.toThrow('BRIDGE_RESUME_MISMATCH')
    expect(records(prepared[0]!)).toEqual([])
    expect(connection.dispose).toHaveBeenCalledOnce()
    expect(connection.submit).not.toHaveBeenCalled()
    expect(createCodexSession).toHaveBeenCalledOnce()
    expect(createClaudeSession).not.toHaveBeenCalled()
    expect(agents.list()).toEqual([])
    expect(sessions.list()).toEqual([])
  }, 10_000)

  it('rolls back official publication and native ownership after workspace attachment fails', async () => {
    const connection = native('attachment-failure')
    const failure = new Error('workspace attachment failed')
    vi.mocked(createCodexSession).mockResolvedValue(connection)
    attachSession.mockRejectedValue(failure)
    await expect(creating('codex', 'test-workspace')).rejects.toBe(failure)
    expect(officialHandle).toBeDefined()
    expect(agents.list()).toEqual([])
    expect(sessions.list()).toEqual([])
    expect(connection.dispose).toHaveBeenCalledOnce()
    expect(runtime.sessions.size).toBe(0)
    expect(runtime.claims.size).toBe(0)
    const replacement = native(connection.id)
    vi.mocked(createCodexSession).mockResolvedValue(replacement)
    attachSession.mockResolvedValue(undefined)
    const result = await creating('codex', 'test-workspace')
    expect(agents.get(sessionModule.SessionId(result.sessionId))).toBe(officialHandle!.agent)
    expect(connection.dispose).toHaveBeenCalledOnce()
    expect(replacement.dispose).not.toHaveBeenCalled()
  }, 10_000)

  it('rejects a second official owner of the same backend-native identity', async () => {
    const first = native('single-owner')
    const second = native('single-owner')
    vi.mocked(createCodexSession).mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const original = await creating()
    await expect(creating()).rejects.toThrow('BRIDGE_NATIVE_OWNER_CONFLICT')
    expect(agents.list()).toHaveLength(1)
    expect(sessions.list()).toHaveLength(1)
    expect(agents.get(sessionModule.SessionId(original.sessionId))?.session).toBe(prepared[0])
    expect(records(prepared[1]!)).toEqual([])
    expect(first.dispose).not.toHaveBeenCalled()
    expect(second.dispose).toHaveBeenCalledOnce()
    expect(second.submit).not.toHaveBeenCalled()
  }, 10_000)

  it('holds concurrent remove calls until a pending ACK is disposed', async () => {
    const ack = deferred<NativeSession>()
    const started = deferred<void>()
    const connection = native('late-ack')
    const drain = deferred<void>()
    const drainStarted = deferred<void>()
    releases.push(() => ack.resolve(connection), () => drain.resolve())
    connection.dispose.mockImplementation(async () => {
      drainStarted.resolve()
      await drain.promise
    })
    vi.mocked(createCodexSession).mockImplementation(async () => {
      started.resolve()
      return ack.promise
    })
    const task = creating()
    const rejection = expect(task).rejects.toThrow('BRIDGE_SESSION_DISPOSED')
    await started.promise
    const official = prepared[0]!
    const signal = vi.mocked(createCodexSession).mock.calls[0]![4]
    let removed = 0
    const first = session.remove(official.id).then(() => {
      removed++
    })
    const second = session.remove(official.id).then(() => {
      removed++
    })
    background.push(first, second, rejection)
    expect(signal.aborted).toBe(true)
    expect(removed).toBe(0)
    ack.resolve(connection)
    await drainStarted.promise
    expect(removed).toBe(0)
    expect(records(official)).toEqual([])
    expect(connection.dispose).toHaveBeenCalledOnce()
    drain.resolve()
    await Promise.all([first, second, rejection])
    expect(removed).toBe(2)
    expect(agents.list()).toEqual([])
    expect(sessions.list()).toEqual([])
    expect(announced).toEqual([])
    expect(runtime.sessions.size).toBe(0)
    expect(runtime.pending.size).toBe(0)
    expect(connection.dispose).toHaveBeenCalledOnce()
  }, 10_000)

  it('aborts a pending create on application disposal and drains a late native ACK', async () => {
    const ack = deferred<NativeSession>()
    const started = deferred<void>()
    const connection = native('shutdown-ack')
    const drain = deferred<void>()
    const drainStarted = deferred<void>()
    releases.push(() => ack.resolve(connection), () => drain.resolve())
    vi.mocked(createCodexSession).mockImplementation(async () => {
      started.resolve()
      return ack.promise
    })
    connection.dispose.mockImplementation(async () => {
      drainStarted.resolve()
      await drain.promise
    })
    const task = creating()
    const rejection = expect(task).rejects.toThrow('BRIDGE_DISPOSED')
    await started.promise
    let disposed = false
    const closing = session.dispose().then(() => {
      disposed = true
    })
    background.push(closing, rejection)
    expect(vi.mocked(createCodexSession).mock.calls[0]![4].aborted).toBe(true)
    expect(disposed).toBe(false)
    ack.resolve(connection)
    await drainStarted.promise
    expect(disposed).toBe(false)
    expect(records(prepared[0]!)).toEqual([])
    drain.resolve()
    await Promise.all([closing, rejection])
    expect(connection.dispose).toHaveBeenCalledOnce()
    expect(agents.list()).toEqual([])
    expect(sessions.list()).toEqual([])
    expect(runtime.sessions.size).toBe(0)
  }, 10_000)
})
