import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import type { NativeModelCatalog, NativeTurnOptions } from '../../shared/native-model'
import type { NativeSession } from '../backends/types'
import type { HostContext, PlatformLoader, RuntimeModules } from '../types'
import { createRequire } from 'node:module'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import * as llmModule from '@deepseek-ai/dsh-llm'
import { assertContiguous, materializeAppendBatch, materializeCreateHeader, SessionPersistence, SessionPersistenceRevision, validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../apply'
import { createClaudeSession } from '../backends/claude'
import { createCodexSession } from '../backends/codex'
import { resetRuntime, runtime } from '../config/runtime'
import { detectBackend } from '../utils/detection'
import { identity } from './identity'
import { model } from './model'
import { session } from './session'

vi.mock('../utils/detection', () => ({ detectBackend: vi.fn() }))
vi.mock('../backends/codex', () => ({ createCodexSession: vi.fn() }))
vi.mock('../backends/claude', () => ({ createClaudeSession: vi.fn() }))

const packageId: string = 'dsh-session-current'
const sessionModule = await import(packageId) as typeof import('@deepseek-ai/dsh-session') & Pick<RuntimeModules, 'appendPluginRecord' | 'pluginRecordOf'>
const require = createRequire(import.meta.url)
const coreRequire = createRequire(require.resolve('@deepseek-ai/dsh-agent-loop'))
const promptModule: { SystemPrompt: new (ctx: Context, config: { includeHarnessIdentity: boolean, includeRuntimeContext: boolean }) => Context['systemPrompt'] } = await import(pathToFileURL(coreRequire.resolve('@deepseek-ai/dsh-system-prompt')).href)
interface StoredSession { header: Session['header'], inheritedEventCount: Session['inheritedEventCount'], events: readonly SessionEvent[], durable: readonly SessionEvent[], owner?: symbol }

class MemoryPersistence extends SessionPersistence {
  readonly stored = new Map<Session['id'], StoredSession>()
  readonly writers = new Map<Session['id'], SessionHandle>()
  barrier: () => Promise<void> = async () => {}

  async create(header: Session['header'], options?: { inheritedEventCount?: Session['inheritedEventCount'], signal?: AbortSignal }): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    if (this.stored.has(header.id))
      throw new Error('memory session already exists')
    const stored: StoredSession = { header: materializeCreateHeader(header), inheritedEventCount: options?.inheritedEventCount ?? sessionModule.SessionLogOffset(0), events: [], durable: [] }
    this.stored.set(header.id, stored)
    return this.open(header.id, 'write', options)
  }

  async open(id: Session['id'], access: SessionHandle['access'], options?: { signal?: AbortSignal }): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    const stored = this.stored.get(id)
    if (!stored)
      throw new Error('memory session missing')
    if (access === 'write' && stored.owner !== undefined)
      throw new Error('memory session already owned')
    const owner = Symbol(id)
    if (access === 'write')
      stored.owner = owner
    let closed = false
    const active = () => {
      if (closed)
        throw new Error('memory session handle closed')
      if (access === 'write' && stored.owner !== owner)
        throw new Error('memory session ownership lost')
    }
    const flush = async () => {
      active()
      if (access !== 'write')
        throw new Error('memory session is read-only')
      await this.barrier()
      stored.durable = validateStoredEvents(stored.header, structuredClone([...stored.events]))
    }
    const close = async () => {
      if (closed)
        return
      if (access === 'write') {
        await flush()
        if (stored.owner === owner)
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
          throw new Error('memory session is read-only')
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

const cwd = process.cwd()
const now = 1_791_576_000_000
const initial: NativeTurnOptions = { model: null, reasoningEffort: null }
const selected: NativeTurnOptions = { model: 'vendor/reasoning-model', reasoningEffort: 'deep' }
const directory: NativeModelCatalog = {
  defaultModel: 'vendor/reasoning-model',
  models: [
    { id: 'vendor/reasoning-model', name: 'Native reasoning model', reasoning: { defaultEffort: 'standard', efforts: [{ id: 'standard', name: 'Standard' }, { id: 'deep', name: 'Deep' }] } },
    { id: 'vendor/plain-model', name: 'Native plain model' },
    { id: 'gpt-5.4', name: 'Native custom GPT route' },
  ],
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

function native(id: string, catalog: NativeModelCatalog = directory) {
  return {
    id,
    models: vi.fn<NonNullable<NativeSession['models']>>().mockResolvedValue(catalog),
    submit: vi.fn<NativeSession['submit']>().mockResolvedValue(undefined),
    dispose: vi.fn<NativeSession['dispose']>().mockResolvedValue(undefined),
  }
}

let context: Context
let agents: AgentRegistry
let sessions: InstanceType<typeof sessionModule.SessionStore>
let projections: SessionProjectionRegistry
let llm: llmModule.LlmRuntime
let handles: AgentHandle[]
let errors: unknown[]
let persisted: Map<string, readonly SessionEvent[]>
let persistence: MemoryPersistence
let checkpoints: string[]
let stopCheckpoint: () => void
let releases: Array<() => void>
let background: Promise<unknown>[]
let disposeBridge: () => Promise<void>

async function mountBridge() {
  const bridge = context.plugin((ctx) => {
    apply(ctx as HostContext)
  })
  disposeBridge = () => bridge.dispose()
  await bridge.await()
  await vi.waitFor(() => expect(runtime.ready).toBe(true))
}

beforeEach(async () => {
  vi.setSystemTime(now)
  await resetRuntime()
  vi.mocked(createCodexSession).mockReset()
  vi.mocked(createClaudeSession).mockReset()
  vi.mocked(detectBackend).mockReset()
  vi.mocked(detectBackend).mockImplementation(async id => ({
    detection: { id, installed: true, auth: 'ok', version: 'test', drift: false, hint: null },
    command: { file: 'boundary-only', args: [id] },
  }))
  context = new Context()
  agents = new AgentRegistry(context)
  sessions = new sessionModule.SessionStore(context)
  projections = new SessionProjectionRegistry(context)
  llm = new llmModule.LlmRuntime(context)
  handles = []
  errors = []
  persisted = new Map()
  persistence = new MemoryPersistence(context)
  checkpoints = []
  releases = []
  background = []
  const create = agents.create.bind(agents)
  vi.spyOn(agents, 'create').mockImplementation(async (...args) => {
    const handle = await create(...args)
    handles.push(handle)
    return handle
  })
  context.on('agent/error', ({ error }) => errors.push(error))
  stopCheckpoint = context.on('session/flush', checkpointOfficial)
  await context.plugin(AgentDefaultModelConfig, { provider: 'global-provider', model: 'global-model', reasoningEffort: 'global-effort' }).await()
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
  context.provide('agentPresets', { resolve: vi.fn().mockResolvedValue({ id: 'test-preset' }), mount: vi.fn().mockResolvedValue(undefined) } as unknown as HostContext['agentPresets'])
  context.provide('workspaceRegistry', { get: () => undefined } as unknown as HostContext['workspaceRegistry'])
  await context.plugin(AgentLoop, { agents: [] }).await()
  await mountBridge()
})

afterEach(async () => {
  for (const release of releases)
    release()
  await Promise.allSettled(background)
  persistence.barrier = async () => {}
  await session.dispose()
  await context.fiber.dispose()
  await resetRuntime()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function checkpointOfficial(official: Session) {
  const handle = persistence.writers.get(official.id)
  if (!handle)
    throw new Error('official session has no memory write owner')
  const stored = persistence.stored.get(official.id)!
  const suffix = official.snapshotEvents().slice(stored.events.length)
  if (suffix.length > 0)
    await handle.append(suffix)
  await handle.flush()
  checkpoints.push(official.id)
  persisted.set(official.id, structuredClone(stored.durable))
}

async function create(connection = native('model-native'), backend: 'codex' | 'claude' = 'codex') {
  vi.mocked(backend === 'codex' ? createCodexSession : createClaudeSession).mockResolvedValueOnce(connection)
  const result = await session.create(backend, undefined, cwd)
  const agent = agents.get(sessionModule.SessionId(result.sessionId))!
  expect(agent.session).toBe(sessions.get(agent.id))
  return { agent, connection }
}

function modelEvents(official: Session) {
  return official.snapshotEvents().filter(event => (event.type as string) === 'plugin:dsh-tauri-kernel/model')
}

function followup(agent: Agent, text: string) {
  agent.followup(llmModule.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  const task = agent.whenIdle()
  background.push(task)
  return task
}

function checkUnchangedRoute(agent: Agent, started = false) {
  expect(agent.options).toMatchObject({ provider: 'dsh-tauri-kernel', model: 'codex' })
  expect(agent.session.requestHeader()?.config).toEqual(started ? { provider: 'dsh-tauri-kernel', model: 'codex' } : undefined)
  expect(context.agentDefaultModel.currentSelection()).toEqual({ provider: 'global-provider', model: 'global-model', reasoningEffort: 'global-effort' })
}

describe('official native model selection', () => {
  it.each(['codex', 'claude'] as const)('reads the actual %s catalog without submitting or creating model records', async (backend) => {
    const { agent, connection } = await create(native(`catalog-${backend}`), backend)
    const cursor = Number(agent.session.seq)
    expect(await model.getCatalog(agent.id)).toEqual({
      backend,
      defaultModel: 'vendor/reasoning-model',
      models: [
        { id: 'vendor/reasoning-model', name: 'Native reasoning model', reasoning: { defaultEffort: 'standard', efforts: [{ id: 'standard', name: 'Standard' }, { id: 'deep', name: 'Deep' }] } },
        { id: 'vendor/plain-model', name: 'Native plain model' },
        { id: 'gpt-5.4', name: 'Native custom GPT route' },
      ],
      current: { model: null, reasoningEffort: null },
    })
    expect(connection.models).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal))
    expect(connection.submit).not.toHaveBeenCalled()
    expect(modelEvents(agent.session)).toEqual([])
    expect(agent.session.seq).toBe(cursor)
    expect(createCodexSession).toHaveBeenCalledTimes(backend === 'codex' ? 1 : 0)
    expect(createClaudeSession).toHaveBeenCalledTimes(backend === 'claude' ? 1 : 0)
  }, 10_000)

  it('preserves acknowledged native defaults without treating a catalog preset as the effective effort', async () => {
    const catalog: NativeModelCatalog = { ...directory, defaultReasoningEffort: 'deep' }
    const { agent, connection } = await create(native('effective-default-native', catalog))
    expect(await model.getCatalog(agent.id)).toEqual({ ...catalog, backend: 'codex', current: initial })
    expect(model.resolve(agent)).toEqual(initial)
    expect(modelEvents(agent.session)).toEqual([])
    expect(connection.submit).not.toHaveBeenCalled()
    checkUnchangedRoute(agent)
  }, 10_000)

  it('preserves a configured default effort without inventing selectable reasoning controls', async () => {
    const catalog: NativeModelCatalog = { defaultModel: 'custom-model', defaultReasoningEffort: 'high', models: [{ id: 'custom-model', name: 'custom-model' }] }
    const { agent, connection } = await create(native('configured-effort-native', catalog))
    expect(await model.getCatalog(agent.id)).toEqual({ ...catalog, backend: 'codex', current: initial })
    await expect(model.select(agent.id, { model: null, reasoningEffort: 'high' })).rejects.toThrow('BRIDGE_REASONING_UNAVAILABLE')
    expect(modelEvents(agent.session)).toEqual([])
    expect(connection.submit).not.toHaveBeenCalled()
    checkUnchangedRoute(agent)
  }, 10_000)

  it('commits exactly one ignorable record and an awaited official durability checkpoint without changing DSH defaults', async () => {
    const { agent, connection } = await create()
    const cursor = Number(agent.session.seq)
    const binding = identity.resolve(agent)
    const providers = llm.listProviders()
    expect(await model.select(agent.id, selected)).toEqual({ model: 'vendor/reasoning-model', reasoningEffort: 'deep' })
    expect(modelEvents(agent.session)).toEqual([{ seq: cursor, time: now, type: 'plugin:dsh-tauri-kernel/model', ignorable: true, data: { model: 'vendor/reasoning-model', reasoningEffort: 'deep' } }])
    expect(model.resolve(agent)).toEqual({ model: 'vendor/reasoning-model', reasoningEffort: 'deep' })
    expect(projections.stateOf(agent.session, 'bridgeModel')).toEqual({ model: 'vendor/reasoning-model', reasoningEffort: 'deep' })
    expect(agent.session.seq).toBe(cursor + 1)
    expect(checkpoints).toEqual([agent.id])
    expect(persisted.get(agent.id)?.find(event => event.seq === cursor)).toEqual({ seq: cursor, time: now, type: 'plugin:dsh-tauri-kernel/model', ignorable: true, data: { model: 'vendor/reasoning-model', reasoningEffort: 'deep' } })
    expect(identity.resolve(agent)).toEqual(binding)
    checkUnchangedRoute(agent)
    expect(llm.listProviders()).toEqual(providers)
    expect(connection.submit).not.toHaveBeenCalled()
    expect(createCodexSession).toHaveBeenCalledOnce()
  }, 10_000)

  it('resets both controls to the native defaults without rewriting identity or the route', async () => {
    const { agent, connection } = await create()
    await model.select(agent.id, selected)
    const cursor = Number(agent.session.seq)
    expect(await model.select(agent.id, initial)).toEqual({ model: null, reasoningEffort: null })
    expect(modelEvents(agent.session).map(event => ({ seq: event.seq, data: event.data }))).toEqual([
      { seq: cursor - 1, data: { model: 'vendor/reasoning-model', reasoningEffort: 'deep' } },
      { seq: cursor, data: { model: null, reasoningEffort: null } },
    ])
    expect(model.resolve(agent)).toEqual({ model: null, reasoningEffort: null })
    expect(checkpoints).toEqual([agent.id, agent.id])
    checkUnchangedRoute(agent)
    expect(connection.submit).not.toHaveBeenCalled()
  }, 10_000)

  it('checkpoints an unchanged choice without adding a duplicate official record', async () => {
    const { agent, connection } = await create()
    await model.select(agent.id, selected)
    const cursor = Number(agent.session.seq)
    const first = modelEvents(agent.session)
    await model.select(agent.id, { model: 'vendor/reasoning-model', reasoningEffort: 'deep' })
    expect(modelEvents(agent.session)).toEqual(first)
    expect(agent.session.seq).toBe(cursor)
    expect(checkpoints).toEqual([agent.id, agent.id])
    expect(connection.models).toHaveBeenCalledTimes(2)
    expect(connection.submit).not.toHaveBeenCalled()
  }, 10_000)

  it.each([
    [{ model: 'missing-model', reasoningEffort: null }, 'BRIDGE_MODEL_UNAVAILABLE'],
    [{ model: 'vendor/reasoning-model', reasoningEffort: 'high' }, 'BRIDGE_REASONING_UNAVAILABLE'],
    [{ model: 'vendor/plain-model', reasoningEffort: 'deep' }, 'BRIDGE_REASONING_UNAVAILABLE'],
    [{ model: 'gpt-5.4', reasoningEffort: 'xhigh' }, 'BRIDGE_REASONING_UNAVAILABLE'],
    [{ model: null, reasoningEffort: 'xhigh' }, 'BRIDGE_REASONING_UNAVAILABLE'],
  ] satisfies Array<[NativeTurnOptions, string]>)('rejects unadvertised native choice %j before records, flush, or submit', async (options, error) => {
    const { agent, connection } = await create()
    const cursor = Number(agent.session.seq)
    await expect(model.select(agent.id, options)).rejects.toThrow(error)
    expect(modelEvents(agent.session)).toEqual([])
    expect(model.resolve(agent)).toEqual({ model: null, reasoningEffort: null })
    expect(agent.session.seq).toBe(cursor)
    expect(checkpoints).toEqual([])
    expect(connection.submit).not.toHaveBeenCalled()
    checkUnchangedRoute(agent)
  }, 10_000)

  it('uses only the advertised custom default model for a null model plus explicit effort', async () => {
    const catalog: NativeModelCatalog = { defaultModel: 'custom/private-default', models: [{ id: 'custom/private-default', name: 'Custom provider default', reasoning: { efforts: [{ id: 'careful', name: 'Careful' }] } }] }
    const { agent, connection } = await create(native('custom-default-native', catalog))
    await expect(model.select(agent.id, { model: null, reasoningEffort: 'high' })).rejects.toThrow('BRIDGE_REASONING_UNAVAILABLE')
    expect(await model.select(agent.id, { model: null, reasoningEffort: 'careful' })).toEqual({ model: null, reasoningEffort: 'careful' })
    expect(modelEvents(agent.session).map(event => event.data)).toEqual([{ model: null, reasoningEffort: 'careful' }])
    expect(connection.submit).not.toHaveBeenCalled()
    checkUnchangedRoute(agent)
  }, 10_000)

  it('does not invent a default model when the native catalog advertises none', async () => {
    const { agent, connection } = await create(native('no-default-native', { models: [{ id: 'only-explicit', name: 'Explicit model', reasoning: { efforts: [{ id: 'deep', name: 'Deep' }] } }] }))
    await expect(model.select(agent.id, { model: null, reasoningEffort: 'deep' })).rejects.toThrow('BRIDGE_REASONING_UNAVAILABLE')
    expect(await model.select(agent.id, initial)).toEqual({ model: null, reasoningEffort: null })
    expect(modelEvents(agent.session)).toEqual([])
    expect(checkpoints).toEqual([agent.id])
    expect(connection.submit).not.toHaveBeenCalled()
  }, 10_000)

  it('refuses a native backend without model discovery rather than guessing supported controls', async () => {
    const connection = native('unsupported-catalog')
    Reflect.deleteProperty(connection, 'models')
    const { agent } = await create(connection)
    await expect(model.getCatalog(agent.id)).rejects.toThrow('BRIDGE_MODEL_UNSUPPORTED')
    await expect(model.select(agent.id, initial)).rejects.toThrow('BRIDGE_MODEL_UNSUPPORTED')
    expect(modelEvents(agent.session)).toEqual([])
    expect(checkpoints).toEqual([])
    expect(connection.submit).not.toHaveBeenCalled()
    expect(createCodexSession).toHaveBeenCalledOnce()
  }, 10_000)

  it.each([
    { defaultModel: 'not-in-directory', models: [{ id: 'valid', name: 'Valid model' }] },
    { defaultReasoningEffort: 'high', models: [{ id: 'valid', name: 'Valid model' }] },
    { models: [{ id: 'duplicate', name: 'One' }, { id: 'duplicate', name: 'Two' }] },
    { models: [{ id: 'bad-efforts', name: 'Bad', reasoning: { efforts: [{ id: 'deep', name: 'One' }, { id: 'deep', name: 'Two' }] } }] },
    { models: [{ id: 'bad-default-effort', name: 'Bad', reasoning: { defaultEffort: 'high', efforts: [{ id: 'deep', name: 'Deep' }] } }] },
  ] satisfies NativeModelCatalog[])('rejects an inconsistent native catalog %j without recording speculative options', async (catalog) => {
    const { agent, connection } = await create(native('invalid-directory', catalog))
    await expect(model.getCatalog(agent.id)).rejects.toThrow('BRIDGE_MODEL_CATALOG_INVALID')
    await expect(model.select(agent.id, initial)).rejects.toThrow('BRIDGE_MODEL_CATALOG_INVALID')
    expect(modelEvents(agent.session)).toEqual([])
    expect(checkpoints).toEqual([])
    expect(connection.submit).not.toHaveBeenCalled()
  }, 10_000)

  it('rejects unknown and ordinary DSH sessions instead of using another native owner', async () => {
    const { agent, connection } = await create()
    const ordinary = await agents.create({ sessionId: sessionModule.SessionId('ordinary-model-session'), meta: { cwd }, agentOptions: { provider: 'global-provider', model: 'global-model' } })
    await expect(model.getCatalog('foreign-model-session')).rejects.toThrow('BRIDGE_SESSION_UNAVAILABLE')
    await expect(model.select('foreign-model-session', selected)).rejects.toThrow('BRIDGE_SESSION_UNAVAILABLE')
    await expect(model.getCatalog(ordinary.agent.id)).rejects.toThrow('BRIDGE_BINDING_MISSING')
    await expect(model.select(ordinary.agent.id, selected)).rejects.toThrow('BRIDGE_BINDING_MISSING')
    expect(connection.models).not.toHaveBeenCalled()
    expect(connection.submit).not.toHaveBeenCalled()
    expect(modelEvents(agent.session)).toEqual([])
    expect(modelEvents(ordinary.agent.session)).toEqual([])
    expect(createCodexSession).toHaveBeenCalledOnce()
    expect(createClaudeSession).not.toHaveBeenCalled()
  }, 10_000)

  it('fails a read-only checkpoint without reporting a successful selection', async () => {
    const { agent, connection } = await create()
    stopCheckpoint()
    const cursor = Number(agent.session.seq)
    await expect(model.select(agent.id, selected)).rejects.toThrow('BRIDGE_MODEL_NOT_PERSISTED')
    expect(modelEvents(agent.session)).toEqual([{ seq: cursor, time: now, type: 'plugin:dsh-tauri-kernel/model', ignorable: true, data: { model: 'vendor/reasoning-model', reasoningEffort: 'deep' } }])
    expect(persisted.has(agent.id)).toBe(false)
    expect(checkpoints).toEqual([])
    expect(connection.submit).not.toHaveBeenCalled()
    checkUnchangedRoute(agent)
  }, 10_000)

  it('propagates flush failure and retries the same official choice without duplicating its event', async () => {
    const { agent, connection } = await create()
    stopCheckpoint()
    const failure = new Error('native model durability refused')
    const stopFailure = context.on('session/flush', async () => {
      throw failure
    })
    const cursor = Number(agent.session.seq)
    await expect(model.select(agent.id, selected)).rejects.toBe(failure)
    expect(modelEvents(agent.session)).toEqual([{ seq: cursor, time: now, type: 'plugin:dsh-tauri-kernel/model', ignorable: true, data: { model: 'vendor/reasoning-model', reasoningEffort: 'deep' } }])
    expect(persisted.has(agent.id)).toBe(false)
    expect(connection.submit).not.toHaveBeenCalled()
    stopFailure()
    context.on('session/flush', checkpointOfficial)
    expect(await model.select(agent.id, selected)).toEqual({ model: 'vendor/reasoning-model', reasoningEffort: 'deep' })
    expect(agent.session.seq).toBe(cursor + 1)
    expect(modelEvents(agent.session)).toHaveLength(1)
    expect(checkpoints).toEqual([agent.id])
    expect(persisted.get(agent.id)?.find(event => event.seq === cursor)).toEqual({ seq: cursor, time: now, type: 'plugin:dsh-tauri-kernel/model', ignorable: true, data: { model: 'vendor/reasoning-model', reasoningEffort: 'deep' } })
    expect(connection.submit).not.toHaveBeenCalled()
  }, 10_000)

  it('keeps a real native first turn behind an unfinished model persistence checkpoint', async () => {
    const connection = native('pending-model-native')
    const submitted = deferred<void>()
    vi.mocked(createCodexSession).mockImplementationOnce(async (_command, _cwd, _storedId, output) => {
      connection.submit.mockImplementation(async () => {
        submitted.resolve()
        output.assistant('pending-model-answer', [{ type: 'text', text: 'durable controls admitted' }])
      })
      return connection
    })
    const result = await session.create('codex', undefined, cwd)
    const agent = agents.get(sessionModule.SessionId(result.sessionId))!
    const entered = deferred<void>()
    const drain = deferred<void>()
    releases.push(() => drain.resolve())
    persistence.barrier = async () => {
      entered.resolve()
      await drain.promise
    }
    const selection = model.select(agent.id, selected)
    background.push(selection)
    await entered.promise
    let idle = false
    const turn = followup(agent, 'wait for the native controls to become durable').then(() => {
      idle = true
    })
    background.push(turn)
    await vi.waitFor(() => expect(runtime.steps.has(agent.id)).toBe(true))
    expect(idle).toBe(false)
    expect(connection.submit).not.toHaveBeenCalled()
    expect(runtime.exchanges.size).toBe(0)
    expect(persistence.stored.get(agent.id)?.durable.some(event => (event.type as string) === 'plugin:dsh-tauri-kernel/model')).toBe(false)
    drain.resolve()
    expect(await selection).toEqual({ model: 'vendor/reasoning-model', reasoningEffort: 'deep' })
    await submitted.promise
    await turn
    expect(connection.submit).toHaveBeenCalledOnce()
    expect(connection.submit.mock.calls[0]![0]).toMatchObject([{ source: { kind: 'user' }, content: [{ type: 'text', text: 'wait for the native controls to become durable' }] }])
    expect(connection.submit.mock.calls[0]![2]).toEqual({ model: 'vendor/reasoning-model', reasoningEffort: 'deep' })
    expect(checkpoints).toEqual([agent.id])
    expect(errors).toEqual([])
    expect(createCodexSession).toHaveBeenCalledOnce()
    checkUnchangedRoute(agent, true)
  }, 10_000)

  it('blocks actual native admission after a failed checkpoint and retries the same official record before submitting', async () => {
    const connection = native('failed-checkpoint-native')
    vi.mocked(createCodexSession).mockImplementationOnce(async (_command, _cwd, _storedId, output) => {
      connection.submit.mockImplementation(async () => output.assistant('retry-checkpoint-answer', [{ type: 'text', text: 'durable retry admitted' }]))
      return connection
    })
    const created = await session.create('codex', undefined, cwd)
    const agent = agents.get(sessionModule.SessionId(created.sessionId))!
    const cursor = Number(agent.session.seq)
    const failure = new Error('first native model durability checkpoint refused')
    persistence.barrier = async () => {
      throw failure
    }
    await expect(model.select(agent.id, selected)).rejects.toBe(failure)
    await followup(agent, 'must not submit the unpersisted choice')
    expect(connection.submit).not.toHaveBeenCalled()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ name: 'LlmError', code: 'UNKNOWN', message: 'first native model durability checkpoint refused', failure: { code: 'UNKNOWN', message: 'first native model durability checkpoint refused' } })
    expect(runtime.exchanges.size).toBe(0)
    expect(modelEvents(agent.session)).toEqual([{ seq: cursor, time: now, type: 'plugin:dsh-tauri-kernel/model', ignorable: true, data: { model: 'vendor/reasoning-model', reasoningEffort: 'deep' } }])
    persistence.barrier = async () => {}
    expect(await model.select(agent.id, selected)).toEqual({ model: 'vendor/reasoning-model', reasoningEffort: 'deep' })
    expect(modelEvents(agent.session)).toHaveLength(1)
    expect(persistence.stored.get(agent.id)?.durable.find(event => event.seq === cursor)).toEqual({ seq: cursor, time: now, type: 'plugin:dsh-tauri-kernel/model', ignorable: true, data: { model: 'vendor/reasoning-model', reasoningEffort: 'deep' } })
    await followup(agent, 'submit only after the saved choice is proven')
    expect(connection.submit).toHaveBeenCalledOnce()
    expect(connection.submit.mock.calls[0]![2]).toEqual({ model: 'vendor/reasoning-model', reasoningEffort: 'deep' })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ name: 'LlmError', code: 'UNKNOWN', message: 'first native model durability checkpoint refused', failure: { code: 'UNKNOWN', message: 'first native model durability checkpoint refused' } })
    expect(createCodexSession).toHaveBeenCalledOnce()
    checkUnchangedRoute(agent, true)
  }, 10_000)

  it('rejects a no-op flush observer that settles true without storing the official model record', async () => {
    const { agent, connection } = await create()
    stopCheckpoint()
    const observer = vi.fn().mockResolvedValue(undefined)
    context.on('session/flush', observer)
    const cursor = Number(agent.session.seq)
    await expect(model.select(agent.id, selected)).rejects.toThrow('BRIDGE_MODEL_NOT_PERSISTED')
    expect(observer).toHaveBeenCalledOnce()
    expect(observer.mock.calls[0]![0]).toBe(agent.session)
    expect(modelEvents(agent.session)).toEqual([{ seq: cursor, time: now, type: 'plugin:dsh-tauri-kernel/model', ignorable: true, data: { model: 'vendor/reasoning-model', reasoningEffort: 'deep' } }])
    expect(persistence.stored.get(agent.id)?.events).toHaveLength(cursor)
    expect(persistence.stored.get(agent.id)?.durable).toHaveLength(cursor)
    expect(connection.submit).not.toHaveBeenCalled()
    expect(createCodexSession).toHaveBeenCalledOnce()
  }, 10_000)

  it('reconstructs an unsaved choice after bridge remount and refuses native admission until official persistence proves it', async () => {
    const { agent, connection } = await create(native('remount-model-native'))
    stopCheckpoint()
    await expect(model.select(agent.id, selected)).rejects.toThrow('BRIDGE_MODEL_NOT_PERSISTED')
    const before = modelEvents(agent.session)
    await disposeBridge()
    expect(connection.dispose).toHaveBeenCalledOnce()
    expect(agents.get(agent.id)).toBe(agent)
    expect(sessions.get(agent.id)).toBe(agent.session)
    await mountBridge()
    expect(model.resolve(agent)).toEqual({ model: 'vendor/reasoning-model', reasoningEffort: 'deep' })
    await followup(agent, 'no remount may bypass the failed model write')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ message: expect.stringContaining('BRIDGE_MODEL_NOT_PERSISTED') })
    expect(createCodexSession).toHaveBeenCalledOnce()
    expect(connection.submit).not.toHaveBeenCalled()
    expect(modelEvents(agent.session)).toEqual(before)
    context.on('session/flush', checkpointOfficial)
    const restored = native('remount-model-native')
    vi.mocked(createCodexSession).mockImplementationOnce(async (_command, _cwd, _storedId, output) => {
      restored.submit.mockImplementation(async () => output.assistant('remount-model-answer', [{ type: 'text', text: 'canonical saved choice restored' }]))
      return restored
    })
    await followup(agent, 'admit the now durable canonical choice')
    expect(restored.submit).toHaveBeenCalledOnce()
    expect(restored.submit.mock.calls[0]![2]).toEqual({ model: 'vendor/reasoning-model', reasoningEffort: 'deep' })
    expect(createCodexSession).toHaveBeenCalledTimes(2)
    expect(vi.mocked(createCodexSession).mock.calls[1]![2]).toBe('remount-model-native')
    expect(vi.mocked(createCodexSession).mock.calls[1]![5]).toBeUndefined()
    expect(modelEvents(agent.session)).toEqual(before)
    expect(persistence.stored.get(agent.id)?.durable.filter(event => (event.type as string) === 'plugin:dsh-tauri-kernel/model')).toEqual(before)
    expect(errors).toHaveLength(1)
    checkUnchangedRoute(agent, true)
  }, 10_000)

  it.each(['catalog', 'selection'] as const)('never adopts an old %s catalog result after unload and remount', async (operation) => {
    const { agent, connection } = await create(native(`old-${operation}-native`))
    const entered = deferred<void>()
    const finish = deferred<void>()
    const catalog = deferred<NativeModelCatalog>()
    releases.push(() => catalog.resolve(directory))
    connection.models.mockImplementationOnce(async () => {
      entered.resolve()
      const value = await catalog.promise
      finish.resolve()
      return value
    })
    const cursor = Number(agent.session.seq)
    const request = operation === 'catalog' ? model.getCatalog(agent.id) : model.select(agent.id, selected)
    const rejected = expect(request).rejects.toThrow('BRIDGE_DISPOSED')
    background.push(rejected)
    await entered.promise
    await disposeBridge()
    await rejected
    expect(connection.dispose).toHaveBeenCalledOnce()
    await mountBridge()
    catalog.resolve(directory)
    await finish.promise
    expect(modelEvents(agent.session)).toEqual([])
    expect(agent.session.seq).toBe(cursor)
    expect(model.resolve(agent)).toEqual({ model: null, reasoningEffort: null })
    expect(checkpoints).toEqual([])
    expect(connection.submit).not.toHaveBeenCalled()
    expect(createCodexSession).toHaveBeenCalledOnce()
    expect(createClaudeSession).not.toHaveBeenCalled()
    expect(agents.get(agent.id)).toBe(agent)
    expect(sessions.get(agent.id)).toBe(agent.session)
    checkUnchangedRoute(agent)
  }, 10_000)

  it('hydrates frozen model options from a cold official session and restores only its committed native id', async () => {
    const { agent, connection } = await create(native('cold-model-native'))
    await model.select(agent.id, selected)
    const oldHandle = handles.find(handle => handle.agent === agent)!
    const cursor = Number(agent.session.seq)
    await oldHandle.dispose()
    await session.remove(agent.id)
    const open = vi.spyOn(persistence, 'open')
    const createStored = vi.spyOn(persistence, 'create')
    const restored = await agents.resume({ resumeSessionId: agent.id, agentOptions: { provider: 'dsh-tauri-kernel', model: 'codex' } })
    const restoredWrite = persistence.writers.get(agent.id)!
    const close = vi.spyOn(restoredWrite, 'close')
    expect(open).toHaveBeenCalledExactlyOnceWith(agent.id, 'write', { signal: expect.any(AbortSignal) })
    expect(persistence.stored.get(agent.id)?.durable).toEqual(persisted.get(agent.id))
    expect(createStored).not.toHaveBeenCalled()
    expect(restored.agent.session).not.toBe(agent.session)
    expect(restored.agent.session.seq).toBe(cursor + 1)
    expect(restored.agent.session.snapshotEvents()).toEqual([...agent.session.snapshotEvents(), { seq: cursor, time: now, type: 'session/end-seed', data: {} }])
    const options = model.resolve(restored.agent)
    expect(options).toEqual({ model: 'vendor/reasoning-model', reasoningEffort: 'deep' })
    expect(Object.isFrozen(options)).toBe(true)
    expect(Reflect.set(options, 'model', 'unadvertised-replacement')).toBe(false)
    expect(model.resolve(restored.agent)).toEqual({ model: 'vendor/reasoning-model', reasoningEffort: 'deep' })
    const resumed = native('cold-model-native')
    vi.mocked(createCodexSession).mockResolvedValueOnce(resumed)
    expect(await model.getCatalog(restored.agent.id)).toMatchObject({ backend: 'codex', current: { model: 'vendor/reasoning-model', reasoningEffort: 'deep' } })
    expect(createCodexSession).toHaveBeenCalledTimes(2)
    expect(vi.mocked(createCodexSession).mock.calls[1]![2]).toBe('cold-model-native')
    expect(vi.mocked(createCodexSession).mock.calls[1]![5]).toBeUndefined()
    expect(resumed.models).toHaveBeenCalledOnce()
    expect(resumed.submit).not.toHaveBeenCalled()
    expect(modelEvents(restored.agent.session)).toEqual(modelEvents(agent.session))
    expect(connection.dispose).toHaveBeenCalledOnce()
    await restored.dispose()
    await session.remove(restored.agent.id)
    expect(close).toHaveBeenCalledOnce()
    expect(resumed.dispose).toHaveBeenCalledOnce()
  }, 10_000)

  it('finishes two native tool continuations with the original options after a concurrent selection fails to flush', async () => {
    const firstTool = deferred<void>()
    const secondTool = deferred<void>()
    const stepTwo = deferred<void>()
    const stepThree = deferred<void>()
    releases.push(() => firstTool.resolve(), () => secondTool.resolve())
    const connection = native('failed-mid-turn-selection')
    vi.mocked(createCodexSession).mockImplementationOnce(async (_command, _cwd, _storedId, output) => {
      connection.submit.mockImplementationOnce(async () => {
        output.assistant('before-failed-selection', [{ type: 'tool-call', id: 'failed-selection-one', name: 'native_one', arguments: '{}' }])
        output.toolStart('failed-selection-one', 'native_one', '{}')
        output.toolEnd('failed-selection-one', 'first result before failed choice')
        await firstTool.promise
        output.assistant('after-failed-selection', [{ type: 'tool-call', id: 'failed-selection-two', name: 'native_two', arguments: '{}' }])
        output.toolStart('failed-selection-two', 'native_two', '{}')
        output.toolEnd('failed-selection-two', 'second result after failed choice')
        await secondTool.promise
        output.assistant('original-options-complete', [{ type: 'text', text: 'original whole turn completed' }])
      }).mockImplementation(async () => output.assistant('saved-new-options', [{ type: 'text', text: 'next durable choice used' }]))
      return connection
    })
    const created = await session.create('codex', undefined, cwd)
    const agent = agents.get(sessionModule.SessionId(created.sessionId))!
    const events: SessionEvent[] = []
    const snapshots: Array<NativeTurnOptions | undefined> = []
    agent.ctx.on('session/event', (official, event) => {
      if (official !== agent.session)
        return
      events.push(event)
      if (event.type === 'step/start' && event.data.turn === 1 && event.data.step === 2) {
        snapshots.push(runtime.exchanges.get(agent.id)?.state.input.options)
        stepTwo.resolve()
      }
      if (event.type === 'step/start' && event.data.turn === 1 && event.data.step === 3) {
        snapshots.push(runtime.exchanges.get(agent.id)?.state.input.options)
        stepThree.resolve()
      }
    })
    await model.select(agent.id, selected)
    const turn = followup(agent, 'keep the already admitted whole-turn options')
    await stepTwo.promise
    const failure = new Error('concurrent native selection could not become durable')
    persistence.barrier = async () => {
      throw failure
    }
    await expect(model.select(agent.id, { model: 'vendor/plain-model', reasoningEffort: null })).rejects.toBe(failure)
    expect(connection.submit).toHaveBeenCalledOnce()
    firstTool.resolve()
    await stepThree.promise
    expect(connection.submit).toHaveBeenCalledOnce()
    secondTool.resolve()
    await turn
    expect(snapshots).toEqual([{ model: 'vendor/reasoning-model', reasoningEffort: 'deep' }, { model: 'vendor/reasoning-model', reasoningEffort: 'deep' }])
    expect(connection.submit.mock.calls[0]![2]).toEqual({ model: 'vendor/reasoning-model', reasoningEffort: 'deep' })
    expect(events.filter(event => event.type === 'step/start').map(event => event.data)).toEqual([{ turn: 1, step: 1 }, { turn: 1, step: 2 }, { turn: 1, step: 3 }])
    expect(events.filter(event => event.type === 'tool/result').map(event => event.data.message.toolCallId)).toEqual(['failed-selection-one', 'failed-selection-two'])
    expect(events.filter(event => event.type === 'turn/end').map(event => event.data)).toEqual([{ turn: 1, reason: { kind: 'completed' } }])
    expect(errors).toEqual([])
    expect(model.resolve(agent)).toEqual({ model: 'vendor/plain-model', reasoningEffort: null })
    await followup(agent, 'cannot admit the failed replacement options yet')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ name: 'LlmError', code: 'UNKNOWN', message: 'concurrent native selection could not become durable', failure: { code: 'UNKNOWN', message: 'concurrent native selection could not become durable' } })
    expect(connection.submit).toHaveBeenCalledOnce()
    persistence.barrier = async () => {}
    await model.select(agent.id, { model: 'vendor/plain-model', reasoningEffort: null })
    await followup(agent, 'admit the retry-proven replacement options')
    expect(connection.submit).toHaveBeenCalledTimes(2)
    expect(connection.submit.mock.calls[1]![2]).toEqual({ model: 'vendor/plain-model', reasoningEffort: null })
    expect(modelEvents(agent.session).map(event => event.data)).toEqual([{ model: 'vendor/reasoning-model', reasoningEffort: 'deep' }, { model: 'vendor/plain-model', reasoningEffort: null }])
    expect(createCodexSession).toHaveBeenCalledOnce()
    expect(runtime.exchanges.size).toBe(0)
    checkUnchangedRoute(agent, true)
  }, 10_000)

  it('keeps one immutable native option snapshot across three official steps and applies concurrent selections only to the next turn', async () => {
    const firstTool = deferred<void>()
    const secondTool = deferred<void>()
    const stepTwo = deferred<void>()
    const stepThree = deferred<void>()
    releases.push(() => firstTool.resolve(), () => secondTool.resolve())
    const connection = native('snapshot-native')
    vi.mocked(createCodexSession).mockImplementationOnce(async (_command, _cwd, _storedId, output) => {
      connection.submit.mockImplementationOnce(async () => {
        output.assistant('first-work', [{ type: 'tool-call', id: 'snapshot-first', name: 'native_first', arguments: '{"path":"one"}' }])
        output.toolStart('snapshot-first', 'native_first', '{"path":"one"}')
        output.toolEnd('snapshot-first', 'first native result')
        await firstTool.promise
        output.assistant('second-work', [{ type: 'tool-call', id: 'snapshot-second', name: 'native_second', arguments: '{"path":"two"}' }])
        output.toolStart('snapshot-second', 'native_second', '{"path":"two"}')
        output.toolEnd('snapshot-second', 'second native result')
        await secondTool.promise
        output.assistant('finished', [{ type: 'text', text: 'both native steps finished' }])
      }).mockImplementation(async () => output.assistant('next-turn', [{ type: 'text', text: 'next options applied' }]))
      return connection
    })
    const created = await session.create('codex', undefined, cwd)
    const agent = agents.get(sessionModule.SessionId(created.sessionId))!
    const events: SessionEvent[] = []
    const snapshots: Array<NativeTurnOptions | undefined> = []
    agent.ctx.on('session/event', (official, event) => {
      if (official !== agent.session)
        return
      events.push(event)
      if (event.type === 'step/start' && event.data.turn === 1 && event.data.step === 2) {
        snapshots.push(runtime.exchanges.get(agent.id)?.state.input.options)
        stepTwo.resolve()
      }
      if (event.type === 'step/start' && event.data.turn === 1 && event.data.step === 3) {
        snapshots.push(runtime.exchanges.get(agent.id)?.state.input.options)
        stepThree.resolve()
      }
    })
    await model.select(agent.id, selected)
    const turn = followup(agent, 'run two consecutive native tool steps')
    await stepTwo.promise
    expect(connection.submit).toHaveBeenCalledOnce()
    expect(connection.submit.mock.calls[0]![0]).toMatchObject([{ source: { kind: 'user' }, content: [{ type: 'text', text: 'run two consecutive native tool steps' }] }])
    expect(connection.submit.mock.calls[0]![2]).toEqual({ model: 'vendor/reasoning-model', reasoningEffort: 'deep' })
    expect(Object.isFrozen(connection.submit.mock.calls[0]![2])).toBe(true)
    await model.select(agent.id, { model: 'vendor/plain-model', reasoningEffort: null })
    expect(connection.submit).toHaveBeenCalledOnce()
    firstTool.resolve()
    await stepThree.promise
    await model.select(agent.id, { model: null, reasoningEffort: 'standard' })
    expect(connection.submit).toHaveBeenCalledOnce()
    secondTool.resolve()
    await turn
    expect(snapshots).toEqual([{ model: 'vendor/reasoning-model', reasoningEffort: 'deep' }, { model: 'vendor/reasoning-model', reasoningEffort: 'deep' }])
    expect(events.filter(event => event.type === 'step/start').map(event => event.data)).toEqual([{ turn: 1, step: 1 }, { turn: 1, step: 2 }, { turn: 1, step: 3 }])
    expect(events.filter(event => event.type === 'tool/call').map(event => event.data)).toEqual([
      { turn: 1, step: 1, callId: 'snapshot-first', name: 'native_first', arguments: '{"path":"one"}' },
      { turn: 1, step: 2, callId: 'snapshot-second', name: 'native_second', arguments: '{"path":"two"}' },
    ])
    expect(events.filter(event => event.type === 'tool/result').map(event => ({ turn: event.data.turn, step: event.data.step, callId: event.data.message.toolCallId, content: event.data.message.content }))).toEqual([
      { turn: 1, step: 1, callId: 'snapshot-first', content: [{ type: 'text', text: 'first native result' }] },
      { turn: 1, step: 2, callId: 'snapshot-second', content: [{ type: 'text', text: 'second native result' }] },
    ])
    checkUnchangedRoute(agent, true)
    await followup(agent, 'use the newly selected native controls')
    expect(connection.submit).toHaveBeenCalledTimes(2)
    expect(connection.submit.mock.calls[1]![0]).toMatchObject([{ source: { kind: 'user' }, content: [{ type: 'text', text: 'use the newly selected native controls' }] }])
    expect(connection.submit.mock.calls[1]![2]).toEqual({ model: null, reasoningEffort: 'standard' })
    expect(modelEvents(agent.session).map(event => event.data)).toEqual([
      { model: 'vendor/reasoning-model', reasoningEffort: 'deep' },
      { model: 'vendor/plain-model', reasoningEffort: null },
      { model: null, reasoningEffort: 'standard' },
    ])
    expect(createCodexSession).toHaveBeenCalledOnce()
    expect(errors).toEqual([])
    expect(runtime.exchanges.size).toBe(0)
  }, 10_000)
})
