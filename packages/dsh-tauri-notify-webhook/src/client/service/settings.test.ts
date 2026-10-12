// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { NOTIFY_WEBHOOK_DEFAULTS } from '../../shared/settings'
import { answer, replies, resetWire, sent } from '../test-utils/client-mock'

vi.mock('dsh-tauri/client', async () => (await import('../test-utils/client-mock')).clientMock)

const { store } = await import('../store/index')
const service = await import('./settings')

const SETTINGS = '/api/tauri/notify-webhook/settings'
const TEST = '/api/tauri/notify-webhook/test'

const remote = {
  channel: 'email',
  notifyOnComplete: false,
  notifyOnAbnormal: true,
  email: { host: 'smtp.example.com', port: 465, security: 'tls', username: 'u', password: 'p', from: 'a@b.c', to: 'd@e.f' },
  pushplus: { token: 'tk' },
}

beforeEach(() => {
  resetWire()
  store.settings.commit(NOTIFY_WEBHOOK_DEFAULTS)
})

describe('settings service', () => {
  it('加载时先把状态推进到加载中并清掉上一次的错误', async () => {
    store.settings.fail('旧错误')
    const pending = service.loadSettings()
    expect(store.settings.status).toBe('loading')
    expect(store.settings.error).toBeNull()
    await pending
  })

  it('加载成功后把宿主的设置搬进表单，端口转成字符串', async () => {
    answer(() => replies.ok({ settings: remote }))
    await service.loadSettings()
    expect(store.settings.status).toBe('ready')
    expect(store.settings.error).toBeNull()
    expect(store.settings.values).toEqual({ ...remote, email: { ...remote.email, port: '465' } })
  })

  it('宿主回错误体时保留表单原值并暴露错误原文', async () => {
    answer(() => replies.ok({ error: 'NOTIFY_STORAGE: boom' }))
    await service.loadSettings()
    expect(store.settings.status).toBe('failed')
    expect(store.settings.error).toBe('NOTIFY_STORAGE: boom')
    expect(store.settings.values).toEqual({ ...NOTIFY_WEBHOOK_DEFAULTS, email: { ...NOTIFY_WEBHOOK_DEFAULTS.email, port: '587' } })
  })

  it('请求失败时把传输层文案记进错误', async () => {
    answer(() => replies.http(405))
    await service.loadSettings()
    expect(store.settings.status).toBe('failed')
    expect(store.settings.error).toBe('请求失败 (405)')
  })

  it('保存时把设置原样发给宿主，并把宿主归一化的结果写回表单', async () => {
    answer(() => replies.ok({ settings: remote }))
    await expect(service.saveSettings(remote)).resolves.toEqual({ ok: true })
    expect(sent).toEqual([{ url: SETTINGS, http: 'POST', body: { settings: remote }, params: {} }])
    expect(store.settings.values).toEqual({ ...remote, email: { ...remote.email, port: '465' } })
  })

  it('保存过程中 busy 停在 saving，结束后回到 idle', async () => {
    answer(() => replies.ok({ settings: remote }))
    const pending = service.saveSettings(remote)
    expect(store.settings.busy).toBe('saving')
    await pending
    expect(store.settings.busy).toBe('idle')
  })

  it('宿主拒绝保存时交回错误原文，表单不被覆盖', async () => {
    answer(() => replies.ok({ error: 'NOTIFY_INVALID: settings' }))
    await expect(service.saveSettings(remote)).resolves.toEqual({ ok: false, error: 'NOTIFY_INVALID: settings' })
    expect(store.settings.values).toEqual({ ...NOTIFY_WEBHOOK_DEFAULTS, email: { ...NOTIFY_WEBHOOK_DEFAULTS.email, port: '587' } })
    expect(store.settings.busy).toBe('idle')
  })

  it('保存请求抛错时把异常文案交回调用方', async () => {
    answer(() => replies.http(500))
    await expect(service.saveSettings(remote)).resolves.toEqual({ ok: false, error: '请求失败 (500)' })
    expect(store.settings.busy).toBe('idle')
  })

  it('测试推送不带请求体，成功时回 ok', async () => {
    answer(() => replies.ok({ ok: true }))
    const pending = service.sendTest()
    expect(store.settings.busy).toBe('testing')
    await expect(pending).resolves.toEqual({ ok: true })
    expect(sent).toEqual([{ url: TEST, http: 'POST', body: {}, params: {} }])
    expect(store.settings.busy).toBe('idle')
  })

  it('测试推送被宿主拒绝时交回错误原文', async () => {
    answer(() => replies.ok({ ok: false, error: 'NOTIFY_UNCONFIGURED: channel' }))
    await expect(service.sendTest()).resolves.toEqual({ ok: false, error: 'NOTIFY_UNCONFIGURED: channel' })
    expect(store.settings.busy).toBe('idle')
  })
})
