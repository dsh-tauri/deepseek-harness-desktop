import type { NotifyWebhookSettings } from '../../shared/settings'
import type { DeliveryOutcome, NotifyTrigger } from '../types/index'
import { defineService } from 'dsh-tauri'
import { NOTIFY_CHANNEL_EMAIL, NOTIFY_CHANNEL_OFF, NOTIFY_CHANNEL_PUSHPLUS } from '../../shared/constants'
import { deliveryErrorOf } from '../utils/error'
import { sendMail } from './notifier.utils'
import { settings } from './settings'

const DELIVERY_TIMEOUT_MS = 15_000
const PUSHPLUS_ENDPOINT = 'https://www.pushplus.plus/send'

const SUBJECT_FALLBACK = 'DSH 通知'
const SUBJECT_MAX_CHARS = 200

const TEST_TITLE = 'DSH 通知推送测试'
const TEST_BODY = '这条消息由插件设置面板发出，收到即代表配置可用。'

export const notifier = defineService({
  async deliver(sessionId: string, title: string, trigger: NotifyTrigger): Promise<DeliveryOutcome> {
    const current = await settings.load()
    if (current.channel === NOTIFY_CHANNEL_OFF)
      return { ok: false, error: 'NOTIFY_UNCONFIGURED: channel' }
    if (trigger === 'completed' ? !current.notifyOnComplete : !current.notifyOnAbnormal)
      return { ok: false, error: 'NOTIFY_DISABLED: trigger' }
    return send(current, subjectOf(title), bodyOf(title, sessionId, trigger))
  },

  async test(): Promise<DeliveryOutcome> {
    const current = await settings.load()
    if (current.channel === NOTIFY_CHANNEL_OFF)
      return { ok: false, error: 'NOTIFY_UNCONFIGURED: channel' }
    return send(current, TEST_TITLE, TEST_BODY)
  },
})

// --- internal ---

async function send(current: NotifyWebhookSettings, subject: string, body: string): Promise<DeliveryOutcome> {
  try {
    if (current.channel === NOTIFY_CHANNEL_EMAIL) {
      await sendEmail(current, subject, body)
      return { ok: true }
    }
    if (current.channel === NOTIFY_CHANNEL_PUSHPLUS) {
      await sendPushplus(current, subject, body)
      return { ok: true }
    }
    return { ok: false, error: 'NOTIFY_UNCONFIGURED: channel' }
  }
  catch (error) {
    return { ok: false, error: deliveryErrorOf(error) }
  }
}

async function sendEmail(current: NotifyWebhookSettings, subject: string, body: string): Promise<void> {
  const { email } = current
  if (email.host === '' || email.from === '' || email.to === '')
    throw new Error('NOTIFY_UNCONFIGURED: email')
  await sendMail({ settings: email, subject, body, timeoutMs: DELIVERY_TIMEOUT_MS })
}

async function sendPushplus(current: NotifyWebhookSettings, subject: string, body: string): Promise<void> {
  const { token } = current.pushplus
  if (token === '')
    throw new Error('NOTIFY_UNCONFIGURED: pushplus')
  const response = await fetch(PUSHPLUS_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, title: subject, content: body, template: 'txt' }),
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  })
  if (!response.ok)
    throw new Error(`NOTIFY_REMOTE: HTTP ${response.status}`)
  const payload = await response.json() as { code?: unknown, msg?: unknown }
  if (payload.code !== 200)
    throw new Error(`NOTIFY_REMOTE: ${String(payload.msg ?? payload.code ?? 'pushplus')}`)
}

function subjectOf(title: string): string {
  const text = sanitize(title)
  return text === '' ? SUBJECT_FALLBACK : text
}

function bodyOf(title: string, sessionId: string, trigger: NotifyTrigger): string {
  const label = trigger === 'completed' ? '任务完成' : '任务异常停止'
  const name = sanitize(title)
  return name === '' ? `${label}\n会话：${sessionId}` : `${label}\n会话：${name}\n${sessionId}`
}

/** 换行折成空格：标题会进邮件头，裸换行等于头注入。 */
function sanitize(value: string): string {
  return value.replace(/[\r\n]/g, ' ').trim().slice(0, SUBJECT_MAX_CHARS)
}
