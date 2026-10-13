import type { NotifyWebhookSettings } from '../../../shared/settings'

// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NOTIFY_WEBHOOK_DEFAULTS } from '../../../shared/settings'

vi.mock('dsh-tauri/client', async () => (await import('../../test-utils/client-mock')).clientMock)

const { store } = await import('../index')

/** 任何用例改动之前抓下的原始状态：本仓 store 没有 reset 动作，初始态只能这样留证。 */
const pristine: unknown = JSON.parse(JSON.stringify(store.settings.$state))

/** 表单口径的默认值：端口是输入框里的字符串，不是设置里的数字。 */
const initialForm = {
  ...NOTIFY_WEBHOOK_DEFAULTS,
  email: { ...NOTIFY_WEBHOOK_DEFAULTS.email, port: '587' },
}

const remote = {
  channel: 'pushplus',
  notifyOnComplete: false,
  notifyOnAbnormal: true,
  email: { host: 'smtp.example.com', port: 465, security: 'tls', username: 'u', password: 'p', from: 'a@b.c', to: 'd@e.f' },
  pushplus: { token: 'tk' },
}

beforeEach(() => {
  store.settings.commit(NOTIFY_WEBHOOK_DEFAULTS)
})

describe('the settings store initial state', () => {
  it('从默认值起手：状态是待加载，表单端口已经是字符串', () => {
    expect(pristine).toEqual({
      status: 'idle',
      error: null,
      busy: 'idle',
      values: initialForm,
      saved: initialForm,
    })
  })
})

describe('commit', () => {
  it('把宿主的设置搬进表单，端口转成字符串', () => {
    store.settings.commit(remote)
    expect(store.settings.values).toEqual({ ...remote, email: { ...remote.email, port: '465' } })
    expect(store.settings.status).toBe('ready')
    expect(store.settings.error).toBeNull()
  })

  it('已保存基线与表单一起落地，两者口径一致', () => {
    store.settings.commit(remote)
    const expected = { ...remote, email: { ...remote.email, port: '465' } }
    expect(store.settings.values).toEqual(expected)
    expect(store.settings.saved).toEqual(expected)
  })

  it('改表单不动已保存基线，未落盘的改动能被认出来', () => {
    store.settings.commit(remote)
    store.settings.patchEmail({ host: 'smtp.other' })
    expect(store.settings.values.email.host).toBe('smtp.other')
    expect(store.settings.saved.email.host).toBe('smtp.example.com')
  })

  it('坏数据在入库前被归一化，不让非法值进表单', () => {
    store.settings.commit({ channel: 'sms', notifyOnComplete: 'yes', email: { port: 99999, security: 'ssl' } } as unknown as NotifyWebhookSettings)
    expect(store.settings.values.channel).toBe('off')
    expect(store.settings.values.notifyOnComplete).toBe(true)
    expect(store.settings.values.email.security).toBe('starttls')
    expect(store.settings.values.email.port).toBe('587')
  })
})

describe('the status trail', () => {
  it('beginLoad 进入加载中并清掉上一次的错误', () => {
    store.settings.fail('旧错误')
    store.settings.beginLoad()
    expect(store.settings.status).toBe('loading')
    expect(store.settings.error).toBeNull()
  })

  it('fail 记下错误原文并标记失败', () => {
    store.settings.fail('NOTIFY_STORAGE: boom')
    expect(store.settings.status).toBe('failed')
    expect(store.settings.error).toBe('NOTIFY_STORAGE: boom')
  })
})

describe('the busy slot', () => {
  it('保存与测试推送各占一格，收尾一律回到 idle', () => {
    store.settings.beginSave()
    expect(store.settings.busy).toBe('saving')
    store.settings.endBusy()
    expect(store.settings.busy).toBe('idle')
    store.settings.beginTest()
    expect(store.settings.busy).toBe('testing')
    store.settings.endBusy()
    expect(store.settings.busy).toBe('idle')
  })
})

describe('patching the form', () => {
  it('patch 只改顶层字段，不动邮件与 pushplus 面板', () => {
    store.settings.commit(remote)
    store.settings.patch({ channel: 'email', notifyOnComplete: true })
    expect(store.settings.values.channel).toBe('email')
    expect(store.settings.values.notifyOnComplete).toBe(true)
    expect(store.settings.values.notifyOnAbnormal).toBe(true)
    expect(store.settings.values.email).toEqual({ ...remote.email, port: '465' })
    expect(store.settings.values.pushplus).toEqual(remote.pushplus)
  })

  it('patchEmail 只合并邮件面板的字段', () => {
    store.settings.commit(remote)
    store.settings.patchEmail({ host: 'smtp.other', port: '2525' })
    expect(store.settings.values.email).toEqual({ ...remote.email, host: 'smtp.other', port: '2525' })
    expect(store.settings.values.channel).toBe('pushplus')
    expect(store.settings.values.pushplus).toEqual(remote.pushplus)
  })

  it('patchPushplus 只合并 token', () => {
    store.settings.commit(remote)
    store.settings.patchPushplus({ token: 'next' })
    expect(store.settings.values.pushplus).toEqual({ token: 'next' })
    expect(store.settings.values.email).toEqual({ ...remote.email, port: '465' })
  })
})
