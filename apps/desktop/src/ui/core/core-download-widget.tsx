import { Button, Spinner } from '@heroui/react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { Panel } from '@/components/panel'
import { store } from '@/store'

/** 核心下载右下角浮窗：后台下载的进度、日志与切换入口 */
export function CoreDownloadWidget() {
  // 1. 数据查询 (Queries)
  const { t } = useTranslation()
  const { task } = useStore(store.coreDownload)

  // 4. 派生数据提取
  const running = task?.status === 'running'
  const switching = task?.status === 'switching'
  const success = task?.status === 'success'
  const failed = task?.status === 'failed'

  if (!task) {
    return null
  }

  return (
    <div
      className="pointer-events-auto fixed right-4 bottom-4 z-40 flex w-[320px] flex-col gap-3 rounded-xl border border-line bg-panel p-4 shadow-lg"
      data-testid="dsh-core-download-widget"
    >
      {/* 标题与状态 */}
      <div className="flex items-start gap-2">
        <If cond={running || switching}>
          <Spinner size="sm" color="current" />
        </If>
        <div className="min-w-0 flex-1" role="status">
          <p className="m-0 truncate text-sm font-medium text-ink">
            <If
              cond={failed}
              else={(
                <If cond={success} else={t('core.downloading', { version: task.version })}>
                  {t('core.downloaded_toast', { version: task.version })}
                </If>
              )}
            >
              {t('core.download_failed')}
            </If>
          </p>
          <p className="m-0 break-all text-xs text-muted">
            <If
              cond={failed}
              else={(
                <If cond={switching} else={<If cond={running}>{t('core.downloading_hint', { version: task.version })}</If>}>
                  {t('core.switch_restart_hint')}
                </If>
              )}
            >
              {task.error}
            </If>
          </p>
        </div>
      </div>

      {/* 进度条与最近日志 */}
      <Panel.Progress percentage={task.percentage} logs={task.logs} />

      {/* 操作：成功后切换/关闭，失败后重试/关闭 */}
      <div className="flex justify-end gap-2">
        <If cond={success || failed}>
          <Button size="sm" variant="tertiary" onPress={store.coreDownload.dismiss}>
            {t('core.download_close')}
          </Button>
        </If>
        <If cond={success}>
          <Button size="sm" variant="primary" onPress={() => void store.coreDownload.activate()}>
            {t('core.download_switch')}
          </Button>
        </If>
        <If cond={failed}>
          <Button size="sm" variant="primary" onPress={() => void store.coreDownload.retry()}>
            {t('app.retry')}
          </Button>
        </If>
      </div>
    </div>
  )
}
