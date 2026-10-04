import type { DataDirEntry, DataDirProgress, DataDirStatus, MigrationBackup, MigrationOutcome, MigrationPlan } from '@/types'
import { Folder } from '@gravity-ui/icons'
import { Alert, Button, Description, Input, Label, Spinner } from '@heroui/react'
import { useOverlay } from '@overlastic/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { Info } from '@/components/info'
import { Item } from '@/components/item'
import { Modal } from '@/components/modal'
import { Panel } from '@/components/panel'
import { queryKeys } from '@/config/query-keys'
import { useInvalidateOnSettingUpdated } from '@/hooks/use-invalidate-on-setting-updated'
import { useListen } from '@/hooks/use-listen'
import { store } from '@/store'
import { silence } from '@/utils/silence'
import { toast } from '@/utils/toast'

/**
 * 目录名白名单：与 Rust 侧 join_leaf 的校验逐字对应。
 * 拒绝分隔符与绝对路径，否则用户填一个 \\?\D:\x 就能把数据目录建到没选过的地方。
 */
const LEAF_PATTERN = /^[\w .-]+$/

/** 进度面板保留的日志行数（Panel.Progress 只展示最后 5 行）。 */
const LOG_LIMIT = 8

/**
 * 预检结果的占位值：planKey 为空串，因此永远不满足「与当前输入一致」，
 * 这样预检卡片可以用 <If cond={planReady}> 渲染，不必在 JSX 里写三元或做非空断言。
 */
const EMPTY_PLAN: MigrationPlan = {
  source: '',
  target: '',
  totalFiles: 0,
  totalBytes: 0,
  links: 0,
  targetFreeBytes: 0,
  enoughSpace: false,
  parentExists: false,
  remembered: false,
}

/** 把字节转成人类可读体积（保留 1 位小数）。 */
function formatBytes(bytes: number): string {
  const kb = 1024
  if (bytes < kb)
    return `${bytes} B`
  if (bytes < kb * kb)
    return `${(bytes / kb).toFixed(1)} KB`
  if (bytes < kb * kb * kb)
    return `${(bytes / kb / kb).toFixed(1)} MB`
  return `${(bytes / kb / kb / kb).toFixed(1)} GB`
}

/** 取路径最后一段（跨盘符时 \\ 与 / 都算分隔符）。 */
function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(part => part !== '')
  return parts.length === 0 ? '' : parts[parts.length - 1]
}

/**
 * 数据目录面板（issue #871）。
 *
 * 数据目录的唯一真相是**用户级 DSH_HOME 环境变量**：这里既不改 app 配置、
 * 也不做联接/软链，只做「复制到新位置 → 校验 → 旧目录改名保底 → 改写变量」，
 * 因此面板只负责收集目标与展示预检，真正的搬家在 Rust 侧阻塞线程里跑。
 */
export function ConfigDataDir() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [dialogHolder, openDialog] = useOverlay(Modal, { type: 'holder' })

  const statusQuery = useQuery({
    queryKey: queryKeys.dataDir,
    queryFn: () => invoke<DataDirStatus>('get_data_dir_status'),
  })
  const entriesQuery = useQuery({
    queryKey: queryKeys.dataDirEntries,
    queryFn: () => invoke<DataDirEntry[]>('list_data_dir_entries'),
  })
  useInvalidateOnSettingUpdated(queryKeys.dataDir)
  useInvalidateOnSettingUpdated(queryKeys.dataDirEntries)

  const [parent, setParent] = useState('')
  const [leaf, setLeaf] = useState('')
  const [plan, setPlan] = useState<MigrationPlan>(EMPTY_PLAN)
  const [planKey, setPlanKey] = useState('')
  const [progress, setProgress] = useState<DataDirProgress | null>(null)
  const [logs, setLogs] = useState<string[]>([])

  const status = statusQuery.data ?? null
  const entries = entriesQuery.data ?? []
  const backups = status === null ? [] : status.backups
  const entriesError = entriesQuery.error ? String(entriesQuery.error) : ''

  // 目录名留空时沿用当前目录的最后一段，用户改一次即可；不需要 effect 回填。
  const suggestedLeaf = status === null ? '' : basenameOf(status.dataDir)
  const effectiveLeaf = leaf === '' ? suggestedLeaf : leaf
  const leafHint = LEAF_PATTERN.test(effectiveLeaf.trim()) ? '' : t('data_dir.leaf_invalid')
  const targetKey = `${parent}::${effectiveLeaf}`
  const planReady = planKey !== '' && planKey === targetKey

  /** 把进度载荷翻成一行日志（回滚不发 copy/verify，只有 scan/finalize/done）。 */
  function describeProgress(payload: DataDirProgress): string {
    if (payload.phase === 'scan')
      return t('data_dir.phase_scan')
    if (payload.phase === 'copy')
      return t('data_dir.phase_copy', { files: payload.copiedFiles, total: payload.totalFiles, bytes: formatBytes(payload.copiedBytes) })
    if (payload.phase === 'verify')
      return t('data_dir.phase_verify')
    if (payload.phase === 'finalize')
      return t('data_dir.phase_finalize')
    return t('data_dir.phase_done')
  }

  useListen<DataDirProgress>('data-dir://progress', (event) => {
    const payload = event.payload
    setProgress(payload)
    setLogs(prev => [...prev, describeProgress(payload)].slice(-LOG_LIMIT))
  })

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: queryKeys.dataDir })
    void queryClient.invalidateQueries({ queryKey: queryKeys.dataDirEntries })
    // 运行信息里也带 data_dir，迁移后要一起刷新
    void queryClient.invalidateQueries({ queryKey: queryKeys.info })
  }

  const preview = useMutation({
    mutationFn: (vars: { parent: string, leaf: string }) => invoke<MigrationPlan>('preview_data_dir_migration', vars),
    onSuccess: (value, vars) => {
      setPlan(value)
      setPlanKey(`${vars.parent}::${vars.leaf}`)
    },
  })

  const migrate = useMutation({
    mutationFn: (vars: { parent: string, leaf: string }) => invoke<MigrationOutcome>('migrate_data_dir', vars),
    onSuccess: invalidate,
  })

  const rollback = useMutation({
    mutationFn: (backup: string) => invoke<MigrationOutcome>('rollback_data_dir', { backup }),
    onSuccess: invalidate,
  })

  const busy = preview.isPending || migrate.isPending || rollback.isPending
  const progressPercentage = progress !== null && progress.totalBytes > 0
    ? (progress.copiedBytes / progress.totalBytes) * 100
    : undefined

  async function handleReveal(path: string) {
    try {
      await invoke('reveal_in_folder', { path })
    }
    catch (err) {
      toast(String(err), { variant: 'danger' })
    }
  }

  async function handlePick() {
    try {
      const picked = await invoke<string | null>('pick_data_dir')
      if (picked != null) {
        setParent(picked)
        setPlanKey('')
      }
    }
    catch (err) {
      toast(`${t('data_dir.pick_failed')}: ${String(err)}`, { variant: 'danger' })
    }
  }

  async function handlePreview() {
    try {
      await preview.mutateAsync({ parent, leaf: effectiveLeaf })
    }
    catch (err) {
      toast(`${t('data_dir.preview_failed')}: ${String(err)}`, { variant: 'danger' })
    }
  }

  async function handleMigrate() {
    try {
      await openDialog({
        status: 'danger',
        title: t('data_dir.migrate_confirm_title'),
        description: (
          <p>
            {t('data_dir.migrate_confirm_desc', { source: plan.source, target: plan.target })}
          </p>
        ),
      })
    }
    catch (e) {
      silence(e, 'data-dir: migrate cancelled')
      return
    }
    setProgress(null)
    setLogs([])
    try {
      // 后端命令自己会取迁移锁并停掉 Harness，前端不再重复 shutdown
      const outcome = await migrate.mutateAsync({ parent, leaf: effectiveLeaf })
      setPlanKey('')
      invoke('launch_harness').catch((e) => {
        console.warn('[ConfigDataDir] launch_harness failed:', e)
      })
      const key = toast(t('data_dir.migrate_done_toast', { target: outcome.target, movedTo: outcome.movedTo }), {
        variant: 'accent',
        timeout: 10_000,
        actionProps: {
          children: t('app.restart'),
          onPress: () => {
            store.harness.restart()
            toast.close(key)
          },
        },
      })
    }
    catch (err) {
      console.error('[ConfigDataDir] migrate failed:', err)
      toast(`${t('data_dir.migrate_failed')}: ${String(err)}`, { variant: 'danger' })
    }
  }

  async function handleRollback(backup: MigrationBackup) {
    try {
      await openDialog({
        status: 'danger',
        title: t('data_dir.rollback_confirm_title'),
        description: (
          <p>
            {t('data_dir.rollback_confirm_desc', { backup: backup.path, current: status === null ? '' : status.dataDir })}
          </p>
        ),
      })
    }
    catch (e) {
      silence(e, 'data-dir: rollback cancelled')
      return
    }
    setProgress(null)
    setLogs([])
    try {
      const outcome = await rollback.mutateAsync(backup.path)
      invoke('launch_harness').catch((e) => {
        console.warn('[ConfigDataDir] launch_harness failed:', e)
      })
      const done = outcome.movedTo === ''
        ? t('data_dir.rollback_done_clean', { target: outcome.target })
        : t('data_dir.rollback_done_toast', { target: outcome.target, movedTo: outcome.movedTo })
      const key = toast(done, {
        variant: 'accent',
        timeout: 10_000,
        actionProps: {
          children: t('app.restart'),
          onPress: () => {
            store.harness.restart()
            toast.close(key)
          },
        },
      })
    }
    catch (err) {
      console.error('[ConfigDataDir] rollback failed:', err)
      toast(`${t('data_dir.rollback_failed')}: ${String(err)}`, { variant: 'danger' })
    }
  }

  return (
    <div className="space-y-3 pl-4">
      <Panel.Header
        title={t('config.dataDir')}
        description={t('data_dir.description')}
        testId="dsh-config-panel-title"
        action={(
          <Button size="sm" variant="primary" className="h-8" onPress={() => handleReveal(status?.dataDir ?? '')}>
            <Folder className="size-3.5" />
            <span>{t('data_dir.reveal')}</span>
          </Button>
        )}
      />

      <If cond={status !== null}>
        <div className="flex flex-col gap-1">
          <Info term={t('data_dir.current')}>{status?.dataDir}</Info>
          <Info term={t('data_dir.default_dir')}>{status?.defaultDir}</Info>
          <Info term={t('data_dir.env_override')}>
            <If cond={(status?.envOverride ?? '') === ''} else={status?.envOverride}>
              {t('data_dir.env_unset')}
            </If>
          </Info>
        </div>
      </If>

      <If cond={status !== null && !status.supported}>
        <Alert status="warning" className="gap-2">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description data-testid="dsh-data-dir-unsupported">
              <If cond={status?.debugBuild === true} else={t('data_dir.unsupported')}>
                {t('data_dir.debug_hint')}
              </If>
            </Alert.Description>
          </Alert.Content>
        </Alert>
      </If>

      <If cond={status?.supported === true}>
        <Panel.Header title={t('data_dir.migrate_title')} description={t('data_dir.migrate_desc')} />
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-ink">{t('data_dir.parent_label')}</span>
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 truncate font-mono text-[11px] text-muted/80">
                <If cond={parent === ''} else={parent}>
                  {t('data_dir.parent_unset')}
                </If>
              </span>
              <Button size="sm" variant="tertiary" className="h-8" isDisabled={busy} onPress={handlePick}>
                <span>{t('data_dir.pick')}</span>
              </Button>
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-ink">{t('data_dir.leaf_label')}</span>
            <Input
              variant="secondary"
              className="h-8 w-[220px]"
              placeholder={t('data_dir.leaf_placeholder')}
              value={effectiveLeaf}
              onChange={(e) => {
                setLeaf(e.target.value)
                setPlanKey('')
              }}
              aria-label={t('data_dir.leaf_label')}
            />
          </div>
          <If cond={leafHint !== ''}>
            <Description className="text-[10px] text-danger">{leafHint}</Description>
          </If>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="tertiary"
              className="h-8"
              isDisabled={busy || parent === '' || leafHint !== ''}
              onPress={handlePreview}
            >
              <If cond={preview.isPending}>
                <Spinner size="sm" color="current" />
              </If>
              <span>{t('data_dir.preview')}</span>
            </Button>
            <Button
              size="sm"
              variant="primary"
              className="h-8"
              isDisabled={busy || !planReady || !plan.enoughSpace}
              onPress={handleMigrate}
            >
              <If cond={migrate.isPending}>
                <Spinner size="sm" color="current" />
              </If>
              <span>{t('data_dir.migrate_action')}</span>
            </Button>
          </div>
        </div>
        <If cond={planReady}>
          <div className="flex flex-col gap-1 rounded-md border border-line bg-panel2/40 p-3">
            <Info term={t('data_dir.plan_source')}>{plan.source}</Info>
            <Info term={t('data_dir.plan_target')}>{plan.target}</Info>
            <Info term={t('data_dir.plan_size')}>{formatBytes(plan.totalBytes)}</Info>
            <Info term={t('data_dir.plan_files')}>{plan.totalFiles}</Info>
            <Info term={t('data_dir.plan_free')}>{formatBytes(plan.targetFreeBytes)}</Info>
            <Info term={t('data_dir.plan_links')}>{plan.links}</Info>
            <If cond={plan.remembered}>
              <Description className="text-[10px] text-muted">{t('data_dir.plan_remembered')}</Description>
            </If>
            <If cond={!plan.parentExists}>
              <Description className="text-[10px] text-muted">{t('data_dir.plan_parent_missing')}</Description>
            </If>
            <If cond={!plan.enoughSpace}>
              <Description className="text-[10px] text-danger">{t('data_dir.plan_no_space')}</Description>
            </If>
          </div>
        </If>
      </If>

      <If cond={progress !== null}>
        <Panel.Progress percentage={progressPercentage} logs={logs} />
      </If>

      <Panel.Header title={t('data_dir.usage_title')} description={t('data_dir.usage_desc')} />
      <Panel.Loadable loading={entriesQuery.isLoading} error={entriesError}>
        <If
          cond={entries.length === 0}
          else={(
            <div className="flex flex-col gap-4">
              {entries.map(entry => (
                <Item
                  key={entry.path}
                  left={(
                    <Label className="text-xs font-mono text-muted">{entry.name}</Label>
                  )}
                  right={(
                    <Description className="text-xs font-mono text-muted">
                      {formatBytes(entry.bytes)}
                      {' · '}
                      {t('data_dir.entry_files', { count: entry.files })}
                    </Description>
                  )}
                />
              ))}
            </div>
          )}
        >
          <div className="space-y-1 rounded-md border border-line bg-panel2/40 p-3">
            <Label className="text-xs font-medium text-ink">{t('data_dir.entries_empty')}</Label>
            <Description className="text-xs text-muted">{t('data_dir.entries_empty_desc')}</Description>
          </div>
        </If>
      </Panel.Loadable>

      <If cond={status?.rollbackAvailable === true}>
        <Panel.Header title={t('data_dir.rollback_title')} description={t('data_dir.rollback_desc')} />
        <div className="flex flex-col gap-4">
          {backups.map(backup => (
            <Item
              key={backup.path}
              left={(
                <>
                  <Label className="text-xs font-mono text-muted">{backup.stamp}</Label>
                  <Description className="text-xs font-mono text-muted">
                    {t('data_dir.backup_sessions', { count: backup.sessions })}
                  </Description>
                </>
              )}
              right={(
                <Button
                  size="sm"
                  variant="tertiary"
                  className="h-7"
                  isDisabled={busy}
                  onPress={() => handleRollback(backup)}
                >
                  <If cond={rollback.isPending}>
                    <Spinner size="sm" color="current" />
                  </If>
                  <span>{t('data_dir.rollback_action')}</span>
                </Button>
              )}
              footer={(
                <div className="flex flex-col gap-1">
                  <Description className="break-all font-mono text-[10px] text-muted">{backup.path}</Description>
                  <If cond={backup.sessions === 0}>
                    <Description className="text-[10px] text-danger">{t('data_dir.backup_no_sessions')}</Description>
                  </If>
                </div>
              )}
            />
          ))}
        </div>
      </If>

      {dialogHolder}
    </div>
  )
}
