/**
 * 批次 · `dsh-tauri-remote` 入站暴露（S4/S5）在真实 `dsh web` 宿主里的路由契约。
 *
 * 复用 globalSetup 的共享宿主（`DSH_E2E_PLUGIN=dsh-tauri-remote`），因此断言的是**打包产物**：
 * 插件从 `src-tauri/resources` 加载，`/access` 的二维码生成必须证明 qrcode 已被构建期内联。
 *
 * 三条边界都在外部世界：HTTP 状态码、真实监听端口上的转发响应、`<DSH_HOME>/remote/access.json`
 * 的落盘形态。每个改状态的用例都在 `finally` 里关掉暴露并清空凭据，绝不把端口与凭据留给后续用例。
 *
 * 隧道只覆盖**参数校验**：quick 模式会真的去下载 cloudflared（网络依赖），进程生命周期由
 * `service/tunnel.test.ts` 用注入的桩进程覆盖，不在共享宿主里起真进程。
 */

import type { Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, inject, it } from 'vitest'

const BASE = '/api/desktop/dsh-tauri-remote'
const ACCESS = `${BASE}/access`
const TOKEN = `${ACCESS}/token`
const TUNNEL = `${ACCESS}/tunnel`

interface AccessStatus {
  enabled: boolean
  state: string
  listening: boolean
  listen: { address: string, port: number }
  port: number
  auth: { enabled: boolean, scope: string, hasPassword?: boolean, hasToken?: boolean }
  link?: string
  maskLink?: string
  qr?: string
  tunnel: { enabled: boolean, mode: string, state: string, url?: string }
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

/** 每个用例收尾：关暴露、关认证并清掉本用例设下的密码，共享宿主不把凭据留给后续文件。 */
afterEach(async () => {
  await writeAccess({ enabled: false, authEnabled: false, password: null })
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
    expect(status.auth.hasPassword).toBe(false)
  })

  it('开启回环监听：真实端口可转发，localPort 取自宿主 webserver 的实监听端口', async () => {
    const port = await freePort()
    const started = await writeAccess({ enabled: true, address: '127.0.0.1', port })
    expect(started.status).toBe(200)
    expect(started.body.listening).toBe(true)
    expect(started.body.port).toBe(port)
    expect(started.body.localPort, '非桌面载体没有 DSH_WEB_PORT，端口必须来自宿主 webserver').toBeGreaterThan(0)
    expect(started.body.link).toBe(`http://127.0.0.1:${port}/`)
    expect(started.body.qr, '回环监听不生成二维码').toBeUndefined()

    const proxied = await fetch(`http://127.0.0.1:${port}/`)
    expect(proxied.status).toBe(200)
    expect(await proxied.text()).toContain('<')

    const stopped = await disable()
    expect(stopped.listening).toBe(false)
    expect(stopped.link).toBeUndefined()
  }, 60_000)

  it('链接 Token 可签发与作废，链接与二维码只在有 Token 时带 auth 参数', async () => {
    const port = await freePort()
    await writeAccess({ enabled: true, address: '0.0.0.0', port, authEnabled: true, password: 'e2e-access-pass', scope: 'public_only' })
    try {
      const issued = await fetch(url(TOKEN), { method: 'POST', headers: apiHeaders() })
      expect(issued.status).toBe(200)
      const withToken = await issued.json() as AccessStatus
      expect(withToken.auth.hasToken).toBe(true)
      expect(withToken.auth.hasPassword).toBe(true)
      expect(withToken.link).toMatch(/\?auth=/u)
      expect(withToken.qr, '非回环监听给出二维码，证明打包产物里的二维码编码可用').toMatch(/^data:image\/png;base64,/u)
      expect(withToken.maskLink).toContain('?auth=***')

      const revoked = await fetch(url(TOKEN), { method: 'DELETE', headers: apiHeaders() })
      expect(revoked.status).toBe(200)
      const withoutToken = await revoked.json() as AccessStatus
      expect(withoutToken.auth.hasToken).toBe(false)
      expect(withoutToken.link).not.toContain('?auth=')
    }
    finally {
      await disable()
    }
  }, 60_000)

  it('隧道参数校验：具名模式缺凭据或主机名时 400，且不落盘', async () => {
    const missingCredential = await fetch(url(TUNNEL), { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ mode: 'token' }) })
    expect(missingCredential.status).toBe(400)
    expect(JSON.stringify(await missingCredential.json())).toContain('Tunnel Token')

    const missingHostname = await fetch(url(TUNNEL), { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ mode: 'token', token: 'cf-token' }) })
    expect(missingHostname.status).toBe(400)
    expect(JSON.stringify(await missingHostname.json())).toContain('公开主机名')

    const document = JSON.parse(readFileSync(join(inject('dshHome'), 'remote', 'access.json'), 'utf8')) as { tunnel: { enabled: boolean } }
    expect(document.tunnel.enabled).toBe(false)
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
