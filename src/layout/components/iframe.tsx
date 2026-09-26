/* eslint-disable react/dom-no-unsafe-iframe-sandbox */
import type { CSSProperties, RefObject } from 'react'
import { CircleExclamation } from '@gravity-ui/icons'
import { useEventListener } from '@reause/core'
import { invoke } from '@tauri-apps/api/core'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { queryClient } from '@/config/client'
import { queryKeys } from '@/config/query-keys'
import { useDshStyle } from '@/hooks/use-dsh-style'
import { useIframeMessage } from '@/hooks/use-iframe-message'
import { useIframePost } from '@/hooks/use-iframe-post'
import { useInvokeIframe } from '@/hooks/use-invoke-iframe'
import { useListen } from '@/hooks/use-listen'
import { useSyncVisibility } from '@/hooks/use-sync-visibility'
import { useZoomFactor } from '@/hooks/use-zoom-factor'
import { store } from '@/store'
import { zoomActionFromBridgeMessage, zoomActionFromShortcut } from '@/utils/zoom'
import { Loadable } from './loadable'
/** 可见性兜底轮询间隔：主路径是窗口 focus/resize 事件，5s 足以覆盖任务栏切换等场景 */

/**
 * iframe → 宿主 的桥消息（宿主侧按 `type` 分发，不比对 `source`）。
 * 只列 iframe 自身关心的桥：通知 / 插件异常 / 剪贴板图片 / 插件 boot / 帧内日志
 * （导航桥的 `dsh://sidebar:collapsed` 由 `webview.tsx` 处理）。
 */
interface IframeBridgeMessage {
  type?: string
  /** 通知桥 */
  title?: string
  body?: string
  tag?: string
  sessionId?: string | null
  requireInteraction?: boolean
  /** 插件异常桥 / 剪贴板图片桥：插件 id 或剪贴板请求 id */
  id?: string
  error?: string
  action?: string
  /** 插件 boot 桥：失败页文本 */
  detail?: string
  /** 帧内日志桥：console 级别（warn/error）与已序列化文本 */
  level?: string
  message?: string

  sidebar?: CSSProperties
  marked?: CSSProperties
  frame?: CSSProperties
}

export interface IframeProps {
  /** iframe 元素 ref（由 `webview.tsx` 创建：导航桥也要用同一个 ref 收发） */
  iframeRef: RefObject<HTMLIFrameElement | null>
  /**
   * 远端模式：非空时 iframe 指向该隧道 URL（远端机器的本地回环隧道，见
   * `store.remote`），不再等本地实例健康；为空维持本地实例语义。
   */
  srcOverride?: string | null
  /** 远端机器勾选「边框着色」时的标识色：给内容区描 inset ring（一眼可辨远端态）。 */
  borderTint?: string | null
}

export interface NotificationClickedPayload {
  sessionId?: string | null
  title?: string
  tag?: string
}

export function Iframe({ iframeRef, srcOverride = null, borderTint = null }: IframeProps) {
  const { t } = useTranslation()
  const harness = useStore(store.harness)
  const setting = useStore(store.setting)
  // 远端模式：非空时 iframe 指向该隧道 URL（远端机器的本地回环隧道，见
  // `store.remote`），不再等本地实例健康；为空维持本地实例语义。
  // 远端加载进度：「已落定 URL」派生——换 URL 自动回到加载态，iframe onLoad
  // 记录落定收起（无 effect、无额外渲染轮次）。
  const remoteMode = srcOverride !== null && srcOverride !== ''
  const [loadedUrl, setLoadedUrl] = useState('')
  const remoteLoading = remoteMode && loadedUrl !== srcOverride

  const post = useIframePost(iframeRef)

  const [, setDshStyle] = useDshStyle()

  // 转发 iframe 消息给 Tauri Rust 命令
  useInvokeIframe(iframeRef)

  // 将窗口可见性（最小化/隐藏/失焦）同步给 iframe，便于其暂停渲染
  useSyncVisibility(iframeRef)

  // 缩放真值 → WebView：显式传入真值，挂载时应用一次、之后真值变化才重应用；
  // 平台能力判定（macOS 10.15 没有原生缩放）由 `useZoomFactor` 内部处理
  useZoomFactor(setting.zoom_factor)

  // 壳层快捷键（焦点在导航栏等壳层元素时；iframe 内由注入脚本经缩放桥转发）
  useEventListener('keydown', handleZoomKeyDown, { capture: true })

  // 系统通知点击 → 让 iframe 聚焦对应会话
  useListen<NotificationClickedPayload>(
    'dsh-notification-clicked',
    event => handleNotificationClicked(event.payload),
  )

  // iframe → 宿主：iframe 自身的桥共用一个监听器，按 `data.type` 分发
  useIframeMessage<IframeBridgeMessage>(iframeRef, (data) => {
    // 帧内文档离开（帧内导航）：旧确认立刻作废，等新文档自己重新自报（issue #705）
    if (data.type === 'dsh://plugin-boot:leaving') {
      store.harness.markIframeLeaving()
      return
    }
    // 能走到这里说明帧内确实跑着 dsh 页面（来源与 origin 已由 hook 校验过），
    // 与具体桥无关——据此确认 iframe 不是一张浏览器内部错误页（issue #705）。
    store.harness.markIframeAlive()
    switch (data.type) {
      // 原生通知：转发给 Tauri 命令弹出系统通知
      case 'dsh://native-notification':
        handleNativeNotification(data)
        break
      // 插件异常上报：写后端错误注册表，并刷新插件列表（「插件」面板据此展示 danger 与修复入口）
      case 'dsh://plugin-error':
        handlePluginBoot(data)
        break
      // 剪贴板图片回退：读系统剪贴板并把 PNG data URL 回传
      // （Linux/WebKitGTK 下 dsh iframe 的 paste 事件拿不到图片，走原生剪贴板通路）
      case 'dsh://clipboard-image:read':
        handleClipboardImageRead(data)
        break
      // 插件 boot 状态：failed 携带官方失败页文本（如 web boot: 1 entry did not activate）
      case 'dsh://plugin-boot:ready':
        store.harness.markIframeBootReady()
        break
      case 'dsh://plugin-boot:stalled':
        void store.harness.recoverIframeBoot()
        break
      case 'dsh://plugin-boot:failed':
        void store.harness.handleIframeBootFailure(data.detail)
        break
      // 缩放快捷键：跨源 iframe 内的 Ctrl/Cmd +/-/0 不会冒泡到壳层，由 dsh-tauri 插件的
      case 'dsh://zoom-shortcut':
        handleZoomShortcut(data)
        break
      case 'dsh://style':
        setDshStyle(data)
        break
      // 帧内日志：iframe 跨源、帧内 console.* 没有宿主侧通路，由注入脚本转回来后
      // 直写 desktop.frontdesk.log，随「复制运行日志」的前台日志一并提供
      case 'dsh://frame-log':
        handleFrameLog(data)
        break
    }
  })

  function handleZoomKeyDown(event: KeyboardEvent) {
    const action = zoomActionFromShortcut(event)
    if (!action)
      return
    event.preventDefault()
    setting.zoom(action)
  }

  function handleNativeNotification(data: IframeBridgeMessage) {
    void invoke('show_native_notification', {
      payload: {
        title: data.title ?? '',
        body: data.body ?? '',
        tag: data.tag ?? null,
        sessionId: data.sessionId ?? null,
        requireInteraction: Boolean(data.requireInteraction),
      },
    }).catch(error => console.error('[notification] show_native_notification failed:', error))
  }

  function handlePluginBoot(data: IframeBridgeMessage) {
    if (!data.id || !data.error)
      return
    void invoke('report_plugin_error', {
      id: data.id,
      error: data.error,
      action: data.action ?? 'runtime',
    })
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.plugins })
      })
      .catch(error => console.error('[plugin-error] report_plugin_error failed:', error))
  }

  function handleClipboardImageRead(data: IframeBridgeMessage) {
    if (!data.id)
      return
    const reqId = data.id
    function reply(dataUrl: string | null) {
      post({ type: 'dsh://clipboard-image:reply', id: reqId, data_url: dataUrl })
    }
    void invoke<{ data_url?: string } | null>('read_clipboard_image')
      .then(result => reply(result?.data_url ?? null))
      .catch((error) => {
        console.error('[clipboard-image] read_clipboard_image failed:', error)
        reply(null)
      })
  }

  function handleZoomShortcut(data: IframeBridgeMessage) {
    const action = zoomActionFromBridgeMessage(data)
    if (action)
      setting.zoom(action)
  }

  function handleFrameLog(data: IframeBridgeMessage) {
    // 桥消息一律按不可信输入处理：非字符串/超长文本直接丢弃或截断
    if (typeof data.message !== 'string' || data.message === '')
      return
    const level = data.level === 'error' ? 'error' : 'warn'
    void invoke('log_frontend', { level, target: 'iframe', message: data.message.slice(0, 2048) })
      .catch(error => console.error('[frame-log] log_frontend failed:', error))
  }

  function handleNotificationClicked(payload: NotificationClickedPayload) {
    post({
      type: 'dsh://focus-session',
      sessionId: payload.sessionId || undefined,
      title: payload.title || undefined,
      tag: payload.tag || undefined,
    })
  }

  return (
    <div className="relative min-h-0 flex-1">
      <If
        cond={remoteMode || harness.serviceHealthy}
        else={<Loadable subtitle={t(harness.startupStatusKey)} />}
      >
        <iframe
          key={remoteMode ? `remote-${srcOverride}` : harness.iframeKey}
          ref={iframeRef}
          data-testid="dsh-shell-iframe"
          className="h-full w-full"
          src={remoteMode ? srcOverride : harness.iframeSrc}
          allow="accelerometer; ambient-light-sensor; autoplay; battery; camera; clipboard-read; clipboard-write; display-capture; document-domain; encrypted-media; fullscreen; gamepad; geolocation; gyroscope; hid; idle-detection; keyboard-map; magnetometer; microphone; midi; payment; picture-in-picture; publickey-credentials-get; screen-wake-lock; serial; speaker-selection; usb; web-share; xr-spatial-tracking"
          sandbox="allow-same-origin allow-scripts allow-popups allow-forms allow-modals allow-downloads allow-storage-access-by-user-activation"
          onLoad={() => {
            store.harness.markIframeLoaded()
            if (remoteMode)
              setLoadedUrl(srcOverride)
          }}
          onError={store.harness.markIframeError}
          title={t('app.open_editor')}
        />
      </If>

      {/* 远端机器勾选「边框着色」时，用标识色给内容区描边：当前处于远端一眼可辨 */}
      <If cond={borderTint !== null}>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-[1]"
          style={borderTint !== null ? { boxShadow: `inset 0 0 0 2px ${borderTint}` } : undefined}
        />
      </If>

      {/* 远端加载覆盖层：切换/首载期间不空屏（iframe 保持挂载） */}
      <If cond={remoteMode && remoteLoading}>
        <div className="absolute inset-0 z-[1]">
          <Loadable subtitle={t('remote.loading')} />
        </div>
      </If>

      <If cond={!remoteMode && harness.showIframeError}>
        <div className="absolute inset-0 z-[1]">
          <Loadable
            icon={CircleExclamation}
            title={t('ui.iframe_error')}
            errorMsg={t('ui.ensure_running', { url: harness.serviceUrl })}
            onRetry={store.harness.refreshIframe}
          >
            {/* 服务就绪却毫无帧内消息：帧里根本没有 dsh 页面（浏览器内部错误页） */}
            <If cond={harness.iframeErrorHint !== ''}>
              <p className="text-xs leading-[18px] break-all text-load-muted">{harness.iframeErrorHint}</p>
            </If>
          </Loadable>
        </div>
      </If>
    </div>
  )
}
