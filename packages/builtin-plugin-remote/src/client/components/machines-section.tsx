import type { ComponentType, CSSProperties, ReactNode } from 'react'
import type { RemoteKey } from '../locales/index'
import type { MachinesNotice } from '../store/modules/machines.types'
import type { InstallResult, MachineLifecycleState, MachineRow, MachineStatus, ProgressPhase, RemoteBridge, SecretValues } from '../types/index'
import { Action, ArrowRotateRight, Button, CirclePlay, EllipsisVertical, Icon, Input, Menu, Modal, PersonPencil, PlugConnection, StateDot, Switch, TrashBin } from 'dsh-tauri-ui/client'
import { cn, useStore } from 'dsh-tauri/client'
import { useEffect, useState } from 'react'
import { DEFAULT_REMOTE_PORT, DEFAULT_SSH_PORT } from '../../shared/constants'
import { messageOf } from '../../shared/error'
import { desktopBridge } from '../service/bridge'
import * as service from '../service/machines'
import { store } from '../store/index'
import { errorTextOf } from '../utils/error'
import { retrySecondsOf } from '../utils/retry'

type DotState = 'done' | 'ongoing' | 'error' | 'idle'

const COLOR_CHOICES = [
  '#4176E6',
  '#0EA5E9',
  '#14B8A6',
  '#22C55E',
  '#F59E0B',
  '#F97316',
  '#EF4444',
  '#A855F7',
]

interface Draft {
  key: string
  row: MachineRow
}

type DirtySecrets = Record<string, SecretValues>

type SecretFieldName = 'password' | 'passphrase'

interface MachinesSectionProps {
  t: (key: RemoteKey) => string
  bridge?: RemoteBridge | undefined
}

interface RemoveTarget {
  key: string
  id: string
  name: string
}

interface ReinstallTarget {
  id: string
  actual?: string
  expected: string
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u

function slugOf(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^.*@/u, '')
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
}

function freeIdOf(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base))
    return base
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`
    if (!taken.has(candidate))
      return candidate
  }
}

function RowShell({ id, name, tag, tintColor, tintBorder, status, trail, actions, t, children }: {
  id: string
  name: string
  tag?: string | undefined
  tintColor: string | undefined
  tintBorder: boolean
  status: MachineStatus | undefined
  trail: readonly ProgressPhase[]
  actions: ReactNode
  t: (key: RemoteKey) => string
  children?: ReactNode
}): ReactNode {
  const detail = status?.progress !== undefined || status?.state === 'reconnecting' || status?.state === 'given-up'
    ? statusTextOf(status, t)
    : undefined
  return (
    <li
      className="group flex flex-col gap-[8px] border-l-2 border-l-transparent px-[14px] py-[10px] [&+&]:border-t [&+&]:border-t-border-l2"
      data-testid={`machine-${id}`}
      style={tintBorder && tintColor !== undefined ? { borderLeftColor: tintColor } : undefined}
    >
      <div className="flex items-center gap-[10px]">
        <span className="inline-flex min-w-0 flex-1 items-center gap-[6px]">
          <StateDotOf status={status} />
          {tintColor !== undefined
            ? <span className="inline-block h-[10px] w-[10px] shrink-0 rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)]" style={{ background: tintColor }} aria-hidden="true" />
            : null}
          <span className="truncate text-[14px] leading-[22px] font-medium text-primary">{name}</span>
          {tag === undefined
            ? null
            : <span className="shrink-0 rounded-full border-0 bg-module-platform px-[8px] py-[2px] text-[11px] leading-[16px] text-secondary" data-testid={`tag-${id}`}>{tag}</span>}
          {detail === undefined
            ? null
            : <span className="min-w-0 truncate text-[12px] leading-[18px] text-tertiary" data-testid={`status-${id}`}>{detail}</span>}
          <StepRail trail={trail} t={t} />
        </span>
        <span className="ml-auto inline-flex shrink-0 items-center gap-[4px] whitespace-nowrap">{actions}</span>
      </div>
      {children}
    </li>
  )
}

function EditPanel({ draft, t, hasPassword, hasPassphrase, dirty, saving, onChange, onSecret, onSave, onCancel }: {
  draft: Draft
  t: (key: RemoteKey) => string
  hasPassword: boolean
  hasPassphrase: boolean
  dirty: SecretValues
  saving: boolean
  onChange: (key: string, patch: Partial<MachineRow>) => void
  onSecret: (key: string, field: SecretFieldName, value: string) => void
  onSave: (key: string) => void
  onCancel: (key: string) => void
}): ReactNode {
  const { row } = draft
  const invalid = row.id === '' || row.name === '' || row.host === ''
  return (
    <div className="mx-0 mb-[4px] mt-[2px] flex flex-col gap-[12px] border-t border-t-border-l2 pt-[12px]" data-testid={`editor-${row.id}`}>
      <div className="grid grid-cols-[repeat(12,minmax(0,1fr))] gap-[10px_12px] max-[760px]:grid-cols-[repeat(6,minmax(0,1fr))]">
        <Field label={t('field.name')} span={4}>
          <Input className="box-border w-full" value={row.name} disabled={saving} onChange={event => onChange(draft.key, { name: event.target.value })} />
        </Field>
        <Field label={t('field.host')} span={5}>
          <Input className="box-border w-full" value={row.host} disabled={saving} onChange={event => onChange(draft.key, { host: event.target.value })} />
        </Field>
        <Field label={t('field.port')} span={3}>
          <Input className="box-border w-full" type="number" value={row.port} disabled={saving} onChange={event => onChange(draft.key, { port: numberOf(event.target.value, DEFAULT_SSH_PORT) })} />
        </Field>
        <Field label={t('field.user')} span={3}>
          <Input className="box-border w-full" value={row.user} disabled={saving} onChange={event => onChange(draft.key, { user: event.target.value })} />
        </Field>
        <Field label={t('field.remotePort')} span={3}>
          <Input className="box-border w-full" type="number" value={row.remotePort} disabled={saving} onChange={event => onChange(draft.key, { remotePort: numberOf(event.target.value, DEFAULT_REMOTE_PORT) })} />
        </Field>
        <Field label={t('field.profileName')} span={3}>
          <Input className="box-border w-full" value={row.profileName ?? ''} placeholder="remote" disabled={saving || (row.startCommand ?? '') !== ''} onChange={event => onChange(draft.key, { profileName: event.target.value })} />
        </Field>
        <Field label={t('field.startCommand')} span={12}>
          <Input className="box-border w-full" value={row.startCommand ?? ''} disabled={saving} onChange={event => onChange(draft.key, { startCommand: event.target.value })} />
        </Field>
      </div>
      <div className="grid grid-cols-[repeat(12,minmax(0,1fr))] gap-[10px_12px] max-[760px]:grid-cols-[repeat(6,minmax(0,1fr))]">
        <SecretField field="password" label={t('field.password')} keyName={draft.key} hasSecret={hasPassword} t={t} value={dirty.password ?? ''} onValue={onSecret} />
        <SecretField field="passphrase" label={t('field.passphrase')} keyName={draft.key} hasSecret={hasPassphrase} t={t} value={dirty.passphrase ?? ''} onValue={onSecret} />
      </div>
      <AppearanceEditor row={row} t={t} onChange={onChange} draftKey={draft.key} />
      <div className="flex items-center justify-end gap-[8px]">
        {invalid ? <p className={cn('m-0 text-[12px] leading-[18px] text-tertiary', 'mr-auto')}>{t('saveHint')}</p> : null}
        <Button variant="ghost" size="sm" disabled={saving} onClick={() => onCancel(draft.key)}>
          {t('add.cancel')}
        </Button>
        <Button variant="primary" size="sm" disabled={saving || invalid} onClick={() => onSave(draft.key)}>
          {t('save')}
        </Button>
      </div>
    </div>
  )
}

interface RowMenuItem {
  key: string
  label: string
  icon: ComponentType
  title?: string
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

function RowMenu({ t, items }: { t: (key: RemoteKey) => string, items: readonly RowMenuItem[] }): ReactNode {
  const [open, setOpen] = useState(false)
  if (items.length === 0)
    return null
  return (
    <Menu
      open={open}
      onClose={() => setOpen(false)}
      onSelect={(id) => {
        setOpen(false)
        items.find(item => item.key === id)?.onSelect()
      }}
      items={items.map(item => ({
        id: item.key,
        label: item.label,
        icon: <Icon size={14} as={item.icon} />,
        title: item.title,
        danger: item.danger === true,
        disabled: item.disabled === true,
      }))}
      portal
      align="end"
      anchor={(
        <Action
          variant="action"
          icon={<Icon size={12} as={EllipsisVertical} />}
          aria-label={t('more')}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(previous => !previous)}
        />
      )}
    />
  )
}

function RowActions({ id, t, status, busy, bridgeOpen, bridgePending, opening, onTest, onConnect, onDisconnect, onOpen, menuItems }: {
  id: string
  t: (key: RemoteKey) => string
  status: MachineStatus | undefined
  busy: 'test' | 'connect' | 'disconnect' | 'install' | undefined
  bridgeOpen: boolean
  bridgePending?: boolean
  opening?: boolean
  onTest: (id: string) => void
  onConnect: (id: string) => void
  onDisconnect: (id: string) => void
  onOpen: (id: string) => void
  menuItems?: readonly RowMenuItem[]
}): ReactNode {
  const connected = status?.state === 'connected'
  const held = status?.state === 'connecting' || status?.state === 'testing' || status?.state === 'reconnecting'
  const secondary: readonly RowMenuItem[] = [
    { key: 'test', label: t('test'), icon: CirclePlay, disabled: busy !== undefined || held, onSelect: () => onTest(id) },
    ...connected
      ? [{ key: 'disconnect', label: t('disconnect'), icon: PlugConnection, disabled: busy !== undefined, onSelect: () => onDisconnect(id) }]
      : [],
    ...menuItems ?? [],
  ]
  return (
    <>
      {connected
        ? (
            bridgeOpen
              ? (
                  <Button variant="primary" size="sm" disabled={busy !== undefined || opening === true} title={t('open.tip')} onClick={() => onOpen(id)}>
                    {opening === true ? t('open.opening') : t('open')}
                  </Button>
                )
              : bridgePending === true
                ? (
                    <Button variant="primary" size="sm" disabled title={t('open.probing')}>
                      {t('open')}
                    </Button>
                  )
                : null
          )
        : (
            <Button variant="primary" size="sm" disabled={busy !== undefined || held} onClick={() => onConnect(id)}>
              {t('connect')}
            </Button>
          )}
      <RowMenu t={t} items={secondary} />
    </>
  )
}

function RowDetails({ id, status, busy, logLines, bridgeError, installResult, t, onInstall }: {
  id: string
  status: MachineStatus | undefined
  busy: 'test' | 'connect' | 'disconnect' | 'install' | undefined
  logLines: readonly string[]
  bridgeError: string | undefined
  installResult: InstallResult | undefined
  t: (key: RemoteKey) => string
  onInstall: (id: string, reinstall: boolean) => void
}): ReactNode {
  return (
    <>
      {status?.dshMissing === true
        ? <InstallPanel status={status} busy={busy} t={t} onInstall={reinstall => onInstall(id, reinstall)} />
        : null}
      {status?.lastError !== undefined ? <p className="m-0 text-[12px] leading-[18px] text-error" role="alert">{status.lastError}</p> : null}
      {bridgeError !== undefined
        ? (
            <p className="m-0 text-[12px] leading-[18px] text-error" role="alert" data-testid={`bridge-error-${id}`}>
              {t('bridge.error')}
              {bridgeError}
            </p>
          )
        : null}
      <LogStream id={id} lines={logLines} fallback={status?.progress?.log} t={t} />
      {installResult !== undefined
        ? <p className="m-0 text-[12px] leading-[18px] text-secondary" data-testid={`install-note-${id}`}>{installNoteOf(installResult, t)}</p>
        : null}
    </>
  )
}

function StateDotOf({ status }: { status: MachineStatus | undefined }): ReactNode {
  const state = dotStateOf(status)
  if (state === 'idle')
    return <span className="relative inline-block h-[8px] w-[8px] shrink-0 rounded-full bg-current text-[var(--dsw-alias-label-caption)] after:absolute after:inset-[25%] after:rounded-full after:bg-current after:content-['']" data-state="idle" aria-hidden="true" />
  return <StateDot state={state} size={8} />
}

function LogStream({ id, lines, fallback, t }: { id: string, lines: readonly string[], fallback: string | undefined, t: (key: RemoteKey) => string }): ReactNode {
  const [open, setOpen] = useState(false)
  const output = lines.length > 0
    ? lines.join('\n')
    : (fallback ?? '')
  if (output === '')
    return null
  return (
    <div className="flex flex-col gap-[4px]">
      <div className="flex items-center gap-[8px]">
        <span className="h-px flex-1 bg-border-l2" aria-hidden="true" />
        <button
          type="button"
          className="cursor-pointer border-none bg-transparent p-0 text-[11px] leading-[16px] text-tertiary hover:text-secondary"
          aria-expanded={open}
          data-testid={`machine-log-toggle-${id}`}
          onClick={() => setOpen(previous => !previous)}
        >
          {open ? t('log.hide') : t('log.show')}
        </button>
        <span className="h-px flex-1 bg-border-l2" aria-hidden="true" />
      </div>
      {open
        ? (
            <pre className="m-0 max-h-[160px] overflow-auto font-mono text-[11px] leading-[16px] whitespace-pre-wrap text-tertiary [overflow-wrap:anywhere]" data-testid={`machine-log-${id}`}>
              {output}
            </pre>
          )
        : null}
    </div>
  )
}

/** dshMissing 只决定文案与按钮：两种情况都提供安装入口，已装好的机器走「重新安装」 */
const INSTALL_VIEW_OF = {
  missing: { hint: 'install.hint', action: 'install.action', variant: 'primary', reinstall: false },
  ready: { hint: 'install.reinstall_hint', action: 'install.reinstall', variant: 'outline', reinstall: true },
} as const satisfies Record<string, { hint: RemoteKey, action: RemoteKey, variant: 'primary' | 'outline', reinstall: boolean }>

function InstallPanel({ status, busy, t, onInstall }: {
  status: MachineStatus
  busy: 'test' | 'connect' | 'disconnect' | 'install' | undefined
  t: (key: RemoteKey) => string
  onInstall: (reinstall: boolean) => void
}): ReactNode {
  // 后端在重连/握手期拒绝新的 install 请求，按钮同步禁用，避免点了才报错。
  const held = status.state === 'connecting' || status.state === 'testing' || status.state === 'reconnecting'
  const view = status.dshMissing === true ? INSTALL_VIEW_OF.missing : INSTALL_VIEW_OF.ready
  return (
    <div className="flex items-center gap-[12px] rounded-[8px] border border-border-l2 bg-[var(--dsw-alias-surface-tinted)] px-[12px] py-[10px]" data-testid={`install-panel-${status.dshMissing === true ? 'missing' : 'ready'}`}>
      <p className="m-0 min-w-0 flex-1 text-[12px] leading-[18px] text-secondary">
        {t(view.hint)}
      </p>
      <Button variant={view.variant} size="sm" className="shrink-0 whitespace-nowrap" disabled={busy !== undefined || held} onClick={() => onInstall(view.reinstall)}>
        {t(view.action)}
      </Button>
    </div>
  )
}

function installNoteOf(result: InstallResult, t: (key: RemoteKey) => string): string {
  if (result.credentialsError !== undefined) {
    return t('install.done.error') + result.credentialsError
  }
  return result.credentialsCopied ? t('install.done.copied') : t('install.done.nokey')
}

type FieldSpan = 3 | 4 | 5 | 6 | 8 | 12

function Field({ label, span = 6, children }: { label: string, span?: FieldSpan, children: ReactNode }): ReactNode {
  return (
    <label
      className={cn('flex min-w-0 flex-col gap-[6px] max-[520px]:col-span-6!', {
        3: 'col-span-3',
        4: 'col-span-4 max-[760px]:col-span-3',
        5: 'col-span-5 max-[760px]:col-span-3',
        6: 'col-span-6 max-[760px]:col-span-3',
        8: 'col-span-8 max-[760px]:col-span-6',
        12: 'col-span-12 max-[760px]:col-span-6',
      }[span])}
    >
      <span className="text-[12px] leading-[18px] font-medium text-secondary">{label}</span>
      {children}
    </label>
  )
}

function AppearanceEditor({ row, t, onChange, draftKey }: {
  row: MachineRow
  t: (key: RemoteKey) => string
  onChange: (key: string, patch: Partial<MachineRow>) => void
  draftKey: string
}): ReactNode {
  const color = colorOf(row)
  return (
    <div className="flex flex-wrap items-center gap-[10px]">
      <span className="text-[12px] leading-[18px] font-medium text-secondary">{t('field.color')}</span>
      <div className="inline-flex flex-wrap items-center gap-[6px]">
        {COLOR_CHOICES.map(choice => (
          <button
            key={choice}
            type="button"
            className={cn('box-border h-[20px] w-[20px] cursor-pointer rounded-full border border-border-l2 bg-[color:var(--swatch-color)] p-0 hover:border-border-l4', color === choice && 'outline-2 outline-brand outline-offset-2')}
            data-selected={color === choice}
            style={{ '--swatch-color': choice } as CSSProperties}
            aria-label={`${t('field.color')}: ${choice}`}
            aria-pressed={color === choice}
            onClick={() => onChange(draftKey, { color: color === choice ? '' : choice })}
          />
        ))}
        <button
          type="button"
          className={cn('box-border h-[20px] w-[20px] cursor-pointer rounded-full border border-border-l2 bg-[color:var(--swatch-color)] p-0 hover:border-border-l4', 'bg-[image:linear-gradient(to_top_right,transparent_calc(50%_-_1px),var(--dsw-alias-label-tertiary),transparent_calc(50%_+_1px))]', color === undefined && 'outline-2 outline-brand outline-offset-2')}
          data-selected={color === undefined}
          aria-label={t('color.none')}
          aria-pressed={color === undefined}
          title={t('color.none')}
          onClick={() => onChange(draftKey, { color: '', tintBorder: false })}
        />
        <span className="ml-[4px] inline-flex items-center gap-[8px]">
          <Switch
            checked={row.tintBorder === true}
            disabled={color === undefined}
            label={t('field.tintBorder')}
            onChange={tintBorder => onChange(draftKey, { tintBorder })}
          />
          <span className="text-[12px] leading-[18px] font-medium text-secondary">{t('field.tintBorder')}</span>
        </span>
      </div>
    </div>
  )
}

function SecretField({ field, label, keyName, hasSecret, t, value, onValue }: {
  field: SecretFieldName
  label: string
  keyName: string
  hasSecret: boolean
  t: (key: RemoteKey) => string
  value: string
  onValue: (key: string, field: SecretFieldName, value: string) => void
}): ReactNode {
  return (
    <Field label={label}>
      <Input
        className="box-border w-full"
        type="password"
        value={value}
        placeholder={hasSecret ? t('secret.set') : t('secret.unset')}
        onChange={event => onValue(keyName, field, event.target.value)}
      />
    </Field>
  )
}

function colorOf(row: MachineRow): string | undefined {
  return row.color === undefined || row.color === '' ? undefined : row.color
}

const STEP_KEY_OF: Record<ProgressPhase, RemoteKey> = {
  handshake: 'step.handshake',
  installing: 'step.installing',
  starting: 'step.starting',
  probing: 'step.probing',
  syncing: 'step.syncing',
}

function StepRail({ trail, t }: { trail: readonly ProgressPhase[], t: (key: RemoteKey) => string }): ReactNode {
  if (trail.length === 0)
    return null
  const current = trail[trail.length - 1]
  return (
    <ol className="m-0 inline-flex shrink-0 list-none gap-[4px] p-0 align-middle" data-testid="step-rail">
      {trail.map(phase => (
        <li
          key={phase}
          className={phase === current ? 'rounded-full border border-current px-[6px] text-[11px] leading-[16px] text-[var(--dsw-alias-state-warning-primary,#d48806)]' : 'rounded-full border border-[color:var(--dsw-alias-line-secondary,currentColor)] px-[6px] text-[11px] leading-[16px] text-tertiary'}
        >
          {t(STEP_KEY_OF[phase])}
        </li>
      ))}
    </ol>
  )
}

function dotStateOf(status: MachineStatus | undefined): DotState {
  if (status?.state === 'connected')
    return 'done'
  if (status?.state === 'connecting' || status?.state === 'testing' || status?.state === 'reconnecting')
    return 'ongoing'
  if (status?.state === 'given-up')
    return 'error'
  return 'idle'
}

const STATUS_KEY_OF: Record<MachineLifecycleState, RemoteKey> = {
  'disconnected': 'status.disconnected',
  'testing': 'status.testing',
  'connecting': 'status.connecting',
  'connected': 'status.connected',
  'reconnecting': 'status.reconnecting',
  'given-up': 'status.givenUp',
}

function statusTextOf(status: MachineStatus | undefined, t: (key: RemoteKey) => string): string {
  const progress = status?.progress
  if (progress !== undefined) {
    return t(`progress.${progress.phase}`)
      .replace('{attempt}', String(progress.attempt ?? '?'))
      .replace('{total}', String(progress.total ?? '?'))
  }
  const base = status === undefined
    ? t('status.disconnected')
    : t(STATUS_KEY_OF[status.state])
  if (status?.state === 'reconnecting' && status.nextRetryAt !== undefined) {
    const seconds = retrySecondsOf(status.nextRetryAt, Date.now())
    const hint = seconds <= 0 ? t('retry.now') : t('retry.inSeconds').replace('{seconds}', String(seconds))
    return base + t('status.nextRetry').replace('{hint}', hint)
  }
  return base
}

function numberOf(raw: string, fallback: number): number {
  const parsed = Number(raw)
  return raw !== '' && Number.isFinite(parsed) ? parsed : fallback
}

function noticeTextOf(notice: MachinesNotice, t: (key: RemoteKey) => string): string {
  if (notice.kind === 'text')
    return notice.text
  let text = t(notice.key)
  for (const [name, value] of Object.entries(notice.params ?? {}))
    text = text.replace(`{${name}}`, String(value))
  return text
}

function AddMachineDialog({ t, saving, takenIds, onSubmit, onClose }: {
  t: (key: RemoteKey) => string
  saving: boolean
  takenIds: ReadonlySet<string>
  onSubmit: (row: MachineRow) => void
  onClose: () => void
}): ReactNode {
  const [host, setHost] = useState('')
  const [name, setName] = useState('')
  const [port, setPort] = useState(String(DEFAULT_SSH_PORT))
  const [user, setUser] = useState('')
  const [remotePort, setRemotePort] = useState(String(DEFAULT_REMOTE_PORT))

  const slug = slugOf(host)
  const effectiveId = slug === '' ? '' : freeIdOf(slug, takenIds)
  const trimmedHost = host.trim()
  const errorKey: RemoteKey | null
    = trimmedHost === ''
      ? 'add.host_required'
      : !ID_PATTERN.test(effectiveId)
          ? 'add.id_invalid'
          : takenIds.has(effectiveId)
            ? 'add.id_taken'
            : null

  function submit(): void {
    if (errorKey !== null || saving)
      return
    onSubmit({
      id: effectiveId,
      name: name.trim() === '' ? effectiveId : name.trim(),
      host: trimmedHost,
      port: numberOf(port, DEFAULT_SSH_PORT),
      user: user.trim(),
      hasPassword: false,
      hasPassphrase: false,
      remotePort: numberOf(remotePort, DEFAULT_REMOTE_PORT),
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('add.title')}
      closeLabel={t('add.cancel')}
      footer={(
        <>
          <Button variant="ghost" disabled={saving} onClick={onClose}>{t('add.cancel')}</Button>
          <Button variant="primary" disabled={saving || errorKey !== null} onClick={submit}>{t('add.submit')}</Button>
        </>
      )}
    >
      <div className="grid grid-cols-[repeat(12,minmax(0,1fr))] gap-[10px_12px] max-[520px]:grid-cols-[repeat(6,minmax(0,1fr))]">
        <Field label={t('field.host')} span={8}>
          <Input
            className="box-border w-full"
            value={host}
            autoFocus
            disabled={saving}
            onChange={event => setHost(event.target.value)}
          />
        </Field>
        <Field label={t('field.port')} span={4}>
          <Input className="box-border w-full" value={port} disabled={saving} onChange={event => setPort(event.target.value)} />
        </Field>
        <Field label={t('field.name')} span={4}>
          <Input className="box-border w-full" value={name} placeholder={effectiveId} disabled={saving} onChange={event => setName(event.target.value)} />
        </Field>
        <Field label={t('field.user')} span={4}>
          <Input className="box-border w-full" value={user} disabled={saving} onChange={event => setUser(event.target.value)} />
        </Field>
        <Field label={t('field.remotePort')} span={4}>
          <Input className="box-border w-full" value={remotePort} disabled={saving} onChange={event => setRemotePort(event.target.value)} />
        </Field>
      </div>
      {errorKey === null
        ? null
        : <p className="m-0 text-[12px] leading-[18px] text-error" role="alert">{t(errorKey)}</p>}
    </Modal>
  )
}

export function MachinesSection({ t, bridge = desktopBridge }: MachinesSectionProps): ReactNode {
  const state = useStore(store.machines)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [dirty, setDirty] = useState<DirtySecrets>({})
  const [editingId, setEditingId] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [addSaving, setAddSaving] = useState(false)
  const [availability, setAvailability] = useState<'desktop' | 'web' | 'unknown'>(() => bridge?.probe === undefined ? 'web' : 'unknown')
  const [bridgeErrors, setBridgeErrors] = useState<Record<string, string>>({})
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null)
  const [reinstallTarget, setReinstallTarget] = useState<ReinstallTarget | null>(null)

  useEffect(() => {
    void service.load()
  }, [])

  useEffect(() => {
    const probe = bridge?.probe
    if (probe === undefined)
      return
    let current = true
    probe().then(
      () => {
        if (current)
          setAvailability('desktop')
      },
      () => {
        if (current)
          setAvailability('web')
      },
    )
    return () => {
      current = false
    }
  }, [bridge])

  const patchDraft = (key: string, patch: Partial<MachineRow>): void => {
    setDrafts(previous => ({
      ...previous,
      [key]: { key, row: { ...previous[key]!.row, ...patch } },
    }))
  }

  const patchDirty = (key: string, field: SecretFieldName, value: string): void => {
    setDirty(previous => ({ ...previous, [key]: { ...previous[key], [field]: value } }))
  }

  const openEditor = (row: MachineRow): void => {
    setDrafts(previous => ({ ...previous, [row.id]: { key: row.id, row: { ...row } } }))
    setEditingId(row.id)
  }

  const closeEditor = (key: string): void => {
    setDirty((previous) => {
      const next = { ...previous }
      delete next[key]
      return next
    })
    setEditingId(null)
  }

  const saveRow = async (key: string): Promise<void> => {
    const draft = drafts[key]
    if (draft === undefined)
      return
    setSavingId(key)
    const secrets = dirty[key] ?? {}
    const rows = store.machines.machines.map(row => row.id === draft.row.id ? draft.row : row)
    const result = await service.persist({ machines: rows, secrets: { [key]: secrets } })
    setSavingId(null)
    if (!result.ok)
      return
    setDirty((previous) => {
      const next = { ...previous }
      delete next[key]
      return next
    })
    setEditingId(null)
  }

  const submitAdd = async (row: MachineRow): Promise<void> => {
    setAddSaving(true)
    const result = await service.persist({ machines: [...store.machines.machines, row], secrets: {} })
    setAddSaving(false)
    if (!result.ok)
      return
    setAddOpen(false)
  }

  const requestInstall = (id: string, reinstall: boolean): void => {
    if (!reinstall) {
      void service.install({ machineId: id, reinstall: false })
      return
    }
    // 强制重装会打断端口上的实例：先用只读发现预检档案，不符则弹确认框（issue #1600）。
    void service.profileMismatchOf(id).then((mismatch) => {
      if (mismatch !== undefined) {
        setReinstallTarget({ id, actual: mismatch.actual, expected: mismatch.expected })
        return
      }
      void service.install({ machineId: id, reinstall: true })
    }).catch(() => {
      // 预检失败（如远端暂不可达）不阻断重装；host 端三态断言仍是最终护栏。
      void service.install({ machineId: id, reinstall: true })
    })
  }

  const confirmReinstall = (): void => {
    if (reinstallTarget === null)
      return
    const { id } = reinstallTarget
    setReinstallTarget(null)
    void service.install({ machineId: id, reinstall: true, ackProfileMismatch: true })
  }

  const confirmRemove = (): void => {
    if (removeTarget === null)
      return
    const { key, id } = removeTarget
    setRemoveTarget(null)
    void service.remove({ machineId: id }).then((result) => {
      if (!result.ok)
        return
      setDrafts((previous) => {
        const next = { ...previous }
        delete next[key]
        return next
      })
      setDirty((previous) => {
        const next = { ...previous }
        delete next[key]
        return next
      })
      if (editingId === id)
        setEditingId(null)
    })
  }

  const openRemoteWindow = (id: string): void => {
    const url = state.statuses[id]?.tunnelBaseUrl
    if (url === undefined || openingId !== null)
      return
    setOpeningId(id)
    bridge.openWindow(id, url).then(
      () => {
        setBridgeErrors((previous) => {
          if (previous[id] === undefined)
            return previous
          const next = { ...previous }
          delete next[id]
          return next
        })
      },
      (error: unknown) => {
        setBridgeErrors(previous => ({ ...previous, [id]: messageOf(error) }))
      },
    ).finally(() => setOpeningId(null))
  }

  const bridgeOpen = availability === 'desktop'
  const bridgePending = availability === 'unknown'

  if (state.role?.remote === true) {
    return (
      <div className="flex flex-col gap-[12px] max-w-[960px] text-primary" data-testid="remote-session">
        <h2 className="m-0 text-[18px] leading-[28px] font-semibold text-primary">{t('title')}</h2>
        <div className="mt-[4px] flex flex-col items-center gap-[12px] rounded-[12px] border-[0.5px] border-border-l2 bg-layer-1 px-[24px] py-[40px] text-center" data-testid="remote-session-banner">
          <span className="inline-flex h-[44px] w-[44px] items-center justify-center rounded-full bg-[var(--dsw-alias-surface-tinted)] text-success" aria-hidden="true">
            <svg fill="none" height="22" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 24 24" width="22">
              <path d="M4 17l6-6-6-6" />
              <path d="M12 19h8" />
            </svg>
          </span>
          <p className="m-0 text-[22px] leading-[32px] font-semibold text-primary">{t('session.remoteTitle')}</p>
          <p className="m-0 max-w-[460px] text-[13px] leading-[21px] text-secondary">
            {state.role.origin !== undefined && state.role.origin !== ''
              ? t('session.remoteHintNamed').replace('{name}', state.role.origin)
              : t('session.remoteHint')}
          </p>
          <p className="m-0 max-w-[460px] rounded-[8px] bg-[var(--dsw-alias-surface-tinted)] px-[12px] py-[8px] text-[12px] leading-[19px] text-tertiary" data-testid="remote-session-sync-hint">{t('session.remoteSyncHint')}</p>
        </div>
      </div>
    )
  }

  const enableRow = (
    <div className="flex items-center justify-between gap-[24px] rounded-[12px] border-[0.5px] border-border-l2 bg-layer-1 px-[16px] py-[10px]">
      <div className="flex min-w-0 flex-col">
        <span className="text-[14px] leading-[20px] text-primary">{t('hero.title')}</span>
        <span className="mt-[4px] text-[12px] leading-[18px] text-secondary">{t('enable.hint')}</span>
      </div>
      <span className="inline-flex" data-testid="machines-enable-toggle">
        <Switch checked={state.enabled === true} label={t('hero.enable')} disabled={state.enabling} onChange={(next) => { void service.setEnabled(next) }} />
      </span>
    </div>
  )

  if (state.enabled === false) {
    return (
      <div className="flex flex-col gap-[12px] max-w-[960px] text-primary" data-testid="machines-section">
        <h2 className="m-0 text-[18px] leading-[28px] font-semibold text-primary">{t('title')}</h2>
        {enableRow}
        {state.error === null
          ? null
          : (
              <p className="m-0 text-[12px] leading-[18px] text-error" role="alert">
                {t('error.banner')}
                {errorTextOf(state.error, t)}
              </p>
            )}
        <p className="m-0 rounded-[8px] border border-dashed border-border-l3 p-[12px] text-center text-[12px] leading-[18px] text-tertiary" data-testid="machines-disabled">{t('enable.off')}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-[12px] max-w-[960px] text-primary">
      <div className="flex flex-wrap items-start justify-between gap-[12px]">
        <div>
          <h2 className="m-0 text-[18px] leading-[28px] font-semibold text-primary">{t('title')}</h2>
          <p className="m-0 text-[13px] leading-[20px] text-tertiary">{t('intro')}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-[8px]">
          <Button variant="outline" size="sm" disabled={state.status === 'loading'} onClick={() => void service.load()}>
            {t('refresh')}
          </Button>
          <Button variant="primary" size="sm" disabled={state.status === 'loading'} onClick={() => setAddOpen(true)}>
            {t('addMachine')}
          </Button>
        </div>
      </div>
      {enableRow}
      {state.notice !== null ? <p className="m-0 text-[12px] leading-[18px] text-secondary" data-testid="notice">{noticeTextOf(state.notice, t)}</p> : null}
      {state.error !== null
        ? (
            <p className="m-0 text-[12px] leading-[18px] text-error" role="alert">
              {t('error.banner')}
              {errorTextOf(state.error, t)}
            </p>
          )
        : null}
      {state.status === 'loading' ? <p className="m-0 text-[12px] leading-[18px] text-tertiary">{t('loading')}</p> : null}
      {state.status === 'error'
        ? (
            <div className="flex flex-col items-start gap-[8px]">
              <p className="m-0 rounded-[8px] border border-dashed border-border-l3 p-[12px] text-center text-[12px] leading-[18px] text-tertiary">{t('loadFailed')}</p>
              <Button variant="outline" size="sm" onClick={() => void service.load()}>{t('refresh')}</Button>
            </div>
          )
        : null}
      {state.status === 'ready' && state.machines.length === 0 && state.discovered.length === 0
        ? <p className="m-0 rounded-[8px] border border-dashed border-border-l3 p-[12px] text-center text-[12px] leading-[18px] text-tertiary">{t('empty')}</p>
        : null}
      <>
        <ul className="m-0 mt-[12px] flex list-none flex-col overflow-hidden rounded-[12px] border border-border-l2 bg-layer-3 p-0">
          {state.machines.map((row) => {
            const draft = drafts[row.id] ?? { key: row.id, row }
            return (
              <RowShell
                key={row.id}
                id={row.id}
                name={row.name === '' ? row.id : row.name}
                tag={undefined}
                tintColor={colorOf(row)}
                tintBorder={row.tintBorder === true}
                status={state.statuses[row.id]}
                trail={state.trails[row.id] ?? []}
                t={t}
                actions={(
                  <>
                    {state.statuses[row.id]?.tunnelBaseUrl !== undefined
                      ? (
                          <span className="max-w-[240px] truncate font-mono text-[11px] leading-[16px] text-tertiary" data-testid={`tunnel-${row.id}`}>
                            {state.statuses[row.id]?.tunnelBaseUrl}
                          </span>
                        )
                      : null}
                    <RowActions
                      id={row.id}
                      t={t}
                      status={state.statuses[row.id]}
                      busy={state.busy[row.id]}
                      bridgeOpen={bridgeOpen}
                      bridgePending={bridgePending}
                      opening={openingId === row.id}
                      onTest={id => void service.test({ machineId: id })}
                      onConnect={id => void service.connect({ machineId: id })}
                      onDisconnect={id => void service.disconnect({ machineId: id })}
                      onOpen={openRemoteWindow}
                      menuItems={[
                        { key: 'reinstall', label: t('install.reinstall'), icon: ArrowRotateRight, title: t('install.reinstall_hint'), disabled: state.busy[row.id] !== undefined, onSelect: () => requestInstall(row.id, true) },
                        { key: 'edit', label: t('edit'), icon: PersonPencil, disabled: editingId !== null && editingId !== row.id, onSelect: () => editingId === row.id ? closeEditor(row.id) : openEditor(row) },
                        { key: 'remove', label: t('remove'), icon: TrashBin, danger: true, disabled: state.busy[row.id] !== undefined, onSelect: () => setRemoveTarget({ key: row.id, id: row.id, name: row.name === '' ? row.id : row.name }) },
                      ]}
                    />
                  </>
                )}
              >
                {editingId === row.id
                  ? (
                      <EditPanel
                        draft={draft}
                        t={t}
                        hasPassword={row.hasPassword}
                        hasPassphrase={row.hasPassphrase}
                        dirty={dirty[row.id] ?? {}}
                        saving={savingId === row.id}
                        onChange={patchDraft}
                        onSecret={patchDirty}
                        onSave={key => void saveRow(key)}
                        onCancel={closeEditor}
                      />
                    )
                  : null}
                <RowDetails
                  id={row.id}
                  status={state.statuses[row.id]}
                  busy={state.busy[row.id]}
                  logLines={state.logs[row.id] ?? []}
                  bridgeError={bridgeErrors[row.id]}
                  installResult={state.installResults[row.id]}
                  t={t}
                  onInstall={requestInstall}
                />
              </RowShell>
            )
          })}
        </ul>
        {state.discovered.length > 0
          ? (
              <>
                <div className="mt-[12px] flex flex-col gap-[2px]">
                  <h3 className="m-0 text-[12px] leading-[18px] font-medium text-secondary">{t('configHosts')}</h3>
                  <p className="m-0 text-[12px] leading-[18px] text-tertiary">{t('configHostsHint')}</p>
                </div>
                <ul className="m-0 mt-[12px] flex list-none flex-col overflow-hidden rounded-[12px] border border-border-l2 bg-layer-3 p-0">
                  {state.discovered.map(row => (
                    <RowShell
                      key={row.id}
                      id={row.id}
                      name={row.name}
                      tag={t('configTag')}
                      tintColor={undefined}
                      tintBorder={false}
                      status={state.statuses[row.id]}
                      trail={state.trails[row.id] ?? []}
                      t={t}
                      actions={(
                        <RowActions
                          id={row.id}
                          t={t}
                          status={state.statuses[row.id]}
                          busy={state.busy[row.id]}
                          bridgeOpen={bridgeOpen}
                          bridgePending={bridgePending}
                          opening={openingId === row.id}
                          onTest={id => void service.test({ machineId: id })}
                          onConnect={id => void service.connect({ machineId: id })}
                          onDisconnect={id => void service.disconnect({ machineId: id })}
                          onOpen={openRemoteWindow}
                        />
                      )}
                    >
                      <RowDetails
                        id={row.id}
                        status={state.statuses[row.id]}
                        busy={state.busy[row.id]}
                        logLines={state.logs[row.id] ?? []}
                        bridgeError={bridgeErrors[row.id]}
                        installResult={state.installResults[row.id]}
                        t={t}
                        onInstall={requestInstall}
                      />
                    </RowShell>
                  ))}
                </ul>
              </>
            )
          : null}
      </>
      {addOpen
        ? (
            <AddMachineDialog
              t={t}
              saving={addSaving}
              takenIds={new Set(state.machines.map(row => row.id))}
              onSubmit={row => void submitAdd(row)}
              onClose={() => {
                if (!addSaving)
                  setAddOpen(false)
              }}
            />
          )
        : null}
      <Modal
        open={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        title={t('remove.confirm.title')}
        closeLabel={t('remove.confirm.cancel')}
        description={removeTarget === null ? '' : t('remove.confirm.description').replace('{name}', removeTarget.name)}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setRemoveTarget(null)}>{t('remove.confirm.cancel')}</Button>
            <Button variant="primary" className="text-error" onClick={confirmRemove}>{t('remove.confirm.ok')}</Button>
          </>
        )}
      />
      <Modal
        open={reinstallTarget !== null}
        onClose={() => setReinstallTarget(null)}
        title={t('reinstall.profile_mismatch.title')}
        closeLabel={t('reinstall.profile_mismatch.cancel')}
        description={reinstallTarget === null
          ? ''
          : reinstallTarget.actual === undefined
            ? t('reinstall.profile_mismatch.unknown')
            : t('reinstall.profile_mismatch.description')
                .replace('{actual}', reinstallTarget.actual)
                .replace('{expected}', reinstallTarget.expected)}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setReinstallTarget(null)}>{t('reinstall.profile_mismatch.cancel')}</Button>
            <Button variant="primary" className="text-error" onClick={confirmReinstall}>{t('reinstall.profile_mismatch.ok')}</Button>
          </>
        )}
      />
    </div>
  )
}
