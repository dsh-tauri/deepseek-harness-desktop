import type { PropsWithOverlays } from '@overlastic/react'
import { ArrowRotateRight } from '@gravity-ui/icons'
import { AlertDialog, Button, Input, Modal, Spinner } from '@heroui/react'
import { useDisclosure } from '@overlastic/react'
import { useToggle } from '@reause/core'
import { useMutation, useQuery } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { Logs } from '@/components/logs'
import { queryKeys } from '@/config/query-keys'
import { store } from '@/store'
import { toast } from '@/utils/toast'

interface TaskProcess {
  pid: number
  parent_pid: number | null
  name: string
  kind: 'desktop' | 'harness' | 'child'
  cpu_percent: number | null
  memory_bytes: number
  run_time: number
  start_time: number
  can_end: boolean
}

type SortKey = 'name' | 'pid' | 'cpu_percent' | 'memory_bytes' | 'run_time'

const columns: { key: SortKey, label: string }[] = [
  { key: 'name', label: 'task_manager.process' },
  { key: 'pid', label: 'task_manager.pid' },
  { key: 'cpu_percent', label: 'task_manager.cpu' },
  { key: 'memory_bytes', label: 'task_manager.memory' },
  { key: 'run_time', label: 'task_manager.uptime' },
]

function duration(seconds: number) {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds % 3600 / 60).toString().padStart(2, '0')
  return `${hours}:${minutes}:${(seconds % 60).toString().padStart(2, '0')}`
}

export function TaskManagerDialog(props: PropsWithOverlays) {
  const disclosure = useDisclosure({ props })
  const { t, i18n } = useTranslation()
  const { busyAction } = useStore(store.harness)
  const [action, setAction] = useState<{ type: 'end', process: TaskProcess } | { type: 'restart' } | null>(null)
  const [autoRefresh, toggleAutoRefresh] = useToggle<boolean>(true)
  const [showLogs, toggleLogs] = useToggle()
  const [search, setSearch] = useState('')
  const [selection, setSelection] = useState<{ pid: number, start_time: number } | null>(null)
  const [sort, setSort] = useState<{ key: SortKey, ascending: boolean }>({ key: 'memory_bytes', ascending: false })
  const processes = useQuery({
    queryKey: queryKeys.taskManager,
    queryFn: () => invoke<TaskProcess[]>('get_task_manager_processes'),
    enabled: disclosure.visible,
    refetchInterval: disclosure.visible && autoRefresh ? 2000 : false,
    retry: false,
  })
  const logs = useQuery({
    queryKey: queryKeys.taskManagerLogs,
    queryFn: () => invoke<string>('read_run_logs'),
    enabled: disclosure.visible && showLogs,
    staleTime: 0,
    retry: false,
  })
  const all = processes.data ?? []
  const number = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 })
  const rows = all.filter((process) => {
    const label = t(`task_manager.kind.${process.kind}`)
    return `${process.name} ${process.pid} ${label}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
  }).sort((a, b) => {
    const left = a[sort.key]
    const right = b[sort.key]
    const order = typeof left === 'string' && typeof right === 'string'
      ? left.localeCompare(right, i18n.language)
      : Number(left ?? -1) - Number(right ?? -1)
    return (sort.ascending ? order : -order) || a.pid - b.pid
  })
  const selected = rows.find(process => process.pid === selection?.pid && process.start_time === selection.start_time)
  const totalMemory = all.reduce((sum, process) => sum + process.memory_bytes, 0)
  const totalCpu = all.reduce((sum, process) => sum + (process.cpu_percent ?? 0), 0)
  const cpuReady = all.length > 0 && all.every(process => process.cpu_percent !== null)
  const endProcess = useMutation({
    mutationFn: (process: TaskProcess) => invoke('end_task_manager_process', { pid: process.pid, startTime: process.start_time }),
    onSuccess: async () => {
      setSelection(null)
      toast(t('task_manager.ended'), { variant: 'success' })
      await processes.refetch()
    },
    onError: (error) => {
      toast(t('task_manager.end_failed'), { variant: 'danger', description: String(error) })
      void processes.refetch()
    },
  })
  const restart = useMutation({
    mutationFn: async () => {
      await store.harness.restart()
      await processes.refetch()
    },
  })
  const busy = busyAction != null || endProcess.isPending || restart.isPending

  function sortBy(key: SortKey) {
    setSort(previous => ({ key, ascending: previous.key === key ? !previous.ascending : key === 'name' || key === 'pid' }))
  }

  return (
    <>
      <Modal.Backdrop isOpen={disclosure.visible} onOpenChange={disclosure.cancel}>
        <Modal.Container size="lg">
          <Modal.Dialog className="sm:max-w-[920px]" data-testid="dsh-task-manager">
            <Modal.CloseTrigger data-testid="dsh-task-manager-close" />
            <Modal.Header>
              <Modal.Heading>{t('menu.task_manager')}</Modal.Heading>
              <p className="text-sm text-muted">{t('task_manager.description')}</p>
            </Modal.Header>
            <Modal.Body className="space-y-4">
              <div className="grid grid-cols-3 gap-3 rounded-xl border border-line bg-panel2/50 p-4 text-sm">
                <div>
                  <p className="text-muted">{t('task_manager.count')}</p>
                  <p className="mt-1 text-xl tabular-nums">{all.length}</p>
                </div>
                <div>
                  <p className="text-muted">{t('task_manager.cpu')}</p>
                  <p className="mt-1 text-xl tabular-nums"><If cond={cpuReady} else={t('task_manager.sampling')}>{`${number.format(totalCpu)}%`}</If></p>
                </div>
                <div>
                  <p className="text-muted">{t('task_manager.memory')}</p>
                  <p className="mt-1 text-xl tabular-nums">{`${number.format(totalMemory / 1024 / 1024)} MB`}</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Input data-testid="dsh-task-manager-search" className="min-w-40 flex-1" aria-label={t('task_manager.search')} placeholder={t('task_manager.search')} value={search} onChange={event => setSearch(event.target.value)} />
                <Button data-testid="dsh-task-manager-auto-refresh" size="sm" variant="secondary" aria-label={t('task_manager.auto_refresh')} aria-pressed={autoRefresh} onPress={() => toggleAutoRefresh()}>
                  <If cond={autoRefresh} else={t('task_manager.paused')}>{t('task_manager.auto_refresh')}</If>
                </Button>
                <Button data-testid="dsh-task-manager-refresh" size="sm" variant="secondary" isDisabled={processes.isFetching} onPress={() => { void processes.refetch() }} aria-label={t('task_manager.refresh')}>
                  <ArrowRotateRight />
                </Button>
              </div>
              <If cond={processes.isError}>
                <p role="alert" className="text-sm text-danger">{t('task_manager.load_failed', { error: String(processes.error) })}</p>
              </If>
              <div className="max-h-80 overflow-auto rounded-lg border border-line" aria-busy={processes.isFetching}>
                <table data-testid="dsh-task-manager-processes" className="w-full min-w-[620px] text-sm" aria-label={t('menu.task_manager')}>
                  <thead className="sticky top-0 z-10 bg-panel2">
                    <tr>
                      {columns.map(column => (
                        <th key={column.key} scope="col" className="px-3 py-2 text-left font-medium text-muted" aria-sort={sort.key === column.key ? sort.ascending ? 'ascending' : 'descending' : 'none'}>
                          <Button variant="ghost" size="sm" onPress={() => sortBy(column.key)}>
                            {t(column.label)}
                            <If cond={sort.key === column.key}><span aria-hidden="true"><If cond={sort.ascending} else="↓">↑</If></span></If>
                          </Button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(process => (
                      <tr key={`${process.pid}-${process.start_time}`} className="border-t border-line data-[selected=true]:bg-accent/10" data-selected={selected === process}>
                        <td className="px-3 py-2">
                          <Button variant="ghost" className="h-auto w-full justify-start px-2 py-1 text-left" aria-pressed={selected === process} onPress={() => setSelection({ pid: process.pid, start_time: process.start_time })}>
                            <span className="max-w-56 truncate">
                              <span className="block truncate">{process.name}</span>
                              <span className="block text-xs text-muted">{t(`task_manager.kind.${process.kind}`)}</span>
                            </span>
                          </Button>
                        </td>
                        <td className="px-5 py-2 tabular-nums">{process.pid}</td>
                        <td className="px-5 py-2 tabular-nums"><If cond={process.cpu_percent !== null} else="—">{`${number.format(process.cpu_percent ?? 0)}%`}</If></td>
                        <td className="px-5 py-2 whitespace-nowrap tabular-nums">{`${number.format(process.memory_bytes / 1024 / 1024)} MB`}</td>
                        <td className="px-5 py-2 tabular-nums">{duration(process.run_time)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <If cond={processes.isPending} else={<If cond={rows.length === 0}><p className="p-8 text-center text-sm text-muted">{t('task_manager.empty')}</p></If>}>
                  <div className="flex justify-center p-8"><Spinner aria-label={t('task_manager.loading')} /></div>
                </If>
              </div>
              <p className="text-xs text-muted">{t('task_manager.metrics_hint')}</p>
              <If cond={showLogs}>
                <If cond={logs.isError} else={<Logs logs={(logs.data ?? '').split('\n').filter(Boolean)} bodyClassName="max-h-44" />}>
                  <p role="alert" className="text-sm text-danger">{t('task_manager.logs_failed')}</p>
                </If>
              </If>
            </Modal.Body>
            <Modal.Footer className="flex-wrap justify-between gap-3">
              <Button variant="ghost" size="sm" onPress={() => toggleLogs()} aria-expanded={showLogs}>{t('menu.run_logs')}</Button>
              <div className="flex flex-wrap gap-2">
                <Button data-testid="dsh-task-manager-restart" variant="secondary" size="sm" isDisabled={busy || !all.some(process => process.kind === 'harness')} onPress={() => setAction({ type: 'restart' })}>{t('task_manager.restart')}</Button>
                <Button
                  data-testid="dsh-task-manager-end"
                  variant="danger"
                  size="sm"
                  isDisabled={busy || processes.isError || !selected?.can_end}
                  onPress={() => {
                    if (selected)
                      setAction({ type: 'end', process: selected })
                  }}
                >
                  {t('task_manager.end')}
                </Button>
              </div>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
      <AlertDialog.Backdrop
        isOpen={action !== null}
        onOpenChange={(open) => {
          if (!open)
            setAction(null)
        }}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Heading>
                <If cond={action?.type === 'end'} else={t('task_manager.restart')}>{t('task_manager.end_title')}</If>
              </AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <If cond={action?.type === 'end'} else={t('task_manager.restart_description')}>
                {t('task_manager.end_description', { name: action?.type === 'end' ? action.process.name : '', pid: action?.type === 'end' ? action.process.pid : '' })}
              </If>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button variant="tertiary" onPress={() => setAction(null)}>{t('buttons.cancel')}</Button>
              <Button
                variant="danger"
                isDisabled={busy}
                onPress={() => {
                  if (action?.type === 'end')
                    endProcess.mutate(action.process)
                  else if (action?.type === 'restart')
                    restart.mutate()
                  setAction(null)
                }}
              >
                <If cond={action?.type === 'end'} else={t('app.restart')}>{t('task_manager.end')}</If>
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </>
  )
}
