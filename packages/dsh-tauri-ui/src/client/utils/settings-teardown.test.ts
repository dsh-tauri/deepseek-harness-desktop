// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scheduleSettingsTeardown } from './settings-teardown'

function createFrames() {
  const queue: Array<() => void> = []
  return {
    request: (callback: () => void) => queue.push(callback),
    cancel: vi.fn(),
    flush() {
      queue.splice(0).forEach(callback => callback())
    },
    pending: () => queue.length,
  }
}

afterEach(() => {
  document.documentElement.style.removeProperty('transform')
})

describe('scheduleSettingsTeardown', () => {
  it('首帧之前不卸载，下一帧才卸载', () => {
    const frames = createFrames()
    const unmount = vi.fn()
    scheduleSettingsTeardown(unmount, frames.request, frames.cancel)
    expect(unmount).not.toHaveBeenCalled()
    frames.flush()
    expect(unmount).toHaveBeenCalledOnce()
  })

  it('卸载后的下一帧给根节点加 transform 强制重绘，再下一帧移除', () => {
    const frames = createFrames()
    scheduleSettingsTeardown(vi.fn(), frames.request, frames.cancel)
    frames.flush()
    expect(document.documentElement.style.transform).toBe('')
    frames.flush()
    expect(document.documentElement.style.transform).toBe('translateZ(0)')
    frames.flush()
    expect(document.documentElement.style.transform).toBe('')
  })

  it('取消后不再卸载也不触碰根节点', () => {
    const frames = createFrames()
    const unmount = vi.fn()
    const cancel = scheduleSettingsTeardown(unmount, frames.request, frames.cancel)
    cancel()
    frames.flush()
    frames.flush()
    expect(unmount).not.toHaveBeenCalled()
    expect(document.documentElement.style.transform).toBe('')
    expect(frames.cancel).toHaveBeenCalled()
  })

  it('卸载后取消会阻止重绘', () => {
    const frames = createFrames()
    const cancel = scheduleSettingsTeardown(vi.fn(), frames.request, frames.cancel)
    frames.flush()
    cancel()
    frames.flush()
    expect(document.documentElement.style.transform).toBe('')
  })
})
