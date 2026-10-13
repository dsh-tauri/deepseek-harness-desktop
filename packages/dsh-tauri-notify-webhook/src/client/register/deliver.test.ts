// @vitest-environment jsdom
import type { ClientContext } from 'dsh-tauri/client'
import type { WireCall, WireReply } from '../test-utils/client-mock'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { answer, replies, resetWire, sent } from '../test-utils/client-mock'

vi.mock('dsh-tauri/client', async () => (await import('../test-utils/client-mock')).clientMock)

const { deliverFeature } = await import('./deliver')

const SETTLE_MS = 250
const TURN_END = '/api/tauri/notify-webhook/turn-end'
const DELIVERY = '/api/tauri/notify-webhook/delivery'

interface SessionRow {
  title?: string
  displayTitle?: string
  origin?: 'subagent'
  running: boolean
}

interface Harness {
  dispose: () => void
  emit: (rows: Record<string, SessionRow>) => void
}

/** 会话列表投影的替身：`emit` 改快照并按订阅者回放，和官方 store 的推流同形。 */
function boot(rows: Record<string, SessionRow>, reason: (sessionId: string) => string = () => 'completed'): Harness {
  let state = rows
  const listeners: Array<() => void> = []
  const sessions = {
    list: {
      getSnapshot: () => ({ ids: Object.keys(state), byId: state }),
      subscribe: (listener: () => void) => {
        listeners.push(listener)
        return () => {
          listeners.splice(listeners.indexOf(listener), 1)
        }
      },
    },
  }
  const ctx = { get: (key: string) => (key === 'sessions' ? sessions : undefined) } as unknown as ClientContext
  answer(call => call.url === TURN_END
    ? replies.ok({ reason: reason(String(call.params.sessionId)) })
    : replies.ok({ ok: true }))
  const run = deliverFeature as unknown as (this: unknown) => () => void
  return {
    dispose: run.call(ctx),
    emit: (next) => {
      state = next
      for (const listener of [...listeners]) listener()
    },
  }
}

const deliveryCalls = (): WireCall[] => sent.filter(call => call.url === DELIVERY)
const turnEndCalls = (): WireCall[] => sent.filter(call => call.url === TURN_END)
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(SETTLE_MS)
}

/** ofetch 的应答链有好几跳，等挂起的回包落地得把微任务队列抽干。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1)
    await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  resetWire()
  // 宿主补丁把 `document.visibilityState` 映射成窗口状态：默认按「窗口没聚焦」跑。
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
})

afterEach(() => {
  Reflect.deleteProperty(document, 'visibilityState')
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('notify-webhook delivery feature', () => {
  it('只在 running 由 true 翻成 false 后推送，标题取会话显示名并去掉首尾空白', async () => {
    const harness = boot({ s1: { running: true, displayTitle: ' 修复登录 ', title: 'raw' } })
    harness.emit({ s1: { running: false, displayTitle: ' 修复登录 ', title: 'raw' } })
    await settle()
    expect(deliveryCalls()).toEqual([{
      url: DELIVERY,
      http: 'POST',
      body: { sessionId: 's1', title: '修复登录', trigger: 'completed' },
      params: {},
    }])
  })

  it('宿主记的是异常结束时推异常触发器，标题缺失时投递空标题', async () => {
    const harness = boot({ s1: { running: true } }, () => 'aborted')
    harness.emit({ s1: { running: false } })
    await settle()
    expect(turnEndCalls()).toEqual([{ url: TURN_END, http: 'GET', body: {}, params: { sessionId: 's1' } }])
    expect(deliveryCalls().map(call => call.body)).toEqual([{ sessionId: 's1', title: '', trigger: 'abnormal' }])
  })

  it('首次观察只建立基线：插件加载前就停住的会话不补推', async () => {
    const harness = boot({ s1: { running: false } })
    harness.emit({ s1: { running: false } })
    await settle()
    expect(turnEndCalls()).toEqual([])
    expect(deliveryCalls()).toEqual([])
  })

  it('合并窗口内又跑起来的会话不推送', async () => {
    const harness = boot({ s1: { running: true } })
    harness.emit({ s1: { running: false } })
    harness.emit({ s1: { running: true } })
    await settle()
    expect(deliveryCalls()).toEqual([])
  })

  it('子代理会话不进观察集，翻成停止也不推送', async () => {
    const harness = boot({ s1: { running: true }, sub: { running: true, origin: 'subagent' } })
    harness.emit({ s1: { running: true }, sub: { running: false, origin: 'subagent' } })
    await settle()
    expect(deliveryCalls()).toEqual([])
  })

  it('窗口在前台时问得到原因但不投递', async () => {
    const harness = boot({ s1: { running: true } })
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    harness.emit({ s1: { running: false } })
    await settle()
    expect(turnEndCalls()).toHaveLength(1)
    expect(deliveryCalls()).toEqual([])
  })

  it('会话从列表消失时清掉基线并取消待推送', async () => {
    const harness = boot({ s1: { running: true } })
    harness.emit({ s1: { running: false } })
    harness.emit({})
    await settle()
    expect(deliveryCalls()).toEqual([])
  })

  it('卸载后不再推送', async () => {
    const harness = boot({ s1: { running: true } })
    harness.emit({ s1: { running: false } })
    harness.dispose()
    await settle()
    expect(deliveryCalls()).toEqual([])
  })

  it('宿主拒绝投递时只告警，不抛出', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const harness = boot({ s1: { running: true } })
    answer((call: WireCall): WireReply => call.url === DELIVERY
      ? replies.ok({ ok: false, error: 'NOTIFY_UNCONFIGURED: channel' })
      : replies.ok({ reason: 'completed' }))
    harness.emit({ s1: { running: false } })
    await settle()
    expect(warn).toHaveBeenCalledWith('[dsh-tauri-notify-webhook] 推送失败：NOTIFY_UNCONFIGURED: channel')
  })

  it('问原因的回包还没落地插件就被卸载，此时不投递', async () => {
    const harness = boot({ s1: { running: true } })
    let release: (reply: WireReply) => void = () => {}
    answer((call: WireCall): WireReply | Promise<WireReply> => call.url === TURN_END
      ? new Promise<WireReply>((resolve) => { release = resolve })
      : replies.ok({ ok: true }))
    harness.emit({ s1: { running: false } })
    await settle()
    expect(turnEndCalls()).toHaveLength(1)

    harness.dispose()
    release(replies.ok({ reason: 'completed' }))
    await flush()
    expect(deliveryCalls()).toEqual([])
  })

  it('问原因的这段时间里会话又跑起来，回包落地也不投递', async () => {
    const harness = boot({ s1: { running: true } })
    let release: (reply: WireReply) => void = () => {}
    answer((call: WireCall): WireReply | Promise<WireReply> => call.url === TURN_END
      ? new Promise<WireReply>((resolve) => { release = resolve })
      : replies.ok({ ok: true }))
    harness.emit({ s1: { running: false } })
    await settle()

    harness.emit({ s1: { running: true } })
    release(replies.ok({ reason: 'completed' }))
    await flush()
    expect(deliveryCalls()).toEqual([])
  })

  it('问原因期间会话又停了一次，上一趟的回包作废、只推最新那次', async () => {
    const harness = boot({ s1: { running: true } })
    const releases: Array<(reply: WireReply) => void> = []
    answer((call: WireCall): WireReply | Promise<WireReply> => call.url === TURN_END
      ? new Promise<WireReply>((resolve) => { releases.push(resolve) })
      : replies.ok({ ok: true }))
    harness.emit({ s1: { running: false } })
    await settle()
    expect(releases).toHaveLength(1)

    harness.emit({ s1: { running: true } })
    harness.emit({ s1: { running: false } })
    await settle()
    expect(releases).toHaveLength(2)

    // 这一趟问的是上一次停下，宿主那格 turn/end 已经被后一次覆盖，原因对不上就不该推。
    releases[0](replies.ok({ reason: 'completed' }))
    await flush()
    expect(deliveryCalls()).toEqual([])

    releases[1](replies.ok({ reason: 'aborted' }))
    await flush()
    expect(deliveryCalls().map(call => call.body)).toEqual([{ sessionId: 's1', title: '', trigger: 'abnormal' }])
  })

  it('问原因期间会话从列表消失，回包落地也不投递', async () => {
    const harness = boot({ s1: { running: true } })
    let release: (reply: WireReply) => void = () => {}
    answer((call: WireCall): WireReply | Promise<WireReply> => call.url === TURN_END
      ? new Promise<WireReply>((resolve) => { release = resolve })
      : replies.ok({ ok: true }))
    harness.emit({ s1: { running: false } })
    await settle()

    harness.emit({})
    release(replies.ok({ reason: 'completed' }))
    await flush()
    expect(deliveryCalls()).toEqual([])
  })

  it('投递请求失败时只告警', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const harness = boot({ s1: { running: true } })
    answer((call: WireCall): WireReply => call.url === DELIVERY ? replies.http(500) : replies.ok({ reason: 'completed' }))
    harness.emit({ s1: { running: false } })
    await settle()
    expect(warn).toHaveBeenCalledWith('[dsh-tauri-notify-webhook] 推送失败：请求失败 (500)')
  })
})
