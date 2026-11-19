import type { RemoteExecResult, RemoteSession } from '../types/index'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it, vi } from 'vitest'
import { remotePidfile } from '../config/constants'
import { assertListenerProfile, parseListenerSnapshot, profileOfArgv, readListenerProfile, remoteInstanceStopCommand } from './instance'

const SHELL_AVAILABLE = spawnSync('sh', ['-c', 'command -v curl >/dev/null 2>&1 && command -v kill >/dev/null 2>&1']).status === 0
const LISTENER_PORT = 41987

function sessionOfResult(result: RemoteExecResult): RemoteSession {
  return {
    exec: vi.fn(async () => result),
    stream: vi.fn(),
    onClosed: vi.fn(),
    close: vi.fn(async () => {}),
  }
}

function linuxSnapshot(pid: string, argv: readonly string[]): string {
  return `Linux\n${pid}\n/home/tester\n123:456\n${argv.join('\0')}\0`
}

describe('远端实例身份', () => {
  it('启动参数里的档案名取自 --profile', () => {
    expect(profileOfArgv(['node', '/opt/dsh/lib/bin.js', '--profile', 'other', '--host', '127.0.0.1', '--port', '8080'])).toBe('other')
  })

  it('没有 --profile 时认不出档案，而不是当成空档案', () => {
    expect(profileOfArgv(['node', '/opt/dsh/lib/bin.js', '--port', '8080'])).toBeUndefined()
  })

  it('--profile 后面缺值时认不出档案', () => {
    expect(profileOfArgv(['node', '/opt/dsh/lib/bin.js', '--profile', '--port'])).toBeUndefined()
  })

  it('监听快照按 Linux 的 NUL 分隔还原 argv', () => {
    const identity = parseListenerSnapshot(linuxSnapshot('4321', ['node', '/opt/dsh/lib/bin.js', '--profile', 'remote']))

    expect(identity?.pid).toBe('4321')
    expect(identity?.argv).toEqual(['node', '/opt/dsh/lib/bin.js', '--profile', 'remote', ''])
  })

  it('快照缺关键字段时认不出身份', () => {
    expect(parseListenerSnapshot('Linux\nnot-a-pid\n/home/tester\n123:456\nnode\0')).toBeUndefined()
  })

  it('端口上的实例是自己配的档案时放行', async () => {
    const session = sessionOfResult({ code: 0, stdout: linuxSnapshot('4321', ['node', '/opt/dsh/lib/bin.js', '--profile', 'remote']), stderr: '' })

    await expect(assertListenerProfile(session, LISTENER_PORT, 'remote')).resolves.toBeUndefined()
  })

  it('端口上的实例是别的档案时报错，不再静默复用', async () => {
    const session = sessionOfResult({ code: 0, stdout: linuxSnapshot('4321', ['node', '/opt/dsh/lib/bin.js', '--profile', 'other']), stderr: '' })

    await expect(assertListenerProfile(session, LISTENER_PORT, 'remote')).rejects.toThrow('REMOTE_INSTANCE_PROFILE_MISMATCH')
  })

  it('远端认不出监听进程时不误判成档案不对', async () => {
    const session = sessionOfResult({ code: 1, stdout: '', stderr: 'REMOTE_DSH_LISTENER_TOOLS_MISSING' })

    await expect(readListenerProfile(session, LISTENER_PORT)).resolves.toBeUndefined()
    await expect(assertListenerProfile(session, LISTENER_PORT, 'remote')).resolves.toBeUndefined()
  })
})

describe.skipIf(!SHELL_AVAILABLE)('停远端实例', () => {
  it('端口上还有别的进程在应答时停实例必须失败', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-instance-stop-'))
    const port = 41988
    const server = spawn(process.execPath, ['-e', `require('http').createServer((_, res) => res.end('ok')).listen(${port}, '127.0.0.1')`], { stdio: 'ignore' })
    try {
      await vi.waitFor(() => {
        const probe = spawnSync('curl', ['-s', '-o', '/dev/null', '-m', '1', `http://127.0.0.1:${port}/`])
        expect(probe.status, '端口上的应答进程必须先起来').toBe(0)
      }, { timeout: 10_000 })
      const script = remoteInstanceStopCommand('remote', port).join('\n')
      const result = spawnSync('sh', ['-c', script], { encoding: 'utf8', env: { ...process.env, HOME: home }, timeout: 60_000 })

      expect(result.status, '端口没腾空就不能当实例已经停掉').not.toBe(0)
      expect(result.stderr).toContain('REMOTE_INSTANCE_STOP_FAILED')
    }
    finally {
      server.kill('SIGKILL')
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('pidfile 按端口命名，同一端口上的两份档案不会各写一份', () => {
    expect(remotePidfile(41989)).toBe('.dsh/.dsh-remote-41989.pid')
  })

  it('停实例时先核对进程身份，命令行对不上的进程不动手', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-instance-stop-'))
    mkdirSync(join(home, '.dsh'), { recursive: true })
    const unrelated = spawn('sh', ['-c', 'sleep 30'], { stdio: 'ignore' })
    try {
      writeFileSync(join(home, remotePidfile(41990)), `${unrelated.pid}\n`)
      const script = remoteInstanceStopCommand('remote', 41990).join('\n')
      const result = spawnSync('sh', ['-c', script], { encoding: 'utf8', env: { ...process.env, HOME: home }, timeout: 60_000 })

      expect(result.status, '命令行不匹配的进程不得被当成实例停掉').toBe(0)
      expect(spawnSync('kill', ['-0', String(unrelated.pid)]).status, '无关进程必须还活着').toBe(0)
    }
    finally {
      unrelated.kill('SIGKILL')
      rmSync(home, { recursive: true, force: true })
    }
  })
})
