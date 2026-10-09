/**
 * 批次 11 · `dsh-tauri` 的桌面载体鉴权适配（契约见 `docs/specs/plugin.test.md`）。
 *
 * 该适配是全仓唯一的网络安全边界：当且仅当子进程带 `DSH_TAURI_EMBEDDED=1` 时，它在
 * `connection` 服务上把 401 降级为放行、把索引放行；其余取值下 `attach()` 返回 noop，鉴权完全不变。
 *
 * 三条用例都必须控制该环境变量，因此各自自带 scratch 宿主。这里不用 `support/dsh.ts` 的
 * `startDshHost`：它在返回宿主前先做根路径 token 交换，而该交换在注入态被鉴权适配放行成 200
 * （没有 303 + Set-Cookie），会把「被测行为」当成启动失败抛掉。自带编排只做脚手架与就绪等待，
 * 复用 `scaffoldDshProfile` / `resolveDshCommand` / `resolveNodeBin` 与 `REPO_ROOT`，不起第二个共享宿主。
 */

import type { ChildProcess } from 'node:child_process'
import type { WriteStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { createWriteStream, readFileSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import process from 'node:process'
import { finished } from 'node:stream/promises'
import { describe, expect, it } from 'vitest'
import { resolveDshCommand, resolveNodeBin, scaffoldDshProfile } from '../support/dsh'

const EMBEDDED_ENV = 'DSH_TAURI_EMBEDDED'

/** 产品可见的 `/api/**` 路由，用于把「401 被降级」与「路由缺失」区分开。 */
const PET_STREAM_PATH = '/api/tauri/pet/session/stream'

/** 仓库内不存在的插件 id：注入态下它证明请求已越过鉴权层落到路由层。 */
const UNMOUNTED_PATH = '/api/tauri/unmounted-probe/ping'

const READY_RE = /http:\/\/127\.0\.0\.1:\d\S*/
const READY_TIMEOUT_MS = 90_000

interface GateHost {
  baseUrl: string
  url: string
  home: string
  logPath: string
  stop: () => Promise<void>
}

function log(message: string): void {
  process.stderr.write(`[gate-host] ${message}\n`)
}

async function killTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null)
    return

  if (process.platform === 'win32') {
    await new Promise<void>((resolvePromise) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.on('close', () => resolvePromise())
      killer.on('error', () => resolvePromise())
    })
    return
  }

  child.kill('SIGTERM')
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1_500))
  if (child.exitCode === null)
    child.kill('SIGKILL')
}

function readLog(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  }
  catch {
    return ''
  }
}

function tailOf(logPath: string): string {
  return readLog(logPath).split('\n').slice(-20).join('\n')
}

async function waitForReady(child: ChildProcess, logPath: string): Promise<string> {
  const deadline = Date.now() + READY_TIMEOUT_MS

  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`dsh web 提前退出（code ${child.exitCode}）；日志：${logPath}\n${tailOf(logPath)}`)

    const match = READY_RE.exec(readLog(logPath))
    if (match !== null)
      return match[0]

    await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
  }

  throw new Error(`等待 dsh web 就绪超时（${READY_TIMEOUT_MS}ms）；日志：${logPath}\n${tailOf(logPath)}`)
}

async function startGateHost(): Promise<GateHost> {
  const profile = await scaffoldDshProfile({
    plugin: 'dsh-tauri',
    also: ['dsh-tauri-pet'],
  })
  const logPath = join(profile.home, 'dsh-web.log')
  const logStream: WriteStream = createWriteStream(logPath, { flags: 'a' })
  const [dshBin] = resolveDshCommand()
  const args = [dshBin, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open']

  log(`🚀 挂载 [${basename(profile.home)}] carrier=${process.env[EMBEDDED_ENV] ?? '(unset)'}`)

  const child = spawn(resolveNodeBin(), args, {
    cwd: profile.profileDir,
    env: { ...process.env, DSH_HOME: profile.home },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  child.stdout?.pipe(logStream, { end: false })
  child.stderr?.pipe(logStream, { end: false })

  const home = profile.home
  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped)
      return
    stopped = true
    await killTree(child)
    child.stdout?.unpipe(logStream)
    child.stderr?.unpipe(logStream)
    logStream.end()
    await finished(logStream).catch(() => {})
    rmSync(home, { recursive: true, force: true })
  }

  try {
    const url = await waitForReady(child, logPath)
    const baseUrl = new URL(url).origin
    log(`✅ 就绪 [${baseUrl}] carrier=${process.env[EMBEDDED_ENV] ?? '(unset)'}`)
    return { baseUrl, url, home, logPath, stop }
  }
  catch (error) {
    await stop()
    throw error
  }
}

function withCarrier(value: string | undefined, body: () => Promise<void>): Promise<void> {
  const previous = process.env[EMBEDDED_ENV]
  if (value === undefined)
    delete process.env[EMBEDDED_ENV]
  else
    process.env[EMBEDDED_ENV] = value

  return body().finally(() => {
    if (previous === undefined)
      delete process.env[EMBEDDED_ENV]
    else
      process.env[EMBEDDED_ENV] = previous
  })
}

describe('桌面载体鉴权适配：非注入态不接管', () => {
  it('验证未注入 DSH_TAURI_EMBEDDED 时索引与 /api 仍按浏览器会话拒绝', async () => {
    await withCarrier(undefined, async () => {
      const host = await startGateHost()
      try {
        const index = await fetch(`${host.baseUrl}/`)
        expect(index.status, '未接管时不带 Cookie 的索引必须 401').toBe(401)

        const launch = await fetch(host.url, { redirect: 'manual' })
        expect(launch.status, '未接管时根路径 token 交换仍必须 303').toBe(303)
        expect(
          launch.headers.get('set-cookie') ?? '',
          '未接管时 token 交换必须下发会话 Cookie',
        ).not.toBe('')

        const api = await fetch(`${host.baseUrl}${PET_STREAM_PATH}`)
        expect(api.status, '未接管时 /api 必须仍然 401').toBe(401)
        const body = await api.json() as { error?: string }
        expect(body.error, '拒绝理由必须来自连接门').toBe('unauthorized')

        const unmounted = await fetch(`${host.baseUrl}${UNMOUNTED_PATH}`)
        expect(
          unmounted.status,
          '拒绝发生在路由之前：未挂载路径也是 401 而不是 404',
        ).toBe(401)
      }
      finally {
        await host.stop()
      }
    })
  })
})

describe('桌面载体鉴权适配：注入态接管', () => {
  it('验证注入 DSH_TAURI_EMBEDDED=1 时索引与 /api 的鉴权被放行', async () => {
    await withCarrier('1', async () => {
      const host = await startGateHost()
      try {
        const index = await fetch(`${host.baseUrl}/`)
        expect(
          index.status,
          'authorizeIndex 被改写为 () => true：索引不再是被拒的 401，而是直接返回页面',
        ).toBe(200)
        expect((await index.text()).length, '放行的索引必须是真实页面而不是空响应').toBeGreaterThan(0)

        const launch = await fetch(host.url, { redirect: 'manual' })
        expect(
          launch.status,
          '索引放行后根路径 token 交换不再回 303，这是「索引无条件放行」的同一证据面',
        ).not.toBe(303)

        const unmounted = await fetch(`${host.baseUrl}${UNMOUNTED_PATH}`)
        expect(
          unmounted.status,
          '原实现返回 401 已被降级为放行：未挂载路径落到路由层后是 404，而不是 401',
        ).toBe(404)
        expect(unmounted.status, '不得再出现会话拒绝').not.toBe(401)

        const pet = await fetch(`${host.baseUrl}${PET_STREAM_PATH}`)
        expect(pet.status, '已挂载插件的 /api 也不得再被 401 拦住').not.toBe(401)
        expect(pet.status, '注入态下请求必须落到路由层').toBeLessThan(500)

        const crossOrigin = await fetch(`${host.baseUrl}${UNMOUNTED_PATH}`, {
          headers: { origin: 'http://evil.example' },
        })
        expect(
          crossOrigin.status,
          '只降级 401：Host/Origin 围栏的 403 必须原样保留',
        ).toBe(403)
      }
      finally {
        await host.stop()
      }
    })
  })
})

describe('桌面载体鉴权适配：载体标记严格判等', () => {
  it('验证 DSH_TAURI_EMBEDDED 为 0 时严格判等仍不接管', async () => {
    await withCarrier('0', async () => {
      const host = await startGateHost()
      try {
        const index = await fetch(`${host.baseUrl}/`)
        expect(index.status, '标记不是 1 时索引必须仍被拒 401').toBe(401)

        const api = await fetch(`${host.baseUrl}${PET_STREAM_PATH}`)
        expect(api.status, '/api 的鉴权也不得被改写').toBe(401)
      }
      finally {
        await host.stop()
      }
    })
  })
})
