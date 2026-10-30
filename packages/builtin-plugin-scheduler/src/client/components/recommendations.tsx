import type { IconComponent } from 'dsh-tauri-ui/client'
import type { ReactElement } from 'react'
import type { LocaleKey, Translate } from '../locales/index.types'
import type { ScheduleForm, TaskFormState, TaskView } from '../types'
import { Calendar, Icon, styles as sharedStyles, Text } from 'dsh-tauri-ui/client'
import { useRef, useState } from 'react'
import { createTask } from '../service/scheduler'
import { recommendationMatchesTask } from './recommendations.utils'
import { describeSchedule } from './schedule.utils'

type IconLike = IconComponent

export interface Recommendation {
  id: string
  nameKey: LocaleKey
  promptKey: LocaleKey
  schedule: ScheduleForm
  accent: string
  icon: IconLike
  form: (t: Translate) => TaskFormState
}

export const RECOMMENDATIONS: Recommendation[] = [
  {
    id: 'weekly-review',
    nameKey: 'recReviewName',
    promptKey: 'recReviewPrompt',
    schedule: { kind: 'weekly', weekdays: ['FR'], time: '16:00' },
    accent: sharedStyles.business,
    icon: Calendar,
    form: t => ({ delivery: 'new-session', sessionId: '', enabled: false, name: t('recReviewName'), schedule: { kind: 'weekly', weekdays: ['FR'], time: '16:00' }, prompt: t('recReviewPrompt'), workspaceId: '', permission: 'read-only', provider: '', model: '', reasoningEffort: '' }),
  },
  {
    id: 'weekday-briefing',
    nameKey: 'recWeekdayBriefingName',
    promptKey: 'recWeekdayBriefingPrompt',
    schedule: { kind: 'workdays', time: '08:00' },
    accent: sharedStyles.success,
    icon: Calendar,
    form: t => ({ delivery: 'new-session', sessionId: '', enabled: false, name: t('recWeekdayBriefingName'), schedule: { kind: 'workdays', time: '08:00' }, prompt: t('recWeekdayBriefingPrompt'), workspaceId: '', permission: 'read-only', provider: '', model: '', reasoningEffort: '' }),
  },
]

export interface RecommendationsProps {
  t: Translate
  tasks: readonly TaskView[]
  onSelect?: (form: TaskFormState) => void
}

export function Recommendations({ t, tasks, onSelect }: RecommendationsProps): ReactElement {
  const pendingRef = useRef(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  async function add(rec: Recommendation): Promise<void> {
    if (pendingRef.current)
      return
    const form = { ...rec.form(t), recommendationId: rec.id }
    if (onSelect) {
      onSelect(form)
      return
    }
    pendingRef.current = true
    setSaving(true)
    setError('')
    const result = await createTask({
      delivery: 'new-session',
      name: form.name,
      schedule: form.schedule,
      prompt: form.prompt,
      workspaceId: form.workspaceId || undefined,
      permission: form.permission,
      recommendationId: rec.id,
      enabled: false,
    })
    pendingRef.current = false
    setSaving(false)
    if (!result.ok)
      setError(result.error ?? t('createFailed'))
  }

  const visible = RECOMMENDATIONS.filter(rec => !tasks.some(task => recommendationMatchesTask(rec, task, t)))

  return (
    <section className="flex flex-col gap-[8px] mt-[20px]" aria-label={t('recommended')}>
      <h2 className="m-0 text-[13px] leading-[20px] font-semibold">{t('recommended')}</h2>
      {error ? <Text tone="error" role="alert">{error}</Text> : null}
      {visible.length === 0
        ? <p className="m-0 text-secondary text-[12px]">{t('recommendedEmpty')}</p>
        : (
            <ul className="flex flex-col gap-[8px] m-0 p-0 list-none">
              {visible.map(rec => (
                <li key={rec.id}>
                  <button type="button" disabled={saving} className="box-border flex items-start gap-[10px] w-full min-w-0 px-[12px] py-[10px] border-none rounded-[10px] bg-transparent text-inherit [font-family:inherit] text-[13px] leading-[20px] text-left cursor-pointer hover:bg-hover" onClick={() => void add(rec)}>
                    <span className="flex-none inline-flex mt-[2px] text-[16px]" style={{ color: rec.accent }}>
                      <Icon as={rec.icon} />
                    </span>
                    <span className="flex flex-col gap-[2px] min-w-0">
                      <span className="text-primary text-[13px] leading-[18px] font-medium">
                        {t(rec.nameKey)}
                        {' '}
                        <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{describeSchedule(rec.schedule, t)}</span>
                      </span>
                      <span className="text-tertiary text-[12px] leading-[18px] truncate">{t(rec.promptKey)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
    </section>
  )
}
