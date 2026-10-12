/** 插件唯一标识：同时作为 locale 命名空间、设置区块 id 与日志前缀。 */
export const PLUGIN_ID = 'dsh-tauri-notify-webhook'

export const NOTIFY_CHANNEL_OFF = 'off'
export const NOTIFY_CHANNEL_EMAIL = 'email'
export const NOTIFY_CHANNEL_PUSHPLUS = 'pushplus'

export const NOTIFY_WEBHOOK_CHANNELS: readonly string[] = [NOTIFY_CHANNEL_OFF, NOTIFY_CHANNEL_EMAIL, NOTIFY_CHANNEL_PUSHPLUS]

export const NOTIFY_SMTP_STARTTLS = 'starttls'
export const NOTIFY_SMTP_TLS = 'tls'
export const NOTIFY_SMTP_PLAIN = 'plain'

export const NOTIFY_SMTP_SECURITIES: readonly string[] = [NOTIFY_SMTP_STARTTLS, NOTIFY_SMTP_TLS, NOTIFY_SMTP_PLAIN]

export const NOTIFY_SMTP_DEFAULT_PORT = 587
