/** `getAuthStatus` 的路径参数：宿主 origin（`BridgeAddress.id`）。 */
export interface GetAuthStatusPaths {
  baseURL: string
}

/** `getManifest` 的路径参数：宿主 origin（`BridgeAddress.id`）。 */
export interface GetManifestPaths {
  baseURL: string
}

/** `GET /__dsh_bridge__/auth-status` 响应体。 */
export interface AuthStatus {
  enabled: boolean
  mode?: string
  allowLoopback?: boolean
}

/** `GET /manifest.webmanifest` 响应体中本 App 依赖的两个字段。 */
export interface BridgeManifest {
  name: string
  short_name: string
}
