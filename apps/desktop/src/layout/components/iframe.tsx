import type { Event as TauriEvent } from '@tauri-apps/api/event'
import type { RefObject } from 'react'
import type { WebviewOutboundMessage } from './webview-bridge'
import type { NotificationActionEvent } from '@/hooks/use-notification-action'
import type { NotificationClickEvent } from '@/hooks/use-notification-clicked'
import type { DshWebviewElement } from '@/types/webview'
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
import { emit } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { useDshStyle } from '@/hooks/use-dsh-style'
import { useListen } from '@/hooks/use-listen'
import { useNotificationAction } from '@/hooks/use-notification-action'
import { useNotificationClicked } from '@/hooks/use-notification-clicked'
import { useSyncVisibility } from '@/hooks/use-sync-visibility'
import { useZoomFactor } from '@/hooks/use-zoom-factor'
import { store } from '@/store'
import { ConfigDialog } from '@/ui/dialog/config'
import { zoomActionFromPayload, zoomActionFromShortcut } from '@/utils/zoom'
import { appearanceBootCss, appearanceTranslucent, normalizeAppearance } from '../../../../../packages/builtin-plugin-tauri/src/shared/appearance'
import { Loadable } from './loadable'
import { emitGuestMessage, postToGuest, useGuestElementEvents } from './webview-bridge'

const APPEARANCE_HANDSHAKE_TIMEOUT = 4000

interface ClipboardFileEntry {
  data_url: string
  mime: string
  filename: string
  size: number
}

interface ClipboardFileRejection {
  filename: string
  reason: string
}

interface GuestBridgeMessage {
  [key: string]: unknown
  type?: string
  title?: string
  body?: string
  tag?: string
  sessionId?: string | null
  requireInteraction?: boolean
  silent?: boolean
  actions?: { action: string, title: string, input?: boolean, inputPlaceholder?: string, inputButtonTitle?: string }[]
  id?: string
  error?: string
  action?: string
  detail?: string
  level?: string
  message?: string
}

export interface GuestWebviewProps {
  guestRef: RefObject<DshWebviewElement | null>
  srcOverride?: string | null
  borderTint?: string | null
}

export interface NotificationClickedPayload {
  sessionId?: string | null
  title?: string
  tag?: string
  action?: string | null
  inputValue?: string | null
}

type ActionTypeRegistration = Parameters<typeof registerActionTypes>[0][number]

const registeredActionTypes = new Map<string, ActionTypeRegistration>()

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

const ACTION_COALESCE_MS = 250

function actionTypeIdFor(actions: readonly { action: string }[]): string {
  return `dsh-notification-${actions.map(action => action.action).join('-')}`
}

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

function notificationIdFor(tag: string | undefined): number {
  let hash = 0
  for (const char of tag ?? '')
    hash = (hash * 31 + char.charCodeAt(0)) | 0
  return (Math.abs(hash) % 0x7FFFFFFF) || 1
}

export function GuestWebview({ guestRef, srcOverride = null, borderTint = null }: GuestWebviewProps) {
  const { t } = useTranslation()
  const openConfigDialog = useOverlay(ConfigDialog)
  const harness = useStore(store.harness)
  const setting = useStore(store.setting)
  const remoteMode = srcOverride !== null && srcOverride !== ''
  const [loadedUrl, setLoadedUrl] = useState('')
  const remoteLoading = remoteMode && loadedUrl !== srcOverride
  const preloadKey = `${harness.frontendGeneration}#${harness.iframeKey}#${harness.serviceUrl}`
  const [preload, setPreload] = useState<{ key: string, src: string, id: string, waiting: boolean, applied: boolean } | null>(null)
  const [preloadFailed, setPreloadFailed] = useState('')
  const activePreload = !remoteMode && preload?.key === preloadKey && preloadFailed !== preloadKey ? preload : null
  const frameSrc = remoteMode ? srcOverride : activePreload?.src ?? harness.iframeSrc
  const frameKey = `${frameSrc}#${harness.iframeKey}`
  const [bootFrame, setBootFrame] = useState<string | null>(null)
  const appearance = normalizeAppearance(setting.appearance)
  const transparent = (window as Window & { __DSH_TRANSPARENT__?: boolean }).__DSH_TRANSPARENT__ === true
  const appearancePayload = {
    ...appearance,
    transparency: transparent && appearance.transparency,
    opacity: transparent && appearance.transparency ? appearance.opacity : 100,
  }
  const bootCss = appearanceTranslucent(appearancePayload) ? appearanceBootCss(appearancePayload) : ''
  const appearancePending = appearanceTranslucent(appearancePayload) && bootFrame !== frameKey
  const mounted = remoteMode || activePreload !== null || harness.serviceHealthy
  const showGuestError = !remoteMode && harness.showIframeError
  const documentWaiting = !remoteMode && mounted && !harness.iframeAlive && !showGuestError && !appearancePending
  const preloadPending = activePreload !== null && !activePreload.applied
  const guestHidden = appearancePending || preloadPending || remoteLoading || showGuestError
  const branch = !mounted ? 'service-wait' : showGuestError ? 'guest-error' : remoteLoading ? 'remote-loading' : appearancePending ? 'appearance-wait' : documentWaiting ? 'document-wait' : remoteMode ? 'remote-frame' : 'local-frame'
  useWatch([branch, harness.status, remoteMode, mounted, harness.serviceHealthy, harness.serviceRunning, harness.iframeKey, harness.iframeLoaded, harness.iframeAlive, harness.iframeError, harness.startupPhase, harness.busyAction, appearancePending, documentWaiting, guestHidden], () => {
    console.warn('[GuestWebview] view', {
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
      guestHidden,
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
    }).catch(error => console.warn('[GuestWebview] native frontend preload unavailable:', error))
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
  const appearanceKey = `${bootCss}#${appearancePayload.palette}#${appearancePayload.opacity}#${appearancePayload.blur}`
  useWatch(
    [frameSrc, appearanceKey],
    ([src]) => {
      if (!src)
        return
      postAppearance()
    },
    { immediate: true },
  )

  const pendingActionsRef = useRef(new Map<string, { payload: NotificationClickedPayload, timer: ReturnType<typeof setTimeout> }>())

  const [, setDshStyle] = useDshStyle()

  useSyncVisibility(guestRef)

  useZoomFactor(setting.zoom_factor)

  useEventListener('keydown', handleZoomKeyDown, { capture: true })

  useNotificationAction(handleNotificationAction)
  useNotificationClicked(handleNotificationClick)

  useListen('dsh://appearance:ready', () => {
    store.harness.markIframeAlive()
    postAppearance()
  })
  useListen('dsh://appearance:applied', () => {
    store.harness.markIframeAlive()
    setBootFrame(frameKey)
  })
  useListen<unknown>('dsh://style', (event: TauriEvent<unknown>) => {
    store.harness.markIframeAlive()
    setDshStyle(event.payload as Parameters<typeof setDshStyle>[0])
  })
  useListen<unknown>('dsh://zoom-shortcut', (event: TauriEvent<unknown>) => {
    store.harness.markIframeAlive()
    handleZoomShortcut(event.payload)
  })
  useListen('dsh://desktop-settings:open', () => {
    store.harness.markIframeAlive()
    openDesktopSettings()
  })

  const renderKey = `${remoteMode ? `remote-${srcOverride}` : activePreload?.id ?? 'http'}#${harness.iframeKey}`

  useGuestElementEvents(guestRef, renderKey, mounted, {
    onMessage: handleGuestMessage,
    onDomReady: handleGuestDomReady,
    onFinishLoad: handleGuestFinishLoad,
    onFailLoad: store.harness.markIframeError,
  })

  function post(message: WebviewOutboundMessage) {
    postToGuest(guestRef.current, message)
  }

  function postAppearance() {
    void emit('dsh://appearance', { appearance: appearancePayload })
  }

  function handleGuestDomReady() {
    store.harness.markIframeLoaded()
    postAppearance()
  }

  function handleGuestFinishLoad() {
    store.harness.markIframeLoaded()
    if (remoteMode)
      setLoadedUrl(srcOverride ?? '')
  }

  function handleGuestMessage(data: GuestBridgeMessage) {
    if (typeof data.type !== 'string')
      return
    emitGuestMessage(data)
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
        console.warn('[GuestWebview] native frontend preload failed; using live HTTP:', data.detail)
        fallbackPreload()
      }
      return
    }
    if (data.type === 'dsh://appearance:request' || data.type === 'dsh://plugin-boot:frame') {
      postAppearance()
      return
    }
    // issue #705：帧内导航后旧文档确认立刻作废，等新文档自报
    if (data.type === 'dsh://plugin-boot:leaving') {
      setBootFrame(null)
      armAppearanceFallback()
      store.harness.markIframeLeaving()
      return
    }
    // issue #705：任何协议消息都证明帧内跑着 dsh 页面，不是浏览器错误页
    store.harness.markIframeAlive()
    switch (data.type) {
      case 'dsh://native-notification':
        handleNativeNotification(data)
        break
      case 'dsh://clipboard-image:read':
        handleClipboardImageRead(data)
        break
      case 'dsh://clipboard-files:read':
        handleClipboardFilesRead(data)
        break
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
      case 'dsh://frame-log':
        handleFrameLog(data)
        break
    }
  }

  function handleZoomKeyDown(event: KeyboardEvent) {
    const action = zoomActionFromShortcut(event)
    if (!action)
      return
    event.preventDefault()
    void setting.zoom(action).catch(error => console.error('[Zoom] failed to save zoom:', error))
  }

  function openDesktopSettings() {
    void openConfigDialog({ tab: 'application' }).catch((error: unknown) => {
      if (!(error instanceof Error))
        return
      console.error('[GuestWebview] failed to open desktop settings:', error)
      toast(t('messages.open_settings_failed'), { variant: 'danger' })
    })
  }

  function handleNativeNotification(data: GuestBridgeMessage) {
    const actions = Array.isArray(data.actions) ? data.actions : []
    const hasActions = actions.length > 0
    const title = data.title ?? ''
    const body = data.body ?? ''

    void (async () => {
      if (!await ensureNotificationPermission())
        return
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
          console.warn('[notification] registerActionTypes failed, sending without actions:', error)
        }
      }
      try {
        await sendNotification({
          id: notificationIdFor(data.tag),
          title,
          body,
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

  function handleClipboardImageRead(data: GuestBridgeMessage) {
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

  function handleClipboardFilesRead(data: GuestBridgeMessage) {
    if (!data.id)
      return
    const reqId = data.id
    function reply(files: ClipboardFileEntry[], rejected: ClipboardFileRejection[]) {
      post({ type: 'dsh://clipboard-files:reply', id: reqId, files, rejected })
      // issue #1160：宿主读取侧的降级（超限/不可读/目录）由执行方提示
      if (rejected.length > 0) {
        const names = rejected.slice(0, 3).map(entry => entry.filename).join(', ')
        toast(
          t(files.length === 0 ? 'messages.clipboard_files_failed' : 'messages.clipboard_files_partial', {
            total: rejected.length,
            names,
          }),
          { variant: 'warning' },
        )
      }
    }
    void invoke<{ files?: ClipboardFileEntry[], rejected?: ClipboardFileRejection[] } | null>('read_clipboard_files')
      .then(result => reply(result?.files ?? [], result?.rejected ?? []))
      .catch((error) => {
        console.error('[clipboard-files] read_clipboard_files failed:', error)
        reply([], [])
      })
  }

  function handleZoomShortcut(payload: unknown) {
    const action = zoomActionFromPayload(payload)
    if (action)
      void setting.zoom(action).catch(error => console.error('[Zoom] failed to save zoom:', error))
  }

  function handleFrameLog(data: GuestBridgeMessage) {
    if (typeof data.message !== 'string' || data.message === '')
      return
    const level = data.level === 'error' ? 'error' : 'warn'
    void invoke('log_frontend', { level, target: 'guest', message: data.message.slice(0, 2048) })
      .catch(error => console.error('[frame-log] log_frontend failed:', error))
  }

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

  function deliverNotificationResult(payload: NotificationClickedPayload) {
    void emit('dsh://notification-clicked', {
      tag: payload.tag || undefined,
      action: payload.action || undefined,
      inputValue: payload.inputValue || undefined,
    })
  }

  function handleNotificationAction(event: NotificationActionEvent) {
    const { actionId, inputValue, notification, extra: payloadExtra } = event
    if (typeof actionId !== 'string' || actionId === '' || actionId === 'tap')
      return

    const extra = payloadExtra ?? notification?.extra
    const payload: NotificationClickedPayload = {
      sessionId: extra?.sessionId ?? null,
      title: extra?.title,
      tag: extra?.tag,
      action: actionId,
      inputValue: typeof inputValue === 'string' ? inputValue : null,
    }

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
    if (import.meta.env.DEV) {
      console.warn('[notification] action event:', payload.action, {
        tag: payload.tag ?? null,
        sessionId: payload.sessionId ?? null,
        inputLength: payload.inputValue?.length ?? 0,
      })
    }
    void deliverNotificationResult(payload)
  }

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
        <webview
          key={renderKey}
          ref={guestRef}
          data-testid="dsh-shell-webview"
          className="h-full w-full"
          style={{ visibility: guestHidden ? 'hidden' : 'visible' }}
          src={frameSrc}
          title={t('app.open_editor')}
        />
      </If>

      <If cond={!remoteMode && mounted && guestHidden && !showGuestError}>
        <div className="absolute inset-0 z-[1]">
          <Loadable subtitle={t(harness.startupStatusKey)} />
        </div>
      </If>

      <If cond={borderTint !== null}>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-[1]"
          style={borderTint !== null ? { boxShadow: `inset 0 0 0 2px ${borderTint}` } : undefined}
        />
      </If>

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
            <If cond={harness.iframeErrorHint !== ''}>
              <p className="text-xs leading-[18px] break-all text-load-muted">{harness.iframeErrorHint}</p>
            </If>
          </Loadable>
        </div>
      </If>
    </div>
  )
}
