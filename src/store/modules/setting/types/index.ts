import type { Appearance } from '../../../../../packages/dsh-tauri/src/shared/appearance'
import type { NotifyWebhook } from '../../../../../packages/dsh-tauri/src/shared/notify-webhook'

export interface AppSettingUpdate {
  proxyUrl?: string
  appearance?: Appearance
  port?: number
  zoomFactor?: number
  harnessMaxHeapMb?: number
  autoStart?: boolean
  cliLinkEnabled?: boolean
  closeAction?: string
  backupRetentionCount?: number
  backupIncludeCredentials?: boolean
  notifyWebhook?: NotifyWebhook
}

export type ZoomAction = 'increase' | 'decrease' | 'reset'
