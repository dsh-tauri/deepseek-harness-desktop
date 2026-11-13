export type CoreDownloadStatus = 'running' | 'success' | 'failed' | 'switching'

export interface CoreDownloadTask {
  tag: string
  version: string
  coreId: string
  status: CoreDownloadStatus
  percentage: number
  logs: string[]
  error: string
}
