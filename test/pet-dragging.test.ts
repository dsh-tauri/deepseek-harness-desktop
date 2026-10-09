// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readSource } from './setup/read-source'

describe('pet dragging follows the pointer (upstream spring feel)', () => {
  const hook = readSource('src/hooks/use-window-draggable.ts')
  const app = readSource('src/pet/app.tsx')
  const cursorEvents = readSource('src/hooks/use-omit-ignore-cursor-events.ts')
  const physics = readSource('src/pet/hooks/use-pet-physics.ts')

  // 只守住跨文件的接线契约；弹簧积分、门槛、收尾等行为由
  // `src/hooks/use-window-draggable.test.ts` 的 jsdom 用例覆盖。
  it('drives the window from the backend cursor stream instead of DOM deltas', () => {
    expect(hook).toContain('\'device-mouse-move\'')
    expect(hook).toContain('\'device-mouse-button\'')
    expect(hook).toContain('.setPosition(')
    // 文档注释里会提到原生 `startDragging()` 作为对照，这里断言的是不再调用它。
    expect(hook).not.toContain('.startDragging(')
  })

  it('uses the upstream playground spring constants for the follow motion', () => {
    expect(hook).toContain('const FOLLOW_STIFFNESS = 200')
    expect(hook).toContain('const FOLLOW_DAMPING = 30')
    expect(hook).toContain('const DRAG_START_THRESHOLD = 5')
    expect(hook).toContain('const DRAG_DIRECTION_THRESHOLD = 3')
  })

  it('passes the pointer lifecycle from the hitbox to the drag hook', () => {
    expect(app).toContain('onHitboxPointerDown={draggable.onPointerDown}')
    expect(app).toContain('onHitboxPointerUp={draggable.onPointerUp}')
    // 跟手不依赖 DOM pointermove（窗口移动会让 clientX 反向变化），也不认
    // pointercancel（穿透态切换会取消指针会话）。
    expect(app).not.toContain('onHitboxPointerMove=')
    expect(app).not.toContain('onHitboxPointerCancel=')
  })

  it('keeps the window interactive while dragging so the release is delivered', () => {
    expect(app).toContain('useOmitIgnoreCursorEvents(hitboxRef, draggable.dragging)')
    expect(cursorEvents).toContain('dragging = false')
  })

  it('brakes a thrown pet only on a real grab, never on a click elsewhere', () => {
    // 抓取信号来自命中箱 pointerdown，经拖拽 hook 的 onGrab 转给甩动物理。
    expect(app).toContain('useWindowDraggable({ onGrab: handleGrab, onRelease, clampPosition })')
    expect(app).toContain('const { onFling, onGrab, onRelease } = usePetPhysics(pet, source?.kind, status?.throw_enabled === true)')
    expect(hook).toContain('onGrabRef.current?.()')
    // 全屏左键流只用来取「松开」时刻：任何位置的按下都不能刹车。
    expect(physics).toContain('if (payload.pressed)')
    expect(physics).toContain('export interface PetPhysicsControls')
  })

  it('keeps pet throwing off unless the status explicitly enables it (issue #930)', () => {
    // 状态未就绪、字段缺省或为假时一律不甩出：开关关闭 = 松手即停，不做任何飞行。
    expect(app).toContain('status?.throw_enabled === true')
    expect(physics).toContain('if (!throwEnabledRef.current)')
  })

  it('routes both release paths through one idempotent physics release', () => {
    // 命中箱 pointerup 与后端设备流汇到同一个 `onRelease`，同一个手势只结算一次：
    // 设备流丢事件时物理层不会一直以为还按着，把很久以后一次无关点击当成甩出。
    expect(hook).toContain('onRelease?: () => void')
    expect(hook).toContain('onReleaseRef.current?.()')
    expect(physics).toContain('function onRelease(): void {')
    expect(physics).toContain('return { onFling, onGrab, onRelease }')
    expect(physics).toContain('onRelease: () => void')
  })

  it('clamps every follow frame to the pet body bounds so edge drops stay on the edge', () => {
    // 跟手每帧夹取（上游 `getBounds` 的等价物），边界与飞行共用 `bodyBounds`。
    expect(app).toContain('const { clampPosition, refreshWorkAreas } = usePetWindowClamp(pet, source?.kind)')
    expect(hook).toContain('clampRef.current({ x: gesture.x, y: gesture.y })')
    expect(readSource('src/pet/hooks/use-pet-window-clamp.ts')).toContain('bodyBounds(geometry, stage.width, stage.height, dsh)')
    // 收尾只落盘：整窗夹取会把贴边松手的宠物推开一段（透明留白的宽度）。
    expect(hook).toContain('void invoke(\'persist_pet_window_position\').catch(() => {})')
    expect(hook).not.toContain('invoke(\'move_pet_window\'')
  })
})
