export const pendingWorktreeTitles = new Set<string>()

export const injectedCheckoutContexts = new Set<string>()

export function resetRuntime(): void {
  pendingWorktreeTitles.clear()
  injectedCheckoutContexts.clear()
}
