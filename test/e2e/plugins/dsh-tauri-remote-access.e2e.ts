import type { Server } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, inject, it } from 'vitest'

const BASE = '/api/tauri/remote'
const ACCESS = `${BASE}/access`
const TUNNEL = `${ACCESS}/tunnel`

interface AccessStatus {
  enabled: boolean
  state: string
  listening: boolean
  listen: { address: string, port: number }
  port: number
  auth: { enabled: boolean, scope: string, hasToken?: boolean }
  link?: string
  maskLink?: string
  qr?: string
  linkSource?: string
  pairing?: { code: string, expiresAt: number, usedSeq: number, link?: string, qr?: string }
  tunnel: { enabled: boolean, mode: string, state: string, url?: string, qr?: string, progress?: { stage: string, received?: number, total?: number } }
  localPort?: number
  error?: string
  events: Array<{ seq: number, line: string }>
}

function url(path: string): string {
  return `${inject('dshBaseUrl')}${path}`
}

function apiHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'cookie': inject('dshCookie'), 'content-type': 'application/json', ...extra }
}

async function readAccess(): Promise<AccessStatus> {
  const response = await fetch(url(ACCESS), { headers: apiHeaders() })
  expect(response.status, 'GET /access 必须存在且返回 200').toBe(200)
  return await response.json() as AccessStatus
}

async function writeAccess(body: Record<string, unknown>, method = 'POST'): Promise<{ status: number, body: AccessStatus }> {
  const response = await fetch(url(ACCESS), { method, headers: apiHeaders(), body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() as AccessStatus }
}

function freePort(): Promise<number> {
  const server: Server = createServer()
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number }
      server.close(() => resolve(address.port))
    })
  })
}

async function disable(): Promise<AccessStatus> {
  const response = await writeAccess({ enabled: false })
  return response.body
}

afterEach(async () => {
  await writeAccess({ enabled: false, authEnabled: false, address: '127.0.0.1' })
})

describe('入站暴露路由（真实 dsh 宿主）', () => {
  it('默认态：未监听、无凭据、隧道停止，且不返回链接', async () => {
    await disable()
    const status = await readAccess()
    expect(status.listening).toBe(false)
    expect(status.state).toBe('stopped')
    expect(status.link).toBeUndefined()
    expect(status.qr).toBeUndefined()
    expect(status.tunnel.state).toBe('stopped')
    expect(status.tunnel.mode).toBe('quick')
    expect(status.auth.hasToken).toBe(false)
    expect(status.auth).not.toHaveProperty('hasPassword')
    expect(status).not.toHaveProperty('generatedPassword')
  })

  it('开启回环监听：真实端口可转发，localPort 取自宿主 webserver 的实监听端口', async () => {
    const port = await freePort()
    const started = await writeAccess({ enabled: true, address: '127.0.0.1', port })
    expect(started.status).toBe(200)
    expect(started.body.listening).toBe(true)
    expect(started.body.port).toBe(port)
    expect(started.body.localPort, '非桌面载体没有 DSH_WEB_PORT，端口必须来自宿主 webserver').toBeGreaterThan(0)
    expect(started.body.link).toBe(`http://127.0.0.1:${port}/`)
    expect(started.body.linkSource).toBe('loopback')
    expect(started.body.qr, '面板需要本地核对用二维码，回环监听也生成').toMatch(/^data:image\/png;base64,/u)
    expect(started.body.auth.enabled, '开启暴露即自动带认证').toBe(true)
    expect(started.body.pairing?.code).toMatch(/^[2-9A-HJ-NP-Z]{8}$/u)
    expect(started.body.auth).not.toHaveProperty('hasPassword')
    expect(started.body).not.toHaveProperty('generatedPassword')

    const proxied = await fetch(`http://127.0.0.1:${port}/`)
    expect(proxied.status).toBe(200)
    expect(await proxied.text()).toContain('<')

    const stopped = await disable()
    expect(stopped.listening).toBe(false)
    expect(stopped.link).toBeUndefined()
  }, 60_000)

  it('配对码换会话后立即轮换，旧码不可重放且既有会话仍可访问', async () => {
    const port = await freePort()
    const started = await writeAccess({ enabled: true, address: '0.0.0.0', port, authEnabled: true, scope: 'all' })
    expect(started.status).toBe(200)
    const pairing = started.body.pairing
    expect(pairing?.link).toContain(`?auth=${pairing?.code}`)
    expect(pairing?.qr).toMatch(/^data:image\/png;base64,/u)
    const origin = `http://127.0.0.1:${started.body.port}`
    const source = { 'x-dsh-remote-source': 'public', 'accept': 'application/json' }
    const challenge = await fetch(`${origin}/`, { headers: { ...source, accept: 'text/html' } })
    expect(challenge.status).toBe(401)
    const html = await challenge.text()
    expect(html).toContain('<form id="loginForm" method="post">')
    expect(html).toContain('name="code"')
    expect(html).not.toContain('name="password"')
    const exchanged = await fetch(`${origin}/?auth=${pairing?.code}`, { headers: source, redirect: 'manual' })
    expect(exchanged.status).toBe(302)
    expect(exchanged.headers.get('location')).toBe('/')
    const cookie = exchanged.headers.getSetCookie().map(value => value.split(';')[0] ?? '').find(value => value.startsWith('dsh_remote_session='))
    expect(cookie).toBeTruthy()
    const next = await readAccess()
    expect(next.pairing?.usedSeq).toBe((pairing?.usedSeq ?? 0) + 1)
    expect(next.pairing?.code).not.toBe(pairing?.code)
    expect((await fetch(`${origin}/?auth=${pairing?.code}`, { headers: source, redirect: 'manual' })).status).toBe(401)
    expect((await fetch(`${origin}/`, { headers: { ...source, cookie: cookie ?? '' } })).status).toBe(200)
  }, 60_000)

  it('原生健康检查无需会话，只有 manifest 可匿名读取且不消费配对码', async () => {
    const port = await freePort()
    const started = await writeAccess({ enabled: true, address: '127.0.0.1', port, authEnabled: true, scope: 'all' })
    expect(started.status).toBe(200)
    const origin = `http://127.0.0.1:${port}`
    const headers = { 'x-dsh-remote-source': 'public', 'accept': 'application/json' }
    const manifest = await fetch(`${origin}/manifest.webmanifest`, { headers })
    expect(manifest.status).toBe(200)
    expect(await manifest.json()).toMatchObject({ name: 'DeepSeek Harness', short_name: 'DSH' })
    expect(manifest.headers.get('set-cookie')).toBeNull()
    const head = await fetch(`${origin}/manifest.webmanifest?auth=${started.body.pairing?.code}`, { method: 'HEAD', headers })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    expect((await readAccess()).pairing).toEqual(started.body.pairing)
    expect((await fetch(`${origin}/`, { headers })).status).toBe(401)
    expect((await fetch(`${origin}${ACCESS}`, { headers })).status).toBe(401)
    expect((await fetch(`${origin}/manifest.webmanifest`, { headers: { ...headers, origin: 'https://evil.example' } })).status).toBe(403)
  })

  it('隧道参数校验：具名模式缺凭据或主机名时 400，且不落盘', async () => {
    const missingCredential = await fetch(url(TUNNEL), { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ mode: 'token' }) })
    expect(missingCredential.status).toBe(400)
    expect(JSON.stringify(await missingCredential.json())).toContain('Tunnel Token')

    const missingHostname = await fetch(url(TUNNEL), { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ mode: 'token', token: 'cf-token' }) })
    expect(missingHostname.status).toBe(400)
    expect(JSON.stringify(await missingHostname.json())).toContain('公开主机名')

    const documentPath = join(inject('dshHome'), 'remote', 'access.json')
    const document = JSON.parse(existsSync(documentPath) ? readFileSync(documentPath, 'utf8') : '{}') as { tunnel?: { enabled?: boolean } }
    expect(document.tunnel?.enabled ?? false).toBe(false)
    expect((await readAccess()).tunnel.state).toBe('stopped')
  }, 60_000)

  it('管理接口拒绝非回环来源（网关标识声明为公网）', async () => {
    const response = await fetch(url(ACCESS), {
      method: 'POST',
      headers: apiHeaders({ 'x-dsh-remote-source': 'public' }),
      body: JSON.stringify({ enabled: true }),
    })
    expect(response.status).toBe(403)
  }, 60_000)
})
