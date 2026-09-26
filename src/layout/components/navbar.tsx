import type { DshPlugin } from '@/types'
import type { ConfigTab } from '@/ui/dialog/config'
import {
  ArrowRotateRight,
  Copy,
  LayoutSideContent,
  LayoutSideContentLeft,
  Minus,
  Square,
  Xmark,
} from '@gravity-ui/icons'
import { Button, Chip, Description, Dropdown, Label } from '@heroui/react'
import { useOverlay } from '@overlastic/react'
import { useQuery } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { cn } from 'tailwind-variants'
import { useStore } from 'valtio-define'
import { queryKeys } from '@/config/query-keys'
import { shortcutHint, useDshShortcuts } from '@/hooks/use-dsh-shortcuts'
import { useDshStyle } from '@/hooks/use-dsh-style'
import { useListen } from '@/hooks/use-listen'
import { store } from '@/store'
import { DesktopAboutDialog } from '@/ui/dialog/about'
import { ConfigDialog } from '@/ui/dialog/config'
import { DesktopUpdateDialog } from '@/ui/dialog/update'
import { writeClipboardText } from '@/utils/clipboard'
import { toast } from '@/utils/toast'
import { ConnectDialog } from './connect-dialog'
import { RemoteSwitcher } from './remote-switcher'

/**
 * 壳层窗口顶部导航栏（44px，常驻）：
 *
 *   [侧边栏(展开/收起)] [文件][运行][帮助] [ 空白拖拽区 ] [更新可用][本地/远端] [最小化][最大化][后台化(X)]
 *
 * - 侧边栏：经 postMessage 操控 iframe 内的 dsh 应用
 *   （`dsh://sidebar:toggle`，由 dsh-tauri 插件的 `client/register/sidebar.ts`
 *   （`ctx.layout.toggleSidebar`）执行）；折叠图标由 iframe 回报的
 *   `dsh://sidebar:collapsed` 同步。
 *   导航桥（收回报 + 发命令）在 `iframe.tsx` / `webview.tsx`，本组件只接收状态与回调：
 *   左侧控件只在「dsh-tauri 插件已启用（已安装）」且传入 `onToggleSidebar` 时渲染，
 *   原生桥缺席时控件没有可靠接收方，避免出现点了没反应的死按钮。
 * - 本地 / 远端：`RemoteSwitcher` 固定在右侧「更新可用」旁边，SSH 功能未启用时
 *   自身不渲染（见 `remote-switcher.tsx`）。
 * - 文件：新建窗口（Tauri 再开一个 webview）/ 新聊天、打开文件夹（经协议调用 dsh 官方
 *   「新建会话」「添加工作区」，接收方是 dsh-tauri 的 `client/register/navigation.ts`）/
 *   关闭（隐藏到托盘）/ 退出（完整退出）。两条依赖 iframe 的项在回调缺席时禁用。
 * - 运行：应用 / 档案 / 插件 / 核心，直接打开配置对话框并定位到对应面板
 *   （对话框与角标见 `ui/dialog/config.tsx`）；「应用」项右侧另挂一个快捷重启图标按钮，
 *   就地重启服务而不必先进面板。
 * - 帮助：运行日志 / 检查更新 / 关于 Desktop / 文档（系统浏览器打开官方文档站）。
 * - 空白拖拽区：Tauri 原生 `data-tauri-drag-region`（顶层文档直接生效），
 *   Windows/Linux 上双击切换最大化，macOS 上交由系统标题栏偏好。
 * - macOS：使用原生交通灯，红键后台化、黄键最小化、绿键进入原生全屏；
 *   普通窗口下导航栏左侧留出交通灯区域，原生全屏时整条导航栏收起。
 *   「文件」「帮助」在 macOS 上由原生菜单栏承载（见 `desktop/builder.rs` 的
 *   `install_macos_menu`），本组按钮不渲染。
 *   交通灯的纵向位置由 `src-tauri/src/desktop/builder.rs` 的 `SHELL_NAV_HEIGHT`
 *   推导（视觉圆心与栏内 flex 居中控件同线），与下面根元素的 `h-11` 是同一真值；两者的一致性
 *   由 Rust 测试 `shell_nav_height_matches_navbar_height_class` 守住——改这个
 *   class 就必须同步那个常量，否则 CI 失败（issue #524）。
 * - Windows/Linux：右侧窗口按钮直接调用 Tauri API；
 *   最大化的字形随窗口状态在「最大化 / 还原」间切换（`useMaximized` 订阅 `onResized`，
 *   因此按钮、拖拽区双击、Win+↑ 等任何原生路径都同步），后台化 = 隐藏到托盘（服务保持运行）。
 *
 * 未传入 onToggleSidebar（安装/错误/预装引导页，无 iframe 可操控）时
 * 只渲染窗口控制与不依赖 iframe 的菜单项。
 */

/**
 * dsh-tauri 插件 id：安装后 iframe 内提供侧边栏切换与折叠状态回报
 *  （`client/register/sidebar.ts`；插件增删即时生效：与「插件」面板共用同一份
 *  查询缓存，缓存由根布局订阅 `dsh-plugins-updated` 写入）
 */
const TAURI_PLUGIN_ID = 'dsh-tauri'

/** 官方文档站点（帮助 → 文档）。 */
const DOCS_URL = 'https://dshtauri.mintlify.site'

/** 「文件」菜单的动作 id（宿主侧统一分发，避免菜单项内散落逻辑）。 */
type FileAction = 'new-window' | 'new-chat' | 'open-folder' | 'close' | 'quit'

/**
 * 「编辑」菜单项：`dsh://edit` 的 action 与平台加速键（macOS 用 ⌘，与官方桌面端一致）。
 */
const EDIT_ITEMS = [
  { id: 'undo', labelKey: 'menu.undo', key: 'Z', shift: false },
  { id: 'redo', labelKey: 'menu.redo', key: 'Z', shift: true },
  { id: 'cut', labelKey: 'menu.cut', key: 'X', shift: false },
  { id: 'copy', labelKey: 'menu.copy', key: 'C', shift: false },
  { id: 'paste', labelKey: 'menu.paste', key: 'V', shift: false },
  { id: 'selectAll', labelKey: 'menu.select_all', key: 'A', shift: false },
] as const

/** 「帮助」菜单的动作 id。 */
type HelpAction = 'keyboard-shortcuts' | 'copy-run-logs' | 'check-update' | 'about' | 'documentation'

/** 「运行」菜单项：直接打开配置对话框并定位到对应面板。 */
const CONFIG_TABS: { id: ConfigTab, labelKey: string }[] = [
  { id: 'application', labelKey: 'config.application' },
  { id: 'profiles', labelKey: 'config.profiles' },
  { id: 'plugins', labelKey: 'config.plugins' },
  { id: 'harness', labelKey: 'config.harness' },
]

/** WKWebView 的 macOS UA 稳定包含 Macintosh，用于切换平台原生窗口 chrome。 */
function detectMacOS() {
  return navigator.userAgent.includes('Macintosh')
}

const IS_MACOS = detectMacOS()

/** macOS 原生全屏时收起整条壳层导航栏。 */
function useMacOSFullscreen() {
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    if (!IS_MACOS)
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
  }, [])

  return isFullscreen
}

/** 最大化状态：Windows/Linux 自绘的最大化按钮据此在「最大化 / 还原」字形间切换（issue #673）。 */
function useMaximized() {
  const [isMaximized, setIsMaximized] = useState(false)

  // keep:effect 显式注册/注销原生窗口 onResized 订阅（@reause/core 不覆盖窗口事件）
  useEffect(() => {
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
  }, [])

  return isMaximized
}

/** 菜单项：左侧文案 + 右侧按键提示；没有生效绑定时只渲染文案（布局不变）。 */
function ShortcutLabel({ label, hint }: { label: string, hint?: string }) {
  if (hint == null)
    return <Label>{label}</Label>
  return (
    <span className="flex w-full items-center justify-between gap-6">
      <Label>{label}</Label>
      <span className="shrink-0 font-mono text-xs text-muted" data-testid="dsh-navbar-shortcut-hint">{hint.replaceAll(' ', '')}</span>
    </span>
  )
}

/** 编辑菜单的加速键文本：macOS 用 ⌘，其余平台用 Ctrl（与官方桌面端同一组）。 */
function editAccelerator(key: string, shift: boolean): string {
  if (IS_MACOS)
    return `⌘${shift ? '⇧' : ''}${key}`
  return `Ctrl+${shift ? 'Shift+' : ''}${key}`
}

export interface NavbarProps { /** iframe 回报的 dsh 侧边栏折叠状态（导航桥逻辑在 `iframe.tsx`） */
  sidebarCollapsed?: boolean
  /** 切换 iframe 内 dsh 侧边栏（向 iframe 发 `dsh://sidebar:toggle`）；传入时启用左侧导航控制 */
  onToggleSidebar?: () => void
  /** 新聊天：向 iframe 发 `dsh://session:new`（dsh 官方「新建会话」）；传入时该项可用 */
  onNewChat?: () => void
  /** 管理机器：向 iframe 发 `dsh://settings:open` 定位 SSH 分区（统一到设置页） */
  onOpenMachineManager?: () => void
  /** 同步到远端：向 iframe 发 `dsh://settings:open` 定位同步分区（与机器管理同级） */
  onOpenSyncToRemote?: () => void
  /** 打开文件夹：向 iframe 发 `dsh://workspace:add`（dsh 官方「添加工作区」）；传入时该项可用 */
  onOpenFolder?: () => void
  /** 编辑菜单动作：向 iframe 发 `dsh://edit`（dsh-tauri 的 `client/register/shortcuts.ts` 执行） */
  onEditAction?: (action: string) => void
  /** 显示键盘快捷键：向 iframe 发 `dsh://shortcuts:open`，弹官方 `shortcuts.open` 弹层（官方蒙版） */
  onOpenShortcuts?: () => void
}

export function Navbar({ sidebarCollapsed = false, onToggleSidebar, onNewChat, onOpenFolder, onEditAction, onOpenShortcuts, onOpenMachineManager, onOpenSyncToRemote }: NavbarProps) {
  const { t } = useTranslation()
  const isFullscreen = useMacOSFullscreen()
  const isMaximized = useMaximized()
  // 只读取「dsh-tauri 插件是否已安装」；查询键与「插件」面板共用（同一份缓存），
  // 挂载时自动拉取，服务重启 / 插件操作后的失效由 store 与该缓存同步共同保证。
  const { data: plugins = [] } = useQuery({
    queryKey: queryKeys.plugins,
    queryFn: () => invoke<DshPlugin[]>('get_dsh_plugins'),
  })
  const { updateInfo } = useStore(store.desktopUpdater)
  const [dshStyle] = useDshStyle()
  const [{ rows: shortcutRows }] = useDshShortcuts()
  // 「运行」菜单受控开合：快捷重启按钮不是菜单项，走不到 React Aria 的
  // 「项选中即收起」，收起得自己来，否则重启期间菜单会一直挂在新页面上。
  const [runMenuOpen, setRunMenuOpen] = useState(false)

  const openConfigDialog = useOverlay(ConfigDialog)
  const openAboutDialog = useOverlay(DesktopAboutDialog)
  const openUpdateDialog = useOverlay(DesktopUpdateDialog)

  // 仅当 dsh-tauri 插件启用（已安装）时显示左侧导航控件
  const tauriEnabled = plugins.some(plugin => plugin.id === TAURI_PLUGIN_ID)
  function handleWindowAction(action: 'minimize' | 'maximize' | 'background') {
    const appWindow = getCurrentWindow()
    switch (action) {
      case 'minimize':
        void appWindow.minimize()
        break
      case 'maximize':
        void appWindow.toggleMaximize()
        break
      case 'background':
        // 后台化：隐藏窗口到托盘（与关闭按钮行为一致，服务保持运行）
        void appWindow.hide()
        break
    }
  }

  function onDragRegionPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    // data-tauri-drag-region 原生只监听鼠标事件（mousedown/mouseup），
    // 触摸屏/笔输入不会触发原生拖拽（见 tauri#13762）。
    // 这里对非鼠标输入手动调用 startDragging 进入系统边拖边跟随。
    if (event.pointerType === 'mouse')
      return
    // 阻止浏览器生成兼容鼠标事件，避免与 data-tauri-drag-region 的原生拖拽重复触发。
    event.preventDefault()
    void getCurrentWindow().startDragging()
  }

  function onHelpAction(key: HelpAction) {
    if (key === 'check-update')
      void handleCheckUpdate()
    else if (key === 'about')
      void openAboutDialog().catch(() => { })
    else if (key === 'copy-run-logs')
      void copyRunLogs()
    else if (key === 'documentation')
      void openDocumentation()
    else if (key === 'keyboard-shortcuts')
      onOpenShortcuts?.()
  }

  function handleFileAction(key: FileAction) {
    switch (key) {
      case 'new-window':
        void createWindow()
        break
      case 'new-chat':
        onNewChat?.()
        break
      case 'open-folder':
        onOpenFolder?.()
        break
      case 'close':
        // 关闭 = 隐藏窗口到托盘（与右上角关闭按钮同语义，服务保持运行）
        handleWindowAction('background')
        break
      case 'quit':
        void quitApp()
        break
    }
  }

  /** 新建窗口：Rust 侧再开一个同源 webview（异步命令，建窗必须在异步运行时） */
  async function createWindow() {
    try {
      await invoke('create_app_window')
    }
    catch (error) {
      console.error('[Navbar] failed to create window:', error)
    }
  }

  /** 退出应用：与托盘「退出」同语义（完整退出，触发服务回收与窗口几何保存） */
  async function quitApp() {
    try {
      await invoke('quit_app')
    }
    catch (error) {
      console.error('[Navbar] failed to quit app:', error)
    }
  }

  /** 帮助 → 文档：交给系统浏览器打开官方文档站 */
  async function openDocumentation() {
    try {
      await invoke('open_external_url', { url: DOCS_URL })
    }
    catch (error) {
      console.error('[Navbar] failed to open documentation:', error)
    }
  }

  function handleOpenConfig(tab?: ConfigTab) {
    void openConfigDialog({ tab }).catch(() => { })
  }

  /** 「应用」项右侧的快捷重启：收起菜单再重启服务（与 macOS 原生菜单「重启」同一入口） */
  function handleQuickRestart() {
    setRunMenuOpen(false)
    void store.harness.restart()
  }

  function handleOpenAbout() {
    void openAboutDialog().catch(() => { })
  }

  /** 「更新可用」chip：与帮助菜单「检查更新」打开同一个更新对话框 */
  function handleOpenUpdateDialog() {
    void openUpdateDialog().catch(() => { })
  }

  /** 「检查更新」：先检查，有更新才弹框；检查失败提示错误而非「已是最新」 */
  async function handleCheckUpdate() {
    try {
      const info = await store.desktopUpdater.check()
      if (info)
        handleOpenUpdateDialog()
      else
        toast(t('update.up_to_date'), {})
    }
    catch (err) {
      console.warn('[Navbar] check update failed:', err)
      toast(t('update.check_failed'), { variant: 'danger' })
    }
  }

  async function copyRunLogs() {
    try {
      const logs = await invoke<string>('read_run_logs')
      // 成功/失败提示由 writeClipboardText 统一给出，这里只记录日志
      await writeClipboardText(logs, t('messages.logs_copied'))
    }
    catch (err) {
      console.error('[Navbar] failed to copy run logs:', err)
    }
  }

  // macOS 原生菜单 → 复用壳层已有操作；非 macOS 无原生菜单，直接忽略事件。
  // （useListen 内部把回调放在 ref 转发，这里读到的始终是最新的处理函数。）
  useListen<string>('macos-menu-action', (event) => {
    if (!IS_MACOS)
      return
    switch (event.payload) {
      case 'desktop-config':
        handleOpenConfig()
        break
      case 'desktop-about':
        handleOpenAbout()
        break
      case 'desktop-copy-run-logs':
        void copyRunLogs()
        break
      case 'desktop-check-update':
        void handleCheckUpdate()
        break
      case 'desktop-restart':
        void store.harness.restart()
        break
      case 'desktop-documentation':
        void openDocumentation()
        break
      case 'desktop-new-window':
        void createWindow()
        break
      case 'desktop-new-chat':
        onNewChat?.()
        break
      case 'desktop-open-folder':
        onOpenFolder?.()
        break
    }
  })

  return (
    <div
      className={cn(
        'relative flex h-11 w-full flex-none select-none items-center gap-0.5 bg-panel',
        {
          'hidden': IS_MACOS && isFullscreen,
          'pl-20 pr-1.5': IS_MACOS && !isFullscreen,
          'px-1.5': !IS_MACOS || isFullscreen,
        },
      )}
      style={{ background: dshStyle.sidebar?.background }}
      data-testid="dsh-navbar-root"
    >
      <If cond={onToggleSidebar != null && tauriEnabled}>
        <Button
          className="rounded-lg size-7"
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label={t(sidebarCollapsed ? 'nav.sidebar_expand' : 'nav.sidebar_collapse')}
          data-testid="dsh-navbar-sidebar-toggle"
          onPress={() => { onToggleSidebar?.() }}
        >
          <If
            cond={sidebarCollapsed}
            then={<LayoutSideContentLeft />}
            else={<LayoutSideContent />}
          />
        </Button>
      </If>
      <If cond={onToggleSidebar != null}>
        <ConnectDialog />
      </If>
      <If cond={!IS_MACOS}>
        <div className="ml-1">
          {/* 文件：新建窗口 / 新聊天 / 打开文件夹 / 关闭 / 退出。
              「新聊天」「打开文件夹」依赖 iframe 内的 dsh 服务（协议命令没有接收方
              时禁用而不是留着点了没反应的死按钮，与左侧侧边栏开关同一取舍）。 */}
          <Dropdown>
            <Button
              className="rounded-lg h-6 text-[12.5px] px-1.5"
              size="sm"
              variant="ghost"
              aria-label={t('menu.file')}
              data-testid="dsh-navbar-menu-file"
            >
              {t('menu.file')}
            </Button>
            <Dropdown.Popover className="rounded-md min-w-55" data-testid="dsh-navbar-menu-popover">
              <Dropdown.Menu>
                <Dropdown.Item
                  className="rounded-md"
                  id="new-window"
                  data-testid="dsh-navbar-item-new-window"
                  textValue={t('menu.new_window')}
                  onAction={() => handleFileAction('new-window')}
                >
                  <Label>{t('menu.new_window')}</Label>
                </Dropdown.Item>
                <Dropdown.Item
                  className="rounded-md"
                  id="new-chat"
                  data-testid="dsh-navbar-item-new-chat"
                  isDisabled={onNewChat == null}
                  textValue={t('menu.new_chat')}
                  onAction={() => handleFileAction('new-chat')}
                >
                  <ShortcutLabel label={t('menu.new_chat')} hint={shortcutHint(shortcutRows, 'session.new')} />
                </Dropdown.Item>
                <Dropdown.Item
                  className="rounded-md"
                  id="open-folder"
                  data-testid="dsh-navbar-item-open-folder"
                  isDisabled={onOpenFolder == null}
                  textValue={t('menu.open_folder')}
                  onAction={() => handleFileAction('open-folder')}
                >
                  <ShortcutLabel label={t('menu.open_folder')} hint={shortcutHint(shortcutRows, 'workspace.add')} />
                </Dropdown.Item>
                <Dropdown.Item
                  className="rounded-md"
                  id="close"
                  data-testid="dsh-navbar-item-close"
                  textValue={t('menu.close')}
                  onAction={() => handleFileAction('close')}
                >
                  <Label>{t('menu.close')}</Label>
                </Dropdown.Item>
                <Dropdown.Item
                  className="rounded-md"
                  id="quit"
                  data-testid="dsh-navbar-item-quit"
                  textValue={t('menu.quit')}
                  onAction={() => handleFileAction('quit')}
                >
                  <Label>{t('menu.quit')}</Label>
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
          {/* 「编辑」：与官方桌面端同一组编辑命令（撤销/重做/剪切/复制/粘贴/全选）。
              动作经 `dsh://edit` 交给 iframe 内的 dsh-tauri 插件在文档上执行，
              未安装插件（没有接收方）时整组禁用；加速键是系统/WebView 真实绑定，
              只作为提示（粘贴仍走原生快捷键，脚本无权读剪贴板）。 */}
          <Dropdown>
            <Button
              className="rounded-lg h-6 text-[12.5px] px-1.5"
              size="sm"
              variant="ghost"
              aria-label={t('menu.edit')}
              data-testid="dsh-navbar-menu-edit"
            >
              {t('menu.edit')}
            </Button>
            <Dropdown.Popover className="rounded-md min-w-55" data-testid="dsh-navbar-menu-popover">
              <Dropdown.Menu>
                {EDIT_ITEMS.map(item => (
                  <Dropdown.Item
                    key={item.id}
                    className="rounded-md"
                    id={item.id}
                    data-testid={`dsh-navbar-item-edit-${item.id}`}
                    isDisabled={onEditAction == null}
                    textValue={t(item.labelKey)}
                    onAction={() => onEditAction?.(item.id)}
                  >
                    <ShortcutLabel label={t(item.labelKey)} hint={editAccelerator(item.key, item.shift)} />
                  </Dropdown.Item>
                ))}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
          <Dropdown isOpen={runMenuOpen} onOpenChange={setRunMenuOpen}>
            {' '}
            <Button
              className="rounded-lg h-6 text-[12.5px] px-1.5"
              size="sm"
              variant="ghost"
              aria-label={t('menu.run')}
              data-testid="dsh-navbar-menu-config"
            >
              {t('menu.run')}
            </Button>
            <Dropdown.Popover className="rounded-md min-w-55" data-testid="dsh-navbar-menu-popover">
              <Dropdown.Menu>
                {CONFIG_TABS.map(item => (
                  <Dropdown.Item
                    key={item.id}
                    className="rounded-md"
                    id={item.id}
                    data-testid={`dsh-navbar-item-${item.id}`}
                    textValue={t(item.labelKey)}
                    onAction={() => handleOpenConfig(item.id)}
                  >
                    <div className="flex w-full items-center justify-between gap-2">
                      <Label>{t(item.labelKey)}</Label>
                      <If cond={item.id === 'application'}>
                        {/* 菜单项整行是 pressable，按钮外包一层专门拦冒泡：React Aria 的
                            pressable 只在 pointerdown / click 上收口，pointerup 会冒泡到菜单项，
                            被菜单项当成「按在别处、松手落在我身上」而自行补一次 click，
                            顺带把菜单项动作（打开配置面板）也触发了——所以 pointerup 必须在这里拦。 */}
                        <span
                          className="flex shrink-0 items-center"
                          onClick={event => event.stopPropagation()}
                          onPointerDown={event => event.stopPropagation()}
                          onPointerUp={event => event.stopPropagation()}
                        >
                          <Button
                            className="rounded-md size-6 hover:bg-background-tertiary"
                            isIconOnly
                            size="sm"
                            variant="ghost"
                            aria-label={t('app.restart')}
                            data-testid="dsh-navbar-item-application-restart"
                            onPress={handleQuickRestart}
                          >
                            <ArrowRotateRight className="size-3.5" />
                          </Button>
                        </span>
                      </If>
                    </div>
                  </Dropdown.Item>
                ))}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
          <Dropdown>
            <Button
              className="rounded-lg h-6 text-[12.5px] px-1.5"
              size="sm"
              variant="ghost"
              aria-label={t('app.help')}
              data-testid="dsh-navbar-menu-help"
            >
              {t('app.help')}
            </Button>
            <Dropdown.Popover className="rounded-md min-w-55" data-testid="dsh-navbar-menu-popover">
              <Dropdown.Menu>
                <Dropdown.Item
                  className="rounded-md"
                  id="keyboard-shortcuts"
                  data-testid="dsh-navbar-item-keyboard-shortcuts"
                  textValue={t('menu.keyboard_shortcuts')}
                  onAction={() => onHelpAction('keyboard-shortcuts')}
                >
                  <ShortcutLabel label={t('menu.keyboard_shortcuts')} hint={shortcutHint(shortcutRows, 'shortcuts.open')} />
                </Dropdown.Item>
                <Dropdown.Item
                  className="rounded-md"
                  id="copy-run-logs"
                  data-testid="dsh-navbar-item-copy-run-logs"
                  textValue={t('menu.run_logs')}
                  onAction={() => onHelpAction('copy-run-logs')}
                >
                  <Label>{t('menu.run_logs')}</Label>
                </Dropdown.Item>
                <Dropdown.Item
                  className="rounded-md"
                  id="check-update"
                  data-testid="dsh-navbar-item-check-update"
                  textValue={t('menu.check_update')}
                  onAction={() => onHelpAction('check-update')}
                >
                  <span className="flex w-full items-center justify-between gap-3">
                    <Label>{t('menu.check_update')}</Label>
                    <If cond={updateInfo != null}>
                      <Description>{t('menu.new_version')}</Description>
                    </If>
                  </span>
                </Dropdown.Item>
                <Dropdown.Item
                  className="rounded-md"
                  id="about"
                  data-testid="dsh-navbar-item-about"
                  textValue={t('menu.about')}
                  onAction={() => onHelpAction('about')}
                >
                  <Label>{t('menu.about')}</Label>
                </Dropdown.Item>
                <Dropdown.Item
                  className="rounded-md"
                  id="documentation"
                  data-testid="dsh-navbar-item-documentation"
                  textValue={t('menu.documentation')}
                  onAction={() => onHelpAction('documentation')}
                >
                  <Label>{t('menu.documentation')}</Label>
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        </div>
      </If>
      <If cond={import.meta.env.DEV}>
        <Chip size="sm" variant="primary" color="warning" className="text-xs text-background ml-1" data-testid="dsh-navbar-dev-chip">
          {t('app.dev_env')}
        </Chip>
      </If>

      {/* 拖拽区：Tauri 原生拖拽（仅此元素带 data-tauri-drag-region，按钮不受影响）。
           双击最大化同样由 Tauri 的 drag.js 原生处理（`internal_toggle_maximize`），
           网页侧不得再挂 onDoubleClick——两边各切一次会互相抵消（见 G-D02-5）。
           touch-none 让触摸被当作拖拽而非滚动/平移手势，配合 onPointerDown 支持触摸/笔。 */}
      <div
        className="min-w-0 flex-1 self-stretch touch-none"
        data-testid="dsh-navbar-drag-region"
        data-tauri-drag-region
        onPointerDown={onDragRegionPointerDown}
      />

      {/* 纯装饰：把 dsh 页面遮罩（`_mask_`）的底色/毛玻璃镜像到导航栏下沿，让两段观感连续。
          dsh 弹模态（如首次进入的 apiKey 对话框）时遮罩铺满，这一层就该盖住导航栏——
          壳层在 dsh 有模态期间不应可点，不要给它加 `pointer-events-none`。
          0.1.7-rc.2 起官方遮罩的底色落在 `::after` 并带入场淡入，镜像层随样式一起带上
          同参数的 `background` / `backdrop-filter` 过渡（见 `getOverlayMarkedStyle`）。 */}
      <div className="absolute" style={dshStyle.marked || {}} />

      {/* 「更新可用」chip：紧跟「帮助」右侧。检测到新版本即出现（安装包此时已在静默下载），
          点击进入更新对话框查看进度 / 打开已下载的安装包。macOS 的「帮助」在原生菜单栏，
          这里同样显示该 chip，保证三平台都有可见的更新入口。 */}
      <If cond={updateInfo != null}>
        <Chip
          color="success"
          size="sm"
          variant="soft"
          className="ml-1 cursor-pointer text-xs mr-1"
          onClick={handleOpenUpdateDialog}
        >
          {t('update.chip_available')}
        </Chip>
      </If>

      {/* 「本地」/ 远端机器切换器：SSH 功能启用后才出现（未启用时组件自身不渲染），
          位置固定在「更新可用」右侧，与左侧的文件/运行/帮助菜单分列两端。 */}
      <If cond={onToggleSidebar != null}>
        <RemoteSwitcher onManage={onOpenMachineManager} onSync={onOpenSyncToRemote} />
      </If>

      <If cond={!IS_MACOS}>
        <Button
          className="rounded-lg size-7"
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label={t('nav.minimize')}
          onPress={() => { handleWindowAction('minimize') }}
        >
          <Minus />
        </Button>

        <Button
          className="rounded-lg size-7"
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label={t(isMaximized ? 'nav.restore' : 'nav.maximize')}
          onPress={() => { handleWindowAction('maximize') }}
        >
          <If
            cond={isMaximized}
            then={<Copy style={{ width: 14, height: 14 }} />}
            else={<Square style={{ width: 14, height: 14 }} />}
          />
        </Button>

        <Button
          className="rounded-lg size-7 transition-colors enabled:hover:bg-danger/16 enabled:hover:text-danger"
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label={t('nav.background')}
          onPress={() => { handleWindowAction('background') }}
        >
          <Xmark />
        </Button>
      </If>
    </div>
  )
}
