// @vitest-environment node
import type { Window } from '@tauri-apps/api/window'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { windowScreenPosition } from './screen-coordinates'

const osType = vi.hoisted(() => vi.fn(() => 'macos'))
vi.mock('@tauri-apps/plugin-os', () => ({ type: osType }))

const native = {
  scaleFactor: vi.fn<() => Promise<number>>(),
  outerPosition: vi.fn<() => Promise<{ x: number, y: number }>>(),
  innerPosition: vi.fn<() => Promise<{ x: number, y: number }>>(),
}

beforeEach(() => {
  vi.resetAllMocks()
  osType.mockReturnValue('macos')
  native.scaleFactor.mockResolvedValue(1)
  native.outerPosition.mockResolvedValue({ x: -500, y: 400 })
  native.innerPosition.mockResolvedValue({ x: -500, y: 420 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('windowScreenPosition', () => {
  it.each([false, true])('macOS inner=%s 读取位置时缩放变化会丢弃混合快照并重读', async (inner) => {
    const position = inner ? native.innerPosition : native.outerPosition
    native.scaleFactor.mockResolvedValueOnce(2).mockResolvedValue(1)
    position.mockResolvedValueOnce({ x: 1000, y: 800 }).mockResolvedValue({ x: -500, y: 400 })

    const result = await windowScreenPosition(native as unknown as Window, inner)

    expect(result.x).toBe(-500)
    expect(result.y).toBe(400)
    expect(position).toHaveBeenCalledTimes(2)
  })

  it('macOS 连续三次缩放不稳定时拒绝错误坐标而不是无限重试', async () => {
    let call = 0
    native.scaleFactor.mockImplementation(async () => ++call % 2 === 1 ? 2 : 1)

    await expect(windowScreenPosition(native as unknown as Window)).rejects.toThrow('PET_POSITION_UNSTABLE_SCALE')
    expect(native.outerPosition).toHaveBeenCalledTimes(3)
  })

  it('非 macOS 保留物理坐标，读位置不增加缩放查询', async () => {
    osType.mockReturnValue('windows')

    const result = await windowScreenPosition(native as unknown as Window)

    expect(result.x).toBe(-500)
    expect(result.y).toBe(400)
    expect(native.scaleFactor).not.toHaveBeenCalled()
  })
})
