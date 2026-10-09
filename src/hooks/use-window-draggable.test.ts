// @vitest-environment jsdom
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { UseWindowDraggableOptions, UseWindowDraggableResult } from './use-window-draggable'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWindowDraggable } from './use-window-draggable'

/**
 * 本文件把 `useListen` 替换成同步登记表：跟手的坐标来源（`device-mouse-move`）与
 * 松手信号（`device-mouse-button`）都来自后端设备流，而真实 `listen` 要走 Tauri
 * IPC，在 jsdom 里无法投递。
 */
const deviceListeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>())

vi.mock('@/hooks/use-listen', () => ({
  useListen: (event: string, handler: (event: { payload: unknown }) => void) => {
    deviceListeners.set(event, handler)
  },
}))

const invokeMock = vi.hoisted(() => vi.fn<(command: string, args?: Record<string, number>) => Promise<void>>())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

/** 只 mock 窗口位置读写：跟手就是每帧把窗口绝对定位到弹簧算出的位置。 */
const windowMock = vi.hoisted(() => ({
  outerPosition: vi.fn<() => Promise<{ x: number, y: number }>>(),
  setPosition: vi.fn<(position: { x: number, y: number }) => Promise<void>>(),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => windowMock,
  PhysicalPosition: class PhysicalPosition {
    x: number
    y: number
    constructor(x: number, y: number) {
      this.x = x
      this.y = y
    }
  },
}))

/** 与 `use-window-draggable.ts` 的常量一致（模块私有，不导出）。 */
const DRAG_START_THRESHOLD = 5
const DRAG_DIRECTION_IDLE_TIMEOUT = 350
const DRAG_SESSION_TIMEOUT = 1500
/** jsdom 的 `devicePixelRatio` 恒为 1（门槛按 `5 * SCALE` 换算）。 */
const SCALE = globalThis.devicePixelRatio || 1
/** 按下时的窗口左上角（物理像素）。 */
const BASE = { x: 1000, y: 500 }
/** 按下时的光标位置（物理像素，与窗口同一坐标系）。 */
const CURSOR = { x: 500, y: 300 }

/**
 * 默认不夹取：本文件验证弹簧与手势本身，夹取边界另有专门用例。真实宿主必须给
 * `clampPosition`（宠物靠它保证贴边合法，见 `use-pet-window-clamp.ts`）。
 */
const noClamp = (position: { x: number, y: number }): { x: number, y: number } => position

function useDraggable(options: Partial<UseWindowDraggableOptions> = {}): UseWindowDraggableResult {
  return useWindowDraggable({ clampPosition: noClamp, ...options })
}

/** 造一个命中箱指针事件：hook 只用按钮/指针 id/主指针标记。 */
function pointerEvent(options: { button?: number, isPrimary?: boolean, pointerId?: number } = {}): ReactPointerEvent<HTMLDivElement> {
  return {
    button: options.button ?? 0,
    pointerId: options.pointerId ?? 1,
    isPrimary: options.isPrimary ?? true,
  } as unknown as ReactPointerEvent<HTMLDivElement>
}

/** 让在途的 promise 回调（如按下的 `outerPosition()`）落地。 */
async function settlePromises(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 4; index += 1)
      await Promise.resolve()
  })
}

async function press(draggable: UseWindowDraggableResult, options?: { button?: number, pointerId?: number }): Promise<void> {
  act(() => {
    draggable.onPointerDown(pointerEvent(options))
  })
  // 按下要异步读窗口原位：不等它落地，滚动门槛时手势拿不到基准点。
  await settlePromises()
}

function release(draggable: UseWindowDraggableResult, options?: { button?: number, pointerId?: number }): void {
  act(() => {
    draggable.onPointerUp(pointerEvent(options))
  })
}

/** 后端设备流上报的光标位置（虚拟屏幕物理像素）。 */
function emitCursor(x: number, y: number): void {
  const handler = deviceListeners.get('device-mouse-move')
  if (handler === undefined)
    throw new Error('未订阅 device-mouse-move：跟手拿不到坐标')
  act(() => {
    handler({ payload: { x, y } })
  })
}

/** 后端设备流上报的左键状态。 */
function emitButton(pressed: boolean): void {
  const handler = deviceListeners.get('device-mouse-button')
  if (handler === undefined)
    throw new Error('未订阅 device-mouse-button：丢 pointerup 时无法收尾')
  act(() => {
    handler({ payload: { pressed } })
  })
}

/**
 * 推进 rAF 帧（每帧 16ms）。注意 `useRafFn` 在 `resume()` 后的首帧 delta 为 0，
 * 弹簧积分从第 2 帧才开始，所以「一步积分」需要至少 2 帧。
 */
function frames(count = 1): void {
  act(() => {
    vi.advanceTimersByTime(16 * count)
  })
}

/** 按下并移动 `dx/dy` 物理像素，越过门槛进入拖拽态（真实场景按下前就有光标样本）。 */
async function startDrag(draggable: UseWindowDraggableResult, dx = 12, dy = 0): Promise<void> {
  emitCursor(CURSOR.x, CURSOR.y)
  await press(draggable)
  emitCursor(CURSOR.x + dx, CURSOR.y + dy)
}

/** 最近一次下发的窗口位置。 */
function lastPosition(): { x: number, y: number } {
  const last = windowMock.setPosition.mock.calls.at(-1)
  if (last === undefined)
    throw new Error('setPosition 从未被调用')
  return last[0]
}

beforeEach(() => {
  vi.useFakeTimers()
  deviceListeners.clear()
  invokeMock.mockReset()
  invokeMock.mockResolvedValue(undefined)
  windowMock.outerPosition.mockReset()
  windowMock.outerPosition.mockResolvedValue({ x: BASE.x, y: BASE.y })
  windowMock.setPosition.mockReset()
  windowMock.setPosition.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useWindowDraggable', () => {
  it('门槛内不移动窗口：位移不足时按单击处理', async () => {
    const { result } = renderHook(() => useDraggable())

    emitCursor(CURSOR.x, CURSOR.y)
    await press(result.current)
    emitCursor(CURSOR.x + DRAG_START_THRESHOLD * SCALE - 1, CURSOR.y)
    frames(4)

    expect(result.current.dragging).toBe(false)
    expect(windowMock.setPosition).not.toHaveBeenCalled()

    release(result.current)
    expect(invokeMock).not.toHaveBeenCalledWith('move_pet_window', expect.anything())
    expect(invokeMock).not.toHaveBeenCalledWith('persist_pet_window_position')
  })

  it('越门槛后进入拖拽态，窗口从原位起步缓慢追光标（第 1 帧只走一小段）', async () => {
    const { result } = renderHook(() => useDraggable())

    await startDrag(result.current, 40)
    expect(result.current.dragging).toBe(true)

    frames(2)
    const first = lastPosition()
    expect(first.x).toBeGreaterThan(BASE.x)
    // 40px 的目标，第 1 帧只走几个像素 —— 这就是上游 playground 的「缓慢跟手」。
    expect(first.x).toBeLessThan(BASE.x + 40)
    expect(first.y).toBe(BASE.y)
  })

  it('窗口最终收敛到光标处：不会滞留在指针后面', async () => {
    const { result } = renderHook(() => useDraggable())

    await startDrag(result.current, 40, 15)
    frames(60)

    expect(lastPosition()).toEqual({ x: BASE.x + 40, y: BASE.y + 15 })
  })

  it('弹簧追的是绝对位置：门槛前丢掉的位移会在越过门槛后补上', async () => {
    const { result } = renderHook(() => useDraggable())

    emitCursor(CURSOR.x, CURSOR.y)
    await press(result.current)
    // 门槛内先走 4px，再越门槛 —— 目标始终按「按下位置」算，不按增量累加。
    emitCursor(CURSOR.x + 4, CURSOR.y)
    expect(result.current.dragging).toBe(false)
    emitCursor(CURSOR.x + 8, CURSOR.y)
    expect(result.current.dragging).toBe(true)

    frames(60)
    expect(lastPosition()).toEqual({ x: BASE.x + 8, y: BASE.y })
  })

  it('手势门槛按 devicePixelRatio 换算成物理像素', async () => {
    vi.stubGlobal('devicePixelRatio', 2)
    const { result } = renderHook(() => useDraggable())

    emitCursor(CURSOR.x, CURSOR.y)
    await press(result.current)
    // 缩放 2 倍时门槛是 10 物理像素。
    emitCursor(CURSOR.x + 8, CURSOR.y)
    expect(result.current.dragging).toBe(false)

    emitCursor(CURSOR.x + 12, CURSOR.y)
    expect(result.current.dragging).toBe(true)
  })

  it('方向按相邻样本的水平位移判定，拖拽停顿时归零', async () => {
    const { result } = renderHook(() => useDraggable())

    await startDrag(result.current, 12)
    // 越过门槛的那一帧没有上一个样本，方向先不判定（与上游轨迹语义一致）。
    expect(result.current.direction).toBeUndefined()

    emitCursor(CURSOR.x + 16, CURSOR.y)
    expect(result.current.direction).toBe('right')

    emitCursor(CURSOR.x + 12, CURSOR.y)
    expect(result.current.direction).toBe('left')

    act(() => {
      vi.advanceTimersByTime(DRAG_DIRECTION_IDLE_TIMEOUT)
    })
    expect(result.current.direction).toBeUndefined()
    expect(result.current.dragging).toBe(true)

    emitCursor(CURSOR.x + 20, CURSOR.y)
    expect(result.current.direction).toBe('right')
  })

  it('pointerup 收尾，且只认同一个 pointerId', async () => {
    const { result } = renderHook(() => useDraggable())

    await startDrag(result.current, 12)
    expect(result.current.dragging).toBe(true)

    release(result.current, { pointerId: 2 })
    expect(result.current.dragging).toBe(true)

    release(result.current, { pointerId: 1 })
    expect(result.current.dragging).toBe(false)
    expect(result.current.direction).toBeUndefined()
  })

  it('收尾时只持久化位置：整窗夹取会把贴边宠物推开', async () => {
    const { result } = renderHook(() => useDraggable())

    await startDrag(result.current, 12)
    release(result.current)

    expect(invokeMock).toHaveBeenCalledWith('persist_pet_window_position')
    // 不再走整窗夹取：宠物四周的透明留白会被算进去，贴边松手时把宠物推开一段。
    expect(invokeMock).not.toHaveBeenCalledWith('move_pet_window', expect.anything())
  })

  it('每帧按 clampPosition 夹取：顶到边界就停住，越界位移不会攒起来', async () => {
    const bound = { x: BASE.x + 30, y: BASE.y + 10 }
    const clampPosition = vi.fn((position: { x: number, y: number }): { x: number, y: number } => ({
      x: Math.min(position.x, bound.x),
      y: Math.min(position.y, bound.y),
    }))
    const { result } = renderHook(() => useDraggable({ clampPosition }))

    // 光标一路推到边界外 200px：弹簧被夹在边界上，而不是先跟到光标再回弹。
    await startDrag(result.current, 200, 60)
    frames(60)

    expect(clampPosition).toHaveBeenCalled()
    expect(lastPosition()).toEqual(bound)
    expect(windowMock.setPosition.mock.calls.every(([position]) => position.x <= bound.x && position.y <= bound.y)).toBe(true)

    // 松手后停在边缘：收尾不再有第二次「夹回屏幕内」的移动。
    release(result.current)
    expect(lastPosition()).toEqual(bound)
  })

  it('每个手势只报一次松开：pointerup 与设备流重复上报不会重复结算', async () => {
    const onRelease = vi.fn()
    const { result } = renderHook(() => useDraggable({ onRelease }))

    // 单击（没过门槛）同样要报：抓取时物理层已进入「按住」，松手必须清掉。
    await press(result.current)
    release(result.current)
    expect(onRelease).toHaveBeenCalledTimes(1)

    // 同一次松开的设备流上报随后到达：不该再结算一遍。
    emitButton(false)
    expect(onRelease).toHaveBeenCalledTimes(1)

    // 下一次手势照常只报一次（这次由设备流收尾）。
    await startDrag(result.current, 12)
    emitButton(false)
    expect(onRelease).toHaveBeenCalledTimes(2)
  })

  it('后端设备流报告松开时立即收尾，不等停歇阈值', async () => {
    const { result } = renderHook(() => useDraggable())

    await startDrag(result.current, 12)
    expect(result.current.dragging).toBe(true)

    emitButton(false)

    expect(result.current.dragging).toBe(false)
    expect(result.current.direction).toBeUndefined()
  })

  it('设备流确认仍按住时，停歇超时不结束拖拽（按住不动再拖不会被误杀）', async () => {
    const { result } = renderHook(() => useDraggable())

    await startDrag(result.current, 12)
    emitButton(true)

    act(() => {
      vi.advanceTimersByTime(DRAG_SESSION_TIMEOUT)
    })
    expect(result.current.dragging).toBe(true)

    emitCursor(CURSOR.x + 60, CURSOR.y)
    frames(60)
    expect(lastPosition()).toEqual({ x: BASE.x + 60, y: BASE.y })
  })

  it('设备流失联时仍由停歇阈值兜底收尾（丢 pointerup 不会永久粘住）', async () => {
    const { result } = renderHook(() => useDraggable())

    await startDrag(result.current, 12)
    expect(result.current.dragging).toBe(true)

    act(() => {
      vi.advanceTimersByTime(DRAG_SESSION_TIMEOUT)
    })

    expect(result.current.dragging).toBe(false)
    expect(invokeMock).toHaveBeenCalledWith('persist_pet_window_position')
  })

  it('只认左键：右键按下不开启会话、不移动窗口', () => {
    const { result } = renderHook(() => useDraggable())

    act(() => {
      result.current.onPointerDown(pointerEvent({ button: 2 }))
    })
    emitCursor(CURSOR.x + 40, CURSOR.y)
    frames(4)

    expect(result.current.dragging).toBe(false)
    expect(windowMock.setPosition).not.toHaveBeenCalled()
  })

  it('命中箱左键按下即通知抓取（不等手势门槛）；右键/非主指针/重复按下都不通知', () => {
    const onGrab = vi.fn()
    const { result } = renderHook(() => useDraggable({ onGrab }))

    act(() => {
      result.current.onPointerDown(pointerEvent({ button: 2 }))
      result.current.onPointerDown(pointerEvent({ isPrimary: false }))
    })
    expect(onGrab).not.toHaveBeenCalled()

    // 门槛前就通知：抓取刹车要发生在按下的那一刻，跟手才等 5px。
    act(() => {
      result.current.onPointerDown(pointerEvent())
    })
    expect(onGrab).toHaveBeenCalledTimes(1)

    // 手势进行中的第二次按下不再重复通知宿主。
    act(() => {
      result.current.onPointerDown(pointerEvent({ pointerId: 2 }))
    })
    expect(onGrab).toHaveBeenCalledTimes(1)

    release(result.current)
    act(() => {
      result.current.onPointerDown(pointerEvent({ pointerId: 3 }))
    })
    expect(onGrab).toHaveBeenCalledTimes(2)
  })

  it('读不到窗口原位时放弃这次手势，窗口保持不动', async () => {
    windowMock.outerPosition.mockRejectedValue(new Error('window unavailable'))
    const { result } = renderHook(() => useDraggable())

    await startDrag(result.current, 40)
    frames(4)

    expect(result.current.dragging).toBe(false)
    expect(windowMock.setPosition).not.toHaveBeenCalled()
  })

  it('拖拽订阅不提前启动由穿透控制器管理的设备流', () => {
    renderHook(() => useDraggable())

    expect(invokeMock).not.toHaveBeenCalledWith('start_pet_mouse_stream')
  })
})
