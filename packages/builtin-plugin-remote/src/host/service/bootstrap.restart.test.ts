import type { Config } from '../config/schema'
import type { MachineProfile, RemoteExecResult, RemoteSession } from '../types/index'
import { describe, expect, it, vi } from 'vitest'
import { buildRestartScript, restartRemoteInstance } from './bootstrap.utils'

const PORT = 41990

const PROFILE: MachineProfile = { id: 'build' as MachineProfile['id'], name: 'build', host: 'build.example', port: 22, user: 'dev', remotePort: PORT }

const CONFIG = { healthPollAttempts: 3, healthPollIntervalMs: 1, healthCheckTimeoutMs: 1000 } as Config

const BOOT_HTML = `<html><head><script>globalThis['__DSH_BOOT__'] = {"release":{"version":"0.33.1"},"entries":[{"url":"/plugins/dsh-tauri-ui/client.js"}]}</script></head></html>`

/** 按命令内容分派：重启脚本 / 就绪探测 / 端口监听身份。 */
function sessionOf(overrides: { restart?: RemoteExecResult } = {}) {
  const calls: string[] = []
  const session: RemoteSession = {
    exec: vi.fn(async (command: string): Promise<RemoteExecResult> => {
      if (command.includes('tmp/restart.')) {
        calls.push('restart')
        return overrides.restart ?? { code: 0, stdout: '远端实例已拉起', stderr: '' }
      }
      if (command.includes('client.js')) {
        calls.push('bundle')
        return { code: 0, stdout: 'console.log(1)\n200', stderr: '' }
      }
      if (command.includes(`127.0.0.1:${PORT}/`)) {
        calls.push('probe')
        return { code: 0, stdout: BOOT_HTML, stderr: '' }
      }
      calls.push('listener')
      return { code: 1, stdout: '', stderr: 'REMOTE_DSH_LISTENER_TOOLS_MISSING' }
    }),
    stream: vi.fn(),
    onClosed: vi.fn(),
    close: vi.fn(async () => {}),
  }
  return { session, calls }
}

describe('远端实例重启', () => {
  it('停与起在同一条脚本里，并先占住活动槽位声明', () => {
    const script = buildRestartScript(PROFILE)

    expect(script).toContain('slot-dsh.lock')
    expect(script).toContain('REMOTE_INSTANCE_STOP_FAILED')
    expect(script).toContain('REMOTE_NOT_INSTALLED')
    expect(script.indexOf('REMOTE_INSTANCE_STOP_FAILED')).toBeLessThan(script.indexOf('REMOTE_NOT_INSTALLED'))
  })

  it('入口按远端实际装的那份取：ZIP 布局优先，npm 布局兜底', () => {
    const script = buildRestartScript(PROFILE)

    expect(script).toContain('dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')
    expect(script).toContain('elif [ -f "$ROOT/dependencies/dsh/lib/bin.js" ]')
    expect(script.indexOf('node_modules/@deepseek-ai/dsh/lib/bin.js')).toBeLessThan(script.indexOf('elif [ -f "$ROOT/dependencies/dsh/lib/bin.js"'))
  })

  it('自定义启动命令的机器不做受管入口检查', () => {
    const script = buildRestartScript({ ...PROFILE, startCommand: 'exec ~/run-dsh.sh' })

    expect(script).toContain('run-dsh.sh')
    expect(script).not.toContain('REMOTE_NOT_INSTALLED')
  })

  it('等到远端实例重新就绪才算重启完成', async () => {
    const { session, calls } = sessionOf()
    const events: string[] = []

    const target = await restartRemoteInstance(session, PROFILE, CONFIG, {
      onEvent: (stage, line, options) => events.push(`${stage}:${line}${options?.terminal === undefined ? '' : `:${options.terminal}`}`),
    })

    expect(target).toBe(`build.example:${PORT}`)
    expect(calls).toContain('probe')
    expect(events.find(event => event.startsWith('launch:重启远端实例'))).toBeDefined()
    expect(events).toContain('ready:远端实例已就绪 (build.example:41990):success')
  })

  it('重启脚本失败时明确失败，不再去探测就绪', async () => {
    const { session, calls } = sessionOf({ restart: { code: 17, stdout: '', stderr: 'REMOTE_CORE_SLOT_BUSY: 远端实例正被其它操作改动（pid 123）' } })
    const events: string[] = []

    await expect(restartRemoteInstance(session, PROFILE, CONFIG, {
      onEvent: (stage, line, options) => events.push(`${stage}:${options?.reason ?? line}`),
    })).rejects.toThrow(/remote instance restart failed/)

    expect(calls).not.toContain('probe')
    expect(events.find(event => event.startsWith('failed:'))).toBeDefined()
  })

  it('远端没有可用的核心入口时报告未安装，而不是当成重启成功', async () => {
    const { session } = sessionOf({ restart: { code: 1, stdout: 'REMOTE_NOT_INSTALLED: 远端三件套未安装完整', stderr: '' } })

    await expect(restartRemoteInstance(session, PROFILE, CONFIG)).rejects.toThrow(/REMOTE_NOT_INSTALLED/)
  })
})
