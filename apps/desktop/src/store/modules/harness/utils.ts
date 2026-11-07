import type { ReadinessPollResult, ReadinessProbeResult, StartupPhase } from './readiness'
import type { InternalPluginsPhasePayload, StartupError } from './types'
import type { PatchEntryStripReport, PatchQuarantineReport } from '@/types/plugin'
import { promiseTimeout } from '@reause/core'
import { invoke } from '@tauri-apps/api/core'
import Anser from 'anser'
import i18next from 'i18next'
import { containsHeapOomError, containsInotifyLimitError, containsPortInUseError, heapPeakFromLogs, pickErrorLines } from '@/components/logs.utils'
import { toast } from '@/utils/toast'
import {
  HEALTH_PROBE_FAST_RETRY_INTERVAL,
  HEALTH_PROBE_INTERVAL,
  LOG_TAIL_MAX_BYTES,
  STARTUP_INACTIVITY_TIMEOUT,
} from './constants'
import {
  containsPatchEntryUnresolved,
  containsPatchLayerEncodingError,
  containsPatchLayerParseError,
  containsQuarantineFailure,
  patchEntryUnresolvedEntries,
  patchLayerErrorDetail,
  quarantineFailureDetail,
} from './patch-layer'
import { pollReadiness } from './readiness'

export function generateTimestampedUrl(baseUrl: string): string {
  const timestamp = Date.now()
  const separator = baseUrl.includes('?') ? '&' : '?'
  return `${baseUrl}${separator}t=${timestamp}&dshDesktop=1`
}

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
      if (e instanceof Error && e.message === 'probe timeout')
        return
      if (!(e instanceof Error) || !/502|ECONNREFUSED|ETIMEDOUT/i.test(e.message))
        return
    }
    await promiseTimeout(intervalMs)
  }
}

export async function checkHealthViaProxy(): Promise<ReadinessProbeResult> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('health check timeout')), 8000)
    })
    const resultPromise = invoke<string | { status: string, boot_html: string, service_url: string }>('proxy_health_check')
    const result = await Promise.race([resultPromise, timeoutPromise])
    const status = typeof result === 'string' ? result : result.status
    const lower = status.toLowerCase()
    if (lower.startsWith('healthy')) {
      return {
        healthy: true,
        notOwned: false,
        phase: 'client-modules',
        reason: status,
        ...(typeof result === 'string' ? {} : { bootHtml: result.boot_html, bootOrigin: result.service_url }),
      }
    }
    console.warn('[Harness] health check returned:', status)
    return {
      healthy: false,
      notOwned: false,
      phase: 'client-modules',
      reason: status,
    }
  }
  catch (err) {
    const message = String(err)
    if (message.includes('HARNESS_NOT_OWNED')) {
      console.warn('[Harness] no owned dsh process, failing health check')
      return {
        healthy: false,
        notOwned: true,
        phase: 'process-boot',
        reason: message,
      }
    }
    if (message.includes('HARNESS_NOT_READY')) {
      return {
        healthy: false,
        notOwned: false,
        notListening: true,
        phase: 'process-boot',
        reason: message,
      }
    }
    if (message.includes('boot page returned') || message.includes('HARNESS_BOOT_MANIFEST_REQUEST_FAILED')) {
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

export async function readServiceLogTail(): Promise<string[]> {
  try {
    const raw = await invoke<string>('read_service_logs', { maxBytes: LOG_TAIL_MAX_BYTES })
    return raw
      .split(/\r?\n/)
      .map(line => Anser.ansiToText(line).trim())
      .filter(Boolean)
  }
  catch (err) {
    console.error('[Harness] failed to read service logs:', err)
    return []
  }
}

export async function attachStartupDiagnostics(err: unknown, processExited = false): Promise<StartupError> {
  const diagnosed: StartupError = err instanceof Error ? err : new Error(String(err))
  if (!diagnosed.logs) {
    const lines = await readServiceLogTail()
    diagnosed.logLines = lines
    diagnosed.logs = pickErrorLines(lines)
    if (lines.join('\n').includes('duplicate prefix route')) {
      diagnosed.pluginConflictHint = i18next.t('errors.plugin_route_conflict')
    }
    if (containsInotifyLimitError(lines)) {
      diagnosed.inotifyLimitHint = i18next.t('errors.inotify_limit')
    }
    if (processExited && containsHeapOomError(lines)) {
      const effectiveLimitMb = await invoke<number | null>('get_effective_heap_limit_mb').catch(() => null)
      const peakMb = heapPeakFromLogs(lines)
      const hint = effectiveLimitMb
        ? i18next.t('errors.heap_oom', { limit: effectiveLimitMb })
        : i18next.t('errors.heap_oom_unknown')
      diagnosed.heapOomHint = peakMb === undefined ? hint : `${hint} ${i18next.t('errors.heap_oom_peak', { peak: peakMb })}`
    }
  }
  if (containsPatchLayerEncodingError(diagnosed.message)) {
    diagnosed.patchLayerHint = i18next.t('errors.patch_layer_encoding_failed', {
      detail: patchLayerErrorDetail(diagnosed.message),
    })
  }
  else if (containsPatchLayerParseError(diagnosed.message)) {
    diagnosed.patchLayerHint = i18next.t('errors.patch_layer_parse_failed', {
      detail: patchLayerErrorDetail(diagnosed.message),
    })
  }
  if (containsQuarantineFailure(diagnosed.message)) {
    diagnosed.patchLayerHint = i18next.t('errors.patch_quarantine_failed', {
      detail: quarantineFailureDetail(diagnosed.message),
    })
  }
  if (containsPatchEntryUnresolved(diagnosed.message)) {
    diagnosed.patchLayerHint = i18next.t('errors.patch_entry_unresolved', {
      detail: patchEntryUnresolvedDetail(diagnosed.message),
    })
  }
  return diagnosed
}

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

const PORT_CONFLICT_RESTART_LIMIT = 3
let portConflictRestarts = 0

export function resetPortConflictRestarts(): void {
  portConflictRestarts = 0
}

export function consumePortConflictRestart(lines: readonly string[]): boolean {
  if (!containsPortInUseError(lines))
    return false
  if (portConflictRestarts >= PORT_CONFLICT_RESTART_LIMIT)
    return false
  portConflictRestarts += 1
  return true
}
