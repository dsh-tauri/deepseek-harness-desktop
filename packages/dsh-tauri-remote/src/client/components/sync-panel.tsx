'use no memo'

import type { ReactNode } from 'react'
import type { RemoteKey } from '../locales/index'
import type { SyncItemResult, SyncPluginItem, SyncSkillItem } from '../types/index'
import { Button, Pill, StateDot } from 'dsh-tauri-ui/client'
import { cn, useStore } from 'dsh-tauri/client'
import { useEffect, useState } from 'react'
import * as machinesService from '../service/machines'
import * as syncService from '../service/sync'
import { store } from '../store/index'
import { syncKeyOf, toggleSelection } from '../store/modules/sync.utils'
import { errorTextOf } from '../utils/error'

interface SyncPanelProps {
  t: (key: RemoteKey) => string
}

interface SelectableRow {
  key: string
  name: string
  meta: string
  syncable: boolean
  reason?: string
}

export function SyncPanel({ t }: SyncPanelProps): ReactNode {
  const machinesState = useStore(store.machines)
  const syncState = useStore(store.sync)
  const [touched, setTouched] = useState<ReadonlySet<string> | null>(null)
  const [targetId, setTargetId] = useState<string | null>(null)

  useEffect(() => {
    if (syncState.status === 'idle')
      void syncService.loadSyncPreview()
  }, [syncState.status])

  useEffect(() => {
    if (machinesState.status === 'idle')
      void machinesService.load()
  }, [machinesState.status])

  const preview = syncState.preview
  const applying = syncState.applying
  const connected = [...machinesState.machines, ...machinesState.discovered].filter(machine => machinesState.statuses[machine.id]?.state === 'connected')
  const target = connected.find(machine => machine.id === (targetId ?? connected[0]?.id))
  const pluginRows: SelectableRow[] = (preview?.plugins ?? []).map(plugin => ({
    key: syncKeyOf({ kind: 'plugin', name: plugin.name }),
    name: plugin.name,
    meta: plugin.spec,
    syncable: plugin.syncable,
    ...plugin.reason === undefined ? {} : { reason: plugin.reason },
  }))
  const skillRows: SelectableRow[] = (preview?.skills ?? []).map(skill => ({
    key: syncKeyOf({ kind: 'skill', name: skill.name, root: skill.root }),
    name: skill.name,
    meta: skill.root,
    syncable: true,
  }))
  const selectableKeys = [...pluginRows, ...skillRows].filter(row => row.syncable).map(row => row.key)
  const selected = touched ?? new Set(selectableKeys)
  const plugins = (preview?.plugins ?? []).filter(plugin => selected.has(syncKeyOf({ kind: 'plugin', name: plugin.name })))
  const skills = (preview?.skills ?? []).filter(skill => selected.has(syncKeyOf({ kind: 'skill', name: skill.name, root: skill.root })))
  const canApply = target !== undefined && !applying && (plugins.length > 0 || skills.length > 0)
  const progress = target === undefined ? undefined : machinesState.statuses[target.id]?.progress
  const syncing = progress?.phase === 'syncing' ? progress : undefined

  const apply = (): void => {
    if (target === undefined)
      return
    void syncService.applySync({ machineId: target.id, plugins, skills })
  }

  const retryFailed = (): void => {
    if (target === undefined || preview === null)
      return
    const failed = failedRefsOf(syncState.results ?? [], preview)
    setTouched(new Set(failed.keys))
    void syncService.applySync({ machineId: target.id, plugins: failed.plugins, skills: failed.skills })
  }

  return (
    <section className="flex flex-col gap-[12px] max-w-[960px] text-primary" data-testid="sync-panel">
      <div className="flex flex-wrap items-start justify-between gap-[12px]">
        <div>
          <h2 className="m-0 text-[18px] leading-[28px] font-semibold text-primary">{t('sync.title')}</h2>
          <p className="m-0 text-[13px] leading-[20px] text-tertiary">{t('sync.desc')}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-[8px]">
          <Button
            variant="outline"
            size="sm"
            disabled={syncState.status === 'loading' || applying}
            onClick={() => {
              setTouched(null)
              void syncService.loadSyncPreview()
            }}
          >
            {t('sync.refresh')}
          </Button>
        </div>
      </div>
      {machinesState.role?.remote === true
        ? <p className="m-0 rounded-[8px] border border-dashed border-border-l3 p-[12px] text-center text-[12px] leading-[18px] text-tertiary" data-testid="sync-remote-note">{t('sync.remoteSessionHint')}</p>
        : connected.length === 0
          ? <p className="m-0 rounded-[8px] border border-dashed border-border-l3 p-[12px] text-center text-[12px] leading-[18px] text-tertiary" data-testid="sync-empty">{t('sync.notConnectedHint')}</p>
          : (
              <>
                <div className="flex flex-wrap items-center gap-[6px]">
                  <span className="text-[12px] leading-[18px] font-medium text-secondary">{t('sync.target')}</span>
                  {connected.map(machine => (
                    <Pill
                      key={machine.id}
                      active={machine.id === target?.id}
                      disabled={applying}
                      aria-pressed={machine.id === target?.id}
                      data-testid={`sync-target-${machine.id}`}
                      onClick={() => setTargetId(machine.id)}
                    >
                      <span className="inline-flex items-center gap-[6px]">
                        <StateDot state="done" size={6} />
                        {machine.name}
                      </span>
                    </Pill>
                  ))}
                </div>
                {preview === null || syncState.status === 'loading'
                  ? <p className="m-0 text-[12px] leading-[18px] text-tertiary">{t('loading')}</p>
                  : (syncState.status === 'ready'
                      ? (
                          <>
                            <div className="flex flex-wrap items-center gap-[8px] pt-[2px]">
                              <span className="text-[12px] leading-[18px] text-secondary" data-testid="sync-selected">
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
                <div className="flex flex-wrap items-center gap-[10px] pt-[2px]">
                  <Button variant="primary" size="sm" disabled={!canApply} data-testid="sync-apply" onClick={apply}>
                    {applying
                      ? t('sync.applying')
                      : target === undefined
                        ? t('sync.apply')
                        : t('sync.applyTo').replace('{name}', target.name)}
                  </Button>
                  {syncing !== undefined
                    ? (
                        <div className="flex min-w-[220px] flex-1 items-center gap-[8px]" data-testid="sync-progress">
                          <span className="block h-[4px] flex-1 overflow-hidden rounded-[2px] bg-border-l2" aria-hidden="true">
                            <span
                              className="block h-full rounded-[2px] bg-brand [transition:width_200ms_ease]"
                              style={{ width: `${barPercentOf(syncing.attempt, syncing.total)}%` }}
                            />
                          </span>
                          <span className="shrink-0 text-[12px] leading-[18px] text-secondary">
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
      {syncState.status === 'error'
        ? (
            <p className="m-0 text-[12px] leading-[18px] text-error" role="alert">
              {t('sync.loadFailed')}
              {errorTextOf(syncState.error ?? '', t)}
            </p>
          )
        : null}
      {syncState.error !== null && syncState.status !== 'error'
        ? (
            <p className="m-0 text-[12px] leading-[18px] text-error" role="alert">
              {t('sync.applyFailed')}
              {errorTextOf(syncState.error, t)}
            </p>
          )
        : null}
      {syncState.results !== null
        ? <SyncResults results={syncState.results} applying={applying} t={t} onRetry={retryFailed} />
        : null}
    </section>
  )
}

function SyncGroup({ label, empty, rows, selected, t, onToggle }: {
  label: string
  empty: string
  rows: readonly SelectableRow[]
  selected: ReadonlySet<string>
  t: (key: RemoteKey) => string
  onToggle: (key: string) => void
}): ReactNode {
  const syncable = rows.filter(row => row.syncable)
  const checked = syncable.filter(row => selected.has(row.key)).length
  return (
    <div className="flex flex-col gap-[6px]">
      <div className="flex items-center gap-[6px]">
        <span className="text-[12px] leading-[18px] font-medium text-secondary">{label}</span>
        {rows.length === 0
          ? null
          : <span className="text-[12px] leading-[18px] text-secondary">{t('sync.groupCount').replace('{checked}', String(checked)).replace('{total}', String(syncable.length))}</span>}
      </div>
      {rows.length === 0
        ? <p className="m-0 text-[12px] leading-[18px] text-tertiary">{empty}</p>
        : (
            <ul className="m-0 flex list-none flex-col gap-[2px] p-0">
              {rows.map((row) => {
                const ticked = row.syncable && selected.has(row.key)
                return (
                  <li key={row.key} className="flex flex-wrap items-center gap-[8px]">
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={ticked}
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-[8px] rounded-[6px] border-0 bg-transparent px-[8px] py-[5px] text-left text-[13px] leading-[20px] text-inherit [font-family:inherit] hover:not-disabled:bg-hover disabled:cursor-not-allowed disabled:opacity-60"
                      data-testid={`sync-row-${row.name}`}
                      disabled={!row.syncable || undefined}
                      title={row.reason}
                      onClick={() => onToggle(row.key)}
                    >
                      <span className={cn('inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-[4px] border border-border-l4 text-primary-fg', ticked && 'border-brand bg-brand')} aria-hidden="true">
                        {ticked
                          ? (
                              <svg fill="none" height="10" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.4" viewBox="0 0 12 12" width="10">
                                <path d="M2 6.5 4.6 9 10 3.5" />
                              </svg>
                            )
                          : null}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-[1px]">
                        <span className="truncate text-[13px] leading-[20px] text-primary">{row.name}</span>
                        {row.syncable ? null : <span className="truncate text-[11px] leading-[16px] text-[var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-tertiary))]">{row.reason ?? t('sync.notSyncable')}</span>}
                      </span>
                      <span className="ml-auto max-w-[40%] shrink-0 truncate pl-[8px] text-[11px] leading-[16px] text-tertiary">{row.meta}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
    </div>
  )
}

function SyncResults({ results, applying, t, onRetry }: {
  results: readonly SyncItemResult[]
  applying: boolean
  t: (key: RemoteKey) => string
  onRetry: () => void
}): ReactNode {
  const okCount = results.filter(item => item.ok).length
  const failed = results.length - okCount
  const [openLogOf, setOpenLogOf] = useState<string | null>(null)
  return (
    <div className="mt-[4px] flex flex-col items-start gap-[6px] border-t border-t-border-l2 pt-[12px]" data-testid="sync-results">
      <p className="m-0 text-[12px] leading-[18px] text-secondary">
        {t('sync.summary').replace('{ok}', String(okCount)).replace('{failed}', String(failed))}
      </p>
      <ul className="m-0 flex list-none flex-col gap-[2px] p-0">
        {results.map(item => (
          <li
            key={syncKeyOf(item)}
            className="flex flex-wrap items-center gap-[8px]"
            data-testid={`sync-result-${item.name}`}
            data-ok={item.ok}
          >
            <StateDot state={item.ok ? 'done' : 'error'} size={8} />
            <span className="text-[12px] leading-[18px] font-medium text-primary">
              {item.name}
              {item.root === undefined ? '' : ` (${item.root})`}
            </span>
            {item.ok
              ? <span className="text-[12px] leading-[18px] text-success">{t('sync.itemOk')}</span>
              : (
                  <>
                    <span className="m-0 text-[12px] leading-[18px] text-error" role="alert">
                      {t('sync.itemFailed')}
                      {item.error === undefined ? '' : `：${item.error}`}
                    </span>
                    {item.log === undefined
                      ? null
                      : (
                          <button
                            type="button"
                            className="cursor-pointer border-0 bg-transparent p-0 text-[12px] leading-[18px] text-business"
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
            <pre className="m-0 max-h-[160px] overflow-auto font-mono text-[11px] leading-[16px] whitespace-pre-wrap text-tertiary [overflow-wrap:anywhere]" data-testid="sync-log">
              {results.find(item => syncKeyOf(item) === openLogOf)?.log ?? ''}
            </pre>
          )}
    </div>
  )
}

function failedRefsOf(
  results: readonly SyncItemResult[],
  preview: { plugins: readonly SyncPluginItem[], skills: readonly SyncSkillItem[] },
): { keys: Set<string>, plugins: SyncPluginItem[], skills: SyncSkillItem[] } {
  const keys = new Set(results.filter(item => !item.ok).map(syncKeyOf))
  return {
    keys,
    plugins: preview.plugins.filter(plugin => keys.has(syncKeyOf({ kind: 'plugin', name: plugin.name }))),
    skills: preview.skills.filter(skill => keys.has(syncKeyOf({ kind: 'skill', name: skill.name, root: skill.root }))),
  }
}

function barPercentOf(attempt: number | undefined, total: number | undefined): number {
  if (total === undefined || total <= 0)
    return 0
  return Math.min(100, Math.round((Math.max(0, (attempt ?? 0) - 1) / total) * 100))
}
