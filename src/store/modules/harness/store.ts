import type { UnlistenFn } from '@tauri-apps/api/event'
import type { StartupPhase } from './readiness'
import type {
  HarnessProcessExitedPayload,
  InstallerState,
  InstallProgress,
  InternalPluginsPhasePayload,
  PatchRepairAction,
  SetupStatus,
  SidebarBusyAction,
  StartupError,
} from './types'
import type { PatchEntryStripReport, PatchQuarantineReport } from '@/types/plugin'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import i18next from 'i18next'
import { defineStore } from 'valtio-define'
import { queryClient } from '@/config/client'
import { hooks } from '@/config/hooks'
import { queryKeys } from '@/config/query-keys'
import { harnessUpdater } from '../harness-updater'
import { preinstall } from '../preinstall'
import { recovery } from '../recovery'
import { setting } from '../setting'
import {
  IFRAME_FRAME_GRACE_TIMEOUT,
  IFRAME_LOAD_TIMEOUT,
  IFRAME_RECOVERY_ABSOLUTE_TIMEOUT,
  IFRAME_RELOAD_MAX_ATTEMPTS,
  PLUGIN_ABSOLUTE_TIMEOUT,
  PLUGIN_ACTIVITY_CHECK_INTERVAL,
  PLUGIN_INACTIVITY_TIMEOUT,
  STARTUP_ABSOLUTE_TIMEOUT,
} from './constants'
import { BoundedReloadGate, SingleFlight, waitForActivityTask } from './readiness'
import { runtimeExitMessageKey, shouldAcceptRuntimeExit } from './runtime'
import {
  attachStartupDiagnostics,
  checkHealthViaProxy,
  generateTimestampedUrl,
  internalPluginReason,
  notifyPatchEntryStrip,
  notifyPatchQuarantine,
  pollHarnessReadiness,
  startupError,
} from './utils'

/** 启动阶段 → 加载文案 i18n 键（webview 的 Loadable 副标题） */
const STARTUP_STATUS_KEYS: Record<StartupPhase, string> = {
  'plugin-install': 'status.loading_internal',
  'process-boot': 'status.loading_process',
  'client-modules': 'status.loading_client_modules',
}

/** 补丁层修复动作的失败日志前缀（保留各入口原有的可检索文案） */
const PATCH_REPAIR_LOG: Record<PatchRepairAction, string> = {
  'safe-mode': '[Harness] enter safe mode failed:',
  'quarantine': '[Harness] quarantine broken patch layers failed:',
  'strip': '[Harness] strip unresolved patch entries failed:',
}

const initialInstaller: InstallerState = {
  title: '',
  detail: '',
  percentage: 0,
  logs: [],
}

/** 启动流程令牌：boot 并发/重复调用时只采纳最后一次的结果 */
let bootToken = 0
/** 最终健康复核到 ready 提交之间的启动代；退出事件可使该提交失效。 */
let readinessCommitToken: number | null = null
/** 首次自动启动去重（React StrictMode 会重复挂载 effect） */
let bootStarted = false
let pluginActivitySequence = 0
let pluginActivityReason = ''
const restartFlight = new SingleFlight<void>()
const iframeReloadGate = new BoundedReloadGate(IFRAME_RELOAD_MAX_ATTEMPTS)
let iframeRefreshTimer: ReturnType<typeof setTimeout> | undefined

/**
 * 桌面外壳核心业务模块：安装/启动流程、服务生命周期（启动/健康检查/重启/停止）、
 * iframe 加载状态与挂起兜底。
 *
 * 拆分说明（参考 damn-reports 的 store 组织方式）：
 * - 版本更新 → `harness-updater`，下载完成提示 → `download`；
 * - 预装插件引导 → `preinstall`，插件异常修复 → `recovery`；
 * - 无状态的探测/日志/错误装饰 → `utils`，时序常量 → `constants`。
 * 本模块只保留「服务怎么起来、页面怎么挂上」这一条主线。
 */
export const harness = defineStore({
  state: () => ({
    status: 'ready' as SetupStatus,
    installer: initialInstaller,
    errorMsg: '',
    /** 启动失败时从 dsh 服务日志中读取的真实错误行（Loadable 错误态日志面板） */
    errorLogs: [] as string[],
    /** 识别到插件路由冲突时的针对性提示（Loadable children 展示） */
    pluginConflictHint: '',
    /** 识别到 Linux inotify 文件监视上限（ENOSPC）时的针对性提示（Loadable children 展示） */
    inotifyLimitHint: '',
    /** 识别到补丁层 YAML 语法错误时的针对性提示（含文件与行列号，Loadable children 展示） */
    patchLayerHint: '',
    heapOomHint: '',
    serviceUrl: 'http://127.0.0.1:3080',
    /** 带时间戳的 iframe 地址（boot 时生成一次，避免缓存） */
    iframeSrc: '',
    iframeLoaded: false,
    iframeError: false,
    /**
     * 已确认承载 dsh 文档的 iframe 代（`iframeKey`）。
     *
     * iframe 的 load 事件不足以证明页面加载成功：浏览器内部错误页（代理拦截、
     * DNS 失败等）同样触发 load，且永远不会发出帧内消息（issue #705）。因此页面
     * 是否真的起来只以「帧内自报」为准，并把确认绑定到具体那一代 iframe——重挂
     * 之后旧文档的迟到消息不能替新文档背书。
     */
    iframeAliveKey: null as number | null,
    iframeKey: 0,
    serviceHealthy: false,
    serviceRunning: false,
    startupPhase: 'plugin-install' as StartupPhase,
    startupReason: '',
    busyAction: null as SidebarBusyAction,
  }),
  getters: {
    /** 当前启动阶段对应的加载文案 i18n 键 */
    startupStatusKey(): string {
      return STARTUP_STATUS_KEYS[this.startupPhase]
    },
    /** 服务健康但 iframe 加载失败：页面覆盖层展示重试入口 */
    showIframeError(): boolean {
      return this.serviceHealthy && this.iframeError
    },
    /** 当前这一代 iframe 是否已自报承载 dsh 文档（重挂即失效，见 `iframeAliveKey`） */
    iframeAlive(): boolean {
      return this.iframeAliveKey === this.iframeKey
    },
    /**
     * 内嵌页面加载失败的补充说明：服务已就绪却没有任何帧内消息，说明帧里根本没
     * 起来 dsh 页面（典型是一张浏览器内部错误页），而不是服务没跑起来。
     */
    iframeErrorHint(): string {
      return this.iframeAlive ? '' : i18next.t('ui.iframe_unreachable_hint')
    },
  },
  actions: {
    /** 首次挂载时自动启动（StrictMode 重复挂载下保证只执行一次） */
    startup() {
      if (bootStarted)
        return
      bootStarted = true
      void this.initialize()
    },

    async initialize() {
      await Promise.all([
        recovery.listen(),
        this.listenInternalPhase(),
        this.listenProcessExit(),
      ])
      await this.boot()
    },

    /** 订阅当前持有的 Harness 根进程退出事件，及时撤下失效 iframe。 */
    async listenProcessExit() {
      try {
        await listen<HarnessProcessExitedPayload>('harness-process-exited', (event) => {
          void this.handleProcessExit(event.payload)
        })
      }
      catch (err) {
        console.error('[Harness] failed to listen harness-process-exited:', err)
      }
    },

    /**
     * 处理运行期退出：先通过 ownership-aware 健康代理确认事件仍属于当前代，
     * 避免延迟事件覆盖已重启的新进程；确认后使旧启动链失效并展示可重试错误页。
     */
    async handleProcessExit(payload: HarnessProcessExitedPayload) {
      const observedToken = bootToken
      if (!shouldAcceptRuntimeExit({
        serviceHealthy: this.serviceHealthy,
        serviceRunning: this.serviceRunning,
        readinessCommitPending: readinessCommitToken === observedToken,
        busyAction: this.busyAction,
        observedToken,
        currentToken: bootToken,
        notOwned: true,
      })) {
        return
      }

      const probe = await checkHealthViaProxy()
      if (!shouldAcceptRuntimeExit({
        serviceHealthy: this.serviceHealthy,
        serviceRunning: this.serviceRunning,
        readinessCommitPending: readinessCommitToken === observedToken,
        busyAction: this.busyAction,
        observedToken,
        currentToken: bootToken,
        notOwned: probe.notOwned,
      })) {
        return
      }

      const exitToken = ++bootToken
      const message = i18next.t(runtimeExitMessageKey(payload.exitCode), {
        code: payload.exitCode,
      })
      let exitDetail = '(exit code unavailable)'
      if (payload.exitCode != null)
        exitDetail = `(exit code ${payload.exitCode})`
      console.warn(
        `[Harness] owned process ${payload.pid} exited unexpectedly`,
        exitDetail,
      )
      iframeReloadGate.reset()
      if (iframeRefreshTimer !== undefined) {
        clearTimeout(iframeRefreshTimer)
        iframeRefreshTimer = undefined
      }
      this.serviceHealthy = false
      this.iframeLoaded = false
      this.iframeError = false
      this.iframeAliveKey = null
      this.fail(message)

      const error = await attachStartupDiagnostics(new Error(message), true)
      if (exitToken !== bootToken)
        return
      await recovery.reviewStartupRecovery(
        error.logLines ?? error.logs ?? [],
        () => exitToken === bootToken,
      )
      if (exitToken !== bootToken)
        return
      this.fail(
        error.message,
        error.logs,
        error.pluginConflictHint,
        error.inotifyLimitHint,
        undefined,
        error.patchLayerHint,
        error.heapOomHint,
      )
    },

    /**
     * 订阅后端「内置插件核对阶段」推送：`internal-plugins-phase` 事件
     * （loading / progress / done），加载屏据此在「Loading internal plugins…」与
     * 「Loading plugins…」之间切换。事件在服务启动前发出，健康轮询期间到达。
     */
    async listenInternalPhase() {
      try {
        await listen<InternalPluginsPhasePayload>('internal-plugins-phase', (event) => {
          const payload = event.payload
          pluginActivitySequence++
          pluginActivityReason = internalPluginReason(
            payload,
            pluginActivityReason,
            (key, options) => i18next.t(key, options),
          )
          if (payload.phase !== 'done') {
            this.startupPhase = 'plugin-install'
            this.startupReason = pluginActivityReason
          }
        })
      }
      catch (err) {
        console.error('[Harness] failed to listen internal-plugins-phase:', err)
      }
    },

    /** 刷新 iframe：清除加载态并延迟重新挂载 */
    refreshIframe() {
      this.iframeLoaded = false
      this.iframeError = false
      this.iframeAliveKey = null
      if (iframeRefreshTimer !== undefined) {
        clearTimeout(iframeRefreshTimer)
      }
      iframeRefreshTimer = setTimeout(() => {
        iframeRefreshTimer = undefined
        this.iframeKey++
      }, 800)
    },

    /** iframe 加载成功/失败时由视图回调更新状态 */
    markIframeLoaded() {
      this.iframeLoaded = true
      this.iframeError = false
    },

    markIframeError() {
      this.iframeError = true
      this.iframeLoaded = false
    },

    /** 帧内任一桥消息到达：确认帧里确实跑着 dsh 页面（load 事件不算数，见 state 注释） */
    markIframeAlive() {
      this.iframeAliveKey = this.iframeKey
    },

    /**
     * 帧内文档开始离开（pagehide）：旧确认立即作废。
     *
     * 帧内导航（dsh 页面把整帧跳到远端登录/错误页）不换 iframe 元素，只靠代绑定
     * 抓不到；新文档要么自己重新自报，要么在宽限窗内被判成「帧里没有 dsh 页面」。
     * 同时撤回 load 结论：这一代已经没有任何已加载的文档了。
     */
    markIframeLeaving() {
      this.iframeAliveKey = null
      this.iframeLoaded = false
    },

    markIframeBootReady() {
      iframeReloadGate.markReady()
      if (iframeRefreshTimer !== undefined) {
        clearTimeout(iframeRefreshTimer)
        iframeRefreshTimer = undefined
      }
    },

    async recoverIframeBoot() {
      const generation = this.iframeKey
      const decision = iframeReloadGate.request(generation)
      if (decision === 'duplicate' || decision === 'ready')
        return
      if (decision === 'exhausted') {
        const reason = i18next.t('errors.client_boot_stalled')
        const error = startupError('client-modules', reason, 'absolute')
        this.fail(error.message, undefined, undefined, undefined, this.serviceRunning)
        return
      }

      const result = await pollHarnessReadiness(
        IFRAME_RECOVERY_ABSOLUTE_TIMEOUT,
        () => generation === this.iframeKey && this.serviceRunning,
      )
      if (generation !== this.iframeKey || !this.serviceRunning)
        return
      if (result.healthy) {
        this.refreshIframe()
        return
      }

      const phase = result.phase ?? 'client-modules'
      const reason = result.reason ?? i18next.t('errors.no_readiness_reason')
      const kind = result.notOwned ? 'exited' : result.timeout ?? 'failed'
      const error = startupError(phase, reason, kind)
      this.fail(error.message, undefined, undefined, undefined, !result.notOwned)
    },

    /**
     * iframe 内官方 boot 失败页上报（dsh://plugin-boot:failed）：
     * 立即把壳层切到错误界面并展示失败页文本（如 `web boot: 1 entry did not
     * activate`），同时尝试从日志定位问题插件弹出修复界面。
     */
    async handleIframeBootFailure(detail?: string) {
      const message = detail && detail.includes('Failed to load plugins')
        ? detail
        : i18next.t('errors.client_boot_failed')
      const error = await attachStartupDiagnostics(new Error(message))
      // 失败页文本是最直接的证据，优先作为日志行参与插件定位（pending 行正则
      // 可命中 `dsh-tauri-rightclick: pending (waiting for service: remote.session)`）
      const lines = [
        ...(detail ? detail.split(/\n/) : []),
        ...(error.logLines ?? error.logs ?? []),
      ]
      await recovery.reviewStartupRecovery(lines)
      this.fail(
        error.message,
        error.logs,
        error.pluginConflictHint,
        error.inotifyLimitHint,
        this.serviceRunning,
        error.patchLayerHint,
      )
    },

    /** 安装进度流：只前进不后退，供首次安装/手动更新共用 */
    async listenInstallProgress(): Promise<UnlistenFn> {
      return listen<InstallProgress>('install-progress', (e) => {
        const payload = e.payload
        if (payload.percentage < this.installer.percentage) {
          return
        }
        const logs = payload.log
          ? [...this.installer.logs, payload.log].slice(-5)
          : this.installer.logs
        this.installer = {
          title: payload.title || this.installer.title,
          detail: payload.detail || this.installer.detail,
          percentage: payload.percentage,
          logs,
        }
      })
    },

    /** 服务探测通过后的统一收尾；token 用于阻止旧启动流程覆盖新状态 */
    async completeReadiness(token: number): Promise<boolean> {
      if (token !== bootToken)
        return false

      // poll 通过与 ready 提交之间仍可能退出，因此提交窗口开启前复核一次 ownership；
      // 但不再为此重跑全量探测（实测 93 个 / 18MB / 311ms，纯粹推迟 iframe 挂载）：
      // ownership 只取决于后端进程槽位与启动守卫，纯内存查询即可判定。上一轮 poll 已
      // 确认就绪，故只有 ownership 丢失才推翻结果，短暂 IPC 失败不降级。
      let ownershipFailure: string | null = null
      try {
        await invoke('harness_ownership')
      }
      catch (err) {
        ownershipFailure = String(err)
      }
      if (token !== bootToken)
        return false
      if (ownershipFailure?.includes('HARNESS_NOT_OWNED')) {
        this.serviceRunning = false
        throw startupError('process-boot', ownershipFailure, 'exited')
      }

      const readyInfo = await invoke<{ service_url: string }>('get_runtime_info')
      if (token !== bootToken)
        return false

      this.serviceUrl = readyInfo.service_url
      this.iframeSrc = generateTimestampedUrl(readyInfo.service_url)
      this.serviceHealthy = true
      this.serviceRunning = true
      this.status = 'ready'
      this.errorMsg = ''
      this.errorLogs = []
      this.pluginConflictHint = ''
      this.inotifyLimitHint = ''
      this.patchLayerHint = ''
      this.heapOomHint = ''
      preinstall.error = ''
      // 服务（重）启动成功：清空插件异常修复态（若曾进入），并重置已「暂不处理」的插件
      recovery.reset()
      iframeReloadGate.reset()
      if (iframeRefreshTimer !== undefined) {
        clearTimeout(iframeRefreshTimer)
        iframeRefreshTimer = undefined
      }
      // 服务（重）启动成功后，dsh 版本/端口/CLI 链接状态等运行时信息可能已变化
      // （典型：Harness 更新后旧版本缓存仍在，调试侧边栏需刷新页面才显示新版本）。
      // 使侧边栏相关查询缓存失效，重新打开/已挂载时自动拉取最新值。
      void queryClient.invalidateQueries({ queryKey: queryKeys.info })
      void queryClient.invalidateQueries({ queryKey: queryKeys.cliStatus })
      // 档案/核心切换后重启：当前档案的插件列表、核心来源状态一并刷新
      void queryClient.invalidateQueries({ queryKey: queryKeys.plugins })
      void queryClient.invalidateQueries({ queryKey: queryKeys.profiles })
      void queryClient.invalidateQueries({ queryKey: queryKeys.cores })
      return true
    },

    /** 拉起服务并等待健康检查通过，通过后才允许挂载 iframe */
    async launchAndWait(token?: number) {
      this.status = 'ready'
      this.installer = initialInstaller
      this.errorMsg = ''
      this.errorLogs = []
      this.pluginConflictHint = ''
      this.inotifyLimitHint = ''
      this.patchLayerHint = ''
      this.heapOomHint = ''
      recovery.reset()
      this.serviceHealthy = false
      this.iframeLoaded = false
      this.iframeError = false
      this.iframeAliveKey = null
      this.startupPhase = 'process-boot'
      this.startupReason = i18next.t('status.loading_process')
      try {
        await invoke('launch_harness')
        this.serviceRunning = true
        this.startupPhase = 'process-boot'
        this.startupReason = i18next.t('status.loading_process')
        // 后端遇到端口占用时会自动递增并持久化端口，启动后重新读取真实地址。
        const runtimeInfo = await invoke<{ service_url: string }>('get_runtime_info')
        this.serviceUrl = runtimeInfo.service_url
        this.iframeSrc = generateTimestampedUrl(runtimeInfo.service_url)

        const result = await pollHarnessReadiness(
          STARTUP_ABSOLUTE_TIMEOUT,
          () => token === undefined || token === bootToken,
          (probe) => {
            if (probe.phase) {
              this.startupPhase = probe.phase
            }
            this.startupReason = probe.reason ?? ''
          },
        )
        if (token !== undefined && token !== bootToken) {
          return
        }
        if (!result.healthy) {
          const phase = result.phase ?? this.startupPhase
          const reason = result.reason ?? (this.startupReason || i18next.t('errors.no_readiness_reason'))
          if (result.notOwned) {
            this.serviceRunning = false
            throw startupError(phase, reason, 'exited')
          }
          if (result.timeout) {
            throw startupError(phase, reason, result.timeout)
          }
          throw startupError(phase, reason, 'failed')
        }
        // 服务已就绪后再取一次真实地址：`launch_harness` 可能因后端已在并发拉起
        // （auto_start）而提前返回，此刻端口若尚未落库，上面读到的 service_url 会是
        // 旧端口；健康检查通过意味着服务已在最终端口就绪，此时读取必然准确。
        // 避免 iframe 挂载到一个无人监听的地址（表现为首次加载失败、刷新后恢复）。
        const readinessToken = token ?? bootToken
        readinessCommitToken = readinessToken
        try {
          await this.completeReadiness(readinessToken)
        }
        finally {
          if (readinessCommitToken === readinessToken)
            readinessCommitToken = null
        }
      }
      catch (err) {
        // 失败时附上服务日志里的真实错误行，供错误界面展示而不是只显示超时文案
        const error = err instanceof Error ? err : new Error(String(err))
        throw await attachStartupDiagnostics(error, error.message.includes('HARNESS_NOT_OWNED') || error.message.includes('Harness exited early'))
      }
    },

    /** 启动流程：检测环境/安装依赖 → 拉起服务 → 已安装时后台检查更新 */
    async boot() {
      const token = ++bootToken
      iframeReloadGate.reset()
      if (iframeRefreshTimer !== undefined) {
        clearTimeout(iframeRefreshTimer)
        iframeRefreshTimer = undefined
      }
      // 回到加载态：已安装时不再显示检测/启动界面，直接进入页面加载状态
      this.serviceHealthy = false
      this.iframeLoaded = false
      this.iframeError = false
      this.iframeAliveKey = null
      // 重新启动/进入启动流程时先退出上一轮的错误与修复态（重启可能由插件修复、
      // 配置切换触发），避免旧的「启动失败 / Preview」等信息在启动期间闪现。
      // 注意：保留 attempts 计数，连续失败仍能命中「频繁失败」提示。
      this.errorMsg = ''
      this.errorLogs = []
      this.pluginConflictHint = ''
      this.inotifyLimitHint = ''
      this.patchLayerHint = ''
      this.heapOomHint = ''
      recovery.clear()
      this.status = 'ready'
      let unlistenInstall: UnlistenFn | null = null

      try {
        // 事件监听失败（例如 IPC 自定义协议被 CSP 拦截、回退 postMessage 也异常）
        // 不应阻断启动流程，因此容错跳过。
        try {
          unlistenInstall = await this.listenInstallProgress()
        }
        catch (err) {
          console.error('[Harness] failed to listen install-progress:', err)
        }
        const runtimeInfo = await invoke<{ service_url: string }>('get_runtime_info')
        this.serviceUrl = runtimeInfo.service_url
        this.iframeSrc = generateTimestampedUrl(runtimeInfo.service_url)

        // 已安装过则跳过安装界面，避免每次启动都闪现"正在安装依赖..."
        // 设置由 setting store 持有（与 Rust 共享同一份 .store.dat）。必须先等水合
        // 完成再读，否则会把默认值当成真实安装状态：多跑一次安装，还漏掉更新检查。
        await setting.refresh()
        // 取快照：后面的 `install_dependencies` 会把 installed 置位并广播，
        // 而本次 boot 的判断应当基于「启动开始时是否已安装」
        const config = { ...setting.$state }

        // 每次启动都做纯本地运行时检查：旧版本升级后 installed 仍为 true，但新版
        // 可能新增依赖（如 Windows 空白环境需要的 MinGit），必须进入幂等自愈。
        // 已全部就绪时不调用安装命令，因此不会联网，也不会闪现安装界面。
        const ready = await invoke<boolean>('runtime_ready')
        if (!ready || !config.installed) {
          if (!ready) {
            this.status = 'installing'
            this.installer = { ...initialInstaller, title: i18next.t('status.installing') }
          }
          await invoke('install_dependencies')
        }

        // 内置插件自愈是独立、显式且有界的启动阶段。后端 heartbeat 只延长无活动
        // deadline，绝对上限不会延长；旧启动 token 失效时立即停止采纳结果。
        this.startupPhase = 'plugin-install'
        this.startupReason = i18next.t('status.loading_internal')
        pluginActivitySequence++
        pluginActivityReason = i18next.t('status.internal_waiting')
        try {
          const result = await waitForActivityTask({
            task: invoke('ensure_internal_plugins'),
            getActivity: () => ({
              sequence: pluginActivitySequence,
              reason: pluginActivityReason,
            }),
            inactivityTimeoutMs: PLUGIN_INACTIVITY_TIMEOUT,
            absoluteTimeoutMs: PLUGIN_ABSOLUTE_TIMEOUT,
            intervalMs: PLUGIN_ACTIVITY_CHECK_INTERVAL,
            shouldContinue: () => token === bootToken,
          })
          if (result.cancelled) {
            return
          }
          if (result.timeout) {
            try {
              // 后端只在所属进程树已退出、共享 flight 已释放后返回；在此之前不
              // 进入失败态，避免用户立即 Retry 订阅到上一轮 cancelled 结果。
              await invoke('cancel_internal_plugins')
            }
            catch (cancelError) {
              console.error('[Harness] failed to cancel timed-out internal plugin install:', cancelError)
              throw startupError('plugin-install', String(cancelError), 'failed')
            }
            throw startupError('plugin-install', result.reason, result.timeout)
          }
        }
        catch (err) {
          if (err instanceof Error && (err as StartupError).phase) {
            throw err
          }
          throw startupError('plugin-install', String(err), 'failed')
        }
        // 预装插件引导：首次安装、老版本升级（无指纹基线）或清单 plugins 节
        // 内容变更（社区新增推荐插件）时重新进入预设流程，装完/跳过后才拉起服务。
        // 清单随安装包发布、每次安装被强制覆盖，旧内容不可比对，
        // 由 Rust 侧记录内容指纹到 app-data（.store.dat），启动时比对是否有变更。
        if (await invoke<boolean>('get_preinstall_pending')) {
          this.status = 'preinstall'
          preinstall.isFirstTime = true
          await preinstall.load()
          return
        }

        await this.launchAndWait(token)

        if (token !== bootToken)
          return
        // 已安装时后台静默检查新版，发现后提示用户
        if (config.installed) {
          void harnessUpdater.checkForUpdate()
        }
      }
      catch (err) {
        if (token !== bootToken)
          return
        console.error('[Harness] startup failed:', err)
        const error = await attachStartupDiagnostics(err)
        // 尝试从日志定位问题插件：能定位则弹出修复界面（全屏恢复页）
        await recovery.reviewStartupRecovery(error.logLines ?? error.logs ?? [])
        this.fail(
          error.message,
          error.logs,
          error.pluginConflictHint,
          error.inotifyLimitHint,
          this.serviceRunning,
          error.patchLayerHint,
          error.heapOomHint,
        )
      }
      finally {
        unlistenInstall?.()
      }
    },

    /** 进入安装态（手动更新前复用，标题区分"安装/更新"） */
    prepareInstall(title: string) {
      this.status = 'installing'
      this.installer = { ...initialInstaller, title }
    },

    /** 进入错误态（供本模块与 harness-updater 模块共用） */
    fail(message: string, logs?: string[], pluginConflictHint?: string, inotifyLimitHint?: string, keepServiceRunning = false, patchLayerHint?: string, heapOomHint?: string) {
      this.errorMsg = message
      this.errorLogs = logs ?? []
      this.pluginConflictHint = pluginConflictHint ?? ''
      this.inotifyLimitHint = inotifyLimitHint ?? ''
      this.patchLayerHint = patchLayerHint ?? ''
      this.heapOomHint = heapOomHint ?? ''
      this.status = 'error'
      this.serviceRunning = keepServiceRunning
    },

    /** 重启服务：先强杀再拉起，最终回到就绪/错误态 */
    restart(): Promise<void> {
      return restartFlight.run(async () => {
        if (this.busyAction)
          return
        this.busyAction = 'restart'
        // 重启旧进程前先撤下旧 iframe；这样延迟到达的旧进程退出事件不会被
        // 误当成新一代启动失败。新进程通过 completeReadiness 后再恢复 healthy。
        this.serviceHealthy = false
        this.iframeLoaded = false
        this.iframeError = false
        // 手动重启（含修复界面上的「重启 Harness」）：先退出恢复态，
        // 若重启仍失败，boot 的 catch 会重新定位问题插件并再次弹出。
        recovery.hide()
        try {
          void hooks['config.dialog.hidden'].trigger()
          await invoke('shutdown_harness')
        }
        catch (err) {
          console.error('[Harness] shutdown during restart failed:', err)
        }
        this.serviceRunning = false
        try {
          await this.boot()
        }
        finally {
          this.busyAction = null
        }
      })
    },

    /**
     * 进入安全模式：切到 safe 档案（仅核心 bundles、无用户插件）并重启服务。
     * 启动失败的插件（如 pending waiting for service）被隔离，应用先恢复可用；
     * 用户在档案列表切回原档案即退出安全模式。
     *
     * 后端同时会隔离「解析不了的补丁层」（安全档案层 + home 层，见
     * `service::plugin::patch_guard`）：home 层作用于所有档案，不隔离的话一处
     * 手写笔误会让安全模式也起不来（issue #525）。结果用 toast 告知备份路径。
     */
    async enterSafeMode() {
      await this.runPatchRepair('safe-mode', async () => {
        const report = await invoke<PatchQuarantineReport>('enter_safe_mode')
        notifyPatchQuarantine(report)
      })
    },

    /**
     * 隔离解析不了的补丁层（当前档案层 + home 层）并重启：错误页在补丁层语法
     * 错误时的专用恢复入口，让用户留在自己的档案里恢复，不切档案、不动插件。
     * 补丁文件只改名保存为 `.broken-<时间戳>` 备份，修好语法后改回原名即可恢复。
     */
    async quarantineBrokenPatchLayers() {
      await this.runPatchRepair('quarantine', async () => {
        const report = await invoke<PatchQuarantineReport>('quarantine_broken_patch_layers')
        notifyPatchQuarantine(report)
      })
    },

    /**
     * 移除补丁层里解析不到包的 insert 条目并重启：错误页在「补丁层引用了未安装的
     * 包」时的专用恢复入口（与语法错误的「隔离」入口互斥，见 setup.tsx）。
     *
     * 判定与启动前预检完全一致，只剥离悬空条目——同一条目里的其它 insert、其它
     * 条目与其它配置原样保留，因此不会顺手删掉还能用的插件。改写前先把原文件备份
     * 成 `.bak-<时间戳>`，结果用 toast 告知备份路径。
     */
    async stripUnresolvedPatchEntries() {
      await this.runPatchRepair('strip', async () => {
        const report = await invoke<PatchEntryStripReport>('strip_unresolved_patch_entries')
        notifyPatchEntryStrip(report)
      })
    },

    /**
     * 补丁层修复动作的共用骨架：在第一个 await 之前就占住忙态并推进 bootToken。
     * 修复本身可能耗到秒级，这期间退出处理器的自动恢复若照常判定，就会把用户刚
     * 点下的这次修复覆盖掉（它自己随后也要重启）；推进令牌让在飞的启动链与自动
     * 恢复一次性作废。忙态在交给 restart 之前释放——restart 自己会重新占住它。
     */
    async runPatchRepair(action: PatchRepairAction, repair: () => Promise<void>) {
      if (this.busyAction)
        return
      ++bootToken
      this.busyAction = 'repair'
      try {
        await repair()
      }
      catch (err) {
        console.error(PATCH_REPAIR_LOG[action], err)
        const error = await attachStartupDiagnostics(err)
        this.fail(
          error.message,
          error.logs,
          error.pluginConflictHint,
          error.inotifyLimitHint,
          undefined,
          error.patchLayerHint,
        )
        return
      }
      finally {
        this.busyAction = null
      }
      await this.restart()
    },

    /** 停止服务并回到停止态界面 */
    async shutdown() {
      if (this.busyAction)
        return
      this.busyAction = 'shutdown'
      // 停止服务后应用回到「已停止」态，配置弹窗已无意义，与 restart 一致地关闭它
      void hooks['config.dialog.hidden'].trigger()
      try {
        await invoke('shutdown_harness')
      }
      catch (err) {
        console.error('[Harness] shutdown failed:', err)
      }
      finally {
        this.busyAction = null
      }
      this.serviceRunning = false
      this.status = 'error'
      this.errorMsg = i18next.t('ui.stopped')
      this.errorLogs = []
      this.pluginConflictHint = ''
      this.inotifyLimitHint = ''
      this.patchLayerHint = ''
      this.heapOomHint = ''
      recovery.reset()
    },

    /** 服务未运行时点击"重试"：重新拉起服务并等待健康检查 */
    async start() {
      if (this.busyAction)
        return
      this.busyAction = 'start'
      try {
        await this.boot()
      }
      finally {
        this.busyAction = null
      }
    },

    /** 在系统浏览器中打开服务地址 */
    async openBrowser() {
      if (this.busyAction)
        return
      this.busyAction = 'openBrowser'
      try {
        await invoke('open_in_browser')
      }
      catch (err) {
        console.error('[Harness] open in browser failed:', err)
      }
      finally {
        this.busyAction = null
      }
    },
  },
})

// 进入 ready 后 iframe 始终没有自报「帧里跑着 dsh 页面」→ 转为错误界面，避免一直
// 停在黑色加载遮罩。判定只看帧内自报，不看 load：浏览器内部错误页（代理拦截、DNS
// 失败等）同样触发 load 却永远没有帧内消息，只按 load 判定就会把一张浏览器错误页
// 当成加载成功——壳层既不给重试入口也不报错，用户只能重启电脑（issue #705）。
let iframeWatch: { loaded: boolean, timer: ReturnType<typeof setTimeout> } | null = null
harness.$subscribe(() => {
  const { status, serviceHealthy, iframeLoaded, iframeError } = harness.$state
  const watching = status === 'ready' && serviceHealthy && !harness.iframeAlive && !iframeError
  if (!watching) {
    if (iframeWatch) {
      clearTimeout(iframeWatch.timer)
      iframeWatch = null
    }
    return
  }
  // 帧已提交文档（load 已触发）却没有帧内消息：只剩「帧里是浏览器错误页」这种可能，
  // 用远短于整体加载上限的宽限窗口尽快给出可重试界面。
  if (iframeWatch?.loaded === iframeLoaded)
    return
  if (iframeWatch) {
    clearTimeout(iframeWatch.timer)
  }
  iframeWatch = {
    loaded: iframeLoaded,
    timer: setTimeout(() => {
      iframeWatch = null
      console.warn('[Harness] iframe never confirmed a dsh document, showing retryable error')
      harness.iframeLoaded = false
      harness.iframeError = true
    }, iframeLoaded ? IFRAME_FRAME_GRACE_TIMEOUT : IFRAME_LOAD_TIMEOUT),
  }
})
