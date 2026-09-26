'use no memo'

/**
 * The sync-to-remote page: pick a connected target, tick the local plugins and
 * user-level skills to move (all syncable items start ticked — the entry point
 * is called "sync to remote", so the default answer is "everything"), then
 * watch each item settle. Live progress comes from the target's machine status
 * (`phase: 'syncing'`), which the host publishes item by item; outcomes merge
 * across runs so a retry keeps the earlier batch visible. All domain state
 * lives in the injected {@link MachinesStore}; only the selection and the
 * target are local.
 * @module dsh-tauri-ssh-ui/client/components/sync-panel
 */

import type { ReactNode } from 'react'
import type { SshKey } from '../locales/index'
import type { MachineRow, MachinesStore } from '../store/index'
import type { SyncItemResult, SyncPluginItem, SyncSkillItem } from '../types/index'
import { Button, Pill, StateDot } from 'dsh-tauri-ui/client'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { pluginKeyOf, skillKeyOf, syncKeyOf, toggleSelection } from '../store/index'
import { cls } from '../styles'
import { errorTextOf } from '../utils/error'

/** The panel props: the framework `t` seat plus the injected store. */
export interface SyncPanelProps {
  store: MachinesStore
  t: (key: SshKey) => string
}

/** One selectable row of either group (plugins and skills share the layout). */
interface SelectableRow {
  key: string
  name: string
  /** The muted right-hand metadata: the dependency spec, or the skill root. */
  meta: string
  syncable: boolean
  reason?: string
}

/** Render the sync page over the store snapshot. */
export function SyncPanel({ store, t }: SyncPanelProps): ReactNode {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  // 选择态：null = 还没动过手，按「全选可同步项」派生（入口叫「同步到远端」，
  // 默认答案就是「都同步」）；一旦勾选/清空/重试就以显式集合为准。
  const [touched, setTouched] = useState<ReadonlySet<string> | null>(null)
  const [targetId, setTargetId] = useState<string | null>(null)

  useEffect(() => {
    if (state.sync.status === 'idle')
      void store.loadSyncPreview()
  }, [state.sync.status, store])

  // 目标候选来自 machine.list：本分区可以不经机器页直达，必须自己拉一次，
  // 否则已连接的机器在这里看不见（两页共用同一个 store 实例，各拉各的）。
  useEffect(() => {
    if (state.status === 'idle')
      void store.load()
  }, [state.status, store])

  const preview = state.sync.preview

  // 同步期间轮询机器状态：逐项进度就长在这条通道上（phase: 'syncing'）。
  const applying = state.sync.applying
  useEffect(() => {
    if (!applying)
      return
    const timer = setInterval(() => void store.poll(), 1000)
    return () => clearInterval(timer)
  }, [applying, store])

  const connected = connectedMachinesOf(state.machines, state.discovered, state.statuses)
  const target = connected.find(machine => machine.id === (targetId ?? connected[0]?.id))
  const pluginRows: SelectableRow[] = (preview?.plugins ?? []).map(plugin => ({
    key: pluginKeyOf(plugin),
    name: plugin.name,
    meta: plugin.spec,
    syncable: plugin.syncable,
    ...plugin.reason === undefined ? {} : { reason: plugin.reason },
  }))
  const skillRows: SelectableRow[] = (preview?.skills ?? []).map(skill => ({
    key: skillKeyOf(skill),
    name: skill.name,
    meta: skill.root,
    syncable: true,
  }))
  const selectableKeys = [...pluginRows, ...skillRows].filter(row => row.syncable).map(row => row.key)
  const selected = touched ?? new Set(selectableKeys)
  const plugins = (preview?.plugins ?? []).filter(plugin => selected.has(pluginKeyOf(plugin)))
  const skills = (preview?.skills ?? []).filter(skill => selected.has(skillKeyOf(skill)))
  const canApply = target !== undefined && !applying && (plugins.length > 0 || skills.length > 0)
  const progress = target === undefined ? undefined : state.statuses[target.id]?.progress
  const syncing = progress?.phase === 'syncing' ? progress : undefined

  const apply = (): void => {
    if (target === undefined)
      return
    void store.applySync(target.id, plugins, skills)
  }

  const retryFailed = (): void => {
    if (target === undefined || preview === null)
      return
    const failed = failedRefsOf(state.sync.results ?? [], preview)
    setTouched(new Set(failed.keys))
    void store.applySync(target.id, failed.plugins, failed.skills)
  }

  return (
    <section className={cls.section} data-testid="sync-panel">
      <div className={cls.sectionHead}>
        <div>
          <h2 className={cls.title}>{t('sync.title')}</h2>
          <p className={cls.intro}>{t('sync.desc')}</p>
        </div>
        <div className={cls.chrome}>
          <Button
            variant="outline"
            size="sm"
            disabled={state.sync.status === 'loading' || applying}
            onClick={() => {
              // 刷新回到派生默认（新出现的可同步项自动纳入），再看一遍计数。
              setTouched(null)
              void store.loadSyncPreview()
            }}
          >
            {t('sync.refresh')}
          </Button>
        </div>
      </div>
      {state.role?.remote === true
        ? <p className={cls.empty} data-testid="sync-remote-note">{t('sync.remoteSessionHint')}</p>
        : connected.length === 0
          ? <p className={cls.empty} data-testid="sync-empty">{t('sync.notConnectedHint')}</p>
          : (
              <>
                <div className={cls.syncTargets}>
                  <span className={cls.fieldLabel}>{t('sync.target')}</span>
                  {connected.map(machine => (
                    <Pill
                      key={machine.id}
                      active={machine.id === target?.id}
                      disabled={applying}
                      aria-pressed={machine.id === target?.id}
                      data-testid={`sync-target-${machine.id}`}
                      onClick={() => setTargetId(machine.id)}
                    >
                      <span className={cls.syncChip}>
                        <StateDot state="done" size={6} />
                        {machine.name}
                      </span>
                    </Pill>
                  ))}
                </div>
                {preview === null || state.sync.status === 'loading'
                  ? <p className={cls.hint}>{t('loading')}</p>
                  : (state.sync.status === 'ready'
                      ? (
                          <>
                            <div className={cls.syncToolbar}>
                              <span className={cls.syncCount} data-testid="sync-selected">
                                {t('sync.selected')
                                  .replace('{plugins}', String(plugins.length))
                                  .replace('{skills}', String(skills.length))}
                              </span>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={applying || selected.size === selectableKeys.length}
                                onClick={() => setTouched(new Set(selectableKeys))}
                              >
                                {t('sync.selectAll')}
                              </Button>
                              <Button variant="ghost" size="sm" disabled={applying || selected.size === 0} onClick={() => setTouched(new Set())}>
                                {t('sync.clear')}
                              </Button>
                            </div>
                            <SyncGroup
                              empty={t('sync.noPlugins')}
                              label={t('sync.plugins')}
                              rows={pluginRows}
                              selected={selected}
                              t={t}
                              onToggle={key => setTouched(toggleSelection(selected, key))}
                            />
                            <SyncGroup
                              empty={t('sync.noSkills')}
                              label={t('sync.skills')}
                              rows={skillRows}
                              selected={selected}
                              t={t}
                              onToggle={key => setTouched(toggleSelection(selected, key))}
                            />
                          </>
                        )
                      : null)}
                <div className={cls.syncActions}>
                  <Button variant="primary" size="sm" disabled={!canApply} data-testid="sync-apply" onClick={apply}>
                    {applying
                      ? t('sync.applying')
                      : target === undefined
                        ? t('sync.apply')
                        : t('sync.applyTo').replace('{name}', target.name)}
                  </Button>
                  {syncing !== undefined
                    ? (
                        <div className={cls.syncProgress} data-testid="sync-progress">
                          <span className={cls.syncBar} aria-hidden="true">
                            <span
                              className={cls.syncBarFill}
                              style={{ width: `${barPercentOf(syncing.attempt, syncing.total)}%` }}
                            />
                          </span>
                          <span className={cls.syncProgressText}>
                            {t('sync.progress')
                              .replace('{done}', String(syncing.attempt ?? 0))
                              .replace('{total}', String(syncing.total ?? 0))
                              .replace('{item}', syncing.item ?? '')}
                          </span>
                        </div>
                      )
                    : null}
                </div>
              </>
            )}
      {state.sync.status === 'error'
        ? (
            <p className={cls.error} role="alert">
              {t('sync.loadFailed')}
              {errorTextOf(state.sync.error ?? '', t)}
            </p>
          )
        : null}
      {state.sync.error !== null && state.sync.status !== 'error'
        ? (
            <p className={cls.error} role="alert">
              {t('sync.applyFailed')}
              {errorTextOf(state.sync.error, t)}
            </p>
          )
        : null}
      {state.sync.results !== null
        ? <SyncResults results={state.sync.results} applying={applying} t={t} onRetry={retryFailed} />
        : null}
    </section>
  )
}

/** One selection group: a counted header plus one checkbox row per item. */
function SyncGroup({ label, empty, rows, selected, t, onToggle }: {
  label: string
  empty: string
  rows: readonly SelectableRow[]
  selected: ReadonlySet<string>
  t: (key: SshKey) => string
  onToggle: (key: string) => void
}): ReactNode {
  // 计数只算「可同步」的条目：不可同步的行恒不勾，算进去会读出「2/15 已选」的假象。
  const syncable = rows.filter(row => row.syncable)
  const checked = syncable.filter(row => selected.has(row.key)).length
  return (
    <div className={cls.syncGroup}>
      <div className={cls.syncGroupHead}>
        <span className={cls.fieldLabel}>{label}</span>
        {rows.length === 0
          ? null
          : <span className={cls.syncCount}>{t('sync.groupCount').replace('{checked}', String(checked)).replace('{total}', String(syncable.length))}</span>}
      </div>
      {rows.length === 0
        ? <p className={cls.hint}>{empty}</p>
        : (
            <ul className={cls.syncItems}>
              {rows.map(row => (
                <li key={row.key} className={cls.syncItem}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={row.syncable && selected.has(row.key)}
                    className={cls.syncRow}
                    data-testid={`sync-row-${row.name}`}
                    disabled={!row.syncable || undefined}
                    title={row.reason}
                    onClick={() => onToggle(row.key)}
                  >
                    <span className={cls.syncBox} aria-hidden="true">
                      {row.syncable && selected.has(row.key)
                        ? (
                            <svg fill="none" height="10" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.4" viewBox="0 0 12 12" width="10">
                              <path d="M2 6.5 4.6 9 10 3.5" />
                            </svg>
                          )
                        : null}
                    </span>
                    <span className={cls.syncText}>
                      <span className={cls.syncName}>{row.name}</span>
                      {row.syncable ? null : <span className={cls.syncReason}>{row.reason ?? t('sync.notSyncable')}</span>}
                    </span>
                    <span className={cls.syncMeta}>{row.meta}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
    </div>
  )
}

/** The merged outcome list: every item this page attempted, with the tally. */
function SyncResults({ results, applying, t, onRetry }: {
  results: readonly SyncItemResult[]
  applying: boolean
  t: (key: SshKey) => string
  onRetry: () => void
}): ReactNode {
  const okCount = results.filter(item => item.ok).length
  const failed = results.length - okCount
  const [openLogOf, setOpenLogOf] = useState<string | null>(null)
  return (
    <div className={cls.syncResults} data-testid="sync-results">
      <p className={cls.syncSummary}>
        {t('sync.summary').replace('{ok}', String(okCount)).replace('{failed}', String(failed))}
      </p>
      <ul className={cls.syncItems}>
        {results.map(item => (
          <li
            key={syncKeyOf(item)}
            className={cls.syncResult}
            data-testid={`sync-result-${item.name}`}
            data-ok={item.ok}
          >
            <StateDot state={item.ok ? 'done' : 'error'} size={8} />
            <span className={cls.syncResultName}>
              {item.name}
              {item.root === undefined ? '' : ` (${item.root})`}
            </span>
            {item.ok
              ? <span className={cls.syncOk}>{t('sync.itemOk')}</span>
              : (
                  <>
                    <span className={cls.statusError} role="alert">
                      {t('sync.itemFailed')}
                      {item.error === undefined ? '' : `：${item.error}`}
                    </span>
                    {item.log === undefined
                      ? null
                      : (
                          <button
                            type="button"
                            className={cls.syncLogToggle}
                            aria-expanded={openLogOf === syncKeyOf(item)}
                            data-testid={`sync-log-toggle-${item.name}`}
                            onClick={() => setOpenLogOf(current => current === syncKeyOf(item) ? null : syncKeyOf(item))}
                          >
                            {openLogOf === syncKeyOf(item) ? t('sync.hideOutput') : t('sync.showOutput')}
                          </button>
                        )}
                  </>
                )}
          </li>
        ))}
      </ul>
      {failed > 0
        ? (
            <Button variant="outline" size="sm" disabled={applying} data-testid="sync-retry" onClick={onRetry}>
              {t('sync.retryFailed').replace('{count}', String(failed))}
            </Button>
          )
        : null}
      {openLogOf === null
        ? null
        : (
            <pre className={cls.logStream} data-testid="sync-log">
              {results.find(item => syncKeyOf(item) === openLogOf)?.log ?? ''}
            </pre>
          )}
    </div>
  )
}

/** The failed items of the last runs, resolved back to selectable refs. */
function failedRefsOf(
  results: readonly SyncItemResult[],
  preview: { plugins: SyncPluginItem[], skills: SyncSkillItem[] },
): { keys: Set<string>, plugins: SyncPluginItem[], skills: SyncSkillItem[] } {
  const keys = new Set(results.filter(item => !item.ok).map(syncKeyOf))
  return {
    keys,
    plugins: preview.plugins.filter(plugin => keys.has(pluginKeyOf(plugin))),
    skills: preview.skills.filter(skill => keys.has(skillKeyOf(skill))),
  }
}

/** The determinate bar width; an unknown total reads as empty. */
function barPercentOf(attempt: number | undefined, total: number | undefined): number {
  if (total === undefined || total <= 0)
    return 0
  return Math.min(100, Math.round((Math.max(0, (attempt ?? 0) - 1) / total) * 100))
}

/** The connected machines, manual first then discovered, in list order. */
function connectedMachinesOf(
  machines: readonly MachineRow[],
  discovered: readonly MachineRow[],
  statuses: Record<string, { state: string }>,
): MachineRow[] {
  return [...machines, ...discovered].filter(machine => statuses[machine.id]?.state === 'connected')
}
