import type { RefObject } from 'react'
import { useWatch } from '@reause/core'
import { Effect, EffectState, getCurrentWindow } from '@tauri-apps/api/window'
import { type } from '@tauri-apps/plugin-os'
import { useRef } from 'react'
import { useStore } from 'valtio-define'
import { store } from '@/store'
import { appearanceBootCss, appearanceColors, appearanceSidebarFill, appearanceStartupFill, appearanceTranslucent, normalizeAppearance } from '../../packages/dsh-tauri/src/shared/appearance'
import { useDshStyle } from './use-dsh-style'
import { useIframeMessage } from './use-iframe-message'
import { useIframePost } from './use-iframe-post'

export function useAppearance(iframeRef: RefObject<HTMLIFrameElement | null>) {
  const { appearance, hydrated } = useStore(store.setting)
  const [dshStyle] = useDshStyle()
  const post = useIframePost(iframeRef)
  const readyRef = useRef(false)
  const nativeEffectQueueRef = useRef(Promise.resolve())
  const transparent = (window as Window & { __DSH_TRANSPARENT__?: boolean }).__DSH_TRANSPARENT__ === true
  const value = normalizeAppearance(appearance)
  const payload = { ...value, transparency: transparent && value.transparency, opacity: transparent && value.transparency ? value.opacity : 100 }
  const bootCss = appearanceBootCss(payload)
  const scheme = dshStyle.colorScheme ?? (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')

  function sendAppearance() {
    post({ type: 'dsh://appearance', appearance: payload, bootCss })
  }

  // 帧内在 document-start 就请求一次（那时壳层可能还没挂载监听器），激活后还会按既有协议
  // 自报 ready；两条通路都回同一份投影，重复下发由帧内幂等处理。
  useIframeMessage<{ type?: string }>(iframeRef, (message) => {
    if (message.type === 'dsh://appearance:ready' || message.type === 'dsh://appearance:request' || message.type === 'dsh://plugin-boot:frame') {
      readyRef.current = true
      sendAppearance()
    }
    else if (message.type === 'dsh://plugin-boot:leaving') {
      readyRef.current = false
    }
  })
  useWatch([appearance, dshStyle.colorScheme], () => {
    if (readyRef.current)
      sendAppearance()
  }, { immediate: true })
  // 原生背景效果只在窗口真透明且平台支持时才设：设置错了会让窗口内容被系统合成器
  // 换成不透明底，比不设更糟；调用是异步窗口 API，串行化避免快速切换时后发先至。
  useWatch([appearance, hydrated], () => {
    if (!hydrated)
      return
    let platform: ReturnType<typeof type>
    try {
      platform = type()
    }
    catch {
      return
    }
    if (!transparent || (platform !== 'windows' && platform !== 'macos'))
      return

    const appWindow = getCurrentWindow()
    nativeEffectQueueRef.current = nativeEffectQueueRef.current
      .then(() => value.transparency && value.blur
        ? appWindow.setEffects({
            effects: [Effect.Acrylic, Effect.Mica, Effect.UnderWindowBackground],
            state: EffectState.FollowsWindowActiveState,
          })
        : appWindow.clearEffects())
      .catch(error => console.warn('[useAppearance] native backdrop effect failed:', error))
  }, { immediate: true })

  const alpha = transparent && value.transparency ? value.opacity : 100
  const backdropFilter = transparent && appearanceTranslucent(value) && value.blur ? 'blur(16px)' : 'none'
  if (value.palette === 'default' && alpha === 100 && !transparent)
    return ''
  const { canvas, panel, surface, text, muted, accent, border } = appearanceColors(value, scheme)
  return [
    // 自绘外框把画布底色下沉到了 shell-root（main.css），透明模式必须一并放掉，
    // 否则内容区被实心 canvas 垫住、桌面颜色透不出来。
    alpha < 100 ? 'html,body,[data-testid="dsh-shell-root"]{background:transparent!important}' : '',
    `html[data-theme]{--color-canvas:${canvas};--color-startup:${appearanceStartupFill(value, canvas)};--color-panel:${panel};--color-panel-2:${surface};--color-ink:${text};--color-info:${accent};--foreground:${text};--muted:${muted};--background:${canvas};--surface:${panel};--surface-secondary:${surface};--surface-tertiary:${surface};${border ? `--color-line:${border};--color-line-strong:${border};--color-btn-border:${border};--border:${border};--separator:${border};--field-border:${border};` : ''}}`,
    `[data-testid="dsh-navbar-root"]{background:${appearanceSidebarFill(canvas, panel, alpha < 100, alpha)}!important;${backdropFilter === 'none' ? '' : `backdrop-filter:${backdropFilter};-webkit-backdrop-filter:${backdropFilter};`}}`,
    alpha < 100 && value.sidebarOnly ? `[data-testid="dsh-config-dialog"]{background:${panel}!important}` : '',
    // 启动页（Loadable / 全屏恢复页 / 预装引导）不属于内容区，但必须跟 navbar、侧边栏
    // 用同一层 alpha，否则窗口背后只透出一半。
    '[data-testid="dsh-shell-root"]>main{background:transparent!important}',
  ].filter(Boolean).join('\n')
}
