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
import { Fragment, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Else, If, Then } from 'react-if-lite'
import { cn } from 'tailwind-variants'
import { useStore } from 'valtio-define'
import { queryKeys } from '@/config/query-keys'
import { DISTRO_MANAGED_QUERY } from '@/hooks/use-distro-managed'
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
import { RemoteShare } from './remote-share'
import { RemoteSwitcher } from './remote-switcher'
import { IS_MACOS, onDragRegionPointerDown, useMacOSFullscreen, useMaximized } from './window-chrome'

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

type FileAction = 'new-window' | 'new-chat' | 'open-folder' | 'close' | 'quit'

type HelpAction = 'toggle-devtools' | 'task-manager' | 'keyboard-shortcuts' | 'copy-run-logs' | 'check-update' | 'about' | keyof typeof HELP_LINKS

const CONFIG_TABS = [
  { id: 'application', labelKey: 'config.application' },
  { id: 'appearance', labelKey: 'config.appearance' },
  { id: 'profiles', labelKey: 'config.profiles' },
  { id: 'plugins', labelKey: 'config.plugins' },
  { id: 'harness', labelKey: 'config.harness' },
  { id: 'dataDir', labelKey: 'config.dataDir' },
] as const

function handleWindowAction(action: 'minimize' | 'maximize' | 'close') {
  const appWindow = getCurrentWindow()
  switch (action) {
    case 'minimize':
      void appWindow.minimize()
      break
    case 'maximize':
      void appWindow.toggleMaximize()
      break
    case 'close':
      if (appWindow.label === 'main')
        void appWindow.hide()
      else
        void appWindow.close()
      break
  }
}

export function WindowControls() {
  const { t } = useTranslation()
  const isMaximized = useMaximized()
  const isMainWindow = getCurrentWindow().label === 'main'

  return (
    <>
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
        aria-label={t(isMainWindow ? 'nav.background' : 'nav.close')}
        onPress={() => { handleWindowAction('close') }}
      >
        <Xmark />
      </Button>
    </>
  )
}

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

  sidebarCollapsed?: boolean

  onToggleSidebar?: () => void

  onNewChat?: () => void

  onOpenMachineManager?: () => void

  onOpenSyncToRemote?: () => void

  onOpenRemoteAccess?: () => void

  onOpenFolder?: () => void

  onOpenShortcuts?: () => void
  onViewCommand?: (command: DshViewCommand) => void
}

export function Navbar({ onRemoteChange, sidebarCollapsed = false, onToggleSidebar, onNewChat, onOpenFolder, onOpenShortcuts, onViewCommand, onOpenMachineManager, onOpenSyncToRemote, onOpenRemoteAccess }: NavbarProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const isFullscreen = useMacOSFullscreen()
  const { data: appIdentifier } = useQuery(APP_IDENTIFIER_QUERY)
  const { data: plugins = [] } = useQuery({
    queryKey: queryKeys.plugins,
    queryFn: () => invoke<DshPlugin[]>('get_dsh_plugins'),
  })
  const { updateInfo } = useStore(store.desktopUpdater)
  const [dshStyle] = useDshStyle()
  const [{ rows: shortcutRows }] = useDshShortcuts()
  const [runMenuOpen, setRunMenuOpen] = useState(false)

  const openConfigDialog = useOverlay(ConfigDialog)
  const openTaskManager = useOverlay(TaskManagerDialog)
  const openAboutDialog = useOverlay(DesktopAboutDialog)
  const openUpdateDialog = useOverlay(DesktopUpdateDialog)

  const tauriEnabled = plugins.some(plugin => plugin.id === TAURI_PLUGIN_ID)
  const isMainWindow = getCurrentWindow().label === 'main'
  const isNightly = appIdentifier === 'dsh-tauri-nightly'
  const showUpdateAvailable = appIdentifier != null && !isNightly && updateInfo != null

  function onHelpAction(key: HelpAction) {
    if (key === 'toggle-devtools')
      void toggleDevtools()
    else if (key === 'task-manager')
      void openTaskManager().catch(() => {})
    else if (key === 'check-update')
      void handleCheckUpdate()
    else if (key === 'about')
      void openAboutDialog().catch(() => {})
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
        handleWindowAction('close')
        break
      case 'quit':
        void quitApp()
        break
    }
  }

  async function createWindow() {
    try {
      await invoke('create_app_window')
    }
    catch (error) {
      console.error('[Navbar] failed to create window:', error)
    }
  }

  async function quitApp() {
    try {
      await invoke('quit_app')
    }
    catch (error) {
      console.error('[Navbar] failed to quit app:', error)
    }
  }

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
    void openConfigDialog({ tab }).catch(() => {})
  }

  function handleQuickRestart() {
    setRunMenuOpen(false)
    void store.harness.restart()
  }

  function handleOpenAbout() {
    void openAboutDialog().catch(() => {})
  }

  function handleOpenUpdateDialog() {
    void openUpdateDialog().catch(() => {})
  }

  async function handleCheckUpdate() {
    try {
      const identifier = await queryClient.ensureQueryData(APP_IDENTIFIER_QUERY)
      if (identifier === 'dsh-tauri-nightly') {
        await invoke('open_external_url', { url: 'https://github.com/dsh-tauri/deepseek-harness-desktop/releases/tag/nightly' })
        return
      }
      if (await queryClient.ensureQueryData(DISTRO_MANAGED_QUERY)) {
        toast(t('update.distro_managed'), {})
        return
      }
      const info = await store.desktopUpdater.check()
      if (info)
        handleOpenUpdateDialog()
      else
        toast(t('update.up_to_date'), {})
    }
    catch (err) {
      // 媒介不支持就地替换是确定结论，不能报成「检查失败，请检查网络」（issue #1410）
      if (String(err).includes('UPDATE_MEDIA_UNSUPPORTED')) {
        toast(t('update.media_unsupported'), { variant: 'danger' })
        return
      }
      console.warn('[Navbar] check update failed:', err)
      toast(t('update.check_failed'), { variant: 'danger' })
    }
  }

  async function copyRunLogs() {
    try {
      const logs = await invoke<string>('read_run_logs')
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
  }, { target: { kind: 'Window', label: getCurrentWindow().label } })

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
              「新聊天」「打开文件夹」依赖 webview 内的 dsh 服务（协议命令没有接收方
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

      <If cond={!isMainWindow}>
        <Chip className="ml-1 shrink-0 text-xs" color="default" size="sm" variant="soft" data-testid="dsh-navbar-child-window-chip">
          {t('navbar.child_window')}
        </Chip>
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

      {/* 右侧控件：入站分享（远程）排在本地/远端切换器之前；切换器在 SSH 未启用时自身不渲染。 */}
      <If cond={onToggleSidebar != null}>
        <RemoteShare onManage={onOpenRemoteAccess} />
      </If>

      <RemoteSwitcher onChange={onRemoteChange} visible={onToggleSidebar != null} onManage={onOpenMachineManager} onSync={onOpenSyncToRemote} />

      <If cond={!IS_MACOS}>
        <WindowControls />
      </If>
    </div>
  )
}
