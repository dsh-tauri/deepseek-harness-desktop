import type { UseQueryResult } from '@tanstack/react-query'
import type { GetApiTauriRemoteCoreCurrentResponse, GetApiTauriRemoteCoreProfilesResponse } from '@/apis/remote.types'
import type { RemoteMachineRow } from '@/hooks/use-remote'
import { ArrowRotateRight } from '@gravity-ui/icons'
import { Button, Chip, Description, Label, Spinner } from '@heroui/react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { getCoreCurrent, getCoreProfiles, getCoreVersions } from '@/apis/remote'
import { Empty } from '@/components/empty'
import { Item } from '@/components/item'
import { Panel } from '@/components/panel'
import { queryKeys } from '@/config/query-keys'
import { loadRemoteMachines } from '@/hooks/use-remote'
import { useRemoteMachineFilter } from '@/hooks/use-remote-machine-filter'
import { RemoteMachinePicker } from './remote-machine-picker'

type CoreTarget = NonNullable<GetApiTauriRemoteCoreCurrentResponse['item']>
type CoreSlot = Extract<CoreTarget, { availability: 'present' }>['slots'][number]
type CoreProfile = NonNullable<GetApiTauriRemoteCoreProfilesResponse['items']>[number]

export function RemoteCoreSection() {
  const { t } = useTranslation()

  // 1. 数据查询 (Queries)
  const machinesQuery = useQuery({
    queryKey: queryKeys.remoteMachines,
    queryFn: loadRemoteMachines,
    refetchInterval: 2000,
  })
  const machines = machinesQuery.data?.machines ?? []
  const enabled = machinesQuery.data?.enabled === true
  const versionsQuery = useQuery({
    queryKey: queryKeys.remoteCoreVersions,
    enabled,
    queryFn: async () => {
      const response = await getCoreVersions()
      if (response.error !== undefined)
        throw new Error(response.error)
      return response.items ?? []
    },
  })

  // 2. 本地用户选择状态
  const [selectedId, setSelectedId] = useRemoteMachineFilter(machines)

  // 3. 远端 Core 数据 Query
  const targetQueries = useQueries({
    queries: machines.map(machine => ({
      queryKey: queryKeys.remoteCoreTarget(machine.id),
      queryFn: async (): Promise<CoreTarget> => {
        const response = await getCoreCurrent({ machineId: machine.id })
        if (response.item === undefined)
          throw new Error(response.error ?? t('core.remote_unavailable'))
        return response.item
      },
    })),
  })
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
  const machineError = machinesQuery.error === null ? '' : String(machinesQuery.error)
  const visibleMachines = machines.flatMap((machine, index) => {
    const target = targetQueries[index]
    const profiles = profileQueries[index]
    if (target === undefined || profiles === undefined || (selectedId !== '' && machine.id !== selectedId))
      return []
    return [{ machine, profiles, target }]
  })
  const refreshing = machinesQuery.isFetching
    || versionsQuery.isFetching
    || targetQueries.some(query => query.isFetching)
    || profileQueries.some(query => query.isFetching)
  const versions = versionsQuery.data ?? []
  const versionsError = versionsQuery.error === null ? '' : String(versionsQuery.error)
  const visible = enabled || machinesQuery.isError

  async function onRefresh() {
    await Promise.allSettled([
      machinesQuery.refetch(),
      versionsQuery.refetch(),
      ...targetQueries.map(query => query.refetch()),
      ...profileQueries.map(query => query.refetch()),
    ])
  }

  return (
    <If cond={visible}>
      <div className="space-y-2 border-t border-line/30 pt-3" data-testid="dsh-core-remote-section">
        <div className="flex items-center justify-between gap-2 px-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-ink">{t('core.remote_cores')}</span>
            <Chip size="sm" variant="soft" color="accent">{t('core.remote_read_only')}</Chip>
          </div>
          <div className="flex items-center gap-1.5">
            <If cond={machines.length > 0}>
              <RemoteMachinePicker machines={machines} selectedId={selectedId} onChange={setSelectedId} testId="dsh-core-remote-target" />
            </If>
            <Button
              size="sm"
              variant="tertiary"
              isDisabled={refreshing}
              aria-label={t('core.refresh')}
              onPress={() => void onRefresh()}
            >
              <If cond={refreshing} then={<Spinner size="sm" color="current" />} else={<ArrowRotateRight className="size-3.5" />} />
              {t('core.refresh')}
            </Button>
          </div>
        </div>

        <Panel.Loadable loading={machinesQuery.isPending} error={machineError}>
          <If cond={machines.length === 0}>
            <Empty>{t('core.remote_no_machines')}</Empty>
          </If>
          <If cond={machines.length > 0}>
            <Panel.Loadable loading={versionsQuery.isPending && enabled} error={versionsError}>
              <If cond={versions.length > 0}>
                <div className="flex flex-wrap items-center gap-1.5 px-1">
                  <span className="text-xs text-muted">{t('core.remote_versions')}</span>
                  {versions.map(version => (
                    <Chip key={version.tag} size="sm" variant="soft" color={version.preview ? 'warning' : 'default'}>
                      {version.version}
                    </Chip>
                  ))}
                </div>
              </If>
            </Panel.Loadable>
            {visibleMachines.map(({ machine, profiles, target }) => (
              <RemoteMachineCore key={machine.id} machine={machine} profiles={profiles} target={target} />
            ))}
          </If>
        </Panel.Loadable>
      </div>
    </If>
  )
}

function RemoteMachineCore({ machine, profiles, target }: { machine: RemoteMachineRow, profiles: UseQueryResult<CoreProfile[]>, target: UseQueryResult<CoreTarget> }) {
  const { t } = useTranslation()
  const targetError = target.error === null ? '' : String(target.error)
  const profilesError = profiles.error === null ? '' : String(profiles.error)
  const unreadableError = unreadableErrorOf(target.data)
  const targetSlots = target.data?.availability === 'present' ? target.data.slots : []
  const capabilities = target.data?.capabilities ?? []

  return (
    <div className="space-y-2" data-testid={`dsh-core-remote-machine-${machine.id}`}>
      <div className="flex items-center justify-between gap-2 px-1">
        <Label className="text-sm font-medium text-ink">{machine.name}</Label>
        <Chip size="sm" variant="soft" color="default">{t(`remote.state.${machine.state}`)}</Chip>
      </div>
      <Panel.Loadable loading={profiles.isPending} error={profilesError}>
        <If cond={(profiles.data?.length ?? 0) > 0}>
          <div className="flex flex-wrap items-center gap-1.5 px-1">
            <span className="text-xs text-muted">{t('core.remote_profiles')}</span>
            {profiles.data?.map(profile => (
              <Chip key={profile.name} size="sm" variant="soft" color={profile.configured ? 'accent' : 'default'}>
                {profile.name}
              </Chip>
            ))}
          </div>
        </If>
      </Panel.Loadable>
      <Panel.Loadable loading={target.isPending} error={targetError}>
        <If cond={target.data?.remoteProfile !== undefined}>
          <Description className="px-1 text-xs text-muted">
            {t('core.remote_profile', { profile: target.data?.remoteProfile })}
          </Description>
        </If>
        <If cond={capabilities.length > 0}>
          <Description className="px-1 text-xs text-muted">
            {t('core.remote_capabilities', { capabilities: capabilities.join(', ') })}
          </Description>
        </If>
        <If cond={target.data !== undefined && target.data.availability !== 'unreadable' && targetSlots.length === 0}>
          <Empty>{t('core.remote_missing')}</Empty>
        </If>
        <If cond={target.data?.availability === 'unreadable'}>
          <Item
            left={<Label className="text-sm font-medium text-danger">{t('core.remote_unavailable')}</Label>}
            footer={<Description className="break-all text-xs text-danger">{unreadableError}</Description>}
          />
        </If>
        <If cond={target.data?.availability === 'present'}>
          {targetSlots.map(slot => <RemoteCoreSlot key={slot.slotKey} slot={slot} />)}
        </If>
      </Panel.Loadable>
    </div>
  )
}

function RemoteCoreSlot({ slot }: { slot: CoreSlot }) {
  const { t } = useTranslation()
  const view = slotViewOf(slot)

  return (
    <div data-testid={`dsh-core-remote-slot-${slot.slotKey}`}>
      <Item
        left={(
          <>
            <Label className="min-w-0 truncate font-mono text-sm font-medium text-ink">{view.version}</Label>
            <Chip size="sm" variant="soft" color="accent" className="shrink-0 font-medium">{t('core.remote')}</Chip>
            <If cond={view.active}>
              <Chip size="sm" variant="soft" color="success" className="shrink-0 font-medium">{t('core.active')}</Chip>
            </If>
            <If cond={view.preview}>
              <Chip size="sm" variant="soft" color="warning" className="shrink-0 font-medium">{t('core.preview')}</Chip>
            </If>
            <If cond={slot.kind === 'unsupported'}>
              <Chip size="sm" variant="soft" color="danger" className="shrink-0 font-medium">{t('core.remote_unsupported')}</Chip>
            </If>
            <If cond={slot.kind === 'unreadable'}>
              <Chip size="sm" variant="soft" color="danger" className="shrink-0 font-medium">{t('core.remote_unreadable')}</Chip>
            </If>
          </>
        )}
        footer={(
          <>
            <Description className="break-all text-xs text-muted">{t('core.remote_slot', { slot: slot.slotKey })}</Description>
            <If cond={view.tag !== undefined}>
              <Description className="break-all font-mono text-[10px] text-muted/70">{view.tag}</Description>
            </If>
            <If cond={view.error !== undefined}>
              <Description className="break-all text-xs text-danger">{view.error}</Description>
            </If>
          </>
        )}
      />
    </div>
  )
}

function slotViewOf(slot: CoreSlot): { version: string, active: boolean, preview: boolean, tag?: string, error?: string } {
  if (slot.kind === 'installed') {
    return {
      version: slot.version,
      active: slot.active,
      preview: slot.preview,
      ...slot.tag === undefined ? {} : { tag: slot.tag },
    }
  }
  if (slot.kind === 'unsupported') {
    return {
      version: slot.version,
      active: false,
      preview: false,
      error: slot.error,
    }
  }
  return {
    version: slot.slotKey,
    active: false,
    preview: false,
    error: slot.error,
  }
}

function unreadableErrorOf(target: CoreTarget | undefined): string | undefined {
  if (target?.availability === 'unreadable')
    return target.error
  return undefined
}
