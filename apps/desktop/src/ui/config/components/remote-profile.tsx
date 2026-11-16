import type { UseQueryResult } from '@tanstack/react-query'
import type { GetApiTauriRemoteCoreProfilesResponse } from '@/apis/remote.types'
import type { RemoteMachineRow } from '@/hooks/use-remote'
import { ArrowRotateRight } from '@gravity-ui/icons'
import { Button, Chip, Description, Label, Spinner } from '@heroui/react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { getCoreProfiles } from '@/apis/remote'
import { Empty } from '@/components/empty'
import { Panel } from '@/components/panel'
import { queryKeys } from '@/config/query-keys'
import { loadRemoteMachines } from '@/hooks/use-remote'
import { useRemoteMachineFilter } from '@/hooks/use-remote-machine-filter'
import { RemoteMachinePicker } from './remote-machine-picker'

type CoreProfile = NonNullable<GetApiTauriRemoteCoreProfilesResponse['items']>[number]

export function RemoteProfileSection() {
  const { t } = useTranslation()

  // 1. 数据查询 (Queries)
  const machinesQuery = useQuery({
    queryKey: queryKeys.remoteMachines,
    queryFn: loadRemoteMachines,
    refetchInterval: 2000,
  })
  const machines = machinesQuery.data?.machines ?? []

  // 2. 本地用户选择状态
  const [selectedId, setSelectedId] = useRemoteMachineFilter(machines)

  // 3. 远端 Profile 数据 Query
  const profileQueries = useQueries({
    queries: machines.map(machine => ({
      queryKey: queryKeys.remoteCoreProfiles(machine.id),
      queryFn: async (): Promise<CoreProfile[]> => {
        const response = await getCoreProfiles({ machineId: machine.id })
        if (response.error !== undefined)
          throw new Error(response.error)
        return response.items ?? []
      },
    })),
  })

  // 4. 派生数据提取与 Map 索引构造
  const refreshing = machinesQuery.isFetching || profileQueries.some(query => query.isFetching)
  const visibleMachines = machines.flatMap((machine, index) => {
    const profiles = profileQueries[index]
    if (profiles === undefined || (selectedId !== '' && machine.id !== selectedId))
      return []
    return [{ machine, profiles }]
  })
  const enabled = machinesQuery.data?.enabled === true
  const machineError = machinesQuery.error === null ? '' : String(machinesQuery.error)
  const visible = enabled || machinesQuery.isError

  async function onRefresh() {
    await Promise.allSettled([
      machinesQuery.refetch(),
      ...profileQueries.map(query => query.refetch()),
    ])
  }

  return (
    <If cond={visible}>
      <div className="space-y-2 border-t border-line/30 pt-3" data-testid="dsh-profile-remote-section">
        <div className="flex items-center justify-between gap-2 px-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-ink">{t('profiles.remote_title')}</span>
            <Chip size="sm" variant="soft" color="accent">{t('core.remote_read_only')}</Chip>
          </div>
          <div className="flex items-center gap-1.5">
            <If cond={machines.length > 0}>
              <RemoteMachinePicker machines={machines} selectedId={selectedId} onChange={setSelectedId} testId="dsh-profile-remote-target" />
            </If>
            <Button
              size="sm"
              variant="tertiary"
              isDisabled={refreshing}
              aria-label={t('profiles.remote_refresh')}
              onPress={() => void onRefresh()}
            >
              <If cond={refreshing} then={<Spinner size="sm" color="current" />} else={<ArrowRotateRight className="size-3.5" />} />
              {t('profiles.remote_refresh')}
            </Button>
          </div>
        </div>

        <Panel.Loadable loading={machinesQuery.isPending} error={machineError}>
          <If cond={machines.length === 0}>
            <Empty>{t('core.remote_no_machines')}</Empty>
          </If>
          {visibleMachines.map(({ machine, profiles }) => (
            <RemoteMachineProfiles key={machine.id} machine={machine} profiles={profiles} />
          ))}
        </Panel.Loadable>
      </div>
    </If>
  )
}

function RemoteMachineProfiles({ machine, profiles }: { machine: RemoteMachineRow, profiles: UseQueryResult<CoreProfile[]> }) {
  const { t } = useTranslation()
  const error = profiles.error === null ? '' : String(profiles.error)
  const items = profiles.data ?? []

  return (
    <div className="space-y-2" data-testid={`dsh-profile-remote-machine-${machine.id}`}>
      <div className="flex items-center justify-between gap-2 px-1">
        <Label className="text-sm font-medium text-ink">{machine.name}</Label>
        <Chip size="sm" variant="soft" color="default">{t(`remote.state.${machine.state}`)}</Chip>
      </div>
      <Panel.Loadable loading={profiles.isPending} error={error}>
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
