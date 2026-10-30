const AXIS_LOCK_DISTANCE = 8
const SWIPE_DISTANCE = 18
const SWIPE_VELOCITY = 0.5

export const SIDEBAR_CLICK_SUPPRESSION_MS = 400

export interface SidebarGesturePoint {
  id: number
  x: number
  y: number
  time: number
}

export interface SidebarGesture {
  id: number
  startX: number
  startY: number
  base: number
  open: boolean
  axis: 'x' | null
  samples: readonly SidebarGesturePoint[]
}

export interface SidebarGestureMove {
  gesture: SidebarGesture | null
  offset?: number
}

export function createSidebarGesture(point: SidebarGesturePoint, open: boolean, width: number): SidebarGesture {
  return {
    id: point.id,
    startX: point.x,
    startY: point.y,
    base: open ? width : 0,
    open,
    axis: null,
    samples: [point],
  }
}

export function moveSidebarGesture(
  gesture: SidebarGesture,
  point: SidebarGesturePoint,
  width: number,
  cancelable: boolean,
): SidebarGestureMove {
  const dx = point.x - gesture.startX
  const dy = point.y - gesture.startY
  if (gesture.axis === null) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) < AXIS_LOCK_DISTANCE)
      return { gesture }
    if (Math.abs(dy) >= Math.abs(dx) * 0.8 || (gesture.open ? dx > 0 : dx < 0))
      return { gesture: null }
  }
  if (!cancelable)
    return { gesture: null }
  const samples = [...gesture.samples, point]
  while (samples.length > 2 && samples[1].time < point.time - 120)
    samples.shift()
  return {
    gesture: { ...gesture, axis: 'x', samples },
    offset: Math.min(width, Math.max(0, gesture.base + dx)),
  }
}

export function finishSidebarGesture(
  gesture: SidebarGesture,
  point: SidebarGesturePoint | undefined,
  width: number,
): { open: boolean, suppressClick: boolean } | null {
  if (gesture.axis !== 'x')
    return null
  const samples = point === undefined ? gesture.samples : [...gesture.samples, point]
  const first = samples[0]
  const last = samples[samples.length - 1]
  const travel = last.x - gesture.startX
  const velocity = (last.x - first.x) / Math.max(1, last.time - first.time)
  const fling = Math.abs(velocity) >= SWIPE_VELOCITY && Math.abs(travel) >= SWIPE_DISTANCE
  const position = Math.min(width, Math.max(0, gesture.base + travel))
  return {
    open: fling ? velocity > 0 : position >= width * 0.5,
    suppressClick: true,
  }
}
