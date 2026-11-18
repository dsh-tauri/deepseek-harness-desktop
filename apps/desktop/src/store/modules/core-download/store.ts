import type { UnlistenFn } from '@tauri-apps/api/event'
import type { InstallProgress } from '../harness'
import type { CoreDownloadTask } from './types'
import type { HarnessCore } from '@/types'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import i18next from 'i18next'
import { defineStore } from 'valtio-define'
import { queryClient } from '@/config/client'
import { queryKeys } from '@/config/query-keys'
import { installPercent } from '@/utils/install-percent'
import { toast } from '@/utils/toast'
import { harness } from '../harness'
import { coreDownloadDescription } from './progress'

/**
 * 核心下载任务：进度复用首次安装的 `install-progress` 事件流（下载与解压合并计一档）。
 *
 * 全过程走右下角 toast，与插件下载同款：下载中是一条常驻的加载气泡（描述位放状态行 +
 * 进度条），结束后换成成功/失败气泡并带切换或重试入口，不再占用界面的模态或浮层。
 */
export const coreDownload = defineStore({
  state: () => ({
    task: null as CoreDownloadTask | null,
    /** 下载中气泡的 key：被可见限额淘汰后 update 会静默失效，故按「已死」重建 */
    progressKey: null as string | null,
  }),
  actions: {
    async start(tag: string, version: string) {
      const current = this.task
      if (current && (current.status === 'running' || current.status === 'switching'))
        return
      this.task = { tag, version, coreId: '', status: 'running', percentage: 0, detail: '', error: '' }
      this.syncProgress()
      await this.run()
    },

    /** 重试只针对提示对应的那次下载：任务已被后来的下载替换时不再代为重试 */
    async retry(tag: string) {
      const current = this.task
      if (!current || current.tag !== tag || current.status !== 'failed')
        return
      this.task = { ...current, status: 'running', percentage: 0, detail: '', error: '' }
      this.syncProgress()
      await this.run()
    },

    syncProgress() {
      const current = this.task
      if (!current || current.status !== 'running')
        return
      const title = i18next.t('core.downloading', { version: current.version })
      const description = coreDownloadDescription(current)
      const key = this.progressKey
      if (key === null || !toast.isActive(key))
        this.progressKey = toast(title, { timeout: 0, isLoading: true, description })
      else
        toast.update(key, { title, isLoading: true, description })
    },

    hideProgress() {
      if (this.progressKey !== null) {
        toast.close(this.progressKey)
        this.progressKey = null
      }
    },

    /** 先挂监听再 invoke，避免漏掉首批进度事件；监听注册本身也放进 try，注册失败要落到失败态而不是卡在下载中 */
    async run() {
      const pending = this.task
      if (!pending)
        return
      let unlisten: UnlistenFn | null = null
      try {
        unlisten = await listen<InstallProgress>('install-progress', (event) => {
          const current = this.task
          if (!current || current.status !== 'running')
            return
          const { percentage, detail } = event.payload
          const next = installPercent(percentage, current.percentage)
          if (next < current.percentage)
            return
          this.task = { ...current, percentage: next, detail }
          this.syncProgress()
        })
        const core = await invoke<HarnessCore>('download_core', { tag: pending.tag })
        const current = this.task
        if (current?.tag === pending.tag) {
          this.task = { ...current, coreId: core.id, status: 'success', percentage: 100 }
          this.hideProgress()
          this.presentDownloaded()
        }
      }
      catch (error) {
        console.error('[CoreDownload] download failed:', error)
        const current = this.task
        if (current?.tag === pending.tag) {
          this.task = { ...current, status: 'failed', error: String(error) }
          this.hideProgress()
          this.presentFailure()
        }
      }
      finally {
        unlisten?.()
        await queryClient.invalidateQueries({ queryKey: queryKeys.cores })
      }
    },

    /** 下载完成的结果气泡：直接给出切换入口，免得用户回到面板里再找这一行 */
    presentDownloaded() {
      const current = this.task
      if (!current)
        return
      const { tag } = current
      toast(i18next.t('core.downloaded_toast', { version: current.version }), {
        variant: 'success',
        timeout: 10_000,
        actionProps: {
          children: i18next.t('core.download_switch'),
          onPress: () => void this.activate(tag),
        },
      })
    },

    presentFailure() {
      const current = this.task
      if (!current)
        return
      const { tag } = current
      toast(i18next.t('core.download_failed'), {
        variant: 'danger',
        timeout: 10_000,
        description: current.error,
        actionProps: {
          children: i18next.t('app.retry'),
          onPress: () => void this.retry(tag),
        },
      })
    },

    /** 切换到刚下载的核心并重启服务；重启失败由 harness 自身上报 */
    async activate(tag: string) {
      const current = this.task
      if (!current || current.tag !== tag || current.status !== 'success')
        return
      this.task = { ...current, status: 'switching' }
      try {
        await invoke<HarnessCore>('set_active_core', { id: current.coreId })
      }
      catch (error) {
        console.error('[CoreDownload] switch failed:', error)
        this.task = { ...current, status: 'failed', error: String(error) }
        this.presentFailure()
        return
      }
      this.task = null
      // 不等待列表重拉：那个查询会走 GitHub，失败还要回退 git tags，让重启排在它后面
      // 等于把「已经切好了的核心」晾在旧服务上（与 config/core.tsx 的约定一致）。
      void queryClient.invalidateQueries({ queryKey: queryKeys.cores })
      await harness.restart()
    },
  },
})
