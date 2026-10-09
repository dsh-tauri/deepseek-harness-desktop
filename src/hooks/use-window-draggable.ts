import type { PointerEvent as ReactPointerEvent } from 'react'
import { useRafFn, useTimeoutFn } from '@reause/core'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow, PhysicalPosition } from '@tauri-apps/api/window'
import { useRef, useState } from 'react'
import { useListen } from '@/hooks/use-listen'

/** 拖拽的水平方向。 */
type DragDirection = 'left' | 'right'

/**
 * `device-mouse-move` 事件载荷：全局光标位置（虚拟屏幕物理像素，
 * 与窗口 `outerPosition()` 同一坐标系）。对应后端 `MouseCursorPos`。
 */
interface DeviceMousePosition {
  x: number
  y: number
}

/**
 * `device-mouse-button` 事件载荷：全局鼠标左键是否按下。
 * 与后端 `src-tauri/src/desktop/pet_mouse.rs` 的 `MouseButtonState` 一一对应。
 */
interface MouseButtonState {
  pressed: boolean
}

export interface UseWindowDraggableResult {
  /** 拖拽会话进行中（越过手势门槛才算，松手或兜底收尾后为 false）。 */
  dragging: boolean
  /** 当前拖拽方向；未拖拽、位移不足或拖拽停顿时为 undefined。 */
  direction: DragDirection | undefined
  /** 命中箱 pointerdown（`<Pet>` 的 `onHitboxPointerDown`）：开启手势并记录按下位置。 */
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  /** 命中箱 pointerup（`<Pet>` 的 `onHitboxPointerUp`）：指针侧即时收尾。 */
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void
}

/** 拖拽钩子的夹取与回调。 */
export interface UseWindowDraggableOptions {
  /**
   * 每帧把弹簧算出的窗口位置夹进可见区域（物理像素，与窗口 `outerPosition()` 同一
   * 坐标系），返回夹取后的位置。
   *
   * 等价于上游 playground `usePetDrag` 的 `getBounds`：上游在弹簧循环里就把盒子夹进
   * 舞台，因此「按在边界不放」不会在弹簧里攒下越界位移、松手后突然弹出去。这里同样在
   * 积分之后、下发 `setPosition` 之前调用。边界必须与飞行共用（桌宠用
   * `src/pet/hooks/use-pet-window-clamp.ts`，边界取自 `bodyBounds` 的宠物本体/脚底），
   * 否则贴边松手会被飞行的越界修正弹回来。
   */
  clampPosition: (position: { x: number, y: number }) => { x: number, y: number }
  /**
   * 命中箱上按下左键（真正「抓住宠物」）时触发，早于读窗口位置的异步调用；右键、
   * 非主指针、以及已有手势进行中的按下都不会触发。
   *
   * 宿主用它做「抓取刹车」这类动作：后端 `device-mouse-button` 是**全屏**左键流，
   * 分不清「抓住宠物」与「在别处点击」（见 `src/pet/hooks/use-pet-physics.ts`）。
   */
  onGrab?: () => void
  /**
   * 手势结束时触发一次（含没有位移的单击、以及设备流/兜底计时结束的那一次），宿主用它
   * 结算甩动并清掉「按住」状态。
   *
   * 后端 `device-mouse-button` 只是 OS 侧的兜底信号，可能丢事件；命中箱的 `pointerup`
   * 更早也更可靠。两条路都汇到这里，同一个手势重复结束只报一次（见
   * `src/pet/hooks/use-pet-physics.ts` 的 `onRelease`）。
   */
  onRelease?: () => void
}

/**
 * 手势门槛（CSS px）：与上游 playground `usePetDrag` 的 `Math.hypot(dx, dy) < 5` 一致，
 * 门槛内按单击处理（组件的挤压反馈）。换算成物理像素时乘 `devicePixelRatio`。
 */
const DRAG_START_THRESHOLD = 5
/** 方向判定阈值（CSS px）：与上游 `Math.abs(x - last.x) >= 3` 一致。 */
const DRAG_DIRECTION_THRESHOLD = 3
/**
 * 弹簧参数（上游 playground 同值）：刚度 K=200 /s²、阻尼 C=30 /s。
 * 阻尼比 C / (2√K) ≈ 1.06，略过阻尼 —— 这是「缓慢跟手、不振荡」的来源。
 */
const FOLLOW_STIFFNESS = 200
const FOLLOW_DAMPING = 30
/** 单帧积分上限与子步上限：与上游一致，大帧切成 1/120 子步，显式弹簧不会发散。 */
const MAX_FRAME_DELTA = 0.05
const MAX_SUBSTEP = 1 / 120
/** 方向停摆阈值：超过此时长没有新的光标样本，方向归零（宠物回到 idle/会话动画）。 */
const DRAG_DIRECTION_IDLE_TIMEOUT = 350
/** 会话兜底阈值：超过此时长没有新的光标样本，且左键状态未知/已松开时收尾拖拽。 */
const DRAG_SESSION_TIMEOUT = 1500

/** 一次拖拽手势的状态（位置/速度与窗口、光标流同一坐标系：虚拟屏幕物理像素）。 */
interface Gesture {
  /** 指针 id：只有同一根指针的 pointerup 才结束会话。 */
  pointerId: number
  /** 手势原点：按下瞬间的光标位置；按下时设备流还没有样本则顺延到首个样本。 */
  anchor: { x: number, y: number } | undefined
  /** 手势原点处的窗口左上角；读窗口位置是异步的，读到之前不进入跟手。 */
  base: { x: number, y: number } | undefined
  /** 弹簧积分出的窗口位置。 */
  x: number
  y: number
  /** 弹簧速度。 */
  vx: number
  vy: number
  /** 是否越过手势门槛（门槛前窗口不动，位移由门槛后的弹簧按原点补齐）。 */
  engaged: boolean
  /** 方向判定用的上一个样本（上游拿轨迹末段比较）。 */
  lastSample: { x: number, y: number } | undefined
}

/**
 * 桌宠窗口拖拽（桌宠窗口在用）：按上游 playground 的「弹簧跟手」移动窗口。
 *
 * # 手感来自上游 playground 的 `usePetDrag`
 *
 * 上游官方用例拖动时是「缓慢跟手」：5px 手势门槛、指针为弹簧目标、K=200/C=30 的
 * 显式弹簧每帧积分，位置在门槛之后才更新。这里逐条照搬（含 `Math.hypot` 门槛、
 * 3px 方向判定、单帧 0.05s 与 1/120 子步上限），只把「舞台里的 DOM 盒子」换成
 * 「显示器里的窗口」：盒子用 `style.left/top` 定位，窗口用 `setPosition` 定位。
 *
 * # 指针位置为什么取后端 `device-mouse-move`，而不是 DOM `pointermove`
 *
 * 上游的盒子在固定视口里，`clientX/clientY` 与盒子位置互不影响；桌宠的「盒子」
 * 就是窗口本身，`clientX` 是相对窗口的坐标 —— 窗口一移动，同一个光标位置的
 * `clientX` 就反向变化，形成「窗口动过 → 增量变小 → 窗口不再动」的反馈：既抖，
 * 又会把窗口留在指针后面追不上。后端设备流给的是**与窗口位置同一坐标系**的全局
 * 物理像素，与窗口自身的移动无关，因此弹簧目标可以写成绝对量
 * `base + (cursor - anchor)`，窗口必然收敛到指针处（静止时零偏移）。
 * 附带好处：命中箱一旦被判定为「指针已离开」而切成穿透态，DOM `pointermove`
 * 会断流，全局流不受影响（`useOmitIgnoreCursorEvents` 的命中判定用的也是它）。
 *
 * # 结束时刻：设备流为主，指针事件为快路径
 *
 * 后端设备流用 `device-mouse-button` 上报 OS 侧左键状态，松开即收尾；命中箱的
 * `pointerup` 是更快的同源信号（同一 `pointerId` 才认）。**不认 `pointercancel`**：
 * 拖拽中命中区可能被判成「指针已离开」而切成穿透态，webview 会因此取消指针会话，
 * 若把它当作结束，窗口就会定格在半路（正是要修的「滞留在后面」）。收尾兜底是
 * `DRAG_SESSION_TIMEOUT`，且设备流确认仍按住时只重新计时，不误杀「按住不动再拖」。
 *
 * # 跟手期间的夹取
 *
 * 每帧夹一次（`clampPosition`，上游 `getBounds` 的等价物）：位置一旦贴到可见区域边界
 * 就不再越界累积，光标继续往外推也只是让弹簧顶在边界上，松手时宠物正好停在边缘 ——
 * 「左右上边缘松开就被弹开」的另一半原因（跟手期间窗口跑到飞行边界之外，松手后飞行
 * 积分把越界位置一次性修正回来）由此消除。
 *
 * # 收尾写回
 *
 * 跟手期间每帧直接 `setPosition`（与飞行同一套做法，绝对定位不会累积漂移）；
 * 结束时只调 `persist_pet_window_position` 把当前位置落盘，**不再**走
 * `move_pet_window(0, 0)`：后者夹的是整个窗口，而宠物只是窗口底部居中的一块，四周
 * 是透明留白（`PET_WINDOW_PAD_X` / 窗口最小宽度），贴边松手的瞬间会把宠物从边缘推开
 * 一段（100% 大小时左侧约 100 物理像素，即「没办法在边缘放置宠物」）。
 * 位置合法性由前端每帧的 `clampPosition` 保证，后端不必再夹一遍。
 *
 * # 抓取回调（`onGrab`）
 *
 * 命中箱上的左键按下同时是「抓住宠物」的语义信号，宿主靠它给甩出中的宠物刹车
 * （见 `src/pet/hooks/use-pet-physics.ts`）。回调落在门槛之前：刹车要在按下的那一刻
 * 发生，而跟手本身要等 5px 门槛；也因此在「按下不动」的单击里同样会触发。
 *
 * # 松开回调（`onRelease`）
 *
 * 每个手势（含没有位移的单击）结束时通知一次，物理层靠它结算甩动并清掉「按住」状态
 * （见 `src/pet/hooks/use-pet-physics.ts` 的 `onRelease`）。不只依赖后端设备流的原因：
 * 设备流可能丢事件，一旦丢了，物理层会一直以为按钮还按着，把很久以后一次无关点击当成
 * 甩出；命中箱 `pointerup` 更早也更可靠，于是两条路都汇进同一个幂等结算。手势对象在
 * `endDrag()` 里已被清空，因此「设备流松手 + `pointerup`」只会报一次。
 */
export function useWindowDraggable(options: UseWindowDraggableOptions): UseWindowDraggableResult {
  // 回调走 ref：拖拽期间每帧重渲染，闭包里的旧回调会把信号落到过期实例上。
  const onGrabRef = useRef(options.onGrab)
  onGrabRef.current = options.onGrab
  // 松开同样走 ref：拖拽期间每帧重渲染，闭包里的旧回调会把信号落到过期实例上。
  const onReleaseRef = useRef(options.onRelease)
  onReleaseRef.current = options.onRelease
  // 夹取同样走 ref：拖拽期间每帧重渲染，闭包可能抓到过期的 `pet.geometry` 快照。
  const clampRef = useRef(options.clampPosition)
  clampRef.current = options.clampPosition
  const gestureRef = useRef<Gesture | null>(null)
  /** 后端设备流最近一次上报的光标位置。 */
  const cursorRef = useRef<{ x: number, y: number } | undefined>(undefined)
  /**
   * 后端设备流最近一次上报的左键状态。`true` = 确认仍按下（拖拽中长时间静止不算结束）；
   * `undefined` = 本次会话没有收到过上报（设备流失联，停歇兜底按「未知」收尾）。
   * 不在 pointerdown 里重置：按下与设备流上报没有固定先后，清掉新会话的 `true` 会让
   * 「按住不动再拖」被停歇阈值误杀；改为在会话结束时重置。
   */
  const pressedRef = useRef<boolean | undefined>(undefined)
  /** useRafFn 每渲染返回新对象，弹簧循环统一走 ref，避免闭包抓到旧的 pause/resume。 */
  const rafRef = useRef<{ pause: () => void, resume: () => void } | null>(null)
  /** 最近一次已下发的取整位置：位置没变就不重复发 IPC（按住不动时每帧一次没有意义）。 */
  const appliedRef = useRef<{ x: number, y: number } | undefined>(undefined)
  const [dragging, setDragging] = useState(false)
  const [direction, setDirection] = useState<DragDirection | undefined>(undefined)

  // reause 的 `useTimeoutFn` 缺省在挂载时就开始计时，这里必须 `immediate: false`：
  // 只有拖拽中的事件才重新 `start()`（等价于「重置计时」）。
  const { start: armDirectionTimer, stop: stopDirectionTimer } = useTimeoutFn(
    parkDirection,
    DRAG_DIRECTION_IDLE_TIMEOUT,
    { immediate: false },
  )
  const { start: armSessionTimer, stop: stopSessionTimer } = useTimeoutFn(
    handleSessionTimeout,
    DRAG_SESSION_TIMEOUT,
    { immediate: false },
  )

  // 弹簧积分循环：与上游 playground 的 `useRafFn` 回调逐行对应（目标取绝对位置，
  // 因此门槛前丢掉的位移会在门槛后一次性补上，而不是像增量累加那样永久丢失）。
  const raf = useRafFn(({ delta }) => {
    const gesture = gestureRef.current
    const cursor = cursorRef.current
    if (gesture === null || !gesture.engaged || gesture.anchor === undefined || gesture.base === undefined || cursor === undefined) {
      rafRef.current?.pause()
      return
    }
    const targetX = gesture.base.x + (cursor.x - gesture.anchor.x)
    const targetY = gesture.base.y + (cursor.y - gesture.anchor.y)
    let remaining = Math.min(MAX_FRAME_DELTA, Math.max(0, delta / 1000))
    // resume 后的首帧 delta 为 0（时间戳起点），空帧不产生位移也不需要下发 IPC。
    if (remaining <= 0)
      return
    while (remaining > 0) {
      const dt = Math.min(remaining, MAX_SUBSTEP)
      gesture.vx += ((targetX - gesture.x) * FOLLOW_STIFFNESS - gesture.vx * FOLLOW_DAMPING) * dt
      gesture.vy += ((targetY - gesture.y) * FOLLOW_STIFFNESS - gesture.vy * FOLLOW_DAMPING) * dt
      gesture.x += gesture.vx * dt
      gesture.y += gesture.vy * dt
      remaining -= dt
    }
    // 先夹取再取整（见 `clampPosition`）：把弹簧状态本身限制在可见区域内，
    // 越界位移不会攒起来在松手后弹出去（上游同样在弹簧循环里夹盒子）。
    const clamped = clampRef.current({ x: gesture.x, y: gesture.y })
    gesture.x = clamped.x
    gesture.y = clamped.y
    // 窗口位置取整：亚像素位置在 Windows 上会被系统四舍五入，抖动比丢精度更显眼。
    const nextX = Math.round(gesture.x)
    const nextY = Math.round(gesture.y)
    if (appliedRef.current?.x === nextX && appliedRef.current.y === nextY)
      return
    appliedRef.current = { x: nextX, y: nextY }
    void getCurrentWindow()
      .setPosition(new PhysicalPosition(nextX, nextY))
      .catch(() => {})
  }, { immediate: false })
  rafRef.current = raf

  /** 暂停移动：方向归零（宠物回到 idle/会话动画），但拖拽会话保持存活。 */
  function parkDirection(): void {
    setDirection(undefined)
  }

  /** 拖拽会话兜底：光标样本停歇超过 `DRAG_SESSION_TIMEOUT` 时触发（见 hook 文档）。 */
  function handleSessionTimeout(): void {
    if (gestureRef.current !== null && pressedRef.current === true) {
      armSessionTimer()
      return
    }
    endDrag()
  }

  function endDrag(): void {
    const gesture = gestureRef.current
    gestureRef.current = null
    pressedRef.current = undefined
    appliedRef.current = undefined
    stopDirectionTimer()
    stopSessionTimer()
    rafRef.current?.pause()
    setDragging(false)
    setDirection(undefined)
    if (gesture !== null) {
      // 每个手势只报一次松开：物理层据此结算甩动并清掉「按住」状态（见 hook 文档）。
      onReleaseRef.current?.()
    }
    if (gesture?.engaged === true) {
      // 只落盘、不夹取：位置已由每帧的 `clampPosition` 保证在可见区域内，整窗夹取
      // 反而会把贴边松手的宠物推开一段（见 hook 文档「收尾写回」）。
      void invoke('persist_pet_window_position').catch(() => {})
    }
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || event.isPrimary === false || gestureRef.current !== null)
      return
    // 先通知宿主「抓住宠物」：这一步早于手势门槛与异步读窗口位置。
    onGrabRef.current?.()
    const latest = cursorRef.current
    const gesture: Gesture = {
      pointerId: event.pointerId,
      anchor: latest === undefined ? undefined : { x: latest.x, y: latest.y },
      base: undefined,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      engaged: false,
      lastSample: undefined,
    }
    gestureRef.current = gesture
    // 按下即开始兜底计时：设备流与指针事件同时中断时也能收尾。
    armSessionTimer()
    // 不调用 preventDefault：取消 pointerdown 会抑制兼容鼠标事件，文本选择/触屏滚动
    // 已由样式（select-none / touch-none）防护。
    void getCurrentWindow().outerPosition().then((position) => {
      if (gestureRef.current !== gesture)
        return
      gesture.base = { x: position.x, y: position.y }
    }).catch(() => {
      // 读不到窗口位置就无法把光标位移映射成窗口位置：放弃这次手势（单击反馈照常）。
      if (gestureRef.current === gesture)
        endDrag()
    })
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || gestureRef.current?.pointerId !== event.pointerId)
      return
    endDrag()
  }

  useListen<DeviceMousePosition>('device-mouse-move', ({ payload }) => {
    cursorRef.current = { x: payload.x, y: payload.y }
    const gesture = gestureRef.current
    if (gesture === null)
      return
    // 事件流仍在推进：重置「会话兜底」计时。
    armSessionTimer()
    if (gesture.anchor === undefined) {
      // 设备流首个样本：手势原点顺延到这里（按下时还没有样本，等价于从此刻起跟手）。
      gesture.anchor = { x: payload.x, y: payload.y }
      gesture.lastSample = { x: payload.x, y: payload.y }
      return
    }
    const scale = globalThis.devicePixelRatio || 1
    const dx = payload.x - gesture.anchor.x
    const dy = payload.y - gesture.anchor.y
    if (!gesture.engaged) {
      // 门槛前窗口不动；越过门槛时从窗口原位起步，弹簧目标始终按原点算。
      if (Math.hypot(dx, dy) < DRAG_START_THRESHOLD * scale || gesture.base === undefined)
        return
      gesture.x = gesture.base.x
      gesture.y = gesture.base.y
      gesture.vx = 0
      gesture.vy = 0
      gesture.engaged = true
      appliedRef.current = undefined
      setDragging(true)
      rafRef.current?.resume()
    }
    const last = gesture.lastSample
    if (last !== undefined && Math.abs(payload.x - last.x) >= DRAG_DIRECTION_THRESHOLD * scale)
      setDirection(payload.x > last.x ? 'right' : 'left')
    gesture.lastSample = { x: payload.x, y: payload.y }
    armDirectionTimer()
  })

  // 只认松开：拖拽会话由 onPointerDown 开启，后端设备流补的是 OS 侧的结束时刻
  // （命中箱切成穿透态后收不到 pointerup 时，靠它保证拖拽不粘住/不半路定格）。
  useListen<MouseButtonState>('device-mouse-button', ({ payload }) => {
    if (payload.pressed) {
      pressedRef.current = true
      return
    }
    pressedRef.current = false
    endDrag()
  })

  return {
    dragging,
    direction,
    onPointerDown: handlePointerDown,
    onPointerUp: handlePointerUp,
  }
}
