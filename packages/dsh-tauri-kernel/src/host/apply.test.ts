import type { Agent } from '@deepseek-ai/dsh-agent'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { HostContext, NativeEntry, PlatformLoader } from './types'
import { Context } from '@deepseek-ai/cordis'
import * as llmModule from '@deepseek-ai/dsh-llm'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { getServerContext } from 'dsh-h3/utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from './apply'
import { resetRuntime, runtime } from './config/runtime'
import { server } from './server'

const packageId: string = 'dsh-session-current'
const sessionModule = await import(packageId) as typeof import('@deepseek-ai/dsh-session')

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

let context: Context
let projections: SessionProjectionRegistry
let registered: Map<string, WebRoute>
let imports: ReturnType<typeof deferred<void>>
let importStarted: ReturnType<typeof deferred<void>>
let releases: Array<() => void>
let registerAdapter: ReturnType<typeof vi.fn>
let unregisterAdapter: ReturnType<typeof vi.fn>

beforeEach(async () => {
  await resetRuntime()
  context = new Context()
  projections = new SessionProjectionRegistry(context)
  registered = new Map()
  releases = []
  imports = deferred<void>()
  importStarted = deferred<void>()
  releases.push(() => imports.resolve())
  unregisterAdapter = vi.fn()
  registerAdapter = vi.fn(() => unregisterAdapter)
  context.provide('webServer', {
    register(route: WebRoute) {
      if (registered.has(route.path))
        throw new Error(`duplicate route: ${route.path}`)
      registered.set(route.path, route)
      return () => registered.delete(route.path)
    },
  } as unknown as HostContext['webServer'])
  const loader: PlatformLoader = {
    async import(id) {
      importStarted.resolve()
      await imports.promise
      if (id === '@deepseek-ai/dsh-llm')
        return llmModule
      if (id === '@deepseek-ai/dsh-session')
        return sessionModule
      throw new Error(`unexpected module: ${id}`)
    },
    unwrapExports: value => value,
  }
  context.provide('loader', loader as HostContext['loader'])
  context.provide('llm', { registerAdapter } as unknown as HostContext['llm'])
})

afterEach(async () => {
  for (const release of releases)
    release()
  await context.fiber.dispose()
  await resetRuntime()
  vi.restoreAllMocks()
})

function start() {
  return context.plugin((ctx) => {
    apply(ctx as HostContext)
  })
}

async function ready() {
  const fiber = start()
  await importStarted.promise
  imports.resolve()
  await vi.waitFor(() => expect(registerAdapter).toHaveBeenCalledOnce())
  return { fiber }
}

describe('owned bridge application lifecycle', () => {
  it('activates the real H3 service before awaited adapter registration', async () => {
    const fiber = start()
    await importStarted.promise
    expect(getServerContext(server)).toBe(fiber.ctx)
    expect([...registered.keys()].sort()).toEqual(['/api/tauri/bridge/backends', '/api/tauri/bridge/models', '/api/tauri/bridge/sessions'])
    expect(projections.stateOf(sessionModule.Session.create(sessionModule.SessionId('startup')), 'bridgeKernel')?.binding).toBeNull()
    expect(registerAdapter).not.toHaveBeenCalled()
    expect(runtime.ready).toBe(false)
    imports.resolve()
    await vi.waitFor(() => expect(registerAdapter).toHaveBeenCalledOnce())
    expect(registerAdapter.mock.calls[0]![0]).toEqual(['dsh-tauri-kernel'])
    expect(registerAdapter.mock.calls[0]![1]).toBeInstanceOf(llmModule.LlmAdapter)
    expect(runtime.ready).toBe(true)
    await fiber.dispose()
    expect(unregisterAdapter).toHaveBeenCalledOnce()
    expect(runtime.ready).toBe(false)
    expect(registered.size).toBe(0)
    expect(() => getServerContext(server)).toThrow('dsh-h3: service is not active')
  }, 10_000)

  it('keeps the H3 service owned until official idle and native disposal drain', async () => {
    const { fiber } = await ready()
    const idle = deferred<void>()
    const idleStarted = deferred<void>()
    const nativeDrain = deferred<void>()
    const nativeStarted = deferred<void>()
    releases.push(() => idle.resolve(), () => nativeDrain.resolve())
    const official = sessionModule.Session.create(sessionModule.SessionId('draining'))
    const agent = {
      id: official.id,
      session: official,
      cancel: vi.fn(),
      whenIdle: vi.fn(() => {
        idleStarted.resolve()
        return idle.promise
      }),
    } as unknown as Agent
    const nativeDispose = vi.fn(async () => {
      expect(getServerContext(server)).toBe(fiber.ctx)
      nativeStarted.resolve()
      await nativeDrain.promise
      expect(getServerContext(server)).toBe(fiber.ctx)
    })
    const entry: NativeEntry = {
      agent,
      binding: { backend: 'codex', nativeSessionId: 'native-draining', sessionId: official.id },
      session: { id: 'native-draining', submit: vi.fn(), dispose: nativeDispose },
      controller: new AbortController(),
    }
    runtime.sessions.set(agent.id, entry)
    let disposed = false
    const unloading = fiber.dispose().then(() => {
      disposed = true
    })
    await idleStarted.promise
    expect(agent.cancel).toHaveBeenCalledExactlyOnceWith({ kind: 'disposed' })
    expect(disposed).toBe(false)
    expect(getServerContext(server)).toBe(fiber.ctx)
    expect(registered.size).toBe(3)
    expect(nativeDispose).not.toHaveBeenCalled()
    idle.resolve()
    await nativeStarted.promise
    expect(disposed).toBe(false)
    expect(getServerContext(server)).toBe(fiber.ctx)
    expect(unregisterAdapter).not.toHaveBeenCalled()
    nativeDrain.resolve()
    await unloading
    expect(nativeDispose).toHaveBeenCalledOnce()
    expect(agent.whenIdle).toHaveBeenCalledOnce()
    expect(unregisterAdapter).toHaveBeenCalledOnce()
    expect(runtime.sessions.size).toBe(0)
    expect(registered.size).toBe(0)
    expect(projections.stateOf(official, 'bridgeKernel')).toBeUndefined()
    expect(() => getServerContext(server)).toThrow('dsh-h3: service is not active')
  }, 10_000)

  it('unloads an in-flight module import without leaking routes or the late adapter', async () => {
    const fiber = start()
    await importStarted.promise
    let disposed = false
    const unloading = fiber.dispose().then(() => {
      disposed = true
    })
    expect(getServerContext(server)).toBe(fiber.ctx)
    expect(disposed).toBe(false)
    imports.resolve()
    await unloading
    expect(registerAdapter).toHaveBeenCalledOnce()
    expect(unregisterAdapter).toHaveBeenCalledOnce()
    expect(runtime.ready).toBe(false)
    expect(runtime.lifetime.signal.aborted).toBe(true)
    expect(registered.size).toBe(0)
    expect(() => getServerContext(server)).toThrow('dsh-h3: service is not active')
  }, 10_000)
})
