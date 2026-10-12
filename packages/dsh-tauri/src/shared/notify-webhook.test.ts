import { describe, expect, it } from 'vitest'
import { normalizeNotifyEmail, normalizeNotifyWebhook, NOTIFY_SMTP_DEFAULT_PORT, NOTIFY_SMTP_SECURITIES, NOTIFY_WEBHOOK_CHANNELS, NOTIFY_WEBHOOK_DEFAULTS, notifySmtpDefaultPort } from './notify-webhook'

describe('notify webhook normalization', () => {
  it('exposes exactly the channels and security modes the backend accepts', () => {
    expect(NOTIFY_WEBHOOK_CHANNELS).toEqual(['off', 'email', 'pushplus'])
    expect(NOTIFY_SMTP_SECURITIES).toEqual(['starttls', 'tls', 'plain'])
    expect(NOTIFY_SMTP_DEFAULT_PORT).toBe(587)
  })

  it.each([[undefined, 587], [null, 587], ['starttls', 587], ['tls', 465], ['plain', 25], ['bogus', 587], ['', 587], [0, 587]])('maps security %s to port %i', (security, port) => {
    expect(notifySmtpDefaultPort(security)).toBe(port)
  })

  it.each([undefined, null, {}, 1, 'email', { channel: 'missing' }, { channel: 'EMAIL' }, { channel: [] }, { channel: null }])('falls back to the off channel for %j', (value) => {
    expect(normalizeNotifyWebhook(value).channel).toBe('off')
  })

  it.each([undefined, null, {}, 1, 'nord', { channel: 'off', email: 'nope', pushplus: 7 }])('keeps the defaults for unusable payloads: %j', (value) => {
    expect(normalizeNotifyWebhook(value)).toEqual(NOTIFY_WEBHOOK_DEFAULTS)
  })

  it('keeps the three whitelisted channels', () => {
    for (const channel of NOTIFY_WEBHOOK_CHANNELS)
      expect(normalizeNotifyWebhook({ channel }).channel).toBe(channel)
  })

  it('trims the mail fields the backend compares verbatim', () => {
    const email = normalizeNotifyEmail({ smtpHost: '  smtp.example.com ', smtpUsername: ' user ', from: ' a@example.com ', to: ' b@example.com ' })
    expect(email).toMatchObject({ smtpHost: 'smtp.example.com', smtpUsername: 'user', from: 'a@example.com', to: 'b@example.com' })
  })

  it('never trims the password so leading spaces survive a round trip', () => {
    expect(normalizeNotifyEmail({ smtpPassword: '  secret  ' }).smtpPassword).toBe('  secret  ')
    expect(normalizeNotifyEmail({}).smtpPassword).toBe('')
  })

  it.each([['starttls', 'starttls'], ['tls', 'tls'], ['plain', 'plain'], ['TLS', 'starttls'], ['', 'starttls'], [null, 'starttls'], [7, 'starttls']])('normalizes security %s to %s', (input, expected) => {
    expect(normalizeNotifyEmail({ smtpSecurity: input }).smtpSecurity).toBe(expected)
  })

  it.each([[587, 'starttls', 587], [465, 'tls', 465], [25, 'plain', 25], [0, 'starttls', 587], [0, 'tls', 465], [0, 'plain', 25], [-1, 'starttls', 587], [65536, 'starttls', 587], [Number.NaN, 'starttls', 587], [Number.POSITIVE_INFINITY, 'starttls', 587], [77.4, 'starttls', 77]])('normalizes port %s under %s to %i', (port, security, expected) => {
    expect(normalizeNotifyEmail({ smtpPort: port, smtpSecurity: security }).smtpPort).toBe(expected)
  })

  it('accepts a port typed as a string only after the caller converts it', () => {
    expect(normalizeNotifyEmail({ smtpPort: '465' as unknown as number }).smtpPort).toBe(587)
  })

  it('trims the pushplus token and tolerates a missing block', () => {
    expect(normalizeNotifyWebhook({ channel: 'pushplus', pushplus: { token: '  abc  ' } }).pushplus.token).toBe('abc')
    expect(normalizeNotifyWebhook({ channel: 'pushplus' }).pushplus.token).toBe('')
    expect(normalizeNotifyWebhook({ channel: 'pushplus', pushplus: { token: 5 } }).pushplus.token).toBe('')
  })

  it('is idempotent so a second pass never drifts the saved values', () => {
    const once = normalizeNotifyWebhook({ channel: 'email', email: { smtpHost: ' h ', smtpPort: 0, smtpSecurity: 'tls', smtpPassword: ' p ' }, pushplus: { token: ' t ' } })
    expect(normalizeNotifyWebhook(once)).toEqual(once)
  })
})
