import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'
import { afterEach, expect, it } from 'vitest'
import { server } from '.'
import { handleSessionEvent } from '../events/session-event'
import { clearTurnEndFacts } from '../service/turn-end'

const path = '/api/tauri/notification/turn-end'
const disposers: Array<() => void> = []

afterEach(() => {
  disposers.splice(0).forEach(dispose => dispose())
  clearTurnEndFacts()
})

it('serves turn-end facts and preserves HEAD, allowed methods and disposal', async () => {
  const registered = new Map<string, WebRoute>()
  const unmount = server({
    webServer: {
      register(route: WebRoute) {
        registered.set(route.path, route)
        return () => {
          registered.delete(route.path)
        }
      },
    },
  } as unknown as Context)
  disposers.push(unmount)
  expect([...registered.keys()]).toEqual([path])
  expect(registered.get(path)?.kind).toBe('exact')
  const route = registered.get(path)!
  const httpServer = createServer((request, response) => {
    void Promise.resolve(route.handler(request, response)).catch(() => {
      response.writeHead(500)
      response.end()
    })
  })
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}${path}`
  try {
    expect(await (await fetch(base)).json()).toEqual({})
    handleSessionEvent({ id: 'session' }, { type: 'turn/end', data: { turn: 3, reason: { kind: 'aborted' } } })
    expect(await (await fetch(`${base}?sessionId=session`)).json()).toEqual({ reason: 'aborted', turn: 3 })
    const head = await fetch(base, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    const options = await fetch(base, { method: 'OPTIONS' })
    expect(options.status).toBe(405)
    expect(options.headers.get('allow')?.split(', ').sort()).toEqual('GET, HEAD'.split(', ').sort())
    const invalid = await fetch(base, { method: 'POST' })
    expect(invalid.status).toBe(405)
    expect(invalid.headers.get('allow')?.split(', ').sort()).toEqual(['GET', 'HEAD'])
    unmount()
    expect(registered.size).toBe(0)
  }
  finally {
    await new Promise<void>(resolve => httpServer.close(() => resolve()))
  }
})
