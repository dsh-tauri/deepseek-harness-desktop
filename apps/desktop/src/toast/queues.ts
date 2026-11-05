import { ToastQueue } from '@heroui/react'

export type Placement = 'top start' | 'top' | 'top end' | 'bottom start' | 'bottom' | 'bottom end'

export const placements: readonly Placement[] = [
  'top start',
  'top',
  'top end',
  'bottom start',
  'bottom',
  'bottom end',
]

/** 上限与壳层 `toast.handle` 的 MAX_VISIBLE_TOASTS 一致；超出部分壳层已先行淘汰。 */
const MAX_VISIBLE_TOASTS = 3

/**
 * toast 窗口自己的队列。它不共享壳层进程里的实例，只按收到的描述重建条目；
 * 因此这里只负责「画」，淘汰与关闭原因仍由壳层 `toast.handle` 决定。
 */
export const queues = Object.fromEntries(placements.map(placement => [
  placement,
  new ToastQueue({ maxVisibleToasts: MAX_VISIBLE_TOASTS }),
])) as Record<Placement, ToastQueue>
