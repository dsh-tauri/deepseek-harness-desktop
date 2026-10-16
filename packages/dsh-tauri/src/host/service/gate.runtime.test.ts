import type { Context as HostContext } from '@deepseek-ai/cordis'
import type { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ConnectionHost } from '../types'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { gate } from './gate'

const require = createRequire(process.env.DSH_E2E_DSH_BIN ? pathToFileURL(process.env.DSH_E2E_DSH_BIN) : import.meta.url)
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse())
      await cleanup()
  }
  finally {
    vi.unstubAllEnvs()
  }
})

it('real core /api prefix admits its original peer only while the embedded gate is attached', async () => {
  vi.stubEnv('DSH_TAURI_EMBEDDED', undefined)
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href) as typeof import('@deepseek-ai/cordis')
  const connectionModule = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-client-connection')).href) as typeof import('@deepseek-ai/dsh-client-connection')
  const context = new Context()
  cleanups.push(() => context.fiber.dispose())
  const routes: WebRoute[] = []
  context.provide('webServer', {
    protocol: 'http:',
    host: '127.0.0.1',
    register(route: WebRoute) {
      routes.push(route)
      return () => routes.splice(routes.indexOf(route), 1)
    },
  } as unknown as HostContext['webServer'])
  context.provide('credentials', {
    async modifyRecord(_key: string, update: (value: undefined) => Promise<unknown>) {
      return update(undefined)
    },
  } as unknown as HostContext['credentials'])
  await connectionModule.apply(context)
  await vi.waitFor(() => expect(routes.map(route => route.path)).toContain('/api'))
  const connection = context.connection as HostConnectionService & {
    browserPeer?: { id: string, signal: AbortSignal, dispose: () => Promise<void> }
    admitConnection?: (request: IncomingMessage) => { rejection: number } | { peer: unknown, release: () => Promise<void> }
  }
  const peer = connection.browserPeer ?? connection.operator
  context.connection.rpc.intercept('/api', endpoint => endpoint === 'gate/probe', async (_endpoint, _payload, _signal, admitted) => ({ ok: true, value: { id: admitted.id } }))
  const route = routes.find(route => route.path === '/api')!
  const server = createServer((req, res) => {
    const selected = routes.find(candidate => candidate.path === new URL(req.url!, 'http://localhost').pathname) ?? route
    void Promise.resolve(selected.handler(req, res)).catch(error => res.destroy(error as Error))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  }))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const probe = (headers: Record<string, string> = {}) => fetch(`${base}/api/gate/probe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ type: 'client-request', rpcId: 'probe', method: 'gate/probe', payload: {} }),
  })
  expect((await probe()).status).toBe(401)
  vi.stubEnv('DSH_TAURI_EMBEDDED', '1')
  const detach = gate.attach(context as unknown as ConnectionHost)
  cleanups.push(detach)
  const allowed = await probe()
  expect(allowed.status).toBe(200)
  expect(await allowed.json()).toEqual({ type: 'server-response', rpcId: 'probe', result: { ok: true, value: { id: peer.id } } })
  expect((await probe({ origin: 'http://evil.example' })).status).toBe(403)
  const untrusted = { headers: { host: 'evil.example' } } as IncomingMessage
  expect(connection.admit(untrusted)).toEqual({ rejection: 403 })
  if (connection.admitConnection) {
    const trusted = { headers: { host: new URL(base).host } } as IncomingMessage
    const connectUrl = new URL(connection.authenticatedUrl(`${base}/`))
    connectUrl.pathname = '/connect'
    const credential = await fetch(connectUrl, { redirect: 'manual' })
    expect(credential.status).toBe(302)
    const cookie = credential.headers.get('set-cookie')!.split(';')[0]!
    const apiAdmission = connection.admit({ headers: { ...trusted.headers, cookie } } as IncomingMessage)
    expect(apiAdmission).toHaveProperty('peer')
    if ('peer' in apiAdmission) {
      expect(apiAdmission.peer).not.toBe(peer)
      const api = await probe({ cookie })
      expect(api.status).toBe(200)
      expect(await api.json()).toEqual({ type: 'server-response', rpcId: 'probe', result: { ok: true, value: { id: apiAdmission.peer.id } } })
    }
    const upgrade = connection.admitConnection(trusted)
    expect(upgrade).toMatchObject({ peer, release: expect.any(Function) })
    if ('release' in upgrade)
      await upgrade.release()
    expect(connection.browserPeer!.signal.aborted).toBe(false)
    expect(connection.admitConnection(untrusted)).toEqual({ rejection: 403 })
    expect(connection.admitConnection({ headers: { ...trusted.headers, origin: 'http://evil.example' } } as IncomingMessage)).toEqual({ rejection: 403 })
    detach()
    cleanups.pop()
    expect((await probe()).status).toBe(401)
    cleanups.push(gate.attach(context as unknown as ConnectionHost))
    Reflect.set(connection, 'disposed', true)
    expect(connection.browserPeer!.signal.aborted).toBe(false)
    expect((await probe()).status).toBe(401)
    Reflect.set(connection, 'disposed', false)
    await connection.browserPeer!.dispose()
    expect(connection.admitConnection(trusted)).toEqual({ rejection: 401 })
    expect(connection.requestRejection(trusted)).toBe(401)
    expect((await probe()).status).toBe(401)
  }
  await cleanups.pop()!()
  expect((await probe()).status).toBe(401)
})
