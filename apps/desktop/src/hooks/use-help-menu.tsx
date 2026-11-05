import type { TFunction } from 'i18next'
import { useOverlay } from '@overlastic/react'
import { useQueryClient } from '@tanstack/react-query'
import { getIdentifier } from '@tauri-apps/api/app'
import { invoke } from '@tauri-apps/api/core'
import { queryKeys } from '@/config/query-keys'
import { DISTRO_MANAGED_QUERY } from '@/hooks/use-distro-managed'
import { store } from '@/store'
import { DesktopAboutDialog } from '@/ui/dialog/about'
import { TaskManagerDialog } from '@/ui/dialog/task-manager'
import { writeClipboardText } from '@/utils/clipboard'
import { toast } from '@/utils/toast'

/** 帮助菜单里的外部链接。 */
export const HELP_LINKS = {
  'documentation': 'https://dshtauri.mintlify.site',
  'desktop-feedback': 'https://github.com/dsh-tauri/deepseek-harness-desktop/issues',
  'harness-feedback': 'https://trtgsjkv6r.feishu.cn/share/base/form/shrcnlCoGElW7MQznGy9r3YYXcg?hide_uid=1&hide_device_info=1&hide_harness_version=1',
}

export type HelpAction = 'toggle-devtools' | 'task-manager' | 'keyboard-shortcuts' | 'copy-run-logs' | 'check-update' | 'about' | keyof typeof HELP_LINKS

export interface HelpMenuActions {
  openUpdateDialog: () => void
}

/** 帮助菜单的动作实现：外部链接、诊断与更新检查。 */
export function useHelpActions(t: TFunction, actions: HelpMenuActions) {
  const queryClient = useQueryClient()
  const openTaskManager = useOverlay(TaskManagerDialog)
  const openAboutDialog = useOverlay(DesktopAboutDialog)

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

  async function copyRunLogs() {
    try {
      const logs = await invoke<string>('read_run_logs')
      await writeClipboardText(logs, t('messages.logs_copied'))
    }
    catch (err) {
      console.error('[Navbar] failed to copy run logs:', err)
    }
  }

  async function checkUpdate() {
    try {
      const identifier = await queryClient.ensureQueryData({
        queryKey: queryKeys.appIdentifier,
        queryFn: getIdentifier,
        staleTime: Infinity,
      })
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
        actions.openUpdateDialog()
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

  async function toggleDevtools() {
    try {
      await invoke('toggle_devtools')
    }
    catch (error) {
      console.error('[Navbar] failed to toggle devtools:', error)
    }
  }

  function run(key: HelpAction, onOpenShortcuts?: () => void) {
    if (key === 'toggle-devtools')
      void toggleDevtools()
    else if (key === 'task-manager')
      void openTaskManager().catch(() => {})
    else if (key === 'check-update')
      void checkUpdate()
    else if (key === 'about')
      void openAboutDialog().catch(() => {})
    else if (key === 'copy-run-logs')
      void copyRunLogs()
    else if (key === 'keyboard-shortcuts')
      onOpenShortcuts?.()
    else
      void openHelpLink(key)
  }

  return { run }
}
