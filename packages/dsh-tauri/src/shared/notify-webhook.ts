export const NOTIFY_WEBHOOK_CHANNELS = ['off', 'email', 'pushplus'] as const
export const NOTIFY_SMTP_SECURITIES = ['starttls', 'tls', 'plain'] as const

/** 加密方式对应的默认端口：STARTTLS 587、隐式 TLS 465、明文 25。 */
export const NOTIFY_SMTP_DEFAULT_PORT = 587

export interface NotifyEmail {
  smtpHost: string
  smtpPort: number
  smtpSecurity: typeof NOTIFY_SMTP_SECURITIES[number]
  smtpUsername: string
  smtpPassword: string
  from: string
  to: string
}

export interface NotifyPushplus {
  token: string
}

export interface NotifyWebhook {
  channel: typeof NOTIFY_WEBHOOK_CHANNELS[number]
  email: NotifyEmail
  pushplus: NotifyPushplus
}

export const NOTIFY_WEBHOOK_DEFAULTS = {
  channel: 'off',
  email: {
    smtpHost: '',
    smtpPort: NOTIFY_SMTP_DEFAULT_PORT,
    smtpSecurity: 'starttls',
    smtpUsername: '',
    smtpPassword: '',
    from: '',
    to: '',
  },
  pushplus: { token: '' },
} as const

export function notifySmtpDefaultPort(security: unknown): number {
  if (security === 'tls')
    return 465
  if (security === 'plain')
    return 25
  return NOTIFY_SMTP_DEFAULT_PORT
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function normalizeNotifyEmail(value: unknown): NotifyEmail {
  const input = value as Partial<NotifyEmail> | null | undefined
  const security = NOTIFY_SMTP_SECURITIES.includes(input?.smtpSecurity as NotifyEmail['smtpSecurity'])
    ? input!.smtpSecurity!
    : 'starttls'
  const port = typeof input?.smtpPort === 'number' && Number.isFinite(input.smtpPort) ? Math.round(input.smtpPort) : 0
  return {
    smtpHost: text(input?.smtpHost),
    // 端口 0 不是有效 SMTP 端口：回落到当前加密方式的默认端口，与 Rust 侧一致
    smtpPort: port > 0 && port <= 65535 ? port : notifySmtpDefaultPort(security),
    smtpSecurity: security,
    smtpUsername: text(input?.smtpUsername),
    smtpPassword: typeof input?.smtpPassword === 'string' ? input.smtpPassword : '',
    from: text(input?.from),
    to: text(input?.to),
  }
}

export function normalizeNotifyWebhook(value: unknown): NotifyWebhook {
  const input = value as Partial<NotifyWebhook> | null | undefined
  return {
    channel: NOTIFY_WEBHOOK_CHANNELS.includes(input?.channel as NotifyWebhook['channel']) ? input!.channel! : 'off',
    email: normalizeNotifyEmail(input?.email),
    pushplus: { token: text((input?.pushplus as Partial<NotifyPushplus> | null | undefined)?.token) },
  }
}
