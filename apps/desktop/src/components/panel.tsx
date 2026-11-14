/* eslint-disable react-refresh/only-export-components -- 复合组件导出（与 HeroUI 的 Modal.* / Select.* 同款写法） */
import type { ReactNode } from 'react'
import { Spinner, Typography } from '@heroui/react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { cn } from 'tailwind-variants'
import { Logs } from './logs'

/** 进度面板最多展示的日志行数 */
const LOG_LIMIT = 5

/**
 * 面板（`Panel`）复合组件：设置面板共用的三块结构。
 *
 * - `Panel.Header`  标题 + 说明（+ 右侧动作位）
 * - `Panel.Loadable` 列表三态（加载中 / 加载失败 / 正常内容）
 * - `Panel.Progress` 进度条 + 日志面板
 *
 * 三者原本是三个独立文件（panel-header / panel-loadable / panel-progress），
 * 统一收敛到本文件并用点号导出，调用方只需 import 一个 `Panel`。
 */
export interface PanelHeaderProps {
  title: string | ReactNode
  description?: string
  className?: string
  action?: ReactNode
  /** 标题元素的 `data-testid`（E2E 定位用；`title` 为节点时忽略） */
  testId?: string
}

/** 配置面板头部：标题 + 说明；className 用于叠加 sticky / 背景等定位类。 */
function Header({ title, description, className, action, testId }: PanelHeaderProps) {
  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center justify-between gap-3">
        {typeof title === 'string' ? <Typography type="h4" data-testid={testId}>{title}</Typography> : title}
        {action}
      </div>
      <If cond={Boolean(description)}>
        <Typography color="muted" type="body-sm">{description}</Typography>
      </If>
    </div>
  )
}

export interface PanelLoadableProps {
  loading: boolean
  error: string
  children?: ReactNode
}

/**
 * 列表三态（加载中 / 加载失败 / 正常内容）。
 * 加载中带 spinner，失败态复用 plugins.error 文案；error 为空且非 loading 时渲染 children。
 */
function Loadable({ loading, error, children }: PanelLoadableProps) {
  const { t } = useTranslation()
  return (
    <If
      cond={!loading && error === ''}
      else={(
        <If
          cond={loading}
          else={(
            <p className="rounded-md border border-danger/30 bg-danger/5 p-3 text-xs text-danger">
              {t('plugins.error')}
              ：
              {error}
            </p>
          )}
        >
          <div className="flex items-center justify-center gap-2 p-4 text-xs text-muted">
            <Spinner size="sm" color="current" />
            {t('plugins.loading')}
          </div>
        </If>
      )}
    >
      {children}
    </If>
  )
}

export interface PanelProgressProps {
  /** 进度百分比（0-100）；不传则不渲染进度条 */
  percentage?: number
  /** 日志行；不传则不渲染日志面板（空数组渲染"等待日志"占位） */
  logs?: readonly string[]
}

/** 进度条宽度、无障碍值与右侧数字的唯一取值：先取整再钳制，三者不会因精度分叉 */
function progressPercent(percentage: number): number {
  if (!Number.isFinite(percentage))
    return 0
  return Math.min(100, Math.max(0, Math.round(percentage)))
}

/** 安装/下载进度面板：宽度、`aria-valuenow` 与右侧数字共用同一个整数百分比，且不加宽度过渡（后端 50ms 一推，过渡会被每次新值重置，条会长期落后于数字） */
function Progress({ percentage, logs }: PanelProgressProps) {
  const hasLogs = logs != null
  const percent = percentage == null ? null : progressPercent(percentage)

  return (
    <If cond={hasLogs || percent != null}>
      <div className="flex w-full flex-col gap-4">
        <If cond={percent != null}>
          <div className="flex items-center gap-3">
            <div
              className="h-2 flex-1 overflow-hidden rounded-full bg-panel2"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent ?? 0}
            >
              <div className="h-full bg-gradient-to-r from-info to-info-hover" style={{ width: `${percent ?? 0}%` }} />
            </div>
            <span className="min-w-[44px] text-right text-[13px] font-semibold tabular-nums text-info-hover">
              {percent ?? 0}
              %
            </span>
          </div>
        </If>
        <If cond={hasLogs}>
          <Logs logs={logs ?? []} limit={LOG_LIMIT} bodyClassName="max-h-[184px]" />
        </If>
      </div>
    </If>
  )
}

export const Panel = { Header, Loadable, Progress }
