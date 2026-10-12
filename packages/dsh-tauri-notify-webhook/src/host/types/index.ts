/** 一次推送的触发类型：正常跑完 / 异常停止。 */
export type NotifyTrigger = 'completed' | 'abnormal'

export interface DeliveryOutcome {
  ok: boolean
  error?: string
}
