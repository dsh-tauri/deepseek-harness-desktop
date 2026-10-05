import { beforeEach, describe, expect, it, vi } from 'vitest'
import { safeResume } from './safe-resume'

vi.mock('dsh-tauri/client', async () => {
  const { defineStore } = await import('valtio-define')
  return { defineStore }
})

const refusal = { message: 'Content Exists Risk', code: 'INVALID_REQUEST', status: 400 }

beforeEach(() => {
  safeResume.clear('s-1')
})

describe('safeResume store', () => {
  it('记录拒绝状态并通知订阅方', async () => {
    const listener = vi.fn()
    const unsubscribe = safeResume.$subscribe(listener)

    safeResume.capture('s-1', refusal)
    await Promise.resolve()

    expect(safeResume.refusals['s-1']).toEqual({ ...refusal, phase: 'idle' })
    expect(listener).toHaveBeenCalled()
    unsubscribe()
  })

  it('同一份拒绝重复写入不再通知（否则与重扫订阅自激成环）', async () => {
    safeResume.capture('s-1', refusal)
    await Promise.resolve()
    const listener = vi.fn()
    const unsubscribe = safeResume.$subscribe(listener)

    safeResume.capture('s-1', { ...refusal })
    await Promise.resolve()

    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('恢复进行中再次捕获拒绝不打断进行中的阶段', () => {
    safeResume.capture('s-1', refusal)
    safeResume.beginRecovery('s-1')
    safeResume.capture('s-1', refusal)

    expect(safeResume.refusals['s-1']?.phase).toBe('running')
  })

  it('恢复失败与清除都落到拒绝状态上', () => {
    safeResume.capture('s-1', refusal)
    safeResume.failRecovery('s-1')
    expect(safeResume.refusals['s-1']?.phase).toBe('failing')

    safeResume.clear('s-1')
    expect(safeResume.refusals['s-1']).toBeUndefined()
  })
})
