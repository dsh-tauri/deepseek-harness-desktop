/* eslint-disable react/dom-no-unsafe-iframe-sandbox */
import type { CSSProperties, RefObject } from 'react'
import type { NotificationActionEvent } from '@/hooks/use-notification-action'
import type { NotificationClickEvent } from '@/hooks/use-notification-clicked'
import {
  isPermissionGranted,
  registerActionTypes,
  requestPermission,
  sendNotification,
} from '@choochmeque/tauri-plugin-notifications-api'
import { CircleExclamation } from '@gravity-ui/icons'
import { toast } from '@heroui/react'
import { useOverlay } from '@overlastic/react'
import { useEventListener, useTimeoutFn, useUnmountedRef, useWatch } from '@reause/core'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { queryClient } from '@/config/client'
import { queryKeys } from '@/config/query-keys'
import { useDshStyle } from '@/hooks/use-dsh-style'
import { useIframeMessage } from '@/hooks/use-iframe-message'
import { useIframePost } from '@/hooks/use-iframe-post'
import { useInvokeIframe } from '@/hooks/use-invoke-iframe'
import { useNotificationAction } from '@/hooks/use-notification-action'
import { useNotificationClicked } from '@/hooks/use-notification-clicked'
import { useSyncVisibility } from '@/hooks/use-sync-visibility'
import { useZoomFactor } from '@/hooks/use-zoom-factor'
import { store } from '@/store'
import { ConfigDialog } from '@/ui/dialog/config'
import { zoomActionFromBridgeMessage, zoomActionFromShortcut } from '@/utils/zoom'
import { appearanceBootCss, appearanceTranslucent, normalizeAppearance } from '../../../packages/dsh-tauri/src/shared/appearance'
import { Loadable } from './loadable'

/** 启动期外观握手兜底：帧内接收器异常时也不让 iframe 永久藏住（远超正常握手耗时）。 */
const APPEARANCE_HANDSHAKE_TIMEOUT = 4000

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
  /** 通知桥：置 true 让原生通知自己静音（提示音由帧内 `sound.play()` 播放，避免双声）。 */
  silent?: boolean
  /** 通知桥：插件声明的系统通知按钮（`{ action, title, … }`；`input` 系列字段透传给 Windows toast 的输入框） */
  actions?: { action: string, title: string, input?: boolean, inputPlaceholder?: string, inputButtonTitle?: string }[]
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
   * `useRemote`），不再等本地实例健康；为空维持本地实例语义。
   */
  srcOverride?: string | null
  /** 远端机器勾选「边框着色」时的标识色：给内容区描 inset ring（一眼可辨远端态）。 */
  borderTint?: string | null
}

export interface NotificationClickedPayload {
  sessionId?: string | null
  title?: string
  tag?: string
  /** 命中的系统通知按钮 action id；点通知本体时为空。 */
  action?: string | null
  /** 带输入框的按钮：用户在系统通知里填的文本。 */
  inputValue?: string | null
}

/** 插件的动作类型载荷（它的 `ActionType` 没有从 JS API 导出，这里从函数签名反推）。 */
type ActionTypeRegistration = Parameters<typeof registerActionTypes>[0][number]

/** 已注册过的按钮集合，按 action type id 索引。 */
const registeredActionTypes = new Map<string, ActionTypeRegistration>()

/** 注册表上限：实际只有「批准 / 拒绝」与「回复」两组，这里只是防止异常输入把表撑大。 */
const ACTION_TYPE_LIMIT = 16

let notificationPermissionRequest: Promise<boolean> | undefined

function ensureNotificationPermission(): Promise<boolean> {
  notificationPermissionRequest ??= (async () => {
    try {
      if (await isPermissionGranted())
        return true
      return await requestPermission() === 'granted'
    }
    catch (error) {
      console.error('[notification] permission request failed:', error)
      return false
    }
  })().finally(() => { notificationPermissionRequest = undefined })
  return notificationPermissionRequest
}

/**
 * 合并同一次按钮点击的重复投递的窗口（毫秒）。
 *
 * 一次点击会同时走「应用内 `Activated` 事件」与「进程外 COM 激活回调」两条通路，两条都
 * 带着同一份 `arguments`，但用户输入文本往往只有其中一条有；两条到达间隔在 1ms 量级，
 * 250ms 足够把它们并成一次投递（见 `handleNotificationAction`）。
 */
const ACTION_COALESCE_MS = 250

/**
 * 一组按钮对应一个 action type id，由动作 id 拼出来；同一组按钮永远映射到同一个 id。
 *
 * 插件的 `registerActionTypes` 是「按 id 覆盖」的（Windows 存一张 id → 动作表，macOS 的
 * `setNotificationCategories` 更是整表替换）。复用同一个 id 会让后注册的集合顶掉先注册的：
 * 两个会话同时挂起时，授权通知的按钮会变成提问通知的「回复」。
 */
function actionTypeIdFor(actions: readonly { action: string }[]): string {
  return `dsh-notification-${actions.map(action => action.action).join('-')}`
}

/**
 * 把当前按钮集合并入注册表，并返回**全部**已注册集合。
 *
 * macOS 侧 `setNotificationCategories` 整表替换，只注册当前集合会把已经发出去的通知上的
 * 按钮抹掉；所以每次都把用过的集合一起注册回去。
 */
function actionTypesToRegister(current: ActionTypeRegistration): ActionTypeRegistration[] {
  registeredActionTypes.delete(current.id)
  registeredActionTypes.set(current.id, current)
  while (registeredActionTypes.size > ACTION_TYPE_LIMIT) {
    const oldest = registeredActionTypes.keys().next().value
    if (oldest === undefined)
      break
    registeredActionTypes.delete(oldest)
  }
  return [...registeredActionTypes.values()]
}

/**
 * 通知 id 必须是 32 位整数，这里取 tag 的稳定哈希：同一会话的同一条通知反复发送时
 * 复用同一个 id（就地更新），而不是每次多堆一条。
 */
function notificationIdFor(tag: string | undefined): number {
  let hash = 0
  for (const char of tag ?? '')
    hash = (hash * 31 + char.charCodeAt(0)) | 0
  return (Math.abs(hash) % 0x7FFFFFFF) || 1
}

/** 内置提示音：壳层 `public/` 下的资源，名字与插件侧的 `BuiltinNotificationSound` 对齐。 */
const NOTIFICATION_SOUND_FILES: ReadonlyArray<readonly [string, string]> = [
  ['default', '/notification.wav'],
  ['classic', '/classic.wav'],
]

/** 已读到的内置提示音（data URL）；插件在 iframe 里取不到壳层同源文件，只能这样送过去。 */
let notificationSoundAssets: Record<string, string> | undefined

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string')
        resolve(reader.result)
      else
        reject(new Error('FileReader returned a non-string result'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsDataURL(blob)
  })
}

/** 读取内置提示音并转成 data URL（读一次缓存住，除非其中任何一个读取失败）。 */
async function loadNotificationSounds(): Promise<Record<string, string>> {
  if (notificationSoundAssets)
    return notificationSoundAssets
  const entries = await Promise.all(NOTIFICATION_SOUND_FILES.map(async ([name, url]) => {
    const response = await fetch(url)
    if (!response.ok)
      throw new Error(`${url}: HTTP ${response.status}`)
    return [name, await readBlobAsDataUrl(await response.blob())] as const
  }))
  notificationSoundAssets = Object.fromEntries(entries)
  return notificationSoundAssets
}

export function Iframe({ iframeRef, srcOverride = null, borderTint = null }: IframeProps) {
  const { t } = useTranslation()
  const openConfigDialog = useOverlay(ConfigDialog)
  const harness = useStore(store.harness)
  const setting = useStore(store.setting)
  // 远端模式：非空时 iframe 指向该隧道 URL（远端机器的本地回环隧道，见
  // `useRemote`），不再等本地实例健康；为空维持本地实例语义。
  // 远端加载进度：「已落定 URL」派生——换 URL 自动回到加载态，iframe onLoad
  // 记录落定收起（无 effect、无额外渲染轮次）。
  const remoteMode = srcOverride !== null && srcOverride !== ''
  const [loadedUrl, setLoadedUrl] = useState('')
  const remoteLoading = remoteMode && loadedUrl !== srcOverride
  const preloadKey = `${harness.frontendGeneration}#${harness.iframeKey}#${harness.serviceUrl}`
  const [preload, setPreload] = useState<{ key: string, src: string, id: string, waiting: boolean, applied: boolean } | null>(null)
  const [preloadFailed, setPreloadFailed] = useState('')
  const activePreload = !remoteMode && preload?.key === preloadKey && preloadFailed !== preloadKey ? preload : null
  const frameSrc = remoteMode ? srcOverride : activePreload?.src ?? harness.iframeSrc
  // 换帧（本地重挂 / 换远端隧道 / 重载）即视为新一代文档：旧文档的外观确认不能替它背书。
  const frameKey = `${frameSrc}#${harness.iframeKey}`
  const [bootFrame, setBootFrame] = useState<string | null>(null)
  const appearance = normalizeAppearance(setting.appearance)
  const translucent = (window as Window & { __DSH_TRANSPARENT__?: boolean }).__DSH_TRANSPARENT__ === true
    && appearanceTranslucent(appearance)
  const bootCss = translucent ? appearanceBootCss(appearance) : ''
  const post = useIframePost(iframeRef)
  // 握手兜底：帧内接收器异常时不能让 iframe 永久藏住，超时后按「未确认」直接揭开。
  const appearancePending = translucent && bootFrame !== frameKey
  const iframeHidden = appearancePending || remoteLoading || harness.showIframeError
  const mounted = remoteMode || activePreload !== null || harness.serviceHealthy
  const showIframeError = !remoteMode && harness.showIframeError
  const documentWaiting = !remoteMode && mounted && !harness.iframeAlive && !showIframeError && !appearancePending
  const branch = !mounted ? 'service-wait' : showIframeError ? 'iframe-error' : remoteLoading ? 'remote-loading' : appearancePending ? 'appearance-wait' : documentWaiting ? 'document-wait' : remoteMode ? 'remote-frame' : 'local-frame'
  useWatch([branch, harness.status, remoteMode, mounted, harness.serviceHealthy, harness.serviceRunning, harness.iframeKey, harness.iframeLoaded, harness.iframeAlive, harness.iframeError, harness.startupPhase, harness.busyAction, appearancePending, documentWaiting, iframeHidden], () => {
    console.warn('[Iframe] view', {
      branch,
      status: harness.status,
      remoteMode,
      mounted,
      serviceHealthy: harness.serviceHealthy,
      serviceRunning: harness.serviceRunning,
      iframeKey: harness.iframeKey,
      iframeLoaded: harness.iframeLoaded,
      iframeAlive: harness.iframeAlive,
      iframeError: harness.iframeError,
      startupPhase: harness.startupPhase,
      busyAction: harness.busyAction,
      appearancePending,
      documentWaiting,
      iframeHidden,
    })
  }, { immediate: true })
  const unmounted = useUnmountedRef()
  const preloadRequestRef = useRef(0)
  useWatch([preloadKey, remoteMode], () => {
    const request = ++preloadRequestRef.current
    if (remoteMode) {
      setPreload(null)
      return
    }
    if (store.harness.serviceHealthy)
      return
    void invoke<string | null>('prepare_frontend_preload').then((src) => {
      if (unmounted.current || request !== preloadRequestRef.current || !src || store.harness.serviceHealthy)
        return
      const url = new URL(src)
      const id = url.searchParams.get('_dshPreload')
      if (id && url.origin === store.harness.serviceUrl)
        setPreload({ key: preloadKey, src, id, waiting: false, applied: false })
    }).catch(error => console.warn('[Iframe] native frontend preload unavailable:', error))
  }, { immediate: true })
  function fallbackPreload() {
    store.harness.markIframeLeaving()
    setPreloadFailed(preloadKey)
  }
  useWatch([activePreload?.id, activePreload?.waiting, harness.serviceHealthy, harness.frontendBootHtml], () => {
    if (!activePreload?.waiting || activePreload.applied || !harness.serviceHealthy)
      return
    if (!harness.frontendBootHtml) {
      fallbackPreload()
      return
    }
    post({ type: 'dsh://frontend-preload:boot', id: activePreload.id, html: harness.frontendBootHtml })
  }, { immediate: true })
  const { start: armPreloadFallback, stop: stopPreloadFallback } = useTimeoutFn(
    fallbackPreload,
    8000,
    { immediate: false },
  )
  useWatch([activePreload?.id, activePreload?.applied, harness.serviceHealthy], () => {
    if (activePreload && !activePreload.applied && harness.serviceHealthy)
      armPreloadFallback()
    else
      stopPreloadFallback()
  }, { immediate: true })
  const { start: armAppearanceFallback, stop: stopAppearanceFallback } = useTimeoutFn(
    () => setBootFrame(frameKey),
    APPEARANCE_HANDSHAKE_TIMEOUT,
    { immediate: false },
  )
  useWatch([frameKey, mounted], ([, mounted]) => {
    setBootFrame(null)
    if (mounted)
      armAppearanceFallback()
    else
      stopAppearanceFallback()
  }, { immediate: true })
  // iframe 与外观投影同一次提交挂载：src 落定后立刻把启动期 CSS 交给帧内接收器
  // （帧内自己也会 document-start 主动请求一次，两条通路互为兜底）。
  useWatch(
    [frameSrc, bootCss],
    ([src, css]) => {
      if (!src)
        return
      post({ type: 'dsh://appearance', bootCss: css })
    },
    { immediate: true },
  )

  /** 待合并的按钮动作，按「tag + actionId」索引（见 `handleNotificationAction`）。 */
  const pendingActionsRef = useRef(new Map<string, { payload: NotificationClickedPayload, timer: ReturnType<typeof setTimeout> }>())

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

  // 系统通知的点击 / 按钮动作 → 让 iframe 聚焦对应会话并回灌 onaction。
  // 订阅细节（含「必须先订阅 onNotificationClicked，Windows 才会派发点击 / 按钮事件」）
  // 收在 hooks 里，与 `useListen` 同一套 latest-ref + 卸载注销语义。
  useNotificationAction(handleNotificationAction)
  useNotificationClicked(handleNotificationClick)

  // iframe → 宿主：iframe 自身的桥共用一个监听器，按 `data.type` 分发
  useIframeMessage<IframeBridgeMessage>(iframeRef, (data) => {
    if (typeof data.type !== 'string')
      return
    if (data.type.startsWith('dsh://frontend-preload:')) {
      if (!activePreload || data.id !== activePreload.id)
        return
      if (data.type === 'dsh://frontend-preload:waiting') {
        setPreload({ ...activePreload, waiting: true })
      }
      else if (data.type === 'dsh://frontend-preload:applied') {
        setPreload({ ...activePreload, applied: true })
      }
      else if (data.type === 'dsh://frontend-preload:failed') {
        console.warn('[Iframe] native frontend preload failed; using live HTTP:', data.detail)
        fallbackPreload()
      }
      return
    }
    // 帧内文档离开（帧内导航）：旧确认立刻作废，等新文档自己重新自报（issue #705）；
    // 外观确认同样作废，并重新隐蔽 iframe + 重挂兜底，避免旧样式作用在新文档上。
    if (data.type === 'dsh://plugin-boot:leaving') {
      setBootFrame(null)
      armAppearanceFallback()
      store.harness.markIframeLeaving()
      return
    }
    // 帧内确认启动期外观已落盘：此刻可以安全揭开 iframe，不会闪出不透明 boot 页。
    // （确认本身已由 `useAppearance` 记录，这里只负责把这一代标记为已确认。）
    if (data.type === 'dsh://appearance:applied') {
      setBootFrame(frameKey)
      return
    }
    // 能走到这里说明帧内确实跑着 dsh 页面（来源与 origin 已由 hook 校验过），
    // 与具体桥无关——据此确认 iframe 不是一张浏览器内部错误页（issue #705）。
    store.harness.markIframeAlive()
    switch (data.type) {
      case 'dsh://desktop-settings:open':
        void openConfigDialog({ tab: 'application' }).catch((error: unknown) => {
          if (error === undefined)
            return
          console.error('[Iframe] failed to open desktop settings:', error)
          toast(t('messages.open_settings_failed'), { variant: 'danger' })
        })
        break
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
        if (activePreload && !activePreload.applied) {
          if (harness.serviceHealthy)
            fallbackPreload()
          break
        }
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
      // 内置提示音：插件客户端在 iframe 里取不到壳层 `public/` 的同源文件，读成 data URL 送过去
      case 'dsh://notification-sounds:request':
        pushNotificationSounds()
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
    void setting.zoom(action).catch(error => console.error('[Zoom] failed to save zoom:', error))
  }

  /**
   * 把内置提示音（`public/*.wav`）读成 data URL 交给 iframe。
   *
   * 插件客户端跑在 iframe 里，与壳层 `public/` 不同源，直接 `new Audio('/notification.wav')`
   * 只会 404；帧内已有用户激活且 iframe 显式 `allow="autoplay"`，播放留在帧内最稳。
   * 读取失败只记日志：帧内会退回合成音，通知本身不受影响。
   */
  function pushNotificationSounds() {
    void loadNotificationSounds()
      .then(sounds => post({ type: 'dsh://notification-sounds', sounds }))
      .catch(error => console.error('[notification] failed to load notification sounds:', error))
  }

  function handleNativeNotification(data: IframeBridgeMessage) {
    const actions = Array.isArray(data.actions) ? data.actions : []
    const hasActions = actions.length > 0
    const title = data.title ?? ''
    const body = data.body ?? ''

    void (async () => {
      if (!await ensureNotificationPermission())
        return
      // 后端只在 `actionTypeId` 已注册时才往通知里写按钮，所以必须先注册再发送；
      // 每次都用插件给的本地化文案重新注册，按钮文案才能跟随界面语言。
      // 整组按钮一起注册（授权是「批准 / 拒绝」），带输入框的按钮把 input 系列字段一并透传，
      // Windows 靠它们生成 toast 里的文本框与提交按钮。
      const actionTypeId = hasActions ? actionTypeIdFor(actions) : undefined
      let actionsRegistered = false
      if (actionTypeId) {
        try {
          await registerActionTypes(actionTypesToRegister({
            id: actionTypeId,
            actions: actions.map(action => ({
              id: action.action,
              title: action.title,
              foreground: true,
              input: action.input === true,
              inputPlaceholder: action.inputPlaceholder,
              inputButtonTitle: action.inputButtonTitle,
            })),
          }))
          actionsRegistered = true
        }
        catch (error) {
          // 注册失败不能连通知一起丢掉：Linux/FreeBSD 的 notify-rust 明确不支持动作，抛错时
          // 退化成没有按钮的通知，用户至少还能点回对应会话。
          console.warn('[notification] registerActionTypes failed, sending without actions:', error)
        }
      }
      try {
        await sendNotification({
          id: notificationIdFor(data.tag),
          title,
          body,
          // 帧内已经按设置播过提示音，这里让 toast 自己静音：Windows 上不静音就会额外响一次默认音。
          silent: data.silent === true ? true : undefined,
          actionTypeId: actionsRegistered ? actionTypeId : undefined,
          extra: {
            sessionId: data.sessionId ?? '',
            title,
            tag: data.tag ?? '',
          },
        })
      }
      catch (error) {
        console.error('[notification] sendNotification failed:', error)
      }
    })()
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
      void setting.zoom(action).catch(error => console.error('[Zoom] failed to save zoom:', error))
  }

  function handleFrameLog(data: IframeBridgeMessage) {
    // 桥消息一律按不可信输入处理：非字符串/超长文本直接丢弃或截断
    if (typeof data.message !== 'string' || data.message === '')
      return
    const level = data.level === 'error' ? 'error' : 'warn'
    void invoke('log_frontend', { level, target: 'iframe', message: data.message.slice(0, 2048) })
      .catch(error => console.error('[frame-log] log_frontend failed:', error))
  }

  /**
   * 点通知本体：先把窗口拉回前台，再让帧内聚焦对应会话。
   *
   * 窗口这一步是必需的：点通知时窗口多半在后台（最小化 / 被别的窗口盖住），
   * 只回灌 iframe 消息的话用户看不到任何变化。失败只记录日志——窗口 API 报错不该
   * 阻断帧内的会话切换与按钮回调。
   */
  async function activateApplication(payload: NotificationClickedPayload) {
    try {
      const appWindow = getCurrentWindow()
      if (await appWindow.isMinimized())
        await appWindow.unminimize()
      await appWindow.show()
      await appWindow.setFocus()
    }
    catch (error) {
      console.error('[notification] focus window failed:', error)
    }
    post({
      type: 'dsh://focus-session',
      sessionId: payload.sessionId || undefined,
      title: payload.title || undefined,
      tag: payload.tag || undefined,
    })
  }

  /**
   * 点击 / 按钮动作回灌给帧内的 Notification 实例：插件注册的
   * onclick、onaction 回调只存在于 iframe 里，壳层只负责转发。
   *
   * 点按钮只走这里，不碰窗口也不切会话：在通知里点「批准 / 拒绝 / 回复」时用户的
   * 视线通常还在别处，把窗口拽到前台会打断手上的事；要看结果自己点通知本体。
   */
  function deliverNotificationResult(payload: NotificationClickedPayload) {
    post({
      type: 'dsh://notification-clicked',
      tag: payload.tag || undefined,
      action: payload.action || undefined,
      inputValue: payload.inputValue || undefined,
    })
  }

  /** `onAction`：点通知本体（`actionId === 'tap'`）交给 `onNotificationClicked`，这里只管按钮。 */
  function handleNotificationAction(event: NotificationActionEvent) {
    const { actionId, inputValue, notification, extra: payloadExtra } = event
    if (typeof actionId !== 'string' || actionId === '' || actionId === 'tap')
      return

    // 会话标识只能从 `extra` 取：进程外 COM 激活（点通知中心里的历史通知）拿到的
    // `notification` 恒为 `null`，而 `extra` 是发送时写进按钮 arguments 的那份数据
    // 原样带回来的。缺了 tag，帧内 `pendingOnClicks` 找不到实例，事件会被静默丢弃。
    const extra = payloadExtra ?? notification?.extra
    const payload: NotificationClickedPayload = {
      sessionId: extra?.sessionId ?? null,
      title: extra?.title,
      tag: extra?.tag,
      action: actionId,
      inputValue: typeof inputValue === 'string' ? inputValue : null,
    }

    // 同一次点击会从两条激活通路各投一次，用户输入文本往往只挂在其中一条上：
    // 先到的先压住，250ms 内的第二条与它合并（优先保留带输入文本的那一份），
    // 只向帧内投递一次，避免回复内容被空的那份顶掉。
    const key = `${payload.tag ?? ''}|${actionId}`
    const queued = pendingActionsRef.current.get(key)
    if (queued) {
      clearTimeout(queued.timer)
      pendingActionsRef.current.delete(key)
      dispatchNotificationAction({
        ...queued.payload,
        ...payload,
        inputValue: payload.inputValue || queued.payload.inputValue,
      })
      return
    }

    const timer = setTimeout(() => {
      pendingActionsRef.current.delete(key)
      dispatchNotificationAction(payload)
    }, ACTION_COALESCE_MS)
    pendingActionsRef.current.set(key, { payload, timer })
  }

  function dispatchNotificationAction(payload: NotificationClickedPayload) {
    // 事件有没有真的到达壳层、有没有带上会话标识只有日志能回答：Windows 的 toast 激活
    // 依赖插件侧回调。eslint 只允许 console.warn/error，而 console 会被 utils/logger
    // 劫持写进前台日志（desktop.frontdesk.log），所以开发态用 warn 留痕、打包态不打扰。
    if (import.meta.env.DEV) {
      console.warn('[notification] action event:', payload.action, {
        tag: payload.tag ?? null,
        sessionId: payload.sessionId ?? null,
        inputLength: payload.inputValue?.length ?? 0,
      })
    }
    void deliverNotificationResult(payload)
  }

  /** `onNotificationClicked`：点通知本体（前台与冷启动两条路径都会走到这里）。 */
  function handleNotificationClick(event: NotificationClickEvent) {
    const { data } = event
    if (import.meta.env.DEV)
      console.warn('[notification] click event:', JSON.stringify(data ?? null))

    const payload: NotificationClickedPayload = {
      sessionId: data?.sessionId ?? null,
      title: data?.title,
      tag: data?.tag,
    }
    void activateApplication(payload).then(() => deliverNotificationResult(payload))
  }

  return (
    <div className="relative min-h-0 flex-1">
      <If
        cond={mounted}
        else={<Loadable subtitle={t(harness.startupStatusKey)} />}
      >
        <iframe
          key={`${remoteMode ? `remote-${srcOverride}` : activePreload?.id ?? 'http'}#${harness.iframeKey}`}
          ref={iframeRef}
          data-testid="dsh-shell-iframe"
          className="h-full w-full"
          // 未确认收到启动期外观前先藏起来：帧内 boot 页（HARNESS + Loading plugins…）
          // 会先按不透明画一帧，露出那一下比等待更刺眼。上面的 Loadable 与之逐项同构，
          // 揭开时视觉无跳变，且有 4s 兜底不会永久藏住。
          style={{ visibility: appearancePending || remoteLoading || harness.showIframeError ? 'hidden' : 'visible' }}
          src={frameSrc}
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
