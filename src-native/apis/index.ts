import type { AuthStatus, BridgeManifest, GetAuthStatusPaths, GetManifestPaths } from './index.types'
import { AUTH_STATUS_PATH, MANIFEST_PATH } from '@/config/constants'
import { isBridgeManifest, parseAuthStatus } from '@/utils/bridge-protocol'

/**
 * 探测宿主的鉴权状态。网络错误由调用方（probe）捕获；
 * 非 2xx 或响应体不合法一律返回 null —— 表示「这个 origin 不是 DSH Bridge 宿主」。
 */
export async function getAuthStatus(paths: GetAuthStatusPaths, init?: RequestInit): Promise<AuthStatus | null> {
  const response = await fetch(new URL(AUTH_STATUS_PATH, paths.baseURL).toString(), {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    redirect: 'error',
    ...init,
  })

  if (!response.ok)
    return null

  return parseAuthStatus(await response.json())
}

/**
 * 读取宿主 manifest，用于判断宿主是否允许 loopback 连接。
 * 非 2xx 或校验失败返回 null。
 */
export async function getManifest(paths: GetManifestPaths, init?: RequestInit): Promise<BridgeManifest | null> {
  const response = await fetch(new URL(MANIFEST_PATH, paths.baseURL).toString(), {
    headers: { Accept: 'application/manifest+json' },
    cache: 'no-store',
    redirect: 'error',
    ...init,
  })

  if (!response.ok)
    return null

  const data: unknown = await response.json()
  return isBridgeManifest(data) ? data : null
}
