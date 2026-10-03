import type { BridgeHost } from './probe-bridge'
import type { ScanCandidate } from '@/utils/discovery'
import { PROBE_TIMEOUT_MS, SCAN_BUDGET_MS, SCAN_CONCURRENCY } from '@/config/constants'
import { parseQrPayload } from '@/utils/bridge-protocol'
import { probeBridge } from './probe-bridge'

export interface ScanOptions {
  signal: AbortSignal
  concurrency?: number
  timeoutMs?: number
  budgetMs?: number
  onFound?: (host: BridgeHost) => void
}

/**
 * 并发探测候选地址（/24 网段扫描），受总预算 budgetMs 与外部 signal 双重约束。
 * 参数不合法直接抛 RangeError —— 调用方（store action）把它们当作编程错误而非网络错误。
 */
export async function scanCandidates(candidates: readonly ScanCandidate[], {
  signal,
  concurrency = SCAN_CONCURRENCY,
  timeoutMs = PROBE_TIMEOUT_MS,
  budgetMs = SCAN_BUDGET_MS,
  onFound,
}: ScanOptions): Promise<BridgeHost[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 256)
    throw new RangeError('Scan concurrency must be between 1 and 256')
  if (!Number.isFinite(budgetMs) || budgetMs <= 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new RangeError('Scan timeouts must be positive')
  if (signal.aborted || candidates.length === 0)
    return []
  const controller = new AbortController()
  function abort() {
    controller.abort()
  }
  signal.addEventListener('abort', abort, { once: true })
  const deadline = setTimeout(abort, budgetMs)
  const found: BridgeHost[] = []
  let cursor = 0
  async function worker() {
    while (!controller.signal.aborted && cursor < candidates.length) {
      const candidate = candidates[cursor++]
      if (!candidate)
        break
      const address = parseQrPayload(`http://${candidate.host}:${candidate.port}`)
      if (!address)
        continue
      const result = await probeBridge(address, controller.signal, timeoutMs)
      if (result && !controller.signal.aborted) {
        found.push(result)
        onFound?.(result)
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker))
    return found
  }
  finally {
    clearTimeout(deadline)
    controller.abort()
    signal.removeEventListener('abort', abort)
  }
}
