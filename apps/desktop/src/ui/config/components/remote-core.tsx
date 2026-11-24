import type { RemoteCoreRow, RemoteCoreTarget } from './remote-core.rows'
import type { GetApiTauriRemoteCoreProfilesResponse } from '@/apis/remote.types'
import { ArrowRotateRight, ChevronRight, Copy, CircleArrowDown as DownloadIcon } from '@gravity-ui/icons'
import { Button, Checkbox, Chip, Description, Label, Spinner } from '@heroui/react'
import { useToggle } from '@reause/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { getCoreCurrent, getCoreProfiles, getCoreTasksEvents, getCoreVersions, postCoreInstall } from '@/apis/remote'
import { Empty } from '@/components/empty'
import { Item } from '@/components/item'
import { Panel } from '@/components/panel'
import { queryKeys } from '@/config/query-keys'
import { loadRemoteMachines } from '@/hooks/use-remote'
import { writeClipboardText } from '@/utils/clipboard'
import { toast } from '@/utils/toast'
import { buildRemoteCoreRows } from './remote-core.rows'

type CoreProfile = NonNullable<GetApiTauriRemoteCoreProfilesResponse['items']>[number]

const DOWNLOAD_POLL_INTERVAL_MS = 1500
const DOWNLOAD_POLL_LIMIT = 1200

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

interface RemoteDownload {
  machineId: string
  tag: string
  version: string
}

export function RemoteCoreList({ machineId }: { machineId: string }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const versionsQuery = useQuery({
    queryKey: queryKeys.remoteCoreVersions,
    queryFn: async () => {
      const response = await getCoreVersions()
      if (response.error !== undefined)
        throw new Error(response.error)
      return response.items ?? []
    },
  })
  const targetQuery = useQuery({
    queryKey: queryKeys.remoteCoreTarget(machineId),
    queryFn: async (): Promise<RemoteCoreTarget> => {
      const response = await getCoreCurrent({ machineId })
      if (response.item === undefined)
        throw new Error(response.error ?? t('core.remote_unavailable'))
      return response.item
    },
  })
  const profilesQuery = useQuery({
    queryKey: queryKeys.remoteCoreProfiles(machineId),
    queryFn: async (): Promise<CoreProfile[]> => {
      const response = await getCoreProfiles({ machineId })
      if (response.error !== undefined)
        throw new Error(response.error)
      return response.items ?? []
    },
  })
  const machinesQuery = useQuery({ queryKey: queryKeys.remoteMachines, queryFn: loadRemoteMachines })
  const machine = machinesQuery.data?.machines.find(item => item.id === machineId)

  const [download, setDownload] = useState<RemoteDownload>()
  const [progress, setProgress] = useState<string>()

  const installMutation = useMutation({
    mutationFn: async (input: { machineId: string, tag: string, version: string }) => {
      const response = await postCoreInstall({ machineId: input.machineId, tag: input.tag })
      if (response.taskId === undefined)
        throw new Error(response.error ?? t('core.download_failed'))
      const taskId = response.taskId
      for (let attempt = 0; attempt < DOWNLOAD_POLL_LIMIT; attempt++) {
        const events = await getCoreTasksEvents({ taskId })
        if (events.error !== undefined)
          throw new Error(events.error)
        const items = events.items ?? []
        setProgress(items.at(-1)?.line)
        const finished = items.find(item => item.terminal !== undefined)
        if (finished !== undefined) {
          if (finished.terminal === 'failed')
            throw new Error(finished.reason ?? finished.line)
          return input.version
        }
        await sleep(DOWNLOAD_POLL_INTERVAL_MS)
      }
      throw new Error(t('core.download_failed'))
    },
    onSuccess: (version, input) => {
      toast(t('core.downloaded_toast', { version }))
      setDownload(current => current?.machineId === input.machineId ? undefined : current)
      setProgress(undefined)
      void queryClient.invalidateQueries({ queryKey: queryKeys.remoteCoreTarget(input.machineId) })
    },
    onError: (error, input) => {
      toast(t('core.download_failed'), { variant: 'danger', description: error instanceof Error ? error.message : String(error) })
      setDownload(current => current?.machineId === input.machineId ? undefined : current)
      setProgress(undefined)
    },
  })

  const targetError = targetQuery.error === null ? '' : String(targetQuery.error)
  const profilesError = profilesQuery.error === null ? '' : String(profilesQuery.error)
  const versionsError = versionsQuery.error === null ? '' : String(versionsQuery.error)
  const target = targetQuery.data
  const targetSlots = target?.availability === 'present' ? target.slots : []
  const capabilities = target?.capabilities ?? []
  const versions = versionsQuery.data ?? []
  const rows = buildRemoteCoreRows(targetSlots, versions)
  const activeDownload = download?.machineId === machineId ? download : undefined

  return (
    <div className="space-y-2" data-testid="dsh-core-remote-list">
      <Panel.Loadable loading={targetQuery.isPending || profilesQuery.isPending} error={targetError || profilesError}>
        <If cond={machine !== undefined}>
          <div className="flex items-center gap-1.5 px-1">
            <Label className="min-w-0 truncate text-sm font-medium text-ink">{machine?.name}</Label>
            <Chip size="sm" variant="soft" color="default">{t(`remote.state.${machine?.state}`)}</Chip>
            <If cond={target?.remoteProfile !== undefined}>
              <Description className="text-xs text-muted">
                {t('core.remote_profile', { profile: target?.remoteProfile })}
              </Description>
            </If>
          </div>
        </If>
        <Panel.Loadable loading={profilesQuery.isPending} error={profilesError}>
          <If cond={(profilesQuery.data?.length ?? 0) > 0}>
            <div className="flex flex-wrap items-center gap-1.5 px-1">
              <span className="text-xs text-muted">{t('core.remote_profiles')}</span>
              {profilesQuery.data?.map(profile => (
                <Chip key={profile.name} size="sm" variant="soft" color={profile.configured ? 'accent' : 'default'}>
                  {profile.name}
                </Chip>
              ))}
            </div>
          </If>
        </Panel.Loadable>
        <Panel.Loadable loading={versionsQuery.isPending} error={versionsError}>
          <If cond={target !== undefined && target.availability !== 'unreadable' && targetSlots.length === 0}>
            <Empty>{t('core.remote_missing')}</Empty>
          </If>
          <If cond={target?.availability === 'unreadable'}>
            <Item
              left={<Label className="text-sm font-medium text-danger">{t('core.remote_unavailable')}</Label>}
              footer={<Description className="break-all text-xs text-danger">{unreadableErrorOf(target)}</Description>}
            />
          </If>
          <If cond={target?.availability === 'present' || target?.availability === 'absent'}>
            <RemoteCoreRows
              rows={rows}
              download={activeDownload}
              progress={activeDownload === undefined ? undefined : progress}
              downloading={installMutation.isPending}
              canDownload={capabilities.includes('installVersion')}
              onDownload={(row) => {
                if (row.tag === undefined || installMutation.isPending)
                  return
                setDownload({ machineId, tag: row.tag, version: row.version })
                installMutation.mutate({ machineId, tag: row.tag, version: row.version })
              }}
            />
          </If>
        </Panel.Loadable>
      </Panel.Loadable>
    </div>
  )
}

/** 远端机器上的核心面板：窗口挂在远端 SSH 时替代本机核心面板 */
export function RemoteCoreSection({ machineId }: { machineId: string }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [refreshing, toggleRefreshing] = useToggle()

  async function onRefresh() {
    if (refreshing)
      return
    toggleRefreshing(true)
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.remoteCoreTarget(machineId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.remoteCoreProfiles(machineId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.remoteCoreVersions }),
      ])
      toast(t('core.refreshed_toast'), {})
    }
    catch (err) {
      console.error('[RemoteCoreSection] refresh failed:', err)
      toast(t('core.refresh_failed'), {})
    }
    finally {
      toggleRefreshing(false)
    }
  }

  return (
    <div className="space-y-3" data-testid="dsh-core-remote-section">
      <Panel.Header
        title={t('core.title')}
        description={t('core.remote_tooltip')}
        testId="dsh-config-panel-title"
        action={(
          <Button
            size="sm"
            variant="tertiary"
            isDisabled={refreshing}
            aria-label={t('core.refresh')}
            onPress={onRefresh}
          >
            <If cond={refreshing} then={<Spinner size="sm" color="current" />} else={<ArrowRotateRight className="size-3.5" />} />
            {t('core.refresh')}
          </Button>
        )}
      />
      <RemoteCoreList machineId={machineId} />
    </div>
  )
}

function RemoteCoreRows({ rows, download, progress, downloading, canDownload, onDownload }: {
  rows: RemoteCoreRow[]
  download?: RemoteDownload
  progress?: string
  downloading: boolean
  canDownload: boolean
  onDownload: (row: RemoteCoreRow) => void
}) {
  const { t } = useTranslation()
  const [showIncompatible, toggleIncompatible] = useToggle(false)
  const currentRows = rows.filter(row => !row.orphaned)
  const orphanRows = rows.filter(row => row.orphaned)
  const orderedRows = [...currentRows, ...orphanRows]
  const incompatibleRows = orderedRows.filter(row => row.unsupported)
  const displayRows = [...orderedRows.filter(row => !row.unsupported), ...incompatibleRows]
  const firstOrphanRow = displayRows.find(row => row.orphaned)

  return (
    <>
      {displayRows.map(row => (
        <div key={row.id}>
          <If cond={row === incompatibleRows[0]}>
            <button
              type="button"
              className="flex items-center gap-1 px-1 pt-2 text-left text-xs font-medium text-muted"
              aria-expanded={showIncompatible}
              onClick={() => toggleIncompatible()}
            >
              <ChevronRight className={showIncompatible ? 'size-3.5 rotate-90' : 'size-3.5'} />
              {t('core.incompatible_title', { count: incompatibleRows.length })}
            </button>
          </If>
          <If cond={row.orphaned && row === firstOrphanRow}>
            <div className="px-1 pt-2 text-xs font-medium text-muted">
              {t('core.remote_orphaned_title')}
            </div>
          </If>
          <RemoteCoreRowView
            row={row}
            hidden={!showIncompatible && row.unsupported}
            downloading={downloading && download?.tag === row.tag}
            busy={downloading}
            progress={download?.tag === row.tag ? progress : undefined}
            canDownload={canDownload}
            onDownload={() => onDownload(row)}
          />
        </div>
      ))}
    </>
  )
}

function RemoteCoreRowView({ row, hidden, downloading, busy, progress, canDownload, onDownload }: {
  row: RemoteCoreRow
  hidden: boolean
  downloading: boolean
  busy: boolean
  progress?: string
  canDownload: boolean
  onDownload: () => void
}) {
  const { t } = useTranslation()

  return (
    <div className={hidden ? 'hidden' : undefined} data-testid={`dsh-core-remote-row-${row.id}`}>
      <Item
        left={(
          <>
            <Label className="min-w-0 truncate font-mono text-sm font-medium text-ink">{row.version}</Label>
            <Chip size="sm" variant="soft" color="accent" className="shrink-0 font-medium">{t('core.remote')}</Chip>
            <If cond={row.active}>
              <Chip size="sm" variant="soft" color="success" className="shrink-0 font-medium">{t('core.active')}</Chip>
            </If>
            <If cond={row.preview}>
              <Chip size="sm" variant="soft" color="warning" className="shrink-0 font-medium">{t('core.preview')}</Chip>
            </If>
            <If cond={row.orphaned}>
              <Chip size="sm" variant="soft" color="warning" className="shrink-0 font-medium">{t('core.orphaned')}</Chip>
            </If>
            <If cond={row.unsupported}>
              <Chip size="sm" variant="soft" color="danger" className="shrink-0 font-medium">{t('core.remote_unsupported')}</Chip>
            </If>
            <If cond={row.present && row.dir !== undefined}>
              <Button
                size="sm"
                variant="tertiary"
                className="h-6 w-6 shrink-0 p-0"
                aria-label={t('core.remote_copy_path')}
                onClick={(event) => {
                  event.stopPropagation()
                  void writeClipboardText(row.dir!)
                }}
              >
                <Copy className="size-3.5" />
              </Button>
            </If>
            <If cond={!row.present}>
              <Description className="min-w-0 text-xs text-muted">{t('core.not_downloaded')}</Description>
            </If>
          </>
        )}
        right={(
          <>
            <If cond={row.present}>
              <Checkbox
                isSelected={row.active}
                isDisabled
                aria-label={row.version}
                className="shrink-0"
              >
                <Checkbox.Content>
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                </Checkbox.Content>
              </Checkbox>
            </If>
            <If cond={!row.present && canDownload}>
              <Button
                size="sm"
                variant="tertiary"
                className="h-7 text-xs"
                isDisabled={busy}
                onClick={(event) => {
                  event.stopPropagation()
                  onDownload()
                }}
              >
                <If cond={downloading} then={<Spinner size="sm" color="current" />} else={<DownloadIcon className="size-3.5" />} />
                {t('core.download')}
              </Button>
            </If>
          </>
        )}
        footer={(
          <>
            <If cond={row.present && row.tag !== undefined}>
              <Description className="break-all font-mono text-[10px] text-muted/70">{row.tag}</Description>
            </If>
            <If cond={row.error !== undefined}>
              <Description className="break-all text-xs text-danger">{row.error}</Description>
            </If>
            <If cond={progress !== undefined}>
              <Description className="break-all text-xs text-muted">{progress}</Description>
            </If>
          </>
        )}
      />
    </div>
  )
}

function unreadableErrorOf(target: RemoteCoreTarget | undefined): string | undefined {
  if (target?.availability === 'unreadable')
    return target.error
  return undefined
}
