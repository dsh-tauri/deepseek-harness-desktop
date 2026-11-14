/** `install-progress` 的 `percentage` 已是后端按阶段权重算好的 0-100 全局值：这里只做取整与钳制，不再二次分段 */
export function installPercent(percentage: number, previous = 0): number {
  if (!Number.isFinite(percentage) || percentage < 0)
    return Math.min(100, Math.max(0, Math.round(previous)))
  return Math.min(100, Math.round(percentage))
}
