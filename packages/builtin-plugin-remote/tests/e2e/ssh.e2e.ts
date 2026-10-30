import type { RemoteSession, RemoteStreamHandle } from '../../src/host/types/index'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, relative } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sshTransport } from '../../src/host/service/transport.ssh'
import { MachineId } from '../../src/host/types/index'

interface ManualSshFixture {
  host: string
  port: number
  user: string
  remotePort: number
  hostKeySha256: string
  privateKey?: string
  password?: string
  token?: string
}

function loadManualSshFixture(): ManualSshFixture {
  if (!process.env.DSH_E2E_INTEGRATIONS?.split(',').includes('ssh'))
    throw new Error('请通过 DSH_E2E_INTEGRATIONS=ssh 显式选择人工外部集成。')
  if (process.env.CI || process.env.GITHUB_ACTIONS)
    throw new Error('人工外部集成禁止在 CI 运行。')
  const configured = process.env.DSH_E2E_SSH_FIXTURE
  if (!configured || !isAbsolute(configured))
    throw new Error('DSH_E2E_SSH_FIXTURE 必须指向系统 Temp/dsh-e2e-ssh-*/fixture.json；不使用用户 SSH 配置。')
  const file = realpathSync(configured)
  const root = dirname(file)
  const temp = realpathSync(tmpdir())
  if (dirname(root) !== temp || !basename(root).startsWith('dsh-e2e-ssh-') || basename(file) !== 'fixture.json')
    throw new Error('SSH fixture 必须位于独占的系统 Temp/dsh-e2e-ssh-* 根内。')
  const within = relative(root, file)
  if (isAbsolute(within) || within.startsWith('..'))
    throw new Error('SSH fixture 不得越出独占根。')
  const fixture: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!fixture || typeof fixture !== 'object')
    throw new Error('SSH fixture 必须是对象。')
  const value = fixture as Record<string, unknown>
  if (typeof value.host !== 'string' || isIP(value.host) === 0
    || typeof value.user !== 'string' || !/^[\w.-]+$/u.test(value.user)
    || ![value.port, value.remotePort].every(port => typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535)
    || typeof value.hostKeySha256 !== 'string' || !/^[A-Za-z0-9+/]{43}=?$/u.test(value.hostKeySha256)
    || ![value.privateKey, value.password].some(secret => typeof secret === 'string' && secret.length > 0)
    || [value.privateKey, value.password, value.token].some(secret => secret !== undefined && typeof secret !== 'string')) {
    throw new Error('SSH fixture 需要 IP、用户名、合法端口、SHA-256 主机指纹及显式测试凭据。')
  }
  return value as unknown as ManualSshFixture
}

const fixture = loadManualSshFixture()

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('人工 SSH 集成：专用远程 dsh 与真实转发', () => {
  it('只连接显式测试凭据，真实读取 dsh 页面并重连到原本地转发端口', async () => {
    vi.stubEnv('SSH_AUTH_SOCK', undefined)
    const profile = {
      id: MachineId('manual-ssh'),
      name: 'manual-ssh',
      host: fixture.host,
      port: fixture.port,
      user: fixture.user,
      remotePort: fixture.remotePort,
    }
    const sessions: RemoteSession[] = []
    const streams: RemoteStreamHandle[] = []
    const connect = async () => {
      const session = await sshTransport.connect(profile, (_label, key) => createHash('sha256').update(key).digest('base64').replace(/=+$/u, '') === fixture.hostKeySha256.replace(/=+$/u, ''), {
        readyTimeoutMs: 30_000,
        resolveProfile: async () => ({
          host: fixture.host,
          port: fixture.port,
          username: fixture.user,
          keys: fixture.privateKey ? [{ privateKey: fixture.privateKey }] : [],
          proxyJump: [],
          ...(fixture.password ? { password: fixture.password } : {}),
        }),
      })
      sessions.push(session)
      return session
    }
    try {
      const session = await connect()
      const first = await session.stream(fixture.remotePort)
      streams.push(first)
      const origin = `http://127.0.0.1:${first.localPort}`
      let cookie = ''
      if (fixture.token) {
        const exchange = await fetch(`${origin}/?token=${encodeURIComponent(fixture.token)}`, { redirect: 'manual', signal: AbortSignal.timeout(30_000) })
        expect(exchange.status, '显式测试 token 必须被真实 dsh 交换为会话').toBe(303)
        cookie = exchange.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
        expect(cookie, '真实核心必须签发会话 Cookie').not.toBe('')
      }
      const response = await fetch(origin, { headers: { cookie }, signal: AbortSignal.timeout(30_000) })
      expect(response.status, '专用远程 dsh 必须真实提供页面，不接受 Python HTTP 替代').toBe(200)
      expect(await response.text(), '页面必须包含真实 dsh 启动数据').toContain('__DSH_BOOT__')
      await first.close()
      await session.close()
      const again = await (await connect()).stream(fixture.remotePort, first.localPort)
      streams.push(again)
      expect(again.localPort, '重连必须复用原本地转发端口').toBe(first.localPort)
      const restored = await fetch(origin, { headers: { cookie }, signal: AbortSignal.timeout(30_000) })
      expect(restored.status, '同一转发地址必须在重连后恢复真实页面').toBe(200)
      expect(await restored.text(), '重连后仍必须是真实 dsh 页面').toContain('__DSH_BOOT__')
    }
    finally {
      await Promise.all(streams.map(stream => stream.close()))
      await Promise.all(sessions.map(session => session.close()))
    }
  })
})
