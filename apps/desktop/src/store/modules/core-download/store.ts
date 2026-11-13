import type { InstallProgress } from '../harness'
import type { CoreDownloadTask } from './types'
import type { HarnessCore } from '@/types'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { defineStore } from 'valtio-define'
import { queryClient } from '@/config/client'
import { queryKeys } from '@/config/query-keys'
import { harness } from '../harness'

/** 浮窗保留的日志行数 */
const LOG_LIMIT = 5

/** 核心下载任务：进度复用首次安装的 `install-progress` 事件流，下载与解压合并计一档 */
export const coreDownload = defineStore({
  state: () => ({
    task: null as CoreDownloadTask | null,
  }),
  actions: {
    async start(tag: string, version: string) {
      const current = this.task
      if (current && (current.status === 'running' || current.status === 'switching'))
        return
      this.task = { tag, version, coreId: '', status: 'running', percentage: 0, logs: [], error: '' }
      await this.run()
    },

    async retry() {
      const current = this.task
      if (!current || current.status !== 'failed')
        return
      this.task = { ...current, status: 'running', percentage: 0, logs: [], error: '' }
      await this.run()
    },

    /** 先挂监听再 invoke，避免漏掉首批进度事件 */
    async run() {
      const pending = this.task
      if (!pending)
        return
      const unlisten = await listen<InstallProgress>('install-progress', (event) => {
        const current = this.task
        if (!current)
          return
        const { percentage, log } = event.payload
        if (percentage < current.percentage)
          return
        this.task = {
          ...current,
          percentage,
          logs: log ? [...current.logs, log].slice(-LOG_LIMIT) : current.logs,
        }
      })
      try {
        const core = await invoke<HarnessCore>('download_core', { tag: pending.tag })
        const current = this.task
        if (current?.tag === pending.tag)
          this.task = { ...current, coreId: core.id, status: 'success', percentage: 100 }
      }
      catch (error) {
        console.error('[CoreDownload] download failed:', error)
        const current = this.task
        if (current?.tag === pending.tag)
          this.task = { ...current, status: 'failed', error: String(error) }
      }
      finally {
        unlisten()
        await queryClient.invalidateQueries({ queryKey: queryKeys.cores })
      }
    },

    /** 切换到刚下载的核心并重启服务；重启失败由 harness 自身上报 */
    async activate() {
      const current = this.task
      if (!current || current.status !== 'success')
        return
      this.task = { ...current, status: 'switching' }
      try {
        await invoke<HarnessCore>('set_active_core', { id: current.coreId })
      }
      catch (error) {
        console.error('[CoreDownload] switch failed:', error)
        this.task = { ...current, status: 'failed', error: String(error) }
        return
      }
      this.task = null
      await queryClient.invalidateQueries({ queryKey: queryKeys.cores })
      await harness.restart()
    },

    dismiss() {
      if (this.task?.status === 'running' || this.task?.status === 'switching')
        return
      this.task = null
    },
  },
})
