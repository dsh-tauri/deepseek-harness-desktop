import type { Dispatch, ReactNode, SetStateAction } from 'react'
import type { RemoteCoreRow, RemoteCoreTarget } from './remote-core.rows'
import type { GetApiTauriRemoteCoreProfilesResponse, GetApiTauriRemoteCoreTasksEventsResponse } from '@/apis/remote.types'
import { ChevronRight, Copy, CircleArrowDown as DownloadIcon } from '@gravity-ui/icons'
import { Button, Checkbox, Chip, Description, Label, Spinner } from '@heroui/react'
import { useOverlay } from '@overlastic/react'
import { useToggle } from '@reause/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, use, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { getCoreCurrent, getCoreProfiles, getCoreTasksEvents, getCoreVersions, postCoreInstall, postCoreSwitch } from '@/apis/remote'
import { Empty } from '@/components/empty'
import { Item } from '@/components/item'
import { Modal } from '@/components/modal'
import { Panel } from '@/components/panel'
import { queryKeys } from '@/config/query-keys'
import { loadRemoteMachines } from '@/hooks/use-remote'
import { writeClipboardText } from '@/utils/clipboard'
import { silence } from '@/utils/silence'
import { toast } from '@/utils/toast'
import { buildRemoteCoreRows } from './remote-core.rows'

type CoreProfile = NonNullable<GetApiTauriRemoteCoreProfilesResponse['items']>[number]

const DOWNLOAD_POLL_INTERVAL_MS = 1500
const DOWNLOAD_POLL_LIMIT = 1200
/** 连续读不到任务事件时的重试次数：读事件失败不等于任务失败，不能就此判定切换失败。 */
const EVENT_READ_RETRY_LIMIT = 5

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 任务结果读不出来：服务端可能仍在执行，只能重新查询，不能当成失败。 */
class UnknownTaskResultError extends Error {
  readonly taskId: string

  constructor(taskId: string, message: string) {
    super(`REMOTE_CORE_TASK_UNKNOWN: ${message}`)
    this.name = 'UnknownTaskResultError'
    this.taskId = taskId
  }
}

async function waitForCoreTask(taskId: string, onProgress: (line: string | undefined) => void, failure: string): Promise<void> {
  let readFailures = 0
  for (let attempt = 0; attempt < DOWNLOAD_POLL_LIMIT; attempt++) {
    let events: GetApiTauriRemoteCoreTasksEventsResponse
    try {
      events = await getCoreTasksEvents({ taskId })
    }
    catch (error) {
      // 读取调用本身失败（超时、连接断了）也不等于任务失败：
      // 服务端的任务可能还在跑，用同一个 taskId 接着看就行。
      events = { error: error instanceof Error ? error.message : String(error) }
    }
    if (events.error !== undefined) {
      // 读不到事件只说明这一次没读到：服务端的任务可能还在跑，用同一个 taskId
      // 接着看就行，重发请求会把操作做两遍。
      readFailures += 1
      if (readFailures >= EVENT_READ_RETRY_LIMIT)
        throw new UnknownTaskResultError(taskId, events.error)
      await sleep(DOWNLOAD_POLL_INTERVAL_MS)
      continue
    }
    readFailures = 0
    const items = events.items ?? []
    onProgress(items.at(-1)?.line)
    const finished = items.find(item => item.terminal !== undefined)
    if (finished !== undefined) {
      if (finished.terminal === 'failed')
        throw new Error(finished.reason ?? finished.line)
      return
    }
    await sleep(DOWNLOAD_POLL_INTERVAL_MS)
  }
  throw new UnknownTaskResultError(taskId, failure)
}

interface RemoteTask {
  tag: string
  version: string
  /** 服务端任务号：结果未知时用它重新查询，不重发操作。 */
  taskId?: string
  /** 结果未知：任务可能还在远端执行。 */
  unknown?: boolean
  /** 这个任务正在跑：按机器分别记，重查一台机器不会解除另一台的保护。 */
  pending?: boolean
}

type RemoteTaskMap = Record<string, RemoteTask>

interface RemoteCoreTasks {
  downloads: RemoteTaskMap
  switchings: RemoteTaskMap
  /** 每台机器的进度行：两台机器同时在跑时不会串。 */
  progress: Record<string, string>
  setDownloads: Dispatch<SetStateAction<RemoteTaskMap>>
  setSwitchings: Dispatch<SetStateAction<RemoteTaskMap>>
  setProgress: Dispatch<SetStateAction<Record<string, string>>>
}

const RemoteCoreTasksContext = createContext<RemoteCoreTasks | undefined>(undefined)

/**
 * 任务记录放在列表组件外面：切到本机再切回这台机器时，
 * 未决任务与「结果未知」的记录都还在，用户还能重新查询它的结果。
 */
export function RemoteCoreTasksProvider({ children }: { children: ReactNode }) {
  const [downloads, setDownloads] = useState<RemoteTaskMap>({})
  const [switchings, setSwitchings] = useState<RemoteTaskMap>({})
  const [progress, setProgress] = useState<Record<string, string>>({})
  const value = useMemo<RemoteCoreTasks>(() => ({ downloads, switchings, progress, setDownloads, setSwitchings, setProgress }), [downloads, switchings, progress])
  return <RemoteCoreTasksContext value={value}>{children}</RemoteCoreTasksContext>
}

function patchTask(tasks: RemoteTaskMap, machineId: string, patch: Partial<RemoteTask>): RemoteTaskMap {
  const existing = tasks[machineId]
  return existing === undefined ? tasks : { ...tasks, [machineId]: { ...existing, ...patch } }
}

function dropTask(tasks: RemoteTaskMap, machineId: string): RemoteTaskMap {
  if (tasks[machineId] === undefined)
    return tasks
  const next = { ...tasks }
  delete next[machineId]
  return next
}

export function RemoteCoreList({ machineId }: { machineId: string }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const openDialog = useOverlay(Modal)

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
  const machinesQuery = useQuery({ queryKey: queryKeys.remoteMachines, queryFn: loadRemoteMachines, refetchInterval: 2000 })
  const machine = machinesQuery.data?.machines.find(item => item.id === machineId)

  // 任务按机器分别记着：换到另一台机器上操作，不会把这边未决任务的记录盖掉。
  const tasks = use(RemoteCoreTasksContext)
  if (tasks === undefined)
    throw new Error('RemoteCoreList 需要放在 RemoteCoreTasksProvider 里')
  const { downloads, switchings, progress, setDownloads, setSwitchings, setProgress } = tasks

  /** 进度也按机器记：两台机器同时在跑时，进度行不会串到另一台去。 */
  function reportProgress(machineId: string, line: string | undefined): void {
    setProgress((current) => {
      const next = { ...current }
      if (line === undefined)
        delete next[machineId]
      else
        next[machineId] = line
      return next
    })
  }

  async function startInstallTask(machineId: string, tag: string): Promise<string> {
    const response = await postCoreInstall({ machineId, tag })
    if (response.taskId === undefined)
      throw new Error(response.error ?? t('core.download_failed'))
    setDownloads(current => patchTask(current, machineId, { taskId: response.taskId }))
    return response.taskId
  }

  async function startSwitchTask(machineId: string, slotKey: string): Promise<string> {
    const response = await postCoreSwitch({ machineId, slotKey })
    if (response.taskId === undefined)
      throw new Error(response.error ?? t('core.switch_failed'))
    setSwitchings(current => patchTask(current, machineId, { taskId: response.taskId }))
    return response.taskId
  }

  const installMutation = useMutation({
    mutationFn: async (input: { machineId: string, tag: string, version: string, taskId?: string }) => {
      const taskId = input.taskId ?? await startInstallTask(input.machineId, input.tag)
      await waitForCoreTask(taskId, line => reportProgress(input.machineId, line), t('core.download_failed'))
      return input.version
    },
    onSuccess: (version, input) => {
      toast(t('core.downloaded_toast', { version }))
      setDownloads(current => dropTask(current, input.machineId))
      reportProgress(input.machineId, undefined)
      void queryClient.invalidateQueries({ queryKey: queryKeys.remoteCoreTarget(input.machineId) })
    },
    onError: (error, input) => {
      const message = error instanceof Error ? error.message : String(error)
      reportProgress(input.machineId, undefined)
      if (error instanceof UnknownTaskResultError) {
        // 结果未知：任务可能还在远端跑，记住任务号让用户能重新查询。
        setDownloads(current => patchTask(current, input.machineId, { taskId: error.taskId, unknown: true, pending: false }))
        toast(t('core.download_unknown'), { variant: 'warning', description: message })
        return
      }
      toast(t('core.download_failed'), { variant: 'danger', description: message })
      setDownloads(current => dropTask(current, input.machineId))
    },
  })

  const switchMutation = useMutation({
    mutationFn: async (input: { machineId: string, slotKey: string, version: string, taskId?: string }) => {
      const taskId = input.taskId ?? await startSwitchTask(input.machineId, input.slotKey)
      await waitForCoreTask(taskId, line => reportProgress(input.machineId, line), t('core.switch_failed'))
      return input.version
    },
    onSuccess: (version, input) => {
      toast(t('core.activate_toast', { version }), {
        variant: 'accent',
        description: t('core.switch_restart_hint'),
        timeout: 10_000,
      })
      setSwitchings(current => dropTask(current, input.machineId))
      reportProgress(input.machineId, undefined)
      void queryClient.invalidateQueries({ queryKey: queryKeys.remoteCoreTarget(input.machineId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.remoteMachines })
    },
    onError: (error, input) => {
      const message = error instanceof Error ? error.message : String(error)
      reportProgress(input.machineId, undefined)
      void queryClient.invalidateQueries({ queryKey: queryKeys.remoteCoreTarget(input.machineId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.remoteMachines })
      if (error instanceof UnknownTaskResultError) {
        // 结果未知：切换可能已经在服务端完成或仍在进行，别让用户以为切换失败了。
        setSwitchings(current => patchTask(current, input.machineId, { taskId: error.taskId, unknown: true, pending: false }))
        toast(t('core.switch_unknown'), { variant: 'warning', description: message })
        return
      }
      toast(t('core.switch_failed'), { variant: 'danger', description: message })
      setSwitchings(current => dropTask(current, input.machineId))
    },
  })

  /** 结果未知时按同一个任务号重新查询，不重发操作。 */
  function recheckDownload() {
    const current = downloads[machineId]
    if (current?.taskId === undefined)
      return
    setDownloads(state => patchTask(state, machineId, { unknown: false, pending: true }))
    reportProgress(machineId, undefined)
    installMutation.mutate({ machineId, tag: current.tag, version: current.version, taskId: current.taskId })
  }

  /** 结果未知时按同一个任务号重新查询，不重发操作。 */
  function recheckSwitch() {
    const current = switchings[machineId]
    if (current?.taskId === undefined)
      return
    setSwitchings(state => patchTask(state, machineId, { unknown: false, pending: true }))
    reportProgress(machineId, undefined)
    switchMutation.mutate({ machineId, slotKey: current.tag, version: current.version, taskId: current.taskId })
  }

  async function onActivate(row: RemoteCoreRow) {
    const slotKey = row.tag
    const current = switchings[machineId]
    // 这台机器还有切换任务没结束：不能再发起新的切换。
    // 新任务会覆盖原记录，用户就再也查不到第一次切换的结果了。
    if (current?.pending === true || current?.unknown === true) {
      toast(t('core.switch_blocked'), { variant: 'warning' })
      return
    }
    if (slotKey === undefined || row.active || !row.present || row.unsupported)
      return
    try {
      await openDialog({
        status: 'warning',
        title: t('core.switch_confirm_title'),
        description: <p>{t('core.switch_confirm_desc', { version: row.version })}</p>,
      })
    }
    catch (error) {
      silence(error, 'remote core switch: dialog cancelled')
      return
    }
    setSwitchings(current => ({ ...current, [machineId]: { tag: slotKey, version: row.version, pending: true } }))
    switchMutation.mutate({ machineId, slotKey, version: row.version })
  }

  const targetError = targetQuery.error === null ? '' : String(targetQuery.error)
  const profilesError = profilesQuery.error === null ? '' : String(profilesQuery.error)
  const versionsError = versionsQuery.error === null ? '' : String(versionsQuery.error)
  const target = targetQuery.data
  const targetSlots = target?.availability === 'present' ? target.slots : []
  const capabilities = target?.capabilities ?? []
  const versions = versionsQuery.data ?? []
  const rows = buildRemoteCoreRows(targetSlots, versions)
  const activeDownload = downloads[machineId]
  const activeSwitching = switchings[machineId]
  // 未决任务：结果未知时任务可能还在远端跑，重查入口要放在版本清单之外，
  // 清单读不出来时用户也得能查到这次任务的结果。
  const pendingTasks: { kind: 'download' | 'switch', task: RemoteTask }[] = [
    ...(activeDownload?.unknown === true ? [{ kind: 'download' as const, task: activeDownload }] : []),
    ...(activeSwitching?.unknown === true ? [{ kind: 'switch' as const, task: activeSwitching }] : []),
  ]

  return (
    <div className="space-y-2" data-testid="dsh-core-remote-list">
      <If cond={pendingTasks.length > 0}>
        <div className="space-y-2">
          {pendingTasks.map(item => (
            <Item
              key={item.kind}
              left={(
                <>
                  <Label className="text-sm font-medium text-warning">{t('core.task_unknown')}</Label>
                  <Description className="text-xs text-muted">{item.task.version}</Description>
                </>
              )}
              right={(
                <Button
                  size="sm"
                  variant="tertiary"
                  className="h-7 text-xs"
                  onClick={() => item.kind === 'download' ? recheckDownload() : recheckSwitch()}
                >
                  {t('core.task_recheck')}
                </Button>
              )}
              footer={<Description className="text-xs text-warning">{t('core.task_unknown_hint')}</Description>}
            />
          ))}
        </div>
      </If>
      <Panel.Loadable loading={targetQuery.isPending || profilesQuery.isPending} error={targetError || profilesError}>
        <If cond={machine !== undefined}>
          <div className="flex items-center gap-1.5 px-1">
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
              switching={activeSwitching}
              progress={progress[machineId]}
              downloading={activeDownload?.pending === true}
              activating={activeSwitching?.pending === true}
              canDownload={capabilities.includes('installVersion')}
              canActivate={capabilities.includes('activate')}
              onDownload={(row) => {
                const tag = row.tag
                if (tag === undefined || activeDownload?.pending === true)
                  return
                setDownloads(current => ({ ...current, [machineId]: { tag, version: row.version, pending: true } }))
                installMutation.mutate({ machineId, tag, version: row.version })
              }}
              onActivate={row => void onActivate(row)}
            />
          </If>
        </Panel.Loadable>
      </Panel.Loadable>
    </div>
  )
}

function RemoteCoreRows({ rows, download, switching, progress, downloading, activating, canDownload, canActivate, onDownload, onActivate }: {
  rows: RemoteCoreRow[]
  download?: RemoteTask
  switching?: RemoteTask
  progress?: string
  downloading: boolean
  activating: boolean
  canDownload: boolean
  canActivate: boolean
  onDownload: (row: RemoteCoreRow) => void
  onActivate: (row: RemoteCoreRow) => void
}) {
  const { t } = useTranslation()
  const [showIncompatible, toggleIncompatible] = useToggle(false)
  const currentRows = rows.filter(row => !row.orphaned)
  const orphanRows = rows.filter(row => row.orphaned)
  const orderedRows = [...currentRows, ...orphanRows]
  const incompatibleRows = orderedRows.filter(row => row.unsupported)
  const displayRows = [...orderedRows.filter(row => !row.unsupported), ...incompatibleRows]
  const firstOrphanRow = displayRows.find(row => row.orphaned)
  // 这台机器还有切换任务没结束时，不能再发起新的切换：
  // 新任务会覆盖原记录，用户就再也查不到第一次切换的结果了。
  const switchBlocked = switching !== undefined && (switching.unknown === true || switching.pending === true)

  return (
    <>
      {displayRows.map((row) => {
        // 结果未知的行由哪条任务带出来的，就用哪条任务重新查询。
        const unknownByDownload = download !== undefined && download.tag === row.tag && download.unknown === true
        const unknownBySwitch = switching !== undefined && switching.tag === row.tag && switching.unknown === true
        const rowUnknown = unknownByDownload || unknownBySwitch
        return (
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
              switching={activating && switching?.tag === row.tag}
              unknown={rowUnknown}
              busy={downloading || activating || rowUnknown}
              switchBlocked={switchBlocked}
              progress={download?.tag === row.tag || switching?.tag === row.tag ? progress : undefined}
              canDownload={canDownload}
              canActivate={canActivate}
              onDownload={() => onDownload(row)}
              onActivate={() => onActivate(row)}
            />
          </div>
        )
      })}
    </>
  )
}

function RemoteCoreRowView({ row, hidden, downloading, switching, unknown, busy, switchBlocked, progress, canDownload, canActivate, onDownload, onActivate }: {
  row: RemoteCoreRow
  hidden: boolean
  downloading: boolean
  switching: boolean
  unknown: boolean
  busy: boolean
  /** 还有结果未知的切换任务：不能再发起新的切换。 */
  switchBlocked: boolean
  progress?: string
  canDownload: boolean
  canActivate: boolean
  onDownload: () => void
  onActivate: () => void
}) {
  const { t } = useTranslation()

  return (
    <div className={hidden ? 'hidden' : undefined} data-testid={`dsh-core-remote-row-${row.id}`}>
      <Item
        onClick={!busy && !switchBlocked && canActivate && row.present && !row.active && !row.unsupported && row.tag !== undefined
          ? onActivate
          : undefined}
        left={(
          <>
            <Label className="min-w-0 truncate font-mono text-sm font-medium text-ink">{row.version}</Label>
            <Chip size="sm" variant="soft" color="accent" className="shrink-0 font-medium">{t('core.remote')}</Chip>
            <If cond={row.active}>
              <Chip size="sm" variant="soft" color="success" className="shrink-0 font-medium">{t('core.active')}</Chip>
            </If>
            <If cond={switching}>
              <Chip size="sm" variant="soft" color="warning" className="shrink-0 font-medium">{t('core.switching')}</Chip>
            </If>
            <If cond={unknown}>
              <Chip size="sm" variant="soft" color="warning" className="shrink-0 font-medium">{t('core.task_unknown')}</Chip>
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
                isDisabled={busy || switchBlocked || !canActivate || row.active || row.unsupported || row.tag === undefined}
                onChange={onActivate}
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
