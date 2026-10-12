import type { NotifyWebhookSettings } from '../../shared/settings'
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NOTIFY_WEBHOOK_DEFAULTS } from '../../shared/settings'

const harness = vi.hoisted(() => ({ documents: new Map<string, unknown>() }))

vi.mock('../storage/index', () => ({
  storage: {
    getItem: async (key: string) => harness.documents.get(key) ?? null,
    setItem: async (key: string, value: unknown) => { harness.documents.set(key, value) },
  },
}))

const { settings } = await import('./settings')

describe('host settings service', () => {
  beforeEach(() => {
    harness.documents.clear()
  })

  it('文档不存在时给出默认设置', async () => {
    await expect(settings.load()).resolves.toEqual(NOTIFY_WEBHOOK_DEFAULTS)
  })

  it('文档是坏数据时也给出默认设置', async () => {
    harness.documents.set('settings', 'nope')
    await expect(settings.load()).resolves.toEqual(NOTIFY_WEBHOOK_DEFAULTS)
  })

  it('保存时归一化，落盘的就是归一化后的设置', async () => {
    const saved = await settings.save({
      channel: 'sms',
      notifyOnComplete: false,
      notifyOnAbnormal: true,
      email: { host: 'smtp.example.com', port: '2525', security: 'tls', username: 'u', password: 'p', from: 'a@b.c', to: 'd@e.f' },
      pushplus: { token: 'tk' },
    } as unknown as NotifyWebhookSettings)
    expect(saved.channel).toBe('off')
    expect(saved.notifyOnComplete).toBe(false)
    expect(saved.email.port).toBe(2525)
    expect(harness.documents.get('settings')).toEqual(saved)
    expect(harness.documents.size).toBe(1)
  })

  it('存进去再读出来是同一份设置', async () => {
    const saved = await settings.save({ channel: 'pushplus', pushplus: { token: 'tk' } } as unknown as NotifyWebhookSettings)
    expect(saved.channel).toBe('pushplus')
    await expect(settings.load()).resolves.toEqual(saved)
  })
})
