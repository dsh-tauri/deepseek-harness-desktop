import {
  NOTIFY_CHANNEL_OFF,
  NOTIFY_SMTP_DEFAULT_PORT,
  NOTIFY_SMTP_PLAIN,
  NOTIFY_SMTP_SECURITIES,
  NOTIFY_SMTP_STARTTLS,
  NOTIFY_SMTP_TLS,
  NOTIFY_WEBHOOK_CHANNELS,
} from './constants'

export interface NotifyEmailSettings {
  host: string
  port: number
  security: string
  username: string
  password: string
  from: string
  to: string
}

export interface NotifyPushplusSettings {
  token: string
}

export interface NotifyWebhookSettings {
  channel: string
  notifyOnComplete: boolean
  notifyOnAbnormal: boolean
  email: NotifyEmailSettings
  pushplus: NotifyPushplusSettings
}

export const NOTIFY_WEBHOOK_DEFAULTS: NotifyWebhookSettings = {
  channel: NOTIFY_CHANNEL_OFF,
  notifyOnComplete: true,
  notifyOnAbnormal: true,
  email: {
    host: '',
    port: NOTIFY_SMTP_DEFAULT_PORT,
    security: NOTIFY_SMTP_STARTTLS,
    username: '',
    password: '',
    from: '',
    to: '',
  },
  pushplus: { token: '' },
}

/** 加密方式决定默认端口：SSL/TLS 走 465，不加密走 25，STARTTLS 走 587。 */
export function notifySmtpDefaultPort(security: string): number {
  if (security === NOTIFY_SMTP_TLS)
    return 465
  if (security === NOTIFY_SMTP_PLAIN)
    return 25
  return NOTIFY_SMTP_DEFAULT_PORT
}

/** 前端归一化 + 后端兜底共用：任何字段非法都退回默认值，不让坏数据进设置页或投递路径。 */
export function normalizeNotifyWebhook(value: unknown): NotifyWebhookSettings {
  const source = recordOf(value)
  const email = recordOf(source.email)
  const pushplus = recordOf(source.pushplus)
  const security = oneOf(NOTIFY_SMTP_SECURITIES, textOf(email.security), NOTIFY_SMTP_STARTTLS)
  return {
    channel: oneOf(NOTIFY_WEBHOOK_CHANNELS, textOf(source.channel), NOTIFY_CHANNEL_OFF),
    notifyOnComplete: source.notifyOnComplete !== false,
    notifyOnAbnormal: source.notifyOnAbnormal !== false,
    email: {
      host: textOf(email.host),
      port: portOf(email.port, security),
      security,
      username: textOf(email.username),
      password: textOf(email.password),
      from: textOf(email.from),
      to: textOf(email.to),
    },
    pushplus: { token: textOf(pushplus.token) },
  }
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function oneOf(values: readonly string[], value: string, fallback: string): string {
  return values.includes(value) ? value : fallback
}

function portOf(value: unknown, security: string): number {
  const port = typeof value === 'string' ? Number(value) : value
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65_535 ? port : notifySmtpDefaultPort(security)
}
