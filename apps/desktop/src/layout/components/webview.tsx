import type { DshShortcutRow, DshViewCommand } from '@/hooks/use-dsh-shortcuts'
import type { NotificationActionEvent } from '@/hooks/use-notification-action'
import type { NotificationClickEvent } from '@/hooks/use-notification-clicked'
import { useOverlay } from '@overlastic/react'
import { useWatch } from '@reause/core'
import { invoke } from '@tauri-apps/api/core'
import { emitTo, listen } from '@tauri-apps/api/event'
import { getAllWindows, getCurrentWindow } from '@tauri-apps/api/window'
import { type } from '@tauri-apps/plugin-os'
import { useEffect, useRef, useState } from 'react'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { useAppearance } from '@/hooks/use-appearance'
import { DSH_VIEW_COMMANDS, shortcutHint, useDshShortcuts } from '@/hooks/use-dsh-shortcuts'
import { useDshStyle } from '@/hooks/use-dsh-style'
import { useListen } from '@/hooks/use-listen'
import { useNotificationAction } from '@/hooks/use-notification-action'
import { useNotificationClicked } from '@/hooks/use-notification-clicked'
import { store } from '@/store'
import { ConfigDialog } from '@/ui/dialog/config'
import { Recovery } from '@/ui/plugin/recovery'
import { FullSidebarNavbar } from './full-sidebar-navbar'
import { HarnessWebview } from './harness-webview'
import { HostedHarness } from './hosted-harness'
import { Navbar } from './navbar'
import { Setup } from './setup'
import { PreinstallSetup } from './setup-preinstall'
import { isFullSidebarWindow, isHostedDocument, isHostedServiceDocument } from './window-presentation'

const REMOTE_SECTION = 'dsh-tauri-remote'
const REMOTE_TAB_MACHINES = 'machines'
const REMOTE_TAB_ACCESS = 'access'
const REMOTE_TAB_SYNC = 'sync'

const FULL_SIDEBAR_REVEAL_MS = 15_000
interface NotificationResult {
  deliveryKey?: string
  tag?: string
  sessionId?: string
  sourceOrigin?: string
  action?: string
  inputValue?: string
}

export function Webview() {
  const [fullSidebarRevealed, setFullSidebarRevealed] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const pendingSettingsTabRef = useRef<string | null>(null)
  const pendingNativeNotificationsRef = useRef<({ click: NotificationClickEvent } | { action: NotificationActionEvent })[]>([])
  const notificationSourceRef = useRef('')
  const notificationQueueRef = useRef<NotificationResult[]>([])
  const pendingActionsRef = useRef(new Map<string, { payload: NotificationResult, timer: ReturnType<typeof setTimeout> }>())

  const [dshStyle, setDshStyle] = useDshStyle()
  const openConfigDialog = useOverlay(ConfigDialog)
  useListen<Parameters<typeof setDshStyle>[0]>('dsh://style', ({ payload }) => setDshStyle(payload))
  useListen('dsh://desktop-settings:open', () => {
    void openConfigDialog()
  })
  const [{ rows: shortcutRows }, setDshShortcuts] = useDshShortcuts()

  const { status, serviceHealthy, serviceRunning, webviewKey, webviewLoaded, webviewAlive, webviewError, webviewSrc, startupPhase, busyAction } = useStore(store.harness)
  const { recovery } = useStore(store.recovery)
  const [remoteView, setRemoteView] = useState({ url: '', tint: null as string | null })
  const activeTunnelUrl = remoteView.url
  const borderTint = remoteView.tint
  const remoteMode = activeTunnelUrl !== ''
  const live = status === 'ready' && (remoteMode || serviceHealthy)
  const appearanceCss = useAppearance()

  // keep:effect 主窗口文档即 DSH：本机服务就绪后把当前 webview 导航到 DSH 页面。
  useEffect(() => {
    if (isHostedServiceDocument() || !isHostedDocument() || remoteMode)
      return
    if (status !== 'ready' || !serviceHealthy || !webviewSrc)
      return
    void invoke('host_harness_document', { url: webviewSrc })
      .catch(error => console.error('[Webview] host document failed:', error))
  }, [status, serviceHealthy, webviewSrc, remoteMode])

  useWatch([activeTunnelUrl, webviewSrc], () => {
    const src = activeTunnelUrl || webviewSrc
    const origin = URL.canParse(src) ? new URL(src).origin : ''
    notificationSourceRef.current = origin
    window.localStorage.setItem(`dsh-notification-source:${getCurrentWindow().label}`, origin)
    if (origin) {
      for (const pending of pendingNativeNotificationsRef.current.splice(0)) {
        if ('click' in pending)
          void handleNotificationClick(pending.click)
        else
          void handleNotificationAction(pending.action)
      }
    }
  }, { immediate: true })

  useEffect(() => {
    const pending = pendingActionsRef.current
    return () => {
      pending.forEach(({ timer }) => clearTimeout(timer))
      pending.clear()
    }
  }, [])
  // keep:effect ready-request 必须在 ready 监听注册完成后发送，避免 guest 已就绪时漏掉握手。
  useEffect(() => {
    let disposed = false
    let flushing = false
    let unlisten: (() => void) | undefined
    const target = { kind: 'Window' as const, label: getCurrentWindow().label }
    void listen<{ sourceOrigin?: string }>('dsh://notification-ready', async ({ payload }) => {
      if (disposed || flushing || !payload?.sourceOrigin || payload.sourceOrigin !== notificationSourceRef.current)
        return
      flushing = true
      try {
        const queue = notificationQueueRef.current
        while (queue.length > 0) {
          const index = queue.findIndex(item => item.sourceOrigin === payload.sourceOrigin)
          if (disposed || index < 0 || payload.sourceOrigin !== notificationSourceRef.current)
            break
          await emitTo(target, 'dsh://notification-clicked', queue[index])
          queue.splice(index, 1)
        }
      }
      catch (error) {
        console.error('[notification] delivery failed:', error)
      }
      finally {
        flushing = false
      }
    }, { target }).then((off) => {
      if (disposed) {
        off()
      }
      else {
        unlisten = off
        void emitTo(target, 'dsh://notification-ready-request').catch(error => console.error('[notification] ready request failed:', error))
      }
    }).catch(error => console.error('[notification] ready listener failed:', error))
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])
  useNotificationAction(handleNotificationAction)
  useNotificationClicked(handleNotificationClick)
  const branch = status === 'ready' ? 'webview' : status === 'preinstall' ? 'preinstall' : status === 'error' && recovery.required ? 'recovery' : 'setup'
  useWatch([branch, status, remoteMode, serviceHealthy, serviceRunning, webviewKey, webviewLoaded, webviewAlive, webviewError, startupPhase, busyAction], () => {
    console.warn('[Webview] shell view', {
      branch,
      status,
      remoteMode,
      serviceHealthy,
      serviceRunning,
      webviewKey,
      webviewLoaded,
      webviewAlive,
      webviewError,
      startupPhase,
      busyAction,
    })
  }, { immediate: true })

  function syncViewMenu() {
    if (type() !== 'macos')
      return
    void invoke('sync_view_menu', {
      entries: DSH_VIEW_COMMANDS.map(item => ({
        id: item.action,
        enabled: live && shortcutRows.some(row => row.id === item.command && row.available === true),
        shortcut: shortcutHint(shortcutRows, item.command) ?? null,
      })),
    }).catch(error => console.error('[Webview] failed to sync View menu:', error))
  }

  useWatch([shortcutRows, live], syncViewMenu, { immediate: true })
  useWatch(activeTunnelUrl, () => setDshShortcuts({ rows: [] }))
  useWatch(live, (ready) => {
    if (!ready)
      setDshShortcuts({ rows: [] })
  })
  useListen('tauri://focus', syncViewMenu, { target: getCurrentWindow().label })
  useListen('macos-menu-rebuilt', syncViewMenu, { target: getCurrentWindow().label })

  function handleRemoteChange(url: string, tint: string | null) {
    setRemoteView({ url, tint })
  }

  function deliverNotificationResult(payload: NotificationResult) {
    notificationQueueRef.current.push(payload)
    void emitTo({ kind: 'Window', label: getCurrentWindow().label }, 'dsh://notification-ready-request').catch(error => console.error('[notification] ready request failed:', error))
  }

  async function ownsNotification(metadata?: { windowLabel?: string, sourceOrigin?: string } | null): Promise<boolean> {
    const { windowLabel, sourceOrigin } = metadata ?? {}
    const currentLabel = getCurrentWindow().label
    if (!sourceOrigin || sourceOrigin !== notificationSourceRef.current)
      return false
    if (windowLabel === currentLabel)
      return true
    try {
      const liveLabels = (await getAllWindows()).map(window => window.label)
      if (windowLabel && liveLabels.includes(windowLabel) && !window.localStorage.getItem(`dsh-notification-source:${windowLabel}`))
        return false
      const labels = liveLabels.filter(label => (label === 'main' || label.startsWith('window-') || label.startsWith('remote-')) && window.localStorage.getItem(`dsh-notification-source:${label}`) === sourceOrigin).sort()
      return (labels.includes(windowLabel ?? '') ? windowLabel : labels[0]) === currentLabel
    }
    catch (error) {
      console.error('[notification] window lookup failed:', error)
      return false
    }
  }

  async function handleNotificationAction(event: NotificationActionEvent) {
    if (!notificationSourceRef.current) {
      pendingNativeNotificationsRef.current.push({ action: event })
      return
    }
    const { actionId, inputValue, notification, extra } = event
    if (typeof actionId !== 'string' || actionId === '' || actionId === 'tap')
      return
    const metadata = extra ?? notification?.extra
    if (!await ownsNotification(metadata))
      return
    const payload = { tag: metadata?.tag, sessionId: metadata?.sessionId, deliveryKey: metadata?.deliveryKey, sourceOrigin: metadata?.sourceOrigin, action: actionId, inputValue: typeof inputValue === 'string' ? inputValue : undefined }
    const key = JSON.stringify([payload.tag, payload.deliveryKey, actionId])
    const queued = pendingActionsRef.current.get(key)
    if (queued) {
      clearTimeout(queued.timer)
      pendingActionsRef.current.delete(key)
      deliverNotificationResult({ ...queued.payload, ...payload, inputValue: payload.inputValue || queued.payload.inputValue })
      return
    }
    const timer = setTimeout(() => {
      pendingActionsRef.current.delete(key)
      deliverNotificationResult(payload)
    }, 250)
    pendingActionsRef.current.set(key, { payload, timer })
  }

  async function handleNotificationClick(event: NotificationClickEvent) {
    if (!notificationSourceRef.current) {
      pendingNativeNotificationsRef.current.push({ click: event })
      return
    }
    const { data } = event
    if (!await ownsNotification(data))
      return
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
    deliverNotificationResult({ tag: data?.tag, sessionId: data?.sessionId, sourceOrigin: data?.sourceOrigin })
  }

  function openSettingsTab(tab: string) {
    void emitTo({ kind: 'Window', label: getCurrentWindow().label }, 'dsh://settings:open', { section: REMOTE_SECTION, tab })
  }

  // 远端视图下设置分区需先切回本机，等待插件就绪后再定位。
  function openLocalSettingsTab(tab: string) {
    if (remoteMode) {
      pendingSettingsTabRef.current = tab
      handleRemoteChange('', null)
      return
    }
    openSettingsTab(tab)
  }

  useListen<{ collapsed?: unknown }>('dsh://sidebar:collapsed', ({ payload }) => {
    setSidebarCollapsed(Boolean(payload.collapsed))
  })
  useListen<{ rows?: unknown }>('dsh://shortcuts', ({ payload }) => {
    setDshShortcuts({ rows: parseShortcutRows(payload.rows) })
  })
  useListen<void>('dsh://full-sidebar:ready', () => setFullSidebarRevealed(true))
  useListen<void>('dsh://window:close', () => {
    void getCurrentWindow().close()
  })
  useListen<void>('dsh://appearance:ready', () => {
    const pending = pendingSettingsTabRef.current
    if (pending !== null) {
      pendingSettingsTabRef.current = null
      openSettingsTab(pending)
    }
  })

  const renderContent = () => {
    switch (status) {
      case 'error':
        return (
          <If cond={recovery.required} else={<Setup />}>
            <Recovery fullScreen />
          </If>
        )
      case 'preinstall':
        return <PreinstallSetup />
      case 'ready':
        return isHostedDocument()
          ? <HostedHarness />
          : (
              <HarnessWebview
                srcOverride={remoteMode ? activeTunnelUrl : null}
                borderTint={borderTint}
              />
            )
      default:
        return <Setup />
    }
  }

  // 窗口形态在进程内不会变：建窗时注入一次载荷，这里读一次就够。
  const fullSidebar = isFullSidebarWindow()

  // 全屏形态窗口先盖住内容区：插件在帧内就位前不露半成品 chrome，兜底超时后强制揭开。
  useEffect(() => {
    if (!fullSidebar || fullSidebarRevealed)
      return
    const timer = window.setTimeout(setFullSidebarRevealed, FULL_SIDEBAR_REVEAL_MS, true)
    return () => window.clearTimeout(timer)
  }, [fullSidebar, fullSidebarRevealed])

  const controls = live
    ? {
        onToggleSidebar: () => { void emitTo({ kind: 'Window', label: getCurrentWindow().label }, 'dsh://sidebar:toggle') },
        onNewChat: () => { void emitTo({ kind: 'Window', label: getCurrentWindow().label }, 'dsh://session:new') },
        onOpenFolder: () => { void emitTo({ kind: 'Window', label: getCurrentWindow().label }, 'dsh://workspace:add') },
        onOpenShortcuts: () => { void emitTo({ kind: 'Window', label: getCurrentWindow().label }, 'dsh://shortcuts:open') },
        onViewCommand: (command: DshViewCommand) => { void emitTo({ kind: 'Window', label: getCurrentWindow().label }, 'dsh://view:command', { command }) },
        onOpenMachineManager: () => openLocalSettingsTab(REMOTE_TAB_MACHINES),
        onOpenRemoteAccess: () => openLocalSettingsTab(REMOTE_TAB_ACCESS),
        onOpenSyncToRemote: () => openLocalSettingsTab(REMOTE_TAB_SYNC),
      }
    : {}

  return (
    <main className="relative flex flex-col min-h-0 flex-1" style={dshStyle.frame || {}}>
      {/* 启动页、预装引导与恢复页共用外观变量。 */}
      <style>{appearanceCss}</style>
      <If
        cond={fullSidebar}
        then={<FullSidebarNavbar />}
        else={<Navbar onRemoteChange={handleRemoteChange} sidebarCollapsed={sidebarCollapsed} {...controls} />}
      />
      <div className="relative flex min-h-0 flex-1">
        {renderContent()}
        <If cond={fullSidebar && !fullSidebarRevealed && status === 'ready'}>
          <div className="absolute inset-0 z-10" data-testid="dsh-full-sidebar-cover" style={{ background: dshStyle.sidebar?.background }} />
        </If>
      </div>
    </main>
  )
}

function parseShortcutRows(rows: unknown): DshShortcutRow[] {
  if (!Array.isArray(rows))
    return []
  const out: DshShortcutRow[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null)
      continue
    const entry = row as { id?: unknown, label?: unknown, keys?: unknown, aria?: unknown, available?: unknown }
    if (typeof entry.id !== 'string' || typeof entry.label !== 'string')
      continue
    out.push({
      id: entry.id,
      label: entry.label,
      keys: Array.isArray(entry.keys) ? entry.keys.filter((key): key is string => typeof key === 'string') : [],
      ...typeof entry.aria === 'string' ? { aria: entry.aria } : {},
      available: entry.available === true,
    })
  }
  return out
}
