import { createEventHook } from '@reause/core'

/**
 * 壳层瞬时事件总线（reause `createEventHook`）。
 *
 * 只承载「无状态、可能跨 store 触发」的瞬时通知；跨组件状态一律走 valtio-define
 * store，不要往这里加新的全局状态。
 *
 * 消费端统一用 reause `useListener` 绑定，卸载自动注销：
 * ```tsx
 * useListener(hooks['config.dialog.hidden'].on, () => { ... })
 * ```
 */
export const hooks = {
  /** 请求关闭设置对话框（harness / preinstall store 在服务重启、退出前收起弹层） */
  'config.dialog.hidden': createEventHook<void>(),
}
