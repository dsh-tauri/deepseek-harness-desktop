import type { SidebarBusyAction } from './types'

export interface HeapRecoveryPlanInput {
  /** 退出日志里是否出现了 V8 堆耗尽的特征行 */
  heapExhausted: boolean
  /** 插件恢复流程是否已经接管错误页（此时不该抢着重启） */
  pluginRecoveryRequired: boolean
  /** 是否有用户发起的动作正在执行 */
  busy: SidebarBusyAction
  /** 向后端询问「崩溃后该抬到多少 MB」，null 表示已经顶到上限 */
  queryLimitMb: () => Promise<number | null>
}

/**
 * 判断这次 Harness 退出要不要自动抬上限重启，返回要写入的新上限（MB）。
 *
 * 只处理「确实因为 V8 堆耗尽退出」这一种：其它退出（端口占用、插件崩溃、
 * 用户手动关闭）照旧走错误页，免得把用户按在无意义的自动重启里。判定顺序
 * 有意从廉价到昂贵——前三个条件不成立时根本不会去问后端。
 *
 * 次数不在这里限制：上限每次翻倍，顶到 HARNESS_HEAP_MAX_MB（32768 MB）后
 * 后端直接返回 null（见 Rust 侧 next_heap_limit_mb），自动重启自然停下。
 */
export async function planHeapRecovery(input: HeapRecoveryPlanInput): Promise<number | null> {
  if (!input.heapExhausted)
    return null
  if (input.pluginRecoveryRequired)
    return null
  if (input.busy !== null)
    return null
  try {
    return await input.queryLimitMb()
  }
  catch (err) {
    console.warn('[Harness] failed to query the heap recovery limit:', err)
    return null
  }
}
