export type CoreDownloadStatus = 'running' | 'success' | 'failed' | 'switching'

export interface CoreDownloadTask {
  tag: string
  version: string
  coreId: string
  status: CoreDownloadStatus
  percentage: number
  /** 后端进度 detail（如「已下载 3.2 MB / 38.0 MB」），即气泡描述行 */
  detail: string
  error: string
}
