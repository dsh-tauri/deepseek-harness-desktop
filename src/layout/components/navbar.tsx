import type { DshViewCommand } from '@/hooks/use-dsh-shortcuts'
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
import { Button, Chip, Description, Dropdown, Label, Separator } from '@heroui/react'
import { useOverlay } from '@overlastic/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getIdentifier } from '@tauri-apps/api/app'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Fragment, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Else, If, Then } from 'react-if-lite'
import { cn } from 'tailwind-variants'
import { useStore } from 'valtio-define'
import { queryKeys } from '@/config/query-keys'
import { DSH_VIEW_COMMANDS, shortcutHint, useDshShortcuts } from '@/hooks/use-dsh-shortcuts'
import { useDshStyle } from '@/hooks/use-dsh-style'
import { useListen } from '@/hooks/use-listen'
import { store } from '@/store'
import { DesktopAboutDialog } from '@/ui/dialog/about'
import { ConfigDialog } from '@/ui/dialog/config'
import { TaskManagerDialog } from '@/ui/dialog/task-manager'
import { DesktopUpdateDialog } from '@/ui/dialog/update'
import { writeClipboardText } from '@/utils/clipboard'
import { toast } from '@/utils/toast'
import { RemoteSwitcher } from './remote-switcher'

/**
 * 壳层窗口顶部导航栏（44px，常驻）：
 *
 *   [侧边栏(展开/收起)] [文件][运行][帮助][更新可用] [ 空白拖拽区 ] [本地/远端] [最小化][最大化][后台化(X)]
 *
 * - 侧边栏：经 postMessage 操控 iframe 内的 dsh 应用
 *   （`dsh://sidebar:toggle`，由 dsh-tauri 插件的 `client/register/sidebar.ts`
 *   （`ctx.layout.toggleSidebar`）执行）；折叠图标由 iframe 回报的
 *   `dsh://sidebar:collapsed` 同步。
 *   导航桥（收回报 + 发命令）在 `iframe.tsx` / `webview.tsx`，本组件只接收状态与回调：
 *   左侧控件只在「dsh-tauri 插件已启用（已安装）」且传入 `onToggleSidebar` 时渲染，
 *   原生桥缺席时控件没有可靠接收方，避免出现点了没反应的死按钮。
 * - 本地 / 远端：`RemoteSwitcher` 固定在右侧，SSH 功能未启用时
 *   自身不渲染（见 `remote-switcher.tsx`）；macOS 上其左侧是「更新可用」chip。
 * - 文件：新建窗口（Tauri 再开一个 webview）/ 新聊天、打开文件夹（经协议调用 dsh 官方
 *   「新建会话」「添加工作区」，接收方是 dsh-tauri 的 `client/register/navigation.ts`）/
 *   关闭（隐藏到托盘）/ 退出（完整退出）。两条依赖 iframe 的项在回调缺席时禁用。
 * - 运行：应用 / 档案 / 插件 / 核心，直接打开配置对话框并定位到对应面板
 *   （对话框与角标见 `ui/dialog/config.tsx`）；「应用」项右侧另挂一个快捷重启图标按钮，
 *   就地重启服务而不必先进面板。
 * - 帮助：运行日志 / 检查更新 / 关于 Desktop / 文档（系统浏览器打开官方文档站）。
 * - 更新可用：检测到新版本即出现在「帮助」右侧（安装包此时已在静默下载），
 *   点击打开更新对话框；macOS 的「帮助」在原生菜单栏，chip 落到右侧控件区。
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

const APP_IDENTIFIER_QUERY = {
  queryKey: queryKeys.appIdentifier,
  queryFn: getIdentifier,
  staleTime: Infinity,
}

const HELP_LINKS = {
  'documentation': 'https://dshtauri.mintlify.site',
  'desktop-feedback': 'https://github.com/dsh-tauri/deepseek-harness-desktop/issues',
  'harness-feedback': 'https://trtgsjkv6r.feishu.cn/share/base/form/shrcnlCoGElW7MQznGy9r3YYXcg?hide_uid=1&hide_device_info=1&hide_harness_version=1',
}

/** 「文件」菜单的动作 id（宿主侧统一分发，避免菜单项内散落逻辑）。 */
type FileAction = 'new-window' | 'new-chat' | 'open-folder' | 'close' | 'quit'

/** 「帮助」菜单的动作 id。 */
type HelpAction = 'toggle-devtools' | 'task-manager' | 'keyboard-shortcuts' | 'copy-run-logs' | 'check-update' | 'about' | keyof typeof HELP_LINKS

/** 「运行」菜单项：直接打开配置对话框并定位到对应面板。 */
const CONFIG_TABS = [
  { id: 'application', labelKey: 'config.application' },
  { id: 'appearance', labelKey: 'config.appearance' },
  { id: 'profiles', labelKey: 'config.profiles' },
  { id: 'plugins', labelKey: 'config.plugins' },
  { id: 'harness', labelKey: 'config.harness' },
  { id: 'dataDir', labelKey: 'config.dataDir' },
] as const

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

export interface NavbarProps {
  onRemoteChange: (url: string, tint: string | null) => void
  /** iframe 回报的 dsh 侧边栏折叠状态（导航桥逻辑在 `iframe.tsx`） */
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
  /** 显示键盘快捷键：向 iframe 发 `dsh://shortcuts:open`，弹官方 `shortcuts.open` 弹层（官方蒙版）；传入时该项可用 */
  onOpenShortcuts?: () => void
  onViewCommand?: (command: DshViewCommand) => void
}

export function Navbar({ onRemoteChange, sidebarCollapsed = false, onToggleSidebar, onNewChat, onOpenFolder, onOpenShortcuts, onViewCommand, onOpenMachineManager, onOpenSyncToRemote }: NavbarProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const isFullscreen = useMacOSFullscreen()
  const isMaximized = useMaximized()
  const { data: appIdentifier } = useQuery(APP_IDENTIFIER_QUERY)
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
  const openTaskManager = useOverlay(TaskManagerDialog)
  const openAboutDialog = useOverlay(DesktopAboutDialog)
  const openUpdateDialog = useOverlay(DesktopUpdateDialog)

  // 仅当 dsh-tauri 插件启用（已安装）时显示左侧导航控件
  const tauriEnabled = plugins.some(plugin => plugin.id === TAURI_PLUGIN_ID)
  const isNightly = appIdentifier === 'dsh-tauri-nightly'
  const showUpdateAvailable = appIdentifier != null && !isNightly && updateInfo != null
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
    if (key === 'toggle-devtools')
      void toggleDevtools()
    else if (key === 'task-manager')
      void openTaskManager().catch(() => { })
    else if (key === 'check-update')
      void handleCheckUpdate()
    else if (key === 'about')
      void openAboutDialog().catch(() => { })
    else if (key === 'copy-run-logs')
      void copyRunLogs()
    else if (key === 'documentation' || key === 'desktop-feedback' || key === 'harness-feedback')
      void openHelpLink(key)
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

  /** 切换开发者工具：Rust 侧就近作用于调用窗口（Windows 上只能反复打开，无法关闭检查器） */
  async function toggleDevtools() {
    try {
      await invoke('toggle_devtools')
    }
    catch (error) {
      console.error('[Navbar] failed to toggle devtools:', error)
    }
  }

  async function openHelpLink(key: keyof typeof HELP_LINKS) {
    try {
      await invoke('open_external_url', { url: HELP_LINKS[key] })
    }
    catch (error) {
      console.error(`[Navbar] failed to open ${key}:`, error)
      toast(t('messages.open_link_failed'), {
        variant: 'danger',
        description: <span className="break-all">{HELP_LINKS[key]}</span>,
        timeout: 10_000,
        actionProps: {
          children: t('buttons.copy_link'),
          onPress: () => {
            void writeClipboardText(HELP_LINKS[key], t('messages.copy_success'))
              .catch(copyError => console.error('[Navbar] failed to copy help link:', copyError))
          },
        },
      })
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
      const identifier = await queryClient.ensureQueryData(APP_IDENTIFIER_QUERY)
      if (identifier === 'dsh-tauri-nightly') {
        await invoke('open_external_url', { url: 'https://github.com/dsh-tauri/deepseek-harness-desktop/releases/tag/nightly' })
        return
      }
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

  useListen<string>('macos-menu-action', (event) => {
    if (!IS_MACOS)
      return
    const viewCommand = DSH_VIEW_COMMANDS.find(item => item.action === event.payload)
    if (viewCommand) {
      onViewCommand?.(viewCommand.command)
      return
    }
    switch (event.payload) {
      case 'desktop-zoom-in':
        store.setting.zoom('increase')
        break
      case 'desktop-zoom-out':
        store.setting.zoom('decrease')
        break
      case 'desktop-zoom-reset':
        store.setting.zoom('reset')
        break
      case 'desktop-config':
        handleOpenConfig('application')
        break
      case 'desktop-profiles':
        handleOpenConfig('profiles')
        break
      case 'desktop-plugins':
        handleOpenConfig('plugins')
        break
      case 'desktop-harness':
        handleOpenConfig('harness')
        break
      case 'desktop-about':
        handleOpenAbout()
        break
      case 'desktop-toggle-devtools':
        void toggleDevtools()
        break
      case 'desktop-task-manager':
        onHelpAction('task-manager')
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
        void openHelpLink('documentation')
        break
      case 'desktop-feedback':
        void openHelpLink('desktop-feedback')
        break
      case 'desktop-harness-feedback':
        void openHelpLink('harness-feedback')
        break
      case 'desktop-keyboard-shortcuts':
        onOpenShortcuts?.()
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
  }, { target: getCurrentWindow().label })

  return (
    <div
      className={cn(
        'relative flex h-11 w-full flex-none select-none items-center gap-0.5 bg-panel',
        {
          'hidden': IS_MACOS && isFullscreen,
          'pl-24 pr-1.5': IS_MACOS && !isFullscreen,
          'px-1.5': !IS_MACOS || isFullscreen,
        },
      )}
      style={{ background: dshStyle.sidebar?.background }}
      data-testid="dsh-navbar-root"
    >
      <If cond={onToggleSidebar != null && tauriEnabled}>
        <Button
          className="size-7"
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
      <If cond={!IS_MACOS}>
        <div className="ml-1">
          {/* 文件：新建窗口 / 新聊天 / 打开文件夹 / 关闭 / 退出。
              「新聊天」「打开文件夹」依赖 iframe 内的 dsh 服务（协议命令没有接收方
              时禁用而不是留着点了没反应的死按钮，与左侧侧边栏开关同一取舍）。 */}
          <Dropdown>
            <Button
              className="h-6 text-[12.5px] px-1.5"
              size="sm"
              variant="ghost"
              aria-label={t('menu.file')}
              data-testid="dsh-navbar-menu-file"
            >
              {t('menu.file')}
            </Button>
            <Dropdown.Popover className="min-w-55" data-testid="dsh-navbar-menu-popover">
              <Dropdown.Menu>
                <Dropdown.Item
                  id="new-window"
                  data-testid="dsh-navbar-item-new-window"
                  textValue={t('menu.new_window')}
                  onAction={() => handleFileAction('new-window')}
                >
                  <Label>{t('menu.new_window')}</Label>
                </Dropdown.Item>
                <Dropdown.Item
                  id="new-chat"
                  data-testid="dsh-navbar-item-new-chat"
                  isDisabled={onNewChat == null}
                  textValue={t('menu.new_chat')}
                  onAction={() => handleFileAction('new-chat')}
                >
                  <ShortcutLabel label={t('menu.new_chat')} hint={shortcutHint(shortcutRows, 'session.new')} />
                </Dropdown.Item>
                <Dropdown.Item
                  id="open-folder"
                  data-testid="dsh-navbar-item-open-folder"
                  isDisabled={onOpenFolder == null}
                  textValue={t('menu.open_folder')}
                  onAction={() => handleFileAction('open-folder')}
                >
                  <ShortcutLabel label={t('menu.open_folder')} hint={shortcutHint(shortcutRows, 'workspace.add')} />
                </Dropdown.Item>
                <Dropdown.Item
                  id="close"
                  data-testid="dsh-navbar-item-close"
                  textValue={t('menu.close')}
                  onAction={() => handleFileAction('close')}
                >
                  <Label>{t('menu.close')}</Label>
                </Dropdown.Item>
                <Dropdown.Item
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
          <Dropdown>
            <Button
              className="h-6 text-[12.5px] px-1.5"
              size="sm"
              variant="ghost"
              aria-label={t('menu.view')}
              data-testid="dsh-navbar-menu-view"
            >
              {t('menu.view')}
            </Button>
            <Dropdown.Popover className="min-w-55" data-testid="dsh-navbar-menu-popover">
              <Dropdown.Menu>
                <Dropdown.Section>
                  {DSH_VIEW_COMMANDS.map(item => (
                    <Dropdown.Item
                      key={item.command}
                      id={item.command}
                      isDisabled={onViewCommand == null || !shortcutRows.some(row => row.id === item.command && row.available === true)}
                      textValue={t(item.label)}
                      onAction={() => onViewCommand?.(item.command)}
                    >
                      <ShortcutLabel label={t(item.label)} hint={shortcutHint(shortcutRows, item.command)} />
                    </Dropdown.Item>
                  ))}
                </Dropdown.Section>
                <Dropdown.Section>
                  <Dropdown.Item id="zoom-in" textValue={t('menu.zoom_in')} onAction={() => store.setting.zoom('increase')}>
                    <ShortcutLabel label={t('menu.zoom_in')} hint="Ctrl + +" />
                  </Dropdown.Item>
                  <Dropdown.Item id="zoom-out" textValue={t('menu.zoom_out')} onAction={() => store.setting.zoom('decrease')}>
                    <ShortcutLabel label={t('menu.zoom_out')} hint="Ctrl + -" />
                  </Dropdown.Item>
                  <Dropdown.Item id="zoom-reset" textValue={t('menu.actual_size')} onAction={() => store.setting.zoom('reset')}>
                    <ShortcutLabel label={t('menu.actual_size')} hint="Ctrl + 0" />
                  </Dropdown.Item>
                </Dropdown.Section>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
          <Dropdown isOpen={runMenuOpen} onOpenChange={setRunMenuOpen}>
            {' '}
            <Button
              className="h-6 text-[12.5px] px-1.5"
              size="sm"
              variant="ghost"
              aria-label={t('menu.run')}
              data-testid="dsh-navbar-menu-config"
            >
              {t('menu.run')}
            </Button>
            <Dropdown.Popover className="min-w-55" data-testid="dsh-navbar-menu-popover">
              <Dropdown.Menu>
                {CONFIG_TABS.map(item => (
                  <Fragment key={item.id}>
                    <Dropdown.Item
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
                              className="size-6 hover:bg-background-tertiary"
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
                    <If cond={item.id === 'appearance'}>
                      <Separator />
                    </If>
                  </Fragment>
                ))}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
          <Dropdown>
            <Button
              className="h-6 text-[12.5px] px-1.5"
              size="sm"
              variant="ghost"
              aria-label={t('app.help')}
              data-testid="dsh-navbar-menu-help"
            >
              {t('app.help')}
            </Button>
            <Dropdown.Popover className="min-w-55" data-testid="dsh-navbar-menu-popover">
              <Dropdown.Menu>
                <Dropdown.Item
                  id="documentation"
                  data-testid="dsh-navbar-item-documentation"
                  textValue={t('menu.documentation')}
                  onAction={() => onHelpAction('documentation')}
                >
                  <Label>{t('menu.documentation')}</Label>
                </Dropdown.Item>
                <Dropdown.Item
                  id="keyboard-shortcuts"
                  data-testid="dsh-navbar-item-keyboard-shortcuts"
                  isDisabled={onOpenShortcuts == null}
                  textValue={t('menu.keyboard_shortcuts')}
                  onAction={() => onHelpAction('keyboard-shortcuts')}
                >
                  <ShortcutLabel label={t('menu.keyboard_shortcuts')} hint={shortcutHint(shortcutRows, 'shortcuts.open')} />
                </Dropdown.Item>
                <Separator />
                <Dropdown.Item
                  id="desktop-feedback"
                  data-testid="dsh-navbar-item-desktop-feedback"
                  textValue={t('menu.desktop_feedback')}
                  onAction={() => onHelpAction('desktop-feedback')}
                >
                  <Label>{t('menu.desktop_feedback')}</Label>
                </Dropdown.Item>
                <Dropdown.Item
                  id="harness-feedback"
                  data-testid="dsh-navbar-item-harness-feedback"
                  textValue={t('menu.harness_feedback')}
                  onAction={() => onHelpAction('harness-feedback')}
                >
                  <Label>{t('menu.harness_feedback')}</Label>
                </Dropdown.Item>
                <Separator />
                <Dropdown.Item
                  id="toggle-devtools"
                  data-testid="dsh-navbar-item-toggle-devtools"
                  textValue={t('menu.toggle_devtools')}
                  onAction={() => onHelpAction('toggle-devtools')}
                >
                  <Label>{t('menu.toggle_devtools')}</Label>
                </Dropdown.Item>
                <Dropdown.Item
                  id="task-manager"
                  data-testid="dsh-navbar-item-task-manager"
                  textValue={t('menu.task_manager')}
                  onAction={() => onHelpAction('task-manager')}
                >
                  <Label>{t('menu.task_manager')}</Label>
                </Dropdown.Item>
                <Dropdown.Item
                  id="copy-run-logs"
                  data-testid="dsh-navbar-item-copy-run-logs"
                  textValue={t('menu.run_logs')}
                  onAction={() => onHelpAction('copy-run-logs')}
                >
                  <Label>{t('menu.run_logs')}</Label>
                </Dropdown.Item>
                <Separator />
                <Dropdown.Item
                  id="check-update"
                  data-testid="dsh-navbar-item-check-update"
                  textValue={t('menu.check_update')}
                  onAction={() => onHelpAction('check-update')}
                >
                  <span className="flex w-full items-center justify-between gap-3">
                    <Label>{t('menu.check_update')}</Label>
                    <If cond={showUpdateAvailable}>
                      <Description>{t('menu.new_version')}</Description>
                    </If>
                  </span>
                </Dropdown.Item>
                <Dropdown.Item
                  id="about"
                  data-testid="dsh-navbar-item-about"
                  textValue={t('menu.about')}
                  onAction={() => onHelpAction('about')}
                >
                  <Label>{t('menu.about')}</Label>
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        </div>
      </If>

      <If cond={isNightly}>
        <Then>
          <Chip color="accent" size="sm" variant="soft" className="ml-1 text-xs mr-1">
            {t('navbar.nightly_build')}
          </Chip>
        </Then>
        <Else>
          <If cond={showUpdateAvailable}>
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
        </Else>
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

      {/* 「本地」/ 远端机器切换器：SSH 功能启用后才出现（未启用时组件自身不渲染），
          固定在右侧，与左侧的文件/运行/帮助菜单分列两端（macOS 上左侧是「更新可用」chip）。 */}
      <RemoteSwitcher onChange={onRemoteChange} visible={onToggleSidebar != null} onManage={onOpenMachineManager} onSync={onOpenSyncToRemote} />

      <If cond={!IS_MACOS}>
        <Button
          className="size-7"
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label={t('nav.minimize')}
          onPress={() => { handleWindowAction('minimize') }}
        >
          <Minus />
        </Button>

        <Button
          className="size-7"
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
          className="size-7 transition-colors enabled:hover:bg-danger/16 enabled:hover:text-danger"
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
