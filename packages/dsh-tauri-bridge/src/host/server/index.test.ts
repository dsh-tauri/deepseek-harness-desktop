import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import type { IncomingMessage, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { NativeModelCatalog } from '../../shared/native-model'
import type { BackendDetection } from '../../shared/types'
import type { NativeSession } from '../backends/types'
import type { HostContext, PlatformLoader, RuntimeModules } from '../types'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import * as llmModule from '@deepseek-ai/dsh-llm'
import * as legacySessionModule from '@deepseek-ai/dsh-session'
import { assertContiguous, materializeAppendBatch, materializeCreateHeader, SessionPersistence, SessionPersistenceRevision, validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import { UserQuestionService } from '@deepseek-ai/dsh-user-questions'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as bridge from '../../index'
import { createClaudeSession } from '../backends/claude'
import { createCodexSession } from '../backends/codex'
import { resetRuntime, runtime } from '../config/runtime'
import { identity } from '../service/identity'
import { session } from '../service/session'
import { detectBackend } from '../utils/detection'

vi.mock('../utils/detection', () => ({ detectBackend: vi.fn() }))
vi.mock('../backends/codex', () => ({ createCodexSession: vi.fn() }))
vi.mock('../backends/claude', () => ({ createClaudeSession: vi.fn() }))

const packageId: string = 'dsh-session-current'
const sessionModule = await import(packageId) as typeof legacySessionModule & Pick<RuntimeModules, 'appendPluginRecord' | 'pluginRecordOf'>
const require = createRequire(import.meta.url)
const coreRequire = createRequire(require.resolve('@deepseek-ai/dsh-agent-loop'))
const promptModule: { SystemPrompt: new (ctx: Context, config: { includeHarnessIdentity: boolean, includeRuntimeContext: boolean }) => Context['systemPrompt'] } = await import(pathToFileURL(coreRequire.resolve('@deepseek-ai/dsh-system-prompt')).href)

class MemoryPersistence extends SessionPersistence {
  readonly stored = new Map<Session['id'], { header: Session['header'], inheritedEventCount: Session['inheritedEventCount'], events: readonly SessionEvent[], durable: readonly SessionEvent[], owner?: symbol }>()
  readonly writers = new Map<Session['id'], SessionHandle>()
  barrier: () => Promise<void> = async () => {}

  async create(header: Session['header'], options?: { inheritedEventCount?: Session['inheritedEventCount'], signal?: AbortSignal }): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    if (this.stored.has(header.id))
      throw new Error('HTTP memory session already exists')
    this.stored.set(header.id, { header: materializeCreateHeader(header), inheritedEventCount: options?.inheritedEventCount ?? sessionModule.SessionLogOffset(0), events: [], durable: [] })
    return this.open(header.id, 'write', options)
  }

  async open(id: Session['id'], access: SessionHandle['access'], options?: { signal?: AbortSignal }): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    const stored = this.stored.get(id)
    if (!stored || (access === 'write' && stored.owner !== undefined))
      throw new Error('HTTP memory session unavailable')
    const owner = Symbol(id)
    if (access === 'write')
      stored.owner = owner
    let closed = false
    const active = () => {
      if (closed || (access === 'write' && stored.owner !== owner))
        throw new Error('HTTP memory session owner closed')
    }
    const flush = async () => {
      active()
      if (access !== 'write')
        throw new Error('HTTP memory session is read-only')
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
          throw new Error('HTTP memory session is read-only')
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
const codex: BackendDetection = { id: 'codex', installed: true, auth: 'ok', version: '0.147.0', drift: false, hint: null }
const claude: BackendDetection = { id: 'claude', installed: false, auth: 'unknown', version: null, drift: false, hint: 'BRIDGE_EXECUTABLE_MISSING: Claude CLI is not installed' }
const dsh: BackendDetection = { id: 'dsh', installed: true, auth: 'ok', version: null, drift: false, hint: null }
const catalog: NativeModelCatalog = { defaultModel: 'native/default', models: [{ id: 'native/default', name: 'Native default', reasoning: { efforts: [{ id: 'normal', name: 'Normal' }, { id: 'deep', name: 'Deep' }], defaultEffort: 'normal' } }, { id: 'native/plain', name: 'Native plain' }] }

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

function native(id = 'http-native-session') {
  return { id, models: vi.fn<NonNullable<NativeSession['models']>>().mockResolvedValue(catalog), submit: vi.fn<NativeSession['submit']>().mockResolvedValue(undefined), dispose: vi.fn<NativeSession['dispose']>().mockResolvedValue(undefined) }
}

let context: Context
let agents: AgentRegistry
let sessions: InstanceType<typeof sessionModule.SessionStore>
let projections: SessionProjectionRegistry
let llm: llmModule.LlmRuntime
let persistence: MemoryPersistence
let http: Server | undefined
let rejection: 401 | 403 | undefined
let runtimeSession: typeof legacySessionModule
let runtimeBoot: unknown
let registered: Map<string, WebRoute>
let requestRejection: ReturnType<typeof vi.fn<(request: IncomingMessage) => 401 | 403 | undefined>>
let handles: AgentHandle[]
let releases: Array<() => void>
let background: Promise<unknown>[]
let stopCheckpoint: () => void
let checkpointed: Session['id'][]

beforeEach(async () => {
  vi.setSystemTime(now)
  await resetRuntime()
  runtimeSession = sessionModule
  runtimeBoot = undefined
  rejection = undefined
  registered = new Map()
  handles = []
  releases = []
  background = []
  checkpointed = []
  vi.mocked(createCodexSession).mockReset()
  vi.mocked(createClaudeSession).mockReset()
  vi.mocked(detectBackend).mockReset()
  vi.mocked(detectBackend).mockImplementation(async id => ({ detection: { ...(id === 'codex' ? codex : claude) }, command: { file: 'boundary-only', args: [id] } }))
  context = new Context()
  agents = new AgentRegistry(context)
  sessions = new sessionModule.SessionStore(context)
  projections = new SessionProjectionRegistry(context)
  llm = new llmModule.LlmRuntime(context)
  persistence = new MemoryPersistence(context)
  const create = agents.create.bind(agents)
  vi.spyOn(agents, 'create').mockImplementation(async (...args) => {
    const handle = await create(...args)
    handles.push(handle)
    return handle
  })
  stopCheckpoint = context.on('session/flush', checkpointOfficial)
  await context.plugin(AgentDefaultModelConfig, { provider: 'global-provider', model: 'global-model', reasoningEffort: 'global-effort' }).await()
  const prompt = new promptModule.SystemPrompt(context, { includeHarnessIdentity: false, includeRuntimeContext: false })
  const tools = new ToolRuntime(context, { mode: 'native' })
  await context.plugin(ApprovalService, { policy: 'never' }).await()
  await context.plugin(UserQuestionService).await()
  expect(await prompt.assemble({})).toMatchObject({ tools: [] })
  expect(tools.schemas()).toEqual([])
  requestRejection = vi.fn(() => rejection)
  await context.plugin((ctx) => {
    ctx.provide('connection', { requestRejection } as unknown as Context['connection'])
  }).await()
  context.provide('webServer', {
    register(route: WebRoute) {
      registered.set(route.path, route)
      return () => registered.delete(route.path)
    },
  } as unknown as HostContext['webServer'])
  const loader: PlatformLoader = {
    async import(id) {
      if (id === '@deepseek-ai/dsh-llm')
        return llmModule
      if (id === '@deepseek-ai/dsh-session')
        return runtimeSession
      if (id === '@deepseek-ai/dsh-app-boot' && runtimeBoot !== undefined)
        return runtimeBoot
      throw new Error(`Unexpected public runtime import: ${id}`)
    },
    unwrapExports: value => value,
  }
  context.provide('loader', loader as HostContext['loader'])
  context.provide('agentPresets', { resolve: vi.fn().mockResolvedValue({ id: 'test-preset' }), mount: vi.fn().mockResolvedValue(undefined) } as unknown as HostContext['agentPresets'])
  context.provide('workspaceRegistry', { get: () => undefined } as unknown as HostContext['workspaceRegistry'])
  await context.plugin(AgentLoop, { agents: [] }).await()
})

afterEach(async () => {
  for (const release of releases)
    release()
  await Promise.allSettled(background)
  persistence.barrier = async () => {}
  if (http) {
    await new Promise<void>((resolve, reject) => {
      http!.close(error => error ? reject(error) : resolve())
      http!.closeAllConnections()
    })
    http = undefined
  }
  await session.dispose()
  await context.fiber.dispose()
  await resetRuntime()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function checkpointOfficial(official: Session) {
  const stored = persistence.stored.get(official.id)!
  const writer = persistence.writers.get(official.id)!
  const suffix = official.snapshotEvents().slice(stored.events.length)
  if (suffix.length > 0)
    await writer.append(suffix)
  await writer.flush()
  checkpointed.push(official.id)
}

async function start(): Promise<string> {
  const fiber = context.plugin(bridge)
  await fiber.await()
  await vi.waitFor(() => expect(runtime.ready).toBe(true))
  http = createServer((request, response) => {
    const route = registered.get(new URL(request.url ?? '/', 'http://localhost').pathname)
    if (!route) {
      response.writeHead(404).end()
      return
    }
    void Promise.resolve(route.handler(request, response)).catch(() => response.destroy())
  })
  await new Promise<void>(resolve => http!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(http.address() as AddressInfo).port}`
}

async function create(base: string, connection = native()) {
  vi.mocked(createCodexSession).mockResolvedValueOnce(connection)
  const response = await fetch(`${base}/api/tauri/bridge/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backend: 'codex', cwd }) })
  expect(response.status).toBe(200)
  const body = await response.json() as { sessionId: string }
  const agent = agents.get(sessionModule.SessionId(body.sessionId))!
  expect(agent.session).toBe(sessions.get(agent.id))
  expect(identity.resolve(agent)).toEqual({ backend: 'codex', nativeSessionId: connection.id, sessionId: body.sessionId })
  return { agent, connection }
}

function select(base: string, agent: Agent, model: string | null, reasoningEffort: string | null) {
  const task = fetch(`${base}/api/tauri/bridge/models`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: agent.id, model, reasoningEffort }) })
  background.push(task)
  return task
}

function modelEvents(official: Session) {
  return official.snapshotEvents().filter(event => (event.type as string) === 'plugin:dsh-tauri-bridge/model')
}

describe('exported bridge plugin HTTP dependency boundary', () => {
  it('returns the kernel catalog through real Cordis inject enforcement and the shared request guard', async () => {
    const base = await start()
    const response = await fetch(`${base}/api/tauri/bridge/backends`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([dsh, { ...codex, bridgeReady: true }, { ...claude, bridgeReady: true }])
    expect(requestRejection).toHaveBeenCalledOnce()
    expect(requestRejection.mock.calls[0]![0].method).toBe('GET')
    expect(vi.mocked(detectBackend).mock.calls.map(([id]) => id).sort()).toEqual(['claude', 'codex'])
    expect(projections.stateOf(sessionModule.Session.create(sessionModule.SessionId('guard-regression')), 'bridgeKernel')?.binding).toBeNull()
  })

  it.each([401, 403] as const)('preserves connection rejection %s on every declared bridge route before native detection', async (status) => {
    rejection = status
    const base = await start()
    for (const [path, method] of [['backends', 'GET'], ['sessions', 'POST'], ['models?sessionId=not-admitted', 'GET'], ['models', 'POST']] as const) {
      const response = await fetch(`${base}/api/tauri/bridge/${path}`, { method })
      expect(response.status).toBe(status)
      expect(await response.json()).toEqual({ error: status === 401 ? 'unauthorized' : 'forbidden' })
    }
    expect(requestRejection).toHaveBeenCalledTimes(4)
    expect(detectBackend).not.toHaveBeenCalled()
    expect(createCodexSession).not.toHaveBeenCalled()
    expect(createClaudeSession).not.toHaveBeenCalled()
    expect(runtime.sessions.size).toBe(0)
  })

  it('reports the official runtime version so the client can gate on it', async () => {
    runtimeBoot = { getDshRuntimeVersion: () => '0.2.1-alpha.2' }
    const base = await start()
    const response = await fetch(`${base}/api/tauri/bridge/backends`)
    expect(response.status).toBe(200)
    const payload = await response.json() as Array<Record<string, unknown>>
    expect(payload[0]).toEqual({ ...dsh, version: '0.2.1-alpha.2' })
  })

  it('retains CLI installation status while marking the bridge unavailable when official record support is absent', async () => {
    runtimeSession = legacySessionModule
    const base = await start()
    const response = await fetch(`${base}/api/tauri/bridge/backends`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([
      dsh,
      { ...codex, bridgeReady: false, hint: 'BRIDGE_CORE_UNAVAILABLE: 当前核心未提供完整的官方内核桥接接口，不能连接本机 CLI。' },
      { ...claude, bridgeReady: false },
    ])
    expect(requestRejection).toHaveBeenCalledOnce()
  })

  it('serves native model controls and durable null reset through the literal models route without mutating the global provider route', async () => {
    const base = await start()
    const { agent, connection } = await create(base)
    const cursor = Number(agent.session.seq)
    const originalBinding = identity.resolve(agent)
    const providers = llm.listProviders()
    const get = await fetch(`${base}/api/tauri/bridge/models?sessionId=${encodeURIComponent(agent.id)}`)
    expect(get.status).toBe(200)
    expect(await get.json()).toEqual({ backend: 'codex', defaultModel: 'native/default', models: [{ id: 'native/default', name: 'Native default', reasoning: { efforts: [{ id: 'normal', name: 'Normal' }, { id: 'deep', name: 'Deep' }], defaultEffort: 'normal' } }, { id: 'native/plain', name: 'Native plain' }], current: { model: null, reasoningEffort: null } })
    const post = await select(base, agent, 'native/default', 'deep')
    expect(post.status).toBe(200)
    expect(await post.json()).toEqual({ model: 'native/default', reasoningEffort: 'deep' })
    expect(modelEvents(agent.session)).toEqual([{ seq: cursor, time: now, type: 'plugin:dsh-tauri-bridge/model', ignorable: true, data: { model: 'native/default', reasoningEffort: 'deep' } }])
    expect(persistence.stored.get(agent.id)?.durable.find(event => event.seq === cursor)).toEqual({ seq: cursor, time: now, type: 'plugin:dsh-tauri-bridge/model', ignorable: true, data: { model: 'native/default', reasoningEffort: 'deep' } })
    const reset = await select(base, agent, null, null)
    expect(reset.status).toBe(200)
    expect(await reset.json()).toEqual({ model: null, reasoningEffort: null })
    expect(modelEvents(agent.session)).toEqual([
      { seq: cursor, time: now, type: 'plugin:dsh-tauri-bridge/model', ignorable: true, data: { model: 'native/default', reasoningEffort: 'deep' } },
      { seq: cursor + 1, time: now, type: 'plugin:dsh-tauri-bridge/model', ignorable: true, data: { model: null, reasoningEffort: null } },
    ])
    expect(checkpointed).toEqual([agent.id, agent.id])
    expect(identity.resolve(agent)).toEqual(originalBinding)
    expect(agent.session.requestHeader()).toBeUndefined()
    expect(agent.options).toMatchObject({ provider: 'dsh-tauri-bridge', model: 'codex' })
    expect(context.agentDefaultModel.currentSelection()).toEqual({ provider: 'global-provider', model: 'global-model', reasoningEffort: 'global-effort' })
    expect(llm.listProviders()).toEqual(providers)
    expect(connection.submit).not.toHaveBeenCalled()
    expect(connection.models).toHaveBeenCalledTimes(3)
    expect(createCodexSession).toHaveBeenCalledOnce()
    expect(createClaudeSession).not.toHaveBeenCalled()
  }, 10_000)

  it('does not return POST success until the official model record crosses the real persistence barrier', async () => {
    const base = await start()
    const { agent, connection } = await create(base)
    const entered = deferred<void>()
    const drain = deferred<void>()
    releases.push(() => drain.resolve())
    persistence.barrier = async () => {
      entered.resolve()
      await drain.promise
    }
    let settled = false
    const request = select(base, agent, 'native/default', 'deep').then((response) => {
      settled = true
      return response
    })
    background.push(request)
    await entered.promise
    expect(settled).toBe(false)
    expect(modelEvents(agent.session)).toHaveLength(1)
    expect(persistence.stored.get(agent.id)?.durable.some(event => (event.type as string) === 'plugin:dsh-tauri-bridge/model')).toBe(false)
    expect(connection.submit).not.toHaveBeenCalled()
    drain.resolve()
    const response = await request
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ model: 'native/default', reasoningEffort: 'deep' })
    expect(persistence.stored.get(agent.id)?.durable.filter(event => (event.type as string) === 'plugin:dsh-tauri-bridge/model')).toEqual(modelEvents(agent.session))
  }, 10_000)

  it('supports HEAD and rejects undeclared models verbs with the actual Allow set without touching native discovery', async () => {
    const base = await start()
    const { agent, connection } = await create(base)
    const head = await fetch(`${base}/api/tauri/bridge/models?sessionId=${encodeURIComponent(agent.id)}`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    expect(connection.models).toHaveBeenCalledOnce()
    for (const method of ['OPTIONS', 'PUT', 'PATCH', 'DELETE']) {
      const response = await fetch(`${base}/api/tauri/bridge/models?sessionId=${encodeURIComponent(agent.id)}`, { method })
      expect(response.status).toBe(405)
      expect(response.headers.get('allow')?.split(', ').sort()).toEqual(['GET', 'HEAD', 'POST'])
    }
    expect(connection.models).toHaveBeenCalledOnce()
    expect(connection.submit).not.toHaveBeenCalled()
    expect(modelEvents(agent.session)).toEqual([])
    expect(checkpointed).toEqual([])
  }, 10_000)

  it('rejects cross-origin model writes before body parsing, native catalog discovery, or record publication', async () => {
    const base = await start()
    const { agent, connection } = await create(base)
    for (const origin of ['http://untrusted.invalid', 'null', 'not-an-origin']) {
      const response = await fetch(`${base}/api/tauri/bridge/models`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: agent.id, model: 'native/default', reasoningEffort: 'deep' }) })
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'cross-origin-request' })
    }
    expect(connection.models).not.toHaveBeenCalled()
    expect(connection.submit).not.toHaveBeenCalled()
    expect(modelEvents(agent.session)).toEqual([])
    expect(checkpointed).toEqual([])
    expect(createCodexSession).toHaveBeenCalledOnce()
  }, 10_000)

  it.each(['', '?sessionId=', '?sessionId=%20', '?sessionId=one&sessionId=two'])('rejects malformed models query %s before native I/O', async (query) => {
    const base = await start()
    const response = await fetch(`${base}/api/tauri/bridge/models${query}`)
    expect(response.status).toBe(400)
    expect(detectBackend).not.toHaveBeenCalled()
    expect(createCodexSession).not.toHaveBeenCalled()
    expect(createClaudeSession).not.toHaveBeenCalled()
    expect(runtime.sessions.size).toBe(0)
  }, 10_000)

  it.each([
    null,
    {},
    { sessionId: '', model: null, reasoningEffort: null },
    { sessionId: 'foreign-http-session', model: '', reasoningEffort: null },
    { sessionId: 'foreign-http-session', model: null },
    { sessionId: 'foreign-http-session', model: null, reasoningEffort: 3 },
    { sessionId: 'foreign-http-session', model: ['native/default'], reasoningEffort: null },
  ])('rejects malformed models body %j before resolving any native session', async (body) => {
    const base = await start()
    const response = await fetch(`${base}/api/tauri/bridge/models`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(response.status).toBe(400)
    expect(detectBackend).not.toHaveBeenCalled()
    expect(createCodexSession).not.toHaveBeenCalled()
    expect(createClaudeSession).not.toHaveBeenCalled()
    expect(runtime.sessions.size).toBe(0)
  }, 10_000)

  it('refuses unknown and nonnative session model actions without using another live native owner', async () => {
    const base = await start()
    const { agent, connection } = await create(base)
    const ordinary = await agents.create({ sessionId: sessionModule.SessionId('ordinary-http-session'), meta: { cwd }, agentOptions: { provider: 'global-provider', model: 'global-model' } })
    for (const id of ['foreign-http-session', ordinary.agent.id]) {
      const get = await fetch(`${base}/api/tauri/bridge/models?sessionId=${encodeURIComponent(id)}`)
      expect(get.status).toBe(500)
      const post = await fetch(`${base}/api/tauri/bridge/models`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: id, model: null, reasoningEffort: null }) })
      expect(post.status).toBe(500)
    }
    expect(connection.models).not.toHaveBeenCalled()
    expect(connection.submit).not.toHaveBeenCalled()
    expect(modelEvents(agent.session)).toEqual([])
    expect(modelEvents(ordinary.agent.session)).toEqual([])
    expect(checkpointed).toEqual([])
    expect(createCodexSession).toHaveBeenCalledOnce()
  }, 10_000)

  it('rejects unavailable models and unadvertised effort without appending or submitting', async () => {
    const base = await start()
    const { agent, connection } = await create(base)
    for (const [chosen, effort] of [['missing-native-model', null], ['native/plain', 'deep'], ['native/default', 'xhigh']] as const) {
      const response = await select(base, agent, chosen, effort)
      expect(response.status).toBe(500)
    }
    expect(connection.models).toHaveBeenCalledTimes(3)
    expect(connection.submit).not.toHaveBeenCalled()
    expect(modelEvents(agent.session)).toEqual([])
    expect(checkpointed).toEqual([])
    expect(agent.session.requestHeader()).toBeUndefined()
    expect(agent.options).toMatchObject({ provider: 'dsh-tauri-bridge', model: 'codex' })
  }, 10_000)

  it('fails rather than pretending a native backend without models can accept model controls', async () => {
    const base = await start()
    const connection = native('http-unsupported-native')
    Reflect.deleteProperty(connection, 'models')
    const { agent } = await create(base, connection)
    const get = await fetch(`${base}/api/tauri/bridge/models?sessionId=${encodeURIComponent(agent.id)}`)
    expect(get.status).toBe(500)
    const post = await select(base, agent, null, null)
    expect(post.status).toBe(500)
    expect(connection.submit).not.toHaveBeenCalled()
    expect(modelEvents(agent.session)).toEqual([])
    expect(checkpointed).toEqual([])
    expect(createCodexSession).toHaveBeenCalledOnce()
  }, 10_000)

  it('does not report a successful model POST without an official flush listener', async () => {
    const base = await start()
    const { agent, connection } = await create(base)
    stopCheckpoint()
    const cursor = Number(agent.session.seq)
    const response = await select(base, agent, 'native/default', 'deep')
    expect(response.status).toBe(500)
    expect(modelEvents(agent.session)).toEqual([{ seq: cursor, time: now, type: 'plugin:dsh-tauri-bridge/model', ignorable: true, data: { model: 'native/default', reasoningEffort: 'deep' } }])
    expect(persistence.stored.get(agent.id)?.durable.some(event => (event.type as string) === 'plugin:dsh-tauri-bridge/model')).toBe(false)
    expect(checkpointed).toEqual([])
    expect(connection.submit).not.toHaveBeenCalled()
  }, 10_000)

  it('keeps a failed flush POST unsuccessful and checkpoints retry without duplicating the official choice', async () => {
    const base = await start()
    const { agent, connection } = await create(base)
    const failure = new Error('HTTP official model flush refused')
    persistence.barrier = async () => {
      throw failure
    }
    const response = await select(base, agent, 'native/default', 'deep')
    expect(response.status).toBe(500)
    expect(modelEvents(agent.session)).toHaveLength(1)
    expect(persistence.stored.get(agent.id)?.durable.some(event => (event.type as string) === 'plugin:dsh-tauri-bridge/model')).toBe(false)
    expect(connection.submit).not.toHaveBeenCalled()
    persistence.barrier = async () => {}
    const retry = await select(base, agent, 'native/default', 'deep')
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual({ model: 'native/default', reasoningEffort: 'deep' })
    expect(modelEvents(agent.session)).toHaveLength(1)
    expect(persistence.stored.get(agent.id)?.durable.filter(event => (event.type as string) === 'plugin:dsh-tauri-bridge/model')).toEqual(modelEvents(agent.session))
    expect(connection.submit).not.toHaveBeenCalled()
    expect(createCodexSession).toHaveBeenCalledOnce()
  }, 10_000)
})
