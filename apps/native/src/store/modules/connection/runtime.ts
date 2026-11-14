import type { ProbeResult } from '@/services/probe-bridge'
import type { BridgeAddress } from '@/utils/bridge-protocol'
import * as Network from 'expo-network'
import { EXTRA_SCAN_PORTS, HEALTH_FAILURE_THRESHOLD, HISTORY_PROBE_TIMEOUT_MS, REMOTE_PROBE_TIMEOUT_MS, SCAN_BUDGET_MS, TRANSITION_PROBE_TIMEOUT_MS } from '@/config/constants'
import { sendNativeNotification } from '@/hooks/use-notifications'
import { i18n } from '@/i18n'
import { probeBridge } from '@/services/probe-bridge'
import { scanCandidates } from '@/services/scan-candidates'
import { parseQrPayload } from '@/utils/bridge-protocol'
import { buildCandidates } from '@/utils/discovery'
import { connection } from './index'

let scanController: AbortController | undefined
let healthController: AbortController | undefined

function withSavedToken(address: BridgeAddress): BridgeAddress {
  const normalized = parseQrPayload(address.url)
  const token = address.token ?? normalized?.token ?? connection.tokens[normalized?.id ?? address.id]
  if (token)
    return { ...address, token }
  return address
}

/** 公网隧道/远程入口的网络抖动明显大于局域网：拉长超时并多探一次，局域网直连单次即返回。 */
function probePlan({ remote }: BridgeAddress, timeoutMs: number): { timeoutMs: number, attempts: number } {
  if (!remote)
    return { timeoutMs, attempts: 1 }
  return { timeoutMs: Math.max(timeoutMs, REMOTE_PROBE_TIMEOUT_MS), attempts: 2 }
}

/** 探测失败原因 → 可读文案 key，用户据此区分隧道超时还是根本连不上。 */
const PROBE_REASON_KEYS: Record<Exclude<ProbeResult['reason'], 'ok'>, string> = {
  timeout: 'connection.probeTimeout',
  manifest: 'connection.probeManifest',
  network: 'connection.probeNetwork',
}

export function cancelAutoScan(): void {
  scanController?.abort()
  scanController = undefined
  connection.cancelScan()
}

export function connectAddress(address: BridgeAddress): void {
  cancelAutoScan()
  connection.accept(withSavedToken(address))
}

export async function startAutoScan({ skipId, historyOnly = false }: { skipId?: string, historyOnly?: boolean } = {}): Promise<void> {
  cancelAutoScan()
  const controller = new AbortController()
  scanController = controller
  const generation = connection.beginScan()
  let expired = false
  const deadline = setTimeout(() => {
    expired = true
    controller.abort()
    connection.finishScan(generation, i18n.t('connection.noHosts'))
  }, SCAN_BUDGET_MS)
  try {
    const history = connection.history.filter(entry => entry.id !== skipId)
    const previous = await Promise.all(history.map(async (entry) => {
      connection.setHealth(entry.id, 'checking')
      const host = withSavedToken(entry)
      const probe = await probeBridge(host, { signal: controller.signal, ...probePlan(host, HISTORY_PROBE_TIMEOUT_MS) })
      if (!controller.signal.aborted)
        connection.setHealth(entry.id, probe.address ? 'available' : 'unavailable')
      return probe.address
    }))
    if (controller.signal.aborted || generation !== connection.scanGeneration)
      return
    for (const host of previous) {
      if (host && connection.accept(host, generation))
        return
    }
    if (historyOnly) {
      connection.finishScan(generation, i18n.t('connection.noHistoryAvailable'))
      return
    }
    const selfIp = await Network.getIpAddressAsync()
    if (controller.signal.aborted || generation !== connection.scanGeneration)
      return
    const exclude: string[] = []
    if (skipId) {
      const skipped = parseQrPayload(skipId)
      if (skipped)
        exclude.push(`${skipped.host}:${skipped.port}`)
    }
    const candidates = buildCandidates({
      selfIp,
      ports: [...EXTRA_SCAN_PORTS, ...history.map(entry => entry.port)],
      exclude,
    })
    if (candidates.length === 0) {
      connection.finishScan(generation, i18n.t('connection.noNetwork'))
      return
    }
    let chosen: BridgeAddress | undefined
    await scanCandidates(candidates, {
      signal: controller.signal,
      onFound(host) {
        if (expired || controller.signal.aborted || generation !== connection.scanGeneration)
          return
        chosen = withSavedToken(host)
        controller.abort()
      },
    })
    if (expired || generation !== connection.scanGeneration)
      return
    if (chosen)
      connection.accept(chosen, generation)
    else
      connection.finishScan(generation, i18n.t('connection.noHosts'))
  }
  catch (error) {
    if (!controller.signal.aborted) {
      console.error('[connection] scan failed:', error)
      connection.finishScan(generation, i18n.t('connection.scanFailed'))
    }
  }
  finally {
    clearTimeout(deadline)
    controller.abort()
    if (scanController === controller)
      scanController = undefined
  }
}

export function disconnectAndScan(): void {
  const previousId = connection.current?.id
  connection.disconnect()
  void startAutoScan({ skipId: previousId })
}

/**
 * 健康检查：已连接主机只降级状态、不打断界面，连续失败达到阈值才提示离线并通知；
 * 正在连接/加载中的主机（界面仍在加载页，没有失败页可用）才在首次失败后显示失败页。
 */
export async function refreshHealth(): Promise<void> {
  if (healthController)
    return
  const controller = new AbortController()
  healthController = controller
  const viewGeneration = connection.viewGeneration
  const addresses = new Map<string, BridgeAddress>(connection.recentFive.map(entry => [entry.id, entry]))
  if (connection.current)
    addresses.set(connection.current.id, connection.current)
  try {
    await Promise.all([...addresses.values()].map(async (address) => {
      const probe = await probeBridge(address, { signal: controller.signal, ...probePlan(address, TRANSITION_PROBE_TIMEOUT_MS) })
      if (controller.signal.aborted || (address.id === connection.current?.id && viewGeneration !== connection.viewGeneration))
        return
      const current = address.id === connection.current?.id
      if (probe.address) {
        connection.setHealth(address.id, 'available')
        if (current && connection.notice === connection.diagnostic)
          connection.setNotice(null)
        connection.setDiagnostic(null)
        return
      }
      const reason = probe.reason === 'ok' ? 'network' : probe.reason
      const message = `${i18n.t('connection.hostOffline')} · ${i18n.t(PROBE_REASON_KEYS[reason])}`
      if (current && connection.loading) {
        connection.markLoadFailed(connection.viewGeneration, message)
        connection.setDiagnostic(message)
        return
      }
      const wasAvailable = connection.health[address.id] === 'available'
      const escalated = connection.recordUnavailable(address.id, HEALTH_FAILURE_THRESHOLD)
      if (!current || !escalated || !wasAvailable)
        return
      connection.setNotice(message)
      connection.setDiagnostic(message)
      void sendNativeNotification({
        type: 'dsh://native-notification',
        title: i18n.t('app.name'),
        body: message,
        tag: `connection:${address.id}`,
        sessionId: '',
        silent: false,
      }, address.id)
    }))
  }
  finally {
    if (healthController === controller)
      healthController = undefined
  }
}

export function stopConnectionRuntime(): void {
  cancelAutoScan()
  healthController?.abort()
  healthController = undefined
}
