import type { UnlistenFn } from '@tauri-apps/api/event'
import type { DshUpdateInfo } from './types'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import i18next, { t } from 'i18next'
import { defineStore } from 'valtio-define'
import { isElectronRuntime } from '@/utils/runtime'
import { toast } from '@/utils/toast'
import { harness } from '../harness'

/**
 * 版本更新模块：后台静默检查 + 手动更新安装。
 * 安装进度与启动等待复用 harness 模块的能力，本模块只负责"有没有新版本"的决策。
 */
export const harnessUpdater = defineStore({
  state: () => ({
    /** 发现的新版本信息（null 表示暂无/已被忽略） */
    updateInfo: null as DshUpdateInfo | null,
    /** 是否正在安装更新 */
    updating: false,
  }),
  actions: {
    /** 后台静默检查是否有新版 Harness（网络失败/API 限流时静默跳过） */
    async checkForUpdate() {
      try {
        const info = await invoke<DshUpdateInfo | null>('check_dsh_update')
        // 后端返回 null 表示没有可推送的更新（包括高于推荐版本的最新版本），
        // 必须清空旧提示，避免调试页继续显示已经被策略拦截的更新。
        this.updateInfo = info
      }
      catch (err) {
        console.warn('[Harness] update check skipped:', err)
      }
    },

    /** 手动更新并重启服务，返回新版本是否已落盘。 */
    async handleUpdate(): Promise<boolean> {
      if (this.updating)
        return false
      this.updating = true
      let unlistenInstall: UnlistenFn | null = null
      let installed = false
      try {
        unlistenInstall = await harness.listenInstallProgress()
        harness.prepareInstall(i18next.t('status.updating'))
        // 返回是否真正落盘更新：false 表示未发生安装（已是最新，或 GitHub
        // 限流拿不到可信摘要而保持本地安装）。此时绝不重启页面、也不丢弃
        // “有新版本”提示——否则用户会看到“页面刷新了、版本却没变、提示也没了”。
        const changed = await invoke<boolean>('install_dependencies')
        installed = changed
        if (!changed) {
          // 回到就绪态（若当前停在安装/更新界面，则恢复到原 webview 视图）
          harness.status = 'ready'
          // 重新核对一次：若确有新版，恢复“存在新版本”的提示并明确告知无法校验，
          // 而非静默当作“已更新”成功。
          this.updateInfo = null
          try {
            await this.checkForUpdate()
          }
          catch {
            /* 核对失败保持 updateInfo 为空，交由下次轮询恢复 */
          }
          if (this.updateInfo) {
            toast(i18next.t('update.verify_failed'), { variant: 'danger' })
          }
          return false
        }
        await harness.launchAndWait()
        this.updateInfo = null
        return true
      }
      catch (err) {
        console.error('[Harness] update failed:', err)
        harness.fail(String(err))
        return installed
      }
      finally {
        unlistenInstall?.()
        this.updating = false
      }
    },

    /** 忽略本次更新提示 */
    dismissUpdate() {
      this.updateInfo = null
    },

    /**
     * 展示更新提示。
     *
     * Electron 下 Harness 页面是主窗口内容区的原生子视图，会整块盖住壳层右下角的
     * toast，因此在原生运行时改用独立的透明置顶覆盖窗口承载提示
     * （`desktop::toast_overlay`），它天然盖在 guest 之上、窗口只贴提示卡片大小。
     * 其它运行时（WebView）仍用普通 toast。
     *
     * `onUpdate` 由覆盖窗口的「立即更新」经 `dsh://toast-overlay:update` 事件触发。
     */
    showToast(onUpdate: () => void) {
      if (!this.updateInfo)
        return
      const title = t('update.available', { tag: this.updateInfo.tag })
      const description = this.updateInfo.commit.slice(0, 7)
      const actionLabel = t('update.now')
      if (isElectronRuntime()) {
        void invoke('show_toast_overlay', {
          content: { title, description, action_label: actionLabel, source: getCurrentWindow().label },
        }).catch((error: unknown) => console.error('[Harness] show toast overlay failed:', error))
        return
      }
      toast(title, {
        actionProps: {
          children: actionLabel,
          onPress: () => {
            toast.clear()
            onUpdate()
          },
          variant: 'tertiary',
        },
        placement: 'bottom end',
        description,
        variant: 'default',
      })
    },

    /** 隐藏覆盖窗口（提示消失或开始安装时调用）。 */
    hideToast() {
      if (!isElectronRuntime())
        return
      void invoke('hide_toast_overlay').catch((error: unknown) => console.error('[Harness] hide toast overlay failed:', error))
    },
  },
})
