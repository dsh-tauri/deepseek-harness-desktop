// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readLocale, readSource } from './setup/read-source'

/**
 * 通知 webhook 的跨层契约：前端只在窗口失焦时转发，后端按渠道投递，
 * 两侧共享同一份取值白名单。断言的是字面量，不是行为——行为由
 * `packages/dsh-tauri/src/shared/notify-webhook.test.ts` 与 Rust 侧的假服务器用例覆盖。
 */
const IF = 'src/layout/components/iframe.tsx'
const FOREGROUND = 'src/utils/notify-foreground.ts'
const PANEL = 'src/ui/config/components/notify-webhook.tsx'
const SHARED = 'packages/dsh-tauri/src/shared/notify-webhook.ts'
const STORE = 'src/store/modules/setting/store.ts'
const RUST = 'src-tauri/src/config/notify_webhook.rs'
const BRIDGE = 'src-tauri/src/bridge/config.rs'
const SETTING = 'src-tauri/src/config/setting.rs'
const BUILDER = 'src-tauri/src/desktop/builder.rs'
const CONSTANTS = 'src-tauri/src/config/constants.rs'
const PANEL_SOURCE = readSource(PANEL)

describe('notification webhook foreground gate', () => {
  it('treats the bridged document.hidden as the only focus source', () => {
    const source = readSource(FOREGROUND)

    expect(source).toContain('export function isNotificationForeground(): boolean')
    expect(source).toContain('return typeof document === \'undefined\' || document.hidden !== true')
  })

  it('dispatches the webhook only when the window is not in the foreground', () => {
    const source = readSource(IF)
    const guard = source.indexOf('if (!isNotificationForeground())')
    const dispatch = source.indexOf('invoke(\'notify_webhook_dispatch\'')

    expect(guard).toBeGreaterThan(-1)
    expect(dispatch).toBeGreaterThan(guard)
    expect(source).toContain('import { isNotificationForeground } from \'@/utils/notify-foreground\'')
  })

  it('passes the notification title, body and session through unchanged', () => {
    expect(readSource(IF)).toContain('invoke(\'notify_webhook_dispatch\', { payload: { title, body, sessionId: data.sessionId ?? \'\' } })')
  })
})

describe('notification webhook configuration contract', () => {
  it('shares one channel and security whitelist between both sides', () => {
    const shared = readSource(SHARED)
    const rust = readSource(RUST)

    expect(shared).toContain('export const NOTIFY_WEBHOOK_CHANNELS = [\'off\', \'email\', \'pushplus\'] as const')
    expect(shared).toContain('export const NOTIFY_SMTP_SECURITIES = [\'starttls\', \'tls\', \'plain\'] as const')
    expect(shared).toContain('export const NOTIFY_SMTP_DEFAULT_PORT = 587')
    expect(rust).toContain('pub const NOTIFY_CHANNEL_OFF: &str = "off";')
    expect(rust).toContain('pub const NOTIFY_CHANNEL_EMAIL: &str = "email";')
    expect(rust).toContain('pub const NOTIFY_CHANNEL_PUSHPLUS: &str = "pushplus";')
    expect(rust).toContain('pub const NOTIFY_SMTP_STARTTLS: &str = "starttls";')
    expect(rust).toContain('pub const NOTIFY_SMTP_TLS: &str = "tls";')
    expect(rust).toContain('pub const NOTIFY_SMTP_PLAIN: &str = "plain";')
    expect(rust).toContain('pub const NOTIFY_SMTP_DEFAULT_PORT: u16 = 587;')
  })

  it('sends a real message only through the saved proxy and a 15s deadline', () => {
    expect(readSource(CONSTANTS)).toContain('pub const NOTIFY_WEBHOOK_TIMEOUT: Duration = Duration::from_secs(15);')
    expect(readSource(RUST)).toContain('pub const NOTIFY_PUSHPLUS_ENDPOINT: &str = "https://www.pushplus.plus/send";')
    expect(readSource(RUST)).toContain('send_pushplus(proxy_url, &webhook.pushplus, payload, NOTIFY_PUSHPLUS_ENDPOINT).await')
    expect(readSource(RUST)).toContain('deliver(&setting.notify_webhook, &setting.proxy_url, &payload).await')
  })

  it('keeps the off channel a no-op instead of an error', () => {
    const rust = readSource(RUST)

    expect(rust).toContain('if setting.notify_webhook.channel == NOTIFY_CHANNEL_OFF {')
    expect(rust).toContain('return Ok(());')
  })

  it('never leaks credentials into an error string', () => {
    const rust = readSource(RUST)

    for (const code of ['NOTIFY_UNCONFIGURED', 'NOTIFY_INVALID', 'NOTIFY_TIMEOUT', 'NOTIFY_REJECTED', 'NOTIFY_RESPONSE', 'NOTIFY_CONNECT', 'NOTIFY_SHUTDOWN', 'NOTIFY_PUSHPLUS']) {
      expect(rust).toContain(`${code}: `)
      expect(rust).toContain(`"${code}`)
    }
  })

  it('registers both commands and both config entry points', () => {
    expect(readSource(BRIDGE)).toContain('pub async fn notify_webhook_dispatch(')
    expect(readSource(BRIDGE)).toContain('pub async fn test_notify_webhook(app_handle: AppHandle) -> Result<(), String> {')
    expect(readSource(BRIDGE)).toContain('setting.notify_webhook = webhook;')
    expect(readSource(BUILDER)).toContain('crate::bridge::notify_webhook_dispatch,')
    expect(readSource(BUILDER)).toContain('crate::bridge::test_notify_webhook,')
    expect(readSource(SETTING)).toContain('replacement.notify_webhook.clone_from(&current.notify_webhook);')
  })

  it('replaces the whole webhook block so clearing a password is expressible', () => {
    const bridge = readSource(BRIDGE)

    expect(bridge).toContain('notify_webhook: Option<config::notify_webhook::NotifyWebhook>,')
    expect(bridge).toContain('if let Some(webhook) = notify_webhook {')
  })
})

describe('notification webhook settings panel contract', () => {
  it('writes through the setting store instead of its own cache', () => {
    expect(PANEL_SOURCE).toContain('export function ConfigNotifyWebhook')
    expect(PANEL_SOURCE).toContain('useStore(store.setting)')
    expect(PANEL_SOURCE).toContain('store.setting.update({ notifyWebhook: normalizeNotifyWebhook(')
    expect(PANEL_SOURCE).not.toContain('useCallback')
    expect(PANEL_SOURCE).not.toContain('useMemo')
    expect(PANEL_SOURCE).not.toContain('useQueryClient')
  })

  it('tests the saved configuration by flushing the pending draft first', () => {
    const flush = PANEL_SOURCE.indexOf('if (draft) {')
    const test = PANEL_SOURCE.indexOf('invoke(\'test_notify_webhook\')')

    expect(flush).toBeGreaterThan(-1)
    expect(test).toBeGreaterThan(flush)
  })

  it('carries the default port when the security mode changes', () => {
    expect(PANEL_SOURCE).toContain('const carried = email.smtpPort === notifySmtpDefaultPort(email.smtpSecurity) ? notifySmtpDefaultPort(security) : email.smtpPort')
  })

  it('hydrates the store with the shared defaults', () => {
    const store = readSource(STORE)

    expect(store).toContain('notify_webhook: normalizeNotifyWebhook(NOTIFY_WEBHOOK_DEFAULTS),')
  })
})

describe('notification webhook locale keys', () => {
  const KEYS = [
    'notify.channel',
    'notify.channel_hint',
    'notify.channel_off',
    'notify.channel_email',
    'notify.channel_pushplus',
    'notify.smtp_host',
    'notify.smtp_port',
    'notify.smtp_security',
    'notify.security_starttls',
    'notify.security_tls',
    'notify.security_plain',
    'notify.smtp_username',
    'notify.smtp_password',
    'notify.from',
    'notify.to',
    'notify.email_hint',
    'notify.pushplus_token',
    'notify.pushplus_hint',
    'notify.test',
    'buttons.save',
    'messages.notify_webhook_save_failed',
    'messages.notify_webhook_test_sent',
    'messages.notify_webhook_test_failed',
  ]

  it('defines every key the panel reads in both locales', () => {
    const zh = readLocale('zh-CN')
    const en = readLocale('en-US')

    for (const key of KEYS) {
      expect(zh[key], `zh-CN ${key}`).toBeTruthy()
      expect(en[key], `en-US ${key}`).toBeTruthy()
    }
  })

  it('keeps the two locale files positionally mirrored', () => {
    const zh = readLocale('zh-CN')
    const en = readLocale('en-US')
    const picked = (locale: Record<string, string>) => Object.keys(locale).filter(key => key.startsWith('notify.') || key.startsWith('messages.notify_webhook_'))

    expect(picked(zh)).toEqual(picked(en))
  })

  it('never hardcodes Chinese copy inside the panel', () => {
    expect(PANEL_SOURCE).not.toMatch(/>[\u4E00-\u9FFF]+</)
  })
})
