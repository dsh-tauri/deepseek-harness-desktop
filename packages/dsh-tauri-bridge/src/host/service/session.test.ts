import type { Agent, AgentHandle, AgentSetup, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
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
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../apply'
import { createClaudeSession } from '../backends/claude'
import { createCodexSession } from '../backends/codex'
import { BRIDGE_PROVIDER } from '../config/constants'
import { resetRuntime, runtime } from '../config/runtime'
import { detectBackend } from '../utils/detection'
import { identity } from './identity'
import { session } from './session'
import { sink } from './sink'

vi.mock('../utils/detection', () => ({ detectBackend: vi.fn() }))
vi.mock('../backends/codex', () => ({ createCodexSession: vi.fn() }))
vi.mock('../backends/claude', () => ({ createClaudeSession: vi.fn() }))

const packageId: string = 'dsh-session-current'
const sessionModule = await import(packageId) as typeof import('@deepseek-ai/dsh-session') & Pick<RuntimeModules, 'appendPluginRecord' | 'pluginRecordOf'>
const require = createRequire(import.meta.url)
const coreRequire = createRequire(require.resolve('@deepseek-ai/dsh-agent-loop'))
const promptModule: { SystemPrompt: new (ctx: Context, config: { includeHarnessIdentity: boolean, includeRuntimeContext: boolean }) => Context['systemPrompt'] } = await import(pathToFileURL(coreRequire.resolve('@deepseek-ai/dsh-system-prompt')).href)
const cwd = process.cwd()

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
  await session.dispose()
  await context.fiber.dispose()
  await resetRuntime()
  vi.restoreAllMocks()
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

function records(official: Session) {
  return official.snapshotEvents().flatMap((event) => {
    const record = sessionModule.pluginRecordOf!(event)
    return record === undefined ? [] : [record]
  })
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

describe('official native session lifecycle', () => {
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
    expect(projections.stateOf(official, 'bridgeKernel')).toBeNull()
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
    expect(official.requestHeader()?.config).toEqual({ provider: BRIDGE_PROVIDER, model: id })
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
    const oldClosing = oldHandle.dispose()
    background.push(oldClosing)
    await drainStarted.promise
    await oldClosing
    expect(agents.get(oldHandle.agent.id)).toBeUndefined()
    expect(sessions.get(oldHandle.agent.id)).toBeUndefined()
    const nativeClosing = session.remove(oldHandle.agent.id)
    background.push(nativeClosing)
    const replacement = await agents.create({ sessionId: oldHandle.agent.id, seed, meta: { cwd }, agentOptions: { provider: BRIDGE_PROVIDER, model: 'codex' } })
    const created = deferred<Awaited<ReturnType<typeof sink.create>>>()
    const create = sink.create.bind(sink)
    vi.spyOn(sink, 'create').mockImplementation(async (...args) => {
      const exchange = await create(...args)
      created.resolve(exchange)
      return exchange
    })
    const rejectedTurn = followup(replacement.agent, 'do not race the old native owner')
    const exchange = await created.promise
    await vi.waitFor(() => expect(exchange.state.done).toBe(true))
    expect(createCodexSession).toHaveBeenCalledOnce()
    expect(original.submit).not.toHaveBeenCalled()
    expect(identity.resolve(replacement.agent).nativeSessionId).toBe(original.id)
    drain.resolve()
    await Promise.all([nativeClosing, rejectedTurn])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ message: expect.stringContaining('BRIDGE_SESSION_CLOSING') })
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
    expect(errors).toHaveLength(1)
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
