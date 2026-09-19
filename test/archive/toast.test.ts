import { afterEach, describe, expect, it, vi } from 'vitest'
import { activeQueues as queues, toast } from '../../src/utils/toast'

afterEach(() => {
  toast.clear()
  vi.useRealTimers()
})

describe('toast lifecycle', () => {
  it('keeps persistent notifications open until explicitly closed and runs their callback', async () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    const key = toast('Update available', { timeout: 0, onClose })
    const queue = queues['bottom end']
    const notification = queue.visibleToasts.find(item => item.key === key)!

    expect(notification.timer).toBeUndefined()
    expect(notification.content).not.toHaveProperty('onClose')
    expect(notification.content).not.toHaveProperty('timeout')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(queue.visibleToasts.some(item => item.key === key)).toBe(true)

    // HeroUI 的关闭按钮直接关闭底层队列，也必须触发业务层的忽略版本回调。
    queue.close(key)
    expect(onClose).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(queue.visibleToasts.some(item => item.key === key)).toBe(false)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('expires a notification using its requested timeout', async () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    const key = toast('Update available', { timeout: 8000, onClose })
    const queue = queues['bottom end']
    const notification = queue.visibleToasts.find(item => item.key === key)!

    // 组件挂载时会启动计时，这里模拟显示后开始倒计时。
    notification.timer!.resume()
    await vi.advanceTimersByTimeAsync(7999)
    expect(queue.visibleToasts.some(item => item.key === key)).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(queue.visibleToasts.some(item => item.key === key)).toBe(false)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('closes only the selected notification in its own placement', async () => {
    const onClose = vi.fn()
    const key = toast('Download complete', { placement: 'top', onClose })
    const otherKey = toast('Update available', { timeout: 0 })

    toast.close(key)
    await Promise.resolve()

    expect(queues.top.visibleToasts.some(item => item.key === key)).toBe(false)
    expect(queues['bottom end'].visibleToasts.some(item => item.key === otherKey)).toBe(true)
    expect(onClose).toHaveBeenCalledOnce()
  })
})
