import type { DshShortcutRow, DshViewCommand } from '@/hooks/use-dsh-shortcuts'
import { useOverlay } from '@overlastic/react'
import { deepEqual, useMount, useWatch } from '@reause/core'
import { invoke } from '@tauri-apps/api/core'
import { emitTo } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { type } from '@tauri-apps/plugin-os'
import { useEffect, useRef, useState } from 'react'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { useAppearance } from '@/hooks/use-appearance'
import { DSH_VIEW_COMMANDS, shortcutHint, useDshShortcuts } from '@/hooks/use-dsh-shortcuts'
import { useDshStyle } from '@/hooks/use-dsh-style'
import { useListen } from '@/hooks/use-listen'
import { useNativeNotifications } from '@/hooks/use-native-notifications'
import { useNotificationAction } from '@/hooks/use-notification-action'
import { useNotificationClicked } from '@/hooks/use-notification-clicked'
import { store } from '@/store'
import { ConfigDialog } from '@/ui/dialog/config'
import { Recovery } from '@/ui/plugin/recovery'
import { isFullSidebarWindow, isHostedDocument, isHostedServiceDocument } from '@/utils/window-presentation'
import { HarnessContent } from './harness/content'
import { FullSidebarNavbar } from './navbar/full-sidebar-navbar'
import { Navbar } from './navbar/navbar'
import { PreinstallSetup } from './startup/preinstall'
import { Setup } from './startup/setup'

const REMOTE_SECTION = 'dsh-tauri-remote'
const REMOTE_TAB_MACHINES = 'machines'
const REMOTE_TAB_ACCESS = 'access'
const REMOTE_TAB_SYNC = 'sync'

const FULL_SIDEBAR_REVEAL_MS = 15_000

/** 壳层窗口组合：导航栏 + 启动/预装/恢复/Harness 内容分支。 */
export function Shell() {
  // 1. 数据查询 (Queries)
  const { status, serviceHealthy, webviewSrc, restartPending } = useStore(store.harness)
  const { recovery } = useStore(store.recovery)
  const [dshStyle, setDshStyle] = useDshStyle()
  const [{ rows: shortcutRows }, setDshShortcuts] = useDshShortcuts()
  const appearanceCss = useAppearance()
  const openConfigDialog = useOverlay(ConfigDialog)

  // 2. 本地用户选择状态
  const [fullSidebarRevealed, setFullSidebarRevealed] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [remoteView, setRemoteView] = useState({ url: '', tint: null as string | null })
  const pendingSettingsTabRef = useRef<string | null>(null)

  // 3. 远程视图数据 Query
  const activeTunnelUrl = remoteView.url
  const borderTint = remoteView.tint
  const remoteMode = activeTunnelUrl !== ''
  const live = status === 'ready' && (remoteMode || serviceHealthy || isHostedServiceDocument())
  const notificationSource = isHostedServiceDocument() ? location.origin : activeTunnelUrl || webviewSrc
  const notifications = useNativeNotifications(notificationSource)

  useNotificationAction(notifications.handleAction)
  useNotificationClicked(notifications.handleClick)
  useMount(() => {
    if (isHostedServiceDocument())
      store.harness.markHostedReady()
  })
  useListen<Parameters<typeof setDshStyle>[0]>('dsh://style', ({ payload }) => setDshStyle(payload))
  useListen('dsh://desktop-settings:open', () => {
    void openConfigDialog()
  })

  // keep:effect 主窗口文档即 DSH：本机服务就绪后把当前 webview 导航到 DSH 页面。
  // `serviceHealthy` 在启动收尾阶段会反复翻转，重复导航会互相打断（ERR_ABORTED），
  // 用 ref 记住已发起的地址，只在目标真正变化时再导航。
  const hostedNavigationRef = useRef<string | null>(null)
  useEffect(() => {
    if (!isHostedDocument() || remoteMode)
      return
    if (status !== 'ready' || !serviceHealthy || !webviewSrc)
      return
    if (isHostedServiceDocument() && new URL(webviewSrc).origin === location.origin && !restartPending)
      return
    if (hostedNavigationRef.current === webviewSrc)
      return
    hostedNavigationRef.current = webviewSrc
    void invoke('host_harness_document', { url: webviewSrc })
      .catch((error) => {
        hostedNavigationRef.current = null
        console.error('[Shell] host document failed:', error)
        store.harness.fail(String(error), undefined, undefined, undefined, store.harness.serviceRunning)
      })
  }, [status, serviceHealthy, webviewSrc, remoteMode, restartPending])

  function syncViewMenu() {
    if (type() !== 'macos')
      return
    void invoke('sync_view_menu', {
      entries: DSH_VIEW_COMMANDS.map(item => ({
        id: item.action,
        enabled: live && shortcutRows.some(row => row.id === item.command && row.available === true),
        shortcut: shortcutHint(shortcutRows, item.command) ?? null,
      })),
    }).catch(error => console.error('[Shell] failed to sync View menu:', error))
  }

  useWatch([shortcutRows, live], syncViewMenu, { immediate: true })
  useWatch(activeTunnelUrl, () => setDshShortcuts({ rows: [] }))
  useWatch(live, (ready) => {
    if (!ready)
      setDshShortcuts({ rows: [] })
  })
  useListen('tauri://focus', syncViewMenu, { target: getCurrentWindow().label })
  useListen('macos-menu-rebuilt', syncViewMenu, { target: getCurrentWindow().label })
  useListen<{ collapsed?: unknown }>('dsh://sidebar:collapsed', ({ payload }) => {
    setSidebarCollapsed(Boolean(payload.collapsed))
  })
  useListen<{ rows?: unknown }>('dsh://shortcuts', ({ payload }) => {
    const rows = parseShortcutRows(payload.rows)
    setDshShortcuts(previous => deepEqual(previous.rows, rows) ? previous : { rows })
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

  function handleRemoteChange(url: string, tint: string | null) {
    setRemoteView({ url, tint })
  }

  function openSettingsTab(tab: string) {
    void emitTo({ kind: 'Window', label: getCurrentWindow().label }, 'dsh://settings:open', { section: REMOTE_SECTION, tab })
  }

  // 远端视图下设置分区需先切回本机，等待插件就绪后再定位。
  function openLocalSettingsTab(tab: string) {
    if (remoteMode) {
      pendingSettingsTabRef.current = tab
      void invoke('navigate_remote_harness', { machineId: null }).catch(error => console.error('[remote] local settings navigation failed:', error))
      return
    }
    openSettingsTab(tab)
  }

  // 4. 派生数据提取
  const fullSidebar = isFullSidebarWindow()
  // IPC 失败此前完全静默（`void emitTo(...)` 丢弃了拒绝），界面上只剩「点了没反应」。
  // 统一走这里，失败时把事件名与原因打到控制台/日志，便于定位权限或目标错误。
  function broadcast(event: string, payload?: unknown) {
    void emitTo({ kind: 'Window', label: getCurrentWindow().label }, event, payload).catch((error) => {
      console.error(`[Shell] emit ${event} failed:`, error)
    })
  }
  const controls = live
    ? {
        onToggleSidebar: () => { broadcast('dsh://sidebar:toggle') },
        onNewChat: () => { broadcast('dsh://session:new') },
        onOpenFolder: () => { broadcast('dsh://workspace:add') },
        onOpenShortcuts: () => { broadcast('dsh://shortcuts:open') },
        onViewCommand: (command: DshViewCommand) => { broadcast('dsh://view:command', { command }) },
        onOpenMachineManager: () => openLocalSettingsTab(REMOTE_TAB_MACHINES),
        onOpenRemoteAccess: () => openLocalSettingsTab(REMOTE_TAB_ACCESS),
        onOpenSyncToRemote: () => openLocalSettingsTab(REMOTE_TAB_SYNC),
      }
    : {}

  // keep:effect 全屏形态窗口先盖住内容区，兜底超时后强制揭开，避免插件未就位时露出半成品。
  useEffect(() => {
    if (!fullSidebar || fullSidebarRevealed)
      return
    const timer = window.setTimeout(setFullSidebarRevealed, FULL_SIDEBAR_REVEAL_MS, true)
    return () => window.clearTimeout(timer)
  }, [fullSidebar, fullSidebarRevealed])

  // 文档即 DSH 时壳层根元素必须保持透明：`dshStyle.frame` 是 DSH 自己那层的外框底色，
  // 铺到壳层根元素上会糊住背后的文档，表现为整窗一片纯色。
  const frameStyle = isHostedServiceDocument() ? undefined : (dshStyle.frame || {})

  const passThrough = isHostedServiceDocument() && status === 'ready'

  return (
    <main
      className={`relative flex flex-col min-h-0 flex-1 ${passThrough ? 'pointer-events-none' : 'pointer-events-auto'}`}
      style={frameStyle}
    >
      {/* 启动页、预装引导与恢复页共用外观变量 */}
      <style>{appearanceCss}</style>
      <If
        cond={fullSidebar}
        then={<FullSidebarNavbar />}
        else={<Navbar onRemoteChange={handleRemoteChange} sidebarCollapsed={sidebarCollapsed} {...controls} />}
      />
      <div className="relative flex min-h-0 flex-1">
        {/* 内容分支：恢复页 / 预装 / Harness */}
        <If
          cond={status === 'error' && recovery.required}
          then={<Recovery fullScreen />}
          else={(
            <If
              cond={status === 'preinstall'}
              then={<PreinstallSetup />}
              else={(
                <If
                  cond={status === 'ready'}
                  then={<HarnessContent srcOverride={remoteMode ? activeTunnelUrl : null} borderTint={borderTint} />}
                  else={<Setup />}
                />
              )}
            />
          )}
        />
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
  return out.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
}
