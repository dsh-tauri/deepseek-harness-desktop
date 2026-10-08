import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ConnectionHost } from '../types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearHostRuntime, getCurrentHostInstance, setCurrentHostInstance } from '../config/runtime'
import { gate } from './gate'

const request = {} as IncomingMessage
const response = {} as ServerResponse

/** 最小 connection 面：两道闸门都记账，用于断言是否调用了原实现。 */
function makeHost(rejection: 401 | 403 | undefined) {
  const calls: string[] = []
  const connection: ConnectionHost['connection'] = {
    requestRejection: () => {
      calls.push('requestRejection')
      return rejection
    },
    authorizeIndex: () => {
      calls.push('authorizeIndex')
      return false
    },
  }
  setCurrentHostInstance({
    connection,
    web: { registerFetchProvider: () => () => {} },
    loader: { import: async () => undefined, unwrapExports: value => value },
  })
  return { connection, calls }
}

beforeEach(() => {
  delete process.env.DSH_TAURI_EMBEDDED
})

afterEach(() => {
  delete process.env.DSH_TAURI_EMBEDDED
  clearHostRuntime()
})

describe('gate.attach without the carrier marker', () => {
  it('leaves both gates untouched', () => {
    const { connection } = makeHost(401)
    const rejection = connection.requestRejection
    const authorize = connection.authorizeIndex

    gate.attach()()

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
    const detach = gate.attach()

    expect(connection.requestRejection(request)).toBeUndefined()
    detach()
  })

  it('keeps the 403 Host/Origin fence', () => {
    const { connection } = makeHost(403)
    const detach = gate.attach()

    expect(connection.requestRejection(request)).toBe(403)
    detach()
  })

  it('serves the index without consulting the original gate', () => {
    const { connection, calls } = makeHost(401)
    const detach = gate.attach()

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
    setCurrentHostInstance({ connection } as never)

    const detach = gate.attach()

    expect(connection.authorizeIndex()).toBe(true)
    expect(connection.calls).toBe(0)
    detach()
    expect(Service.prototype.authorizeIndex).toBe(original)
  })

  /** 0.1.7 起 `requestRejection` 移到 peer 上，`connection` 只剩 `authorizeIndex`。 */
  it('still bypasses the index gate when the core dropped requestRejection', () => {
    const warn = vi.fn()
    const authorizeIndex = () => false
    setCurrentHostInstance({ connection: { authorizeIndex }, logger: { warn } } as never)

    const detach = gate.attach()

    expect(warn).not.toHaveBeenCalled()
    const { connection } = getCurrentHostInstance() as ConnectionHost
    expect(connection.authorizeIndex(request, response)).toBe(true)
    detach()
    expect(connection.authorizeIndex).toBe(authorizeIndex)
  })

  it('restores both gates on detach', () => {
    const { connection } = makeHost(401)
    const rejection = connection.requestRejection
    const authorize = connection.authorizeIndex

    gate.attach()()

    expect(connection.requestRejection).toBe(rejection)
    expect(connection.authorizeIndex).toBe(authorize)
  })

  it('stays inert and warns when the core lacks the gates', () => {
    const warn = vi.fn()
    setCurrentHostInstance({
      connection: {} as never,
      logger: { warn },
      web: { registerFetchProvider: () => () => {} },
      loader: { import: async () => undefined, unwrapExports: value => value },
    })

    gate.attach()()

    expect(warn).toHaveBeenCalledOnce()
  })
})
