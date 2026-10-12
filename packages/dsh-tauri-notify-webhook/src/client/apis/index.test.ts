// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { answer, replies, resetWire, sent } from '../test-utils/client-mock'
import * as api from './index'

vi.mock('dsh-tauri/client', async () => (await import('../test-utils/client-mock')).clientMock)

const API = '/api/tauri/notify-webhook'

const settings = {
  channel: 'email',
  notifyOnComplete: true,
  notifyOnAbnormal: false,
  email: { host: 'smtp.example.com', port: 587, security: 'starttls', username: 'u', password: 'p', from: 'a@b.c', to: 'd@e.f' },
  pushplus: { token: 'tk' },
}

beforeEach(() => {
  resetWire()
})

describe('the request layer', () => {
  it('sends every request to its own REST endpoint', async () => {
    const table: { run: () => Promise<unknown>, url: string, http: string, body?: Record<string, unknown>, params?: Record<string, unknown>, value: unknown, result: unknown }[] = [
      { run: () => api.getSettings(), url: '/settings', http: 'GET', value: { settings }, result: { settings } },
      { run: () => api.postSettings({ settings }), url: '/settings', http: 'POST', body: { settings }, value: { settings }, result: { settings } },
      { run: () => api.postTest(), url: '/test', http: 'POST', value: { ok: true }, result: { ok: true } },
      { run: () => api.getTurnEnd({ sessionId: 's1' }), url: '/turn-end', http: 'GET', params: { sessionId: 's1' }, value: { reason: 'aborted', turn: 2 }, result: { reason: 'aborted', turn: 2 } },
      { run: () => api.postDelivery({ sessionId: 's1', title: '标题', trigger: 'completed' }), url: '/delivery', http: 'POST', body: { sessionId: 's1', title: '标题', trigger: 'completed' }, value: { ok: true }, result: { ok: true } },
    ]
    for (const entry of table) {
      resetWire()
      answer(() => replies.ok(entry.value))
      await expect(entry.run()).resolves.toEqual(entry.result)
      expect(sent).toEqual([{
        url: `${API}${entry.url}`,
        http: entry.http,
        body: entry.body ?? {},
        params: entry.params ?? {},
      }])
    }
  })

  it('passes the host failure prose through untouched', async () => {
    answer(() => replies.ok({ ok: false, error: 'NOTIFY_UNCONFIGURED: channel' }))
    await expect(api.postTest()).resolves.toEqual({ ok: false, error: 'NOTIFY_UNCONFIGURED: channel' })
  })

  it('turns an unknown session into an empty fact', async () => {
    answer(() => replies.ok({}))
    await expect(api.getTurnEnd({ sessionId: 'ghost' })).resolves.toEqual({})
  })

  it('surfaces a host-provided failure as its prose', async () => {
    answer(() => replies.fail('NOTIFY_INVALID: trigger'))
    await expect(api.postDelivery({ sessionId: 's1', trigger: 'completed' })).rejects.toThrowError('请求失败 (400): NOTIFY_INVALID: trigger')
  })

  it('reports a missing endpoint with its status', async () => {
    answer(() => replies.http(405))
    await expect(api.getSettings()).rejects.toThrowError('请求失败 (405)')
  })

  it('resolves an empty body as undefined', async () => {
    answer(() => replies.empty())
    await expect(api.getSettings()).resolves.toBeUndefined()
  })
})
