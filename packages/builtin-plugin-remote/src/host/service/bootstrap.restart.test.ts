import type { Config } from '../config/schema'
import type { MachineProfile, RemoteExecResult, RemoteSession } from '../types/index'
import { describe, expect, it, vi } from 'vitest'
import { restartRemoteInstance } from './bootstrap.utils'

const PORT = 41990

const PROFILE: MachineProfile = { id: 'build' as MachineProfile['id'], name: 'build', host: 'build.example', port: 22, user: 'dev', remotePort: PORT }

const CONFIG = { healthPollAttempts: 3, healthPollIntervalMs: 1, healthCheckTimeoutMs: 1000 } as Config

const BOOT_HTML = `<html><head><script>globalThis['__DSH_BOOT__'] = {"release":{"version":"0.33.1"},"entries":[{"url":"/plugins/dsh-tauri-ui/client.js"}]}</script></head></html>`

/** 按命令内容分派：停实例 / 拉起 / 就绪探测 / 端口监听身份。 */
function sessionOf(overrides: { stop?: RemoteExecResult, start?: RemoteExecResult } = {}) {
  const calls: string[] = []
  const session: RemoteSession = {
    exec: vi.fn(async (command: string): Promise<RemoteExecResult> => {
      if (command.includes('REMOTE_INSTANCE_STOP_FAILED')) {
        calls.push('stop')
        return overrides.stop ?? { code: 0, stdout: '', stderr: '' }
      }
      if (command.includes('REMOTE_NOT_INSTALLED')) {
        calls.push('start')
        return overrides.start ?? { code: 0, stdout: '远端实例已拉起', stderr: '' }
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
  it('先停掉端口上的实例，再按同一份档案拉起并等到就绪', async () => {
    const { session, calls } = sessionOf()
    const events: string[] = []

    const target = await restartRemoteInstance(session, PROFILE, CONFIG, {
      onEvent: (stage, line, options) => events.push(`${stage}:${line}${options?.terminal === undefined ? '' : `:${options.terminal}`}`),
    })

    expect(target).toBe(`build.example:${PORT}`)
    expect(calls[0]).toBe('stop')
    expect(calls[1]).toBe('start')
    expect(calls).toContain('probe')
    expect(events.find(event => event.startsWith('launch:重启远端实例'))).toBeDefined()
    expect(events).toContain('ready:远端实例已就绪 (build.example:41990):success')
  })

  it('停不掉实例时明确失败，不会在旧实例还活着的时候去拉起新的', async () => {
    const { session, calls } = sessionOf({ stop: { code: 19, stdout: '', stderr: 'REMOTE_INSTANCE_STOP_FAILED: 远端实例（端口 41990）没有退出' } })
    const events: string[] = []

    await expect(restartRemoteInstance(session, PROFILE, CONFIG, {
      onEvent: (stage, line, options) => events.push(`${stage}:${options?.reason ?? line}`),
    })).rejects.toThrow(/remote instance stop failed/)

    expect(calls).not.toContain('start')
    expect(events.find(event => event.startsWith('failed:'))).toBeDefined()
  })

  it('拉起失败时报告失败而不是当作已重启', async () => {
    const { session } = sessionOf({ start: { code: 1, stdout: 'REMOTE_NOT_INSTALLED: 远端三件套未安装完整', stderr: '' } })

    await expect(restartRemoteInstance(session, PROFILE, CONFIG)).rejects.toThrow(/REMOTE_NOT_INSTALLED/)
  })
})
