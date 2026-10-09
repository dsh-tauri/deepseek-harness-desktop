/* eslint-disable no-control-regex */
import type { ReadinessPollResult, ReadinessProbeResult, StartupPhase } from './readiness'
import type { InternalPluginsPhasePayload, StartupError } from './types'
import type { PatchEntryStripReport, PatchQuarantineReport } from '@/types/plugin'
import { promiseTimeout } from '@reause/core'
import { invoke } from '@tauri-apps/api/core'
import i18next from 'i18next'
import { containsHeapOomError, containsInotifyLimitError, heapPeakFromLogs, pickErrorLines } from '@/components/logs.utils'
import { toast } from '@/utils/toast'
import {
  HEALTH_PROBE_FAST_RETRY_INTERVAL,
  HEALTH_PROBE_INTERVAL,
  LOG_TAIL_MAX_BYTES,
  STARTUP_INACTIVITY_TIMEOUT,
} from './constants'
import {
  containsPatchEntryUnresolved,
  containsPatchLayerParseError,
  containsQuarantineFailure,
  patchEntryUnresolvedEntries,
  patchLayerErrorDetail,
  quarantineFailureDetail,
} from './patch-layer'
import { pollReadiness } from './readiness'

/**
 * 服务生命周期的无状态辅助函数：URL 生成、健康探测、日志读取、错误装饰。
 *
 * 全部与 store 实例无关（不读 `this`、不写状态），因此从 store 中抽出，
 * 便于单独推理与复用；store 只保留编排逻辑。
 */

/**
 * 构建带时间戳的 iframe URL，避免 WebView2 缓存旧页面。
 * alpha 鉴权由启动前的桌面端 patch 处理，iframe 永远不携带启动 token；旧核心
 * 同样继续使用原有的缓存查询参数。
 *
 * `dshDesktop` 是桌面载体的唯一凭据：宿主只给带该参数的 index 注入官方 Electron
 * 载体标记（`globalThis.dshDesktop`），因此用户用浏览器直开同一端口时不会被误判成
 * 桌面端而冒出账号登录入口。
 */
export function generateTimestampedUrl(baseUrl: string): string {
  const timestamp = Date.now()
  const separator = baseUrl.includes('?') ? '&' : '?'
  return `${baseUrl}${separator}t=${timestamp}&dshDesktop=1`
}

/**
 * 轮询 health check 确认 DSH 服务已真正停止，避免改写档案目录时撞文件锁。
 *
 *  - 使用剩余 timeout 约束 in-flight 的 probe（reause `promiseTimeout`），防止无限挂起
 *  - 仅当 health check 明确失败（非 transient 错误）时才视为已停止
 *  - 超时后继续执行（shutdown 可能仍在进行中）
 */
export async function waitForHarnessStopped(timeoutMs = 10_000, intervalMs = 500): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const remaining = timeoutMs - (Date.now() - start)
    if (remaining <= 0)
      break
    try {
      await Promise.race([invoke('proxy_health_check'), promiseTimeout(remaining, true, 'probe timeout')])
    }
    catch (e) {
      // probe 超时视为已停止
      if (e instanceof Error && e.message === 'probe timeout')
        return
      // 非 transient 错误视为已停止；transient 错误（502 等）继续重试
      if (!(e instanceof Error) || !/502|ECONNREFUSED|ETIMEDOUT/i.test(e.message))
        return
    }
    await promiseTimeout(intervalMs)
  }
}

/** 通过 Rust 代理探测服务健康状态（超时 8s，网络抖动时重试） */
export async function checkHealthViaProxy(): Promise<ReadinessProbeResult> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('health check timeout')), 8000)
    })
    const resultPromise = invoke<string>('proxy_health_check')
    const result = await Promise.race([resultPromise, timeoutPromise])

    const lower = result.toLowerCase()
    if (lower.startsWith('healthy')) {
      // 正常路径不写日志：就绪轮询每 1s 成功一次，成功噪音只会盖住真正有用的
      // 失败重试行。
      return {
        healthy: true,
        notOwned: false,
        phase: 'client-modules',
        reason: result,
      }
    }
    console.warn('[Harness] health check returned:', result)
    return {
      healthy: false,
      notOwned: false,
      phase: 'client-modules',
      reason: result,
    }
  }
  catch (err) {
    const message = String(err)
    if (message.includes('HARNESS_NOT_OWNED')) {
      // dsh 进程已退出（典型如插件冲突导致启动即崩溃），继续等只会白白耗完
      // 当前阶段 deadline，让调用方立刻结束并展示日志里的真实错误。
      // 运行期崩溃走的是另一条路径（handleProcessExit），这里能到就说明还在启动轮询里。
      console.warn('[Harness] dsh process exited before readiness, failing fast')
      return {
        healthy: false,
        notOwned: true,
        phase: 'process-boot',
        reason: message,
      }
    }
    if (message.includes('not listening yet')) {
      // 端口还没被监听：Rust 门禁直接判定，属启动早期正常态。静默返回并让轮询改用
      // 快扫间隔；若在这里记 warn，250ms 的节奏会刷满控制台。
      return {
        healthy: false,
        notOwned: false,
        notListening: true,
        phase: 'process-boot',
        reason: message,
      }
    }
    if (message.includes('boot page returned') || message.includes('HARNESS_BOOT_MANIFEST_REQUEST_FAILED')) {
      // 端口已在监听、启动页尚未登记：本轮只发了一次请求、没取任何 bundle，下一刻
      // 就可能就绪，快扫能把这 1s 空等压到 ~0.25s（实测启动尾段正是白等满一个常规
      // 间隔）。仍记一行 warn：这个窗口通常是插件 boot 登记的尾巴，是启动慢的实证。
      console.warn('[Harness] health check failed, retrying:', err)
      return {
        healthy: false,
        notOwned: false,
        bootPending: true,
        phase: 'process-boot',
        reason: message,
      }
    }
    if (message.includes('502') || message.includes('Bad Gateway')) {
      console.warn('[Harness] transient 502 during health check, retrying')
    }
    else {
      // 单次探测失败是启动期的常态：服务尚未就绪、部分 bundle 还没登记等都会走到
      // 这里，而轮询会一直重试到该阶段 deadline；真正的失败由 startupError 以
      // errors.startup_* 报出。逐次记 ERROR 只会造成「满屏错误但其实启动正常」。
      console.warn('[Harness] health check failed, retrying:', err)
    }
    return {
      healthy: false,
      notOwned: false,
      phase: message.includes('client modules') || message.includes('client plugins')
        ? 'client-modules'
        : 'process-boot',
      reason: message,
    }
  }
  finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId)
    }
  }
}

/** 按阶段 + 失败类型构造可展示的启动错误 */
export function startupError(
  phase: StartupPhase,
  reason: string,
  kind: 'failed' | 'inactivity' | 'absolute' | 'exited',
): StartupError {
  const phaseLabel = i18next.t(`startup.phase.${phase}`)
  const message = i18next.t(`errors.startup_${kind}`, {
    phase: phaseLabel,
    reason,
  })
  const error: StartupError = new Error(message)
  error.phase = phase
  error.lastReason = reason
  return error
}

/** 服务就绪轮询（探测实现固定为 Rust 代理健康检查） */
export function pollHarnessReadiness(
  absoluteTimeoutMs: number,
  shouldContinue: () => boolean,
  onProbe?: (result: ReadinessProbeResult) => void,
): Promise<ReadinessPollResult> {
  return pollReadiness({
    probe: checkHealthViaProxy,
    intervalMs: HEALTH_PROBE_INTERVAL,
    fastRetryIntervalMs: HEALTH_PROBE_FAST_RETRY_INTERVAL,
    inactivityTimeoutMs: STARTUP_INACTIVITY_TIMEOUT,
    absoluteTimeoutMs,
    shouldContinue,
    onProbe,
  })
}

/** 读取服务日志尾部（去掉 ANSI 转义与空行），启动失败时展示真实错误 */
export async function readServiceLogTail(): Promise<string[]> {
  try {
    const raw = await invoke<string>('read_service_logs', { maxBytes: LOG_TAIL_MAX_BYTES })
    return raw
      .split(/\r?\n/)
      .map(line => line.replace(/\x1B\[[0-9;]*m/g, '').trim())
      .filter(Boolean)
  }
  catch (err) {
    console.error('[Harness] failed to read service logs:', err)
    return []
  }
}

/** 失败时把服务日志的真实错误行与冲突提示挂到错误对象上 */
export async function attachStartupDiagnostics(err: unknown, processExited = false): Promise<StartupError> {
  // Tauri `invoke` 对 `Result<_, String>` 命令的 rejection 是裸字符串，
  // 必须先归一化为 Error 对象，否则在其上赋属性（ESM 严格模式）会抛
  // `TypeError: Cannot create property ... on string`，反而遮蔽真实错误。
  const diagnosed: StartupError = err instanceof Error ? err : new Error(String(err))
  if (!diagnosed.logs) {
    const lines = await readServiceLogTail()
    diagnosed.logLines = lines
    diagnosed.logs = pickErrorLines(lines)
    // 识别插件路由冲突（如 `duplicate prefix route "/sidebar/api"`），给出可操作的提示
    if (lines.join('\n').includes('duplicate prefix route')) {
      diagnosed.pluginConflictHint = i18next.t('errors.plugin_route_conflict')
    }
    // 识别 Linux inotify 文件监视上限（ENOSPC）：harness 服务启动即崩溃且用户无法直接解决，
    // 需要系统级调高 fs.inotify.max_user_watches（见 errors.inotify_limit 文案）
    if (containsInotifyLimitError(lines)) {
      diagnosed.inotifyLimitHint = i18next.t('errors.inotify_limit')
    }
    if (processExited && containsHeapOomError(lines)) {
      // 提示里报出"崩溃时真正生效的上限"：设置页里的值可能被 NODE_OPTIONS 顶掉，
      // 所以上限以后端启动链路同一份判定（get_effective_heap_limit_mb）为准。
      const effectiveLimitMb = await invoke<number | null>('get_effective_heap_limit_mb').catch(() => null)
      const peakMb = heapPeakFromLogs(lines)
      const hint = effectiveLimitMb
        ? i18next.t('errors.heap_oom', { limit: effectiveLimitMb })
        : i18next.t('errors.heap_oom_unknown')
      diagnosed.heapOomHint = peakMb === undefined ? hint : `${hint} ${i18next.t('errors.heap_oom_peak', { peak: peakMb })}`
    }
  }
  // 补丁层 YAML 语法错误（issue #525）：真实原因是用户手写的 `cordis.patch.yml`
  // 解析不了，但失败阶段是「Plugin installation」，很容易被当成插件损坏。这里挂上
  // 「哪个文件、哪一行、怎么改」的提示（错误页据此给出隔离入口）。
  if (containsPatchLayerParseError(diagnosed.message)) {
    diagnosed.patchLayerHint = i18next.t('errors.patch_layer_parse_failed', {
      detail: patchLayerErrorDetail(diagnosed.message),
    })
  }
  // 隔离没能完成（改名失败：文件被占用/权限不足）：此时后端拒绝重启，否则立刻回到
  // 同一个解析失败。换成「先手动处理文件」的提示，别让用户以为已经恢复。
  if (containsQuarantineFailure(diagnosed.message)) {
    diagnosed.patchLayerHint = i18next.t('errors.patch_quarantine_failed', {
      detail: quarantineFailureDetail(diagnosed.message),
    })
  }
  // 补丁层悬空 insert（包被卸载、手写的引用还在）：启动前预检已把「哪个文件、
  // 哪一行、哪个包」作为明细回传，这里转成可读提示；错误页据此给出「移除悬空
  // 条目」入口（与语法错误的「隔离」入口互斥，见 setup.tsx）。
  if (containsPatchEntryUnresolved(diagnosed.message)) {
    diagnosed.patchLayerHint = i18next.t('errors.patch_entry_unresolved', {
      detail: patchEntryUnresolvedDetail(diagnosed.message),
    })
  }
  return diagnosed
}

/** 把悬空条目明细拼成「文件 + 行号 + 包名」的提示串（明细不可解析时为空串）。 */
export function patchEntryUnresolvedDetail(message: string): string {
  return patchEntryUnresolvedEntries(message)
    .map(entry => i18next.t('errors.patch_entry_unresolved_item', {
      layer: entry.layer,
      line: entry.line,
      id: entry.id || entry.name,
      name: entry.name,
      note: entry.declared ? i18next.t('errors.patch_entry_unresolved_declared') : '',
    }))
    .join('; ')
}

/**
 * 把补丁层隔离结果告知用户：成功项逐个提示「原路径 → 备份路径」（改回原名即可
 * 恢复）。隔离是显式恢复动作，用户必须知道文件被移到了哪里；没有隔离项时完全不
 * 打扰（正常情况下点安全模式不会弹任何提示）。
 *
 * `failures` 兜底：改名失败时后端已改为返回错误（前端走
 * `errors.patch_quarantine_failed` 提示且不重启，见 `attachStartupDiagnostics`），
 * 所以成功路径上它总是空的；这里保留提示逻辑，避免契约变化时静默丢信息。
 */
export function notifyPatchQuarantine(report: PatchQuarantineReport): void {
  for (const layer of report.quarantined) {
    toast(
      i18next.t('patch.quarantined_toast', { backup: layer.backup, original: layer.original }),
      { variant: 'accent', timeout: 10_000 },
    )
  }
  for (const failure of report.failures) {
    toast(
      i18next.t('patch.quarantine_failed_toast', { path: failure.path, error: failure.error }),
      { variant: 'danger', timeout: 0 },
    )
  }
}

/**
 * 把补丁层清理结果告知用户：逐层提示「移除 N 条 + 备份路径」。
 *
 * 清理会改写用户手写的补丁层，因此必须说清原文件被备份到了哪里；没有清理项时
 * 完全不打扰（正常情况下点按钮总能清掉预检报出的那批条目）。
 */
export function notifyPatchEntryStrip(report: PatchEntryStripReport): void {
  for (const layer of report.layers) {
    toast(
      i18next.t('patch.entries_stripped_toast', {
        count: layer.removed,
        backup: layer.backup,
      }),
      { variant: 'accent', timeout: 10_000 },
    )
  }
}

export type InternalPluginPhaseTranslate = (
  key: string,
  options?: Record<string, number>,
) => string

/**
 * 内部插件装载阶段 → 展示文案（`internal-plugins-phase` 事件驱动）。
 *
 * `heartbeat` 只是「仍在进行」的心跳，不改变文案，原样返回上一句，避免文案反复闪烁。
 */
export function internalPluginReason(
  payload: InternalPluginsPhasePayload,
  previousReason: string,
  translate: InternalPluginPhaseTranslate,
): string {
  switch (payload.detail) {
    case 'waiting':
      return translate('status.internal_waiting')
    case 'checking':
      return translate('status.internal_checking', { total: payload.total })
    case 'installing':
      return translate('status.internal_installing', { total: payload.total })
    case 'heartbeat':
      return previousReason
    case 'done':
      return translate('status.internal_done', { total: payload.total })
    case 'timeout':
      return translate('status.internal_timeout')
    case 'cancelled':
      return translate('status.internal_cancelled')
  }
}
