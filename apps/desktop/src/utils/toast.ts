import type { ToastContentValue } from '@heroui/react/toast'
import type { ToastVariants } from '@heroui/styles'
import type { ReactNode } from 'react'
import { ToastQueue } from '@heroui/react'
import { hooks } from '@/config/hooks'

/** toast 关闭来源：库侧 close 不携带原因，只能由本模块预记或按超时配置反推 */
export type ToastCloseReason = 'closed' | 'evicted' | 'dismissed'

/** toast() 可选项：库内未暴露的 HeroUIToastOptions（toast-queue 收敛的 content + 超时回调），这里用公开的 ToastContentValue 组合 */
export type ToastOptions = Partial<ToastContentValue & { timeout?: number, onClose?: (reason: ToastCloseReason) => void }> & { placement?: Placement, sticky?: boolean }
export type ToastUpdateOptions = Partial<ToastContentValue>

/**
 * react-stately 队列的内部形态：`updateVisibleToasts` 是 TS private 但运行时存在，
 * 只重建 visibleToasts 并通知订阅者，不改动条目，因此改 content 后必须自己调它。
 */
interface StatelyQueue {
  queue: Array<{ key: string, content?: ToastContentValue }>
  updateVisibleToasts: (action: string) => void
}

export type Placement = NonNullable<ToastVariants['placement']>
export const placements = [
  'top start',
  'top',
  'top end',
  'bottom start',
  'bottom',
  'bottom end',
] as const

/**
 * 单个 placement 同时存在的 toast 上限：渲染层（maxVisibleToasts）与丢弃层
 * （placementKeys 超限关最旧）共用同一数值。
 */
const MAX_VISIBLE_TOASTS = 3

export const queues = Object.fromEntries(
  placements.map(p => [p, new ToastQueue({ maxVisibleToasts: MAX_VISIBLE_TOASTS })]),
) as Record<Placement, ToastQueue>

const linuxQueues = Object.fromEntries(
  placements.map(p => [p, new ToastQueue({ maxVisibleToasts: MAX_VISIBLE_TOASTS, wrapUpdate: fn => fn() })]),
) as Record<Placement, ToastQueue>

export const activeQueues = navigator.platform.toLowerCase().includes('linux')
  ? linuxQueues
  : queues

const toastContents = new Map<string, ToastContentValue>()
const placementsKeys = new Map<string, Placement>()
/**
 * 程序化关闭的原因旁路表。底层 react-stately 的 `close(key)` 对「自动超时 / 用户点
 * 关闭 / 外部 close」走同一条路径且不透传参数，本模块只能在调用 close 前先登记，
 * 回调时取出；未登记（用户点关闭按钮）再按超时配置反推，见 `takeCloseReason`。
 */
const closeReasons = new Map<string, ToastCloseReason>()
/**
 * 每个 placement 的存活 key（按创建顺序，旧→新）。stately queue 对超出
 * maxVisibleToasts 的条目只做「窗口外排队、等旧条目关闭后复现」，常驻
 * （timeout: 0）气泡会无限积压并在旧气泡关闭时复现；这里在新 toast 入队后
 * 直接关闭最旧的条目，保证任何时刻只存在最新的 MAX_VISIBLE_TOASTS 条。
 * `sticky` 的气泡（授权按钮）不入表：它们必须一直可点，被淘汰就等于把用户
 * 堵在「等待授权」上再也点不到（见 config/plugin 的授权流程）。
 */
const placementOrder = new Map<Placement, string[]>()

/**
 * 同步清理一条 toast 的登记。`keepReason` 为真时保留关闭原因，供库侧稍后
 * （rAF 异步）触发的 onClose 读取——`close()` 必须这样调用，否则常驻气泡
 * （`timeout: 0`）的程序化关闭会被误判为用户拒绝。
 */
function forgetKey(key: string, keepReason = false): void {
  toastContents.delete(key)
  if (!keepReason)
    closeReasons.delete(key)
  const placement = placementsKeys.get(key)
  placementsKeys.delete(key)
  if (placement === undefined)
    return
  const order = placementOrder.get(placement)
  if (order === undefined)
    return
  const index = order.indexOf(key)
  if (index >= 0)
    order.splice(index, 1)
  if (order.length === 0)
    placementOrder.delete(placement)
}

/**
 * 关闭原因：优先取本模块登记的程序化原因；未登记说明是用户在气泡上点了关闭
 * （或自动超时），按该条是否配了自动关闭超时反推——配了就是超时自动消失，
 * 没配（`timeout: 0` 常驻）只能是用户点了关闭。
 */
function takeCloseReason(key: string, autoClose: boolean): ToastCloseReason {
  const recorded = closeReasons.get(key)
  if (recorded !== undefined) {
    closeReasons.delete(key)
    return recorded
  }
  return autoClose ? 'closed' : 'dismissed'
}

/**
 * 统一 toast API：直接调用创建，toast.update/close/clear/isActive 通过 key 管理。
 * HeroUI 默认气泡直接读队列条目的 content，而 HeroUI ToastQueue 没有 update 方法：
 * 这里原地改写条目 content 并通知 react-stately 队列重渲染，同时触发
 * `hooks['toast.updated']`（见 config/hooks）供桌宠窗口的自定义气泡消费。
 */
export const toast = Object.assign(
  (message: string | ReactNode, options?: ToastOptions) => {
    // 默认右下角；个别调用方需要其他位置时显式传 placement
    const { placement = 'bottom end', timeout, onClose, sticky = false, ...rest } = options || {}
    const content = { title: message, ...rest }
    // 未指定 timeout 时 HeroUI 会补默认超时（`constants: DEFAULT_TOAST_TIMEOUT`），
    // 因此「undefined 或正数」都意味着这条会自己消失。
    const autoClose = timeout === undefined || timeout > 0
    const key = activeQueues[placement].add(content, {
      timeout,
      onClose: () => {
        // 自动超时 / 用户关闭 / 外部 close 都会走到这里；延后业务回调，避免渲染中更新组件。
        const reason = takeCloseReason(key, autoClose)
        forgetKey(key)
        queueMicrotask(() => onClose?.(reason))
      },
    })
    toastContents.set(key, content)
    placementsKeys.set(key, placement)
    if (sticky)
      return key
    const order = placementOrder.get(placement) ?? []
    order.push(key)
    placementOrder.set(placement, order)
    // 丢弃超出上限的最旧条目（含 rAF 清理延迟期内的死 key），维持「仅最新 N 条」
    while (order.length > MAX_VISIBLE_TOASTS) {
      const oldest = order.shift()
      if (oldest !== undefined) {
        closeReasons.set(oldest, 'evicted')
        activeQueues[placement].close(oldest)
      }
    }
    return key
  },
  {
    update(key: string, options: ToastUpdateOptions): void {
      const placement = placementsKeys.get(key)
      if (placement === undefined)
        return
      toastContents.set(key, { ...(toastContents.get(key) ?? {}), ...options })
      const queue = activeQueues[placement].getQueue() as unknown as StatelyQueue
      const entry = queue.queue.find(item => item.key === key)
      if (entry !== undefined) {
        entry.content = { ...entry.content, ...options }
        queue.updateVisibleToasts('update')
      }
      void hooks['toast.updated'].trigger({ key, options })
    },

    /** 该 key 是否仍是活着的 toast：被限额淘汰后 update/close 都会静默失效 */
    isActive(key: string): boolean {
      return placementsKeys.has(key)
    },

    close(key: string): void {
      const placement = placementsKeys.get(key)
      if (placement) {
        closeReasons.set(key, 'closed')
        activeQueues[placement].close(key)
        // onClose 是 rAF 异步回调：保留关闭原因到那时再取，但同步清掉其余登记，
        // 紧随其后的 add 不会把死 key 计入限额
        forgetKey(key, true)
      }
      else {
        toastContents.delete(key)
        closeReasons.delete(key)
      }
    },

    clear(): void {
      toastContents.clear()
      placementsKeys.clear()
      placementOrder.clear()
      closeReasons.clear()
      placements.forEach(p => activeQueues[p].clear())
    },
  },
)
