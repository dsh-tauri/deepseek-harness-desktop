import type { PluginRecoveryInfo } from './types'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { defineStore } from 'valtio-define'
import { harness } from '../harness'
import { MAX_RECOVERY_ATTEMPTS } from './types'
import { createRecovery } from './utils'

/**
 * 插件异常修复模块：启动崩溃或运行期异常时定位问题插件，并提供
 * 「从快照还原 / 卸除此插件并继续检测 / 重启 / 暂不处理」。
 *
 * 与 harness 模块的分工：harness 负责服务生命周期，本模块只负责
 * 「哪个插件坏了、怎么修」——修复动作完成后统一回调 harness 重启。
 */
export const recovery = defineStore({
  state: () => ({
    /** 插件异常修复界面状态（启动崩溃/运行期异常 → 弹出「卸除此插件并继续检测」） */
    recovery: createRecovery(),
    /** 用户已「暂不处理」的插件 id（避免同一运行期异常反复弹窗） */
    dismissedRecoveryIds: [] as string[],
  }),
  getters: {
    /** 连续修复失败达到上限：界面转为「查看日志 / 手动卸载」提示 */
    exhausted(): boolean {
      return this.recovery.attempts >= MAX_RECOVERY_ATTEMPTS
    },
  },
  actions: {
    /**
     * 订阅后端「插件异常」推送：`report_plugin_error`（运行期异常）会推送
     * `plugin-recovery-required`，据此弹出「卸除此插件并继续检测」修复界面。
     */
    async listen() {
      try {
        await listen<PluginRecoveryInfo>('plugin-recovery-required', (event) => {
          this.setRuntimeRecovery(event.payload)
        })
      }
      catch (err) {
        console.error('[Harness] failed to listen plugin-recovery-required:', err)
      }
    },

    /** 运行期插件异常：弹出修复对话框（应用仍在运行）。已「暂不处理」的同插件不再重复弹。 */
    setRuntimeRecovery(info: PluginRecoveryInfo) {
      if (info.plugins.length === 0)
        return
      if (info.plugins.some(id => this.dismissedRecoveryIds.includes(id)))
        return
      this.recovery = { required: true, info, attempts: this.recovery.attempts + 1, busy: false }
    },

    /**
     * 启动失败时尝试定位问题插件并弹出修复界面。
     * 能定位到具体插件 → 设置 `recovery`；定位不到则保持普通错误态（无插件可卸载）。
     *
     * `shouldCommit` 由调用方注入（例如「本次启动是否仍是最新一代」的场景守卫）：
     * 定位是异步的，期间可能已发生重启/退出，守卫返回 false 时丢弃结果。
     */
    async reviewStartupRecovery(logs: string[], shouldCommit?: () => boolean) {
      if (this.recovery.required || logs.length === 0)
        return
      try {
        const info = await invoke<PluginRecoveryInfo>('detect_plugin_recovery', { logs })
        if (shouldCommit && !shouldCommit())
          return
        if (info.plugins.length > 0) {
          this.recovery = {
            required: true,
            info,
            attempts: this.recovery.attempts + 1,
            busy: false,
          }
        }
      }
      catch (err) {
        console.error('[Harness] detect_plugin_recovery failed:', err)
      }
    },

    /** 「卸除此插件并继续检测」：离线卸载定位到的插件 → 重启并重新检测；仍有问题会再次触发修复界面。 */
    async recoverAndRedetect(ids: readonly string[]) {
      if (this.recovery.busy || ids.length === 0)
        return
      this.recovery = { ...this.recovery, busy: true }
      try {
        for (const id of ids) {
          await invoke('recover_plugin', { id })
        }
        // 卸载成功：清空恢复态回到启动/就绪；若仍失败，boot 的 catch 会再次定位并弹出。
        // 保留 attempts：连续失败会累加，达到上限后界面提示「查看日志 / 手动卸载」。
        this.dismissedRecoveryIds = this.dismissedRecoveryIds.filter(x => !ids.includes(x))
        this.clear()
        await harness.restart()
      }
      catch (err) {
        console.error('[Harness] recover_plugin failed:', err)
        this.recovery = { ...this.recovery, busy: false, attempts: this.recovery.attempts + 1 }
      }
    },

    /**
     * 从快照还原并继续检测：优先用单插件快照还原问题插件（优先级高于卸载）；
     * 仅对传入的（确有快照的）插件还原，单项失败不阻断其它项。还原成功后重启并重新检测。
     */
    async restoreAndRedetect(ids: readonly string[]) {
      if (this.recovery.busy || ids.length === 0)
        return
      this.recovery = { ...this.recovery, busy: true }
      try {
        // 逐项还原，单项失败仅记录告警、不中断整体流程（无快照项由调用方过滤）
        for (const id of ids) {
          try {
            await invoke('restore_plugin', { id })
          }
          catch (err) {
            console.error(`[Harness] restore_plugin failed for ${id}:`, err)
          }
        }
        this.clear()
        await harness.restart()
      }
      catch (err) {
        console.error('[Harness] restoreAndRedetect failed:', err)
        this.recovery = { ...this.recovery, busy: false, attempts: this.recovery.attempts + 1 }
      }
    },

    /** 「暂不处理」：关闭修复界面并记住这些插件（运行期场景不阻断使用）。 */
    dismissRecovery() {
      if (this.recovery.info) {
        this.dismissedRecoveryIds = [
          ...new Set([...this.dismissedRecoveryIds, ...this.recovery.info.plugins]),
        ]
      }
      this.recovery = createRecovery()
    },

    /** 完全重置：清空定位信息、失败计数与已忽略列表（服务确认就绪/停止后调用）。 */
    reset() {
      this.recovery = createRecovery()
      this.dismissedRecoveryIds = []
    },

    /** 收起界面并清空定位信息，但保留 attempts（服务重启开始时调用）。 */
    clear() {
      this.recovery = createRecovery(this.recovery.attempts)
    },

    /**
     * 仅收起界面，保留 info 与 attempts（手动重启前调用）。
     * 若重启仍失败，boot 的 catch 会重新定位问题插件并再次弹出。
     */
    hide() {
      this.recovery = { ...this.recovery, required: false, busy: false }
    },
  },
})
