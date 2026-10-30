import type { NotificationSettings } from '../types'
import { describe, expect, it } from 'vitest'
import { allowPendingNotification, allowTurnNotification, boundText, notificationTag } from './decision'

const settings: NotificationSettings = {
  turnComplete: 'background',
  approval: true,
  question: false,
  sound: 'default',
  customSound: null,
}

describe('allowTurnNotification', () => {
  const base = { mode: 'background' as const, hostHidden: false, sessionId: 's1', currentSessionId: 's1' }

  it('never 模式一律不提醒', () => {
    expect(allowTurnNotification({ ...base, mode: 'never', hostHidden: true })).toBe(false)
    expect(allowTurnNotification({ ...base, mode: 'never', currentSessionId: 's2' })).toBe(false)
  })

  it('always 模式一律提醒', () => {
    expect(allowTurnNotification({ ...base, mode: 'always' })).toBe(true)
    expect(allowTurnNotification({ ...base, mode: 'always', currentSessionId: undefined })).toBe(true)
  })

  it('background 在窗口隐藏时提醒', () => {
    expect(allowTurnNotification({ ...base, hostHidden: true })).toBe(true)
  })

  it('background 在用户切到别的会话时提醒', () => {
    expect(allowTurnNotification({ ...base, currentSessionId: 's2' })).toBe(true)
  })

  it('background 在窗口可见且仍盯着同一会话时不提醒', () => {
    expect(allowTurnNotification(base)).toBe(false)
  })

  it('background 在拿不到当前会话时仍提醒：只有确知「就停在这个会话上」才抑制', () => {
    // 与参考实现 `source/dsh-notification` 的 shouldShow 一致：读不到当前会话（会话投影
    // 缺席、或界面还没打开任何会话）时无法证明用户正盯着它，宁可多提醒一次。
    expect(allowTurnNotification({ ...base, currentSessionId: undefined })).toBe(true)
  })
})

describe('allowPendingNotification', () => {
  const gate = { hostHidden: false, sessionId: 's1', currentSessionId: 's1' }
  /** 一定不抑制的位置（窗口在后台），用来单纯验证开关。 */
  const background = { ...gate, hostHidden: true }

  it('按类别读取各自的开关', () => {
    expect(allowPendingNotification(settings, 'approval', background)).toBe(true)
    expect(allowPendingNotification(settings, 'question', background)).toBe(false)
    expect(allowPendingNotification({ ...settings, approval: false, question: true }, 'approval', background)).toBe(false)
    expect(allowPendingNotification({ ...settings, approval: false, question: true }, 'question', background)).toBe(true)
  })

  it('窗口在前台且就停在这个会话上时不提醒：审批框 / 提问就在眼前', () => {
    expect(allowPendingNotification({ ...settings, question: true }, 'question', gate)).toBe(false)
    expect(allowPendingNotification({ ...settings, approval: true }, 'approval', gate)).toBe(false)
  })

  it('「始终」时窗口在前台也提醒：用户明确要求不必省这一条', () => {
    const always = { ...settings, turnComplete: 'always' as const, question: true }
    expect(allowPendingNotification(always, 'question', gate)).toBe(true)
    expect(allowPendingNotification({ ...always, approval: true }, 'approval', gate)).toBe(true)
    // 「始终」只解除位置抑制，不越过各自的开关。
    expect(allowPendingNotification({ ...always, question: false }, 'question', gate)).toBe(false)
  })

  it('「从不」只管轮次完成，挂起交互仍遵循「看着就不打扰」', () => {
    const never = { ...settings, turnComplete: 'never' as const, question: true }
    expect(allowPendingNotification(never, 'question', gate)).toBe(false)
    expect(allowPendingNotification(never, 'question', { ...gate, hostHidden: true })).toBe(true)
  })

  it('窗口在后台时提醒', () => {
    expect(allowPendingNotification({ ...settings, question: true }, 'question', background)).toBe(true)
  })

  it('用户切到别的会话时提醒', () => {
    expect(allowPendingNotification({ ...settings, question: true }, 'question', { ...gate, currentSessionId: 's2' })).toBe(true)
  })

  it('拿不到当前会话时仍提醒：只有确知「就停在这个会话上」才抑制', () => {
    expect(allowPendingNotification({ ...settings, question: true }, 'question', { ...gate, currentSessionId: undefined })).toBe(true)
  })

  it('开关关掉时任何位置都不提醒', () => {
    expect(allowPendingNotification({ ...settings, approval: false }, 'approval', background)).toBe(false)
    expect(allowPendingNotification({ ...settings, approval: false }, 'approval', { ...gate, currentSessionId: 's2' })).toBe(false)
  })
})

describe('notificationTag', () => {
  it('轮次完成 tag 带序号', () => {
    expect(notificationTag('session-abc', 'turn', 3)).toBe('dsh-notification-session-abc-3')
  })

  it('待处理交互 tag 带 pending 前缀', () => {
    expect(notificationTag('session-abc', 'approval', 7)).toBe('dsh-notification-pending-session-abc-7')
  })
})

describe('boundText', () => {
  it('去除首尾空白', () => {
    expect(boundText('  已完成  ', 400)).toBe('已完成')
  })

  it('未超长时原样返回', () => {
    expect(boundText('abc', 3)).toBe('abc')
  })

  it('超长时截断并补省略号，总长等于上限', () => {
    const bounded = boundText('x'.repeat(50), 10)
    expect(bounded).toBe(`${'x'.repeat(9)}…`)
    expect(bounded).toHaveLength(10)
  })
})
