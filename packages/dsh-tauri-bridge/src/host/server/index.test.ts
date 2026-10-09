import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { BackendDetection } from '../../shared/types'
import type { HostContext, PlatformLoader } from '../types'
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import * as llmModule from '@deepseek-ai/dsh-llm'
import * as legacySessionModule from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as bridge from '../../index'
import { resetRuntime, runtime } from '../config/runtime'
import { detectBackend } from '../utils/detection'

vi.mock('../utils/detection', () => ({ detectBackend: vi.fn() }))

const packageId: string = 'dsh-session-current'
const sessionModule = await import(packageId) as typeof legacySessionModule
const codex: BackendDetection = { id: 'codex', installed: true, auth: 'ok', version: '0.147.0', drift: false, hint: null }
const claude: BackendDetection = { id: 'claude', installed: false, auth: 'unknown', version: null, drift: false, hint: 'BRIDGE_EXECUTABLE_MISSING: Claude CLI is not installed' }
const dsh: BackendDetection = { id: 'dsh', installed: true, auth: 'ok', version: null, drift: false, hint: null }

let context: Context
let projections: SessionProjectionRegistry
let http: Server | undefined
let rejection: 401 | 403 | undefined
let runtimeSession: typeof legacySessionModule
let registered: Map<string, WebRoute>
let requestRejection: ReturnType<typeof vi.fn<(request: IncomingMessage) => 401 | 403 | undefined>>

beforeEach(async () => {
  await resetRuntime()
  runtimeSession = sessionModule
  rejection = undefined
  registered = new Map()
  vi.mocked(detectBackend).mockReset()
  vi.mocked(detectBackend).mockImplementation(async id => ({ detection: { ...(id === 'codex' ? codex : claude) } }))
  context = new Context()
  projections = new SessionProjectionRegistry(context)
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
      throw new Error(`Unexpected public runtime import: ${id}`)
    },
    unwrapExports: value => value,
  }
  context.provide('loader', loader as HostContext['loader'])
  context.provide('llm', { registerAdapter: () => () => {} } as unknown as HostContext['llm'])
  context.provide('sessions', { get: () => undefined } as unknown as HostContext['sessions'])
  for (const name of ['agents', 'workspaceRegistry', 'agentPresets', 'approval', 'userQuestions'])
    context.provide(name, {})
})

afterEach(async () => {
  if (http) {
    await new Promise<void>((resolve, reject) => {
      http!.close(error => error ? reject(error) : resolve())
      http!.closeAllConnections()
    })
    http = undefined
  }
  await context.fiber.dispose()
  await resetRuntime()
  vi.restoreAllMocks()
})

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

describe('exported bridge plugin HTTP dependency boundary', () => {
  it('returns the kernel catalog through real Cordis inject enforcement and the shared request guard', async () => {
    const base = await start()
    const response = await fetch(`${base}/api/tauri/bridge/backends`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([dsh, codex, claude])
    expect(requestRejection).toHaveBeenCalledOnce()
    expect(requestRejection.mock.calls[0]![0].method).toBe('GET')
    expect(vi.mocked(detectBackend).mock.calls.map(([id]) => id).sort()).toEqual(['claude', 'codex'])
    expect(projections.stateOf(sessionModule.Session.create(sessionModule.SessionId('guard-regression')), 'bridgeKernel')).toBeNull()
  })

  it.each([401, 403] as const)('preserves connection rejection %s on catalog and session routes before native detection', async (status) => {
    rejection = status
    const base = await start()
    for (const [path, method] of [['backends', 'GET'], ['sessions', 'POST']] as const) {
      const response = await fetch(`${base}/api/tauri/bridge/${path}`, { method })
      expect(response.status).toBe(status)
      expect(await response.json()).toEqual({ error: status === 401 ? 'unauthorized' : 'forbidden' })
    }
    expect(requestRejection).toHaveBeenCalledTimes(2)
    expect(detectBackend).not.toHaveBeenCalled()
    expect(runtime.sessions.size).toBe(0)
  })

  it('returns an unavailable hint rather than HTTP 500 when the official record capability is absent', async () => {
    runtimeSession = legacySessionModule
    const base = await start()
    const response = await fetch(`${base}/api/tauri/bridge/backends`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([
      dsh,
      { ...codex, installed: false, hint: 'BRIDGE_CORE_UNAVAILABLE: 当前核心未提供完整的官方内核桥接接口，不能连接本机 CLI。' },
      { ...claude, hint: 'BRIDGE_CORE_UNAVAILABLE: 当前核心未提供完整的官方内核桥接接口，不能连接本机 CLI。' },
    ])
    expect(requestRejection).toHaveBeenCalledOnce()
  })
})
