import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tokenMatches } from '../utils/auth'
import { consumePairingCode, PAIRING_TTL_MS, pairingCodeOf, resetPairingCode, waitForPairingUse } from './pairing'

const NOW = 1_700_000_000_000

beforeEach(() => {
  resetPairingCode()
})

afterEach(() => {
  resetPairingCode()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('pairingCodeOf', () => {
  it('生成 8 位大写字母数字配对码并在有效期内保持不变', () => {
    const first = pairingCodeOf(NOW)
    expect(first.code).toMatch(/^[2-9A-HJ-NP-Z]{8}$/u)
    expect(first.expiresAt).toBe(NOW + PAIRING_TTL_MS)
    expect(first.usedSeq).toBe(0)
    expect(pairingCodeOf(NOW + PAIRING_TTL_MS - 1)).toBe(first)
  })

  it('过期即换新码，旧码立刻失效', () => {
    const first = pairingCodeOf(NOW)
    const next = pairingCodeOf(NOW + PAIRING_TTL_MS)
    expect(next.code).not.toBe(first.code)
    expect(tokenMatches(first.code.toLowerCase(), next.code)).toBe(false)
    expect(tokenMatches(next.code.toLowerCase(), next.code)).toBe(true)
    expect(next.expiresAt).toBe(NOW + PAIRING_TTL_MS * 2)
    expect(next.usedSeq).toBe(0)
    expect(pairingCodeOf(NOW + PAIRING_TTL_MS)).toBe(next)
  })

  it('新旧码不相等且不会因为重复读取而漂移', () => {
    const codes = new Set<string>()
    for (let index = 0; index < 32; index += 1) {
      resetPairingCode()
      codes.add(pairingCodeOf(NOW).code)
    }
    expect(codes.size).toBe(32)
  })
})

describe('临时配对码消费', () => {
  it('小写码只能消费一次，立即换新码且仅成功时推进 usedSeq', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const first = pairingCodeOf()
    expect(consumePairingCode('invalid')).toBe(false)
    expect(pairingCodeOf()).toBe(first)
    expect(consumePairingCode(first.code.toLowerCase())).toBe(true)
    const next = pairingCodeOf()
    expect(next.code).not.toBe(first.code)
    expect(next.expiresAt).toBe(NOW + PAIRING_TTL_MS)
    expect(next.usedSeq).toBe(1)
    expect(consumePairingCode(first.code)).toBe(false)
    expect(pairingCodeOf()).toBe(next)
    expect(consumePairingCode(next.code)).toBe(true)
    const afterUse = pairingCodeOf()
    expect(afterUse.usedSeq).toBe(2)
    const afterExpiry = pairingCodeOf(afterUse.expiresAt)
    expect(afterExpiry.code).not.toBe(afterUse.code)
    expect(afterExpiry.usedSeq).toBe(2)
  })

  it('到期边界拒绝旧码，不把自动轮换记成使用', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const first = pairingCodeOf()
    clock.mockReturnValue(NOW + PAIRING_TTL_MS)
    expect(consumePairingCode(first.code)).toBe(false)
    expect(pairingCodeOf().usedSeq).toBe(0)
  })

  it('通知所有等待者，并在已消费后注册时不丢事件', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const first = pairingCodeOf()
    const left = waitForPairingUse(0)
    const right = waitForPairingUse(0)
    expect(consumePairingCode(first.code.toLowerCase())).toBe(true)
    await expect(Promise.all([left, right])).resolves.toEqual([undefined, undefined])
    await expect(waitForPairingUse(0)).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('等待只由消费或八秒超时结束，期限自动轮换不通知', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const first = pairingCodeOf()
    let settled = false
    const pending = waitForPairingUse(0).then(() => {
      settled = true
    })
    pairingCodeOf(first.expiresAt)
    await vi.advanceTimersByTimeAsync(7999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(settled).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('取消和重置移除等待者与定时器，不影响下一次等待', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const aborted = new AbortController()
    aborted.abort()
    await waitForPairingUse(0, aborted.signal)
    expect(vi.getTimerCount()).toBe(0)
    const controller = new AbortController()
    const cancelled = waitForPairingUse(0, controller.signal)
    const reset = waitForPairingUse(0)
    expect(vi.getTimerCount()).toBe(2)
    controller.abort()
    await cancelled
    expect(vi.getTimerCount()).toBe(1)
    resetPairingCode()
    await reset
    expect(vi.getTimerCount()).toBe(0)
    const next = pairingCodeOf()
    const pending = waitForPairingUse(0)
    expect(consumePairingCode(next.code)).toBe(true)
    await pending
    expect(vi.getTimerCount()).toBe(0)
  })
})
