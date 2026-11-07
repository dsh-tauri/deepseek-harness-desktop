import type { IncomingMessage, Server } from 'node:http'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { H3 } from 'h3'
import { toNodeHandler } from 'h3/node'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { guard } from './request'

let listener: Server | undefined
let origin = ''

beforeEach(async () => {
  const connection = {
    requestRejection(request: IncomingMessage): 401 | 403 | undefined {
      if (request.headers.origin === 'https://untrusted.example' && request.method === 'GET')
        return 403
      return request.headers.cookie === 'dsh-auth-test=session' ? undefined : 401
    },
  }
  const context = { connection }
  const app = new H3()
  app.use((event) => {
    Object.assign(event.context, { __host_instance: { context } })
  })
  app.use(guard)
  app.get('/api/known', () => 'authorized route')
  app.post('/api/mutation', () => 'mutation route')
  listener = createServer(toNodeHandler(app))
  const listening = once(listener, 'listening')
  listener.listen(0, '127.0.0.1')
  await listening
  const address = listener.address()
  if (!address || typeof address === 'string')
    throw new Error('test listener did not bind a TCP port')
  origin = `http://127.0.0.1:${String(address.port)}`
})

afterEach(async () => {
  vi.unstubAllEnvs()
  if (listener !== undefined) {
    const current = listener
    listener = undefined
    await new Promise<void>((resolve, reject) => {
      current.close(error => error ? reject(error) : resolve())
    })
  }
})

describe('desktop carrier request authorization', () => {
  it.each(['0', '1'])('preserves kernel 401 rejection with embedded=%s', async (embedded) => {
    vi.stubEnv('DSH_TAURI_EMBEDDED', embedded)
    const response = await fetch(`${origin}/api/known`)
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized' })
  })

  it('preserves a kernel cross-origin 403 rejection', async () => {
    const response = await fetch(`${origin}/api/known`, { headers: { origin: 'https://untrusted.example' } })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'forbidden' })
  })

  it('serves a request authorized by the kernel session', async () => {
    const response = await fetch(`${origin}/api/known`, { headers: { cookie: 'dsh-auth-test=session' } })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('authorized route')
  })

  it('allows an authenticated same-origin POST', async () => {
    const response = await fetch(`${origin}/api/mutation`, { method: 'POST', headers: { origin, cookie: 'dsh-auth-test=session' } })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('mutation route')
  })

  it('rejects an authenticated cross-origin POST', async () => {
    const response = await fetch(`${origin}/api/mutation`, { method: 'POST', headers: { origin: 'https://untrusted.example', cookie: 'dsh-auth-test=session' } })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'cross-origin-request' })
  })

  it('returns 404 for an authenticated unmounted route', async () => {
    const response = await fetch(`${origin}/api/missing`, { headers: { cookie: 'dsh-auth-test=session' } })
    expect(response.status).toBe(404)
  })
})
