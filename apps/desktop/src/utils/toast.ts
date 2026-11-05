import type { ToastContentValue } from '@heroui/react/toast'
import type { ToastVariants } from '@heroui/styles'
import type { ReactNode } from 'react'
import type { ToastCloseReason, ToastOptions, ToastUpdateOptions } from './toast.handle'
import { invoke } from '@tauri-apps/api/core'
import { emitTo, listen } from '@tauri-apps/api/event'
import { toast as local } from './toast.handle'

export type { Placement, ToastCloseReason, ToastOptions, ToastUpdateOptions } from './toast.handle'
export { activeQueues, placements } from './toast.handle'

type Placement = NonNullable<ToastVariants['placement']>
type ToastVariant = NonNullable<ToastContentValue['variant']>

/** 透明 toast 窗口的 label。与 `desktop::toast_view` 的常量逐字一致。 */
export const TOAST_WINDOW_LABEL = 'toast'

/** 一条 toast 的可序列化描述：这是唯一能跨进程传的形式。 */
export interface ToastRecord {
  key: string
  placement: Placement
  title: string
  description?: string
  variant?: ToastVariant
  isLoading?: boolean
  sticky?: boolean
  autoClose: boolean
  action?: { id: string, label: string, variant?: string }
}

/**
 * 壳层 toast 的转发层。
 *
 * Electron 架构下 Harness 页面是主窗口里的原生 WebContentsView，永远画在壳层 DOM 之上，
 * 壳层右下角的 toast 会被整块盖住。这里把每条 toast 的**可序列化描述**镜像给独立的
 * 透明置顶窗口（`toast.html`），由那个窗口里的 HeroUI 渲染（issue #1408）。
 *
 * 壳层本地队列照旧保留：`key` / `onClose` / `sticky` / 淘汰规则全部由 `toast.handle` 决定，
 * 对外暴露的接口与拆分前完全一致，42 处调用点一行不用改。
 *
 * 两样不可跨进程的东西在这里被换成可传输的表示：
 * - `description` 可能是 JSX，只保留文本；
 * - `actionProps.onPress` 是闭包，登记成 action id，点击由透明窗口回传后执行。
 */
const actions = { next: 0, handlers: new Map<string, () => void>() }
const records = new Map<string, ToastRecord>()

/** 把 JSX / 数组 / 字符串压成纯文本；压不出来的（自定义组件）返回 undefined。 */
function textOf(value: unknown): string | undefined {
  if (value === null || value === undefined || typeof value === 'boolean')
    return undefined
  if (typeof value === 'string' || typeof value === 'number')
    return String(value)
  if (Array.isArray(value))
    return value.map(textOf).filter(part => part !== undefined && part !== '').join('') || undefined
  if (typeof value === 'object' && 'props' in value) {
    const props = (value as { props?: { children?: unknown } }).props
    return textOf(props?.children)
  }
  return undefined
}

function recordOf(
  key: string,
  placement: Placement,
  content: ToastContentValue & { sticky?: boolean, autoClose?: boolean },
): ToastRecord {
  const button = content.actionProps
  let action: ToastRecord['action']
  if (button?.onPress !== undefined && button.children !== undefined) {
    const id = `act-${++actions.next}`
    const press = button.onPress
    actions.handlers.set(id, () => press(undefined as never))
    action = {
      id,
      label: textOf(button.children) ?? '',
      variant: typeof button.variant === 'string' ? button.variant : undefined,
    }
  }
  return {
    key,
    placement,
    title: textOf(content.title) ?? '',
    description: textOf(content.description),
    variant: content.variant,
    isLoading: content.isLoading,
    sticky: content.sticky,
    autoClose: content.autoClose ?? true,
    action,
  }
}

function push(record: ToastRecord): void {
  records.set(record.key, record)
  // 窗口需要先存在才能收事件：`toast_view_show` 幂等地创建、贴合并显示，
  // 之后再用 emitTo 推内容。顺序不能反，否则首条提示会丢在未挂载的页面里。
  void invoke('toast_view_show')
    .then(() => emitTo({ kind: 'Window', label: TOAST_WINDOW_LABEL }, 'dsh://toast:show', record))
    .catch(error => console.warn('[toast] overlay forward failed:', error))
}

/** 最后一条提示消失时收起窗口，避免留下一块置顶的透明层。 */
function hideWhenEmpty(): void {
  if (records.size > 0)
    return
  void invoke('toast_view_hide').catch(() => {})
}

/**
 * 统一 toast API：签名与拆分前完全一致（`toast(...)` / `update` / `close` / `clear` /
 * `isActive`）。本地照旧入壳层队列，同时把可序列化镜像推给透明窗口。
 */
export const toast = Object.assign(
  (message: string | ReactNode, options?: ToastOptions) => {
    const { placement = 'bottom end', timeout, onClose, ...rest } = options || {}
    let key = ''
    // 包一层 onClose：库侧自动超时 / 用户点关闭同样要把透明窗口里的那条收掉，
    // 否则气泡会在覆盖层里一直停着（那个窗口的条目只能由壳层通知关闭）。
    // `autoClose` 与 toast.handle 同一判定：未指定超时由库补默认值，只有显式 0 才常驻。
    const autoClose = timeout === undefined || timeout > 0
    key = local(message, {
      ...options,
      onClose: (reason: ToastCloseReason) => {
        records.delete(key)
        void emitTo({ kind: 'Window', label: TOAST_WINDOW_LABEL }, 'dsh://toast:close', { key })
          .catch(() => {})
        hideWhenEmpty()
        onClose?.(reason)
      },
    })
    push(recordOf(key, placement, { title: message, autoClose, ...rest }))
    return key
  },
  {
    update(key: string, options: ToastUpdateOptions): void {
      local.update(key, options)
      const current = records.get(key)
      if (current === undefined)
        return
      const next = recordOf(key, current.placement, { ...current, ...options })
      // 只改文案时沿用原 action：新内容里没有 onPress，不该把已登记的按钮弄丢。
      push({ ...next, action: next.action ?? current.action })
    },

    isActive(key: string): boolean {
      return local.isActive(key)
    },

    close(key: string): void {
      local.close(key)
      records.delete(key)
      void emitTo({ kind: 'Window', label: TOAST_WINDOW_LABEL }, 'dsh://toast:close', { key })
        .catch(() => {})
      hideWhenEmpty()
    },

    clear(): void {
      local.clear()
      records.clear()
      actions.handlers.clear()
      void emitTo({ kind: 'Window', label: TOAST_WINDOW_LABEL }, 'dsh://toast:clear', {})
        .catch(() => {})
      hideWhenEmpty()
    },
  },
)

/**
 * 透明窗口就绪后要一次全量，避免窗口创建晚于首条提示时丢内容。
 * 由 toast 页面在挂载时发 `{ kind: 'ready' }` 触发。
 */
function syncToastMirrors(): void {
  void emitTo({ kind: 'Window', label: TOAST_WINDOW_LABEL }, 'dsh://toast:sync', {
    records: [...records.values()],
  }).catch(() => {})
}

/**
 * 透明窗口回传的两类消息都在这里处理：`ready` 请求全量回放，`press` 执行壳层登记的
 * 原回调（action 闭包无法跨进程，只能登记成 id 再回查）。由壳层入口挂一次。
 */
export function startToastActionBridge(): () => void {
  let disposed = false
  let unlisten: (() => void) | undefined
  void listen<{ kind?: string, id?: string }>('dsh://toast:action', ({ payload }) => {
    if (payload?.kind === 'ready') {
      syncToastMirrors()
      return
    }
    const id = payload?.id
    if (typeof id !== 'string')
      return
    const run = actions.handlers.get(id)
    if (run === undefined)
      return
    // 一次性消费：同一个按钮重复点击不该重复执行（安装/更新这类操作不可重入）。
    actions.handlers.delete(id)
    run()
  }).then((off) => {
    if (disposed)
      off()
    else
      unlisten = off
  }).catch(error => console.warn('[toast] action bridge failed:', error))
  return () => {
    disposed = true
    unlisten?.()
  }
}
