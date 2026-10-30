import { afterEach, describe, expect, it, vi } from 'vitest'
import { getTurnEnd } from '../apis'
import { turnEndedByUser } from './turn-end'

vi.mock('../apis', () => ({ getTurnEnd: vi.fn() }))

afterEach(() => {
  vi.resetAllMocks()
  vi.restoreAllMocks()
})

describe('turnEndedByUser', () => {
  it.each(['aborted', 'interrupted', 'archived'])('宿主返回 %s 时抑制完成通知', async (reason) => {
    vi.mocked(getTurnEnd).mockResolvedValue({ reason, turn: 4 })
    expect(await turnEndedByUser('session')).toBe(true)
    expect(getTurnEnd).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session' })
  })

  it('宿主确认正常完成时保留完成通知', async () => {
    vi.mocked(getTurnEnd).mockResolvedValue({ reason: 'completed', turn: 4 })
    expect(await turnEndedByUser('session')).toBe(false)
  })

  it('空会话不请求宿主', async () => {
    expect(await turnEndedByUser('')).toBe(false)
    expect(getTurnEnd).not.toHaveBeenCalled()
  })

  it('宿主请求失败时保留原有通知退级', async () => {
    vi.mocked(getTurnEnd).mockRejectedValue(new Error('offline'))
    expect(await turnEndedByUser('session')).toBe(false)
  })
})
