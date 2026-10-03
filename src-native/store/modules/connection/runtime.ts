import type { BridgeHost } from '@/services/probe-bridge'
import type { BridgeAddress } from '@/utils/bridge-protocol'
import * as Network from 'expo-network'
import { EXTRA_SCAN_PORTS, HISTORY_PROBE_TIMEOUT_MS, SCAN_BUDGET_MS } from '@/config/constants'
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
      const host = await probeBridge(withSavedToken(entry), controller.signal, HISTORY_PROBE_TIMEOUT_MS)
      if (!controller.signal.aborted)
        connection.setHealth(entry.id, host ? 'available' : 'unavailable')
      return host
    }))
    if (controller.signal.aborted || generation !== connection.scanGeneration)
      return
    let needsToken = false
    for (const host of previous) {
      if (!host)
        continue
      if (host.auth.enabled && host.auth.mode === 'token_only' && !host.token) {
        needsToken = true
        continue
      }
      if (connection.accept(host, generation))
        return
    }
    if (historyOnly) {
      connection.finishScan(generation, needsToken ? i18n.t('connection.tokenRequired') : i18n.t('connection.noHistoryAvailable'))
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
    let chosen: BridgeHost | undefined
    await scanCandidates(candidates, {
      signal: controller.signal,
      onFound(host) {
        if (expired || controller.signal.aborted || generation !== connection.scanGeneration)
          return
        const saved = withSavedToken(host)
        if (host.auth.enabled && host.auth.mode === 'token_only' && !saved.token) {
          needsToken = true
          return
        }
        chosen = { ...host, ...saved }
        controller.abort()
      },
    })
    if (expired || generation !== connection.scanGeneration)
      return
    if (chosen) {
      connection.accept(chosen, generation)
    }
    else {
      let notice: string = i18n.t('connection.noHosts')
      if (needsToken)
        notice = i18n.t('connection.tokenRequired')
      connection.finishScan(generation, notice)
    }
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
      const wasAvailable = connection.health[address.id] === 'available'
      const host = await probeBridge(address, controller.signal, HISTORY_PROBE_TIMEOUT_MS)
      if (controller.signal.aborted || (address.id === connection.current?.id && viewGeneration !== connection.viewGeneration))
        return
      connection.setHealth(address.id, host ? 'available' : 'unavailable')
      if (wasAvailable && !host && address.id === connection.current?.id) {
        connection.setNotice(i18n.t('connection.hostOffline'))
        void sendNativeNotification({
          type: 'dsh://native-notification',
          title: i18n.t('app.name'),
          body: i18n.t('connection.hostOffline'),
          tag: `connection:${address.id}`,
          sessionId: '',
          silent: false,
        }, address.id)
      }
      if (host && address.id === connection.current?.id && connection.notice === i18n.t('connection.hostOffline'))
        connection.setNotice(null)
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
