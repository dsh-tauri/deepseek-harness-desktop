// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { defineStore } from 'valtio-define'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeNotifyWebhook, NOTIFY_WEBHOOK_DEFAULTS } from '../../../../packages/dsh-tauri/src/shared/notify-webhook'
import { ConfigNotifyWebhook } from './notify-webhook'

const mocks = vi.hoisted(() => ({ setting: {} as any, toast: vi.fn(), invoke: vi.fn() }))
vi.mock('@/store', () => ({ store: { get setting() {
  return mocks.setting
} } }))
vi.mock('@/utils/toast', () => ({ toast: mocks.toast }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function setup(webhook: Record<string, unknown> = {}, fail = false) {
  const update = vi.fn(async (value) => {
    if (fail)
      throw new Error('disk write failed')
    mocks.setting.$patch({ notify_webhook: value.notifyWebhook })
  })
  mocks.setting = defineStore({
    state: () => ({ notify_webhook: normalizeNotifyWebhook({ ...NOTIFY_WEBHOOK_DEFAULTS, ...webhook }) }),
    actions: { update },
  })
  mocks.invoke.mockResolvedValue(undefined)
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  render(<QueryClientProvider client={client}><ConfigNotifyWebhook /></QueryClientProvider>)
  return update
}

function pickOption(testid: string, value: string) {
  const select = screen.getByTestId(testid).closest('[data-slot="select"]')!.querySelector('select')!
  fireEvent.change(select, { target: { value } })
}

function saved(update: ReturnType<typeof vi.fn>) {
  return update.mock.calls.at(-1)![0] as { notifyWebhook: Record<string, any> }
}

describe('通知转发设置面板', () => {
  it('关闭时不显示任何渠道字段与动作按钮', () => {
    setup()

    expect(screen.getByTestId('dsh-notify-channel')).toBeTruthy()
    expect(screen.queryByTestId('dsh-notify-smtp-host')).toBeNull()
    expect(screen.queryByTestId('dsh-notify-token')).toBeNull()
    expect(screen.queryByTestId('dsh-notify-save')).toBeNull()
    expect(screen.queryByTestId('dsh-notify-test')).toBeNull()
  })

  it('切换到邮件时立即落盘渠道，并展开 SMTP 字段', async () => {
    const update = setup()

    pickOption('dsh-notify-channel', 'email')

    await waitFor(() => expect(saved(update).notifyWebhook.channel).toBe('email'))
    await waitFor(() => expect(screen.getByTestId('dsh-notify-smtp-host')).toBeTruthy())
    expect(screen.queryByTestId('dsh-notify-token')).toBeNull()
  })

  it('未编辑时保存按钮禁用，编辑后按归一化字段一次提交', async () => {
    const update = setup({ channel: 'email' })
    const save = screen.getByTestId('dsh-notify-save') as HTMLButtonElement

    expect(save.disabled).toBe(true)

    fireEvent.change(screen.getByTestId('dsh-notify-smtp-host'), { target: { value: '  smtp.example.com ' } })
    fireEvent.change(screen.getByTestId('dsh-notify-smtp-username'), { target: { value: 'bot' } })
    await waitFor(() => expect(save.disabled).toBe(false))
    fireEvent.click(save)

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(saved(update).notifyWebhook).toMatchObject({
      channel: 'email',
      email: { smtpHost: 'smtp.example.com', smtpUsername: 'bot', smtpPort: 587, smtpSecurity: 'starttls' },
    })
  })

  it('密码前后空格原样保留，不会被 trim 掉', async () => {
    const update = setup({ channel: 'email' })
    fireEvent.change(screen.getByTestId('dsh-notify-smtp-password'), { target: { value: ' pw ' } })
    fireEvent.click(screen.getByTestId('dsh-notify-save'))

    await waitFor(() => expect(saved(update).notifyWebhook.email.smtpPassword).toBe(' pw '))
  })

  it('换加密方式时把仍停在默认值的端口一并带过去', async () => {
    const update = setup({ channel: 'email' })

    pickOption('dsh-notify-smtp-security', 'tls')
    await waitFor(() => expect((screen.getByTestId('dsh-notify-smtp-port') as HTMLInputElement).value).toBe('465'))
    fireEvent.click(screen.getByTestId('dsh-notify-save'))

    await waitFor(() => expect(saved(update).notifyWebhook.email).toMatchObject({ smtpSecurity: 'tls', smtpPort: 465 }))
  })

  it('用户自己填过的端口不会被加密方式覆盖', async () => {
    const update = setup({ channel: 'email', email: { ...NOTIFY_WEBHOOK_DEFAULTS.email, smtpPort: 2525 } })

    pickOption('dsh-notify-smtp-security', 'plain')
    fireEvent.click(screen.getByTestId('dsh-notify-save'))

    await waitFor(() => expect(saved(update).notifyWebhook.email).toMatchObject({ smtpSecurity: 'plain', smtpPort: 2525 }))
  })

  it('pushplus 渠道保存 token 时保留其它字段', async () => {
    const update = setup({ channel: 'pushplus' })

    fireEvent.change(screen.getByTestId('dsh-notify-token'), { target: { value: ' abc123 ' } })
    fireEvent.click(screen.getByTestId('dsh-notify-save'))

    await waitFor(() => expect(saved(update).notifyWebhook).toMatchObject({ channel: 'pushplus', pushplus: { token: 'abc123' } }))
  })

  it('测试前先把未保存的草稿落盘，再调后端命令', async () => {
    const update = setup({ channel: 'pushplus' })

    fireEvent.change(screen.getByTestId('dsh-notify-token'), { target: { value: 'abc' } })
    fireEvent.click(screen.getByTestId('dsh-notify-test'))

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('test_notify_webhook'))
    expect(saved(update).notifyWebhook.pushplus.token).toBe('abc')
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(mocks.invoke.mock.invocationCallOrder[0])
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('messages.notify_webhook_test_sent'))
  })

  it('没有草稿时直接测已保存的配置，不多写一次盘', async () => {
    const update = setup({ channel: 'pushplus' })

    fireEvent.click(screen.getByTestId('dsh-notify-test'))

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('test_notify_webhook'))
    expect(update).not.toHaveBeenCalled()
  })

  it('测试失败时提示带后端原因的错误', async () => {
    setup({ channel: 'email' })
    mocks.invoke.mockRejectedValue(new Error('NOTIFY_UNCONFIGURED: email from'))

    fireEvent.click(screen.getByTestId('dsh-notify-test'))

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('messages.notify_webhook_test_failed', { variant: 'danger', description: 'Error: NOTIFY_UNCONFIGURED: email from' }))
  })

  it('保存失败时提示错误且不回填草稿', async () => {
    setup({ channel: 'email' }, true)

    fireEvent.change(screen.getByTestId('dsh-notify-smtp-host'), { target: { value: 'smtp.example.com' } })
    fireEvent.click(screen.getByTestId('dsh-notify-save'))

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('messages.notify_webhook_save_failed', { variant: 'danger' }))
    expect((screen.getByTestId('dsh-notify-smtp-host') as HTMLInputElement).value).toBe('smtp.example.com')
  })

  it('渠道切换失败时提示错误并保持原渠道', async () => {
    setup({}, true)

    pickOption('dsh-notify-channel', 'email')

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('messages.notify_webhook_save_failed', { variant: 'danger' }))
    expect(screen.queryByTestId('dsh-notify-smtp-host')).toBeNull()
  })
})
