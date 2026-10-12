import type { ReactNode } from 'react'
import { Button, Input, Select, Switch } from 'dsh-tauri-ui/client'
import { cn, useStore } from 'dsh-tauri/client'
import { useEffect, useState } from 'react'
import { NOTIFY_CHANNEL_EMAIL, NOTIFY_CHANNEL_OFF, NOTIFY_CHANNEL_PUSHPLUS, NOTIFY_SMTP_PLAIN, NOTIFY_SMTP_STARTTLS, NOTIFY_SMTP_TLS } from '../../shared/constants'
import { normalizeNotifyWebhook } from '../../shared/settings'
import { locale } from '../locales'
import * as service from '../service/settings'
import { store } from '../store/index'

type FieldSpan = 3 | 4 | 5 | 6 | 8 | 12

interface Notice {
  ok: boolean
  text: string
}

function Field({ label, hint, span = 6, children }: { label: string, hint?: string, span?: FieldSpan, children: ReactNode }): ReactNode {
  return (
    <label
      className={cn('flex min-w-0 flex-col gap-[6px] max-[520px]:col-span-6!', {
        3: 'col-span-3',
        4: 'col-span-4 max-[760px]:col-span-3',
        5: 'col-span-5 max-[760px]:col-span-3',
        6: 'col-span-6 max-[760px]:col-span-3',
        8: 'col-span-8 max-[760px]:col-span-6',
        12: 'col-span-12 max-[760px]:col-span-6',
      }[span])}
    >
      <span className="text-[12px] leading-[18px] font-medium text-secondary">{label}</span>
      {children}
      {hint === undefined ? null : <span className="text-[12px] leading-[18px] text-secondary">{hint}</span>}
    </label>
  )
}

function TriggerRow({ label, hint, checked, onChange }: { label: string, hint: string, checked: boolean, onChange: (next: boolean) => void }): ReactNode {
  return (
    <span className="inline-flex items-center gap-[8px]">
      <Switch checked={checked} label={label} onChange={onChange} />
      <span className="flex flex-col">
        <span className="text-[12px] leading-[18px] font-medium text-secondary">{label}</span>
        <span className="text-[12px] leading-[18px] text-secondary">{hint}</span>
      </span>
    </span>
  )
}

const GRID = 'grid grid-cols-[repeat(12,minmax(0,1fr))] gap-[10px_12px] max-[760px]:grid-cols-[repeat(6,minmax(0,1fr))]'
const PANEL = 'flex flex-col gap-[10px] rounded-[8px] border border-border-l2 bg-[var(--dsw-alias-surface-tinted)] px-[12px] py-[10px]'

export function NotifyWebhookSection(): ReactNode {
  locale.useLocale()
  const { status, error, busy, values } = useStore(store.settings)
  const [notice, setNotice] = useState<Notice | null>(null)
  const text = locale.text

  useEffect(() => {
    void service.loadSettings()
  }, [])

  if (status === 'idle' || status === 'loading')
    return <p className="m-0 text-[12px] leading-[18px] text-secondary" data-testid="notify-webhook-loading">{text('loading')}</p>

  if (status === 'failed')
    return <p className="m-0 text-[12px] leading-[18px] text-error" role="alert" data-testid="notify-webhook-error">{text('loadFailed', { error: error ?? '' })}</p>

  const save = async (): Promise<void> => {
    setNotice(null)
    const result = await service.saveSettings(normalizeNotifyWebhook(store.settings.values))
    setNotice(result.ok ? { ok: true, text: text('saveOk') } : { ok: false, text: text('saveFailed', { error: result.error ?? '' }) })
  }

  const test = async (): Promise<void> => {
    setNotice(null)
    const result = await service.sendTest()
    setNotice(result.ok ? { ok: true, text: text('testOk') } : { ok: false, text: text('testFailed', { error: result.error ?? '' }) })
  }

  const channelOptions = [
    { value: NOTIFY_CHANNEL_OFF, label: text('channelOff') },
    { value: NOTIFY_CHANNEL_EMAIL, label: text('channelEmail') },
    { value: NOTIFY_CHANNEL_PUSHPLUS, label: text('channelPushplus') },
  ]
  const securityOptions = [
    { value: NOTIFY_SMTP_STARTTLS, label: text('securityStarttls') },
    { value: NOTIFY_SMTP_TLS, label: text('securityTls') },
    { value: NOTIFY_SMTP_PLAIN, label: text('securityPlain') },
  ]

  return (
    <div className="flex flex-col gap-[12px] max-w-[960px] text-primary" data-testid="notify-webhook-section">
      <p className="m-0 text-[13px] leading-[21px] text-secondary">{text('intro')}</p>
      <div className={GRID}>
        <Field label={text('channel')} hint={text('channelHint')} span={4}>
          <Select
            options={channelOptions}
            value={values.channel}
            label={text('channel')}
            disabled={busy !== 'idle'}
            onChange={next => store.settings.patch({ channel: next })}
          />
        </Field>
        <Field label={text('trigger')} span={8}>
          <span className="flex flex-col gap-[8px]">
            <TriggerRow
              label={text('triggerComplete')}
              hint={text('triggerCompleteHint')}
              checked={values.notifyOnComplete}
              onChange={next => store.settings.patch({ notifyOnComplete: next })}
            />
            <TriggerRow
              label={text('triggerAbnormal')}
              hint={text('triggerAbnormalHint')}
              checked={values.notifyOnAbnormal}
              onChange={next => store.settings.patch({ notifyOnAbnormal: next })}
            />
          </span>
        </Field>
      </div>
      <div className={PANEL}>
        <span className="text-[12px] leading-[18px] font-medium text-primary">{text('email')}</span>
        <div className={GRID}>
          <Field label={text('smtpHost')} span={6}>
            <Input className="box-border w-full" value={values.email.host} onChange={event => store.settings.patchEmail({ host: event.target.value })} />
          </Field>
          <Field label={text('smtpPort')} span={3}>
            <Input className="box-border w-full" type="number" value={values.email.port} onChange={event => store.settings.patchEmail({ port: event.target.value })} />
          </Field>
          <Field label={text('smtpSecurity')} span={3}>
            <Select
              options={securityOptions}
              value={values.email.security}
              label={text('smtpSecurity')}
              disabled={busy !== 'idle'}
              onChange={next => store.settings.patchEmail({ security: next })}
            />
          </Field>
          <Field label={text('smtpUsername')} hint={text('smtpOptional')} span={6}>
            <Input className="box-border w-full" value={values.email.username} onChange={event => store.settings.patchEmail({ username: event.target.value })} />
          </Field>
          <Field label={text('smtpPassword')} hint={text('smtpOptional')} span={6}>
            <Input className="box-border w-full" type="password" value={values.email.password} onChange={event => store.settings.patchEmail({ password: event.target.value })} />
          </Field>
          <Field label={text('smtpFrom')} span={6}>
            <Input className="box-border w-full" value={values.email.from} onChange={event => store.settings.patchEmail({ from: event.target.value })} />
          </Field>
          <Field label={text('smtpTo')} span={6}>
            <Input className="box-border w-full" value={values.email.to} onChange={event => store.settings.patchEmail({ to: event.target.value })} />
          </Field>
        </div>
        <span className="text-[12px] leading-[18px] text-secondary">{text('emailHint')}</span>
      </div>
      <div className={PANEL}>
        <span className="text-[12px] leading-[18px] font-medium text-primary">{text('pushplus')}</span>
        <div className={GRID}>
          <Field label={text('pushplusToken')} span={12}>
            <Input className="box-border w-full" type="password" value={values.pushplus.token} onChange={event => store.settings.patchPushplus({ token: event.target.value })} />
          </Field>
        </div>
        <span className="text-[12px] leading-[18px] text-secondary">{text('pushplusHint')}</span>
      </div>
      <div className="flex flex-wrap items-center gap-[8px]">
        <Button
          variant="outline"
          size="sm"
          data-testid="notify-webhook-test"
          disabled={busy !== 'idle'}
          onClick={() => { void test() }}
        >
          {busy === 'testing' ? text('testing') : text('test')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          data-testid="notify-webhook-save"
          disabled={busy !== 'idle'}
          onClick={() => { void save() }}
        >
          {busy === 'saving' ? text('saving') : text('save')}
        </Button>
        {notice === null
          ? null
          : (
              <span
                className={cn('text-[12px] leading-[18px]', notice.ok ? 'text-success' : 'text-error')}
                role={notice.ok ? undefined : 'alert'}
                data-testid="notify-webhook-notice"
              >
                {notice.text}
              </span>
            )}
      </div>
    </div>
  )
}
