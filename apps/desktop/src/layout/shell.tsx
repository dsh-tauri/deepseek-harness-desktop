import type { DshShortcutRow, DshViewCommand } from '@/hooks/use-dsh-shortcuts'
import { useOverlay } from '@overlastic/react'
import { useMount, useWatch } from '@reause/core'
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
  const { status, serviceHealthy, serviceRunning, webviewKey, webviewLoaded, webviewAlive, webviewError, webviewSrc, startupPhase, busyAction } = useStore(store.harness)
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
  // 文档即 DSH 时启动流程被跳过，`serviceHealthy` 停在初值 false；此时页面本身就是
  // 服务产物，直接视为可用，否则导航栏的切换/远程控件全部不渲染。
  // 文档即 DSH 时启动流程被跳过，`serviceHealthy` 可能停在初值；页面本身就是服务产物，
  // 直接视为可用。判据用 `isHostedDocument`：origin 精确匹配在带 token 或端口变化时会漏判，
  // `live` 变 false 会让左侧侧栏开关与远程/SSH 控件整块不渲染。
  const live = status === 'ready' && (remoteMode || serviceHealthy || isHostedDocument())
  const notificationSource = activeTunnelUrl || webviewSrc
  const notifications = useNativeNotifications(notificationSource)

  useNotificationAction(notifications.handleAction)
  useNotificationClicked(notifications.handleClick)
  // 文档即 DSH 时 `App` 里的 startup() 被跳过，runtime 状态会停在初值，内容分支与导航栏
  // 控件都进不到可用态；这里在渲染前把就绪态补齐。判据用 `isHostedDocument` 而非
  // origin 精确匹配——带 token 的导航或端口变化会让后者漏判，把已经就绪的界面打回启动页。
  useMount(() => {
    if (isHostedDocument())
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
    if (isHostedServiceDocument() || !isHostedDocument() || remoteMode)
      return
    if (status !== 'ready' || !serviceHealthy || !webviewSrc)
      return
    if (hostedNavigationRef.current === webviewSrc)
      return
    hostedNavigationRef.current = webviewSrc
    void invoke('host_harness_document', { url: webviewSrc })
      .catch((error) => {
        hostedNavigationRef.current = null
        console.error('[Shell] host document failed:', error)
      })
  }, [status, serviceHealthy, webviewSrc, remoteMode])

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

  const branch = status === 'ready' ? 'webview' : status === 'preinstall' ? 'preinstall' : status === 'error' && recovery.required ? 'recovery' : 'setup'
  // 传对象的 console.warn 会被前端 logger 序列化成 `[object Object]`，日志里等于没有信息；
  // 这里拼成一行纯文本，字段名与取值都直接可读。
  useWatch([branch, status, remoteMode, serviceHealthy, serviceRunning, webviewKey, webviewLoaded, webviewAlive, webviewError, startupPhase, busyAction], () => {
    console.warn(
      `[Shell] view branch=${branch} status=${status} remote=${remoteMode} healthy=${serviceHealthy}`
      + ` running=${serviceRunning} loaded=${webviewLoaded} alive=${webviewAlive}`
      + ` error=${webviewError} phase=${startupPhase} busy=${busyAction}`,
    )
  }, { immediate: true })

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
      handleRemoteChange('', null)
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

  return (
    <main className="relative flex flex-col min-h-0 flex-1" style={dshStyle.frame || {}}>
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
  return out
}
