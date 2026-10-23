// @vitest-environment jsdom
import type { PetGeometry, PetRef } from 'dsh-pet-component'
import type { PetWorkArea } from './use-pet-window-clamp'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clampPetWindowPosition, usePetWindowClamp } from './use-pet-window-clamp'

/**
 * 夹取边界必须与飞行共用 `bodyBounds`（宠物本体 / 脚底），而不是整个窗口：
 * 窗口比宠物宽出一圈透明留白，按整窗夹取会让贴边松手的宠物被推开一段
 * （「左右上边缘松开，会弹开 Pet」）。
 */

const osType = vi.hoisted(() => vi.fn(() => 'windows'))
vi.mock('@tauri-apps/plugin-os', () => ({ type: osType }))

const availableMonitorsMock = vi.hoisted(() => vi.fn<() => Promise<unknown[]>>())

vi.mock('@tauri-apps/api/window', () => ({
  availableMonitors: availableMonitorsMock,
}))

/** 100% dsh 大小、底部居中的宠物：窗口 420 宽，本体 220 宽（左右各 100 透明留白）。 */
const GEOMETRY: PetGeometry = {
  x: 300,
  y: 100,
  width: 220,
  height: 200,
  body: { left: 400, top: 180, right: 620, bottom: 380 },
}

/** 单个显示器工作区（物理像素，scale = 1）。 */
const MONITOR: PetWorkArea = { x: 0, y: 0, width: 1920, height: 1080 }
/** 缩放 2 倍时的同一个工作区。 */
const MONITOR_SCALED: PetWorkArea = { x: 0, y: 0, width: 3840, height: 2160 }

function clampAt(
  position: { x: number, y: number },
  options: { dsh?: boolean, areas?: readonly PetWorkArea[], scale?: number } = {},
): { x: number, y: number } {
  return clampPetWindowPosition(position, GEOMETRY, options.dsh ?? true, options.areas ?? [MONITOR], options.scale ?? 1)
}

function fakePetRef(geometry: PetGeometry | null): PetRef {
  return { geometry } as unknown as PetRef
}

/** 让在途的 `availableMonitors()` 回调落地。 */
async function settlePromises(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 4; index += 1)
      await Promise.resolve()
  })
}

beforeEach(() => {
  osType.mockReturnValue('windows')
  availableMonitorsMock.mockReset()
  availableMonitorsMock.mockResolvedValue([{ workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } } }])
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('clampPetWindowPosition', () => {
  it('工作区内不动', () => {
    expect(clampAt({ x: 900, y: 400 })).toEqual({ x: 900, y: 400 })
  })

  it('左边缘：窗口探出屏幕 100px，宠物本体正好贴边', () => {
    const clamped = clampAt({ x: -500, y: 400 })

    expect(clamped.x).toBe(-400)
    // 本体左缘正好落在工作区左缘：留白可以留在屏幕外，宠物本身必须完整可见。
    expect(clamped.x + GEOMETRY.body.left).toBe(MONITOR.x)
  })

  it('右边缘：本体右缘贴住工作区右缘', () => {
    const clamped = clampAt({ x: 5000, y: 400 })

    expect(clamped.x).toBe(1300)
    expect(clamped.x + GEOMETRY.body.right).toBe(MONITOR.x + MONITOR.width)
  })

  it('上边缘：按容器顶边（与飞行同一套 bodyBounds）', () => {
    expect(clampAt({ x: 900, y: -500 }).y).toBe(-100)
  })

  it('下边缘：按 dsh 的脚底比例留出脚下空间', () => {
    // feet = height * 330 / 360 ≈ 183.33；窗口下界 = 1080 - feet - y(100) ≈ 796.67。
    expect(clampAt({ x: 900, y: 5000 }).y).toBeCloseTo(796.6667, 3)
  })

  it('codex 用本体底边当脚底，可用高度与 dsh 不同', () => {
    expect(clampAt({ x: 900, y: 5000 }, { dsh: false }).y).toBe(700)
  })

  it('多显示器：本体中心落在哪块屏就用哪块屏的边界', () => {
    const monitors: PetWorkArea[] = [MONITOR, { x: 1920, y: 0, width: 1280, height: 1024 }]

    // 本体中心在第二块屏内：位置合法，不该被第一块屏的右边界拉回来。
    expect(clampAt({ x: 2000, y: 400 }, { areas: monitors }).x).toBe(2000)
    // 第二块屏的右界（3200）才是这里的边界：本体右缘贴住它。
    expect(clampAt({ x: 5000, y: 400 }, { areas: monitors }).x).toBe(2580)
    // 同一位置若只有第一块屏，就会被夹到 1300 —— 证明选屏确实生效。
    expect(clampAt({ x: 2000, y: 400 }).x).toBe(1300)
  })

  it('屏幕间隙：取最近的工作区', () => {
    const gapped: PetWorkArea[] = [MONITOR, { x: 2200, y: 0, width: 1280, height: 1024 }]

    // 本体中心 2110 落在 1920–2200 的间隙里，最近的第二块屏左界把窗口顶到 1800。
    expect(clampAt({ x: 1600, y: 400 }, { areas: gapped }).x).toBe(1800)
  })

  it('缩放按 devicePixelRatio 换算物理像素', () => {
    expect(clampAt({ x: -5000, y: 400 }, { areas: [MONITOR_SCALED], scale: 2 }).x).toBe(-800)
    expect(clampAt({ x: 5000, y: 400 }, { areas: [MONITOR_SCALED], scale: 2 }).x).toBe(2600)
  })

  it('还没读到显示器工作区时不夹取', () => {
    expect(clampAt({ x: 5000, y: 5000 }, { areas: [] })).toEqual({ x: 5000, y: 5000 })
  })
})

describe('usePetWindowClamp', () => {
  it('geometry 未就绪时原样返回', () => {
    const { result } = renderHook(() => usePetWindowClamp(fakePetRef(null), 'dsh'))

    expect(result.current.clampPosition({ x: 5000, y: 5000 })).toEqual({ x: 5000, y: 5000 })
  })

  it('挂载时读取显示器工作区，之后按本体夹取', async () => {
    const { result } = renderHook(() => usePetWindowClamp(fakePetRef(GEOMETRY), 'dsh'))
    await settlePromises()

    const clamped = result.current.clampPosition({ x: 5000, y: 5000 })

    expect(clamped.x).toBe(1300)
    expect(clamped.y).toBeCloseTo(796.6667, 3)
  })

  it('macOS 混合缩放屏幕按各自缩放还原工作区，允许负坐标', async () => {
    osType.mockReturnValue('macos')
    vi.stubGlobal('devicePixelRatio', 2)
    availableMonitorsMock.mockResolvedValue([
      { scaleFactor: 2, workArea: { position: { x: 0, y: 0 }, size: { width: 3840, height: 2160 } } },
      { scaleFactor: 1, workArea: { position: { x: -1280, y: -200 }, size: { width: 1280, height: 1024 } } },
    ])
    const { result } = renderHook(() => usePetWindowClamp(fakePetRef(GEOMETRY), 'dsh'))
    await settlePromises()

    expect(result.current.clampPosition({ x: -1000, y: 0 })).toEqual({ x: -1000, y: 0 })
    expect(result.current.clampPosition({ x: 5000, y: 400 })).toEqual({ x: 1300, y: 400 })
    vi.stubGlobal('devicePixelRatio', 1)
    expect(result.current.clampPosition({ x: -5000, y: 0 })).toEqual({ x: -1680, y: 0 })
  })

  it('refreshWorkAreas 重新读取显示器列表（插拔显示器后立刻生效）', async () => {
    const { result } = renderHook(() => usePetWindowClamp(fakePetRef(GEOMETRY), 'dsh'))
    await settlePromises()
    availableMonitorsMock.mockResolvedValue([{ workArea: { position: { x: -1280, y: 0 }, size: { width: 1280, height: 1024 } } }])

    act(() => {
      result.current.refreshWorkAreas()
    })
    await settlePromises()

    // 新的工作区在左侧：左界变成 -1280 - 100 - 300 = -1680。
    expect(result.current.clampPosition({ x: -5000, y: 400 }).x).toBe(-1680)
  })
})
