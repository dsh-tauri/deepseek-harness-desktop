import type { RemoteAuthPolicy, RemoteHostContext } from '../types/index'
import type { TunnelHandlers, TunnelProcess } from './tunnel.types'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCurrentHostInstance, setTunnelDeps } from '../config/runtime'
import { defaultAccessDocument, readAccessDocument, writeAccessDocument } from './access.utils'
import { gateway } from './gateway'
import { tunnel } from './tunnel'

const HOST_PORT = 45_678

const POLICY: RemoteAuthPolicy = { enabled: true, scope: 'public_only', linkToken: 'link-token', sessionSecret: 'session-secret' }

interface Spawned {
  env?: NodeJS.ProcessEnv
  binary: string
  args: string[]
  handlers: TunnelHandlers
  kills: NodeJS.Signals[]
  crash: (code: number | null) => void
}

const homes: string[] = []

let previousHome: string | undefined

let previousPort: string | undefined

let spawned: Spawned[] = []

function hostContext(): RemoteHostContext {
  return {
    webServer: { register: () => () => {}, port: HOST_PORT },
    effect: () => {},
    connection: { authenticatedUrl: (base: string) => `${base}?token=launch-token` },
  } as unknown as RemoteHostContext
}

function stubSpawn(binary: string, args: string[], handlers: TunnelHandlers, env?: NodeJS.ProcessEnv): TunnelProcess {
  let settle: () => void = () => {}
  const record: Spawned = {
    binary,
    args,
    env,
    handlers,
    kills: [],
    crash: (code) => {
      handlers.onExit(code, null)
      settle()
    },
  }
  spawned.push(record)
  return {
    pid: 4242,
    exited: new Promise<void>((resolve) => {
      settle = resolve
    }),
    kill: (signal) => {
      record.kills.push(signal)
      handlers.onExit(null, signal)
      settle()
    },
  }
}

beforeEach(() => {
  previousHome = process.env.DSH_HOME
  previousPort = process.env.DSH_WEB_PORT
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-remote-tunnel-'))
  homes.push(process.env.DSH_HOME)
  spawned = []
  setCurrentHostInstance(hostContext())
  setTunnelDeps({
    policy: () => POLICY,
    resolveBinary: async () => '/stub/cloudflared',
    spawn: stubSpawn,
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await tunnel.dispose()
  await gateway.dispose()
  setCurrentHostInstance(undefined)
  if (previousHome === undefined)
    delete process.env.DSH_HOME
  else
    process.env.DSH_HOME = previousHome
  if (previousPort === undefined)
    delete process.env.DSH_WEB_PORT
  else
    process.env.DSH_WEB_PORT = previousPort
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true })
})

describe('tunnel 生命周期', () => {
  it('quick 模式：入口按 tunnel 类型监听回环，解析到 trycloudflare 域名后进入 running 并落盘 hostname', async () => {
    await tunnel.start('quick')
    const entry = gateway.status('tunnel')
    expect(entry?.kind).toBe('tunnel')
    expect(entry?.host).toBe('127.0.0.1')
    expect(entry?.upstream).toBe(`http://127.0.0.1:${HOST_PORT}`)
    expect(spawned).toHaveLength(1)
    expect(spawned[0]?.binary).toBe('/stub/cloudflared')
    expect(spawned[0]?.args).toEqual(['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${entry?.port}`])

    const starting = await tunnel.status()
    expect(starting.state).toBe('starting')
    expect(starting.mode).toBe('quick')
    expect(starting.port).toBe(entry?.port)
    expect(starting.url).toBeUndefined()

    spawned[0]?.handlers.onLine('2026-10-06T00:00:00Z INF Your quick Tunnel has been created! Visit it at https://bold-fox-abc.trycloudflare.com')
    const running = await tunnel.status()
    expect(running.state).toBe('running')
    expect(running.url).toBe('https://bold-fox-abc.trycloudflare.com')
    expect(running.hostname).toBe('bold-fox-abc.trycloudflare.com')
    expect(readAccessDocument().document.tunnel).toEqual({ enabled: true, mode: 'quick', token: null, hostname: 'bold-fox-abc.trycloudflare.com' })
    expect(running.events.some(event => event.kind === 'process' && event.line.includes('trycloudflare'))).toBe(true)
  })

  it('token 模式：用具名凭据启动并以配置的公开主机名作为链接', async () => {
    await tunnel.start('token', 'cf-token', 'dsh.example.com')
    expect(spawned[0]?.args).toEqual(['tunnel', '--no-autoupdate', 'run'])
    expect(spawned[0]?.args.join(' '), '凭据不得出现在进程参数里').not.toContain('cf-token')
    expect(spawned[0]?.env).toEqual({ TUNNEL_TOKEN: 'cf-token' })
    const status = await tunnel.status()
    expect(status.state).toBe('running')
    expect(status.url).toBe('https://dsh.example.com')
    expect(status.token).toBe('cf-token')
    expect(readAccessDocument().document.tunnel).toEqual({ enabled: true, mode: 'token', token: 'cf-token', hostname: 'dsh.example.com' })
  })

  it('并发 start/stop 串行化：最终只留一次启动，进程被回收', async () => {
    const starting = tunnel.start('quick')
    const stopping = tunnel.stop()
    await Promise.all([starting, stopping])
    expect(spawned).toHaveLength(1)
    expect(spawned[0]?.kills).toContain('SIGTERM')
    const status = await tunnel.status()
    expect(status.state).toBe('stopped')
    expect(status.enabled).toBe(false)
  })

  it('access.json 损坏时拿到域名不抛错：落为可读失败而不是未捕获异常', async () => {
    await tunnel.start('quick')
    writeAccessDocument({ ...defaultAccessDocument(), tunnel: { enabled: true, mode: 'quick', token: null, hostname: null } })
    // 直接把档案写坏，模拟 cloudflared 输出域名时磁盘上的配置已不可解析
    writeFileSync(join(process.env.DSH_HOME ?? '', 'remote', 'access.json'), '{ not json')
    expect(() => {
      spawned[0]?.handlers.onLine('INF Your quick Tunnel has been created! Visit it at https://bold-fox-abc.trycloudflare.com')
    }).not.toThrow()
    await vi.waitFor(async () => {
      expect((await tunnel.status()).state).toBe('error')
    })
    expect((await tunnel.status()).error).toContain('落盘')
  })

  it.each(['落盘失败', '进程退出'])('%s 后重启必须等旧入口回收，不能被旧清理覆盖状态', async (cause) => {
    await tunnel.start('quick')
    const originalStop = gateway.stop
    const originalStart = gateway.start
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered = false
    let completed = false
    const cleanup = vi.spyOn(gateway, 'stop').mockImplementationOnce(async (id) => {
      await originalStop(id)
      entered = true
      await gate
      completed = true
    })
    try {
      if (cause === '落盘失败') {
        writeFileSync(join(process.env.DSH_HOME ?? '', 'remote', 'access.json'), '{ broken')
        spawned[0]!.handlers.onLine('INF Your quick Tunnel has been created! Visit it at https://bold-fox-abc.trycloudflare.com')
      }
      else {
        spawned[0]!.crash(1)
      }
      await vi.waitFor(() => expect(entered).toBe(true))
      expect((await tunnel.status()).state).toBe('error')
      writeAccessDocument(defaultAccessDocument())
      const order: boolean[] = []
      vi.spyOn(gateway, 'start').mockImplementationOnce(async (options) => {
        order.push(completed)
        release()
        return await originalStart(options)
      })
      const restarting = tunnel.start('quick')
      setImmediate(release)
      await restarting
      await cleanup.mock.results[0]!.value
      expect(order).toEqual([true])
      const status = await tunnel.status()
      expect(status.state).toBe('starting')
      expect(status.port).toBe(gateway.status('tunnel')?.port)
      expect(spawned).toHaveLength(2)
    }
    finally {
      release()
    }
  })

  it('token 模式缺凭据或主机名时拒绝启动，且不落盘、不装入口、不起进程', async () => {
    await expect(tunnel.start('token')).rejects.toThrowError('Tunnel Token')
    await expect(tunnel.start('token', 'cf-token')).rejects.toThrowError('公开主机名')
    expect(spawned).toHaveLength(0)
    expect(gateway.status('tunnel')).toBeUndefined()
    expect(readAccessDocument().document.tunnel.enabled).toBe(false)
  })

  it('stop：回收进程与入口，配置保留但 enabled 落为 false', async () => {
    await tunnel.start('quick')
    await tunnel.stop()
    expect(spawned[0]?.kills).toEqual(['SIGTERM'])
    expect(gateway.status('tunnel')?.state).toBe('stopped')
    expect(gateway.status('tunnel')?.port).toBe(0)
    const status = await tunnel.status()
    expect(status.state).toBe('stopped')
    expect(status.url).toBeUndefined()
    expect(status.port).toBeUndefined()
    expect(readAccessDocument().document.tunnel).toEqual({ enabled: false, mode: 'quick', token: null, hostname: null })
  })

  it('cloudflared 异常退出：进入 error、入口回收、原因可读（不自动重启）', async () => {
    await tunnel.start('quick')
    spawned[0]?.crash(1)
    const status = await tunnel.status()
    expect(status.state).toBe('error')
    expect(status.error).toContain('cloudflared 已退出')
    await vi.waitFor(() => {
      expect(gateway.status('tunnel')?.state).toBe('stopped')
    })
    expect(spawned).toHaveLength(1)
    expect(readAccessDocument().document.tunnel.enabled).toBe(true)
  })

  it('restore：按落盘的 enabled 配置自动启动', async () => {
    writeAccessDocument({ ...defaultAccessDocument(), tunnel: { enabled: true, mode: 'quick', token: null, hostname: null } })
    await tunnel.restore()
    expect((await tunnel.status()).state).toBe('starting')
    expect(spawned).toHaveLength(1)
  })

  it('access.json 损坏时拒绝写入隧道配置，避免覆盖待修复的文件', async () => {
    const file = join(process.env.DSH_HOME ?? '', 'remote', 'access.json')
    mkdirSync(join(process.env.DSH_HOME ?? '', 'remote'), { recursive: true })
    writeFileSync(file, '{ broken')
    await expect(tunnel.start('quick')).rejects.toThrowError('access.json 解析失败')
    expect(spawned).toHaveLength(0)
  })

  it('上游端口取宿主 webserver 的实监听端口，而不是进程环境变量', async () => {
    process.env.DSH_WEB_PORT = '1'
    await tunnel.start('quick')
    expect(gateway.status('tunnel')?.upstream).toBe(`http://127.0.0.1:${HOST_PORT}`)
  })

  it('缺少可用本机端口时不装入口，并给出可读原因', async () => {
    setCurrentHostInstance({ webServer: { register: () => () => {} }, effect: () => {} } as unknown as RemoteHostContext)
    delete process.env.DSH_WEB_PORT
    await tunnel.start('quick')
    const status = await tunnel.status()
    expect(status.state).toBe('error')
    expect(status.error).toContain('无法确定本机 DSH 端口')
    expect(gateway.status('tunnel')).toBeUndefined()
    expect(spawned).toHaveLength(0)
  })
})
