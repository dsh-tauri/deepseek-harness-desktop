import type { UnlistenFn } from '@tauri-apps/api/event'
import type { DshUpdateInfo } from './types'
import { invoke } from '@tauri-apps/api/core'
import i18next, { t } from 'i18next'
import { defineStore } from 'valtio-define'
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
    /** 后台静默检查是否有新版 Harness（后端失败原因见 DSH_UPDATE_CHECK_FAILED 日志） */
    async checkForUpdate() {
      try {
        const info = await invoke<DshUpdateInfo | null>('check_dsh_update')
        // 同一版本不重复写回：引用变化会让界面层重复弹提示，而定时复查每轮都会
        // 拿到内容相同的新对象。null 必须写回，否则会留下已经过期的更新入口。
        if (info === null || info.tag !== this.updateInfo?.tag)
          this.updateInfo = info
      }
      catch (err) {
        // 后端已用 DSH_UPDATE_CHECK_FAILED 记录失败原因（限流/网络/解析），
        // 这里只透传，避免前端静默成一个看不见的 Promise 拒绝。
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

    showToast(onUpdate: () => void) {
      if (!this.updateInfo)
        return
      toast(t('update.available', { tag: this.updateInfo.tag }), {
        actionProps: {
          children: t('update.now'),
          onPress: () => {
            toast.clear()
            onUpdate()
          },
          variant: 'tertiary',
        },
        placement: 'bottom end',
        description: this.updateInfo.commit.slice(0, 7),
        variant: 'default',
      })
    },
  },
})
