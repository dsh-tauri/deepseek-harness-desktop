import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'
import { defineWebServer } from 'dsh-h3'
import { getServerOptions } from 'dsh-h3/utils'
import { defineEventHandler, H3Event, readBody } from 'h3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getServerContext } from '../utils/server'
import { desktopRequestGuard } from './request'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
  vi.restoreAllMocks()
})

async function activate(rejection?: 401 | 403) {
  const registered = new Map<string, WebRoute>()
  const context = {
    webServer: {
      register(route: WebRoute) {
        if (registered.has(route.path))
          throw new Error('duplicate route')
        registered.set(route.path, route)
        return () => registered.delete(route.path)
      },
    },
    connection: { requestRejection: () => rejection },
    logger: { error: vi.fn() },
  } as unknown as Context
  const service = defineWebServer<{ label: string }>((app) => {
    app.use(desktopRequestGuard)
    app.get('/api/demo', defineEventHandler(event => ({ label: getServerOptions<{ label: string }>(event).label })))
    app.post('/api/demo', defineEventHandler(async event => ({ body: await readBody(event) })))
    app.get('/api/error', defineEventHandler(() => {
      throw new Error('boom')
    }))
  })
  cleanups.push(service(context, { label: 'first' }))
  const server: Server = createServer((request, response) => {
    const route = registered.get(new URL(request.url ?? '/', 'http://localhost').pathname)
    if (!route) {
      response.writeHead(404).end()
      return
    }
    void Promise.resolve(route.handler(request, response)).catch(() => response.destroy())
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  }))
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, service, context }
}

describe('desktop H3 request boundary', () => {
  it('preserves route methods, OPTIONS, large bodies and native service lifecycle', async () => {
    const { base, service, context } = await activate()
    const typedContext = getServerContext<Context>(service)
    expect(typedContext).toBe(context)
    expect(await (await fetch(`${base}/api/demo`)).json()).toEqual({ label: 'first' })
    const preflight = await fetch(`${base}/api/demo`, { method: 'OPTIONS' })
    expect(preflight.status).toBe(405)
    expect(preflight.headers.get('allow')?.split(', ').sort()).toEqual(['GET', 'HEAD', 'POST'])
    const invalid = await fetch(`${base}/api/demo`, { method: 'DELETE' })
    expect(invalid.status).toBe(405)
    expect(new Set(invalid.headers.get('allow')?.split(', '))).toEqual(new Set(['GET', 'HEAD', 'POST']))
    const body = { text: 'x'.repeat(1024 * 1024 + 1) }
    const response = await fetch(`${base}/api/demo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ body })
    expect(response.headers.get('cache-control')).toBeNull()
  })

  it.each([401, 403] as const)('retains connection rejection %s for declared requests', async (status) => {
    const { base } = await activate(status)
    for (const method of ['GET', 'POST']) {
      const response = await fetch(`${base}/api/demo`, { method })
      expect(response.status).toBe(status)
      expect(await response.json()).toEqual({ error: status === 401 ? 'unauthorized' : 'forbidden' })
    }
  })

  it('rejects cross-origin writes and malformed origins, allows same-origin and headless writes', async () => {
    const { base } = await activate()
    for (const origin of ['http://evil.example', 'null', 'not-a-url']) {
      const response = await fetch(`${base}/api/demo`, { method: 'POST', headers: { origin } })
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'cross-origin-request' })
    }
    expect((await fetch(`${base}/api/demo`, { method: 'POST', headers: { origin: base } })).status).toBe(200)
    expect((await fetch(`${base}/api/demo`, { method: 'POST' })).status).toBe(200)
  })

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('rejects non-loopback %s without trusting proxy headers', async (method) => {
    const request = { socket: { remoteAddress: '10.0.0.5' }, headers: { 'x-forwarded-for': '127.0.0.1' } } as unknown as IncomingMessage
    const event = new H3Event(new Request('http://localhost/api/demo', { method }))
    Object.defineProperty(event, 'runtime', { value: { node: { req: request } } })
    event.context.__host_instance = { context: {}, options: undefined }
    const next = vi.fn()
    expect(await desktopRequestGuard(event, next)).toEqual({ error: '变更操作仅限本机（127.0.0.1）调用' })
    expect(event.res.status).toBe(403)
    expect(next).not.toHaveBeenCalled()
  })

  it('logs unexpected handler errors without replacing the 500 response', async () => {
    const { base, context } = await activate()
    expect((await fetch(`${base}/api/error`)).status).toBe(500)
    expect(context.logger.error).toHaveBeenCalledWith(expect.stringContaining('boom'))
  })
})
