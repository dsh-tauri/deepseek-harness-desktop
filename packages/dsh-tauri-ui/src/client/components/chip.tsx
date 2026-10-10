// 引用源 @deepseek-ai/dsh-client-ui-agent-preset · packages/client/ui-agent-preset/src/client/AgentPresetSeat.module.css ; @deepseek-ai/dsh-client-ui-permission-presets · packages/client/ui-permission-presets/src/client/PermissionSelect.module.css ; @deepseek-ai/dsh-client-ui-permission-presets · packages/client/ui-permission-presets/src/client/PermissionRow.module.css · 版本 0.1.7-rc.2（≥0.1.5-rc.1）· hash seat=cubgiG_seat composerTrigger=iWlSmW_trigger selector=oY77xG_selector
import type { VariantProps } from 'dsh-tauri/client'
import type { ComponentProps, ReactElement, ReactNode } from 'react'
import { tv } from 'dsh-tauri/client'
import { forwardRef } from 'react'

export interface ChipProps extends Omit<ComponentProps<'button'>, 'children' | 'ref'> {
  variant: ChipVariant
  icon?: ReactNode
  badge?: ReactNode
  chevron?: ReactNode
  open?: boolean
  children?: ReactNode
}

const chip = tv({
  slots: {
    base: 'inline-flex items-center border-none rounded-sm bg-transparent font-medium cursor-pointer disabled:cursor-default',
    // 官方三种 chip 的 chevron 同为一枚细描边 14px artwork；gravity 实心箭头在 14px 下宽 +20.8%、高 +35.6%、
    // 笔画重 +49.9%，实测光学等效点为 11px。属字形属性，故置于块级供三种 variant 共用，调用方传 size 也不再漂移。
    chevron: 'inline-flex shrink-0 text-[var(--dsw-alias-label-caption)] [&_svg]:w-[11px] [&_svg]:h-[11px]',
    icon: 'inline-flex shrink-0',
    label: 'min-w-0 truncate',
    badge: 'shrink-0',
  },
  variants: {
    variant: {
      seat: {
        base: 'gap-[4px] min-w-0 max-w-[min(100%,240px)] min-h-[28px] px-[8px] text-[13px] leading-[20px] text-primary whitespace-nowrap hover:not-disabled:bg-hover aria-expanded:bg-hover disabled:text-[var(--dsw-alias-label-quaternary)]',
        icon: 'text-primary',
      },
      composerTrigger: {
        base: 'gap-[4px] min-w-0 max-w-[220px] h-[28px] pl-[8px] pr-[4px] text-[13px] leading-[20px] text-secondary outline-none hover:not-disabled:bg-hover focus-visible:shadow-focus-ring disabled:text-dimmed',
        icon: '[&_svg]:w-[14px] [&_svg]:h-[14px]',
        chevron: 'transition-transform duration-[120ms] ease-[ease] data-[open=true]:rotate-180',
      },
      // 官方 .selector 是设置行、不旋转；本仓把它当下拉触发器用，故与 composerTrigger 一样带展开态。
      selector: {
        base: 'gap-[12px] h-[36px] px-[14px] rounded-md bg-module-platform [font-family:inherit] text-[14px] leading-[22px] text-primary hover:not-disabled:bg-hover',
        chevron: 'transition-transform duration-[120ms] ease-[ease] data-[open=true]:rotate-180',
      },
    },
    hasIcon: { true: {}, false: {} },
  },
  compoundSlots: [
    {
      variant: 'composerTrigger',
      hasIcon: true,
      slots: ['label'],
      class: '@max-[460px]:hidden',
    },
  ],
})

export type ChipVariant = NonNullable<VariantProps<typeof chip>['variant']>

// eslint-disable-next-line react/no-forward-ref -- 部署端前端内置 React 18（issue #783）：普通函数组件会静默丢弃 ref
export const Chip = forwardRef<HTMLButtonElement, ChipProps>((
  { variant, icon, badge, chevron, open, className, children, ...rest },
  ref,
): ReactElement => {
  // 官方 PermissionRow.selector 不包 icon/label/badge，其余两个 variant 按 PermissionSelect/AgentPresetSeat 包裹。
  const wraps = variant !== 'selector'
  const styles = chip({ variant, hasIcon: wraps && icon != null })
  return (
    <button type="button" className={styles.base({ className })} {...rest} ref={ref}>
      {wraps && icon != null ? <span className={styles.icon()} aria-hidden>{icon}</span> : icon}
      {wraps && children != null ? <span className={styles.label()}>{children}</span> : children}
      {wraps && badge != null ? <span className={styles.badge()} aria-hidden>{badge}</span> : badge}
      {chevron === undefined
        ? null
        : <span className={styles.chevron()} aria-hidden data-open={open === true ? 'true' : undefined}>{chevron}</span>}
    </button>
  )
})
