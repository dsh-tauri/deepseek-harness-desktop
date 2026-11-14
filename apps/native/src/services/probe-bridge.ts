import type { BridgeAddress } from '@/utils/bridge-protocol'
import { FetchError } from 'expo/src/winter/fetch/FetchErrors'
import { getManifest } from '@/apis/index'
import { PROBE_TIMEOUT_MS } from '@/config/constants'

export interface ProbeOptions {
  signal: AbortSignal
  timeoutMs?: number
  attempts?: number
}

export interface ProbeResult {
  address: BridgeAddress | null
  reason: 'ok' | 'timeout' | 'manifest' | 'network'
}

const RETRY_DELAY_MS = 250

/** 单个地址的 manifest 探测：超时、非 DSH manifest、网络错误都归一成可读原因，只有真正的编程错误才抛。 */
export async function probeBridge(address: BridgeAddress, { signal, timeoutMs = PROBE_TIMEOUT_MS, attempts = 1 }: ProbeOptions): Promise<ProbeResult> {
  for (let attempt = 1; ; attempt++) {
    const result = await probeOnce(address, signal, timeoutMs)
    if (result.reason === 'ok' || attempt >= attempts || signal.aborted)
      return result
    await wait(RETRY_DELAY_MS * attempt, signal)
    if (signal.aborted)
      return { address: null, reason: 'network' }
  }
}

async function probeOnce(address: BridgeAddress, signal: AbortSignal, timeoutMs: number): Promise<ProbeResult> {
  if (signal.aborted)
    return { address: null, reason: 'network' }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  function abort() {
    controller.abort()
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    const manifest = await getManifest({ baseURL: address.id }, { signal: controller.signal })
    if (signal.aborted)
      return { address: null, reason: 'network' }
    if (!manifest)
      return { address: null, reason: 'manifest' }
    return controller.signal.aborted ? { address: null, reason: 'timeout' } : { address, reason: 'ok' }
  }
  catch (error) {
    if (signal.aborted)
      return { address: null, reason: 'network' }
    if (controller.signal.aborted)
      return { address: null, reason: 'timeout' }
    if (error instanceof SyntaxError)
      return { address: null, reason: 'manifest' }
    if (error instanceof TypeError || error instanceof FetchError)
      return { address: null, reason: 'network' }
    throw error
  }
  finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
    function finish() {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
  })
}
