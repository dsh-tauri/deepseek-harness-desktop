import type { Appearance } from '../../../../../packages/builtin-plugin-tauri/src/shared/appearance'
import type { DshShortcutRow, DshViewCommand } from '@/hooks/use-dsh-shortcuts'
import type { DshWebviewElement } from '@/types/webview'
import { useWatch } from '@reause/core'
import { invoke } from '@tauri-apps/api/core'
import { emit } from '@tauri-apps/api/event'
import { Effect, EffectState, getCurrentWindow } from '@tauri-apps/api/window'
import { type } from '@tauri-apps/plugin-os'
import { useEffect, useRef, useState } from 'react'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { DSH_VIEW_COMMANDS, shortcutHint, useDshShortcuts } from '@/hooks/use-dsh-shortcuts'
import { useDshStyle } from '@/hooks/use-dsh-style'
import { useListen } from '@/hooks/use-listen'
import { store } from '@/store'
import { Recovery } from '@/ui/plugin/recovery'
import { appearanceColors, appearanceSidebarFill, appearanceStartupFill, appearanceTranslucent, normalizeAppearance } from '../../../../../packages/builtin-plugin-tauri/src/shared/appearance'
import { FullSidebarNavbar } from './full-sidebar-navbar'
import { GuestWebview } from './iframe'
import { REMOTE_SECTION, REMOTE_TAB_ACCESS, REMOTE_TAB_MACHINES } from './nav-bridge'
import { Navbar } from './navbar'
import { Setup } from './setup'
import { PreinstallSetup } from './setup-preinstall'
import { useGuestMessage } from './webview-bridge'
import { isFullSidebarWindow } from './window-presentation'

const FULL_SIDEBAR_REVEAL_MS = 15_000

function shellAppearanceCss(appearance: Appearance, scheme: 'dark' | 'light', transparent: boolean): string {
  const alpha = transparent && appearance.transparency ? appearance.opacity : 100
  const backdropFilter = transparent && appearanceTranslucent(appearance) && appearance.blur ? 'blur(16px)' : 'none'
  if (appearance.palette === 'default' && alpha === 100 && !transparent)
    return ''
  const { canvas, panel, surface, text, muted, accent, border } = appearanceColors(appearance, scheme)
  return [
    alpha < 100 ? 'html,body,[data-testid="dsh-shell-root"]{background:transparent!important}' : '',
    `html[data-theme]{--color-canvas:${canvas};--color-startup:${appearanceStartupFill(appearance, canvas)};--color-panel:${panel};--color-panel-2:${surface};--color-ink:${text};--color-info:${accent};--foreground:${text};--muted:${muted};--background:${canvas};--surface:${panel};--surface-secondary:${surface};--surface-tertiary:${surface};${border ? `--color-line:${border};--color-line-strong:${border};--color-btn-border:${border};--border:${border};--separator:${border};--field-border:${border};` : ''}}`,
    `[data-testid="dsh-navbar-root"]{background:${appearanceSidebarFill(canvas, panel, alpha < 100, alpha)}!important;${backdropFilter === 'none' ? '' : `backdrop-filter:${backdropFilter};-webkit-backdrop-filter:${backdropFilter};`}}`,
    alpha < 100 && appearance.sidebarOnly ? `[data-testid="dsh-config-dialog"]{background:${panel}!important}` : '',
    '[data-testid="dsh-shell-root"]>main{background:transparent!important}',
  ].filter(Boolean).join('\n')
}

export function Webview() {
  const [fullSidebarRevealed, setFullSidebarRevealed] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const guestRef = useRef<DshWebviewElement | null>(null)
  const pendingSettingsTabRef = useRef<string | null>(null)
  const nativeEffectQueueRef = useRef(Promise.resolve())

  const [dshStyle] = useDshStyle()
  const [{ rows: shortcutRows }, setDshShortcuts] = useDshShortcuts()
  const setting = useStore(store.setting)

  const { status, serviceHealthy, serviceRunning, iframeKey, iframeLoaded, iframeAlive, iframeError, startupPhase, busyAction } = useStore(store.harness)
  const { recovery } = useStore(store.recovery)
  const [remoteView, setRemoteView] = useState({ url: '', tint: null as string | null })
  const activeTunnelUrl = remoteView.url
  const borderTint = remoteView.tint
  const remoteMode = activeTunnelUrl !== ''
  const live = status === 'ready' && (remoteMode || serviceHealthy)
  const branch = status === 'ready' ? 'guest' : status === 'preinstall' ? 'preinstall' : status === 'error' && recovery.required ? 'recovery' : 'setup'
  useWatch([branch, status, remoteMode, serviceHealthy, serviceRunning, iframeKey, iframeLoaded, iframeAlive, iframeError, startupPhase, busyAction], () => {
    console.warn('[Webview] shell view', {
      branch,
      status,
      remoteMode,
      serviceHealthy,
      serviceRunning,
      iframeKey,
      iframeLoaded,
      iframeAlive,
      iframeError,
      startupPhase,
      busyAction,
    })
  }, { immediate: true })

  const transparent = (window as Window & { __DSH_TRANSPARENT__?: boolean }).__DSH_TRANSPARENT__ === true
  const appearance = normalizeAppearance(setting.appearance)
  const scheme = dshStyle.colorScheme ?? (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')
  const appearanceCss = shellAppearanceCss(appearance, scheme, transparent)

  // keep:effect 原生背景效果只能经窗口 API 命令式设置/清除，串行化避免后发先至
  useWatch([setting.appearance, setting.hydrated], () => {
    if (!setting.hydrated || !transparent)
      return
    let platform: ReturnType<typeof type>
    try {
      platform = type()
    }
    catch {
      return
    }
    if (platform !== 'windows' && platform !== 'macos')
      return

    const appWindow = getCurrentWindow()
    nativeEffectQueueRef.current = nativeEffectQueueRef.current
      .then(() => appearance.transparency && appearance.blur
        ? appWindow.setEffects({
            effects: [Effect.Acrylic, Effect.Mica, Effect.UnderWindowBackground],
            state: EffectState.FollowsWindowActiveState,
          })
        : appWindow.clearEffects())
      .catch(error => console.warn('[Webview] native backdrop effect failed:', error))
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

  function openSettingsTab(tab: string) {
    void emit('dsh://settings:open', { section: REMOTE_SECTION, tab })
  }

  function openLocalSettingsTab(tab: string) {
    if (remoteMode) {
      pendingSettingsTabRef.current = tab
      handleRemoteChange('', null)
      return
    }
    openSettingsTab(tab)
  }

  useListen<{ collapsed?: unknown }>('dsh://sidebar:collapsed', ({ payload }) => {
    setSidebarCollapsed(Boolean(payload?.collapsed))
  })
  useListen<{ rows?: unknown }>('dsh://shortcuts', ({ payload }) => {
    setDshShortcuts({ rows: parseShortcutRows(payload?.rows) })
  })
  useListen('dsh://full-sidebar:ready', () => setFullSidebarRevealed(true))
  useListen('dsh://window:close', () => {
    void getCurrentWindow().close()
  })
  useGuestMessage((data) => {
    if (data.type !== 'dsh://plugin-boot:ready')
      return
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
        return (
          <GuestWebview
            guestRef={guestRef}
            srcOverride={remoteMode ? activeTunnelUrl : null}
            borderTint={borderTint}
          />
        )
      default:
        return <Setup />
    }
  }

  const fullSidebar = isFullSidebarWindow()

  // keep:effect 全屏形态窗口的兜底揭开计时器必须随卸载清除
  useEffect(() => {
    if (!fullSidebar || fullSidebarRevealed)
      return
    const timer = window.setTimeout(setFullSidebarRevealed, FULL_SIDEBAR_REVEAL_MS, true)
    return () => window.clearTimeout(timer)
  }, [fullSidebar, fullSidebarRevealed])

  const bridge = live
    ? {
        onToggleSidebar: () => void emit('dsh://sidebar:toggle'),
        onNewChat: () => void emit('dsh://session:new'),
        onOpenFolder: () => void emit('dsh://workspace:add'),
        onOpenShortcuts: () => void emit('dsh://shortcuts:open'),
        onViewCommand: (command: DshViewCommand) => void emit('dsh://view:command', { command }),
        onOpenMachineManager: () => openLocalSettingsTab(REMOTE_TAB_MACHINES),
        onOpenRemoteAccess: () => openLocalSettingsTab(REMOTE_TAB_ACCESS),
      }
    : {}

  return (
    <main className="relative flex flex-col min-h-0 flex-1" style={dshStyle.frame || {}}>
      <style>{appearanceCss}</style>
      <If
        cond={fullSidebar}
        then={<FullSidebarNavbar />}
        else={<Navbar onRemoteChange={handleRemoteChange} sidebarCollapsed={sidebarCollapsed} {...bridge} />}
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
