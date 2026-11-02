import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { H3 } from 'h3'
import { toNodeHandler } from 'h3/node'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gate } from './gate'
import { guard } from './request'

let listener: Server | undefined
let origin = ''
let restoreEmbedded = () => {}
let disposeGate: (() => void) | undefined
let enableEmbedded = () => {}

beforeEach(async () => {
  const previousEmbedded = process.env.DSH_TAURI_EMBEDDED
  delete process.env.DSH_TAURI_EMBEDDED
  restoreEmbedded = () => {
    if (previousEmbedded === undefined)
      delete process.env.DSH_TAURI_EMBEDDED
    else
      process.env.DSH_TAURI_EMBEDDED = previousEmbedded
  }

  const connection = {
    browserPeer: { signal: new AbortController().signal },
    disposed: false,
    admit(request: IncomingMessage): { rejection: 401 | 403 } | { peer: { signal: AbortSignal } } {
      return { rejection: request.method === 'POST' ? 401 : request.headers.origin === 'https://untrusted.example' ? 403 : 401 }
    },
    authorizeIndex(request: IncomingMessage, response: ServerResponse): boolean {
      const token = new URL(request.url ?? '/', 'http://dsh.invalid').searchParams.get('token')
      if (token !== 'launch-token')
        return true
      response.writeHead(303, { 'location': './', 'set-cookie': 'dsh-auth-test=session; Path=/; HttpOnly; SameSite=Strict' })
      response.end()
      return false
    },
    requestRejection(request: IncomingMessage): 401 | 403 | undefined {
      const admission = this.admit(request)
      return 'rejection' in admission ? admission.rejection : undefined
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
  app.get('/', (event) => {
    const req = event.runtime?.node?.req as IncomingMessage
    const res = event.runtime?.node?.res as ServerResponse
    if (!connection.authorizeIndex(req, res))
      return
    return 'index route'
  })
  listener = createServer(toNodeHandler(app))
  const listening = once(listener, 'listening')
  listener.listen(0, '127.0.0.1')
  await listening
  const address = listener.address()
  if (!address || typeof address === 'string')
    throw new Error('test listener did not bind a TCP port')
  origin = `http://127.0.0.1:${String(address.port)}`

  disposeGate = undefined
  enableEmbedded = () => {
    if (process.env.DSH_TAURI_EMBEDDED === '1')
      return
    process.env.DSH_TAURI_EMBEDDED = '1'
    disposeGate = gate.attach(context)
  }
})

afterEach(async () => {
  disposeGate?.()
  disposeGate = undefined
  restoreEmbedded()
  enableEmbedded = () => {}
  if (listener !== undefined) {
    const current = listener
    listener = undefined
    await new Promise<void>((resolve, reject) => {
      current.close(error => error ? reject(error) : resolve())
    })
  }
})

describe('desktop carrier request authorization', () => {
  it('returns 401 for an ordinary request rejected by the connection service', async () => {
    const response = await fetch(`${origin}/api/known`)
    expect(response.status, '未认证请求必须保持 401').toBe(401)
    expect(await response.json(), '401 必须返回 unauthorized 错误体').toEqual({ error: 'unauthorized' })
  })

  it('allows an embedded carrier through only a 401 rejection', async () => {
    enableEmbedded()
    const response = await fetch(`${origin}/api/known`)
    expect(response.status, '嵌入载体的 401 必须被 gate 放行').toBe(200)
    expect(await response.text(), '放行后必须到达真实 H3 路由').toBe('authorized route')
  })

  it('keeps a cross-origin 403 when the embedded carrier is enabled, while the gate is enabled', async () => {
    enableEmbedded()
    const response = await fetch(`${origin}/api/known`, { headers: { origin: 'https://untrusted.example' } })
    expect(response.status, '跨源拒绝不得被嵌入载体绕过').toBe(403)
    expect(await response.json(), '403 必须返回 forbidden 错误体').toEqual({ error: 'forbidden' })
  })

  it('allows an embedded same-origin POST through the request guard', async () => {
    enableEmbedded()
    const response = await fetch(`${origin}/api/mutation`, { method: 'POST', headers: { origin } })
    expect(response.status, '同源 POST 必须通过 request guard').toBe(200)
    expect(await response.text(), '同源 POST 必须到达真实 H3 路由').toBe('mutation route')
  })

  it('rejects an embedded cross-origin POST in the request guard', async () => {
    enableEmbedded()
    const response = await fetch(`${origin}/api/mutation`, { method: 'POST', headers: { origin: 'https://untrusted.example' } })
    expect(response.status, '跨源 POST 必须由 request guard 拒绝').toBe(403)
    expect(await response.json(), 'request guard 必须返回 cross-origin-request').toEqual({ error: 'cross-origin-request' })
  })

  it('restores the 401 rejection after disposing the embedded gate', async () => {
    enableEmbedded()
    const embedded = await fetch(`${origin}/api/known`)
    expect(embedded.status, 'dispose 前嵌入载体应被放行').toBe(200)

    disposeGate?.()
    disposeGate = undefined
    const restored = await fetch(`${origin}/api/known`)
    expect(restored.status, 'dispose 后必须恢复 401').toBe(401)
    expect(await restored.json(), '恢复后的 401 必须返回 unauthorized 错误体').toEqual({ error: 'unauthorized' })
  })

  it('returns 401 before embedding and 404 after embedding for an unmounted route', async () => {
    const ordinary = await fetch(`${origin}/api/missing`)
    expect(ordinary.status, '未嵌入时未挂载路径仍受鉴权保护').toBe(401)

    enableEmbedded()
    const embedded = await fetch(`${origin}/api/missing`)
    expect(embedded.status, '嵌入绕过鉴权后未挂载路径必须返回 404').toBe(404)
  })

  it('delegates a launch-token index request so the kernel can mint a session cookie', async () => {
    enableEmbedded()
    const response = await fetch(`${origin}/?token=launch-token`, { redirect: 'manual' })
    expect(response.status, '带 token 的 index 请求必须交回内核换取会话 Cookie').toBe(303)
    expect(response.headers.get('set-cookie'), '内核的 303 必须带上会话 Cookie').toContain('dsh-auth-test=session')
    expect(response.headers.get('location'), '内核按目录相对路径跳转').toBe('./')
  })

  it('keeps the embedded bypass for an index request without a launch token', async () => {
    enableEmbedded()
    const response = await fetch(`${origin}/`)
    expect(response.status, '无 token 的 index 请求仍按内嵌载体放行').toBe(200)
    expect(await response.text(), '放行后直接返回页面').toBe('index route')
  })

  it('ignores a launch token outside the root path', async () => {
    enableEmbedded()
    const response = await fetch(`${origin}/api/known?token=launch-token`)
    expect(response.status, 'token 只在根路径上触发交换').toBe(200)
    expect(await response.text(), '非根路径不进入内核交换').toBe('authorized route')
  })
})
