import type { NotifyEmail, NotifyWebhook } from '../../../../packages/dsh-tauri/src/shared/notify-webhook'
import { Button, Description, Input, ListBox, Select, Spinner } from '@heroui/react'
import { useMutation } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { store } from '@/store'
import { toast } from '@/utils/toast'
import { normalizeNotifyWebhook, NOTIFY_SMTP_SECURITIES, NOTIFY_WEBHOOK_CHANNELS, notifySmtpDefaultPort } from '../../../../packages/dsh-tauri/src/shared/notify-webhook'

const CHANNEL_LABEL_KEYS = { off: 'notify.channel_off', email: 'notify.channel_email', pushplus: 'notify.channel_pushplus' }
const SECURITY_LABEL_KEYS = { starttls: 'notify.security_starttls', tls: 'notify.security_tls', plain: 'notify.security_plain' }

/** 窗口失焦时把系统通知转发到邮件 / pushplus：渠道即时生效，文本字段攒成草稿一次保存。 */
export function ConfigNotifyWebhook() {
  const { t } = useTranslation()
  const { notify_webhook: saved } = useStore(store.setting)
  const webhook = normalizeNotifyWebhook(saved)
  const [draft, setDraft] = useState<{ email: NotifyEmail, token: string } | null>(null)
  const email = draft?.email ?? webhook.email
  const token = draft?.token ?? webhook.pushplus.token

  const { mutate: setChannel, isPending: savingChannel } = useMutation({
    mutationFn: (channel: NotifyWebhook['channel']) => store.setting.update({ notifyWebhook: normalizeNotifyWebhook({ ...webhook, channel }) }),
    onError: (error: unknown) => {
      console.error('[ConfigNotifyWebhook] channel update failed:', error)
      toast(t('messages.notify_webhook_save_failed'), { variant: 'danger' })
    },
  })

  const { mutate: save, isPending: savingDraft } = useMutation({
    mutationFn: (pending: { email: NotifyEmail, token: string }) => commit(pending),
    onSuccess: (_saved, pending) => setDraft(current => current === pending ? null : current),
    onError: (error: unknown) => {
      console.error('[ConfigNotifyWebhook] save failed:', error)
      toast(t('messages.notify_webhook_save_failed'), { variant: 'danger' })
    },
  })

  const { mutate: runTest, isPending: testing } = useMutation({
    mutationFn: async () => {
      // 测的是已保存的配置：输入框里有未保存的改动时先落盘，免得测到旧值
      if (draft) {
        await commit(draft)
        setDraft(null)
      }
      await invoke('test_notify_webhook')
    },
    onSuccess: () => toast(t('messages.notify_webhook_test_sent')),
    onError: (error: unknown) => {
      console.error('[ConfigNotifyWebhook] test failed:', error)
      toast(t('messages.notify_webhook_test_failed'), { variant: 'danger', description: String(error) })
    },
  })

  function commit(pending: { email: NotifyEmail, token: string }) {
    return store.setting.update({
      notifyWebhook: normalizeNotifyWebhook({ ...webhook, email: pending.email, pushplus: { token: pending.token } }),
    })
  }

  function updateEmail(patch: Partial<NotifyEmail>) {
    setDraft(current => ({ email: { ...(current?.email ?? webhook.email), ...patch }, token: current?.token ?? webhook.pushplus.token }))
  }

  function updateSecurity(security: NotifyEmail['smtpSecurity']) {
    // 换加密方式时把还停在旧默认值的端口一并带过去，用户自己填过的端口保持不动
    const carried = email.smtpPort === notifySmtpDefaultPort(email.smtpSecurity) ? notifySmtpDefaultPort(security) : email.smtpPort
    updateEmail({ smtpSecurity: security, smtpPort: carried })
  }

  const busy = savingChannel || savingDraft || testing

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-ink">{t('notify.channel')}</span>
        <Select
          variant="secondary"
          selectedKey={webhook.channel}
          onSelectionChange={key => setChannel(key as NotifyWebhook['channel'])}
          isDisabled={busy}
          className="w-[140px]"
          aria-label={t('notify.channel')}
        >
          <Select.Trigger className="min-h-8! h-8 py-0 items-center" data-testid="dsh-notify-channel">
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {NOTIFY_WEBHOOK_CHANNELS.map(channel => (
                <ListBox.Item className="min-h-8!" id={channel} key={channel} textValue={t(CHANNEL_LABEL_KEYS[channel])}>{t(CHANNEL_LABEL_KEYS[channel])}</ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      </div>
      <p className="text-[10px] text-muted/70">{t('notify.channel_hint')}</p>

      <If cond={webhook.channel === 'email'}>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-ink">{t('notify.smtp_host')}</span>
            <Input
              variant="secondary"
              autoComplete="off"
              spellCheck={false}
              value={email.smtpHost}
              onChange={e => updateEmail({ smtpHost: e.target.value })}
              className="w-52 h-8"
              aria-label={t('notify.smtp_host')}
              data-testid="dsh-notify-smtp-host"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-ink">{t('notify.smtp_port')}</span>
            <Input
              type="number"
              variant="secondary"
              value={String(email.smtpPort)}
              onChange={e => updateEmail({ smtpPort: Number(e.target.value) })}
              className="w-24 h-8 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              aria-label={t('notify.smtp_port')}
              data-testid="dsh-notify-smtp-port"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-ink">{t('notify.smtp_security')}</span>
            <Select
              variant="secondary"
              selectedKey={email.smtpSecurity}
              onSelectionChange={key => updateSecurity(key as NotifyEmail['smtpSecurity'])}
              className="w-[140px]"
              aria-label={t('notify.smtp_security')}
            >
              <Select.Trigger className="min-h-8! h-8 py-0 items-center" data-testid="dsh-notify-smtp-security">
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {NOTIFY_SMTP_SECURITIES.map(security => (
                    <ListBox.Item className="min-h-8!" id={security} key={security} textValue={t(SECURITY_LABEL_KEYS[security])}>{t(SECURITY_LABEL_KEYS[security])}</ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-ink">{t('notify.smtp_username')}</span>
            <Input
              variant="secondary"
              autoComplete="off"
              spellCheck={false}
              value={email.smtpUsername}
              onChange={e => updateEmail({ smtpUsername: e.target.value })}
              className="w-52 h-8"
              aria-label={t('notify.smtp_username')}
              data-testid="dsh-notify-smtp-username"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-ink">{t('notify.smtp_password')}</span>
            <Input
              type="password"
              variant="secondary"
              autoComplete="new-password"
              value={email.smtpPassword}
              onChange={e => updateEmail({ smtpPassword: e.target.value })}
              className="w-52 h-8"
              aria-label={t('notify.smtp_password')}
              data-testid="dsh-notify-smtp-password"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-ink">{t('notify.from')}</span>
            <Input
              variant="secondary"
              autoComplete="off"
              spellCheck={false}
              value={email.from}
              onChange={e => updateEmail({ from: e.target.value })}
              className="w-52 h-8"
              aria-label={t('notify.from')}
              data-testid="dsh-notify-from"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-ink">{t('notify.to')}</span>
            <Input
              variant="secondary"
              autoComplete="off"
              spellCheck={false}
              value={email.to}
              onChange={e => updateEmail({ to: e.target.value })}
              className="w-52 h-8"
              aria-label={t('notify.to')}
              data-testid="dsh-notify-to"
            />
          </div>
          <Description className="text-[10px] text-muted/70">{t('notify.email_hint')}</Description>
        </div>
      </If>

      <If cond={webhook.channel === 'pushplus'}>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-ink">{t('notify.pushplus_token')}</span>
            <Input
              variant="secondary"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={e => setDraft(current => ({ email: current?.email ?? webhook.email, token: e.target.value }))}
              className="w-52 h-8"
              aria-label={t('notify.pushplus_token')}
              data-testid="dsh-notify-token"
            />
          </div>
          <Description className="text-[10px] text-muted/70">{t('notify.pushplus_hint')}</Description>
        </div>
      </If>

      <If cond={webhook.channel !== 'off'}>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="primary"
            className="h-8"
            onPress={() => save(draft ?? { email, token })}
            isDisabled={busy || draft === null}
            data-testid="dsh-notify-save"
          >
            {t('buttons.save')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="h-8"
            onPress={() => runTest()}
            isDisabled={busy}
            data-testid="dsh-notify-test"
          >
            {testing ? <Spinner size="sm" color="current" /> : t('notify.test')}
          </Button>
        </div>
      </If>
    </div>
  )
}
