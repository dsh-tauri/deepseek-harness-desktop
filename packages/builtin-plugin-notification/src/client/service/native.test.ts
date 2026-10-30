import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface ClickedPayload {
  tag?: string
  action?: string
  inputValue?: string
}

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}))

vi.mock('dsh-tauri/client', () => ({ invoke: mocks.invoke, listen: mocks.listen }))

type Commands = Record<string, (args?: Record<string, unknown>) => unknown>

function scriptInvoke(commands: Commands): void {
  mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    const handler = commands[cmd]
    if (!handler)
      throw new Error(`unexpected ${cmd}`)
    return handler(args)
  })
}

function sentOptions(): Record<string, unknown>[] {
  return mocks.invoke.mock.calls
    .filter(([cmd]) => cmd === 'plugin:notifications|notify')
    .map(([, args]) => (args as { options: Record<string, unknown> }).options)
}

async function load() {
  vi.resetModules()
  const handlers: Array<(event: { payload: ClickedPayload }) => void> = []
  mocks.listen.mockImplementation(async (_event: string, handler: (event: { payload: ClickedPayload }) => void) => {
    handlers.push(handler)
    return () => {}
  })
  const { showNativeNotification } = await import('./native')
  const emit = (payload: ClickedPayload) => handlers.forEach(handler => handler({ payload }))
  return { showNativeNotification, emit }
}

beforeEach(() => {
  mocks.invoke.mockReset()
  mocks.listen.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('showNativeNotification', () => {
  it('已授权时直接发通知，extra 带回会话标识', async () => {
    scriptInvoke({
      'plugin:notifications|is_permission_granted': () => true,
      'plugin:notifications|notify': () => undefined,
    })
    const { showNativeNotification } = await load()

    showNativeNotification({ title: '标题', body: '正文', tag: 'tag-1', sessionId: 's-1', silent: true })

    await vi.waitFor(() => expect(sentOptions()).toHaveLength(1))
    expect(sentOptions()[0]).toMatchObject({
      title: '标题',
      body: '正文',
      silent: true,
      actionTypeId: undefined,
      extra: { sessionId: 's-1', title: '标题', tag: 'tag-1' },
    })
    expect(mocks.listen).toHaveBeenCalledWith('dsh://notification-clicked', expect.any(Function))
  })

  it('未授权时先请求权限，被拒绝则不发通知', async () => {
    scriptInvoke({
      'plugin:notifications|is_permission_granted': () => false,
      'plugin:notifications|request_permission': () => 'denied',
    })
    const { showNativeNotification } = await load()

    showNativeNotification({ title: '标题', body: '正文', tag: 'tag-1', sessionId: 's-1' })

    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('plugin:notifications|request_permission'))
    expect(sentOptions()).toHaveLength(0)
  })

  it('actions 注册成动作类型并把按钮输入框字段带上', async () => {
    scriptInvoke({
      'plugin:notifications|is_permission_granted': () => true,
      'plugin:notifications|register_action_types': () => undefined,
      'plugin:notifications|notify': () => undefined,
    })
    const { showNativeNotification } = await load()

    showNativeNotification({
      title: '标题',
      body: '正文',
      tag: 'tag-1',
      sessionId: 's-1',
      actions: [
        { id: 'approve', title: '批准' },
        { id: 'reply', title: '回复', input: true, inputPlaceholder: '输入回复内容', inputButtonTitle: '发送' },
      ],
    })

    await vi.waitFor(() => expect(sentOptions()).toHaveLength(1))
    const registered = mocks.invoke.mock.calls.find(([cmd]) => cmd === 'plugin:notifications|register_action_types')
    expect(registered?.[1]).toEqual({
      types: [{
        id: 'dsh-notification-approve-reply',
        actions: [
          { id: 'approve', title: '批准', foreground: true, input: false, inputPlaceholder: undefined, inputButtonTitle: undefined },
          { id: 'reply', title: '回复', foreground: true, input: true, inputPlaceholder: '输入回复内容', inputButtonTitle: '发送' },
        ],
      }],
    })
    expect(sentOptions()[0].actionTypeId).toBe('dsh-notification-approve-reply')
  })

  it('动作类型注册失败时退回无按钮通知', async () => {
    scriptInvoke({
      'plugin:notifications|is_permission_granted': () => true,
      'plugin:notifications|register_action_types': () => { throw new Error('boom') },
      'plugin:notifications|notify': () => undefined,
    })
    const { showNativeNotification } = await load()

    showNativeNotification({ title: '标题', body: '正文', tag: 'tag-1', sessionId: 's-1', actions: [{ id: 'approve', title: '批准' }] })

    await vi.waitFor(() => expect(sentOptions()).toHaveLength(1))
    expect(sentOptions()[0].actionTypeId).toBeUndefined()
  })

  it('点通知本体按 tag 回调 onClick', async () => {
    scriptInvoke({
      'plugin:notifications|is_permission_granted': () => true,
      'plugin:notifications|notify': () => undefined,
    })
    const { showNativeNotification, emit } = await load()
    const onClick = vi.fn()
    showNativeNotification({ title: '标题', body: '正文', tag: 'tag-1', sessionId: 's-1', onClick })
    await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalled())

    emit({ tag: 'other' })
    emit({ tag: 'tag-1' })

    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('按钮回灌：空输入折成 null，有文本则原样回传 action id', async () => {
    scriptInvoke({
      'plugin:notifications|is_permission_granted': () => true,
      'plugin:notifications|notify': () => undefined,
    })
    const { showNativeNotification, emit } = await load()
    const onAction = vi.fn()
    const onClick = vi.fn()
    showNativeNotification({ title: '标题', body: '正文', tag: 'tag-1', sessionId: 's-1', onAction, onClick })
    await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalled())

    emit({ tag: 'tag-1', action: 'approve' })
    emit({ tag: 'tag-1', action: 'reply', inputValue: '就这样' })

    expect(onAction.mock.calls).toEqual([
      ['approve', null],
      ['reply', '就这样'],
    ])
    expect(onClick).not.toHaveBeenCalled()
  })
})
