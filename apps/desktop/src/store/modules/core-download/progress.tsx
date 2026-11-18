import type { CoreDownloadTask } from './types'
import { ProgressBar } from '@heroui/react'
import i18next from 'i18next'
import { If } from 'react-if-lite'

/** 下载气泡的描述位：状态行 + 进度条，与插件下载气泡同款布局 */
export function coreDownloadDescription(task: CoreDownloadTask) {
  return (
    <span className="flex w-full flex-col gap-1.5">
      <If cond={task.detail !== ''}>
        <span className="text-xs break-all">{task.detail}</span>
      </If>
      <ProgressBar
        aria-label={i18next.t('core.downloading', { version: task.version })}
        className="w-full"
        size="sm"
        value={task.percentage}
      >
        <ProgressBar.Track>
          <ProgressBar.Fill className="bg-info" />
        </ProgressBar.Track>
      </ProgressBar>
    </span>
  )
}
