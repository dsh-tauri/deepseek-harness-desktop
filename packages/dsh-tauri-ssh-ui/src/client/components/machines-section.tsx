import type { CSSProperties, ReactNode } from 'react'
import type { SshKey } from '../locales/index'
import type { InstallResult, MachineRow, MachinesNotice, MachinesStore, MachineStatus, ProgressPhase, SecretValues } from '../store/index'
import type { MachineLifecycleState, RemoteBridge } from '../types/index'
import { Button, Input, Modal, StateDot } from 'dsh-tauri-ui/client'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { cls } from '../styles/index'
import { errorTextOf } from '../utils/error'
import { retrySecondsOf } from '../utils/retry'

/** New-machine form defaults (ssh-ui 既有默认：SSH 22 / 远端 web 3080)。 */
const DEFAULT_PORT = 22
const DEFAULT_REMOTE_PORT = 3080

/** The StateDot vocabulary the connection states map onto ('idle' is hollow). */
type DotState = 'done' | 'ongoing' | 'error' | 'idle'

/** The identity-color palette (fits the DSH status hue family). */
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

/** One in-edit draft of a manual machine row (keyed by row id). */
interface Draft {
  key: string
  row: MachineRow
}

/** Per-row typed secrets the editor holds (write-only; keyed by row id). */
type DirtySecrets = Record<string, SecretValues>

/** Which secret fields exist (the write-only sidecar keys). */
export type SecretFieldName = 'password' | 'passphrase'

/** Injected dependencies (the app binds the real store/bridge; tests pass fakes). */
export interface MachinesSectionInjected {
  store: MachinesStore
  /** Desktop bridge; absent (or unanswered probe) means pure web. */
  bridge?: RemoteBridge
}

export interface MachinesSectionProps extends MachinesSectionInjected {
  t: (key: SshKey) => string
}

/** The remove-confirm target: which row is about to be deleted. */
interface RemoveTarget {
  key: string
  id: string
  name: string
}

/** The id charset mirrors the host-side MachineId guard. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u

/**
 * Derive the machine id from a host: lowercase alnum-dash slug of the part
 * after the last `@` (so `ops@10.1.1.1` → `10.1.1.1` → `10-1-1-1`); empty
 * when the host has no usable characters.
 */
function slugOf(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^.*@/u, '')
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
}

/** Pick the first free id: the slug itself, else slug-2, slug-3, … */
function freeIdOf(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base))
    return base
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`
    if (!taken.has(candidate))
      return candidate
  }
}

/**
 * The shared machine row shell: identity (state dot + optional color pip +
 * name + host tag), live status text with the step rail, and the trailing
 * action cluster. Manual and discovered rows differ only in their action
 * set and whether an editor can expand below.
 */
function RowShell({ id, name, tag, tintColor, tintBorder, status, trail, actions, t, children }: {
  id: string
  name: string
  /** The muted identity suffix (host for manual rows, the config tag for discovered). */
  tag: string
  tintColor: string | undefined
  tintBorder: boolean
  status: MachineStatus | undefined
  trail: readonly ProgressPhase[]
  actions: ReactNode
  t: (key: SshKey) => string
  children?: ReactNode
}): ReactNode {
  return (
    <li
      className={cls.rowCard}
      data-testid={`machine-${id}`}
      style={tintBorder && tintColor !== undefined ? { borderLeftColor: tintColor } : undefined}
    >
      <div className={cls.rowHead}>
        <span className={cls.rowIdentity}>
          <StateDotOf status={status} />
          {tintColor !== undefined
            ? <span className={cls.colorPip} style={{ background: tintColor }} aria-hidden="true" />
            : null}
          <span className={cls.rowName}>{name}</span>
          <span className={cls.rowTag}>{tag}</span>
          <span className={cls.status} data-testid={`status-${id}`}>{statusTextOf(status, t)}</span>
          <StepRail trail={trail} t={t} />
        </span>
        <span className={cls.rowActions}>{actions}</span>
      </div>
      {children}
    </li>
  )
}

/**
 * The inline editor of one manual machine: connection fields, write-only
 * secrets and the appearance row. Saving applies immediately for this row
 * alone (other rows are untouched); cancel discards the buffer.
 */
function EditPanel({ draft, t, secretSet, dirty, saving, onChange, onSecret, onSave, onCancel }: {
  draft: Draft
  t: (key: SshKey) => string
  secretSet: Record<string, boolean>
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
    <div className={cls.editor} data-testid={`editor-${row.id}`}>
      {/* 12 栅格显式分组：第 1 行 = ID / 名称 / 主机（3+4+5），
          第 2 行 = 端口 / 用户 / 远端端口 / 远端档案（3×4），启动命令独占整行 */}
      <div className={cls.grid}>
        <Field label={t('field.id')} span={3}>
          <Input className={cls.fieldInput} value={row.id} disabled />
        </Field>
        <Field label={t('field.name')} span={4}>
          <Input className={cls.fieldInput} value={row.name} disabled={saving} onChange={event => onChange(draft.key, { name: event.target.value })} />
        </Field>
        <Field label={t('field.host')} span={5}>
          <Input className={cls.fieldInput} value={row.host} disabled={saving} onChange={event => onChange(draft.key, { host: event.target.value })} />
        </Field>
        <Field label={t('field.port')} span={3}>
          <Input className={cls.fieldInput} type="number" value={row.port} disabled={saving} onChange={event => onChange(draft.key, { port: numberOf(event.target.value, DEFAULT_PORT) })} />
        </Field>
        <Field label={t('field.user')} span={3}>
          <Input className={cls.fieldInput} value={row.user} disabled={saving} onChange={event => onChange(draft.key, { user: event.target.value })} />
        </Field>
        <Field label={t('field.remotePort')} span={3}>
          <Input className={cls.fieldInput} type="number" value={row.remotePort} disabled={saving} onChange={event => onChange(draft.key, { remotePort: numberOf(event.target.value, DEFAULT_REMOTE_PORT) })} />
        </Field>
        <Field label={t('field.profileName')} span={3}>
          <Input className={cls.fieldInput} value={row.profileName ?? ''} placeholder="remote" disabled={saving || (row.startCommand ?? '') !== ''} onChange={event => onChange(draft.key, { profileName: event.target.value })} />
        </Field>
        <Field label={t('field.startCommand')} span={12}>
          <Input className={cls.fieldInput} value={row.startCommand ?? ''} disabled={saving} onChange={event => onChange(draft.key, { startCommand: event.target.value })} />
        </Field>
      </div>
      <div className={cls.grid}>
        <SecretField field="password" span={6} label={t('field.password')} keyName={draft.key} secretSet={secretSet} t={t} value={dirty.password ?? ''} onValue={onSecret} />
        <SecretField field="passphrase" span={6} label={t('field.passphrase')} keyName={draft.key} secretSet={secretSet} t={t} value={dirty.passphrase ?? ''} onValue={onSecret} />
      </div>
      <AppearanceEditor row={row} t={t} onChange={onChange} draftKey={draft.key} />
      <div className={cls.editorActions}>
        {invalid ? <p className={cls.hint}>{t('saveHint')}</p> : null}
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

/** The shared trailing action cluster of one row (test/connect/open/disconnect + row-specific extras). */
function RowActions({ id, t, status, busy, bridgeOpen, bridgePending, opening, onTest, onConnect, onDisconnect, onOpen, extras }: {
  id: string
  t: (key: SshKey) => string
  status: MachineStatus | undefined
  busy: 'test' | 'connect' | 'disconnect' | 'install' | undefined
  bridgeOpen: boolean
  bridgePending?: boolean
  opening?: boolean
  onTest: (id: string) => void
  onConnect: (id: string) => void
  onDisconnect: (id: string) => void
  onOpen: (id: string) => void
  extras?: ReactNode
}): ReactNode {
  const connected = status?.state === 'connected'
  const held = status?.state === 'connecting' || status?.state === 'testing' || status?.state === 'reconnecting'
  return (
    <>
      <Button variant="outline" size="sm" disabled={busy !== undefined || held} onClick={() => onTest(id)}>
        {t('test')}
      </Button>
      {connected
        ? (
            <>
              {bridgeOpen
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
                  : null}
              <Button variant="outline" size="sm" disabled={busy !== undefined} onClick={() => onDisconnect(id)}>
                {t('disconnect')}
              </Button>
            </>
          )
        : (
            <Button variant="primary" size="sm" disabled={busy !== undefined || held} onClick={() => onConnect(id)}>
              {t('connect')}
            </Button>
          )}
      {extras}
    </>
  )
}

/** The detail block under a row: install surface, errors, tunnel link, live log. */
function RowDetails({ id, status, busy, logLines, bridgeError, installResult, t, onInstall }: {
  id: string
  status: MachineStatus | undefined
  busy: 'test' | 'connect' | 'disconnect' | 'install' | undefined
  logLines: readonly string[]
  bridgeError: string | undefined
  installResult: InstallResult | undefined
  t: (key: SshKey) => string
  onInstall: (id: string) => void
}): ReactNode {
  return (
    <>
      {status?.dshMissing === true
        ? <InstallPanel status={status} busy={busy} t={t} onInstall={() => onInstall(id)} />
        : null}
      {status?.lastError !== undefined ? <p className={cls.statusError} role="alert">{status.lastError}</p> : null}
      {bridgeError !== undefined
        ? (
            <p className={cls.statusError} role="alert" data-testid={`bridge-error-${id}`}>
              {t('bridge.error')}
              {bridgeError}
            </p>
          )
        : null}
      {status?.tunnelBaseUrl !== undefined ? <p className={cls.link}>{status.tunnelBaseUrl}</p> : null}
      <LogStream id={id} lines={logLines} fallback={status?.progress?.log} />
      {installResult !== undefined
        ? <p className={cls.installNote} data-testid={`install-note-${id}`}>{installNoteOf(installResult, t)}</p>
        : null}
    </>
  )
}

/** The state dot: a primitive StateDot for live states, hollow CSS for idle. */
function StateDotOf({ status }: { status: MachineStatus | undefined }): ReactNode {
  const state = dotStateOf(status)
  if (state === 'idle')
    return <span className={cls.stateDot} data-state="idle" aria-hidden="true" />
  return <StateDot state={state} size={8} />
}

/** The streaming log: the S2 event lines when present, else the progress log. */
function LogStream({ id, lines, fallback }: { id: string, lines: readonly string[], fallback: string | undefined }): ReactNode {
  const output = lines.length > 0
    ? lines.join('\n')
    : (fallback ?? '')
  if (output === '')
    return null
  return (
    <pre className={cls.logStream} data-testid={`machine-log-${id}`}>
      {output}
    </pre>
  )
}

/** The dsh-missing install surface: a one-click install (the log lives in the card stream). */
function InstallPanel({ status, busy, t, onInstall }: {
  status: MachineStatus
  busy: 'test' | 'connect' | 'disconnect' | 'install' | undefined
  t: (key: SshKey) => string
  onInstall: () => void
}): ReactNode {
  const installing = busy === 'install' || status.progress?.phase === 'installing'
  if (installing) {
    return (
      <div className={cls.installBox}>
        <p className={cls.installHint}>{t('progress.installing')}</p>
      </div>
    )
  }
  return (
    <div className={cls.installBox}>
      <p className={cls.installHint}>{t('install.hint')}</p>
      <Button variant="primary" size="sm" disabled={busy !== undefined} onClick={onInstall}>
        {t('install.action')}
      </Button>
    </div>
  )
}

/** One operator-facing line for a finished install. */
function installNoteOf(result: InstallResult, t: (key: SshKey) => string): string {
  if (result.credentialsError !== undefined) {
    return t('install.done.error') + result.credentialsError
  }
  return result.credentialsCopied ? t('install.done.copied') : t('install.done.nokey')
}

/** The grid spans the editor layout uses (12-column track). */
export type FieldSpan = 3 | 4 | 5 | 6 | 8 | 12

/** Span class per grid width (the 12-column editor track). */
const SPAN_CLASS: Record<FieldSpan, string> = {
  3: cls.span3,
  4: cls.span4,
  5: cls.span5,
  6: cls.span6,
  8: cls.span8,
  12: cls.span12,
}

/** One labeled field row. */
function Field({ label, span = 6, children }: { label: string, span?: FieldSpan, children: ReactNode }): ReactNode {
  return (
    <label className={`${cls.field} ${SPAN_CLASS[span]}`}>
      <span className={cls.fieldLabel}>{label}</span>
      {children}
    </label>
  )
}

/**
 * The appearance row of one machine editor: an identity-color swatch set
 * (plus a "default" reset) and the tint-the-border switch, which is only
 * meaningful while a color is chosen. Clearing writes the empty-string
 * (off) form — the save path drops it.
 */
function AppearanceEditor({ row, t, onChange, draftKey }: {
  row: MachineRow
  t: (key: SshKey) => string
  onChange: (key: string, patch: Partial<MachineRow>) => void
  draftKey: string
}): ReactNode {
  const color = colorOf(row)
  return (
    <div className={cls.appearance}>
      <span className={cls.fieldLabel}>{t('field.color')}</span>
      <div className={cls.swatches}>
        {COLOR_CHOICES.map(choice => (
          <button
            key={choice}
            type="button"
            className={cls.swatch}
            data-selected={color === choice}
            style={{ '--swatch-color': choice } as CSSProperties}
            aria-label={`${t('field.color')}: ${choice}`}
            aria-pressed={color === choice}
            onClick={() => onChange(draftKey, { color: color === choice ? '' : choice })}
          />
        ))}
        <button
          type="button"
          className={`${cls.swatch} ${cls.swatchNone}`}
          data-selected={color === undefined}
          aria-label={t('color.none')}
          aria-pressed={color === undefined}
          title={t('color.none')}
          onClick={() => onChange(draftKey, { color: '', tintBorder: false })}
        />
        <span className={cls.switchRow}>
          <button
            type="button"
            role="switch"
            aria-checked={row.tintBorder === true}
            className={cls.switch}
            disabled={color === undefined}
            onClick={() => onChange(draftKey, { tintBorder: row.tintBorder !== true })}
          />
          <span className={cls.fieldLabel}>{t('field.tintBorder')}</span>
        </span>
      </div>
    </div>
  )
}

/** One write-only secret input; the placeholder reports whether a value is stored. */
export function SecretField({ field, label, keyName, secretSet, t, value, onValue, span = 6 }: {
  field: SecretFieldName
  label: string
  keyName: string
  secretSet: Record<string, boolean>
  t: (key: SshKey) => string
  value: string
  onValue: (key: string, field: SecretFieldName, value: string) => void
  span?: FieldSpan
}): ReactNode {
  const placeholder = secretSet[`${keyName}.${field}`] ? t('secret.set') : t('secret.unset')
  return (
    <label className={`${cls.field} ${SPAN_CLASS[span]}`}>
      <span className={cls.fieldLabel}>{label}</span>
      <Input
        className={cls.fieldInput}
        type="password"
        value={value}
        placeholder={placeholder}
        onChange={event => onValue(keyName, field, event.target.value)}
      />
    </label>
  )
}

/** The write-only secret presence flags of one draft row, keyed like the stored sidecar. */
function secretFlagsOf(row: MachineRow): Record<string, boolean> {
  return {
    [`${row.id}.password`]: row.hasPassword,
    [`${row.id}.passphrase`]: row.hasPassphrase,
  }
}

/** The row's effective identity color ('' and undefined both mean none). */
function colorOf(row: MachineRow): string | undefined {
  return row.color === undefined || row.color === '' ? undefined : row.color
}

/** Short step labels of each pipeline phase (the long progress.* text stays in the status line). */
const STEP_KEY_OF: Record<ProgressPhase, SshKey> = {
  handshake: 'step.handshake',
  installing: 'step.installing',
  starting: 'step.starting',
  probing: 'step.probing',
  syncing: 'step.syncing',
}

/** The step rail: the phases one operation actually walked, latest current. */
function StepRail({ trail, t }: { trail: readonly ProgressPhase[], t: (key: SshKey) => string }): ReactNode {
  if (trail.length === 0)
    return null
  const current = trail[trail.length - 1]
  return (
    <ol className={cls.stepRail} data-testid="step-rail">
      {trail.map(phase => (
        <li
          key={phase}
          className={phase === current ? cls.stepCurrent : cls.stepDone}
        >
          {t(STEP_KEY_OF[phase])}
        </li>
      ))}
    </ol>
  )
}

/** The connection-state dot vocabulary (StateDot states; idle renders hollow). */
function dotStateOf(status: MachineStatus | undefined): DotState {
  if (status?.state === 'connected')
    return 'done'
  if (status?.state === 'connecting' || status?.state === 'testing' || status?.state === 'reconnecting')
    return 'ongoing'
  if (status?.state === 'given-up')
    return 'error'
  return 'idle'
}

/** The status-label key of each lifecycle state (the hyphenated state maps to camelCase keys). */
const STATUS_KEY_OF: Record<MachineLifecycleState, SshKey> = {
  'disconnected': 'status.disconnected',
  'testing': 'status.testing',
  'connecting': 'status.connecting',
  'connected': 'status.connected',
  'reconnecting': 'status.reconnecting',
  'given-up': 'status.givenUp',
}

/** The status line: live progress text while an operation is in flight, else the state label. */
function statusTextOf(status: MachineStatus | undefined, t: (key: SshKey) => string): string {
  const progress = status?.progress
  if (progress?.phase === 'handshake')
    return t('progress.handshake')
  if (progress?.phase === 'starting')
    return t('progress.starting')
  if (progress?.phase === 'installing')
    return t('progress.installing')
  if (progress?.phase === 'probing') {
    return t('progress.probing')
      .replace('{attempt}', String(progress.attempt ?? '?'))
      .replace('{total}', String(progress.total ?? '?'))
  }
  if (progress?.phase === 'syncing') {
    return t('progress.syncing')
      .replace('{attempt}', String(progress.attempt ?? '?'))
      .replace('{total}', String(progress.total ?? '?'))
  }
  const base = status === undefined
    ? t('status.disconnected')
    : t(STATUS_KEY_OF[status.state])
  if (status?.state === 'reconnecting' && status.nextRetryAt !== undefined) {
    return base + t('status.nextRetry').replace('{hint}', retryHintOf(status.nextRetryAt, Date.now(), t))
  }
  return base
}

/**
 * The relative-time hint for a scheduled retry: "now" once the instant is
 * due, else "in Xs". The clock is read per render; the polling loop keeps
 * reconnecting machines re-rendering, so the hint stays current.
 */
function retryHintOf(nextRetryAt: number, nowMs: number, t: (key: SshKey) => string): string {
  const seconds = retrySecondsOf(nextRetryAt, nowMs)
  return seconds <= 0 ? t('retry.now') : t('retry.inSeconds').replace('{seconds}', String(seconds))
}

/** Parse a number input; non-numbers fall back to the default. */
function numberOf(raw: string, fallback: number): number {
  const parsed = Number(raw)
  return raw !== '' && Number.isFinite(parsed) ? parsed : fallback
}

/** One operator-facing description of a bridge failure. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Render one notice: host words verbatim, store literals through the locale table. */
function noticeTextOf(notice: MachinesNotice, t: (key: SshKey) => string): string {
  if (notice.kind === 'text')
    return notice.text
  let text = t(notice.key)
  for (const [name, value] of Object.entries(notice.params ?? {}))
    text = text.replace(`{${name}}`, value)
  return text
}

/**
 * The add-machine dialog: one focused form, saved immediately on submit
 * (the parent appends the row to the store). The id auto-derives from the
 * host until the operator touches the field. Remount per open (the parent
 * keys it by the open flag) so every open starts from a clean form.
 */
function AddMachineDialog({ t, saving, takenIds, onSubmit, onClose }: {
  t: (key: SshKey) => string
  saving: boolean
  /** Ids the new machine must not collide with. */
  takenIds: ReadonlySet<string>
  onSubmit: (row: MachineRow) => void
  onClose: () => void
}): ReactNode {
  const [host, setHost] = useState('')
  const [name, setName] = useState('')
  const [id, setId] = useState('')
  const [idTouched, setIdTouched] = useState(false)
  const [port, setPort] = useState(String(DEFAULT_PORT))
  const [user, setUser] = useState('')
  const [remotePort, setRemotePort] = useState(String(DEFAULT_REMOTE_PORT))
  const [profileName, setProfileName] = useState('')

  const slug = slugOf(host)
  const effectiveId = idTouched ? id.trim() : (slug === '' ? '' : freeIdOf(slug, takenIds))
  const trimmedHost = host.trim()
  const errorKey: SshKey | null
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
      port: numberOf(port, DEFAULT_PORT),
      user: user.trim(),
      hasPassword: false,
      hasPassphrase: false,
      remotePort: numberOf(remotePort, DEFAULT_REMOTE_PORT),
      ...(profileName.trim() === '' ? {} : { profileName: profileName.trim() }),
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
      {/* 新增表单同样按 12 栅格成组：主机 + 端口一行（8+4），
          名称 / ID / 用户一行（4×3），远端端口 + 远端档案一行（6+6） */}
      <div className={cls.grid}>
        <Field label={t('field.host')} span={8}>
          <Input
            className={cls.fieldInput}
            value={host}
            autoFocus
            disabled={saving}
            onChange={event => setHost(event.target.value)}
          />
        </Field>
        <Field label={t('field.port')} span={4}>
          <Input className={cls.fieldInput} value={port} disabled={saving} onChange={event => setPort(event.target.value)} />
        </Field>
        <Field label={t('field.name')} span={4}>
          <Input className={cls.fieldInput} value={name} disabled={saving} onChange={event => setName(event.target.value)} />
        </Field>
        <Field label={t('field.id')} span={4}>
          <Input
            className={cls.fieldInput}
            value={idTouched ? id : effectiveId}
            placeholder={t('add.id_auto')}
            disabled={saving}
            onChange={(event) => {
              setIdTouched(true)
              setId(event.target.value)
            }}
          />
        </Field>
        <Field label={t('field.user')} span={4}>
          <Input className={cls.fieldInput} value={user} disabled={saving} onChange={event => setUser(event.target.value)} />
        </Field>
        <Field label={t('field.remotePort')} span={6}>
          <Input className={cls.fieldInput} value={remotePort} disabled={saving} onChange={event => setRemotePort(event.target.value)} />
        </Field>
        <Field label={t('field.profileName')} span={6}>
          <Input className={cls.fieldInput} value={profileName} placeholder="remote" disabled={saving} onChange={event => setProfileName(event.target.value)} />
        </Field>
      </div>
      {errorKey === null
        ? <p className={cls.hint}>{t('add.id_auto')}</p>
        : <p className={cls.error} role="alert">{errorKey === null ? '' : t(errorKey)}</p>}
    </Modal>
  )
}

/**
 * Render the SSH-machines settings page.
 *
 * Rows are display-first: identity + live status + actions. Editing a manual
 * machine expands an inline editor whose save applies to that row alone and
 * immediately (no page-level staging); add is a focused modal; remove is
 * confirmed then applied at once.
 * @returns the page element tree.
 */
export function MachinesSection({ t, store, bridge }: MachinesSectionProps): ReactNode {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [dirty, setDirty] = useState<DirtySecrets>({})
  /** The one row whose inline editor is open (null = all collapsed). */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [addSaving, setAddSaving] = useState(false)
  const [initialized, setInitialized] = useState(false)
  const [availability, setAvailability] = useState<'desktop' | 'web' | 'unknown'>(() => bridge?.probe === undefined ? 'web' : 'unknown')
  const [bridgeErrors, setBridgeErrors] = useState<Record<string, string>>({})
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null)

  useEffect(() => {
    void store.load()
  }, [store])

  // Probe the desktop bridge once: an answer means the popup affordance
  // exists; a timeout or rejection means pure web, where it never shows.
  // (No bridge at all settled synchronously in the initial state.)
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

  // While any machine has an operation in flight, poll the host every 1.5 s
  // so the live progress (handshake / starting / probing) and the event log
  // stay current.
  const anyInFlight = Object.keys(state.busy).length > 0
    || Object.values(state.statuses).some(status =>
      status.state === 'connecting' || status.state === 'reconnecting' || status.state === 'testing')
  useEffect(() => {
    if (!anyInFlight)
      return
    const timer = setInterval(() => void store.poll(), 1500)
    return () => clearInterval(timer)
  }, [anyInFlight, store])

  // Initialize the draft buffer once the first load lands; the buffer only
  // exists while a row editor is open (opened editors re-seed from the row).
  useEffect(() => {
    if (initialized || state.status !== 'ready')
      return
    // eslint-disable-next-line react/set-state-in-effect -- load-once hydration: the draft buffer cannot exist before the first machine.list lands
    setInitialized(true)
    // eslint-disable-next-line react/set-state-in-effect -- same hydrate-once guard as setInitialized above
    setDrafts(Object.fromEntries(state.machines.map(row => [row.id, { key: row.id, row: { ...row } }])))
  }, [initialized, state.status, state.machines])

  const patchDraft = (key: string, patch: Partial<MachineRow>): void => {
    setDrafts(previous => ({
      ...previous,
      [key]: { key, row: { ...previous[key]!.row, ...patch } },
    }))
  }

  const patchDirty = (key: string, field: SecretFieldName, value: string): void => {
    setDirty(previous => ({ ...previous, [key]: { ...previous[key], [field]: value } }))
  }

  /** Open a row's editor, re-seeding its buffer from the latest saved row. */
  const openEditor = (row: MachineRow): void => {
    setDrafts(previous => ({ ...previous, [row.id]: { key: row.id, row: { ...row } } }))
    setEditingId(row.id)
  }

  /** Discard a row's buffer and collapse its editor. */
  const closeEditor = (key: string): void => {
    const saved = state.machines.find(row => row.id === key)
    if (saved !== undefined)
      setDrafts(previous => ({ ...previous, [key]: { key, row: { ...saved } } }))
    setDirty((previous) => {
      const next = { ...previous }
      delete next[key]
      return next
    })
    setEditingId(null)
  }

  /** Save one row: persist the stored set with this row's buffer substituted. */
  const saveRow = async (key: string): Promise<void> => {
    const draft = drafts[key]
    if (draft === undefined)
      return
    setSavingId(key)
    const secrets = dirty[key] ?? {}
    const rows = store.getSnapshot().machines.map(row => row.id === draft.row.id ? draft.row : row)
    const ok = await store.persist(rows, { [key]: secrets })
    setSavingId(null)
    if (!ok)
      return
    setDirty((previous) => {
      const next = { ...previous }
      delete next[key]
      return next
    })
    setEditingId(null)
  }

  /**
   * Add = create-and-save now: persist the saved set plus the new row.
   */
  const submitAdd = async (row: MachineRow): Promise<void> => {
    setAddSaving(true)
    const ok = await store.persist([...store.getSnapshot().machines, row], {})
    setAddSaving(false)
    if (!ok)
      return
    setDrafts(previous => ({ ...previous, [row.id]: { key: row.id, row: { ...row } } }))
    setAddOpen(false)
  }

  const confirmRemove = (): void => {
    if (removeTarget === null)
      return
    const { key, id } = removeTarget
    setRemoveTarget(null)
    // 删除立即生效：确认即调 machine.remove，成功后摘掉草稿与脏密钥
    void store.remove(id).then((ok) => {
      if (!ok)
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

  /**
   * Ask the desktop shell for the remote window; failures surface per machine.
   *  While the call is in flight the Open button shows an opening label.
   */
  const openRemoteWindow = (id: string): void => {
    const url = state.statuses[id]?.tunnelBaseUrl
    if (url === undefined || bridge === undefined || openingId !== null)
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
  // 桌面桥探测未落定前给「新窗口打开」留禁用占位：落定后桌面端原位点亮、
  // 纯 Web 端移除，避免按钮闪现造成布局跳动。
  const bridgePending = availability === 'unknown'

  // 远端会话：本实例自己就是 SSH 目标，机器管理在发起端——整页只剩告示卡
  // （列表/添加/刷新全部让位），并点明回发起端用「同步到远端…」搬插件与 Skill。
  if (state.role?.remote === true) {
    return (
      <div className={cls.section} data-testid="remote-session">
        <h2 className={cls.title}>{t('title')}</h2>
        <div className={cls.remoteCard} data-testid="remote-session-banner">
          <span className={cls.remoteIcon} aria-hidden="true">
            <svg fill="none" height="22" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 24 24" width="22">
              <path d="M4 17l6-6-6-6" />
              <path d="M12 19h8" />
            </svg>
          </span>
          <p className={cls.remoteTitle}>{t('session.remoteTitle')}</p>
          <p className={cls.remoteHint}>
            {state.role.origin !== undefined && state.role.origin !== ''
              ? t('session.remoteHintNamed').replace('{name}', state.role.origin)
              : t('session.remoteHint')}
          </p>
          <p className={cls.remoteNote} data-testid="remote-session-sync-hint">{t('session.remoteSyncHint')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className={cls.section}>
      <div className={cls.sectionHead}>
        <div>
          <h2 className={cls.title}>{t('title')}</h2>
          <p className={cls.intro}>{t('intro')}</p>
        </div>
        <div className={cls.chrome}>
          <Button variant="outline" size="sm" disabled={state.status === 'loading'} onClick={() => void store.load()}>
            {t('refresh')}
          </Button>
          <Button variant="primary" size="sm" disabled={state.status === 'loading'} onClick={() => setAddOpen(true)}>
            {t('addMachine')}
          </Button>
        </div>
      </div>
      {state.notice !== null ? <p className={cls.notice} data-testid="notice">{noticeTextOf(state.notice, t)}</p> : null}
      {state.error !== null
        ? (
            <p className={cls.error} role="alert">
              {t('error.banner')}
              {errorTextOf(state.error, t)}
            </p>
          )
        : null}
      {state.status === 'loading' ? <p className={cls.hint}>{t('loading')}</p> : null}
      {state.status === 'error'
        ? (
            <div className={cls.emptyBlock}>
              <p className={cls.empty}>{t('loadFailed')}</p>
              <Button variant="outline" size="sm" onClick={() => void store.load()}>{t('refresh')}</Button>
            </div>
          )
        : null}
      {state.status === 'ready' && state.machines.length === 0 && state.discovered.length === 0
        ? <p className={cls.empty}>{t('empty')}</p>
        : null}
      <>
        <ul className={cls.rows}>
          {state.machines.map((row) => {
            const draft = drafts[row.id] ?? { key: row.id, row }
            return (
              <RowShell
                key={row.id}
                id={row.id}
                name={row.name === '' ? row.id : row.name}
                tag={row.host}
                tintColor={colorOf(row)}
                tintBorder={row.tintBorder === true}
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
                    onTest={id => void store.test(id)}
                    onConnect={id => void store.connect(id)}
                    onDisconnect={id => void store.disconnect(id)}
                    onOpen={openRemoteWindow}
                    extras={(
                      <>
                        <Button variant="outline" size="sm" disabled={editingId !== null && editingId !== row.id} onClick={() => editingId === row.id ? closeEditor(row.id) : openEditor(row)}>
                          {t('edit')}
                        </Button>
                        <Button variant="ghost" size="sm" className={cls.dangerAction} disabled={state.busy[row.id] !== undefined} onClick={() => setRemoveTarget({ key: row.id, id: row.id, name: row.name === '' ? row.id : row.name })}>
                          {t('remove')}
                        </Button>
                      </>
                    )}
                  />
                )}
              >
                {editingId === row.id
                  ? (
                      <EditPanel
                        draft={draft}
                        t={t}
                        secretSet={secretFlagsOf(row)}
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
                  onInstall={id => void store.install(id)}
                />
              </RowShell>
            )
          })}
        </ul>
        {state.discovered.length > 0
          ? (
              <>
                <div className={cls.group}>
                  <h3 className={cls.groupTitle}>{t('configHosts')}</h3>
                  <p className={cls.groupHint}>{t('configHostsHint')}</p>
                </div>
                <ul className={cls.rows}>
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
                          onTest={id => void store.test(id)}
                          onConnect={id => void store.connect(id)}
                          onDisconnect={id => void store.disconnect(id)}
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
                        onInstall={id => void store.install(id)}
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
            <Button variant="primary" className={cls.dangerAction} onClick={confirmRemove}>{t('remove.confirm.ok')}</Button>
          </>
        )}
      />
    </div>
  )
}
