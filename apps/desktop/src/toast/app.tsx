import type { ToastViewContent } from '@/components/toast-provider'
import type { ToastRecord } from '@/utils/toast'
import type { Placement } from '@/utils/toast.handle'
import { ToastQueue } from '@heroui/react'
import { invoke } from '@tauri-apps/api/core'
import { emitTo } from '@tauri-apps/api/event'
import { useEffect, useRef, useState } from 'react'
import { ToastProvider } from '@/components/toast-provider'
import { useListen } from '@/hooks/use-listen'
import { placements } from '@/utils/toast.handle'

const SHELL_WINDOW = 'main'
/** 壳层 → 本窗口的事件名（与 `utils/toast` 逐字一致）。 */
const SHOW = 'dsh://toast:show'
const CLOSE = 'dsh://toast:close'
const CLEAR = 'dsh://toast:clear'
const SYNC = 'dsh://toast:sync'
const ACTION = 'dsh://toast:action'
const ROOT_TESTID = 'dsh-toast-root'

/** 上限与壳层 `toast.handle` 的 MAX_VISIBLE_TOASTS 一致；超出部分壳层已先行淘汰。 */
const MAX_VISIBLE_TOASTS = 3

const queues = Object.fromEntries(placements.map(placement => [
  placement,
  new ToastQueue({ maxVisibleToasts: MAX_VISIBLE_TOASTS }),
])) as Record<Placement, ToastQueue>

interface ToastSync {
  records: ToastRecord[]
}

function contentOf(record: ToastRecord): ToastViewContent {
  return {
    title: record.title,
    description: record.description,
    variant: record.variant,
    isLoading: record.isLoading,
    action: record.action ? { id: record.action.id, label: record.action.label } : undefined,
  }
}

/**
 * 透明 toast 窗口：把壳层推来的可序列化记录渲染成 HeroUI 气泡。
 *
 * 窗口只包住卡片本身（由 Rust 按右下角贴合），所以没有逐像素穿透逻辑：
 * 卡片以外不属于这个窗口，点击自然落到下方的 Harness 页面。
 *
 * 高度随卡片实际尺寸回填给 Rust 重设窗口，避免固定高度在只有一条提示时留下一大块
 * 可点击的透明区。
 */
export function App() {
  const recordsRef = useRef(new Map<string, ToastRecord>())
  // 队列是命令式实例，条目变化不会自己触发重渲染；这个计数器只负责「有变化就重画」。
  const [revision, setRevision] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)

  function syncHeight(): void {
    const element = rootRef.current
    if (element === null)
      return
    const { height } = element.getBoundingClientRect()
    if (height <= 0)
      return
    void invoke('toast_view_resize', { height: Math.ceil(height) }).catch(error =>
      console.warn('[toast] resize failed:', error))
  }

  function render(record: ToastRecord): void {
    const previous = recordsRef.current.get(record.key)
    if (previous !== undefined && previous.placement !== record.placement)
      queues[previous.placement].close(record.key)
    recordsRef.current.set(record.key, record)
    // `autoClose: false` 的常驻气泡交给壳层关闭，这里不能再设超时。
    const timeout = record.autoClose ? undefined : 0
    const queue = queues[record.placement]
    if (previous !== undefined)
      queue.update(record.key, contentOf(record) as never, { timeout })
    else
      queue.add(contentOf(record) as never, { timeout })
    setRevision(value => value + 1)
    requestAnimationFrame(syncHeight)
  }

  function close(key: string): void {
    const record = recordsRef.current.get(key)
    if (record === undefined)
      return
    queues[record.placement].close(key)
    recordsRef.current.delete(key)
    setRevision(value => value + 1)
    requestAnimationFrame(syncHeight)
  }

  useListen<ToastRecord>(SHOW, ({ payload }) => render(payload))
  useListen<{ key: string }>(CLOSE, ({ payload }) => close(payload.key))
  useListen(CLEAR, () => {
    for (const placement of placements)
      queues[placement].clear()
    recordsRef.current.clear()
    setRevision(value => value + 1)
    requestAnimationFrame(syncHeight)
  })
  useListen<ToastSync>(SYNC, ({ payload }) => {
    for (const record of payload.records ?? []) render(record)
  })
  // keep:effect 就绪握手必须在监听注册之后发：窗口创建晚于首条提示时，
  // 壳层早在页面挂载前就已推过一次，只能靠这次回放补上。
  useEffect(() => {
    void emitTo({ kind: 'Window', label: SHELL_WINDOW }, ACTION, { kind: 'ready' }).catch(() => {})
  }, [])

  return (
    <div ref={rootRef} data-testid={ROOT_TESTID} data-revision={revision} className="relative h-full w-full">
      <ToastProvider
        queues={queues}
        onAction={(id) => {
          void emitTo({ kind: 'Window', label: SHELL_WINDOW }, ACTION, { kind: 'press', id })
            .catch(error => console.warn('[toast] action forward failed:', error))
        }}
      />
    </div>
  )
}
