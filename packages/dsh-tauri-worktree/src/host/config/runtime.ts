/** 继承前缀里没有人类消息的工作树会话：首个请求头落盘时显式补一次模型标题（内核不会为 fork 子会话自动生成）。 */
export const pendingWorktreeTitles = new Set<string>()

export const injectedCheckoutContexts = new Set<string>()

export function resetRuntime(): void {
  pendingWorktreeTitles.clear()
  injectedCheckoutContexts.clear()
}
