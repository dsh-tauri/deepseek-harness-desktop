import type { WireCall, WireReply } from '../test-utils/client-mock'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { store } from '../store/index'
import { answer, replies, resetWire, sent } from '../test-utils/client-mock'
import * as service from './access'

vi.mock('dsh-tauri/client', async () => (await import('../test-utils/client-mock')).clientMock)

const BASE = '/api/tauri/remote/access'

let queued: WireReply[] = []
let route: (call: WireCall) => WireReply | Promise<WireReply> = () => replies.ok({})

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

afterEach(() => {
  vi.restoreAllMocks()
})

const DOWNLOADING = { enabled: true, tunnel: { enabled: true, mode: 'quick', state: 'starting', progress: { stage: 'download', received: 1, total: 2 } } }

const RUNNING = { enabled: true, tunnel: { enabled: true, mode: 'quick', state: 'running' } }

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

  it('配对回包保留合法消费序号，非法序号不覆盖可用凭据', async () => {
    const pairing = { code: 'AB23CD45', expiresAt: 300000 }
    const cases: { value: unknown, expected?: number }[] = [
      { value: 0, expected: 0 },
      { value: 2, expected: 2 },
      { value: Number.MAX_SAFE_INTEGER, expected: Number.MAX_SAFE_INTEGER },
      { value: -1 },
      { value: 0.5 },
      { value: '2' },
      { value: undefined },
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
      { value: Number.MAX_SAFE_INTEGER + 1 },
    ]
    for (const { value, expected } of cases) {
      route = () => replies.ok({ auth: { token: '01234567' }, pairing: { ...pairing, usedSeq: value } })
      await service.refresh()
      expect(store.access.snapshot?.auth.token).toBe('01234567')
      expect(store.access.snapshot?.pairing).toEqual(expected === undefined ? pairing : { ...pairing, usedSeq: expected })
    }
  })

  it('变更失败时保留错误文案并复位 busy', async () => {
    once(replies.ok({}), replies.fail('监听地址不可用', 400))
    await service.load()
    const result = await service.apply({ address: 'missing' })
    expect(result).toEqual({ ok: false, error: '请求失败 (400): 监听地址不可用' })
    expect(store.access.status).toBe('error')
    expect(store.access.busy).toBe(false)
  })

  it('旧回包的访问密码字段被丢弃，配对码和永久码不受影响', async () => {
    route = () => replies.ok({
      auth: { enabled: true, scope: 'all', hasPassword: true, hasToken: true, token: '01234567' },
      generatedPassword: 'legacy-secret',
      pairing: { code: 'AB23CD45', expiresAt: 300000 },
    })
    await service.load()

    expect(store.access.snapshot?.auth).toEqual({ enabled: true, scope: 'all', hasToken: true, token: '01234567' })
    expect(store.access.snapshot).not.toHaveProperty('generatedPassword')
    expect(store.access.snapshot?.pairing).toEqual({ code: 'AB23CD45', expiresAt: 300000 })
  })

  it('get 乱序返回时旧 stopped 快照不能覆盖已提交的下载进度', async () => {
    const older = Promise.withResolvers<WireReply>()
    const newer = Promise.withResolvers<WireReply>()
    let reads = 0
    route = () => (++reads === 1 ? older.promise : newer.promise)
    const first = service.refresh()
    const second = service.refresh()
    newer.resolve(replies.ok(DOWNLOADING))
    await second
    expect(store.access.snapshot?.tunnel.progress).toEqual({ stage: 'download', received: 1, total: 2 })
    older.resolve(replies.ok({}))
    await first
    expect(store.access.snapshot?.tunnel.progress).toEqual({ stage: 'download', received: 1, total: 2 })
  })

  it('get 乱序失败时不抹掉较新进度或新增旧错误', async () => {
    const older = Promise.withResolvers<WireReply>()
    const newer = Promise.withResolvers<WireReply>()
    let reads = 0
    route = () => (++reads === 1 ? older.promise : newer.promise)
    const first = service.refresh()
    const second = service.refresh()
    newer.resolve(replies.ok(DOWNLOADING))
    await second
    older.resolve(replies.fail('stale failure'))
    await first
    expect(store.access.status).toBe('ready')
    expect(store.access.error).toBeNull()
    expect(store.access.snapshot?.tunnel.progress).toEqual({ stage: 'download', received: 1, total: 2 })
  })

  it('长启动回包较旧时保留期间轮询进度并释放 busy', async () => {
    const mutation = Promise.withResolvers<WireReply>()
    route = call => call.http === 'POST' ? mutation.promise : replies.ok(DOWNLOADING)
    const pending = service.startTunnel({ mode: 'quick' })
    await service.refresh()
    expect(store.access.busy).toBe(true)
    expect(store.access.snapshot?.tunnel.progress).toEqual({ stage: 'download', received: 1, total: 2 })

    mutation.resolve(replies.ok({}))
    await expect(pending).resolves.toEqual({ ok: true })
    expect(store.access.snapshot?.tunnel.progress).toEqual({ stage: 'download', received: 1, total: 2 })
    expect(store.access.busy).toBe(false)
  })

  it('长启动完成后读取权威最终状态，不停留于期间的下载进度', async () => {
    const mutation = Promise.withResolvers<WireReply>()
    let current: unknown = DOWNLOADING
    route = call => call.http === 'POST' ? mutation.promise : replies.ok(current)
    const pending = service.startTunnel({ mode: 'quick' })
    await service.refresh()
    expect(store.access.snapshot?.tunnel.state).toBe('starting')
    current = RUNNING
    mutation.resolve(replies.ok(RUNNING))
    await pending
    expect(store.access.snapshot?.tunnel.state).toBe('running')
    expect(store.access.busy).toBe(false)
  })

  it('启动完成后迟到的 GET 不能覆盖动作最终快照', async () => {
    const mutation = Promise.withResolvers<WireReply>()
    const poll = Promise.withResolvers<WireReply>()
    route = call => call.http === 'POST' ? mutation.promise : poll.promise
    const pending = service.startTunnel({ mode: 'quick' })
    const reading = service.refresh()
    mutation.resolve(replies.ok(RUNNING))
    await pending
    expect(store.access.snapshot?.tunnel.state).toBe('running')
    poll.resolve(replies.ok(DOWNLOADING))
    await reading
    expect(store.access.snapshot?.tunnel.state).toBe('running')
  })

  it('动作失败仍保留自身错误，期间 polling 不遮蔽失败且 busy 复位', async () => {
    const mutation = Promise.withResolvers<WireReply>()
    route = call => call.http === 'POST' ? mutation.promise : replies.ok(DOWNLOADING)
    const pending = service.startTunnel({ mode: 'quick' })
    await service.refresh()
    mutation.resolve(replies.fail('download denied'))
    await expect(pending).resolves.toEqual({ ok: false, error: '请求失败 (400): download denied' })
    expect(store.access.error).toBe('请求失败 (400): download denied')
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
