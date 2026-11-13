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
}))

vi.mock('dsh-tauri', () => ({ defineService: <T>(service: T): T => service }))
vi.mock('../config/runtime', () => ({
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

let handlers: TunnelHandlers | undefined
let settle: (() => void) | undefined

function fakeProcess(_binary: string, _args: string[], next: TunnelHandlers): TunnelProcess {
  handlers = next
  const exited = new Promise<void>((resolve) => {
    settle = resolve
  })
  return {
    pid: 4242,
    exited,
    kill: (): void => {
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
