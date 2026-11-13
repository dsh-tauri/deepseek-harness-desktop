import type { BridgeAddress } from '@/utils/bridge-protocol'
import { describe, expect, it, vi } from 'vitest'
import { buildDiagnosticLog } from './diagnostics'

const address: BridgeAddress = {
  id: 'http://bridge.test:3080',
  url: 'http://bridge.test:3080/tasks',
  host: 'bridge.test',
  port: 3080,
}

function inputOf(overrides: Partial<Parameters<typeof buildDiagnosticLog>[0]> = {}) {
  return {
    address,
    stage: 'connected',
    health: 'unavailable' as const,
    loadError: null,
    notice: null,
    authenticated: false,
    timedOut: false,
    ...overrides,
  }
}

describe('buildDiagnosticLog', () => {
  it('列出连接地址、端口、状态与最近错误', () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const log = buildDiagnosticLog(inputOf({ loadError: '连接失败', notice: '主机暂时不可用' }))
    expect(log.split('\n')).toEqual([
      'DSH Mobile connection diagnostics',
      'time: 2026-01-01T00:00:00.000Z',
      'stage: connected',
      'health: unavailable',
      'loadError: 连接失败',
      'notice: 主机暂时不可用',
      'loadTimedOut: no',
      'address: http://bridge.test:3080/tasks',
      'host: bridge.test',
      'port: 3080',
      'hasToken: no',
      'hasDeviceSession: no',
    ])
    vi.useRealTimers()
  })

  it('只标记令牌有无，绝不写明文', () => {
    const secret = `v1.1700000000000.0.${'b'.repeat(64)}`
    const log = buildDiagnosticLog(inputOf({ address: { ...address, token: secret }, authenticated: true }))
    expect(log).toContain('hasToken: yes')
    expect(log).toContain('hasDeviceSession: yes')
    expect(log).not.toContain(secret)
    expect(log).not.toContain('b'.repeat(64))
  })

  it('超时与无地址时给出可读占位', () => {
    const log = buildDiagnosticLog(inputOf({ address: null, loadError: null, timedOut: true, health: undefined }))
    expect(log).toContain('health: unknown')
    expect(log).toContain('loadError: none')
    expect(log).toContain('loadTimedOut: yes')
    expect(log).toContain('address: none')
    expect(log).not.toContain('hasToken')
  })
})
