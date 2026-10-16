import type { BridgeAddress } from '@/utils/bridge-protocol'
import { FetchError } from 'expo/src/winter/fetch/FetchErrors'
import { getManifest } from '@/apis/index'
import { PROBE_TIMEOUT_MS } from '@/config/constants'

export async function probeBridge(address: BridgeAddress, signal: AbortSignal, timeoutMs = PROBE_TIMEOUT_MS): Promise<BridgeAddress | null> {
  if (signal.aborted)
    return null
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  function abort() {
    controller.abort()
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    const manifest = await getManifest({ baseURL: address.id }, { signal: controller.signal })
    return manifest && !controller.signal.aborted ? address : null
  }
  catch (error) {
    if (controller.signal.aborted || error instanceof TypeError || error instanceof SyntaxError || error instanceof FetchError)
      return null
    throw error
  }
  finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
  }
}
