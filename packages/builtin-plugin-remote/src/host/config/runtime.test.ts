import type { Config } from './schema'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { dirname, join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearHostRuntime, migrateLegacyState, setHostConfig } from './runtime'

let home = ''

function configOf(overrides: Partial<Config> = {}): Config {
  return {
    connectTimeoutMs: 15_000,
    healthCheckTimeoutMs: 3_000,
    healthPollIntervalMs: 1_000,
    healthPollAttempts: 30,
    keepaliveIntervalMs: 10_000,
    keepaliveCountMax: 3,
    reconnectInitialDelayMs: 1_000,
    reconnectMaxDelayMs: 20_000,
    reconnectMaxAttempts: 6,
    ...overrides,
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-remote-state-'))
  process.env.DSH_HOME = home
  setHostConfig(configOf())
})

afterEach(() => {
  clearHostRuntime()
  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
})

describe('migrateLegacyState', () => {
  it('把上一版 remote 目录里的状态文件与 bin 搬进 remote.ssh，并删掉腾空的 remote', () => {
    writeJson(join(home, 'remote', 'machines.json'), { machines: ['m1'] })
    writeJson(join(home, 'remote', 'known-hosts.json'), { records: ['r1'] })
    writeJson(join(home, 'remote', 'access.json'), { enabled: true })
    mkdirSync(join(home, 'remote', 'bin'), { recursive: true })
    writeFileSync(join(home, 'remote', 'bin', 'cloudflared'), 'binary')

    expect(migrateLegacyState()).toBeUndefined()

    expect(readJson(join(home, 'remote.ssh', 'machines.json'))).toEqual({ machines: ['m1'] })
    expect(readJson(join(home, 'remote.ssh', 'known-hosts.json'))).toEqual({ records: ['r1'] })
    expect(readJson(join(home, 'remote.ssh', 'access.json'))).toEqual({ enabled: true })
    expect(readFileSync(join(home, 'remote.ssh', 'bin', 'cloudflared'), 'utf8')).toBe('binary')
    expect(existsSync(join(home, 'remote'))).toBe(false)
  })

  it('remote 里的他人条目原地不动，目录保留给 ds-harness-remote', () => {
    writeJson(join(home, 'remote', 'machines.json'), { machines: ['m1'] })
    writeJson(join(home, 'remote', 'servers', 'web.json'), { id: 'web' })

    expect(migrateLegacyState()).toBeUndefined()

    expect(readJson(join(home, 'remote', 'servers', 'web.json'))).toEqual({ id: 'web' })
    expect(existsSync(join(home, 'remote', 'machines.json'))).toBe(false)
    expect(readJson(join(home, 'remote.ssh', 'machines.json'))).toEqual({ machines: ['m1'] })
  })

  it('新目录已有同名条目时不覆盖，旧文件留在原处并给出告警', () => {
    writeJson(join(home, 'remote', 'access.json'), { enabled: false })
    writeJson(join(home, 'remote.ssh', 'access.json'), { enabled: true })

    expect(migrateLegacyState()).toContain('access.json')

    expect(readJson(join(home, 'remote.ssh', 'access.json'))).toEqual({ enabled: true })
    expect(readJson(join(home, 'remote', 'access.json'))).toEqual({ enabled: false })
  })

  it('最早的 ssh 目录只搬文档并保留旧文件', () => {
    writeJson(join(home, 'ssh', 'machines.json'), { machines: ['legacy'] })

    expect(migrateLegacyState()).toBeUndefined()

    expect(readJson(join(home, 'remote.ssh', 'machines.json'))).toEqual({ machines: ['legacy'] })
    expect(readJson(join(home, 'ssh', 'machines.json'))).toEqual({ machines: ['legacy'] })
  })

  it('两份旧目录都有 machines.json 时以较新的 remote 为准', () => {
    writeJson(join(home, 'remote', 'machines.json'), { machines: ['new'] })
    writeJson(join(home, 'ssh', 'machines.json'), { machines: ['old'] })

    expect(migrateLegacyState()).toBeUndefined()

    expect(readJson(join(home, 'remote.ssh', 'machines.json'))).toEqual({ machines: ['new'] })
  })

  it('同一进程内只搬一次，之后新出现的旧文件不再搬动', () => {
    writeJson(join(home, 'remote', 'machines.json'), { machines: ['m1'] })
    expect(migrateLegacyState()).toBeUndefined()

    writeJson(join(home, 'remote', 'access.json'), { enabled: true })
    expect(migrateLegacyState()).toBeUndefined()

    expect(readJson(join(home, 'remote', 'access.json'))).toEqual({ enabled: true })
  })

  it('没有旧目录时不创建新目录', () => {
    expect(migrateLegacyState()).toBeUndefined()

    expect(existsSync(join(home, 'remote.ssh'))).toBe(false)
  })
})
