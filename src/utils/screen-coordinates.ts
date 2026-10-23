import type { Monitor, Window } from '@tauri-apps/api/window'
import { LogicalPosition, PhysicalPosition } from '@tauri-apps/api/window'
import { type } from '@tauri-apps/plugin-os'

export function screenCoordinateScale(): number {
  return type() === 'macos' ? 1 : globalThis.devicePixelRatio || 1
}

export async function windowScreenPosition(appWindow: Window, inner = false): Promise<{ x: number, y: number, scaleFactor: number }> {
  const logical = type() === 'macos'
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const scaleFactor = logical ? await appWindow.scaleFactor() : 1
    const position = await (inner ? appWindow.innerPosition() : appWindow.outerPosition())
    if (!logical || scaleFactor === await appWindow.scaleFactor())
      return { x: position.x / scaleFactor, y: position.y / scaleFactor, scaleFactor }
  }
  throw new Error('PET_POSITION_UNSTABLE_SCALE: window scale changed while reading its position')
}

export function nativeScreenPosition(x: number, y: number): LogicalPosition | PhysicalPosition {
  return type() === 'macos' ? new LogicalPosition(x, y) : new PhysicalPosition(x, y)
}

export function monitorScreenWorkArea(monitor: Monitor): { x: number, y: number, width: number, height: number } {
  const scale = type() === 'macos' ? monitor.scaleFactor : 1
  return {
    x: monitor.workArea.position.x / scale,
    y: monitor.workArea.position.y / scale,
    width: monitor.workArea.size.width / scale,
    height: monitor.workArea.size.height / scale,
  }
}
