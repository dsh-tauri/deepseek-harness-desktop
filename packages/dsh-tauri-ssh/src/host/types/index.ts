/**
 * Public type vocabulary of the SSH remote-machine plugin: the `MachineId`
 * brand, the stored machine profile, its redacted view, connection status,
 * the tunnel link, the typed failure vocabulary, and the structural host
 * services the plugin consumes (the DSH packages providing them are private
 * to the harness, so the plugin declares just the surface it touches).
 * @module dsh-tauri-ssh/host/types
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** Identifies one SSH machine profile. A generated uuid, never the host name: hosts are not unique. */
export type MachineId = string & { readonly __machineId: unique symbol }

/**
 * Brand a string as a {@link MachineId}.
 * @param id - the raw machine id string.
 * @returns the same string, branded (a compile-time cast — no runtime cost).
 */
// eslint-disable-next-line ts/no-redeclare -- 品牌类型惯用法：值与类型同名
export function MachineId(id: string): MachineId {
  return id as MachineId
}

/**
 * One stored SSH machine profile: the state document's machine value shape.
 * Credentials are deliberately sparse: authentication runs on the host's own
 * `~/.ssh` (config aliases, `IdentityFile`s, default keys), so only the
 * optional fallback secrets live here — they never ride a redacted wire
 * surface, only the plugin's in-process value.
 */
export interface MachineProfile {
  /** Stable profile id (generated uuid). */
  id: MachineId
  /** Display name (duplicates allowed). */
  name: string
  /** SSH server host name, IP literal, or a `~/.ssh/config` `Host` alias. */
  host: string
  /** SSH server TCP port; a config `Port` override wins when present. */
  port: number
  /** Login user name; empty means "resolve from config or the OS user". */
  user: string
  /** Password credential; secret. Optional fallback when no key works. */
  password?: string
  /** Passphrase unlocking the `~/.ssh` identity files; secret. Optional. */
  passphrase?: string
  /** TCP port the remote `dsh web` instance listens on (loopback). */
  remotePort: number
  /**
   * Remote dsh profile name (`dsh --profile <name> web`); defaults to
   * `remote`. Ignored when the machine carries its own `startCommand`.
   */
  profileName?: string
  /** Command that starts the remote instance; defaults to `dsh web --host 127.0.0.1 --port <remotePort>`. */
  startCommand?: string
  /** Optional identity color (any CSS color) shown as the machine's pip in the UI. */
  color?: string
  /** Whether the identity color also tints the machine card's border in the UI. */
  tintBorder?: boolean
}

/**
 * Redacted view of one machine profile: secrets replaced by presence flags.
 * This is the only profile shape that may cross a wire surface.
 */
export interface MachineView {
  id: MachineId
  name: string
  host: string
  port: number
  user: string
  /** Whether the profile currently holds a password (the value itself never rides). */
  hasPassword: boolean
  /** Whether the profile currently holds a key passphrase (the value itself never rides). */
  hasPassphrase: boolean
  remotePort: number
  profileName?: string
  startCommand?: string
  color?: string
  tintBorder?: boolean
}

/** One machine row as the settings page writes it: config fields only, no secrets. */
export interface MachineSaveRow {
  name: string
  host: string
  port: number
  user: string
  remotePort: number
  profileName?: string
  startCommand?: string
  color?: string
  tintBorder?: boolean
}

/** Secret values the settings page writes (write-only direction; absent = keep stored). */
export interface MachineSecretWrite {
  password?: string
  passphrase?: string
}

/**
 * Live connection state of one machine — the C-STATE vocabulary consumed by
 * the status dot (S4) and the switcher (S5).
 *
 * - `disconnected` — not connected (never tried, or a deliberate disconnect);
 * - `testing` — a one-shot `machine.test` probe is in flight;
 * - `connecting` — a user-initiated connect is in flight;
 * - `connected` — the tunnel link is live;
 * - `reconnecting` — an established connection dropped and the automatic
 *   retry loop owns the machine (a scheduled retry is announced through
 *   {@link SshMachineStatus.nextRetryAt});
 * - `given-up` — terminal failure state: either the first connect never
 *   succeeded or the reconnect budget ran out. `lastError` carries the
 *   reason; the same word is used for both sources on purpose (switchers
 *   need not distinguish them). A fresh `connect` attempt exits it.
 */
export type SshConnectionState
  = | 'disconnected'
    | 'testing'
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'given-up'

/** Which credential the transport last authenticated with. */
export type SshAuthMethod = 'agent' | 'key' | 'password'

/** One progress phase of a connection-plane operation, shown live in the UI. */
export type SshProgressPhase = 'handshake' | 'starting' | 'probing' | 'installing' | 'syncing'

/** Structured progress of an in-flight connection-plane operation. */
export interface SshProgress {
  phase: SshProgressPhase
  /** Progress position (health-probe attempt, or the sync item's 1-based index). */
  attempt?: number
  /** Progress total (health-probe attempt budget, or the sync item count). */
  total?: number
  /** Display label of the work in flight (the sync item's name). */
  item?: string
  /** Recent streaming output of the operation (the install log), newest last. */
  log?: string
}

/** Transport-level status of one machine. */
export interface SshMachineStatus {
  machineId: MachineId
  state: SshConnectionState
  /** Local loopback URL of the SSH tunnel to the remote instance; present while connected. */
  tunnelBaseUrl?: string
  /** Operator-facing failure description of the last failed transition; absent while healthy. */
  lastError?: string
  /** Whether the last failure was "dsh not installed on the remote" (offers install). */
  dshMissing?: boolean
  /** Live progress of the in-flight operation; absent while idle. */
  progress?: SshProgress
  /** Epoch milliseconds of the next scheduled reconnect retry; present while `reconnecting` waits. */
  nextRetryAt?: number
  /** Which credential the live (or last successful) connection authenticated with. */
  authMethod?: SshAuthMethod
}

/** A live machine link: the id and the tunnel base URL. */
export interface SshLink {
  machineId: MachineId
  /** `http://127.0.0.1:<localPort>` — loopback only, never exposed to remote clients. */
  tunnelBaseUrl: string
}

/** Outcome of a one-shot connection test. */
export type SshTestResult
  = | { ok: true, banner: string }
    | { ok: false, message: string }

/**
 * One stage of the machine event channel: S2's bootstrap pipeline stages
 * plus S3's connection-lifecycle stages (`auth`/`reconnect`, declared by
 * {@link SSH_CONNECTION_EVENT_STAGES} on the same channel).
 */
export type SshMachineStage
  = | 'probe'
    | 'download'
    | 'verify'
    | 'install'
    | 'launch'
    | 'ready'
    | 'failed'
    | 'auth'
    | 'reconnect'

/** Terminal verdict of a machine event, when it settles an operation. */
export type SshMachineTerminal = 'success' | 'failed'

/**
 * One machine-scoped event of the `/api-ssh` `machine.events` channel: a
 * displayable log line tagged with its pipeline stage. `seq` is per-machine
 * and monotonically increasing; consumers poll with the last seen seq.
 */
export interface SshMachineEvent {
  /** Per-machine sequence number, starting at 1. */
  seq: number
  /** Wall-clock timestamp of the event (ISO-8601). */
  ts: string
  /** The machine the event is about. */
  machineId: MachineId
  /** The pipeline stage the line belongs to. */
  stage: SshMachineStage
  /** The displayable log line. */
  line: string
  /** Terminal verdict, present only on the settling event of an operation. */
  terminal?: SshMachineTerminal
  /** Failure reason, present on `terminal: 'failed'` events. */
  reason?: string
}

/** The `machine.events` response: the drained slice plus the poll cursor. */
export interface SshMachineEventsPage {
  events: SshMachineEvent[]
  /** The next event's seq; poll again with `sinceSeq = nextSeq - 1`. */
  nextSeq: number
}

/** Outcome of a one-shot remote dsh install. */
export interface SshInstallResult {
  /** Components freshly installed this run (a subset of node/dsh/pnpm). */
  installed: string[]
  /** The pinned DSH release actually installed (`<tag>` or `npm:<version>`). */
  dshRef: string
  /** The resolved DSH semver. */
  dshVersion: string
  /** Absolute path of the installed `dsh` entry as the remote sees it. */
  dshPath: string
  /** Whether the local DEEPSEEK_API_KEY was copied to the remote `~/.dsh/.env`. */
  credentialsCopied: boolean
  /** Operator-facing description when the credentials copy itself failed. */
  credentialsError?: string
}

/** Closed failure vocabulary of the ssh primitives. */
export type SshErrorCode
  = | 'machine-not-found'
    | 'machine-connect-failed'
    | 'machine-bootstrap-failed'
    | 'machine-dsh-missing'
    | 'machine-install-failed'
    | 'machine-ssh-error'
    | 'machine-reconnecting'
    | 'machine-sync-failed'

/**
 * Connection-lifecycle stages this plugin feeds into the machine-level event
 * channel (C-EVENT). The channel itself — `/api-ssh` `machine.events` — is
 * owned by S2; this constant declares S3's augmentation of
 * {@link SshMachineStage}, and the `satisfies` clause keeps it checked
 * against the merged union (adding a stage here requires it on the union).
 */
export const SSH_CONNECTION_EVENT_STAGES = ['auth', 'reconnect'] as const satisfies readonly SshMachineStage[]

/** One connection-lifecycle stage of the machine event channel (S3's slice). */
export type SshConnectionEventStage = typeof SSH_CONNECTION_EVENT_STAGES[number]

/** Label of one local user-level skill root the sync scans. */
export type SyncSkillRoot = 'dsh' | 'agents'

/** One plugin sync candidate: a dependency of the local dsh profile. */
export interface SyncPluginItem {
  /** Package name as the profile's package.json spells it. */
  name: string
  /** The dependency spec to install on the remote (e.g. `github:org/repo`, `^1.2.0`). */
  spec: string
  /** Whether the spec can be installed on a remote at all. */
  syncable: boolean
  /** Operator-facing reason a non-syncable spec is excluded. */
  reason?: string
}

/** One skill sync candidate: a SKILL.md directory under a user-level root. */
export interface SyncSkillItem {
  name: string
  /** The local root the skill was found under. */
  root: SyncSkillRoot
}

/** The `sync.preview` value: what the panel offers for selection. */
export interface SyncPreview {
  plugins: SyncPluginItem[]
  skills: SyncSkillItem[]
}

/** One plugin the panel asked to sync, as `sync.apply` receives it. */
export interface SyncPluginRef {
  name: string
  spec: string
}

/** One skill the panel asked to sync, as `sync.apply` receives it. */
export interface SyncSkillRef {
  name: string
  root: SyncSkillRoot
}

/** Outcome of exactly one synced item — the per-item failure surface. */
export interface SyncItemResult {
  kind: 'plugin' | 'skill'
  /** Display identity, matching the ref the panel sent. */
  name: string
  /** Skill root; plugins carry none. */
  root?: SyncSkillRoot
  ok: boolean
  /**
   * Operator-facing failure description; absent on success. It leads with the
   * cause line(s) and keeps the tail as context — a long install log buries
   * the real error well above the end.
   */
  error?: string
  /**
   * The command's own output (trimmed, newest kept) for on-demand display;
   * absent on success and when the command printed nothing.
   */
  log?: string
}

/** The `sync.apply` value: every requested item, success and failure alike. */
export interface SyncApplyResult {
  items: SyncItemResult[]
}

/** Typed failure thrown by ssh primitives so consumers map business codes without string matching. */
export class SshError extends Error {
  /**
   * @param code - closed business code of the failure.
   * @param machineId - the machine the failure is about.
   * @param message - operator-facing description.
   */
  constructor(readonly code: SshErrorCode, readonly machineId: MachineId, message: string) {
    super(message)
    this.name = 'SshError'
  }
}

/** The webserver route shape this plugin registers (a subset of the harness's WebRoute). */
export interface HostWebRoute {
  kind: 'exact' | 'prefix'
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Owns the full response lifecycle (may hold the response open, e.g. SSE). */
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** The webserver service surface this plugin needs. */
export interface HostWebServer {
  register: (route: HostWebRoute) => () => void
}

/**
 * The host context this plugin's apply receives: the webserver (route mount)
 * plus the teardown-effect seat. Structural — the harness's real context
 * duck-types onto it.
 */
export interface SshHostContext {
  webServer: HostWebServer
  /** Register a teardown effect (narrow cordis surface). */
  effect: (execute: () => () => void, label?: string) => unknown
}
