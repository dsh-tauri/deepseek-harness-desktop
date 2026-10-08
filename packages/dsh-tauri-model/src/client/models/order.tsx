import type { ReactNode } from 'react'
import { ArrowDown, ArrowUp } from 'dsh-tauri-ui/client'
import { modelStyles as styles } from './styles.ts'

/** 交换两项；下标越界或原地不动时返回 undefined，调用方据此判断这一步没有可交换的邻居。 */
export function swappedAt<T>(items: readonly T[], index: number, target: number): T[] | undefined {
  if (index < 0 || index >= items.length || target < 0 || target >= items.length || index === target)
    return undefined
  const next = [...items]
  const moved = next[index]
  next[index] = next[target]
  next[target] = moved
  return next
}

/** 行尾的「上移 / 下移」按钮组；位置与总数由调用方按 1 起算。 */
export function OrderButtons(props: {
  position: number
  count: number
  disabled: boolean
  upLabel: string
  downLabel: string
  onMove: (delta: number) => void
}): ReactNode {
  const { position, count, disabled } = props
  return (
    <>
      <button
        type="button"
        className={styles.iconButton}
        aria-label={`${props.upLabel} ${String(position)}`}
        title={props.upLabel}
        disabled={disabled || position <= 1}
        onClick={() => { props.onMove(-1) }}
      >
        <ArrowUp width={14} height={14} />
      </button>
      <button
        type="button"
        className={styles.iconButton}
        aria-label={`${props.downLabel} ${String(position)}`}
        title={props.downLabel}
        disabled={disabled || position >= count}
        onClick={() => { props.onMove(1) }}
      >
        <ArrowDown width={14} height={14} />
      </button>
    </>
  )
}
