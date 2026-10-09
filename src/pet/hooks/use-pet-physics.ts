import type { PetPhysicsEvent, PetRef, PhysicsParams } from 'dsh-pet-component'
import type { DragSample, ThrowBounds, ThrowState } from './use-pet-physics.helpers'
import { useRafFn } from '@reause/core'
import { currentMonitor, getCurrentWindow, PhysicalPosition } from '@tauri-apps/api/window'
import { useEffect, useRef } from 'react'
import { useListen } from '@/hooks/use-listen'
import { reportPetIssue } from '../utils/log'
import { bodyBounds, estimateReleaseVelocity, stepThrow } from './use-pet-physics.helpers'

/** 轨迹最多留 64 个样本：估速只看最近 150ms，长拖不必无限增长。 */
const TRAIL_LIMIT = 64

/**
 * 宿主侧甩动：把「松手 → 请求甩出 → 飞行 → 落地 Q 弹」接在 dsh-pet-component 的协议上。
 *
 * 组件 0.2.3 起把甩动物理留给宿主（见组件 `docs/spec/pet-interactions.md` 的职责划分），
 * 桌宠宿主的舞台就是显示器工作区、宠物本体就是窗口，于是飞行 = 每帧 `setPosition`：
 *
 * - **轨迹来自窗口 `Moved`**：拖拽由 `use-window-draggable.ts` 的弹簧每帧 `setPosition`
 *   驱动，命中箱的 `pointermove` 是相对窗口的坐标、会自我反馈，因此窗口位移仍是能看出
 *   「甩得多快」的信号；松开时刻有两条路 —— 命中箱 `pointerup`（更早、更可靠）与
 *   `device-mouse-button`（OS 侧兜底），两条都汇到 `onRelease` 且只结算一次
 *   （见 `use-window-draggable.ts`），与窗口位移一起拼出一次甩动；
 * - **抓取只认命中箱**：`device-mouse-button` 是**全屏**左键流，在桌面别处的点击同样会
 *   上报「按下」；拿它当抓取会让甩出中的宠物被无关点击刹车。真正的抓取信号是命中箱上的
 *   `pointerdown`（`useWindowDraggable({ onGrab })` → `onGrab`），它同时给这次甩动开
 *   轨迹；
 * - **增益只在 `onFling` 里施加**：松手时先用 `throwPower = 1` 判断「这一下要不要甩」，
 *   组件回吐的 `PetPhysicsEvent` 才带着合并后的 `physics`（prop > 配置 > 默认），速度的
 *   `throwPower` 放大因此只能在那里做 —— 默认值 1 时与组件参考实现完全等价；
 * - **单位是 CSS px**：重力/速度都按组件默认参数的语义（CSS px/s）算，写回窗口时乘
 *   `devicePixelRatio` 换成物理像素；Retina 上不去换算，观感速度会差一倍；
 * - 单宠物窗口没有宠物间碰撞，`physics.petCollision` 与 `pet.bounce` 不适用；
 * - **抛射开关默认关闭**（issue #930）：`throwEnabled` 为假时松手只结算并清状态，
 *   不请求甩出，因此没有飞行也没有撞边回弹；拖拽本身照常工作。
 */
export function usePetPhysics(pet: PetRef, kind: 'dsh' | 'codex' | undefined, throwEnabled: boolean): PetPhysicsControls {
  const trailRef = useRef<DragSample[]>([])
  /** 是否抓住了宠物（信号来自命中箱 `pointerdown`，见 `onGrab`）：轨迹只在抓取后采样。 */
  const pressedRef = useRef(false)
  const flightRef = useRef<Flight | null>(null)
  // 飞行代号：起飞行要 await 显示器与窗口位置，期间可能被「抓取取消」或下一次甩动顶掉。
  const flightIdRef = useRef(0)
  const kindRef = useRef(kind)
  kindRef.current = kind
  const throwEnabledRef = useRef(throwEnabled)
  throwEnabledRef.current = throwEnabled
  // useRafFn 每渲染返回新对象，飞行循环统一走 ref，避免闭包抓到旧的 pause/resume。
  const rafRef = useRef<{ pause: () => void, resume: () => void } | null>(null)

  const raf = useRafFn(({ delta }) => {
    const flight = flightRef.current
    if (flight === null) {
      rafRef.current?.pause()
      return
    }

    const next = stepThrow(flight.state, delta / 1000, flight.bounds, flight.physics)
    flight.state = { x: next.x, y: next.y, vx: next.vx, vy: next.vy }
    // 窗口位置取整：亚像素位置在 Windows 上会被系统四舍五入，抖动比丢精度更显眼。
    void getCurrentWindow()
      .setPosition(new PhysicalPosition(
        Math.round((next.x - flight.originX) * flight.scale),
        Math.round((next.y - flight.originY) * flight.scale),
      ))
      .catch(() => {})

    // 落地 Q 弹复用组件的挤压动画；力度是撞击瞬间的下坠速度（积分前）。
    if (next.landed)
      pet.squash(next.impactSpeed)
    if (next.atRest)
      flightRef.current = null
  }, { immediate: false })
  rafRef.current = raf

  useEffect(() => {
    // keep:effect 拖拽的每帧 setPosition 同样触发 Moved，甩动轨迹以窗口位移为准
    let disposed = false
    let unlisten: (() => void) | undefined

    void getCurrentWindow()
      .onMoved((event) => {
        if (!pressedRef.current)
          return
        const scale = window.devicePixelRatio
        const samples = trailRef.current
        samples.push({ t: performance.now(), x: event.payload.x / scale, y: event.payload.y / scale })
        if (samples.length > TRAIL_LIMIT)
          samples.splice(0, samples.length - TRAIL_LIMIT)
      })
      .then((fn) => {
        if (disposed)
          fn()
        else
          unlisten = fn
      })
      .catch(error => reportPetIssue('fling-moved', error))

    return () => {
      disposed = true
      stopFlight()
      unlisten?.()
    }
  }, [])

  // 只认松开：`device-mouse-button` 是全屏左键流，别处的点击也会上报按下，
  // 因此「抓取」不能看它 —— 那会让甩出中的宠物被无关点击刹车。抓取走 `onGrab`
  // （命中箱 `pointerdown`）；松开统一走 `onRelease`，这里只是设备流这条路径。
  useListen<MouseButtonState>('device-mouse-button', ({ payload }) => {
    if (payload.pressed)
      return
    onRelease()
  })

  /** 终止飞行（含尚未起飞的请求）：抓取、下一次甩出、卸载都走这里。 */
  function stopFlight(): void {
    flightIdRef.current += 1
    if (flightRef.current === null)
      return
    flightRef.current = null
    rafRef.current?.pause()
  }

  return { onFling, onGrab, onRelease }

  /**
   * 抓住宠物（命中箱上的左键按下）：立刻刹车 + 清空轨迹。
   *
   * 组件自己会取消挤压动画，这里只要停下窗口飞行；轨迹从抓取这一刻重新计时，
   * 抓取前的窗口位移不再算进这次甩动的速度。刹车发生在按下瞬间（不等拖拽门槛），
   * 因此「接住飞过来的宠物」和「按下不动」都能让它停住。
   */
  function onGrab(): void {
    pressedRef.current = true
    trailRef.current = []
    stopFlight()
  }

  /**
   * 松开宠物：结算一次甩动，并清掉「按住」状态。
   *
   * 命中箱的 `pointerup`（经 `useWindowDraggable({ onRelease })`）与后端设备流的松开都
   * 指向这里，重复的松开只生效一次。少了这条「谁先到谁结算」的路径，漏掉的松开会让
   * `pressedRef` 一直是 true：轨迹继续采样窗口位移，很久以后一次无关点击就能把宠物甩出去。
   */
  function onRelease(): void {
    if (!pressedRef.current)
      return
    pressedRef.current = false

    const trail = trailRef.current
    trailRef.current = []
    // 抛射关闭时不起飞行：松手照常结算、清掉按住状态，但宠物就停在原地。
    if (!throwEnabledRef.current)
      return
    const release = estimateReleaseVelocity(trail, performance.now(), 1)
    if (release !== null)
      pet.fling(release)
  }

  /** 组件校验后的甩出请求：读出几何与屏幕工作区，把这次甩动变成一次飞行。 */
  function onFling(event: PetPhysicsEvent): void {
    const id = flightIdRef.current + 1
    flightIdRef.current = id
    flightRef.current = null
    rafRef.current?.pause()
    void startFlight(event, id)
  }

  /** 组件校验后的甩出请求：读出几何与屏幕工作区，把这次甩动变成一次飞行。 */
  async function startFlight(event: PetPhysicsEvent, id: number): Promise<void> {
    try {
      const [monitor, position] = await Promise.all([currentMonitor(), getCurrentWindow().outerPosition()])
      // 等待期间被下一次甩动或抓取顶掉：这次请求作废。
      if (monitor === null || id !== flightIdRef.current)
        return

      const scale = window.devicePixelRatio
      const area = monitor.workArea
      // 工作区与窗口位置都是物理像素，除 dpr 换成视口 px（= CSS px）后才能和组件几何对齐。
      const stage = {
        x: area.position.x / scale,
        y: area.position.y / scale,
        width: area.size.width / scale,
        height: area.size.height / scale,
      }
      const local = bodyBounds(event.geometry, stage.width, stage.height, kindRef.current === 'dsh')
      const origin = position.toLogical(scale)

      flightRef.current = {
        // 组件几何挂在本窗口的视口上：容器屏幕坐标 = 窗口逻辑位置 + 视口原点。
        state: {
          x: origin.x + event.geometry.x,
          y: origin.y + event.geometry.y,
          vx: event.vx * event.physics.throwPower,
          vy: event.vy * event.physics.throwPower,
        },
        physics: event.physics,
        bounds: {
          minX: stage.x + local.minX,
          minY: stage.y + local.minY,
          maxX: stage.x + local.maxX,
          maxY: stage.y + local.maxY,
        },
        originX: event.geometry.x,
        originY: event.geometry.y,
        scale,
      }
      rafRef.current?.resume()
    }
    catch (error) {
      reportPetIssue('fling', error)
    }
  }
}

/** 一次飞行的全部状态：位置/速度 + 参数快照 + 屏幕边界 + 窗口换算。 */
interface Flight {
  state: ThrowState
  physics: PhysicsParams
  bounds: ThrowBounds
  /** 容器（宠物）在窗口视口里的原点：窗口位置 = 飞行位置 - 原点。 */
  originX: number
  originY: number
  /** 起飞行时的 `devicePixelRatio`（= Tauri 缩放系数），每帧换算窗口位置用。 */
  scale: number
}

/** `device-mouse-button` 的事件载荷（对应 Rust 的 `MouseButtonState`）。 */
interface MouseButtonState {
  pressed: boolean
}

/** 甩动控制的出口：`onFling` 接组件回吐的甩出请求，`onGrab`/`onRelease` 接命中箱上的抓取与松开。 */
export interface PetPhysicsControls {
  /** 组件校验后的甩出请求（接到 `<Pet onFling>`）。 */
  onFling: (event: PetPhysicsEvent) => void
  /**
   * 抓住宠物：接到命中箱的 `pointerdown`（经 `useWindowDraggable({ onGrab })`，
   * 见 `src/pet/app.tsx`）。
   */
  onGrab: () => void
  /**
   * 松开宠物：接到拖拽手势结束时的那一次通知（经 `useWindowDraggable({ onRelease })`）。
   * 与后端 `device-mouse-button` 的松开共用同一条结算路径，重复上报只生效一次。
   */
  onRelease: () => void
}
