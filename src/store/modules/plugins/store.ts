import type { PluginsManagerEvent, PluginsManagerEventMap } from './events'
import type {
  BlockedRefusal,
  Plugin,
  PluginGroup,
  PluginProcess,
  PluginProcessReason,
  PluginProcessResult,
  PluginProcessType,
  PluginRef,
  PluginSearchProblem,
  PluginSearchResult,
  PluginsManagerRuntime,
  PluginsState,
} from './types'
import type { DshPlugin } from '@/types'
import type { ToastCloseReason } from '@/utils/toast'
import { invoke } from '@tauri-apps/api/core'
import i18next from 'i18next'
import { defineStore } from 'valtio-define'
import { toast } from '@/utils/toast'
import { harness } from '../harness'
import { onPluginsManagerEvent, triggerPluginsManagerEvent } from './events'
import { enrichInstalled, normalizeRef, normalizeRefs, parseBlockedRefusal, parseUpdateFailures, refusalNames } from './utils'

const LOG_LIMIT = 200
const MAX_ATTEMPTS = 8

const COMMANDS: Record<PluginProcessType, string> = {
  install: 'install_plugin_specs',
  upgrade: 'update_dsh_plugins',
  uninstall: 'remove_dsh_plugins',
  disable: 'disable_dsh_plugin',
  enable: 'enable_dsh_plugin',
}

const PROGRESS_ONE: Record<PluginProcessType, string> = {
  install: 'plugins.progress_install_one',
  upgrade: 'plugins.progress_upgrade_one',
  uninstall: 'plugins.progress_uninstall_one',
  disable: 'plugins.progress_disable_one',
  enable: 'plugins.progress_enable_one',
}

const PROGRESS_MANY: Record<PluginProcessType, string> = {
  install: 'plugins.progress_install_many',
  upgrade: 'plugins.progress_upgrade_many',
  uninstall: 'plugins.progress_uninstall_many',
  disable: 'plugins.progress_disable_many',
  enable: 'plugins.progress_enable_many',
}

const RESULT_SUCCESS: Record<PluginProcessType, string> = {
  install: 'plugins.result_install_success',
  upgrade: 'plugins.result_upgrade_success',
  uninstall: 'plugins.result_uninstall_success',
  disable: 'plugins.result_disable_success',
  enable: 'plugins.result_enable_success',
}

const RESULT_FAILED: Record<PluginProcessType, string> = {
  install: 'plugins.result_install_failed',
  upgrade: 'plugins.result_upgrade_failed',
  uninstall: 'plugins.result_uninstall_failed',
  disable: 'plugins.result_disable_failed',
  enable: 'plugins.result_enable_failed',
}

const BLOCK_TITLE: Record<BlockedRefusal['kind'], string> = {
  'incompatible': 'plugins.blocked_incompatible_title',
  'policy': 'plugins.blocked_policy_title',
  'update-hold': 'plugins.hold_title',
}

const BLOCK_DESC: Record<BlockedRefusal['kind'], string> = {
  'incompatible': 'plugins.blocked_incompatible_desc',
  'policy': 'plugins.blocked_policy_desc',
  'update-hold': 'plugins.hold_desc',
}

const NOOP_MESSAGE: Record<PluginProcessType, string> = {
  install: 'plugins.already_absent',
  upgrade: 'plugins.no_change',
  uninstall: 'plugins.already_absent',
  disable: 'plugins.no_change',
  enable: 'plugins.no_change',
}

interface PluginInspectPayload {
  spec: string
  name?: string
  version?: string
  compatible?: boolean | null
  peers?: Record<string, string>
  problem?: PluginSearchProblem
}

function nextGroupId(type: PluginProcessType): string {
  return `${type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(message: string): string | undefined {
  return /^([A-Z][A-Z0-9_]+):/.exec(message)?.[1]
}

export const plugins = defineStore({
  state: (): PluginsState => ({
    groups: [],
    processes: [],
    logs: [],
    activeGroupId: null,
    cancelling: false,
    installedSource: [],
    installedLoaded: false,
    progressKey: null,
    progressDetail: '',
    queueResults: [],
  }),
  getters: {
    installed(): Plugin[] {
      return enrichInstalled(this.installedSource)
    },
    pendingApprovals(): PluginProcess[] {
      return this.processes.filter(process => process.status === 'unauthorized')
    },
  },
  actions: {
    pushLog(level: 'info' | 'error', message: string, groupId?: string, processId?: string): void {
      this.logs = [...this.logs, { at: Date.now(), level, message, groupId, processId }].slice(-LOG_LIMIT)
    },

    setInstalled(list: DshPlugin[]): void {
      this.installedSource = list
      this.installedLoaded = true
    },

    async refresh(): Promise<DshPlugin[]> {
      const list = await invoke<DshPlugin[]>('refresh_plugin_updates')
      this.setInstalled(list)
      return list
    },

    on<K extends PluginsManagerEvent>(
      event: K,
      handler: (payload: PluginsManagerEventMap[K]) => void,
    ): () => void {
      return onPluginsManagerEvent(event, handler)
    },

    enqueue(
      type: PluginProcessType,
      refs: PluginRef | PluginRef[],
      options: PluginsManagerRuntime,
    ): Promise<PluginProcessResult[]> {
      const normalized = normalizeRefs(refs)
      const groupId = nextGroupId(type)
      const created: PluginProcess[] = normalized.map((ref, index) => ({
        id: `${groupId}#${index}`,
        groupId,
        type,
        status: 'pending',
        spec: ref.spec,
        name: ref.name,
        ...(ref.version === undefined ? {} : { version: ref.version }),
      }))
      let resolveDone: (results: PluginProcessResult[]) => void = () => {}
      const done = new Promise<PluginProcessResult[]>((resolve) => {
        resolveDone = resolve
      })
      const group: PluginGroup = {
        id: groupId,
        type,
        status: 'pending',
        processIds: created.map(process => process.id),
        attempt: 0,
        pending: created.map(process => process.id),
        results: [],
        done,
        resolveDone,
        options,
      }
      this.processes = [...this.processes, ...created]
      this.groups = [...this.groups, group]
      this.pushLog('info', i18next.t('plugins.log_enqueued', { count: created.length }), groupId)
      this.syncProgress()
      void this.drain()
      return done
    },

    async drain(): Promise<void> {
      if (this.activeGroupId !== null)
        return
      const group = this.groups.find(item => item.status === 'pending')
      if (!group)
        return
      this.activeGroupId = group.id
      group.status = 'active'
      try {
        await this.runGroup(group)
      }
      finally {
        this.activeGroupId = null
        void this.drain()
      }
    },

    async runGroup(group: PluginGroup): Promise<void> {
      this.syncProgress()
      while (group.pending.length > 0) {
        const targets = group.pending
          .map(id => this.processes.find(process => process.id === id))
          .filter((process): process is PluginProcess => process !== undefined && process.status === 'pending')
        if (this.cancelling)
          break
        if (targets.length === 0) {
          this.hideProgress()
          await new Promise<void>((resolve) => {
            group.resume = resolve
          })
          group.resume = undefined
          this.syncProgress()
          continue
        }
        if (group.attempt >= MAX_ATTEMPTS) {
          targets.forEach((process) => {
            this.finish(group.id, process, {
              process,
              ok: false,
              error: i18next.t('plugins.retry_exhausted'),
              reason: 'retry-exhausted',
            })
          })
          break
        }
        const runnable: PluginProcess[] = []
        targets.forEach((process) => {
          const reason = this.precheck(process)
          if (reason === null) {
            runnable.push(process)
            return
          }
          this.finish(group.id, process, {
            process,
            ok: false,
            error: i18next.t(reason === 'not-installed' ? 'plugins.not_installed' : NOOP_MESSAGE[process.type], {
              name: process.name,
            }),
            reason,
          })
        })
        if (runnable.length === 0)
          continue
        runnable.forEach((process) => {
          process.status = 'running'
        })
        const blocked = await this.submit(group, runnable)
        if (blocked.length > 0) {
          this.hideProgress()
          await new Promise<void>((resolve) => {
            group.resume = resolve
          })
          group.resume = undefined
          this.syncProgress()
          continue
        }
        runnable.forEach(process => this.detach(process.id))
      }
      this.settle(group)
    },

    precheck(process: PluginProcess): PluginProcessReason | null {
      // 升级永不预跳过：面板既然画出了升级入口，就说明它有版本或异常信息要处理，而本地快照
      // （`installedSource`）可能刚被安装/刷新改过。按快照判「没有更新」会把用户的点击悄悄丢掉——
      // 用户点过的插件必须交给宿主，宿主按面板给的目标版本显式安装，装不上就报真实错误
      // （见 `update_dsh_plugins` → `install_targets`）。
      if (process.type === 'install' || process.type === 'upgrade' || !this.installedLoaded)
        return null
      const installed = this.installedSource.find(item => item.id === process.name || item.name === process.name)
      if (!installed)
        return process.type === 'uninstall' ? 'already-absent' : 'not-installed'
      if (process.type === 'disable' && installed.disabled)
        return 'already-absent'
      if (process.type === 'enable' && !installed.disabled && !installed.patchDisabled)
        return 'already-absent'
      return null
    },

    async submit(group: PluginGroup, targets: PluginProcess[]): Promise<PluginProcess[]> {
      group.attempt += 1
      if (group.type === 'disable' || group.type === 'enable') {
        const settled = await Promise.allSettled(
          targets.map(process =>
            invoke<void>(COMMANDS[group.type], {
              id: process.name,
              ...(group.type === 'enable' ? { clearConfigOverride: group.options.clearConfigOverride ?? false } : {}),
            }),
          ),
        )
        const blocked: PluginProcess[] = []
        settled.forEach((outcome, index) => {
          const process = targets[index]
          if (outcome.status === 'fulfilled') {
            this.finish(group.id, process, { process, ok: true })
            return
          }
          const message = errorMessage(outcome.reason)
          const refusal = parseBlockedRefusal(message)
          if (refusal !== null && refusalNames(refusal).size > 0) {
            this.block(group, process, refusal, group.options.toast)
            blocked.push(process)
            return
          }
          this.finish(group.id, process, { process, ok: false, error: message, code: errorCode(message) })
        })
        return blocked
      }
      try {
        // 升级的载荷项是 `id@版本`（面板显示着目标版本，带上它核验与显式安装兜底才有据
        // 可依，见 `update_dsh_plugins`）；宿主的参数名仍叫 `ids`。
        await invoke<void>(COMMANDS[group.type], {
          ...(group.type === 'install'
            ? { specs: targets.map(process => process.spec) }
            : group.type === 'upgrade'
              ? { ids: targets.map(process => process.spec) }
              : { ids: targets.map(process => process.name) }),
        })
        targets.forEach(process => this.finish(group.id, process, { process, ok: true }))
        return []
      }
      catch (error) {
        // 宿主调用返回时这一组可能已经被 cancel() 结算（取消不等在途调用结束）：此时
        // group.pending 已空。若照旧按拒绝归结，就会给已经按「已取消」结算的进程重新挂上授权
        // 等待，而 cancel 早已返回、再没人唤醒 resume，整条队列连同后续组会永久卡死。finish 用
        // 同一判据做幂等，这里也让归因只看仍留在组里的进程。
        const message = errorMessage(error)
        const refusal = parseBlockedRefusal(message)
        // 升级的结算里，宿主把「哪个目标真的没装上、原因是什么」逐条带出来（见
        // `PLUGIN_UPDATE_FAILED`）。没有这份逐项证据时只能按整组错误归结，于是一批里已经被
        // 宿主核验装上的目标也会跟着报失败，汇总里连重启入口都不出现（见 #914）。
        const failures = new Map(parseUpdateFailures(message).map(entry => [entry.name, entry.message]))
        const settleFailure = (process: PluginProcess): boolean => {
          const detail = failures.get(process.name)
          if (detail === undefined)
            return false
          this.finish(group.id, process, { process, ok: false, error: detail, code: errorCode(detail) })
          return true
        }
        // 升级：宿主对整批逐项核验过指纹，只有被点名的才没生效。
        // - 没被点名的说明确实装上了，报成功即可，重提一次反而会把它们重新判成「没有变化」；
        // - 还能授权（新版本只是太新，写进档案豁免清单就能过闸）→ 进授权流程，常驻提示带按钮；
        // - 点名的版本已经授权过（写在豁免清单里）却还是没有变化：这是**失败**，不是
        //   「可跳过」。用户点升级就是要装上那个版本，静默跳过会让他以为已经更新（见
        //   `plugins.hold_pinned_desc` 的原因说明）；
        // - 载荷连目标版本都没有（探测缓存没命中、面板当时也没有版本可带）时无从安装：这同样是
        //   失败，只是原因不同（没有可安装的目标版本）。任何「什么都没发生」的路径都必须留下
        //   一条可见的结果，否则汇总里会出现用户看不见的空桶（「1 个成功」而其它插件下落不明）。
        if (refusal?.kind === 'update-hold') {
          const names = refusalNames(refusal)
          const known = new Set(refusal.versions.map(item => item.name))
          const blocked: PluginProcess[] = []
          targets.forEach((process) => {
            if (!group.pending.includes(process.id))
              return
            if (names.size > 0 && !names.has(process.name)) {
              if (settleFailure(process))
                return
              this.finish(group.id, process, { process, ok: true })
              return
            }
            if (names.size > 0 && refusal.retryableNames.includes(process.name)) {
              this.block(group, process, refusal, group.options.toast)
              blocked.push(process)
              return
            }
            this.finish(group.id, process, {
              process,
              ok: false,
              error: i18next.t(
                known.has(process.name) ? 'plugins.hold_pinned_desc' : 'plugins.hold_no_target',
              ),
            })
          })
          return blocked
        }
        if (refusal !== null && refusalNames(refusal).size > 0) {
          const names = refusalNames(refusal)
          const blocked: PluginProcess[] = []
          targets.forEach((process) => {
            if (!group.pending.includes(process.id))
              return
            if (names.has(process.name)) {
              this.block(group, process, refusal, group.options.toast)
              blocked.push(process)
              return
            }
            if (settleFailure(process))
              return
            process.status = 'pending'
          })
          // 只有当被点名的包确实在本次提交里时才进入授权等待。refusal 常点名传递依赖
          // 等外部包，此时 blocked 为空；若照样返回，runGroup 会因无人调用 resume 永久挂起。
          if (blocked.length > 0)
            return blocked
        }
        // 有逐项证据时按目标归因：点名的报它自己的错，没点名的就是宿主已核验装上的目标，
        // 报成功——它们让「1 个成功 · 1 个失败」的汇总和重启入口都留下来。
        if (failures.size > 0) {
          targets.forEach((process) => {
            if (!group.pending.includes(process.id))
              return
            if (settleFailure(process))
              return
            this.finish(group.id, process, { process, ok: true })
          })
          return []
        }
        targets.forEach(process =>
          this.finish(group.id, process, {
            process,
            ok: false,
            error: message,
            code: errorCode(message),
          }),
        )
        return []
      }
    },

    block(group: PluginGroup, process: PluginProcess, refusal: BlockedRefusal, presenter: boolean): void {
      process.status = 'unauthorized'
      process.refusal = refusal
      this.pushLog('error', i18next.t('plugins.not_authorized', { name: process.name }), group.id, process.id)
      if (!presenter)
        return
      const versions = refusal.versions.map(item => `${item.name}@${item.version}`).join('、')
      process.approvalKey = toast(i18next.t(BLOCK_TITLE[refusal.kind], { name: process.name }), {
        variant: refusal.kind === 'incompatible' ? 'danger' : 'warning',
        timeout: 0,
        // 授权气泡必须一直可点：被新气泡挤掉后没人能再授权它，队列会永远停在等待授权上
        sticky: true,
        description: i18next.t(BLOCK_DESC[refusal.kind], { blocked: versions }),
        actionProps: {
          children: i18next.t('buttons.authorize'),
          onPress: () => {
            void this.approve(process.spec)
          },
        },
        onClose: (reason: ToastCloseReason) => {
          if (reason !== 'dismissed')
            return
          void this.reject(process.spec)
        },
      })
    },

    finish(groupId: string, process: PluginProcess, result: PluginProcessResult): void {
      const group = this.groups.find(item => item.id === groupId)
      // 幂等：cancel 会先给仍在运行的进程结算 'cancelled'，被中断的宿主调用随后 reject
      // 回来时不能再次记账，否则结果、提示与事件都会重复。
      if (group === undefined || !group.pending.includes(process.id)) {
        this.detach(process.id)
        return
      }
      group.pending = group.pending.filter(id => id !== process.id)
      group.results = [...group.results, result]
      if (!result.ok) {
        this.pushLog('error', result.error ?? i18next.t('plugins.action_failed'), groupId, process.id)
      }
      this.detach(process.id)
    },

    detach(processId: string): void {
      this.processes = this.processes.filter(process => process.id !== processId)
    },

    settle(group: PluginGroup): void {
      const results = group.results
      const failed = results.filter(result => !result.ok)
      group.status = 'settled'
      this.groups = this.groups.filter(item => item.id !== group.id)
      group.processIds.forEach(id => this.detach(id))
      this.syncProgress()
      group.resolveDone(results)
      triggerPluginsManagerEvent('completed', results)
      if (failed.length > 0)
        triggerPluginsManagerEvent('error', failed)
      this.presentResults(group, results)
      if (this.groups.length === 0)
        triggerPluginsManagerEvent('allcompleted', results)
    },

    /** 全队列共享的加载气泡：标题按待处理进程总数聚合，因此后入队的组会立刻改变计数 */
    progressTargets(): PluginProcess[] {
      return this.processes.filter(process => process.status !== 'unauthorized')
    },

    progressTitle(processes: PluginProcess[]): string {
      const first = processes[0]
      if (processes.length >= 2) {
        const types = new Set(processes.map(process => process.type))
        return types.size === 1
          ? i18next.t(PROGRESS_MANY[first.type], { count: processes.length })
          : i18next.t('plugins.progress_many', { count: processes.length })
      }
      return i18next.t(PROGRESS_ONE[first.type], { name: first.name })
    },

    syncProgress(): void {
      const processes = this.progressTargets()
      // 提示权只由入队时的 toast 选项决定：面板关闭（presenter 卸载）不该让仍在跑的队列
      // 失去进度气泡与授权入口。
      const wanted = processes.length > 0
        && this.groups.some(group => group.options.toast)
      if (!wanted) {
        this.hideProgress()
        return
      }
      const title = this.progressTitle(processes)
      const description = this.progressDetail === '' ? undefined : this.progressDetail
      // 结果 Toast 会把共享气泡挤出可见限额（见 MAX_VISIBLE_TOASTS）：被淘汰的 key 其
      // update 静默失效，若继续沿用，后续组就完全没有进度提示，故按「已死」重建。
      const current = this.progressKey
      if (current === null || !toast.isActive(current))
        this.progressKey = toast(title, { timeout: 0, isLoading: true, description })
      else
        toast.update(current, { title, isLoading: true, description })
      const key = this.progressKey
      processes.forEach((process) => {
        process.progressKey = key ?? undefined
      })
    },

    hideProgress(): void {
      if (this.progressKey !== null) {
        toast.close(this.progressKey)
        this.progressKey = null
      }
      this.progressDetail = ''
      this.processes.forEach((process) => {
        process.progressKey = undefined
      })
    },

    /** 安装日志的末行即加载气泡的副标题（HeroUI 默认气泡的 description 直接读条目 content） */
    setProgressDetail(line: string): void {
      const current = this.progressKey
      if (current === null || !toast.isActive(current))
        return
      this.progressDetail = line
      toast.update(current, { description: line })
    },

    /**
     * 结果提示：整条队列（一次入队的多个组）跑完才汇报一次。
     *
     * 每个组各自弹结果会互相盖住——用户只看到最后一条，前面失败的原因全被顶掉。因此把结果
     * 攒到队列排空再统一汇报（见 [`presentQueueResults`](self)）。
     */
    presentResults(group: PluginGroup, results: PluginProcessResult[]): void {
      if (!group.options.toast)
        return
      this.queueResults.push(...results)
      if (this.groups.length > 0)
        return
      const pending = this.queueResults
      this.queueResults = []
      this.presentQueueResults(pending, group)
    },

    presentQueueResults(results: PluginProcessResult[], group: PluginGroup): void {
      if (results.length === 0)
        return
      const succeeded = results.filter(result => result.ok).length
      // 汇总不允许有看不见的桶：升级点名的目标版本没装上必定带 `error`，会落进 `failed`；
      // 只有卸载/禁用本来无事可做（already-absent）才算「无需变更」。用户自己取消或拒绝授权
      // 的项（cancelled / rejected）既不算成功也不算失败，也不再追着提示（见 m07292/m07436）。
      const noop = results.filter(result => result.reason === 'already-absent').length
      const failed = results.filter(
        result => !result.ok
          && result.reason !== 'already-absent'
          && result.reason !== 'cancelled'
          && result.reason !== 'rejected',
      ).length
      const restart = group.options.restartOnSettle && succeeded > 0
      // 需要重启时把「重启」按钮挂在结果气泡上：一次操作只留一条。单独再弹一条常驻的重启提示
      // 会和结果提示同时出现，用户看到的就是「两个 toast 说同一件事」。
      let restartKey = ''
      const restartAction = {
        children: i18next.t('app.restart'),
        onPress: () => {
          toast.close(restartKey)
          void harness.restart()
        },
      }
      if (results.length === 1) {
        const [result] = results
        // 用户自己的选择（取消 / 拒绝授权）不再补一条错误提示追问他；其余结果无论成败都要
        // 说出来（失败带 `description: result.error`），否则用户会以为操作没发生。
        if (result.reason === 'cancelled' || result.reason === 'rejected')
          return
        const title = i18next.t(
          result.ok ? RESULT_SUCCESS[result.process.type] : RESULT_FAILED[result.process.type],
          { name: result.process.name },
        )
        restartKey = toast(
          title,
          result.ok
            ? restart
              ? { variant: 'accent', timeout: 0, actionProps: restartAction }
              : { variant: 'default' }
            : { variant: 'danger', description: result.error },
        )
        return
      }
      const parts = [
        succeeded > 0 ? i18next.t('plugins.queue_summary_success', { count: succeeded }) : '',
        failed > 0 ? i18next.t('plugins.queue_summary_failed', { count: failed }) : '',
        noop > 0 ? i18next.t('plugins.queue_summary_skipped', { count: noop }) : '',
      ].filter(part => part !== '')
      restartKey = toast(i18next.t('plugins.queue_summary'), {
        description: parts.join(' · '),
        variant: failed > 0 ? 'danger' : restart ? 'accent' : 'default',
        timeout: restart ? 0 : undefined,
        actionProps: restart ? restartAction : undefined,
      })
    },

    async approve(refs?: PluginRef | PluginRef[]): Promise<PluginProcessResult[]> {
      const group = this.activeGroup()
      if (!group)
        return []
      const targets = this.approvalTargets(group, refs)
      if (targets.length === 0)
        return group.done
      for (const process of targets) {
        const refusal = process.refusal
        if (!refusal)
          continue
        try {
          await invoke<void>(refusal.kind === 'incompatible' ? 'allow_plugin_versions' : 'allow_plugin_policy_versions', {
            versions: refusal.versions,
          })
        }
        catch (error) {
          const message = errorMessage(error)
          this.pushLog('error', message, group.id, process.id)
          if (group.options.toast) {
            toast(i18next.t('plugins.authorize_failed'), {})
          }
          continue
        }
        if (process.approvalKey !== undefined) {
          toast.close(process.approvalKey)
          process.approvalKey = undefined
        }
        process.refusal = undefined
        process.status = 'pending'
        triggerPluginsManagerEvent('approve', process)
      }
      group.resume?.()
      return group.done
    },

    async reject(ref: PluginRef): Promise<PluginProcessResult[]> {
      const normalized = normalizeRef(ref)
      const group = this.activeGroup()
      if (!group)
        return []
      const process = this.approvalTargets(group, normalized.spec).find(
        item => item.name === normalized.name || item.spec === normalized.spec,
      )
      if (!process)
        return group.done
      if (process.approvalKey !== undefined) {
        toast.close(process.approvalKey)
        process.approvalKey = undefined
      }
      this.finish(group.id, process, {
        process,
        ok: false,
        error: i18next.t('plugins.rejected'),
        reason: 'rejected',
      })
      group.resume?.()
      return group.done
    },

    async cancel(): Promise<void> {
      const group = this.activeGroup()
      if (!group || this.cancelling)
        return
      this.cancelling = true
      try {
        await invoke<void>('cancel_plugin_processes')
      }
      catch (error) {
        this.pushLog('error', errorMessage(error), group.id)
      }
      const remaining = group.pending
        .map(id => this.processes.find(process => process.id === id))
        .filter((process): process is PluginProcess => process !== undefined)
      remaining.forEach((process) => {
        if (process.approvalKey !== undefined) {
          toast.close(process.approvalKey)
          process.approvalKey = undefined
        }
        this.finish(group.id, process, {
          process,
          ok: false,
          error: i18next.t('plugins.cancelled'),
          reason: 'cancelled',
        })
      })
      this.cancelling = false
      group.resume?.()
    },

    async search(refs: PluginRef | PluginRef[], options?: { dsh?: string }): Promise<PluginSearchResult[]> {
      const normalized = normalizeRefs(refs)
      const specs = normalized.map(item => item.spec)
      try {
        const inspected = await invoke<PluginInspectPayload[]>('inspect_plugin_specs', {
          specs,
          dsh: options?.dsh ?? null,
        })
        return inspected.map(item => ({
          spec: item.spec,
          name: item.name,
          version: item.version,
          compatible: item.compatible ?? null,
          peers: item.peers,
          problem: item.problem,
        }))
      }
      catch (error) {
        this.pushLog('error', errorMessage(error))
        return specs.map(spec => ({ spec, compatible: null, problem: 'network' as const }))
      }
    },

    activeGroup(): PluginGroup | undefined {
      return this.groups.find(item => item.id === this.activeGroupId)
    },

    approvalTargets(group: PluginGroup, refs?: PluginRef | PluginRef[]): PluginProcess[] {
      const unauthorized = group.pending
        .map(id => this.processes.find(process => process.id === id))
        .filter((process): process is PluginProcess => process !== undefined && process.status === 'unauthorized')
      if (refs === undefined)
        return unauthorized
      const normalized = normalizeRefs(refs)
      const names = new Set(normalized.map(item => item.name))
      return unauthorized.filter(process => names.has(process.name))
    },
  },
})
