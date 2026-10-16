import type { PetRef, PetRenderMotion } from 'dsh-pet-component'
import { useEventListener } from '@reause/core'
import { Pet, useControllablePet } from 'dsh-pet-component'
import { useRef } from 'react'
import { If } from 'react-if-lite'
import { useOmitIgnoreCursorEvents } from '@/hooks/use-omit-ignore-cursor-events'
import { useWindowDraggable } from '@/hooks/use-window-draggable'
import { Hint } from '@/ui/pet/hint'
import { useWakelockRelease } from '../hooks/use-wakelock-release'
import { PET_BASE_WIDTH, PET_DSH_ASPECT } from './constants'
import { useBubbleTracker } from './hooks/use-bubble-tracker'
import { usePetAutonomy } from './hooks/use-pet-autonomy'
import { usePetPhysics } from './hooks/use-pet-physics'
import { usePetSource } from './hooks/use-pet-source'
import { normalizeSizePercent, usePetStatus } from './hooks/use-pet-status'
import { usePetWindowSize } from './hooks/use-pet-window'
import { usePetWindowClamp } from './hooks/use-pet-window-clamp'

export function App() {
  const petRef = useRef<PetRef>(null)
  const pet = useControllablePet(petRef)
  const status = usePetStatus()
  const activedPet = status?.active_pet ?? ''
  const { source, error } = usePetSource(activedPet)
  const hitboxRef = useRef<HTMLDivElement>(null)
  // 甩动：松手后按窗口轨迹估速请求组件甩出，飞行积分与落地 Q 弹都在宿主（见 hook 文档）。
  // 抓取信号来自命中箱 `pointerdown`（经拖拽 hook 的 `onGrab`）：`device-mouse-button`
  // 是全屏左键流，在桌面别处的点击不能给甩出中的宠物刹车。松开由拖拽 hook 统一上报
  // （`onRelease`，命中箱 `pointerup` 与设备流两条路只结算一次），物理层据此估速并清状态。
  const { onFling, onGrab, onRelease, isBusy } = usePetPhysics(pet, source?.kind, status?.throw_enabled === true)
  // 跟手期间按「宠物本体 / 脚底」把窗口夹进显示器工作区（与飞行共用边界）：贴边松手
  // 不会被整窗夹取推开，也不会跑出飞行边界而在松手瞬间被修正回来。
  const { clampPosition, refreshWorkAreas } = usePetWindowClamp(pet, source?.kind)
  const draggable = useWindowDraggable({ onGrab: handleGrab, onRelease, clampPosition })

  /** 抓取时顺手刷新显示器工作区（插拔显示器后立刻生效），再交给物理层刹车。 */
  function handleGrab(): void {
    refreshWorkAreas()
    onGrab()
  }

  const visible = status === null || (status.enabled !== false && status.visible !== false)
  const width = (source?.width ?? PET_BASE_WIDTH) * normalizeSizePercent(status?.pet_size) / 100

  const autonomy = usePetAutonomy(pet, visible && source !== null && source !== undefined && status?.autonomy_enabled === true && status?.autonomy_supported === true, isBusy, source)
  useBubbleTracker(pet, source)
  usePetWindowSize(width, source?.aspect ?? PET_DSH_ASPECT, visible)
  useOmitIgnoreCursorEvents(hitboxRef, draggable.dragging)
  useEventListener('contextmenu', event => event.preventDefault())
  useWakelockRelease()

  const motion: PetRenderMotion | undefined = draggable.dragging
    ? (draggable.direction === undefined ? undefined : `moving-${draggable.direction}`)
    : undefined

  return (
    <main className={`pointer-events-none fixed inset-0 flex items-end justify-center ${visible ? '' : 'invisible'}`}>
      {source && (
        <Pet
          ref={petRef}
          kind={source.kind}
          config={autonomy.config ?? source.config}
          className={autonomy.active ? 'pet-interacting' : undefined}
          style={autonomy.style}
          mirrored={autonomy.mirrored}
          onMotionChange={autonomy.onMotionChange}
          uri={source.uri}
          ext={source.ext}
          motion={source?.kind === 'codex' ? motion : undefined}
          size={width}
          dragging={draggable.dragging}
          onFling={onFling}
          cache={true}
          hidden={!visible}
          hitboxRef={hitboxRef}
          onHitboxPointerDown={draggable.onPointerDown}
          onHitboxPointerUp={draggable.onPointerUp}
          onError={autonomy.onError}
        />
      )}
      <If cond={error !== null} then={<Hint petId={activedPet} />} />
    </main>
  )
}
