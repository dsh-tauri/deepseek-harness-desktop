// @vitest-environment node
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { server } from '.'
import { NOTIFY_WEBHOOK_DEFAULTS } from '../../shared/settings'
import { resetRuntime, turnEndFacts } from '../config/runtime'
import { handleSessionEvent } from '../events/session-event'
import { notifier } from '../service/notifier'
import { settings } from '../service/settings'

const BASE = '/api/tauri/notify-webhook'
const SETTINGS = `${BASE}/settings`
const TEST = `${BASE}/test`
const TURN_END = `${BASE}/turn-end`
const DELIVERY = `${BASE}/delivery`
const PATHS = [SETTINGS, TEST, TURN_END, DELIVERY]

/** 宿主服务是模块级单例：每个用例换掉方法，收尾按快照还原。 */
const original = { deliver: notifier.deliver, test: notifier.test, load: settings.load, save: settings.save }

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
  Object.assign(notifier, original)
  Object.assign(settings, original)
  resetRuntime()
  vi.restoreAllMocks()
})

interface Harness {
  base: string
  registered: Map<string, WebRoute>
  unmount: () => void
}

/** 真实 webServer 契约的最小替身 + 真 HTTP 回环：断言的是字节，不是路由对象。 */
async function activate(rejection?: 401 | 403): Promise<Harness> {
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

  const unmount = server(context)
  const httpServer = createServer((request, response) => {
    const route = registered.get(new URL(request.url ?? '/', 'http://localhost').pathname)
    if (!route) {
      response.writeHead(404).end()
      return
    }
    void Promise.resolve(route.handler(request, response)).catch(() => response.destroy())
  })
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    httpServer.close(error => error ? reject(error) : resolve())
    httpServer.closeAllConnections()
  }))
  cleanups.push(unmount)

  return { base: `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`, registered, unmount }
}

function post(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const allowOf = (response: Response): string[] => (response.headers.get('allow') ?? '').split(', ').sort()

it('把五条路由收敛成四条精确路径，且卸载后全部收回', async () => {
  const { registered, unmount } = await activate()
  expect([...registered.keys()].sort()).toEqual([...PATHS].sort())
  expect([...registered.values()].map(route => route.kind)).toEqual(['exact', 'exact', 'exact', 'exact'])
  unmount()
  expect(registered.size).toBe(0)
})

it('gET 设置回宿主设置，POST 设置把请求体交给保存并回归一化结果', async () => {
  const { base } = await activate()
  const saved = { ...NOTIFY_WEBHOOK_DEFAULTS, channel: 'pushplus', pushplus: { token: 'tk' } }
  const save = vi.fn(async () => saved)
  Object.assign(settings, { load: vi.fn(async () => saved), save })

  expect(await (await fetch(`${base}${SETTINGS}`)).json()).toEqual({ settings: saved })

  const body = { settings: { ...NOTIFY_WEBHOOK_DEFAULTS, channel: 'sms', email: { ...NOTIFY_WEBHOOK_DEFAULTS.email, port: '2525' } } }
  expect(await (await post(base, SETTINGS, body)).json()).toEqual({ settings: saved })
  expect(save).toHaveBeenCalledTimes(1)
  expect(save).toHaveBeenCalledWith(body.settings)
})

it('pOST 设置缺 settings 字段时拒绝，不碰存储', async () => {
  const { base } = await activate()
  const save = vi.fn(async () => NOTIFY_WEBHOOK_DEFAULTS)
  Object.assign(settings, { save })

  expect(await (await post(base, SETTINGS, {})).json()).toEqual({ error: 'NOTIFY_INVALID: settings' })
  expect(await (await post(base, SETTINGS, { settings: undefined })).json()).toEqual({ error: 'NOTIFY_INVALID: settings' })
  expect(save).not.toHaveBeenCalled()
})

it('设置读写在存储抛错时回错误原文而不是 500', async () => {
  const { base } = await activate()
  Object.assign(settings, {
    load: vi.fn(async () => { throw new Error('NOTIFY_STORAGE: boom') }),
    save: vi.fn(async () => { throw new Error('NOTIFY_STORAGE: boom') }),
  })

  expect(await (await fetch(`${base}${SETTINGS}`)).json()).toEqual({ error: 'NOTIFY_STORAGE: boom' })
  expect(await (await post(base, SETTINGS, { settings: NOTIFY_WEBHOOK_DEFAULTS })).json()).toEqual({ error: 'NOTIFY_STORAGE: boom' })
})

it('pOST 测试推送原样回投递结果，且不读请求体', async () => {
  const { base } = await activate()
  Object.assign(notifier, { test: vi.fn(async () => ({ ok: false, error: 'NOTIFY_UNCONFIGURED: channel' })) })

  const response = await fetch(`${base}${TEST}`, { method: 'POST' })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: false, error: 'NOTIFY_UNCONFIGURED: channel' })
})

it('gET 回合结束事实：未知会话回空对象，记录过的会话回原因与回合号', async () => {
  const { base } = await activate()
  expect(await (await fetch(`${base}${TURN_END}`)).json()).toEqual({})
  expect(await (await fetch(`${base}${TURN_END}?sessionId=ghost`)).json()).toEqual({})

  handleSessionEvent({ id: 's1' }, { type: 'turn/end', data: { turn: 3, reason: { kind: 'aborted' } } })
  expect(await (await fetch(`${base}${TURN_END}?sessionId=s1`)).json()).toEqual({ reason: 'aborted', turn: 3 })
  expect(turnEndFacts.size).toBe(1)
})

it('pOST 投递校验会话与触发器，通过后把标题交给投递服务', async () => {
  const { base } = await activate()
  const deliver = vi.fn(async () => ({ ok: true }))
  Object.assign(notifier, { deliver })

  expect(await (await post(base, DELIVERY, { trigger: 'completed' })).json()).toEqual({ ok: false, error: 'NOTIFY_INVALID: sessionId' })
  expect(await (await post(base, DELIVERY, { sessionId: 's1' })).json()).toEqual({ ok: false, error: 'NOTIFY_INVALID: trigger' })
  expect(await (await post(base, DELIVERY, { sessionId: 's1', trigger: 'forked' })).json()).toEqual({ ok: false, error: 'NOTIFY_INVALID: trigger' })
  expect(deliver).not.toHaveBeenCalled()

  expect(await (await post(base, DELIVERY, { sessionId: 's1', title: '标题', trigger: 'abnormal' })).json()).toEqual({ ok: true })
  expect(deliver).toHaveBeenCalledTimes(1)
  expect(deliver).toHaveBeenCalledWith('s1', '标题', 'abnormal')
})

it('投递失败时把失败原因交给客户端', async () => {
  const { base } = await activate()
  Object.assign(notifier, { deliver: vi.fn(async () => ({ ok: false, error: 'NOTIFY_DISABLED: completed' })) })

  expect(await (await post(base, DELIVERY, { sessionId: 's1', trigger: 'completed' })).json()).toEqual({ ok: false, error: 'NOTIFY_DISABLED: completed' })
})

it('gET 路由同时应答 HEAD，未注册的方法回 405 并列出允许集合', async () => {
  const { base } = await activate()

  for (const path of [SETTINGS, TURN_END]) {
    const head = await fetch(`${base}${path}`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    const options = await fetch(`${base}${path}`, { method: 'OPTIONS' })
    expect(options.status).toBe(405)
    expect(allowOf(options)).toEqual(path === SETTINGS ? ['GET', 'HEAD', 'POST'] : ['GET', 'HEAD'])
  }

  for (const path of [TEST, DELIVERY]) {
    const get = await fetch(`${base}${path}`)
    expect(get.status).toBe(405)
    expect(allowOf(get)).toEqual(['POST'])
  }

  const invalid = await fetch(`${base}${TURN_END}`, { method: 'POST' })
  expect(invalid.status).toBe(405)
  expect(allowOf(invalid)).toEqual(['GET', 'HEAD'])
})

it('连接闸门判 401/403 时设置路由不放行', async () => {
  const unauthorized = await activate(401)
  const forbidden = await activate(403)

  const first = await fetch(`${unauthorized.base}${SETTINGS}`)
  expect(first.status).toBe(401)
  expect(await first.json()).toEqual({ error: 'unauthorized' })

  const second = await fetch(`${forbidden.base}${SETTINGS}`)
  expect(second.status).toBe(403)
  expect(await second.json()).toEqual({ error: 'forbidden' })
})
