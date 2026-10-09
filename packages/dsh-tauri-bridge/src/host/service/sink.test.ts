import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import type { NativeSession, NativeSink } from '../backends/types'
import type { HostContext, NativeExecution, PlatformLoader, RuntimeModules } from '../types'
import type { OfficialSink } from './sink.types'
import { createRequire } from 'node:module'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import * as llmModule from '@deepseek-ai/dsh-llm'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import { UserQuestionService } from '@deepseek-ai/dsh-user-questions'
import { getServerContext } from 'dsh-h3/utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../apply'
import { BRIDGE_PROVIDER } from '../config/constants'
import { resetRuntime, runtime } from '../config/runtime'
import { server } from '../server'
import { identity } from './identity'
import { session as bridgeSession } from './session'
import { sink } from './sink'

const currentPackage: string = 'dsh-session-current'
const sessionModule = await import(currentPackage) as unknown as typeof import('@deepseek-ai/dsh-session') & Required<Pick<RuntimeModules, 'appendPluginRecord' | 'pluginRecordOf'>>
const require = createRequire(import.meta.url)
const loopRequire = createRequire(require.resolve('@deepseek-ai/dsh-agent-loop'))
const promptModule: { SystemPrompt: new (ctx: Context, options: { includeHarnessIdentity: boolean, includeRuntimeContext: boolean }) => Context['systemPrompt'] } = await import(pathToFileURL(loopRequire.resolve('@deepseek-ai/dsh-system-prompt')).href)

let context: Context
let agents: AgentRegistry
let agent: Agent
let handle: AgentHandle
let connection: NativeSession & { submit: ReturnType<typeof vi.fn<NativeSession['submit']>>, dispose: ReturnType<typeof vi.fn<NativeSession['dispose']>> }
let events: SessionEvent[]
let errors: unknown[]
let results: { exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult> }[]
let timeline: string[]
let exchanges: OfficialSink[]
let releases: (() => void)[]
let background: Promise<unknown>[]
let nativeScript: (output: NativeSink, messages: readonly UserMessage[], signal: AbortSignal) => Promise<void>

function output(): NativeSink {
  const exchange = runtime.exchanges.get(agent.id)
  if (!exchange)
    throw new Error('Test native boundary has no active official sink')
  return exchange.state.native
}

function inheritedTool(name = 'shell_command') {
  const body = vi.fn(async () => 'inherited DSH body must not run')
  context.tools.register({
    name,
    description: 'inherited DSH test capability',
    parameters: { type: 'object', additionalProperties: true },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute: body,
  })
  return body
}

function nativeCall(output: NativeSink, id: string, arguments_ = '{}', name = 'shell_command') {
  output.assistant(`${id}:assistant`, [{ type: 'tool-call', id, name, arguments: arguments_ }])
  output.toolStart(id, name, arguments_)
}

async function exchange(): Promise<OfficialSink> {
  agent.session.append('turn/start', { turn: 1 })
  agent.session.append('step/start', { turn: 1, step: 1 })
  const input: NativeExecution = {
    agent,
    turn: 1,
    step: 1,
    messages: [],
    signal: new AbortController().signal,
    dispatched: true,
    binding: identity.resolve(agent),
  }
  const current = await sink.create(input)
  exchanges.push(current)
  return current
}

function runTurn(): Promise<void> {
  agent.followup(llmModule.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'native task' }] }))
  const idle = agent.whenIdle()
  background.push(idle)
  return idle
}

function execute(id: string, signal: AbortSignal, arguments_: unknown = {}, name = 'shell_command') {
  const task = context.tools.execute({ agent, callId: llmModule.ToolCallId(id), name, arguments: arguments_, signal })
  background.push(task)
  return task
}

function toolResults() {
  return events.filter((event): event is Extract<SessionEvent, { type: 'tool/result' }> => event.type === 'tool/result')
}

function assistants() {
  return events.filter((event): event is Extract<SessionEvent, { type: 'assistant/message' }> => event.type === 'assistant/message')
}

beforeEach(async () => {
  await resetRuntime()
  runtime.lifetime = new AbortController()
  context = new Context()
  agents = new AgentRegistry(context)
  const services = [
    new sessionModule.SessionStore(context),
    new SessionProjectionRegistry(context),
    new llmModule.LlmRuntime(context),
    new promptModule.SystemPrompt(context, { includeHarnessIdentity: false, includeRuntimeContext: false }),
    new ToolRuntime(context, { mode: 'native' }),
    new ApprovalService(context, { policy: 'ask' }),
    new UserQuestionService(context),
  ]
  expect(services).toHaveLength(7)
  events = []
  errors = []
  results = []
  timeline = []
  exchanges = []
  releases = []
  background = []
  context.on('session/event', (value, event) => {
    if (value === agent?.session) {
      events.push(event)
      if (event.type === 'tool/result')
        timeline.push(`commit:${event.data.message.toolCallId}`)
    }
  })
  context.on('agent/error', ({ error }) => {
    errors.push(error)
  })
  context.on('tools/result', (exec, result) => {
    results.push({ exec, result })
    timeline.push(`result:${exec.callId}`)
    return undefined
  })
  const routes = new Map<string, WebRoute>()
  context.provide('webServer', {
    register(route: WebRoute) {
      routes.set(route.path, route)
      return () => {
        routes.delete(route.path)
      }
    },
  } as unknown as HostContext['webServer'])
  const loader: PlatformLoader = {
    async import(id) {
      if (id === '@deepseek-ai/dsh-llm')
        return llmModule
      if (id === '@deepseek-ai/dsh-session')
        return sessionModule
      throw new Error(`Unexpected public runtime import: ${id}`)
    },
    unwrapExports: value => value,
  }
  context.provide('loader', loader as HostContext['loader'])
  context.provide('agentPresets', { inspectCompositions: () => [] } as unknown as HostContext['agentPresets'])
  const loop = context.plugin(AgentLoop, { agents: [] })
  await loop.await()
  context.plugin((ctx) => {
    apply(ctx as HostContext)
  })
  await vi.waitFor(() => expect(runtime.ready).toBe(true))
  expect(getServerContext<HostContext>(server).root).toBe(context.root)
  expect([...routes.keys()].sort()).toEqual(['/api/tauri/bridge/backends', '/api/tauri/bridge/sessions'])
  handle = await agents.create({
    sessionId: sessionModule.SessionId('sink-contract-session'),
    meta: { cwd: process.cwd() },
    agentOptions: { provider: BRIDGE_PROVIDER, model: 'codex' },
    async setup(_agentCtx, owner) {
      await identity.append(owner, { backend: 'codex', nativeSessionId: 'native-sink-session', sessionId: owner.id })
      owner.session.append('request/header', { header: { config: { provider: BRIDGE_PROVIDER, model: 'codex' } }, reason: 'initial' })
    },
  })
  agent = handle.agent
  nativeScript = async (native) => {
    native.assistant('final', [{ type: 'text', text: 'native done' }])
  }
  connection = {
    id: 'native-sink-session',
    submit: vi.fn<NativeSession['submit']>(async (messages, signal) => nativeScript(output(), messages, signal)),
    dispose: vi.fn<NativeSession['dispose']>().mockResolvedValue(undefined),
  }
  runtime.sessions.set(agent.id, { agent, binding: identity.resolve(agent), session: connection, controller: new AbortController() })
})

afterEach(async () => {
  for (const release of releases)
    release()
  for (const current of exchanges)
    current.settle(new Error('TEST_TURN_CLOSED'))
  await bridgeSession.dispose()
  await Promise.allSettled(background)
  await handle?.dispose()
  await context.fiber.dispose()
  await resetRuntime()
  vi.restoreAllMocks()
})

describe('real official cross-step native sink', () => {
  it('settles a full terminal queue with done, one wake, and a retained overflow failure', async () => {
    const current = await exchange()
    const native = current.state.native
    for (let index = 0; index < 8_190; index++)
      native.text('full', 'x')
    native.assistant('full', [{ type: 'text', text: 'x'.repeat(8_190) }])
    expect(current.state.queue).toHaveLength(8_192)
    const wake = vi.fn()
    current.state.wake = wake
    expect(() => current.settle()).not.toThrow()
    expect(current.state.done).toBe(true)
    expect(current.state.active).toBe(false)
    expect(current.state.failure).toMatchObject({ message: 'BRIDGE_STREAM_OVERFLOW: 原生输出超过缓冲限制。' })
    expect(current.state.queue.filter(chunk => chunk.type === 'finish')).toEqual([])
    expect(wake).toHaveBeenCalledOnce()
    expect(current.state.wake).toBeUndefined()
    current.settle()
    expect(wake).toHaveBeenCalledOnce()
  })

  it('wakes the real official stream with overflow instead of leaving its idle future hanging', async () => {
    nativeScript = async (native) => {
      native.text('overflow', 'x'.repeat(8 * 1_024 * 1_024))
    }
    await runTurn()
    expect(connection.submit).toHaveBeenCalledOnce()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ message: 'BRIDGE_STREAM_OVERFLOW: 原生输出超过缓冲限制。' })
    expect(events.filter(event => event.type === 'turn/end')).toHaveLength(1)
    expect(runtime.exchanges.size).toBe(0)
    expect(agent.status).toBe('idle')
  }, 10_000)

  it('queues 32 early native results across real official steps without invoking an inherited DSH body', async () => {
    const inherited = inheritedTool()
    nativeScript = async (native) => {
      for (let index = 0; index < 32; index++)
        nativeCall(native, `native-${index}`, JSON.stringify({ command: `inspect-${index}` }))
      for (let index = 31; index >= 0; index--)
        native.toolEnd(`native-${index}`, `native output ${index}`)
      native.assistant('final', [{ type: 'text', text: 'all native tools settled' }])
    }
    await runTurn()
    expect(errors).toEqual([])
    expect(connection.submit).toHaveBeenCalledOnce()
    expect(inherited).not.toHaveBeenCalled()
    expect(assistants().map(event => event.data.step)).toEqual(Array.from({ length: 33 }, (_, index) => index + 1))
    expect(assistants().slice(0, 32).map(event => event.data.message.content)).toEqual(Array.from({ length: 32 }, (_, index) => [{ type: 'tool-call', id: `native-${index}`, name: 'shell_command', arguments: JSON.stringify({ command: `inspect-${index}` }) }]))
    expect(assistants()[32]!.data.message.content).toEqual([{ type: 'text', text: 'all native tools settled' }])
    expect(toolResults().map(event => ({ id: event.data.message.toolCallId, step: event.data.step, content: event.data.message.content }))).toEqual(Array.from({ length: 32 }, (_, index) => ({ id: `native-${index}`, step: index + 1, content: [{ type: 'text', text: `native output ${index}` }] })))
    expect(toolResults().map(event => event.data.message.isError)).toEqual(Array.from({ length: 32 }).fill(false))
    expect(results.map(({ result }) => result)).toEqual(Array.from({ length: 32 }, (_, index) => ({ isError: false, value: `native output ${index}`, content: [{ type: 'text', text: `native output ${index}` }] })))
    expect(results.every(({ exec, result }) => exec.agent === agent && Object.isFrozen(exec) && Object.isFrozen(result))).toBe(true)
    expect(timeline).toEqual(Array.from({ length: 32 }, (_, index) => [`result:native-${index}`, `commit:native-${index}`]).flat())
    expect(context.tools.get('shell_command', agent)?.execute).toBe(inherited)
    expect(runtime.exchanges.size).toBe(0)
  }, 10_000)

  it('preserves native error text through the real tool pipeline and official result log', async () => {
    const inherited = inheritedTool()
    nativeScript = async (native) => {
      nativeCall(native, 'failed-native')
      native.toolEnd('failed-native', 'native stderr without a synthetic Error prefix', true)
      native.assistant('final', [{ type: 'text', text: 'native recovery completed' }])
    }
    await runTurn()
    expect(errors).toEqual([])
    expect(inherited).not.toHaveBeenCalled()
    expect(results).toHaveLength(1)
    expect(results[0]!.result).toEqual({ isError: true, error: { message: 'native stderr without a synthetic Error prefix', info: { name: 'NativeToolError', code: 'BRIDGE_NATIVE_TOOL_ERROR' } }, content: [{ type: 'text', text: 'native stderr without a synthetic Error prefix' }] })
    expect(toolResults()).toHaveLength(1)
    expect(toolResults()[0]!.data).toMatchObject({ turn: 1, step: 1, message: { role: 'tool', toolCallId: 'failed-native', isError: true, content: [{ type: 'text', text: 'native stderr without a synthetic Error prefix' }] }, error: { name: 'NativeToolError', code: 'BRIDGE_NATIVE_TOOL_ERROR' } })
    expect(assistants().map(event => event.data.step)).toEqual([1, 2])
    expect(runtime.exchanges.size).toBe(0)
  }, 10_000)

  it.each(['block', 'value', 'content', 'context'] as const)('refuses continuation after real post-execute %s rewrites the native result', async (policy) => {
    const inherited = inheritedTool()
    const additional = llmModule.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'extra policy context' }] })
    agent.ctx.on('tools/post-execute', async (): Promise<PostToolDecision> => {
      if (policy === 'block')
        return { kind: 'block', feedback: [{ type: 'text', text: 'policy denied native output' }] }
      if (policy === 'value')
        return { kind: 'accept', value: 'rewritten native value' }
      if (policy === 'content')
        return { kind: 'accept', content: [{ type: 'text', text: 'rewritten native content' }] }
      return { kind: 'accept', additionalContexts: [additional] }
    })
    nativeScript = async (native) => {
      nativeCall(native, 'rewritten')
      native.toolEnd('rewritten', 'canonical native output')
      native.assistant('final', [{ type: 'text', text: 'must not enter another official step' }])
    }
    await runTurn()
    expect(connection.submit).toHaveBeenCalledOnce()
    expect(inherited).not.toHaveBeenCalled()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ message: expect.stringContaining('BRIDGE_TOOL_RESULT_REJECTED') })
    expect(assistants()).toHaveLength(1)
    expect(toolResults()).toHaveLength(1)
    expect(assistants()[0]!.data.step).toBe(1)
    expect(events.filter(event => event.type === 'step/start').map(event => event.data.step)).toEqual([1])
    expect(runtime.exchanges.size).toBe(0)
  }, 10_000)

  it('rejects an authored concludesTurn at the public final-result acceptance boundary', async () => {
    const inherited = inheritedTool()
    const current = await exchange()
    nativeCall(current.state.native, 'concluding')
    current.state.native.toolEnd('concluding', 'canonical native output')
    const result = await execute('concluding', current.state.signal)
    expect(result).toEqual({ isError: false, value: 'canonical native output', content: [{ type: 'text', text: 'canonical native output' }] })
    expect(inherited).not.toHaveBeenCalled()
    expect(current.state.signal.aborted).toBe(false)
    if (result.isError)
      throw new Error('The independent canonical success fixture unexpectedly failed')
    expect(sink.acceptTool(results[0]!.exec, { ...result, concludesTurn: true })).toBeUndefined()
    expect(current.state.signal.aborted).toBe(true)
    expect(current.state.failure).toMatchObject({ message: expect.stringContaining('BRIDGE_TOOL_RESULT_REJECTED') })
  })

  it.each(['allowed-once', 'rejected', 'cancelled', 'unavailable'] as const)('audits approval before any call is presented and grants only %s', async (outcome) => {
    const current = await exchange()
    const answerer = vi.fn(async (_request: ApprovalRequest) => outcome)
    agent.ctx.on('approval/request', answerer)
    expect(await current.state.native.approval('not-yet-presented', { kind: 'command', title: 'native command', details: 'native permission reason' })).toBe(outcome === 'allowed-once')
    expect(current.state.tools.size).toBe(0)
    expect(answerer).toHaveBeenCalledOnce()
    const request = answerer.mock.calls[0]![0]
    expect(request.agent).toBe(agent)
    expect({ toolName: request.toolName, reason: request.reason }).toEqual({ toolName: 'native command', reason: 'native permission reason' })
    expect(Object.hasOwn(request, 'callId')).toBe(false)
    const audit = events.filter(event => event.type === 'approval/asked' || event.type === 'approval/decided')
    expect(audit).toHaveLength(2)
    expect(audit[0]).toMatchObject({ type: 'approval/asked', data: { toolName: 'native command', reason: 'native permission reason' } })
    expect(audit[1]).toMatchObject({ type: 'approval/decided', data: { id: audit[0]!.data.id, outcome } })
  })

  it('preserves multi-selection and custom answers through the real user-questions service', async () => {
    const current = await exchange()
    const questions = [{ id: 'multi', question: 'Select native targets', options: [{ label: 'red' }, { label: 'blue' }], multiSelect: true }, { id: 'single', question: 'Choose one', options: [{ label: 'one' }] }]
    const answerer = vi.fn(async (_request: AskUserQuestionRequest) => ({ answers: [{ id: 'multi', selected: ['red', 'blue'], custom: 'custom, literal' }, { id: 'single', selected: ['one'] }] }))
    agent.ctx.on('user-questions/request', answerer)
    expect(await current.state.native.questions('native-question-call', questions)).toEqual({ multi: ['red', 'blue', 'custom, literal'], single: 'one' })
    expect(answerer).toHaveBeenCalledOnce()
    const request = answerer.mock.calls[0]![0]
    expect(request.agent).toBe(agent)
    expect(request.questions).toEqual(questions)
    expect(request.wait).toEqual({ callId: 'native-question-call' })
    expect(current.state.tools.size).toBe(0)
  })

  it('rejects an incomplete question answer instead of dropping unanswered identities', async () => {
    const current = await exchange()
    agent.ctx.on('user-questions/request', async () => ({ answers: [{ id: 'first', selected: ['yes'] }] }))
    await expect(current.state.native.questions('question-call', [{ id: 'first', question: 'First?' }, { id: 'second', question: 'Second?' }])).rejects.toThrow('BRIDGE_QUESTION_ANSWER_MISSING')
  })

  it('refuses late callbacks after cancellation without adding queued chunks', async () => {
    const current = await exchange()
    const failure = new Error('native turn cancelled')
    current.state.controller.abort(failure)
    expect(() => current.state.native.text('late', 'forbidden')).toThrow(failure)
    expect(current.state.queue).toEqual([])
    current.settle()
    expect(current.state.done).toBe(true)
    expect(current.state.failure).toBe(failure)
    expect(() => current.state.native.assistant('late-final', [{ type: 'text', text: 'forbidden' }])).toThrow('BRIDGE_NOTIFICATION_OUTSIDE_TURN')
    expect(current.state.queue).toEqual([])
  })

  it('deduplicates identical assistant and tool outcomes but refuses conflicting duplicates', async () => {
    const current = await exchange()
    const native = current.state.native
    native.assistant('text', [{ type: 'text', text: 'authoritative text' }])
    const initial = [...current.state.queue]
    native.assistant('text', [{ type: 'text', text: 'authoritative text' }])
    expect(current.state.queue).toEqual(initial)
    expect(() => native.assistant('text', [{ type: 'text', text: 'changed text' }])).toThrow('BRIDGE_ASSISTANT_CONFLICT')
    nativeCall(native, 'duplicate-native')
    native.toolEnd('duplicate-native', 'canonical output')
    native.toolEnd('duplicate-native', 'canonical output')
    expect(current.state.tools.get('duplicate-native')!.result).toEqual({ output: 'canonical output', isError: false })
    expect(() => native.toolEnd('duplicate-native', 'changed output')).toThrow('BRIDGE_TOOL_RESULT_CONFLICT')
    expect(() => native.assistant('foreign-assistant', [{ type: 'tool-call', id: 'duplicate-native', name: 'shell_command', arguments: '{}' }])).toThrow('BRIDGE_TOOL_CONFLICT')
  })

  it('does not dispatch an inherited tool body for an unpresented native call', async () => {
    const inherited = inheritedTool()
    const current = await exchange()
    const result = await execute('never-presented', current.state.signal)
    expect(inherited).not.toHaveBeenCalled()
    expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('BRIDGE_TOOL_NOT_PRESENTED') }] })
    expect(current.state.signal.aborted).toBe(true)
    expect(current.state.failure).toMatchObject({ message: expect.stringContaining('BRIDGE_TOOL_NOT_PRESENTED') })
  })

  it('keeps pre-dispatch cancellation attributed by the real ToolRuntime instead of accepting a native result', async () => {
    const inherited = inheritedTool()
    const current = await exchange()
    nativeCall(current.state.native, 'cancelled-before-dispatch')
    current.state.native.toolEnd('cancelled-before-dispatch', 'native already finished')
    const cancellation = new AbortController()
    cancellation.abort(new Error('caller cancelled before official dispatch'))
    const result = await execute('cancelled-before-dispatch', cancellation.signal)
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'ABORTED_BEFORE_DISPATCH' } } })
    expect(inherited).not.toHaveBeenCalled()
    expect(current.state.tools.get('cancelled-before-dispatch')!.dispatched).toBe(false)
    expect(current.state.tools.get('cancelled-before-dispatch')!.accepted).toBe(false)
    expect(current.state.signal.aborted).toBe(true)
    expect(current.state.failure).toMatchObject({ message: expect.stringContaining('BRIDGE_TOOL_RESULT_REJECTED') })
  })
})
