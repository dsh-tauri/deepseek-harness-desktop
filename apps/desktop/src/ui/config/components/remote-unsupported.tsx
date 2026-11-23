import { Typography } from '@heroui/react'
import { useTranslation } from 'react-i18next'

/** 远端 SSH 会话下，这些页面管理的是发起端本机状态，远端实例不从壳层改写 */
export function RemoteUnsupported({ title }: { title: string }) {
  const { t } = useTranslation()
  return (
    <div className="space-y-3" data-testid="remote-unsupported">
      <Typography type="h4" data-testid="dsh-config-panel-title">{title}</Typography>
      <p className="rounded-lg bg-background-secondary px-4 py-8 text-center text-xs text-muted">
        {t('remote.unsupported')}
      </p>
    </div>
  )
}
