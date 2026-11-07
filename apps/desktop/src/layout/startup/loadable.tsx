import type { ComponentType, ReactNode, SVGProps } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { Panel } from '@/components/panel'
import { button } from '@/components/primitives'

export type IconComponent = ComponentType<SVGProps<SVGSVGElement>>

export interface LoadableProps {

  icon?: IconComponent

  title?: string

  subtitle?: string

  percentage?: number

  logs?: readonly string[]

  errorMsg?: string

  onRetry?: () => void

  testId?: string

  children?: ReactNode
}

export function Loadable({
  icon: Icon,
  title,
  subtitle,
  percentage,
  logs,
  errorMsg,
  onRetry,
  testId,
  children,
}: LoadableProps) {
  const { t } = useTranslation()
  const error = errorMsg != null
  const wordmark = title ?? t('app.wordmark')
  const hint = error ? errorMsg : subtitle ?? t('status.loading_plugins')
  const hasLogs = logs != null
  const showPanel = hasLogs || percentage != null

  return (
    <div className="flex h-full items-center justify-center bg-startup w-full" data-testid={testId}>
      <div className="flex w-[min(460px,88vw)] flex-col items-center gap-4 text-center -mt-[1px]">
        {}
        {}
        <If cond={error && Icon != null}>
          {Icon != null && <Icon className="size-7 text-load-ink" />}
        </If>

        <span className="text-base leading-6 font-semibold tracking-[0.08em] text-load-ink truncate">{wordmark}</span>

        <If
          cond={error}
          else={(
            <>
              <span className="h-5 w-5 animate-load-spin rounded-full border-2 border-load-ring border-t-load-ink" />
              <p className="min-h-[18px] text-xs leading-[18px] break-all text-load-muted">{hint}</p>
            </>
          )}
        >
          {}
          <p className="min-h-[18px] max-w-full font-mono text-xs leading-[18px] break-all text-load-muted">{hint}</p>
        </If>

        <If cond={onRetry != null}>
          <button
            className={button({ tone: 'primary' })}
            onClick={onRetry}
          >
            {t('app.retry')}
          </button>
        </If>

        <If cond={showPanel}>
          <div className="flex w-full flex-col gap-4">
            <Panel.Progress percentage={percentage} logs={logs} />
          </div>
        </If>

        {children}
      </div>
    </div>
  )
}
