import type { WireReply } from '../test-utils/client-mock'
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NOTIFY_WEBHOOK_DEFAULTS } from '../../shared/settings'
import { store } from '../store/index'
import { answer, replies, resetWire, sent } from '../test-utils/client-mock'
import { NotifyWebhookSection } from './notify-webhook-section'

// 宿主 loader 缺失时语言桥停在英文兜底，组件断言的就是英文字典原文。
vi.mock('dsh-tauri-ui/client', async () => (await import('../test-utils/ui-mock')).uiMock)
vi.mock('dsh-tauri/client', async () => (await import('../test-utils/client-mock')).clientMock)

const SETTINGS = '/api/tauri/notify-webhook/settings'
const TEST = '/api/tauri/notify-webhook/test'

const en = {
  intro: 'Forward a notification to email or pushplus when a task stops abnormally or completes; pushes happen only while the window is unfocused.',
  channel: 'Channel',
  channelOff: 'Off',
  channelEmail: 'Email',
  channelPushplus: 'pushplus',
  trigger: 'When to push',
  triggerComplete: 'Task completed',
  triggerAbnormal: 'Task stopped abnormally',
  email: 'Email (SMTP)',
  smtpHost: 'SMTP server',
  smtpPort: 'Port',
  smtpSecurity: 'Security',
  smtpUsername: 'Username',
  smtpPassword: 'Password',
  smtpFrom: 'From',
  smtpTo: 'To',
  pushplusToken: 'Token',
  test: 'Send test',
  save: 'Save',
  saveOk: 'Saved',
  saveFailed: 'Save failed: {error}',
  testOk: 'Test message sent',
  testFailed: 'Send failed: {error}',
  loading: 'Loading…',
  loadFailed: 'Failed to load settings: {error}',
}

const remote = {
  channel: 'email',
  notifyOnComplete: true,
  notifyOnAbnormal: false,
  email: { host: 'smtp.example.com', port: 465, security: 'tls', username: 'u', password: 'p', from: 'a@b.c', to: 'd@e.f' },
  pushplus: { token: 'tk' },
}

function bootWire(): void {
  answer((call) => {
    if (call.url === SETTINGS && call.http === 'GET')
      return replies.ok({ settings: remote })
    if (call.url === SETTINGS)
      return replies.ok({ settings: (call.body.settings as typeof remote | undefined) ?? remote })
    if (call.url === TEST)
      return replies.ok({ ok: true })
    return replies.ok({})
  })
}

const value = (name: string): string => (screen.getByLabelText(name, { selector: 'input' }) as HTMLInputElement).value
const notices = (): Element[] => screen.queryAllByTestId('notify-webhook-notice')
/** 直接推动 store 的 busy 槽：要验的是锁态，不必真的走一趟 HTTP。 */
function beginSave(): void {
  store.settings.beginSave()
}

function endBusy(): void {
  store.settings.endBusy()
}

// Field 用 <label> 包住 Select，渠道选项的无障碍名会带上外层标签文字，只能按结构取。
const channelOptions = (): HTMLButtonElement[] => [...screen.getByRole('listbox', { name: en.channel }).querySelectorAll('[role="option"]')] as HTMLButtonElement[]
const rendered = (): Promise<void> => waitFor(() => expect(screen.getByTestId('notify-webhook-section')).toBeTruthy())

beforeEach(() => {
  resetWire()
  store.settings.commit(NOTIFY_WEBHOOK_DEFAULTS)
  bootWire()
})

afterEach(() => {
  cleanup()
})

describe('notifyWebhookSection', () => {
  it('加载中先出加载态，拿到设置后按英文词典渲染渠道、时机与两块凭据面板', async () => {
    let release: (reply: WireReply) => void = () => {}
    answer((call) => {
      if (call.url === SETTINGS && call.http === 'GET')
        return new Promise<WireReply>((resolve) => { release = resolve })
      return replies.ok({})
    })
    render(<NotifyWebhookSection />)
    await waitFor(() => expect(screen.getByTestId('notify-webhook-loading').textContent).toBe(en.loading))
    expect(screen.queryByTestId('notify-webhook-section')).toBeNull()

    release(replies.ok({ settings: remote }))
    await rendered()
    expect(screen.getByText(en.intro)).toBeTruthy()
    expect(screen.getByRole('listbox', { name: en.channel })).toBeTruthy()
    expect(screen.getByRole('switch', { name: en.triggerComplete }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('switch', { name: en.triggerAbnormal }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText(en.email)).toBeTruthy()
    expect(screen.getByText(en.pushplusToken)).toBeTruthy()
  })

  it('把宿主设置铺进表单：端口转成字符串，密码与 token 用密码框', async () => {
    render(<NotifyWebhookSection />)
    await rendered()

    expect(value(en.smtpHost)).toBe('smtp.example.com')
    expect(value(en.smtpPort)).toBe('465')
    expect(value(en.smtpFrom)).toBe('a@b.c')
    expect(value(en.smtpTo)).toBe('d@e.f')
    expect(value(en.pushplusToken)).toBe('tk')
    const security = screen.getByRole('listbox', { name: en.smtpSecurity })
    expect([...security.querySelectorAll('[role="option"]')].map(option => option.textContent)).toEqual(['STARTTLS', 'SSL/TLS', 'None'])
  })

  it('切换推送渠道与两个开关只改表单，不落盘', async () => {
    render(<NotifyWebhookSection />)
    await rendered()

    fireEvent.click(screen.getByRole('option', { name: en.channelPushplus }))
    expect(store.settings.values.channel).toBe('pushplus')

    fireEvent.click(screen.getByRole('switch', { name: en.triggerComplete }))
    expect(store.settings.values.notifyOnComplete).toBe(false)
    fireEvent.click(screen.getByRole('switch', { name: en.triggerAbnormal }))
    expect(store.settings.values.notifyOnAbnormal).toBe(true)

    expect(sent.filter(call => call.url === SETTINGS && call.http === 'POST')).toEqual([])
  })

  it('编辑邮件字段写进表单，端口保持输入框里的字符串', async () => {
    render(<NotifyWebhookSection />)
    await rendered()

    fireEvent.change(screen.getByLabelText(en.smtpHost, { selector: 'input' }), { target: { value: 'smtp.other' } })
    fireEvent.change(screen.getByLabelText(en.smtpPort, { selector: 'input' }), { target: { value: '2525' } })
    fireEvent.change(screen.getByLabelText(en.smtpPassword, { selector: 'input', exact: false }), { target: { value: 'secret' } })

    expect(store.settings.values.email).toEqual({ ...remote.email, host: 'smtp.other', port: '2525', password: 'secret' })
  })

  it('保存把归一化后的表单发给宿主，成功后提示已保存并回填宿主结果', async () => {
    render(<NotifyWebhookSection />)
    await rendered()

    // 端口清空后按加密方式落到默认端口（tls → 465），保存回包再把表单填回来。
    fireEvent.change(screen.getByLabelText(en.smtpPort, { selector: 'input' }), { target: { value: '' } })
    await waitFor(() => expect(value(en.smtpPort)).toBe(''))
    fireEvent.click(screen.getByTestId('notify-webhook-save'))

    await waitFor(() => expect(screen.getByTestId('notify-webhook-notice').textContent).toBe(en.saveOk))
    expect(sent.filter(call => call.url === SETTINGS && call.http === 'POST').map(call => call.body)).toEqual([
      { settings: { ...remote, email: { ...remote.email, port: 465 } } },
    ])
    expect(value(en.smtpPort)).toBe('465')
    expect(store.settings.status).toBe('ready')
  })

  it('保存被宿主拒绝时把错误原文挂在告警提示上', async () => {
    answer(call => call.url === SETTINGS && call.http === 'POST'
      ? replies.ok({ error: 'NOTIFY_INVALID: settings' })
      : replies.ok({ settings: remote }))
    render(<NotifyWebhookSection />)
    await rendered()

    fireEvent.click(screen.getByTestId('notify-webhook-save'))
    await waitFor(() => expect(screen.getByTestId('notify-webhook-notice').getAttribute('role')).toBe('alert'))
    expect(screen.getByTestId('notify-webhook-notice').textContent).toBe('Save failed: NOTIFY_INVALID: settings')
  })

  it('测试推送不带请求体，成功后提示测试消息已发出', async () => {
    render(<NotifyWebhookSection />)
    await rendered()

    fireEvent.click(screen.getByTestId('notify-webhook-test'))
    await waitFor(() => expect(screen.getByTestId('notify-webhook-notice').textContent).toBe(en.testOk))
    expect(sent.filter(call => call.url === TEST)).toEqual([{ url: TEST, http: 'POST', body: {}, params: {} }])
  })

  it('测试推送失败时把原因挂到告警提示上', async () => {
    answer(call => call.url === TEST
      ? replies.ok({ ok: false, error: 'NOTIFY_UNCONFIGURED: channel' })
      : replies.ok({ settings: remote }))
    render(<NotifyWebhookSection />)
    await rendered()

    fireEvent.click(screen.getByTestId('notify-webhook-test'))
    await waitFor(() => expect(screen.getByTestId('notify-webhook-notice').textContent).toBe('Send failed: NOTIFY_UNCONFIGURED: channel'))
    expect(screen.getByTestId('notify-webhook-notice').getAttribute('role')).toBe('alert')
    expect(notices()).toHaveLength(1)
  })

  it('设置加载失败时整块换成告警文案，不再渲染表单', async () => {
    answer(() => replies.ok({ error: 'NOTIFY_STORAGE: boom' }))
    render(<NotifyWebhookSection />)

    await waitFor(() => expect(screen.getByTestId('notify-webhook-error')).toBeTruthy())
    expect(screen.getByTestId('notify-webhook-error').getAttribute('role')).toBe('alert')
    expect(screen.getByTestId('notify-webhook-error').textContent).toBe('Failed to load settings: NOTIFY_STORAGE: boom')
    expect(screen.queryByTestId('notify-webhook-section')).toBeNull()
  })

  it('插件未加载（设置接口 405）时呈现本地化加载失败而不是原生解析异常', async () => {
    answer(() => replies.http(405))
    render(<NotifyWebhookSection />)

    await waitFor(() => expect(screen.getByTestId('notify-webhook-error').textContent).toBe('Failed to load settings: 请求失败 (405)'))
  })

  it('表单有未保存改动时测试推送按钮锁住，保存落地后解锁', async () => {
    render(<NotifyWebhookSection />)
    await rendered()

    const button = screen.getByTestId('notify-webhook-test') as HTMLButtonElement
    expect(button.disabled).toBe(false)

    fireEvent.change(screen.getByLabelText(en.smtpHost, { selector: 'input' }), { target: { value: 'smtp.other' } })
    await waitFor(() => expect(button.disabled).toBe(true))

    fireEvent.click(screen.getByTestId('notify-webhook-save'))
    await waitFor(() => expect(screen.getByTestId('notify-webhook-notice').textContent).toBe(en.saveOk))
    expect(button.disabled).toBe(false)
  })

  it('保存进行中把输入框、渠道选项与两个开关一起锁住', async () => {
    render(<NotifyWebhookSection />)
    await rendered()

    act(beginSave)

    await waitFor(() => expect((screen.getByLabelText(en.smtpHost, { selector: 'input' }) as HTMLInputElement).disabled).toBe(true))
    expect((screen.getByLabelText(en.smtpPort, { selector: 'input' }) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText(en.smtpPassword, { selector: 'input', exact: false }) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText(en.pushplusToken, { selector: 'input' }) as HTMLInputElement).disabled).toBe(true)
    expect(channelOptions().map(option => option.disabled)).toEqual([true, true, true])
    expect((screen.getByRole('switch', { name: en.triggerComplete }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('switch', { name: en.triggerAbnormal }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('notify-webhook-save') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('notify-webhook-test') as HTMLButtonElement).disabled).toBe(true)

    act(endBusy)

    await waitFor(() => expect((screen.getByLabelText(en.smtpHost, { selector: 'input' }) as HTMLInputElement).disabled).toBe(false))
    expect((screen.getByRole('switch', { name: en.triggerComplete }) as HTMLButtonElement).disabled).toBe(false)
  })
})
