import { SCHEDULE_KINDS } from '../../shared/constants'

export const scheduleParameters = {
  type: 'object',
  description: 'Schedule spec: once/hourly/daily/interval/workdays/weekly/monthly/custom.',
  properties: {
    kind: { type: 'string', enum: [...SCHEDULE_KINDS] },
    timeZone: { type: 'string', description: 'IANA time zone for the calendar schedule; defaults to the host zone.' },
    time: { type: 'string', description: '"HH:mm" for daily/workdays/weekly/monthly/custom.' },
    everyMinutes: { type: 'number', description: 'Interval minutes for kind=interval.' },
    everyDays: { type: 'number', description: 'Interval days for kind=custom.' },
    anchor: { type: 'string', description: 'ISO anchor for fixed interval/custom recurrence.' },
    at: { type: 'string', description: 'ISO timestamp for kind=once.' },
    minute: { type: 'number', description: 'Minute of hour for kind=hourly.' },
    day: { type: 'number', description: 'Day of month for kind=monthly.' },
    weekdays: { type: 'array', items: { type: 'string' }, description: '["MO","TU",...] for kind=weekly.' },
  },
  required: ['kind'],
}

// 核心校验器只认 `oneOf`；`type: ['string','null']` 与 `anyOf` 都会抛错。
export const nullableText = { oneOf: [{ type: 'string' }, { type: 'null' }] }

export function textBlock(text: string): Array<{ type: 'text', text: string }> {
  return [{ type: 'text', text }]
}
