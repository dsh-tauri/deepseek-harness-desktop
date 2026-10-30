import type { PendingInteractionFace, SessionStatusFace, UiSessionFace } from '../types'
import { describe, expect, it, vi } from 'vitest'
import {
  answerQuestionBatch,
  approveInteraction,
  pendingDetail,
  pendingIdentity,
  pendingNotificationKind,
  readPendingInteraction,
  readSessionStatus,
} from './approval'

function fakeUiSession(status?: Partial<SessionStatusFace>): UiSessionFace {
  const snapshot = new Map<string, SessionStatusFace>()
  if (status) {
    snapshot.set('s1', {
      running: false,
      pendingInteraction: undefined,
      completionUnread: false,
      ...status,
    })
  }
  return {
    sessionStatus: {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
    },
  }
}

function pending(overrides: Partial<PendingInteractionFace> & Pick<PendingInteractionFace, 'kind' | 'key'>): PendingInteractionFace {
  return { sessionId: 's1', ...overrides }
}

describe('readSessionStatus / readPendingInteraction', () => {
  it('缺少 uiSession 服务时安全降级为 undefined', () => {
    expect(readSessionStatus(undefined, 's1')).toBeUndefined()
    expect(readPendingInteraction(undefined, 's1')).toBeUndefined()
  })

  it('会话不在快照里时为 undefined', () => {
    expect(readSessionStatus(fakeUiSession({ running: true }), 'missing')).toBeUndefined()
  })

  it('读得到当前待处理交互', () => {
    const interaction = pending({ kind: 'approval', key: 'k1' })
    const ui = fakeUiSession({ pendingInteraction: interaction })
    expect(readSessionStatus(ui, 's1')?.pendingInteraction).toBe(interaction)
    expect(readPendingInteraction(ui, 's1')).toBe(interaction)
  })
})

describe('pendingNotificationKind', () => {
  it('未挂起时不通知', () => {
    expect(pendingNotificationKind(undefined)).toBeUndefined()
  })

  it('授权映射为 approval', () => {
    expect(pendingNotificationKind(pending({ kind: 'approval', key: 'k' }))).toBe('approval')
  })

  it('提问与计划评审都映射为 question', () => {
    expect(pendingNotificationKind(pending({ kind: 'question', key: 'k' }))).toBe('question')
    expect(pendingNotificationKind(pending({ kind: 'plan-review', key: 'k' }))).toBe('question')
  })

  it('未知交互不弹通知', () => {
    expect(pendingNotificationKind(pending({ kind: 'mystery', key: 'k' }))).toBeUndefined()
  })
})

describe('pendingIdentity', () => {
  it('由 kind 与 key 组成稳定标识', () => {
    expect(pendingIdentity(pending({ kind: 'approval', key: 'abc' }))).toBe('approval:abc')
    expect(pendingIdentity(pending({ kind: 'question', key: 'abc' }))).toBe('question:abc')
  })
})

describe('pendingDetail', () => {
  it('授权拼接工具名与原因', () => {
    expect(pendingDetail(pending({ kind: 'approval', key: 'k', toolName: 'Bash', reason: '网络访问' })))
      .toBe('Bash: 网络访问')
  })

  it('授权优先使用本地化的 displayReason', () => {
    expect(pendingDetail(pending({ kind: 'approval', key: 'k', toolName: 'Bash', displayReason: { zh: '需要授权', en: 'needs approval' } })))
      .toBe('Bash: 需要授权')
    expect(pendingDetail(pending({ kind: 'approval', key: 'k', toolName: 'Bash', displayReason: '因为安全' })))
      .toBe('Bash: 因为安全')
  })

  it('只有工具名或只有原因时退化为可用的那一半', () => {
    expect(pendingDetail(pending({ kind: 'approval', key: 'k', toolName: 'Bash' }))).toBe('Bash')
    expect(pendingDetail(pending({ kind: 'approval', key: 'k', reason: '网络访问' }))).toBe('网络访问')
    expect(pendingDetail(pending({ kind: 'approval', key: 'k' }))).toBe('')
  })

  it('提问取首个问题，缺失时退回标题', () => {
    expect(pendingDetail(pending({ kind: 'question', key: 'k', questions: [{ question: '选哪个？', header: '选择' }] })))
      .toBe('选哪个？')
    expect(pendingDetail(pending({ kind: 'question', key: 'k', questions: [{ header: '选择' }] })))
      .toBe('选择')
    expect(pendingDetail(pending({ kind: 'question', key: 'k' }))).toBe('')
  })
})

describe('approveInteraction', () => {
  it('没有可用的待处理交互时返回 APPROVAL_UNAVAILABLE', async () => {
    expect(await approveInteraction(undefined, 's1')).toEqual({ ok: false, error: 'APPROVAL_UNAVAILABLE' })
    expect(await approveInteraction(fakeUiSession({ running: true }), 's1')).toEqual({ ok: false, error: 'APPROVAL_UNAVAILABLE' })
  })

  it('挂起的是提问而不是授权时不越权回答', async () => {
    const ui = fakeUiSession({ pendingInteraction: pending({ kind: 'question', key: 'k', answer: async () => {} }) })
    expect(await approveInteraction(ui, 's1')).toEqual({ ok: false, error: 'APPROVAL_UNAVAILABLE' })
  })

  it('交互已不可回答或缺少 answer 方法时返回 APPROVAL_NOT_ANSWERABLE', async () => {
    const notAnswerable = fakeUiSession({
      pendingInteraction: pending({ kind: 'approval', key: 'k', answerable: false, answer: async () => {} }),
    })
    expect(await approveInteraction(notAnswerable, 's1')).toEqual({ ok: false, error: 'APPROVAL_NOT_ANSWERABLE' })
    const noAnswer = fakeUiSession({ pendingInteraction: pending({ kind: 'approval', key: 'k', answerable: true }) })
    expect(await approveInteraction(noAnswer, 's1')).toEqual({ ok: false, error: 'APPROVAL_NOT_ANSWERABLE' })
  })

  it('可回答时以 allowed-once 一次性批准', async () => {
    const answer = vi.fn(async () => {})
    const ui = fakeUiSession({ pendingInteraction: pending({ kind: 'approval', key: 'k', answerable: true, answer }) })
    expect(await approveInteraction(ui, 's1')).toEqual({ ok: true })
    expect(answer).toHaveBeenCalledTimes(1)
    expect(answer).toHaveBeenCalledWith('allowed-once')
  })

  it('回答抛错时把错误信息回传而不是抛出', async () => {
    const ui = fakeUiSession({
      pendingInteraction: pending({ kind: 'approval', key: 'k', answerable: true, answer: async () => { throw new Error('已过期') } }),
    })
    expect(await approveInteraction(ui, 's1')).toEqual({ ok: false, error: '已过期' })
  })
})

describe('answerQuestionBatch', () => {
  const questions = [{ id: 'q1' }, { id: 'q2' }]

  it('没有提问挂起时不越权回答', async () => {
    expect(await answerQuestionBatch(undefined, 's1', [{ id: 'q1', selected: [], custom: 'x' }]))
      .toEqual({ ok: false, error: 'QUESTION_UNAVAILABLE' })
    const approval = fakeUiSession({ pendingInteraction: pending({ kind: 'approval', key: 'k', answer: async () => {} }) })
    expect(await answerQuestionBatch(approval, 's1', [{ id: 'q1', selected: [], custom: 'x' }]))
      .toEqual({ ok: false, error: 'QUESTION_UNAVAILABLE' })
  })

  it('身份对不上时返回 QUESTION_STALE，避免替新的挂起作答', async () => {
    const ui = fakeUiSession({ pendingInteraction: pending({ kind: 'question', key: 'k', answerable: true, questions, answer: async () => {} }) })
    expect(await answerQuestionBatch(ui, 's1', [{ id: 'q1', selected: [], custom: '一' }, { id: 'q2', selected: [], custom: '二' }], 'question:old'))
      .toEqual({ ok: false, error: 'QUESTION_STALE' })
  })

  it('交互已不可回答时返回 QUESTION_NOT_ANSWERABLE', async () => {
    const ui = fakeUiSession({ pendingInteraction: pending({ kind: 'question', key: 'k', answerable: false, questions, answer: async () => {} }) })
    expect(await answerQuestionBatch(ui, 's1', [{ id: 'q1', selected: [], custom: '一' }]))
      .toEqual({ ok: false, error: 'QUESTION_NOT_ANSWERABLE' })
  })

  it('空答案不提交', async () => {
    const ui = fakeUiSession({ pendingInteraction: pending({ kind: 'question', key: 'k', answerable: true, questions, answer: async () => {} }) })
    expect(await answerQuestionBatch(ui, 's1', [])).toEqual({ ok: false, error: 'QUESTION_EMPTY' })
    expect(await answerQuestionBatch(ui, 's1', [{ id: 'q1', selected: [], custom: '  ' }]))
      .toEqual({ ok: false, error: 'QUESTION_EMPTY' })
  })

  it('答案与挂起的题目对不齐时返回 QUESTION_STALE，不交给宿主去拒收', async () => {
    const answer = vi.fn(async () => {})
    const ui = fakeUiSession({ pendingInteraction: pending({ kind: 'question', key: 'k', answerable: true, questions, answer }) })
    expect(await answerQuestionBatch(ui, 's1', [{ id: 'q1', selected: [], custom: '一' }]))
      .toEqual({ ok: false, error: 'QUESTION_STALE' })
    expect(await answerQuestionBatch(ui, 's1', [{ id: 'q1', selected: [], custom: '一' }, { id: 'qX', selected: [], custom: '二' }]))
      .toEqual({ ok: false, error: 'QUESTION_STALE' })
    expect(answer).not.toHaveBeenCalled()
  })

  it('整批一次提交，自由文本走 custom', async () => {
    const answer = vi.fn(async () => {})
    const ui = fakeUiSession({ pendingInteraction: pending({ kind: 'question', key: 'k', answerable: true, questions, answer }) })
    expect(await answerQuestionBatch(ui, 's1', [{ id: 'q1', selected: [], custom: '一' }, { id: 'q2', selected: [], custom: '二' }], 'question:k'))
      .toEqual({ ok: true })
    expect(answer).toHaveBeenCalledTimes(1)
    expect(answer).toHaveBeenCalledWith({ answers: [{ id: 'q1', selected: [], custom: '一' }, { id: 'q2', selected: [], custom: '二' }] })
  })

  it('宿主拒收时把错误信息回传而不是抛出', async () => {
    const ui = fakeUiSession({
      pendingInteraction: pending({ kind: 'question', key: 'k', answerable: true, questions: [{ id: 'q1' }], answer: async () => { throw new Error('BAD_ANSWER') } }),
    })
    expect(await answerQuestionBatch(ui, 's1', [{ id: 'q1', selected: [], custom: '一' }]))
      .toEqual({ ok: false, error: 'BAD_ANSWER' })
  })
})
