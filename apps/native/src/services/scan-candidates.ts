import type { BridgeAddress } from '@/utils/bridge-protocol'
import type { ScanCandidate } from '@/utils/discovery'
import { PROBE_TIMEOUT_MS, SCAN_BUDGET_MS, SCAN_CONCURRENCY } from '@/config/constants'
import { parseQrPayload } from '@/utils/bridge-protocol'
import { probeBridge } from './probe-bridge'

export interface ScanOptions {
  signal: AbortSignal
  concurrency?: number
  timeoutMs?: number
  budgetMs?: number
  onFound?: (host: BridgeAddress) => void
}

/** 并发探测 /24 网段候选地址，受总预算与外部 signal 双重约束；参数非法属于编程错误。 */
export async function scanCandidates(candidates: readonly ScanCandidate[], {
  signal,
  concurrency = SCAN_CONCURRENCY,
  timeoutMs = PROBE_TIMEOUT_MS,
  budgetMs = SCAN_BUDGET_MS,
  onFound,
}: ScanOptions): Promise<BridgeAddress[]> {
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
  const found: BridgeAddress[] = []
  let cursor = 0
  async function worker() {
    while (!controller.signal.aborted && cursor < candidates.length) {
      const candidate = candidates[cursor++]
      if (!candidate)
        break
      const address = parseQrPayload(`http://${candidate.host}:${candidate.port}`)
      if (!address)
        continue
      const result = await probeBridge(address, { signal: controller.signal, timeoutMs })
      if (result.address && !controller.signal.aborted) {
        found.push(result.address)
        onFound?.(result.address)
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
