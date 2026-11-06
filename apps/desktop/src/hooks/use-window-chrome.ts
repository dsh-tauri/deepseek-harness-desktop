import type { PointerEvent } from 'react'
import { useWatch } from '@reause/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect, useState } from 'react'
import { applyFrameMode, applyHostedTitlebar, hasNativeWindow, IS_MACOS, isFramedWindow } from '@/utils/window-frame'
import { isHostedDocument } from '@/utils/window-presentation'

/** 订阅窗口布尔状态（最大化 / 全屏）：随窗口尺寸变化重读。 */
function useWindowFlag(enabled: boolean, read: () => Promise<boolean>, label: string): boolean | undefined {
  const [value, setValue] = useState<boolean | undefined>(undefined)

  // keep:effect 原生窗口的 onResized 监听必须在卸载时注销，reause 未覆盖该资源。
  useEffect(() => {
    if (!enabled || !hasNativeWindow())
      return
    const appWindow = getCurrentWindow()
    let mounted = true
    let unlisten: (() => void) | undefined

    async function sync() {
      try {
        const next = await read.call(appWindow)
        if (mounted)
          setValue(next)
      }
      catch (error) {
        console.error(`[Navbar] failed to sync ${label} state:`, error)
      }
    }

    void (async () => {
      try {
        const stopListening = await appWindow.onResized(() => {
          void sync()
        })
        if (!mounted) {
          stopListening()
          return
        }
        unlisten = stopListening
        await sync()
      }
      catch (error) {
        console.error(`[Navbar] failed to listen for ${label} state:`, error)
      }
    })()

    return () => {
      mounted = false
      unlisten?.()
    }
  }, [enabled, label, read])

  return value
}

export function useMaximized(enabled = true): boolean | undefined {
  return useWindowFlag(enabled, getCurrentWindow().isMaximized, 'maximized')
}

export function useFullscreen(enabled = true): boolean | undefined {
  return useWindowFlag(enabled, getCurrentWindow().isFullscreen, 'fullscreen')
}

export function useMacOSFullscreen(): boolean {
  const macFullscreen = useFullscreen(IS_MACOS)
  return IS_MACOS && Boolean(macFullscreen)
}

/** 把最大化 / 全屏合成为文档级边框形态。 */
export function useFrameChrome(): void {
  const framed = isFramedWindow()
  const maximized = useMaximized(framed)
  const fullscreen = useFullscreen(framed || IS_MACOS)
  useWatch([maximized, fullscreen], () => {
    if (maximized === undefined || fullscreen === undefined)
      return
    applyFrameMode(maximized, fullscreen)
  }, { immediate: true })
  useWatch([fullscreen], () => {
    applyHostedTitlebar(isHostedDocument(), IS_MACOS && Boolean(fullscreen))
  }, { immediate: true })
}

/** 触摸/触控笔点拖拽区时主动发起窗口拖动（鼠标交给系统拖拽）。 */
export function onDragRegionPointerDown(event: PointerEvent<HTMLDivElement>): void {
  if (event.pointerType === 'mouse')
    return
  event.preventDefault()
  void getCurrentWindow().startDragging()
}
