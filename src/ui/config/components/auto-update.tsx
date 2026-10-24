import { Switch } from '@heroui/react'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useStore } from 'valtio-define'
import { useDistroManaged } from '@/hooks/use-distro-managed'
import { store } from '@/store'
import { toast } from '@/utils/toast'

/** 「自动更新」开关：静默下载 + 退出时自动安装的总开关（issue #1132） */
export function ConfigAutoUpdate() {
  const { t } = useTranslation()
  const { auto_update: autoUpdate } = useStore(store.setting)
  // 发行版仓库构建由包管理器升级，开关不起作用，禁用并说明原因（issue #1230）
  const distroManaged = useDistroManaged()
  const { mutate: setAutoUpdate, isPending } = useMutation({
    mutationFn: (enabled: boolean) => store.setting.update({ autoUpdate: enabled }),
    onError: (error: unknown) => {
      console.error('[ConfigAutoUpdate] update failed:', error)
      toast(t('messages.auto_update_failed'), { variant: 'danger' })
    },
  })

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-ink">{t('ui.auto_update')}</span>
        <Switch
          isSelected={autoUpdate && !distroManaged}
          isDisabled={isPending || distroManaged}
          onChange={setAutoUpdate}
          aria-label={t('ui.auto_update')}
        >
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
          </Switch.Content>
        </Switch>
      </div>
      <p className="text-[10px] text-muted/70">{t(distroManaged ? 'ui.auto_update_distro_hint' : 'ui.auto_update_hint')}</p>
    </div>
  )
}
