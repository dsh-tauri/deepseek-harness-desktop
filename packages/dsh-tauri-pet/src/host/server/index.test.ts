import type { HostContext } from 'dsh-tauri'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
/**
 * 宿主装配 apply() 的性能约定回归 + 会话流路由契约。
 *
 * 背景（0.11.x 用户反馈「吐字变慢」）：宿主曾在**每个** session/event（含逐 token 的
 * assistant/chunk）上调用 `sessionTitle.get(session)`，其内部是
 * `foldSessionTitle(session.snapshotEvents())` —— 整份会话事件日志 O(N) 复制 + O(N)
 * 扫描，成熟会话单次 1–4 ms，跑在 append() 的同步发布路径上（与流式转发同进程）。
 *
 * 本文件锁死四条约定：
 *   1. 无 SSE 消费者（桌宠停用/隐藏）时不挂载监听，会话事件不触发任何工作；
 *   2. 标题折叠次数与会话事件数无关（每会话至多一次全量折叠）；
 *   3. 有 `title` 投影时只走 O(新事件) 的 `stateOf`，不再全量折叠；
 *   4. 最后一个消费者断开即注销监听并丢弃累计态（下次接入从零重建）。
 *
 * 驱动方式与生产同路径：`apply(ctx)` 经 `defineWebServer` 把 node 处理器注册到宿主
 * webServer（本文件用最小替身捕获），再挂到真实 `node:http` server 上，用 fetch 读
 * 真 SSE 字节流——因此帧格式（`data: …` / `: keepalive` / `: state-lost` / `retry`）与断连清理都在
 * 本文件里被真实覆盖，而不是对着手写 response 打桩。
 */
import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, SESSION_STREAM_PATH } from '../../index'
import { SSE_KEEPALIVE_MS, SSE_RETRY_MS, SSE_STATE_LOST_COMMENT } from '../../shared/constants'

/** 一帧数据载荷（`data:` 行反序列化后的形状）。 */
interface SsePayload {
  action: string
  payload: Record<string, unknown>
}

/** 一条已建立的 SSE 连接（真实字节流 + 逐帧累积）。 */
interface SseConnection {
  /** 已到达的原始帧文本（含注释帧，按到达顺序）。 */
  frames: string[]
  /** 已到达的数据帧载荷（按到达顺序）。 */
  payloads: SsePayload[]
  /** 响应头（断言 `content-type: text/event-stream` 用）。 */
  headers: Headers
  /** 流地址（同路径发非 GET 请求，验证方法限制用）。 */
  url: string
  /** 等待条件成立（帧到达是异步的；超时抛错而不是永久挂起）。 */
  waitFor: <T>(read: () => T | undefined, label: string) => Promise<T>
  /** 断开连接（服务端据此注销监听）。 */
  disconnect: () => Promise<void>
}

interface FakeHostOptions {
  /** 是否提供 sessionTitle 服务（`get()` = O(整份日志) 折叠）。默认提供。 */
  titleService?: boolean
  /** 是否提供注册了 key='title' 的 sessionProjections 服务（O(新事件) 投影）。 */
  projections?: boolean
}

/** 宿主 webServer 收到的注册行（`defineWebServer` 的对外契约：kind + path + handler）。 */
interface RegisteredRoute {
  kind: string
  path: string
}

interface FakeHost {
  ctx: HostContext
  routes: RegisteredRoute[]
  titleLookups: () => number
  listenerCount: (name: string) => number
  emitEvent: (session: unknown, event: unknown) => void
  emitDisposed: (session: unknown) => void
  /** 发一帧 agent-scoped 活体助手流帧（`agent/assistant-stream` 的 chunk 帧）。 */
  emitAssistantStream: (session: unknown, chunk: unknown) => void
  /** 启动真实 http server 并接入一个 SSE 消费者。 */
  connect: () => Promise<SseConnection>
}

/** 等待条件成立（默认 2s 上限）：帧到达与断连都是异步的。 */
async function waitFor<T>(read: () => T | undefined, label: string): Promise<T> {
  const deadline = Date.now() + 2000
  for (;;) {
    const value = read()
    if (value !== undefined)
      return value
    if (Date.now() > deadline)
      throw new Error(`timeout waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** 等待布尔条件成立（`waitFor` 的布尔包装）。 */
async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  await waitFor(() => (predicate() ? true : undefined), label)
}

/** 测试期打开的资源：afterEach 里统一断开连接、跑插件卸载、关服务器。 */
const openConnections: SseConnection[] = []
const openServers: Array<() => Promise<void>> = []

/** 每个用例注册的插件卸载回调（见 createHost 尾部）。 */
const unloaders: Array<() => void> = []

/** 用例内安装的全局定时器 spy：配置无 restoreMocks，异常/超时路径也必须自己还原。 */
const intervalSpyRestores: Array<() => void> = []

function restoreIntervalSpies(): void {
  for (const restore of intervalSpyRestores.splice(0))
    restore()
}

/**
 * 最小宿主上下文替身：记录标题折叠次数、路由、会话监听挂载情况，
 * 并把 defineWebServer 注册出来的 node 处理器交给真实 http server。
 */
function createHost(options: FakeHostOptions = {}): FakeHost {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const routes: RegisteredRoute[] = []
  const disposers: Array<() => void> = []
  let lookups = 0
  let nodeHandler: ((request: IncomingMessage, response: ServerResponse) => void) | undefined

  const ctx = {
    get: (name: string) => {
      if (name === 'sessionTitle' && options.titleService !== false) {
        return {
          get: () => {
            lookups += 1
            return { title: `title-${lookups}` }
          },
        }
      }
      if (name === 'sessionProjections' && options.projections === true) {
        return {
          stateOf: (session: unknown, key: string) => key === 'title'
            ? (session as { title?: string }).title
            : undefined,
        }
      }
      return undefined
    },
    on: (name: string, handler: (...args: unknown[]) => void) => {
      const set = listeners.get(name) ?? new Set<(...args: unknown[]) => void>()
      listeners.set(name, set)
      set.add(handler)
      return () => {
        set.delete(handler)
      }
    },
    effect: (fn: () => unknown) => {
      const cleanup = fn()
      if (typeof cleanup === 'function')
        disposers.push(cleanup as () => void)
    },
    webServer: {
      // `defineWebServer` 的注册契约：一行 (kind, path) + 一个 node 处理器。
      register: (route: { kind: string, path: string, handler: (request: IncomingMessage, response: ServerResponse) => void }) => {
        routes.push({ kind: route.kind, path: route.path })
        nodeHandler = route.handler
        return () => {}
      },
    },
  } as unknown as HostContext

  const host: FakeHost = {
    ctx,
    routes,
    titleLookups: () => lookups,
    listenerCount: name => listeners.get(name)?.size ?? 0,
    emitEvent: (session, event) => {
      for (const handler of listeners.get('session/event') ?? [])
        handler(session, event)
    },
    emitDisposed: (session) => {
      for (const handler of listeners.get('session/disposed') ?? [])
        handler(session)
    },
    emitAssistantStream: (session, chunk) => {
      for (const handler of listeners.get('agent/assistant-stream') ?? [])
        handler({ agent: { session }, frame: { type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 0, chunk } })
    },
    connect: async () => {
      const server = createServer((request, response) => {
        nodeHandler?.(request, response)
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      openServers.push(() => new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }))

      const { port } = server.address() as AddressInfo
      const url = `http://127.0.0.1:${port}${SESSION_STREAM_PATH}`
      const response = await fetch(url)
      if (response.body === null)
        throw new Error('SSE response has no body')

      const frames: string[] = []
      const payloads: SsePayload[] = []
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      // 后台读流：按空行切帧，注释帧进 frames，数据帧另存解析结果。
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done)
              return
            buffer += decoder.decode(value, { stream: true })
            let end = buffer.indexOf('\n\n')
            while (end >= 0) {
              const frame = buffer.slice(0, end)
              buffer = buffer.slice(end + 2)
              frames.push(frame)
              const data = frame.split('\n').find(line => line.startsWith('data: '))
              if (data !== undefined)
                payloads.push(JSON.parse(data.slice('data: '.length)) as SsePayload)
              end = buffer.indexOf('\n\n')
            }
          }
        }
        catch {
          // 客户端 cancel 会打断读取：按流结束处理。
        }
      })()

      const connection: SseConnection = {
        frames,
        payloads,
        headers: response.headers,
        url,
        waitFor: (read, label) => waitFor(read, label),
        disconnect: async () => {
          await reader.cancel().catch(() => {})
        },
      }
      openConnections.push(connection)
      return connection
    },
  }

  // 卸载路径：afterEach 调这些 disposer（等价插件被卸载），保证模块级累计态不跨用例残留。
  unloaders.push(() => {
    for (const dispose of disposers.splice(0))
      dispose()
  })
  return host
}

/** 一段流式正文事件（逐 token 的 assistant/chunk）。 */
function chunk(seq: number) {
  return { type: 'assistant/chunk', seq, time: seq, data: { chunk: { type: 'text-delta', text: 'x' } } }
}

afterEach(async () => {
  restoreIntervalSpies()
  for (const connection of openConnections.splice(0))
    await connection.disconnect()
  for (const stop of openServers.splice(0))
    await stop()
  for (const unload of unloaders.splice(0))
    unload()
})

describe('pet host apply()', () => {
  it('会话流只声明 GET，POST 与 OPTIONS 返回原生 405 和 GET/HEAD 方法集合', async () => {
    const host = createHost()
    apply(host.ctx)
    expect(host.routes).toEqual([{ kind: 'exact', path: SESSION_STREAM_PATH }])

    const connection = await host.connect()
    for (const method of ['POST', 'OPTIONS']) {
      const rejected = await fetch(connection.url, { method })
      expect(rejected.status).toBe(405)
      expect(rejected.headers.get('allow')?.split(', ').sort()).toEqual(['GET', 'HEAD'])
    }
  })

  it('sSE 响应头与首帧：content-type 为 text/event-stream，首帧携带 retry: 1000', async () => {
    const host = createHost()
    apply(host.ctx)
    const connection = await host.connect()
    expect(connection.headers.get('content-type')).toContain('text/event-stream')

    const session = { id: 's1' }
    host.emitEvent(session, chunk(0))
    // retry 必须与**首帧数据**同帧（单独发会多出一条空 data 行，Rust 端按帧 JSON 解析会断流）。
    const first = await connection.waitFor(
      () => connection.frames.find(frame => frame.split('\n').some(line => line.startsWith('data: '))),
      '首帧数据',
    )
    expect(first.split('\n')).toContain(`retry: ${SSE_RETRY_MS}`)
    const payload = await connection.waitFor(() => connection.payloads[0], '首帧载荷')
    expect(payload.action).toBe('create')
    expect(payload.payload).toMatchObject({ id: 's1' })
  })

  it('无消费者（桌宠停用/隐藏）时不挂载监听，会话事件不触发任何工作', () => {
    const host = createHost()
    apply(host.ctx)
    expect(host.listenerCount('session/event')).toBe(0)
    expect(host.listenerCount('session/disposed')).toBe(0)

    host.emitEvent({ id: 's1' }, chunk(0))
    expect(host.titleLookups()).toBe(0)
  })

  it('首个消费者接入才挂载监听，标题折叠不随流式事件数增长', async () => {
    const host = createHost()
    apply(host.ctx)
    await host.connect()
    expect(host.listenerCount('session/event')).toBe(1)

    const session = { id: 's1' }
    for (let seq = 0; seq < 500; seq++)
      host.emitEvent(session, chunk(seq))
    expect(host.titleLookups()).toBe(1)

    // 另一个会话首次出现：再读一次；同会话后续事件不再触发。
    const other = { id: 's2' }
    host.emitEvent(other, { type: 'turn/start', seq: 0, time: 0, data: {} })
    for (let seq = 1; seq < 200; seq++)
      host.emitEvent(other, chunk(seq))
    expect(host.titleLookups()).toBe(2)
  })

  it('最后一个消费者断开后注销监听并丢弃状态，重新接入再折叠一次', async () => {
    const host = createHost()
    apply(host.ctx)
    const connection = await host.connect()
    const session = { id: 's1' }

    host.emitEvent(session, chunk(0))
    expect(host.titleLookups()).toBe(1)

    await connection.disconnect()
    await waitUntil(() => host.listenerCount('session/event') === 0, '断开后注销监听')
    expect(host.listenerCount('session/disposed')).toBe(0)
    expect(host.listenerCount('agent/assistant-stream')).toBe(0)

    // 断开期间的会话事件不再产生任何工作（也不读标题）。
    host.emitEvent(session, chunk(1))
    host.emitDisposed(session)
    expect(host.titleLookups()).toBe(1)

    // 重新接入：状态从零重建，标题重新折叠一次。
    await host.connect()
    host.emitEvent(session, chunk(2))
    expect(host.titleLookups()).toBe(2)
  })

  it('接入前已无其他消费者才宣告 state-lost；仍有消费者在流上时不得宣告（状态仍有效且不会重放）', async () => {
    const host = createHost()
    apply(host.ctx)
    const stateLost = `: ${SSE_STATE_LOST_COMMENT}`

    // 首个消费者：宿主累计态从零开始，上一轮气泡作废。
    const first = await host.connect()
    await first.waitFor(() => first.frames.find(frame => frame === stateLost), '首个消费者收到 state-lost')

    // 第二个消费者：宿主状态被 first 托着没有丢，因此绝不能再宣告作废，否则会误杀活气泡。
    const second = await host.connect()
    host.emitEvent({ id: 's1' }, chunk(0))
    await second.waitFor(() => second.payloads[0], '第二连接的数据帧')
    expect(second.frames).not.toContain(stateLost)

    // 全部断开后累计态被丢弃：下次接入必须重新宣告。
    await first.disconnect()
    await second.disconnect()
    await waitUntil(() => host.listenerCount('session/event') === 0, '全部断开后注销监听')

    const third = await host.connect()
    await third.waitFor(() => third.frames.find(frame => frame === stateLost), '重新接入再次收到 state-lost')
  })

  it('后续标题变化仍由 session/title 事件增量转发到 SSE', async () => {
    const host = createHost()
    apply(host.ctx)
    const connection = await host.connect()
    const session = { id: 's1' }

    host.emitEvent(session, { type: 'turn/start', seq: 0, time: 0, data: {} })
    host.emitEvent(session, { type: 'session/title', seq: 1, time: 1, data: { title: '新标题' } })

    const last = await connection.waitFor(
      () => connection.payloads.find(frame => frame.payload.title === '新标题'),
      '标题增量更新帧',
    )
    expect(last.action).toBe('update')
    expect(last.payload).toMatchObject({ id: 's1', title: '新标题', displayTitle: '新标题' })
    expect(host.titleLookups()).toBe(1)
  })

  it('活体助手流帧（agent/assistant-stream）折叠成 reasoning 展示态并下发（0.1.6 起流式增量不再是会话事件）', async () => {
    const host = createHost()
    apply(host.ctx)
    const connection = await host.connect()
    const session = { id: 's1' }

    expect(host.listenerCount('agent/assistant-stream')).toBe(1)
    host.emitEvent(session, { type: 'turn/start', seq: 0, time: 0, data: {} })
    host.emitAssistantStream(session, { type: 'reasoning-delta', index: 0, text: '正在想' })

    const frame = await connection.waitFor(
      () => connection.payloads.find(item => (item.payload.liveActivity as { kind?: string } | undefined)?.kind === 'reasoning'),
      'reasoning 活体帧',
    )
    expect(frame.action).toBe('update')
    expect(frame.payload).toMatchObject({ id: 's1', workStatus: 'thinking' })
    expect(frame.payload.liveActivity).toMatchObject({ kind: 'reasoning', text: '正在想' })
  })

  it('活动帧里的非流式增量（text-delta / 空 chunk）不逐 token 转发', async () => {
    const host = createHost()
    apply(host.ctx)
    const connection = await host.connect()
    const session = { id: 's1' }

    host.emitEvent(session, { type: 'turn/start', seq: 0, time: 0, data: {} })
    // 等 turn/start 的 update 帧真的被读到再取基线（帧到达是异步的）。
    await connection.waitFor(
      () => connection.payloads.find(item => item.payload.workStatus === 'thinking'),
      'turn/start 帧',
    )
    const before = connection.payloads.length
    host.emitAssistantStream(session, { type: 'text-delta', index: 0, text: '正文' })
    host.emitAssistantStream(session, { type: 'usage', usage: { totalTokens: 1 } })
    host.emitAssistantStream(session, undefined)
    host.emitAssistantStream(session, null)

    // 静默一小段时间确认没有新帧（正文只累积到 message，不逐 token 转发）。
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(connection.payloads.length).toBe(before)
  })

  it('心跳：接入即刷一帧注释，并按 SSE_KEEPALIVE_MS 周期续心跳、断开时清除', async () => {
    const host = createHost()
    apply(host.ctx)

    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    intervalSpyRestores.push(() => setIntervalSpy.mockRestore())
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
    intervalSpyRestores.push(() => clearIntervalSpy.mockRestore())

    try {
      const connection = await host.connect()

      // 接入帧：Node 的 writeHead 不会单独刷响应头，握手必须有一帧（注释帧，客户端可忽略）。
      const handshake = await connection.waitFor(
        () => connection.frames.find(frame => frame.startsWith(': ')),
        '接入心跳注释帧',
      )
      expect(handshake).toBe(': keepalive')

      // 心跳计时器按 15s 注册；手动触发一次等价于 15s 后触发，避免真实等待。
      const heartbeatIndex = setIntervalSpy.mock.calls.findIndex(([, ms]) => ms === SSE_KEEPALIVE_MS)
      expect(heartbeatIndex).toBeGreaterThanOrEqual(0)
      const handle = setIntervalSpy.mock.results[heartbeatIndex]?.value
      setIntervalSpy.mock.calls[heartbeatIndex]?.[0]()
      const tick = await connection.waitFor(
        () => connection.frames.filter(frame => frame === ': keepalive')[1],
        '周期心跳注释帧',
      )
      expect(tick).toBe(': keepalive')

      await connection.disconnect()
      await waitUntil(() => host.listenerCount('session/event') === 0, '断开后注销监听')
      expect(clearIntervalSpy.mock.calls.some(([value]) => value === handle)).toBe(true)
    }
    finally {
      restoreIntervalSpies()
    }
  })

  it('有 title 投影时只走 O(新事件) 的 stateOf，不做全量折叠', async () => {
    const host = createHost({ projections: true })
    apply(host.ctx)
    const connection = await host.connect()
    const session: { id: string, title: string } = { id: 's1', title: '投影标题' }

    for (let seq = 0; seq < 200; seq++)
      host.emitEvent(session, chunk(seq))

    // 投影路径：sessionTitle.get() 一次都不该被调用。
    expect(host.titleLookups()).toBe(0)
    const create = await connection.waitFor(
      () => connection.payloads.find(frame => frame.action === 'create'),
      'create 帧',
    )
    expect(create.payload).toMatchObject({ id: 's1', title: '投影标题' })

    // 标题在外部变化后，下一次事件即带上新值（无需 session/title 事件）。
    session.title = '改名后'
    host.emitEvent(session, { type: 'turn/start', seq: 200, time: 200, data: {} })
    const renamed = await connection.waitFor(
      () => connection.payloads.find(frame => frame.payload.title === '改名后'),
      '改名后的 update 帧',
    )
    expect(renamed.payload).toMatchObject({ id: 's1', title: '改名后' })
  })
})
