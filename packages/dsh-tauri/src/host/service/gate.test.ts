import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ConnectionHost } from '../types'
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gate } from './gate'

const cleanups: Array<() => void | Promise<void>> = []
const request = {} as IncomingMessage
const response = {} as ServerResponse
let host: ConnectionHost

/** 最小 connection 面：两道闸门都记账，用于断言是否调用了原实现。 */
function makeHost(rejection: 401 | 403 | undefined) {
  const calls: string[] = []
  const connection = {
    requestRejection: (_request: IncomingMessage) => {
      calls.push('requestRejection')
      return rejection
    },
    authorizeIndex: (_request: IncomingMessage, _response: ServerResponse) => {
      calls.push('authorizeIndex')
      return false
    },
  }
  host = { connection }
  return { connection, calls }
}

beforeEach(() => {
  vi.stubEnv('DSH_TAURI_EMBEDDED', undefined)
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
  vi.restoreAllMocks()
  vi.stubEnv('DSH_TAURI_EMBEDDED', undefined)
  vi.unstubAllEnvs()
})

function modernService() {
  const lifetime = new AbortController()
  const browserPeer = { id: 'browser', signal: lifetime.signal }
  const apiPeer = { id: 'api', signal: new AbortController().signal }
  class Connection extends Service {
    browserPeer = browserPeer
    calls = 0
    disposed = false
    admit(req: IncomingMessage) {
      this.calls += 1
      if (req.headers?.origin === 'evil')
        return { rejection: 403 as const }
      return req.headers?.cookie === 'api' ? { peer: apiPeer } : { rejection: 401 as const }
    }

    requestRejection(req: IncomingMessage) {
      const admission = this.admit(req)
      return 'rejection' in admission ? admission.rejection : undefined
    }

    admitConnection(req: IncomingMessage) {
      const admission = this.admit(req)
      return 'rejection' in admission ? admission : { ...admission, release: async () => {} }
    }
  }
  const context = new Context()
  const connection = new Connection(context, 'connection')
  cleanups.push(() => context.fiber.dispose())
  return { context, connection, browserPeer, apiPeer, lifetime, Connection }
}

function attach(connection: unknown) {
  const detach = gate.attach({ connection } as ConnectionHost)
  cleanups.push(detach)
  return detach
}

describe('gate.attach modern admission', () => {
  beforeEach(() => vi.stubEnv('DSH_TAURI_EMBEDDED', '1'))

  it('admits the existing browser peer for HTTP and connection upgrade', async () => {
    const { connection, browserPeer } = modernService()
    attach(connection)
    expect(connection.admit(request)).toEqual({ peer: browserPeer })
    const upgrade = connection.admitConnection(request)
    expect(upgrade).toMatchObject({ peer: browserPeer, release: expect.any(Function) })
    if ('release' in upgrade)
      await upgrade.release()
    expect(browserPeer.signal.aborted).toBe(false)
    expect(connection.requestRejection(request)).toBeUndefined()
  })

  it('preserves API identity and Host/Origin rejection', () => {
    const { connection, apiPeer } = modernService()
    attach(connection)
    expect(connection.admit({ headers: { cookie: 'api' } } as IncomingMessage)).toEqual({ peer: apiPeer })
    expect(connection.admit({ headers: { origin: 'evil' } } as IncomingMessage)).toEqual({ rejection: 403 })
    expect(connection.calls).toBe(2)
  })

  it('preserves service disposal rejection before the browser peer signal aborts', () => {
    const { connection, browserPeer } = modernService()
    attach(connection)
    connection.disposed = true
    expect(browserPeer.signal.aborted).toBe(false)
    expect(connection.admit(request)).toEqual({ rejection: 401 })
    expect(connection.requestRejection(request)).toBe(401)
  })

  it('does not revive a disposed browser peer through admission or requestRejection', () => {
    const { connection, lifetime } = modernService()
    attach(connection)
    lifetime.abort()
    expect(connection.admit(request)).toEqual({ rejection: 401 })
    expect(connection.admitConnection(request)).toEqual({ rejection: 401 })
    expect(connection.requestRejection(request)).toBe(401)
  })

  it('uses each Cordis access receiver and restores inherited property shape', () => {
    const { connection, context, Connection } = modernService()
    const instanceBefore = Object.getOwnPropertyDescriptors(connection)
    const prototypeBefore = Object.getOwnPropertyDescriptors(Connection.prototype)
    const detach = attach(context.connection)
    expect(context.connection.admit(request)).toEqual({ peer: connection.browserPeer })
    expect(context.extend().connection.admit(request)).toEqual({ peer: connection.browserPeer })
    expect(connection.calls).toBe(2)
    detach()
    cleanups.pop()
    const instanceAfter = Object.getOwnPropertyDescriptors(connection)
    instanceAfter.calls = instanceBefore.calls!
    expect(instanceAfter).toEqual(instanceBefore)
    expect(Object.getOwnPropertyDescriptors(Connection.prototype)).toEqual(prototypeBefore)
    expect(connection.admit(request)).toEqual({ rejection: 401 })
  })
})

describe('gate.attach without the carrier marker', () => {
  it.each([undefined, '0', 'true'])('does not change modern admission for marker %s', (marker) => {
    vi.stubEnv('DSH_TAURI_EMBEDDED', marker)
    const { connection } = modernService()
    const original = connection.admit
    attach(connection)
    expect(connection.admit).toBe(original)
    expect(connection.admit(request)).toEqual({ rejection: 401 })
  })

  it('leaves both gates untouched', () => {
    const { connection } = makeHost(401)
    const rejection = connection.requestRejection
    const authorize = connection.authorizeIndex

    gate.attach(host)()

    expect(connection.requestRejection).toBe(rejection)
    expect(connection.authorizeIndex).toBe(authorize)
  })
})

describe('gate.attach with the carrier marker', () => {
  beforeEach(() => {
    process.env.DSH_TAURI_EMBEDDED = '1'
  })

  it('downgrades the browser-session 401 to allowed', () => {
    const { connection } = makeHost(401)
    const detach = gate.attach(host)

    expect(connection.requestRejection(request)).toBeUndefined()
    detach()
  })

  it('keeps the 403 Host/Origin fence', () => {
    const { connection } = makeHost(403)
    const detach = gate.attach(host)

    expect(connection.requestRejection(request)).toBe(403)
    detach()
  })

  it('serves the index without consulting the original gate', () => {
    const { connection, calls } = makeHost(401)
    const detach = gate.attach(host)

    expect(connection.authorizeIndex(request, response)).toBe(true)
    expect(calls).not.toContain('authorizeIndex')
    detach()
  })

  /** 类实例（方法在原型上）：只覆写实例属性时 `ctx.connection` 换一个取用对象就失效。 */
  it('patches a class prototype so every access path sees the bypass', () => {
    class Service {
      calls = 0
      authorizeIndex(): boolean {
        this.calls += 1
        return false
      }
    }
    const connection = new Service()
    const original = Service.prototype.authorizeIndex
    host = { connection } as never

    const detach = gate.attach(host)

    expect(connection.authorizeIndex()).toBe(true)
    expect(connection.calls).toBe(0)
    detach()
    expect(Service.prototype.authorizeIndex).toBe(original)
  })

  /** 0.1.7 起 `requestRejection` 移到 peer 上，`connection` 只剩 `authorizeIndex`。 */
  it('still bypasses the index gate when the core dropped requestRejection', () => {
    const warn = vi.fn()
    const authorizeIndex = () => false
    host = { connection: { authorizeIndex }, logger: { warn } } as never

    const detach = gate.attach(host)

    expect(warn).not.toHaveBeenCalled()
    expect(host.connection.authorizeIndex!(request, response)).toBe(true)
    detach()
    expect(host.connection.authorizeIndex).toBe(authorizeIndex)
  })

  it('restores both gates on detach', () => {
    const { connection } = makeHost(401)
    Object.defineProperty(connection, 'requestRejection', { enumerable: false })
    const descriptors = Object.getOwnPropertyDescriptors(connection)
    const rejection = connection.requestRejection
    const authorize = connection.authorizeIndex

    gate.attach(host)()

    expect(connection.requestRejection).toBe(rejection)
    expect(connection.authorizeIndex).toBe(authorize)
    expect(Object.getOwnPropertyDescriptors(connection)).toEqual(descriptors)
  })

  it('stays inert and warns when the core lacks the gates', () => {
    const warn = vi.fn()
    host = { connection: {} as never, logger: { warn } }

    gate.attach(host)()

    expect(warn).toHaveBeenCalledOnce()
  })
})
