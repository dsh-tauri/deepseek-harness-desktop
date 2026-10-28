import type { PointerEvent } from 'react'
import { useWatch } from '@reause/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect, useState } from 'react'

/** WKWebView 的 macOS UA 稳定包含 Macintosh，用于切换平台原生窗口 chrome。 */
export const IS_MACOS = typeof navigator !== 'undefined' && navigator.userAgent.includes('Macintosh')

/** 浏览器预览与 jsdom 没有原生窗口，原生调用必须在此拦截，不能靠 catch 兜底。 */
export function hasNativeWindow(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 自绘外框模式：'' 关闭；最大化 / 全屏统一 flat；常规窗口贴边画圆角与描边。 */
export function frameMode(maximized: boolean, fullscreen = false): string {
  const frame = (window as Window & { __DSH_FRAME__?: boolean }).__DSH_FRAME__ === true
  if (!frame)
    return ''
  if (fullscreen || maximized)
    return 'flat'
  return 'border'
}

export function applyFrameMode(maximized: boolean, fullscreen = false) {
  const mode = frameMode(maximized, fullscreen)
  if (mode)
    document.documentElement.dataset.dshFrame = mode
  else
    delete document.documentElement.dataset.dshFrame
}

/** 等待原生状态就绪后再覆盖 bootstrap 的首帧模式。 */
export function useFrameChrome() {
  const framed = typeof window !== 'undefined' && (window as Window & { __DSH_FRAME__?: boolean }).__DSH_FRAME__ === true
  const maximized = useMaximized(framed)
  const fullscreen = useFullscreen(framed)
  useWatch([maximized, fullscreen], () => {
    if (maximized === undefined || fullscreen === undefined)
      return
    applyFrameMode(maximized, fullscreen)
  }, { immediate: true })
}

export function useFullscreen(enabled = true): boolean | undefined {
  const [isFullscreen, setIsFullscreen] = useState<boolean | undefined>(undefined)

  // keep:effect 订阅 Tauri 原生窗口全屏状态与 resize 变化
  useEffect(() => {
    if (!enabled || !hasNativeWindow())
      return

    const appWindow = getCurrentWindow()
    let mounted = true
    let unlisten: (() => void) | undefined

    async function syncFullscreen() {
      try {
        const fullscreen = await appWindow.isFullscreen()
        if (mounted)
          setIsFullscreen(fullscreen)
      }
      catch (error) {
        console.error('[Navbar] failed to sync fullscreen state:', error)
      }
    }

    async function setupListener() {
      try {
        const stopListening = await appWindow.onResized(() => {
          void syncFullscreen()
        })
        if (mounted) {
          unlisten = stopListening
        }
        else {
          stopListening()
          return
        }
        await syncFullscreen()
      }
      catch (error) {
        console.error('[Navbar] failed to listen for fullscreen state:', error)
      }
    }

    void setupListener()
    return () => {
      mounted = false
      unlisten?.()
    }
  }, [enabled])

  return isFullscreen
}

/** macOS 原生全屏时收起整条壳层导航栏。 */
export function useMacOSFullscreen(): boolean {
  const isFullscreen = useFullscreen(IS_MACOS)
  return IS_MACOS && Boolean(isFullscreen)
}

export function useMaximized(enabled = true): boolean | undefined {
  const [isMaximized, setIsMaximized] = useState<boolean | undefined>(undefined)

  useEffect(() => {
    if (!enabled || !hasNativeWindow())
      return

    const appWindow = getCurrentWindow()
    let mounted = true
    let unlisten: (() => void) | undefined

    async function syncMaximized() {
      try {
        const maximized = await appWindow.isMaximized()
        if (mounted)
          setIsMaximized(maximized)
      }
      catch (error) {
        console.error('[Navbar] failed to sync maximized state:', error)
      }
    }

    async function setupListener() {
      try {
        const stopListening = await appWindow.onResized(() => {
          void syncMaximized()
        })
        if (mounted) {
          unlisten = stopListening
        }
        else {
          stopListening()
          return
        }
        await syncMaximized()
      }
      catch (error) {
        console.error('[Navbar] failed to listen for maximized state:', error)
      }
    }

    void setupListener()
    return () => {
      mounted = false
      unlisten?.()
    }
  }, [enabled])

  return isMaximized
}

/** 拖拽区指针处理：`data-tauri-drag-region` 原生只认鼠标，触摸/笔输入要手动进入系统拖拽。 */
export function onDragRegionPointerDown(event: PointerEvent<HTMLDivElement>) {
  if (event.pointerType === 'mouse')
    return
  event.preventDefault()
  void getCurrentWindow().startDragging()
}
