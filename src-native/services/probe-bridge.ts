import type { AuthStatus } from '@/apis/index.types'
import type { BridgeAddress } from '@/utils/bridge-protocol'
import { getAuthStatus, getManifest } from '@/apis/index'
import { PROBE_TIMEOUT_MS } from '@/config/constants'

export interface BridgeHost extends BridgeAddress {
  auth: AuthStatus
}

/**
 * 探测单个候选地址是否为可用的 DSH Bridge 宿主。
 * 超时、网络错误、非 2xx、响应体不合法一律返回 null（扫描靠 null 判定「不可用」）。
 */
export async function probeBridge(address: BridgeAddress, signal: AbortSignal, timeoutMs = PROBE_TIMEOUT_MS): Promise<BridgeHost | null> {
  if (signal.aborted)
    return null
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  function abort() {
    controller.abort()
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    const auth = await getAuthStatus({ baseURL: address.id }, { signal: controller.signal })
    if (!auth || controller.signal.aborted)
      return null
    // 旧版宿主不返回 allowLoopback，此时用 manifest 兜底确认这是一台 DSH Bridge 宿主。
    if (auth.allowLoopback === undefined) {
      const manifest = await getManifest({ baseURL: address.id }, { signal: controller.signal })
      if (!manifest || controller.signal.aborted)
        return null
    }
    return { ...address, auth }
  }
  catch {
    return null
  }
  finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
  }
}
