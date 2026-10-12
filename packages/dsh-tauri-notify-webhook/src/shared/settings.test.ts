// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { NOTIFY_SMTP_DEFAULT_PORT, NOTIFY_SMTP_PLAIN, NOTIFY_SMTP_STARTTLS, NOTIFY_SMTP_TLS } from './constants'
import { normalizeNotifyWebhook, NOTIFY_WEBHOOK_DEFAULTS, notifySmtpDefaultPort } from './settings'

describe('notifySmtpDefaultPort', () => {
  it('跟着加密方式走：TLS 465、不加密 25、其余 587', () => {
    expect(notifySmtpDefaultPort(NOTIFY_SMTP_TLS)).toBe(465)
    expect(notifySmtpDefaultPort(NOTIFY_SMTP_PLAIN)).toBe(25)
    expect(notifySmtpDefaultPort(NOTIFY_SMTP_STARTTLS)).toBe(NOTIFY_SMTP_DEFAULT_PORT)
    expect(notifySmtpDefaultPort('')).toBe(NOTIFY_SMTP_DEFAULT_PORT)
  })
})

describe('normalizeNotifyWebhook', () => {
  it('空值与坏类型都退回默认设置', () => {
    for (const value of [undefined, null, 42, 'nope', [], true]) {
      expect(normalizeNotifyWebhook(value)).toEqual(NOTIFY_WEBHOOK_DEFAULTS)
    }
  })

  it('返回的是新对象，改它不会污染默认设置', () => {
    const next = normalizeNotifyWebhook(NOTIFY_WEBHOOK_DEFAULTS)
    expect(next).not.toBe(NOTIFY_WEBHOOK_DEFAULTS)
    expect(next.email).not.toBe(NOTIFY_WEBHOOK_DEFAULTS.email)
    expect(next.pushplus).not.toBe(NOTIFY_WEBHOOK_DEFAULTS.pushplus)
    next.email.host = 'mutated'
    next.pushplus.token = 'mutated'
    expect(NOTIFY_WEBHOOK_DEFAULTS.email.host).toBe('')
    expect(NOTIFY_WEBHOOK_DEFAULTS.pushplus.token).toBe('')
  })

  it('只认已登记的渠道，其余一律关掉', () => {
    expect(normalizeNotifyWebhook({ channel: 'email' }).channel).toBe('email')
    expect(normalizeNotifyWebhook({ channel: 'pushplus' }).channel).toBe('pushplus')
    expect(normalizeNotifyWebhook({ channel: 'off' }).channel).toBe('off')
    expect(normalizeNotifyWebhook({ channel: 'sms' }).channel).toBe('off')
    expect(normalizeNotifyWebhook({ channel: 42 }).channel).toBe('off')
  })

  it('两个推送开关只在显式 false 时关闭', () => {
    expect(normalizeNotifyWebhook({}).notifyOnComplete).toBe(true)
    expect(normalizeNotifyWebhook({ notifyOnComplete: false }).notifyOnComplete).toBe(false)
    expect(normalizeNotifyWebhook({ notifyOnComplete: true }).notifyOnComplete).toBe(true)
    expect(normalizeNotifyWebhook({ notifyOnComplete: 0 }).notifyOnComplete).toBe(true)
    expect(normalizeNotifyWebhook({ notifyOnAbnormal: false }).notifyOnAbnormal).toBe(false)
    expect(normalizeNotifyWebhook({ notifyOnAbnormal: 'no' }).notifyOnAbnormal).toBe(true)
  })

  it('端口收数字与数字字符串，其余按加密方式补默认值', () => {
    expect(normalizeNotifyWebhook({ email: { port: 2525 } }).email.port).toBe(2525)
    expect(normalizeNotifyWebhook({ email: { port: '465' } }).email.port).toBe(465)
    expect(normalizeNotifyWebhook({ email: { port: 'abc' } }).email.port).toBe(NOTIFY_SMTP_DEFAULT_PORT)
    expect(normalizeNotifyWebhook({ email: { port: '' } }).email.port).toBe(NOTIFY_SMTP_DEFAULT_PORT)
    expect(normalizeNotifyWebhook({ email: { port: 0 } }).email.port).toBe(NOTIFY_SMTP_DEFAULT_PORT)
    expect(normalizeNotifyWebhook({ email: { port: 65_536 } }).email.port).toBe(NOTIFY_SMTP_DEFAULT_PORT)
    expect(normalizeNotifyWebhook({ email: { port: 1.5 } }).email.port).toBe(NOTIFY_SMTP_DEFAULT_PORT)
    expect(normalizeNotifyWebhook({ email: { port: true } }).email.port).toBe(NOTIFY_SMTP_DEFAULT_PORT)
  })

  it('端口缺失时按已选的加密方式补，而不是死记 587', () => {
    expect(normalizeNotifyWebhook({ email: { security: NOTIFY_SMTP_TLS } }).email.port).toBe(465)
    expect(normalizeNotifyWebhook({ email: { security: NOTIFY_SMTP_PLAIN } }).email.port).toBe(25)
    expect(normalizeNotifyWebhook({ email: { security: NOTIFY_SMTP_TLS, port: 'x' } }).email.port).toBe(465)
  })

  it('加密方式非法时退回 STARTTLS，端口跟着退回 587', () => {
    const next = normalizeNotifyWebhook({ email: { security: 'ssl' } })
    expect(next.email.security).toBe(NOTIFY_SMTP_STARTTLS)
    expect(next.email.port).toBe(NOTIFY_SMTP_DEFAULT_PORT)
  })

  it('字符串字段只收字符串，其余清空', () => {
    const next = normalizeNotifyWebhook({
      email: { host: 'smtp.example.com', username: 7, password: null, from: 'a@b.c', to: ['x'] },
      pushplus: { token: 'tk' },
    })
    expect(next.email).toEqual({
      host: 'smtp.example.com',
      port: NOTIFY_SMTP_DEFAULT_PORT,
      security: NOTIFY_SMTP_STARTTLS,
      username: '',
      password: '',
      from: 'a@b.c',
      to: '',
    })
    expect(next.pushplus).toEqual({ token: 'tk' })
    expect(normalizeNotifyWebhook({ pushplus: 'nope' }).pushplus).toEqual({ token: '' })
  })

  it('顶层嵌套字段类型不对时按空对象处理，不抛错', () => {
    expect(normalizeNotifyWebhook({ email: 'nope' }).email).toEqual(NOTIFY_WEBHOOK_DEFAULTS.email)
    expect(normalizeNotifyWebhook({ email: [] }).email).toEqual(NOTIFY_WEBHOOK_DEFAULTS.email)
  })
})
