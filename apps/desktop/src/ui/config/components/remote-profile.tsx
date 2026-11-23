import type { GetApiTauriRemoteCoreProfilesResponse } from '@/apis/remote.types'
import type { RemoteMachineRow } from '@/hooks/use-remote'
import { ArrowRotateRight } from '@gravity-ui/icons'
import { Button, Chip, Description, Label, Spinner } from '@heroui/react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { getCoreInstance, getCoreProfiles } from '@/apis/remote'
import { Empty } from '@/components/empty'
import { Panel } from '@/components/panel'
import { queryKeys } from '@/config/query-keys'

type CoreProfile = NonNullable<GetApiTauriRemoteCoreProfilesResponse['items']>[number]

/**
 * 某台远端机器上的档案只读视图。
 *
 * 档案作用域由档案页顶部的「管理范围」选择器决定：选中本机时桌面壳提供完整功能，
 * 选中远端机器时这里只展示该机器上的档案，不提供创建、克隆、切换或删除。
 */
export function RemoteProfileSection({ machine }: { machine: RemoteMachineRow }) {
  const { t } = useTranslation()

  const profilesQuery = useQuery({
    queryKey: queryKeys.remoteCoreProfiles(machine.id),
    queryFn: async (): Promise<CoreProfile[]> => {
      const response = await getCoreProfiles({ machineId: machine.id })
      if (response.error !== undefined)
        throw new Error(response.error)
      return response.items ?? []
    },
  })

  // 端口上实例的实际档案（P3-0，issue #1600）：按实例自报展示，不用机器配置的档案覆盖。
  const instanceQuery = useQuery({
    queryKey: queryKeys.remoteCoreInstance(machine.id),
    queryFn: async () => {
      const response = await getCoreInstance({ machineId: machine.id })
      if (response.error !== undefined)
        throw new Error(response.error)
      return response.item ?? null
    },
  })
  const instance = instanceQuery.data

  const refreshing = profilesQuery.isFetching || instanceQuery.isFetching
  const error = profilesQuery.error === null ? '' : String(profilesQuery.error)
  const items = profilesQuery.data ?? []

  return (
    <div className="space-y-2" data-testid="dsh-profile-remote-section">
      <div className="flex items-center justify-between gap-2 px-1">
        <div className="flex items-center gap-2">
          <Label className="text-sm font-medium text-ink">{machine.name}</Label>
          <Chip size="sm" variant="soft" color="default">{t(`remote.state.${machine.state}`)}</Chip>
          <Chip size="sm" variant="soft" color="accent">{t('core.remote_read_only')}</Chip>
        </div>
        <Button
          size="sm"
          variant="tertiary"
          isDisabled={refreshing}
          aria-label={t('profiles.remote_refresh')}
          onPress={() => {
            void profilesQuery.refetch()
            void instanceQuery.refetch()
          }}
        >
          <If cond={refreshing} then={<Spinner size="sm" color="current" />} else={<ArrowRotateRight className="size-3.5" />} />
          {t('profiles.remote_refresh')}
        </Button>
      </div>

      <Panel.Loadable loading={profilesQuery.isPending} error={error}>
        <If cond={instanceQuery.error != null}>
          <div className="px-1 pb-1" data-testid={`dsh-profile-remote-instance-error-${machine.id}`}>
            <Description className="text-[10px] text-warning">{t('profiles.remote_instance_error')}</Description>
          </div>
        </If>
        <If cond={instance != null}>
          <div className="flex flex-wrap items-center gap-1.5 px-1 pb-1" data-testid={`dsh-profile-remote-instance-${machine.id}`}>
            <span className="text-xs text-muted">{t('profiles.remote_instance_profile')}</span>
            <Chip
              size="sm"
              variant="soft"
              color={instance?.verdict === 'mismatch' ? 'warning' : instance?.verdict === 'match' ? 'success' : 'default'}
              data-testid={`dsh-profile-remote-instance-profile-${machine.id}`}
            >
              {instance?.actual ?? t('profiles.remote_instance_unknown')}
            </Chip>
            <If cond={instance?.verdict === 'mismatch'}>
              <Description className="text-[10px] text-warning">
                {t('profiles.remote_instance_mismatch', { configured: instance?.expected ?? '' })}
              </Description>
            </If>
            <If cond={instance?.pid !== undefined}>
              <Description className="text-[10px] text-muted">{t('profiles.remote_instance_pid', { pid: instance?.pid ?? '' })}</Description>
            </If>
          </div>
        </If>
        <If cond={items.length === 0}>
          <Empty>{t('profiles.remote_empty')}</Empty>
        </If>
        <If cond={items.length > 0}>
          <div className="flex flex-wrap items-center gap-1.5 px-1">
            <span className="text-xs text-muted">{t('core.remote_profiles')}</span>
            {items.map(profile => (
              <span className="flex items-center gap-1" key={profile.name}>
                <Chip
                  size="sm"
                  variant="soft"
                  color={profile.configured ? 'accent' : 'default'}
                  data-testid={`dsh-profile-remote-${machine.id}-${profile.name}`}
                >
                  {profile.name}
                </Chip>
                <If cond={profile.configured}>
                  <Description className="text-[10px] text-muted">{t('profiles.remote_configured')}</Description>
                </If>
              </span>
            ))}
          </div>
        </If>
      </Panel.Loadable>
    </div>
  )
}
