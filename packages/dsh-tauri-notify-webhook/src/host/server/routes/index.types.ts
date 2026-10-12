/** 路由契约：生成客户端据此产出 `Types.*`（形状校验仍在处理器内做）。 */
import type { NotifyWebhookSettings } from '../../../shared/settings'

export interface GetSettingsResult {
  settings?: NotifyWebhookSettings
  error?: string
}

export interface PostSettingsBody {
  settings?: NotifyWebhookSettings
}

export interface PostSettingsResult {
  settings?: NotifyWebhookSettings
  error?: string
}

export interface PostTestResult {
  ok?: boolean
  error?: string
}

export interface GetTurnEndQuery {
  sessionId?: string
}

/** 会话最近一次回合结束的原因；宿主还没记录过该会话时字段缺省。 */
export interface GetTurnEndResult {
  reason?: string
  turn?: number
}
