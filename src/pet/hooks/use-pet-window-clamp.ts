import type { PetGeometry, PetRef } from 'dsh-pet-component'
import { availableMonitors } from '@tauri-apps/api/window'
import { useEffect, useRef } from 'react'
import { monitorScreenWorkArea, screenCoordinateScale } from '@/utils/screen-coordinates'
import { bodyBounds } from './use-pet-physics.helpers'

/** 显示器工作区：macOS 使用全局逻辑点，其他平台使用物理像素。 */
export interface PetWorkArea {
  x: number
  y: number
  width: number
  height: number
}

/** 窗口左上角位置，与设备光标流使用同一屏幕坐标系。 */
export interface PetWindowPosition {
  x: number
  y: number
}

/**
 * 把窗口位置夹进显示器工作区 —— 边界取**宠物本体 / 脚底**，与飞行共用 `bodyBounds`。
 *
 * # 为什么不夹整个窗口
 *
 * 宠物只是窗口底部居中的一块，四周是透明留白（`PET_WINDOW_PAD_X`、窗口最小宽度
 * `PET_BUBBLE_MIN_WIDTH`）：按整窗夹取会把留白算成宠物的一部分，于是贴到左右/上边缘
 * 松手时被推开一段（100% 大小时左侧约 `(420 - 220) / 2 = 100` 物理像素），看起来就是
 * 「没办法在边缘放置宠物」。按本体夹取时窗口的一部分可以留在屏幕外，宠物本体始终
 * 完整可见且贴得住边缘。
 *
 * 与飞行的边界一致还有第二个好处：跟手期间窗口不会跑到飞行边界之外，松手时飞行
 * 积分不必把越界位置一次性修正回来（那就是「松开就弹开」的另半个原因）。
 *
 * 换算与 `src/pet/hooks/use-pet-physics.ts` 的 `startFlight` 完全一致：工作区换算到
 * 逻辑像素当舞台，`bodyBounds` 给出本体相对舞台的边界，再减去 `geometry.x/y` 得到窗口
 * 位置（窗口逻辑位置 = 容器逻辑位置 − `geometry.x/y`），最后乘回 `scale` 得屏幕坐标。
 */
export function clampPetWindowPosition(
  position: PetWindowPosition,
  geometry: PetGeometry,
  dsh: boolean,
  areas: readonly PetWorkArea[],
  scale: number,
  target: PetWindowPosition = position,
): PetWindowPosition {
  if (areas.length === 0)
    return position
  const area = selectWorkArea(target, geometry, areas, scale)
  const stage = {
    x: area.x / scale,
    y: area.y / scale,
    width: area.width / scale,
    height: area.height / scale,
  }
  const local = bodyBounds(geometry, stage.width, stage.height, dsh)
  return {
    x: clamp(position.x, (stage.x + local.minX - geometry.x) * scale, (stage.x + local.maxX - geometry.x) * scale),
    y: clamp(position.y, (stage.y + local.minY - geometry.y) * scale, (stage.y + local.maxY - geometry.y) * scale),
  }
}

/**
 * 钳制到上下限之间；上下限反了（工作区比宠物还小）时退化成上限，与后端
 * `clamp_window_position` 的 `.clamp(left, max_x)` 行为一致。
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/**
 * 按未夹取目标的本体中心选屏，避免每帧夹取把拖拽困在原屏；跨屏间隙时取最近的
 * 一个（与后端 `move_pet_window` 按窗口中心选屏、间隙取最近显示器同理，只是这里用
 * 本体中心，与夹取边界同一套计算）。
 */
function selectWorkArea(
  position: PetWindowPosition,
  geometry: PetGeometry,
  areas: readonly PetWorkArea[],
  scale: number,
): PetWorkArea {
  const centerX = position.x + ((geometry.body.left + geometry.body.right) / 2) * scale
  const centerY = position.y + ((geometry.body.top + geometry.body.bottom) / 2) * scale
  const containing = areas.find(area =>
    centerX >= area.x
    && centerX < area.x + area.width
    && centerY >= area.y
    && centerY < area.y + area.height)
  if (containing !== undefined)
    return containing
  return areas.reduce((best, area) =>
    distanceSquared(area, centerX, centerY) < distanceSquared(best, centerX, centerY) ? area : best)
}

/** 点到工作区的距离平方（在工作区内为 0）。 */
function distanceSquared(area: PetWorkArea, x: number, y: number): number {
  const right = area.x + area.width
  const bottom = area.y + area.height
  const dx = x < area.x ? area.x - x : x >= right ? x - right + 1 : 0
  const dy = y < area.y ? area.y - y : y >= bottom ? y - bottom + 1 : 0
  return dx * dx + dy * dy
}

/** 读取显示器工作区列表并写入 ref；失败时保留上一次的列表。 */
function loadWorkAreas(areasRef: { current: readonly PetWorkArea[] }): void {
  void availableMonitors()
    .then((monitors) => { areasRef.current = monitors.map(monitorScreenWorkArea) })
    .catch(() => {})
}

/** 桌宠窗口的「按本体夹取」控制器。 */
export interface PetWindowClampControls {
  /**
   * 传给 `useWindowDraggable({ clampPosition })`：用实时 `pet.geometry` 与缓存的显示器
   * 工作区夹取窗口位置。`geometry` 还没就绪或工作区还没读到时不夹取。
   */
  clampPosition: (position: PetWindowPosition, target?: PetWindowPosition) => PetWindowPosition
  /** 重新读取显示器工作区：抓取时调用，插拔显示器后立刻生效（无需重开应用）。 */
  refreshWorkAreas: () => void
}

/**
 * 桌宠窗口的夹取来源：挂载时读一次显示器工作区列表，之后每次抓取都刷新；每帧的边界
 * 用实时 `pet.geometry` 现算（`PetRef.geometry` 是同步 getter）。
 */
export function usePetWindowClamp(pet: PetRef, kind: 'dsh' | 'codex' | undefined): PetWindowClampControls {
  const areasRef = useRef<readonly PetWorkArea[]>([])
  const kindRef = useRef(kind)
  kindRef.current = kind

  // keep:effect 挂载时先取一次显示器列表（拖拽可能早于下一次抓取刷新）；之后由
  // `refreshWorkAreas` 在每次抓取时更新，显示器热插拔不用重开应用。
  useEffect(() => {
    loadWorkAreas(areasRef)
  }, [])

  function refreshWorkAreas(): void {
    loadWorkAreas(areasRef)
  }

  function clampPosition(position: PetWindowPosition, target: PetWindowPosition = position): PetWindowPosition {
    const geometry = pet.geometry
    if (geometry === null)
      return position
    return clampPetWindowPosition(
      position,
      geometry,
      kindRef.current === 'dsh',
      areasRef.current,
      screenCoordinateScale(),
      target,
    )
  }

  return { clampPosition, refreshWorkAreas }
}
