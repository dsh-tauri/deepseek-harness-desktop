import { describe, expect, it, vi } from 'vitest'
import { forkRefusedSession } from './safe-resume'

describe('forkRefusedSession', () => {
  it('按显式 atSeq 分叉并在成功后打开子会话', async () => {
    const fork = vi.fn(async () => 'child-1')
    const outcome = await forkRefusedSession({ sessions: { fork }, sessionId: 's-1', atSeq: 4 })

    expect(fork).toHaveBeenCalledWith({ sessionId: 's-1', atSeq: 4, increaseTitle: true })
    expect(outcome).toEqual({ ok: true, childId: 'child-1' })
  })

  it('分叉能力缺席时给出可读失败而不抛错', async () => {
    const outcome = await forkRefusedSession({ sessions: {}, sessionId: 's-1', atSeq: 4 })

    expect(outcome.ok).toBe(false)
  })

  it('子会话 id 非字符串时判失败', async () => {
    const fork = vi.fn(async () => undefined as unknown as string)
    const outcome = await forkRefusedSession({ sessions: { fork }, sessionId: 's-1', atSeq: 4 })

    expect(outcome.ok).toBe(false)
  })

  it('内核抛错时折叠成失败结果', async () => {
    const fork = vi.fn(async () => {
      throw new Error('session/fork-unavailable')
    })
    const outcome = await forkRefusedSession({ sessions: { fork }, sessionId: 's-1', atSeq: 4 })

    expect(outcome).toEqual({ ok: false, error: 'session/fork-unavailable' })
  })
})
