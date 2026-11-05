/** 投递给 DSH 页面的通知结果载荷。 */
export interface NotificationResult {
  deliveryKey?: string
  tag?: string
  sessionId?: string
  sourceOrigin?: string
  action?: string
  inputValue?: string
}

/** 通知归属判定所需的元数据。 */
export interface NotificationOwnerMetadata {
  windowLabel?: string
  sourceOrigin?: string
  tag?: string
  sessionId?: string
  deliveryKey?: string
}

/** 通知来源 origin 记在 localStorage 的这个前缀下，供多窗口仲裁复用。 */
export const NOTIFICATION_SOURCE_PREFIX = 'dsh-notification-source:'

/** 延迟合并同一通知的多次动作，避免一次点击投递两条。 */
export const NOTIFICATION_ACTION_MERGE_MS = 250

/** 读取某个窗口登记的来源 origin。 */
export function readNotificationSource(label: string): string | null {
  return window.localStorage.getItem(`${NOTIFICATION_SOURCE_PREFIX}${label}`)
}

/** 登记某个窗口负责的来源 origin。 */
export function writeNotificationSource(label: string, origin: string): void {
  window.localStorage.setItem(`${NOTIFICATION_SOURCE_PREFIX}${label}`, origin)
}

/** 哪些窗口可能承载通知：主窗口、子窗口与远程窗口。 */
export function isNotificationShellLabel(label: string): boolean {
  return label === 'main' || label.startsWith('window-') || label.startsWith('remote-')
}

/**
 * 从同一来源的候选窗口里选出唯一承担者。
 *
 * 其它窗口已登记同一来源且仍在世时让位；否则按标签排序取第一个，保证多窗口
 * 打开同一 webview 时通知只投递一次（issue #1325 的多窗口仲裁）。
 */
export function electNotificationOwner(
  labels: string[],
  metadata: NotificationOwnerMetadata | null | undefined,
  currentLabel: string,
): boolean {
  const { windowLabel, sourceOrigin } = metadata ?? {}
  if (!sourceOrigin)
    return false
  if (windowLabel === currentLabel)
    return true
  const liveLabels = labels
  if (windowLabel && liveLabels.includes(windowLabel) && !readNotificationSource(windowLabel))
    return false
  const candidates = liveLabels
    .filter(label => isNotificationShellLabel(label) && readNotificationSource(label) === sourceOrigin)
    .sort()
  return (candidates.includes(windowLabel ?? '') ? windowLabel : candidates[0]) === currentLabel
}

/** 构造投递载荷；缺失字段保持 undefined，避免覆盖已合并的值。 */
export function buildNotificationResult(
  metadata: NotificationOwnerMetadata | null | undefined,
  actionId: string,
  inputValue?: unknown,
): NotificationResult {
  return {
    tag: metadata?.tag,
    sessionId: metadata?.sessionId,
    deliveryKey: metadata?.deliveryKey,
    sourceOrigin: metadata?.sourceOrigin,
    action: actionId,
    inputValue: typeof inputValue === 'string' ? inputValue : undefined,
  }
}

/** 同一通知的动作键：用于 250ms 内的重复动作合并。 */
export function notificationActionKey(payload: NotificationResult, actionId: string): string {
  return JSON.stringify([payload.tag, payload.deliveryKey, actionId])
}

/** 判断某个来源是否就是当前登记的来源。 */
export function matchesNotificationSource(sourceOrigin: string | undefined, current: string): boolean {
  return sourceOrigin !== undefined && sourceOrigin !== '' && sourceOrigin === current
}
