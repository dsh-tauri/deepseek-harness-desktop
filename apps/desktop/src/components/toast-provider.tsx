import type { ToastQueue } from '@heroui/react'
import type { ReactNode } from 'react'
import type { Placement } from '@/utils/toast.handle'
import { Spinner, Toast } from '@heroui/react'
import { If } from 'react-if-lite'
import { placements } from '@/utils/toast.handle'

/** 覆盖层里「操作」按钮的描述：闭包不能跨进程，只传 id 与文案。 */
export interface ToastAction {
  id: string
  label: string
}

/**
 * 透明 toast 窗口里一条提示的可渲染内容。
 *
 * 壳层把每条 toast 压成这个形状再推过来：JSX 已收成文本，`onPress` 已换成 id。
 */
export interface ToastViewContent {
  title?: string
  description?: string
  variant?: 'default' | 'accent' | 'success' | 'warning' | 'danger'
  isLoading?: boolean
  action?: ToastAction
}

export interface ToastProviderProps {
  /** 这个窗口自己的队列。壳层那套实例不跨进程，两边各持一份。 */
  queues: Record<Placement, ToastQueue>
  /** 点击「操作」按钮时回调，由调用方把 id 回传给壳层。 */
  onAction?: (id: string) => void
  children?: ReactNode
}

/**
 * HeroUI queue/provider 的唯一渲染入口，由透明 toast 窗口使用。
 *
 * 内容直接取队列条目的 `content`（见 `ToastViewContent`），因此不需要额外的更新表：
 * 壳层改文案时推的是同一条记录，覆盖层用 `queue.update` 原地替换即可。
 */
export function ToastProvider(props: ToastProviderProps) {
  return (
    <>
      {placements.map(placement => (
        <Toast.Provider
          key={placement}
          placement={placement}
          queue={props.queues[placement]}
          className="[&_[data-frontmost=true]_[data-slot=toast-close]]:pointer-events-auto [&_[data-frontmost=true]_[data-slot=toast-close]]:opacity-100"
        >
          {({ toast: item }) => {
            const content = item.content as ToastViewContent
            return (
              <Toast toast={item} variant={content.variant}>
                <If cond={content.isLoading} else={<Toast.Indicator variant={content.variant} />}>
                  <Toast.Indicator variant={content.variant}>
                    <Spinner color="current" size="sm" />
                  </Toast.Indicator>
                </If>
                <Toast.Content className="overflow-hidden">
                  <If cond={content.title !== undefined}>
                    <Toast.Title>{content.title}</Toast.Title>
                  </If>
                  <If cond={content.description !== undefined}>
                    <Toast.Description>{content.description}</Toast.Description>
                  </If>
                  <If cond={content.action !== undefined}>
                    <button
                      type="button"
                      className="button button--sm mt-2"
                      onClick={() => props.onAction?.(content.action!.id)}
                    >
                      {content.action?.label}
                    </button>
                  </If>
                </Toast.Content>
              </Toast>
            )
          }}
        </Toast.Provider>
      ))}
      {props.children}
    </>
  )
}
