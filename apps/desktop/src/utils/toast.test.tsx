// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 转发层的职责只有一条：把每次 toast 调用变成「本地照旧 + 给透明窗口推一份可序列化记录」。
 * 这里锁住三件容易回归的事：
 * - 不可序列化的 JSX / 闭包被压成文本与 action id；
 * - `close` / `clear` 同步收回窗口里的条目；
 * - 窗口只在还有提示时可见（最后一条消失要收起，避免留下置顶透明层）。
 */
const native = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(),
  emitTo: vi.fn<(target: unknown, event: string, payload?: unknown) => Promise<void>>(),
  listen: vi.fn<() => Promise<() => void>>(),
  local: {
    add: vi.fn(),
    update: vi.fn(),
    close: vi.fn(),
    clear: vi.fn(),
    isActive: vi.fn(),
  },
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ emitTo: native.emitTo, listen: native.listen }))
vi.mock('./toast.handle', () => ({
  toast: Object.assign(native.local.add, {
    update: native.local.update,
    close: native.local.close,
    clear: native.local.clear,
    isActive: native.local.isActive,
  }),
  activeQueues: {},
  placements: [],
}))

let key = 0
beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  key = 0
  native.invoke.mockResolvedValue(undefined)
  native.emitTo.mockResolvedValue(undefined)
  native.listen.mockResolvedValue(() => {})
  native.local.add.mockImplementation(() => `k${++key}`)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('toast 透明窗口转发', () => {
  it('把 JSX 描述压成文本并给按钮登记 action id', async () => {
    const { toast } = await import('./toast')
    toast('更新可用', {
      description: <span className="x">v0.31.0</span>,
      actionProps: { children: '立即更新', onPress: () => {} },
    })
    await vi.waitFor(() => expect(native.emitTo).toHaveBeenCalled())
    const [, event, record] = native.emitTo.mock.calls.at(-1)!
    expect(event).toBe('dsh://toast:show')
    expect(record).toMatchObject({
      key: 'k1',
      title: '更新可用',
      description: 'v0.31.0',
      action: { label: '立即更新' },
    })
    expect((record as { action: { id: string } }).action.id).toMatch(/^act-/)
  })

  it('先确保窗口存在再推内容，首条提示不会落进未挂载的页面', async () => {
    const { toast } = await import('./toast')
    toast('hi')
    await vi.waitFor(() => expect(native.emitTo).toHaveBeenCalled())
    expect(native.invoke.mock.calls[0]![0]).toBe('toast_view_show')
    const showIndex = native.invoke.mock.calls.findIndex(call => call[0] === 'toast_view_show')
    expect(showIndex).toBe(0)
  })

  it('close 会同步收回窗口里的条目', async () => {
    const { toast } = await import('./toast')
    const created = toast('hi')
    await vi.waitFor(() => expect(native.emitTo).toHaveBeenCalled())
    toast.close(created)
    const [, event, payload] = native.emitTo.mock.calls.at(-1)!
    expect(event).toBe('dsh://toast:close')
    expect(payload).toEqual({ key: 'k1' })
  })

  it('最后一条提示关闭后收起窗口，不留置顶透明层', async () => {
    const { toast } = await import('./toast')
    const created = toast('hi')
    await vi.waitFor(() => expect(native.emitTo).toHaveBeenCalled())
    native.invoke.mockClear()
    toast.close(created)
    await vi.waitFor(() => expect(native.invoke.mock.calls.some(call => call[0] === 'toast_view_hide')).toBe(true))
  })

  it('仍有提示时不收起窗口', async () => {
    const { toast } = await import('./toast')
    const first = toast('a')
    toast('b')
    await vi.waitFor(() => expect(native.emitTo).toHaveBeenCalledTimes(2))
    native.invoke.mockClear()
    toast.close(first)
    expect(native.invoke.mock.calls.some(call => call[0] === 'toast_view_hide')).toBe(false)
  })

  it('update 只改文案时保留已登记的操作按钮', async () => {
    const { toast } = await import('./toast')
    const created = toast('a', {
      description: 'one',
      actionProps: { children: '更新', onPress: () => {} },
    })
    await vi.waitFor(() => expect(native.emitTo).toHaveBeenCalled())
    const before = native.emitTo.mock.calls.at(-1)![2] as { action: { id: string } }
    toast.update(created, { description: 'two' })
    await vi.waitFor(() => expect(native.emitTo).toHaveBeenCalledTimes(2))
    const after = native.emitTo.mock.calls.at(-1)![2] as { action: { id: string }, description: string }
    expect(after.description).toBe('two')
    expect(after.action.id).toBe(before.action.id)
  })
})
