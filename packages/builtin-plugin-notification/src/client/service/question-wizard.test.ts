import type { PendingInteractionFace, PendingQuestionFace } from '../types'
import { describe, expect, it } from 'vitest'
import { advanceQuestionWizard, canDriveQuestions, questionWizardStep, syncQuestionWizard } from './question-wizard'

function questionPending(questions: PendingQuestionFace[], key = 'k1'): PendingInteractionFace {
  return { key, kind: 'question', sessionId: 's1', questions, answerable: true, answer: async () => {} }
}

describe('canDriveQuestions', () => {
  it('每道题都有 id 时才驱动得了', () => {
    expect(canDriveQuestions(questionPending([{ id: 'q1', question: '选哪个？' }]))).toBe(true)
    expect(canDriveQuestions(questionPending([{ id: 'q1' }, { id: 'q2' }]))).toBe(true)
  })

  it('没有题、或有一题缺 id 时驱动不了', () => {
    expect(canDriveQuestions(questionPending([]))).toBe(false)
    expect(canDriveQuestions(questionPending([{ id: 'q1' }, { question: '没有 id' }]))).toBe(false)
    expect(canDriveQuestions(questionPending([{ id: '' }]))).toBe(false)
  })
})

describe('questionWizardStep', () => {
  it('单问题批次只有一题', () => {
    const step = questionWizardStep('single', questionPending([{ id: 'q1', question: '选哪个？' }]))
    expect(step).toMatchObject({ identity: 'question:k1', index: 0, total: 1, id: 'q1' })
  })

  it('多问题批次从第一题开始，答一题推进一题', () => {
    const pending = questionPending([{ id: 'q1', question: '第一题' }, { id: 'q2', question: '第二题' }])
    expect(questionWizardStep('chain', pending)?.index).toBe(0)
    expect(advanceQuestionWizard('chain', pending, '第一个回答')).toBeUndefined()
    const next = questionWizardStep('chain', pending)
    expect(next).toMatchObject({ index: 1, total: 2, id: 'q2' })
  })

  it('驱动不了的批返回 undefined', () => {
    expect(questionWizardStep('broken', questionPending([{ question: '没有 id' }]))).toBeUndefined()
    expect(questionWizardStep('empty', questionPending([]))).toBeUndefined()
  })
})

describe('advanceQuestionWizard', () => {
  it('最后一题答完给出完整批次，按题目顺序对齐', () => {
    const pending = questionPending([{ id: 'q1' }, { id: 'q2' }])
    expect(advanceQuestionWizard('batch', pending, '第一个')).toBeUndefined()
    expect(advanceQuestionWizard('batch', pending, '第二个')).toEqual([
      { id: 'q1', selected: [], custom: '第一个' },
      { id: 'q2', selected: [], custom: '第二个' },
    ])
  })

  it('单问题批次一次答完就提交', () => {
    const pending = questionPending([{ id: 'q1', question: '选哪个？' }])
    expect(advanceQuestionWizard('alone', pending, '  42  ')).toEqual([{ id: 'q1', selected: [], custom: '42' }])
  })

  it('空文本既不记草稿也不推进题号', () => {
    const pending = questionPending([{ id: 'q1' }, { id: 'q2' }])
    expect(advanceQuestionWizard('blank', pending, '   ')).toBeUndefined()
    expect(questionWizardStep('blank', pending)?.index).toBe(0)
  })

  it('提交后进度清空，下一次从第一题重新开始', () => {
    const pending = questionPending([{ id: 'q1' }])
    advanceQuestionWizard('again', pending, '答案')
    expect(questionWizardStep('again', pending)?.index).toBe(0)
  })
})

describe('syncQuestionWizard', () => {
  it('待处理交互换了身份就丢掉进度', () => {
    const pending = questionPending([{ id: 'q1' }, { id: 'q2' }])
    advanceQuestionWizard('switch', pending, '第一个')
    expect(questionWizardStep('switch', pending)?.index).toBe(1)
    syncQuestionWizard('switch', 'question:k2')
    expect(questionWizardStep('switch', pending)?.index).toBe(0)
  })

  it('身份不变时保留进度', () => {
    const pending = questionPending([{ id: 'q1' }, { id: 'q2' }])
    advanceQuestionWizard('keep', pending, '第一个')
    syncQuestionWizard('keep', 'question:k1')
    expect(questionWizardStep('keep', pending)?.index).toBe(1)
  })

  it('挂起消失时丢掉进度', () => {
    const pending = questionPending([{ id: 'q1' }, { id: 'q2' }])
    advanceQuestionWizard('gone', pending, '第一个')
    syncQuestionWizard('gone', undefined)
    expect(questionWizardStep('gone', pending)?.index).toBe(0)
  })
})
