import type { RemoteAccessDocument } from './access.types'
import type { TunnelDeps, TunnelHandlers, TunnelProcess } from './tunnel.types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({
  document: undefined as unknown as RemoteAccessDocument,
  start: vi.fn<(options: { id: string, port: number }) => Promise<{ port: number }>>(),
  stop: vi.fn<(id: string) => Promise<void>>(),
  status: vi.fn<(id: string) => { state: 'listening' | 'stopped', port: number } | undefined>(),
  resolveBinary: vi.fn<() => Promise<string>>(),
  spawn: vi.fn<(binary: string, args: string[], handlers: TunnelHandlers) => TunnelProcess>(),
  probe: vi.fn<(address: string, timeoutMs: number) => Promise<{ healthy: boolean, reason?: string }>>(),
}))

vi.mock('dsh-tauri', () => ({ defineService: <T>(service: T): T => service }))
vi.mock('../utils/cloudflared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/cloudflared')>()
  return { ...actual, probeCloudflaredReady: host.probe }
})
vi.mock('../config/runtime', () => ({
  harnessHome: () => '/tmp/dsh-home',
  localUpstream: () => 'http://127.0.0.1:3080',
  mintAuthenticatedUrl: async () => undefined,
  tunnelRuntimeDeps: (): TunnelDeps => ({
    policy: () => ({ enabled: true, scope: 'all', linkToken: null, sessionSecret: 'secret' }),
    resolveBinary: host.resolveBinary,
    spawn: host.spawn,
  }),
}))
vi.mock('./gateway', () => ({ gateway: { start: host.start, stop: host.stop, status: host.status } }))
vi.mock('./access.utils', () => ({
  readAccessDocument: () => ({ document: host.document, corrupt: false, warnings: [] }),
  writeAccessDocument: (next: RemoteAccessDocument) => {
    host.document = next
  },
}))

const ENTRY_PORT = 3089
const QUICK_LINE = 'INF |  https://random-words-here.trycloudflare.com  |'
const METRICS_LINE = 'INF Starting metrics server on 127.0.0.1:41143/metrics'
const PROBE_INTERVAL_MS = 30_000

let handlers: TunnelHandlers | undefined
let settle: (() => void) | undefined
let signals: NodeJS.Signals[] = []

function fakeProcess(_binary: string, _args: string[], next: TunnelHandlers): TunnelProcess {
  handlers = next
  const exited = new Promise<void>((resolve) => {
    settle = resolve
  })
  return {
    pid: 4242,
    exited,
    kill: (signal): void => {
      signals.push(signal)
      settle?.()
    },
  }
}

function crash(): void {
  settle?.()
  settle = undefined
  handlers?.onExit(1, null)
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
  await Promise.resolve()
  await Promise.resolve()
  await vi.advanceTimersByTimeAsync(0)
}

async function startRunning(tunnel: { start: (mode: 'quick') => Promise<void> }): Promise<void> {
  await tunnel.start('quick')
  handlers?.onLine(QUICK_LINE)
  await flush()
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.clearAllMocks()
  handlers = undefined
  settle = undefined
  signals = []
  host.probe.mockReset()
  host.probe.mockResolvedValue({ healthy: true })
  host.document = {
    version: 1,
    enabled: true,
    listen: { address: '127.0.0.1', port: 3088 },
    auth: { enabled: true, token: null, scope: 'all' },
    tunnel: { enabled: true, mode: 'quick', token: null, hostname: null },
  }
  host.resolveBinary.mockResolvedValue('/bin/cloudflared')
  host.spawn.mockImplementation(fakeProcess)
  host.start.mockImplementation(async () => ({ port: ENTRY_PORT }))
  host.stop.mockResolvedValue(undefined)
  host.status.mockReturnValue(undefined)
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('cloudflared 异常退出后的自愈', () => {
  it('异常退出后不拆掉本地网关入口，并按 1 秒退避复用同一端口重建隧道', async () => {
    const { tunnel } = await import('./tunnel')
    await startRunning(tunnel)
    expect((await tunnel.status()).state).toBe('running')
    host.stop.mockClear()
    host.status.mockReturnValue({ state: 'listening', port: ENTRY_PORT })

    crash()
    await flush()

    expect((await tunnel.status()).state).toBe('starting')
    expect(host.stop).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(999)
    expect(host.spawn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await flush()

    expect(host.spawn).toHaveBeenCalledTimes(2)
    expect(host.spawn.mock.calls[1]?.[1]).toEqual([
      'tunnel',
      '--no-autoupdate',
      '--protocol',
      'http2',
      '--url',
      `http://127.0.0.1:${ENTRY_PORT}`,
    ])
    expect(host.start).toHaveBeenCalledTimes(1)
    expect(host.stop).not.toHaveBeenCalled()
  })

  it('重建成功后再次异常退出，退避间隔翻倍', async () => {
    const { tunnel } = await import('./tunnel')
    await startRunning(tunnel)
    host.status.mockReturnValue({ state: 'listening', port: ENTRY_PORT })

    crash()
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    expect(host.spawn).toHaveBeenCalledTimes(2)

    crash()
    await vi.advanceTimersByTimeAsync(1_999)
    expect(host.spawn).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    await flush()

    expect(host.spawn).toHaveBeenCalledTimes(3)
  })

  it('重试耗尽后进入 error，保留可读原因并停掉网关入口', async () => {
    const { tunnel } = await import('./tunnel')
    await startRunning(tunnel)
    host.status.mockReturnValue({ state: 'listening', port: ENTRY_PORT })
    host.stop.mockClear()

    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000]) {
      crash()
      await vi.advanceTimersByTimeAsync(delay)
      await flush()
    }
    expect(host.spawn).toHaveBeenCalledTimes(6)

    crash()
    await flush()

    const status = await tunnel.status()
    expect(status.state).toBe('error')
    expect(status.error).toMatch(/cloudflared 已退出/)
    expect(status.error).toMatch(/已自动重建 5 次/)
    expect(status.events.some(event => event.line.includes('已自动重建 5 次'))).toBe(true)
    expect(host.stop).toHaveBeenCalledWith('tunnel')
  })

  it('隧道恢复就绪后退避重新从 1 秒算起', async () => {
    const { tunnel } = await import('./tunnel')
    await startRunning(tunnel)
    host.status.mockReturnValue({ state: 'listening', port: ENTRY_PORT })

    crash()
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    expect(host.spawn).toHaveBeenCalledTimes(2)

    handlers?.onLine(QUICK_LINE)
    await flush()
    expect((await tunnel.status()).state).toBe('running')

    crash()
    await vi.advanceTimersByTimeAsync(999)
    expect(host.spawn).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    await flush()

    expect(host.spawn).toHaveBeenCalledTimes(3)
  })

  it('具名隧道在连接建立前不算就绪，退避计数不会因进程重启而被清零', async () => {
    host.document = {
      ...host.document,
      tunnel: { enabled: true, mode: 'token', token: 'secret-token', hostname: 'dsh.example.com' },
    }
    const { tunnel } = await import('./tunnel')
    await tunnel.start('token', 'secret-token', 'dsh.example.com')
    await flush()

    expect(host.spawn).toHaveBeenCalledTimes(1)
    const status = await tunnel.status()
    expect(status.state).toBe('starting')
    expect(status.url).toBeUndefined()

    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000]) {
      crash()
      await vi.advanceTimersByTimeAsync(delay)
      await flush()
    }
    expect(host.spawn).toHaveBeenCalledTimes(6)

    crash()
    await flush()
    expect((await tunnel.status()).state).toBe('error')
  })

  it('进程退出后迟到的就绪日志不会把状态改回运行中', async () => {
    const { tunnel } = await import('./tunnel')
    await startRunning(tunnel)
    host.status.mockReturnValue({ state: 'listening', port: ENTRY_PORT })

    crash()
    await flush()
    expect((await tunnel.status()).state).toBe('starting')

    handlers?.onLine(QUICK_LINE)
    await flush()

    const status = await tunnel.status()
    expect(status.state).toBe('starting')
    expect(status.url).toBeUndefined()
  })

  it('用户显式 stop 打断等待中的重试', async () => {
    const { tunnel } = await import('./tunnel')
    await startRunning(tunnel)
    host.status.mockReturnValue({ state: 'listening', port: ENTRY_PORT })

    crash()
    await flush()
    expect((await tunnel.status()).state).toBe('starting')

    await tunnel.stop()
    host.spawn.mockClear()
    await vi.advanceTimersByTimeAsync(20_000)
    await flush()

    expect(host.spawn).not.toHaveBeenCalled()
    const status = await tunnel.status()
    expect(status.state).toBe('stopped')
    expect(status.error).toBeUndefined()
  })
})

describe('cloudflared 假死探针', () => {
  async function startProbed(tunnel: { start: (mode: 'quick') => Promise<void> }): Promise<void> {
    await startRunning(tunnel)
    handlers?.onLine(METRICS_LINE)
    await flush()
  }

  async function failProbe(times: number): Promise<void> {
    host.probe.mockResolvedValue({ healthy: false, reason: 'HTTP 503' })
    for (let index = 0; index < times; index += 1) {
      await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS)
      await flush()
    }
  }

  it('连续 3 次探活失败降级为启动中，恢复后回到运行中', async () => {
    const { tunnel } = await import('./tunnel')
    await startProbed(tunnel)
    expect((await tunnel.status()).state).toBe('running')

    await failProbe(2)
    expect((await tunnel.status()).state).toBe('running')

    await failProbe(1)
    const degraded = await tunnel.status()
    expect(degraded.state).toBe('starting')
    expect(degraded.events.some(event => event.line.includes('健康探活连续 3 次失败'))).toBe(true)

    host.probe.mockResolvedValue({ healthy: true })
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS)
    await flush()

    const recovered = await tunnel.status()
    expect(recovered.state).toBe('running')
    expect(recovered.events.some(event => event.line.includes('已自行恢复'))).toBe(true)
    expect(signals).toEqual([])
  })

  it('连续 10 次探活失败判定假死并终止进程触发重建', async () => {
    const { tunnel } = await import('./tunnel')
    await startProbed(tunnel)
    host.status.mockReturnValue({ state: 'listening', port: ENTRY_PORT })

    await failProbe(9)
    expect(signals).toEqual([])

    await failProbe(1)
    expect(signals).toEqual(['SIGTERM'])
    expect((await tunnel.status()).events.some(event => event.line.includes('判定连接器假死'))).toBe(true)
  })

  it('假死触发的重建链路不进入终态，网络恢复后仍会自愈', async () => {
    const { tunnel } = await import('./tunnel')
    await startProbed(tunnel)
    host.status.mockReturnValue({ state: 'listening', port: ENTRY_PORT })

    await failProbe(10)
    expect(signals).toEqual(['SIGTERM'])

    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 16_000]) {
      crash()
      await vi.advanceTimersByTimeAsync(delay)
      await flush()
    }

    const status = await tunnel.status()
    expect(status.state).toBe('starting')
    expect(status.error).toBeUndefined()
    expect(status.events.some(event => event.line.includes('判定假死后的重建不设上限'))).toBe(true)
  })

  it('未识别到 metrics 地址时不启动探活，也不会误杀进程', async () => {
    const { tunnel } = await import('./tunnel')
    await startRunning(tunnel)

    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS * 12)
    await flush()

    expect(host.probe).not.toHaveBeenCalled()
    expect(signals).toEqual([])
    expect((await tunnel.status()).state).toBe('running')
  })
})
