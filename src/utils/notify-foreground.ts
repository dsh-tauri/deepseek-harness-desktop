/**
 * 窗口当前是否在前台。
 *
 * `document.hidden` 被 `NOTIFICATION_SHIM_JS` 接成了宿主下发的可见性状态
 * （`minimized || !visible || !focused`，见 `use-sync-visibility.ts`），所以它表达的是
 * 「窗口没聚焦」而不是浏览器那套「标签页被切走」；这里复用同一份语义，避免再引一个
 * 可能与之不同步的 Rust 焦点查询。
 */
export function isNotificationForeground(): boolean {
  return typeof document === 'undefined' || document.hidden !== true
}
