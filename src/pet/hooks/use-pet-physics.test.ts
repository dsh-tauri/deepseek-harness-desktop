// @vitest-environment jsdom
import type { PetPhysicsEvent, PetRef } from 'dsh-pet-component'
import type { PetPhysicsControls } from './use-pet-physics'
import { LogicalPosition } from '@tauri-apps/api/window'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePetPhysics } from './use-pet-physics'

/** useListen 的同步登记表：假事件直接投喂给订阅者，不经过 Tauri。 */
const deviceListeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>())

vi.mock('@/hooks/use-listen', () => ({
  useListen: (event: string, handler: (event: { payload: unknown }) => void) => {
    deviceListeners.set(event, handler)
  },
}))

const mocks = vi.hoisted(() => {
  const movedHandlers: Array<(event: { payload: { x: number, y: number } }) => void> = []
  const scaleHandlers: Array<(event: { payload: { scaleFactor: number } }) => void> = []
  return {
    movedHandlers,
    scaleHandlers,
    monitor: vi.fn<() => Promise<unknown>>(),
    osType: vi.fn(() => 'windows'),
    window: {
      outerPosition: vi.fn<() => Promise<unknown>>(),
      scaleFactor: vi.fn<() => Promise<number>>(),
      setPosition: vi.fn<(position: unknown) => Promise<void>>(),
      onMoved: vi.fn<(handler: (event: { payload: { x: number, y: number } }) => void) => Promise<() => void>>(),
      onScaleChanged: vi.fn<(handler: (event: { payload: { scaleFactor: number } }) => void) => Promise<() => void>>(),
    },
  }
})

vi.mock('@tauri-apps/plugin-os', () => ({ type: mocks.osType }))

vi.mock('@tauri-apps/api/window', () => ({
  LogicalPosition: class {
    constructor(public x: number, public y: number) {}
  },
  PhysicalPosition: class {
    constructor(public x: number, public y: number) {}
  },
  currentMonitor: mocks.monitor,
  getCurrentWindow: () => mocks.window,
}))

/** 屏幕工作区 1920x1080（物理像素，jsdom 的 dpr = 1），窗口逻辑位置 (500, 400)。 */
const WORK_AREA = { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } }
const WINDOW_POSITION = { x: 500, y: 400 }

/** 组件校验后送回来的甩出请求：几何铺满视口，脚底在容器底边。 */
function flingEvent(vx: number, vy: number): PetPhysicsEvent {
  return {
    vx,
    vy,
    geometry: { x: 0, y: 0, width: 100, height: 100, body: { left: 0, top: 0, right: 100, bottom: 100 } },
    physics: { gravity: 1400, restitution: 0.78, groundFriction: 2.5, ceilingBounce: true, throwPower: 1, petCollision: false },
  }
}

function createPet(): { fling: ReturnType<typeof vi.fn>, squash: ReturnType<typeof vi.fn>, ref: PetRef } {
  const fling = vi.fn()
  const squash = vi.fn()
  const stopSquash = vi.fn()
  return { fling, squash, ref: { fling, squash, stopSquash } as unknown as PetRef }
}

function advanceFrames(count: number): void {
  act(() => {
    for (let index = 0; index < count; index += 1)
      vi.advanceTimersByTime(16)
  })
}

function pressMouse(pressed: boolean): void {
  const handler = deviceListeners.get('device-mouse-button')
  if (handler === undefined)
    throw new Error('未订阅 device-mouse-button：甩动拿不到 OS 侧的松开时刻（Bug 复现）')
  act(() => {
    handler({ payload: { pressed } })
  })
}

/** 抓住宠物：命中箱上的左键按下（`useWindowDraggable({ onGrab })` 转来的信号）。 */
function grab(controls: PetPhysicsControls): void {
  act(() => {
    controls.onGrab()
  })
}

/** 投喂窗口 Moved：`clock` 控制采样时刻，采样值 = 物理像素 / dpr。 */
function dragWindow(clock: { now: number }, samples: Array<{ t: number, x: number, y: number }>): void {
  for (const sample of samples) {
    clock.now = sample.t
    act(() => {
      for (const handler of [...mocks.movedHandlers])
        handler({ payload: { x: sample.x, y: sample.y } })
    })
  }
}

/** 一次完整的「抓取 → 高速拖拽 → 松手」手势（5000 CSS px/s，远超 500 的甩出门槛）。 */
function flingGesture(controls: PetPhysicsControls, clock: { now: number }): void {
  const start = clock.now
  grab(controls)
  dragWindow(clock, [
    { t: start, x: 1000, y: 500 },
    { t: start + 40, x: 1200, y: 500 },
    { t: start + 80, x: 1400, y: 500 },
    { t: start + 120, x: 1600, y: 500 },
  ])
  clock.now = start + 121
  pressMouse(false)
}

describe('usePetPhysics', () => {
  const clock = { now: 0 }

  async function nativeMove(t: number, x: number, y: number, scale: number): Promise<void> {
    clock.now = t
    mocks.window.scaleFactor.mockResolvedValue(scale)
    mocks.window.outerPosition.mockResolvedValue({ x: x * scale, y: y * scale })
    dragWindow(clock, [{ t, x: x * scale, y: y * scale }])
    await act(async () => {})
  }

  function changeScale(scaleFactor: number): void {
    act(() => {
      for (const handler of mocks.scaleHandlers)
        handler({ payload: { scaleFactor } })
    })
  }

  beforeEach(() => {
    clock.now = 0
    deviceListeners.clear()
    mocks.movedHandlers.length = 0
    mocks.scaleHandlers.length = 0
    vi.clearAllMocks()
    mocks.osType.mockReturnValue('windows')
    mocks.window.scaleFactor.mockResolvedValue(1)
    vi.useFakeTimers()
    vi.spyOn(performance, 'now').mockImplementation(() => clock.now)
    mocks.monitor.mockResolvedValue({ workArea: WORK_AREA })
    mocks.window.outerPosition.mockResolvedValue({
      ...WINDOW_POSITION,
      toLogical: () => ({ ...WINDOW_POSITION }),
    })
    mocks.window.setPosition.mockResolvedValue(undefined)
    mocks.window.onScaleChanged.mockImplementation((handler) => {
      mocks.scaleHandlers.push(handler)
      return Promise.resolve(() => {})
    })
    mocks.window.onMoved.mockImplementation((handler) => {
      mocks.movedHandlers.push(handler)
      return Promise.resolve(() => {})
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('抓住宠物后松开左键，按窗口轨迹估速并请求组件甩出，轨迹随下一次抓取清空', () => {
    const pet = createPet()
    const { result } = renderHook(() => usePetPhysics(pet.ref, 'codex', true))

    grab(result.current)
    dragWindow(clock, [
      { t: 0, x: 1000, y: 500 },
      { t: 40, x: 1200, y: 500 },
      { t: 80, x: 1400, y: 500 },
      { t: 120, x: 1600, y: 500 },
    ])
    clock.now = 121
    pressMouse(false)

    expect(pet.fling).toHaveBeenCalledTimes(1)
    const velocity = pet.fling.mock.calls[0][0] as { vx: number, vy: number }
    expect(velocity.vx).toBeGreaterThan(0)
    expect(velocity.vy).toBeCloseTo(0, 6)

    grab(result.current)
    clock.now = 400
    pressMouse(false)
    expect(pet.fling).toHaveBeenCalledTimes(1)
  })

  it('宿主转来的命中箱松开结算一次甩动，设备流的同一次松开不再重复结算', () => {
    const pet = createPet()
    const { result } = renderHook(() => usePetPhysics(pet.ref, 'codex', true))

    grab(result.current)
    dragWindow(clock, [
      { t: 0, x: 1000, y: 500 },
      { t: 40, x: 1200, y: 500 },
      { t: 80, x: 1400, y: 500 },
      { t: 120, x: 1600, y: 500 },
    ])
    clock.now = 121
    act(() => {
      result.current.onRelease()
    })

    expect(pet.fling).toHaveBeenCalledTimes(1)

    // 设备流的同一次松开随后到达：`pressedRef` 已清，不再结算（也就不会用陈旧轨迹甩出去）。
    clock.now = 130
    pressMouse(false)
    act(() => {
      result.current.onRelease()
    })
    expect(pet.fling).toHaveBeenCalledTimes(1)
  })

  it('没有抓取时的松开是空操作：清状态不会凭空甩出宠物', () => {
    const pet = createPet()
    const { result } = renderHook(() => usePetPhysics(pet.ref, 'codex', true))

    dragWindow(clock, [
      { t: 0, x: 1000, y: 500 },
      { t: 40, x: 1600, y: 500 },
    ])
    act(() => {
      result.current.onRelease()
    })
    pressMouse(false)

    expect(pet.fling).not.toHaveBeenCalled()
  })

  it('窗口几乎没动（低于 500 CSS px/s）的松手不甩', () => {
    const pet = createPet()
    const { result } = renderHook(() => usePetPhysics(pet.ref, 'codex', true))

    grab(result.current)
    dragWindow(clock, [
      { t: 0, x: 1000, y: 500 },
      { t: 100, x: 1010, y: 500 },
    ])
    clock.now = 110
    pressMouse(false)

    expect(pet.fling).not.toHaveBeenCalled()
  })

  it('飞行逐帧移动窗口，落地时触发挤压动画并停在地板上', async () => {
    const pet = createPet()
    const { result } = renderHook(() => usePetPhysics(pet.ref, 'codex', true))

    act(() => {
      result.current.onFling(flingEvent(600, 0))
    })
    await act(async () => {})

    advanceFrames(2)

    // 工作区高 1080 - 脚底 100 = 地板 980；vx 600 CSS px/s 首帧走 9.6px。
    const first = mocks.window.setPosition.mock.calls[1][0] as { x: number, y: number }
    expect(first.x).toBe(Math.round(WINDOW_POSITION.x + 600 * 0.016))

    advanceFrames(120)

    expect(pet.squash).toHaveBeenCalled()
    expect(pet.squash.mock.calls[0][0] as number).toBeGreaterThan(0)
    const positions = mocks.window.setPosition.mock.calls.map(([position]) => position as { x: number, y: number })
    expect(Math.max(...positions.map(position => position.y))).toBeLessThanOrEqual(980)
  })

  it('macOS 按实际窗口逻辑位置采样，跨缩放后保留甩动速度', async () => {
    mocks.osType.mockReturnValue('macos')
    vi.stubGlobal('devicePixelRatio', 2)
    const pet = createPet()
    const { result } = renderHook(() => usePetPhysics(pet.ref, 'codex', true))
    grab(result.current)
    await nativeMove(0, 900, 500, 2)
    await nativeMove(40, 940, 500, 2)
    vi.stubGlobal('devicePixelRatio', 1)
    await nativeMove(80, 980, 500, 1)
    await nativeMove(120, 1020, 500, 1)
    clock.now = 121
    pressMouse(false)

    expect(pet.fling).toHaveBeenCalledOnce()
    expect(pet.fling.mock.calls[0][0].vx).toBeCloseTo(873.125538, 5)
    expect(pet.fling.mock.calls[0][0].vy).toBe(0)
  })

  it.each(['moved-first', 'scale-first'])('macOS 在 %s 交错时序和滞后 DPR 下仍按原生逻辑位移甩动', async (order) => {
    mocks.osType.mockReturnValue('macos')
    vi.stubGlobal('devicePixelRatio', 2)
    const pet = createPet()
    const { result } = renderHook(() => usePetPhysics(pet.ref, 'codex', true))
    grab(result.current)
    await nativeMove(0, 900, 500, 2)
    await nativeMove(40, 940, 500, 2)
    if (order === 'scale-first')
      changeScale(1)
    await nativeMove(80, 980, 500, 1)
    if (order === 'moved-first')
      changeScale(1)
    for (const [t, x] of [[120, 1020], [160, 1060], [200, 1100]])
      await nativeMove(t, x, 500, 1)
    clock.now = 201
    pressMouse(false)

    expect(pet.fling).toHaveBeenCalledOnce()
    expect(pet.fling.mock.calls[0][0].vx).toBeCloseTo(873.125538, 5)
    expect(pet.fling.mock.calls[0][0].vy).toBe(0)
  })

  it('macOS 首个新缩放 Moved 先到后立即松手时，不用跨缩放轨迹制造猛甩', async () => {
    mocks.osType.mockReturnValue('macos')
    vi.stubGlobal('devicePixelRatio', 2)
    const pet = createPet()
    const { result } = renderHook(() => usePetPhysics(pet.ref, 'codex', true))
    grab(result.current)
    await nativeMove(0, 900, 500, 2)
    await nativeMove(40, 940, 500, 2)
    await nativeMove(80, 980, 500, 1)
    clock.now = 81
    pressMouse(false)

    expect(pet.fling).not.toHaveBeenCalled()
    changeScale(1)
    expect(pet.fling).not.toHaveBeenCalled()
  })

  it.each([1, 6])('macOS 每次 IPC 延迟 %sms 且每 16ms 连续 Moved 时，采样不会被后续帧饿死', async (delay) => {
    mocks.osType.mockReturnValue('macos')
    const startedAt = Date.now()
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - startedAt)
    let pending = 0
    let maxPending = 0
    function nativeReply<T>(value: () => T): Promise<T> {
      pending++
      maxPending = Math.max(maxPending, pending)
      return new Promise((resolve) => {
        setTimeout(() => {
          pending--
          resolve(value())
        }, delay)
      })
    }
    mocks.window.scaleFactor.mockImplementation(() => nativeReply(() => 1))
    mocks.window.outerPosition.mockImplementation(() => nativeReply(() => ({ x: 500 + Date.now() - startedAt, y: 500 })))
    const pet = createPet()
    const { result } = renderHook(() => usePetPhysics(pet.ref, 'codex', true))
    grab(result.current)
    for (let frame = 0; frame < 20; frame += 1) {
      setTimeout(() => {
        for (const handler of mocks.movedHandlers)
          handler({ payload: { x: 500 + frame * 16, y: 500 } })
      }, frame * 16)
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(320)
    })
    pressMouse(false)

    expect(pet.fling).toHaveBeenCalledOnce()
    expect(pet.fling.mock.calls[0][0].vx).toBeCloseTo(873.125538, 5)
    expect(pet.fling.mock.calls[0][0].vy).toBe(0)
    expect(maxPending).toBe(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * delay)
    })
    expect(pet.fling).toHaveBeenCalledOnce()
  })

  it('macOS 上一次抓取晚到的位置快照不会污染下一次甩动', async () => {
    mocks.osType.mockReturnValue('macos')
    mocks.window.scaleFactor.mockResolvedValue(2)
    let resolvePosition!: (position: { x: number, y: number }) => void
    mocks.window.outerPosition.mockReturnValueOnce(new Promise((resolve) => {
      resolvePosition = resolve
    }))
    const pet = createPet()
    const { result } = renderHook(() => usePetPhysics(pet.ref, 'codex', true))
    grab(result.current)
    dragWindow(clock, [{ t: 0, x: 1800, y: 1000 }])
    await act(async () => {})
    pressMouse(false)
    expect(pet.fling).not.toHaveBeenCalled()

    grab(result.current)
    await nativeMove(200, 900, 500, 2)
    await act(async () => {
      resolvePosition({ x: 10000, y: 10000 })
    })
    await nativeMove(240, 940, 500, 2)
    await nativeMove(280, 980, 500, 2)
    clock.now = 281
    pressMouse(false)

    expect(pet.fling).toHaveBeenCalledOnce()
    expect(pet.fling.mock.calls[0][0].vx).toBeCloseTo(873.125538, 5)
    expect(pet.fling.mock.calls[0][0].vy).toBe(0)
  })

  it('macOS 卸载会清理 Moved 和晚到的 ScaleChanged 订阅', async () => {
    mocks.osType.mockReturnValue('macos')
    const disposeMoved = vi.fn()
    const disposeScale = vi.fn()
    let resolveScale!: (unlisten: () => void) => void
    mocks.window.onMoved.mockResolvedValueOnce(disposeMoved)
    mocks.window.onScaleChanged.mockReturnValueOnce(new Promise((resolve) => {
      resolveScale = resolve
    }))
    const pet = createPet()
    const { unmount } = renderHook(() => usePetPhysics(pet.ref, 'codex', true))
    await act(async () => {})
    unmount()
    await act(async () => {
      resolveScale(disposeScale)
    })

    expect(disposeMoved).toHaveBeenCalledOnce()
    expect(disposeScale).toHaveBeenCalledOnce()
  })

  it('macOS 飞行按显示器与窗口各自缩放读取几何，并写回逻辑坐标', async () => {
    mocks.osType.mockReturnValue('macos')
    vi.stubGlobal('devicePixelRatio', 2)
    mocks.monitor.mockResolvedValue({
      scaleFactor: 1,
      workArea: { position: { x: -1280, y: -200 }, size: { width: 1280, height: 1024 } },
    })
    mocks.window.scaleFactor.mockResolvedValue(1)
    mocks.window.outerPosition.mockResolvedValue({ x: -500, y: 400, toLogical: (scale: number) => ({ x: -500 / scale, y: 400 / scale }) })
    const pet = createPet()
    const { result } = renderHook(() => usePetPhysics(pet.ref, 'codex', true))
    act(() => {
      result.current.onFling(flingEvent(600, 0))
    })
    await act(async () => {})
    advanceFrames(2)

    const first = mocks.window.setPosition.mock.calls[1][0]
    expect(first).toBeInstanceOf(LogicalPosition)
    expect(first).toEqual({ x: -490, y: 400 })
    advanceFrames(120)
    const positions = mocks.window.setPosition.mock.calls.map(([position]) => position as { x: number, y: number })
    expect(Math.max(...positions.map(position => position.y))).toBe(724)
  })

  it('飞行中在别处点击（全屏左键按下）不停窗口，也不会被当成甩动', async () => {
    const pet = createPet()
    const { result } = renderHook(() => usePetPhysics(pet.ref, 'codex', true))

    act(() => {
      result.current.onFling(flingEvent(600, 0))
    })
    await act(async () => {})
    advanceFrames(2)

    const calls = mocks.window.setPosition.mock.calls.length
    pressMouse(true)
    advanceFrames(10)

    // 全屏左键流分不清「抓宠物」与「在别处点击」：飞行必须继续。
    expect(mocks.window.setPosition.mock.calls.length).toBeGreaterThan(calls)

    pressMouse(false)
    expect(pet.fling).not.toHaveBeenCalled()
  })

  it('卸载后晚到的屏幕信息不会重新启动飞行或移动窗口', async () => {
    let resolve!: (monitor: unknown) => void
    mocks.monitor.mockReturnValueOnce(new Promise((yes) => {
      resolve = yes
    }))
    const pet = createPet()
    const { result, unmount } = renderHook(() => usePetPhysics(pet.ref, 'codex', true))
    act(() => {
      result.current.onFling(flingEvent(600, 0))
    })
    unmount()
    await act(async () => {
      resolve({ workArea: WORK_AREA })
    })
    advanceFrames(3)
    expect(mocks.window.setPosition).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('抓住宠物（命中箱按下）立刻停住飞行，不等落地', async () => {
    const pet = createPet()
    const { result } = renderHook(() => usePetPhysics(pet.ref, 'codex', true))

    act(() => {
      result.current.onFling(flingEvent(600, 0))
    })
    await act(async () => {})
    advanceFrames(2)

    const calls = mocks.window.setPosition.mock.calls.length
    grab(result.current)
    advanceFrames(10)

    expect(mocks.window.setPosition).toHaveBeenCalledTimes(calls)
  })

  it('抛射关闭（默认）时松手不请求甩出，重新开启后同一次手势照常甩出', () => {
    const pet = createPet()
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => usePetPhysics(pet.ref, 'codex', enabled),
      { initialProps: { enabled: false } },
    )

    flingGesture(result.current, clock)
    expect(pet.fling).not.toHaveBeenCalled()

    rerender({ enabled: true })
    flingGesture(result.current, clock)
    expect(pet.fling).toHaveBeenCalledTimes(1)
  })
})
