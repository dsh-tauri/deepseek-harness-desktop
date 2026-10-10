import type { WireCall, WireReply } from '../test-utils/client-mock'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { store } from '../store/index'
import { answer, replies, resetWire, sent } from '../test-utils/client-mock'
import * as service from './access'

vi.mock('dsh-tauri/client', async () => (await import('../test-utils/client-mock')).clientMock)

const BASE = '/api/tauri/remote/access'

let queued: WireReply[] = []
let route: (call: WireCall) => WireReply = () => replies.ok({})

function once(...next: WireReply[]): void {
  queued.push(...next)
}

beforeEach(() => {
  resetWire()
  store.access.reset()
  queued = []
  route = () => replies.ok({})
  answer(call => queued.shift() ?? route(call))
})

describe('接入面板数据层', () => {
  it('回包缺字段时按默认值收敛，绝不抛错', async () => {
    route = () => replies.ok({ state: 'listening', listening: true })
    await service.load()
    const snapshot = store.access.snapshot
    expect(store.access.status).toBe('ready')
    expect(snapshot?.state).toBe('listening')
    expect(snapshot?.listen).toEqual({ address: '127.0.0.1', port: 3088 })
    expect(snapshot?.tunnel).toEqual({ enabled: false, mode: 'quick', hostname: null, state: 'stopped', events: [] })
    expect(snapshot?.addresses).toEqual([])
  })

  it('字段类型不对时逐项回落，保留可用部分', async () => {
    route = () => replies.ok({
      version: 'v1',
      enabled: true,
      port: '3088',
      auth: { enabled: true, scope: 'everything', hasToken: 'yes' },
      addresses: [{ address: '10.0.0.2' }, { nope: true }, 'garbage'],
      tunnel: { enabled: true, mode: 'named', state: 'running', hostname: 'dsh.example.com' },
      events: [{ seq: 2, line: 'ok' }, { nope: 1 }],
    })
    await service.load()
    const snapshot = store.access.snapshot
    expect(snapshot?.version).toBe(1)
    expect(snapshot?.port).toBe(0)
    expect(snapshot?.auth).toEqual({ enabled: true, scope: 'public_only' })
    expect(snapshot?.addresses).toHaveLength(1)
    expect(snapshot?.addresses[0]?.address).toBe('10.0.0.2')
    expect(snapshot?.tunnel.mode).toBe('quick')
    expect(snapshot?.tunnel.state).toBe('running')
    expect(snapshot?.events).toEqual([{ seq: 2, ts: '', kind: 'state', line: 'ok' }])
  })

  it('变更失败时保留错误文案并复位 busy', async () => {
    once(replies.ok({}), replies.fail('访问密码太短', 400))
    await service.load()
    const result = await service.apply({ password: 'x' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('访问密码太短')
    expect(store.access.status).toBe('error')
    expect(store.access.busy).toBe(false)
  })

  it('隧道启停走面板专用路由并提交回包', async () => {
    once(
      replies.ok({}),
      replies.ok({ enabled: true, tunnel: { enabled: true, mode: 'token', hostname: 'dsh.example.com', state: 'running', events: [] } }),
      replies.ok({ enabled: true, tunnel: { enabled: false, mode: 'token', hostname: 'dsh.example.com', state: 'stopped', events: [] } }),
    )
    await service.load()
    await service.startTunnel({ mode: 'token', token: 'cf', hostname: 'dsh.example.com' })
    expect(sent.at(-1)?.url).toBe(`${BASE}/tunnel`)
    expect(sent.at(-1)?.http).toBe('POST')
    expect(store.access.snapshot?.tunnel.state).toBe('running')
    await service.stopTunnel()
    expect(sent.at(-1)?.http).toBe('DELETE')
    expect(store.access.snapshot?.tunnel.state).toBe('stopped')
  })
})
