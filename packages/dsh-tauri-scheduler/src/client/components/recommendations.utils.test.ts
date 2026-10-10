import type { TaskView } from '../types'
import type { RecommendationMatch } from './recommendations.utils'
import { describe, expect, it } from 'vitest'
import { recommendationMatchesTask } from './recommendations.utils'

const translations: Record<string, string> = {
  recReviewName: '每周回顾',
  recReviewPrompt: '每周五将你最近的工作整理成简明的状态更新',
  recWeekdayBriefingName: '工作日早报',
  recWeekdayBriefingPrompt: '我要创建一个定时任务，每【工作日】执行【汇总昨夜仓库变更并给出今日关注点】。',
}

const t = (key: string): string => translations[key] ?? key

function task(overrides: Partial<TaskView>): TaskView {
  return {
    id: 'task-1',
    name: '任务',
    schedule: { kind: 'workdays', time: '08:00', timeZone: 'Asia/Shanghai' },
    prompt: '任务指令',
    delivery: 'new-session',
    status: 'active',
    enabled: false,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  }
}

describe('recommendationMatchesTask', () => {
  it('matches persisted recommendation ids after refresh', () => {
    const recommendation: RecommendationMatch = { id: 'weekday-briefing', nameKey: 'recWeekdayBriefingName', promptKey: 'recWeekdayBriefingPrompt', schedule: { kind: 'workdays', time: '08:00' } }
    expect(recommendationMatchesTask(recommendation, task({ recommendationId: 'weekday-briefing' }), t)).toBe(true)
  })

  it('matches legacy recommendation tasks without an id', () => {
    const recommendation: RecommendationMatch = { id: 'weekday-briefing', nameKey: 'recWeekdayBriefingName', promptKey: 'recWeekdayBriefingPrompt', schedule: { kind: 'workdays', time: '08:00' } }
    expect(recommendationMatchesTask(recommendation, task({
      name: t('recWeekdayBriefingName'),
      prompt: t('recWeekdayBriefingPrompt'),
    }), t)).toBe(true)
  })

  it('does not hide a recommendation for an unrelated task', () => {
    const recommendation: RecommendationMatch = { id: 'weekday-briefing', nameKey: 'recWeekdayBriefingName', promptKey: 'recWeekdayBriefingPrompt', schedule: { kind: 'workdays', time: '08:00' } }
    expect(recommendationMatchesTask(recommendation, task({ recommendationId: 'another-recommendation' }), t)).toBe(false)
    expect(recommendationMatchesTask(recommendation, task({ name: t('recWeekdayBriefingName') }), t)).toBe(false)
  })
})
