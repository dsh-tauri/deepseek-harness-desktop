import type { SshMachineRow } from './types'
import { describe, expect, it } from 'vitest'
import { borderTintOf, dotClassOf, dotStyleOf, reconcileSwitcher } from './logic'

function machineOf(partial: Partial<SshMachineRow>): SshMachineRow {
  return {
    id: 'm1',
    name: 'machine',
    state: 'disconnected',
    ...partial,
  }
}

describe('dotClassOf（S3 词汇表色点语义）', () => {
  it('机器标识色优先：任何状态都不覆盖内联色', () => {
    for (const state of ['disconnected', 'connected', 'reconnecting', 'given-up'] as const) {
      expect(dotClassOf({ color: '#ff00ff', state })).toBe('')
      expect(dotStyleOf({ color: '#ff00ff' })).toEqual({ backgroundColor: '#ff00ff' })
    }
  })

  it('无标识色时按状态给语义色：已连接绿、重连/进行中琥珀、放弃红、其余中性', () => {
    expect(dotClassOf({ state: 'connected' })).toBe('bg-success')
    expect(dotClassOf({ state: 'reconnecting' })).toBe('bg-warning')
    expect(dotClassOf({ state: 'connecting' })).toBe('bg-warning')
    expect(dotClassOf({ state: 'testing' })).toBe('bg-warning')
    expect(dotClassOf({ state: 'given-up' })).toBe('bg-danger')
    expect(dotClassOf({ state: 'disconnected' })).toBe('bg-line-strong')
    expect(dotStyleOf({})).toBeUndefined()
  })
})

describe('borderTintOf（内容区着色）', () => {
  it('活动机器勾选 tintBorder 且有标识色才描边', () => {
    expect(borderTintOf(machineOf({ color: '#123456', tintBorder: true }))).toBe('#123456')
    expect(borderTintOf(machineOf({ color: '#123456' }))).toBeNull()
    expect(borderTintOf(machineOf({ tintBorder: true }))).toBeNull()
    expect(borderTintOf(undefined)).toBeNull()
  })
})

describe('reconcileSwitcher（切换语义）', () => {
  const idle = { activeId: null, pendingId: null, activeTunnelUrl: '' }

  it('活动机器断开或放弃 → 自动回本地', () => {
    for (const state of ['disconnected', 'given-up'] as const) {
      const next = reconcileSwitcher(
        { activeId: 'm1', pendingId: null, activeTunnelUrl: 'http://127.0.0.1:4001' },
        [machineOf({ id: 'm1', state })],
      )
      expect(next).toEqual(idle)
    }
  })

  it('活动机器行消失（被删除）→ 回本地', () => {
    const next = reconcileSwitcher(
      { activeId: 'gone', pendingId: null, activeTunnelUrl: 'http://127.0.0.1:4001' },
      [],
    )
    expect(next).toEqual(idle)
  })

  it('重连窗口保持指向：粘性保留隧道 URL，不指向空端口', () => {
    const next = reconcileSwitcher(
      { activeId: 'm1', pendingId: null, activeTunnelUrl: 'http://127.0.0.1:4001' },
      [machineOf({ id: 'm1', state: 'reconnecting', nextRetryAt: 1 })],
    )
    expect(next).toEqual({ activeId: 'm1', pendingId: null, activeTunnelUrl: 'http://127.0.0.1:4001' })
  })

  it('重连恢复后采用最新隧道 URL（端口稳定策略下通常不变，变化则换 URL）', () => {
    const same = reconcileSwitcher(
      { activeId: 'm1', pendingId: null, activeTunnelUrl: 'http://127.0.0.1:4001' },
      [machineOf({ id: 'm1', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })],
    )
    expect(same.activeTunnelUrl).toBe('http://127.0.0.1:4001')

    const moved = reconcileSwitcher(
      { activeId: 'm1', pendingId: null, activeTunnelUrl: 'http://127.0.0.1:4001' },
      [machineOf({ id: 'm1', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4009' })],
    )
    expect(moved.activeTunnelUrl).toBe('http://127.0.0.1:4009')
  })

  it('待切换机器就绪 → 升为活动；放弃或消失 → 撤销待切换留在本地', () => {
    const promoted = reconcileSwitcher(
      { activeId: null, pendingId: 'm1', activeTunnelUrl: '' },
      [machineOf({ id: 'm1', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4002' })],
    )
    expect(promoted).toEqual({ activeId: 'm1', pendingId: null, activeTunnelUrl: 'http://127.0.0.1:4002' })

    for (const machines of [
      [machineOf({ id: 'm1', state: 'given-up', lastError: 'connect failed' })],
      [],
    ]) {
      const next = reconcileSwitcher({ activeId: null, pendingId: 'm1', activeTunnelUrl: '' }, machines)
      expect(next).toEqual(idle)
    }
  })

  it('活动机器待重连时另一台机器就绪不抢切换（同一时刻一台活动机器）', () => {
    const next = reconcileSwitcher(
      { activeId: 'm1', pendingId: null, activeTunnelUrl: 'http://127.0.0.1:4001' },
      [
        machineOf({ id: 'm1', state: 'reconnecting' }),
        machineOf({ id: 'm2', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4003' }),
      ],
    )
    expect(next).toEqual({ activeId: 'm1', pendingId: null, activeTunnelUrl: 'http://127.0.0.1:4001' })
  })
})
