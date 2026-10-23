import type { PointerEvent } from 'react'
import { useWatch } from '@reause/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect, useState } from 'react'

/** WKWebView 的 macOS UA 稳定包含 Macintosh，用于切换平台原生窗口 chrome。 */
export function isMacOS(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Macintosh')
}
export const IS_MACOS = isMacOS()

/** 浏览器预览与 jsdom 没有原生窗口，原生调用必须在此拦截，不能靠 catch 兜底。 */
function hasNativeWindow(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 自绘外框模式：'' 关闭；全屏统一 flat；非 macOS 常规 inset / 最大化 flat；macOS 常规仅补描边 border。 */
export function frameMode(maximized: boolean, fullscreen = false): string {
  const frame = (window as Window & { __DSH_FRAME__?: boolean }).__DSH_FRAME__ === true
  if (!frame)
    return ''
  if (fullscreen)
    return 'flat'
  if (isMacOS())
    return 'border'
  return maximized ? 'flat' : 'inset'
}

/** 根据窗口状态计算并应用外框模式到 document dataset。 */
export function applyFrameMode(maximized: boolean, fullscreen = false) {
  const mode = frameMode(maximized, fullscreen)
  if (mode)
    document.documentElement.dataset.dshFrame = mode
  else
    delete document.documentElement.dataset.dshFrame
}

/** 最大化或全屏时撤掉外框内缩与圆角（阴影会被屏幕边缘裁出硬边），还原后再画回。 */
export function useFrameChrome() {
  const framed = typeof window !== 'undefined' && (window as Window & { __DSH_FRAME__?: boolean }).__DSH_FRAME__ === true
  const maximized = useMaximized(framed)
  const fullscreen = useFullscreen(framed)
  useWatch([maximized, fullscreen], () => applyFrameMode(maximized, fullscreen), { immediate: true })
}

/** 订阅 Tauri 原生窗口全屏状态并返回当前值。 */
export function useFullscreen(enabled = true) {
  const [isFullscreen, setIsFullscreen] = useState(false)

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
        await syncFullscreen()
        const stopListening = await appWindow.onResized(() => {
          void syncFullscreen()
        })
        if (mounted)
          unlisten = stopListening
        else
          stopListening()
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
export function useMacOSFullscreen() {
  const isFullscreen = useFullscreen(IS_MACOS)
  return IS_MACOS && isFullscreen
}

/** 订阅 Tauri 原生窗口最大化状态并返回当前值。 */
export function useMaximized(enabled = true) {
  const [isMaximized, setIsMaximized] = useState(false)

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
        await syncMaximized()
        const stopListening = await appWindow.onResized(() => {
          void syncMaximized()
        })
        if (mounted)
          unlisten = stopListening
        else
          stopListening()
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
