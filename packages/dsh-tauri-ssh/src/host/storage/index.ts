/**
 * Plugin config and the plugin-owned machine state document. 0.1.7 removed
 * `ctx.settings.register` (namespaces are now plugin Config entries), so the
 * machine table and the enable flag live in one JSON document under the
 * harness home — the same shape of self-owned persistence the TOFU host-key
 * store already uses, and therefore kernel-version agnostic.
 * @module dsh-tauri-ssh/host/storage
 */

import type { MachineId, MachineProfile } from '../types/index'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'pathe'
import z from 'schemastery'
import { MachineId as brandMachineId } from '../types/index'

/** Default TCP port of the remote `dsh web` instance (loopback). */
export const DEFAULT_REMOTE_PORT = 3080

/** Default SSH transport port. */
export const DEFAULT_SSH_PORT = 22

/** Default remote dsh profile name (`dsh --profile <name> web`). */
export const DEFAULT_REMOTE_PROFILE = 'remote'

/** Schema version of the state document. */
export const STATE_VERSION = 1

/** The persisted plugin state: the feature switch plus the manual machine dict. */
export interface SshState {
  enabled: boolean
  machines: Record<string, MachineProfile>
}

/**
 * Validated plugin config. Timeouts are deployment-varying choices, never
 * hardcoded tunables.
 */
export interface Config {
  /** SSH handshake/authentication deadline in milliseconds. */
  connectTimeoutMs: number
  /** Per-probe deadline of the remote-instance health check in milliseconds. */
  healthCheckTimeoutMs: number
  /** Pause between health-check probes while waiting for the instance. */
  healthPollIntervalMs: number
  /** How many probes run before the bootstrap attempt is declared failed. */
  healthPollAttempts: number
  /** Override for the TOFU known-hosts file (defaults under the harness home). */
  knownHostsPath?: string
  /** Override for the machine state document (defaults under the harness home). */
  statePath?: string
  /** Override for the `~/.ssh` directory the credentials resolve against. */
  sshDir?: string
  /** Default remote `dsh web` port for machines that do not override it. */
  remotePort?: number
  /**
   * Default remote-instance start command for machines without their own
   * override; `{port}` is replaced with the machine's remote port. Covers
   * the discovered `~/.ssh/config` aliases, which cannot carry per-machine
   * overrides.
   */
  startCommand?: string
  /**
   * The DSH install-source repository anchor. Defaults to the official DSH
   * repository (org verified: `deepseek-ai`); the binary install resolves its
   * download repository from it — the official anchor maps onto the official
   * packaging repository (`dsh-tauri-desk/deepseek-harness-pkg`), and any
   * other configured `owner/name` or GitHub URL is used directly as the
   * release repository, so forks/mirrors of the packaging repo keep working.
   */
  installRepo?: string
  /**
   * DSH version pin for the binary install: a semver (`0.1.5-rc.3`) or a full
   * release tag (`dsh-0.1.5-rc.3-35833820356`). Defaults to the recommended
   * version; unresolvable pins fall back to the latest stable release.
   */
  installRef?: string
  /** Deadline for one remote binary install (download + verify + extract + pnpm assembly). */
  installTimeoutMs?: number
  /** ssh2 keepalive interval in milliseconds — the connection watchdog's heartbeat. */
  keepaliveIntervalMs: number
  /** How many unanswered keepalives declare the connection dead (the watchdog threshold). */
  keepaliveCountMax: number
  /** Delay before the first reconnect retry, in milliseconds. */
  reconnectInitialDelayMs: number
  /** Ceiling of the exponential reconnect backoff, in milliseconds. */
  reconnectMaxDelayMs: number
  /**
   * Give-up threshold: how many reconnect retries run (after the initial
   * attempt) before the machine lands in the `given-up` terminal state.
   */
  reconnectMaxAttempts: number
}

/** Plugin config schema; schemastery fills defaults before construction. */
export const ConfigSchema: z<Config> = z.object({
  connectTimeoutMs: z.number().default(15_000),
  healthCheckTimeoutMs: z.number().default(3_000),
  healthPollIntervalMs: z.number().default(1_000),
  healthPollAttempts: z.number().default(30),
  knownHostsPath: z.string(),
  statePath: z.string(),
  sshDir: z.string(),
  remotePort: z.number().default(DEFAULT_REMOTE_PORT),
  startCommand: z.string(),
  installRepo: z.string(),
  installRef: z.string(),
  installTimeoutMs: z.number().default(1_800_000),
  keepaliveIntervalMs: z.number().default(10_000),
  keepaliveCountMax: z.number().default(3),
  reconnectInitialDelayMs: z.number().default(1_000),
  reconnectMaxDelayMs: z.number().default(20_000),
  reconnectMaxAttempts: z.number().default(6),
})

/** Project one stored record; malformed rows are dropped, never fatal. */
export function machineProfileOf(raw: unknown): MachineProfile | undefined {
  if (typeof raw !== 'object' || raw === null)
    return undefined
  const value = raw as Record<string, unknown>
  if (typeof value.id !== 'string' || value.id === '')
    return undefined
  if (typeof value.name !== 'string')
    return undefined
  if (typeof value.host !== 'string' || value.host === '')
    return undefined
  if (typeof value.user !== 'string')
    return undefined
  return {
    id: brandMachineId(value.id),
    name: value.name,
    host: value.host,
    port: typeof value.port === 'number' ? value.port : DEFAULT_SSH_PORT,
    user: value.user,
    remotePort: typeof value.remotePort === 'number' ? value.remotePort : DEFAULT_REMOTE_PORT,
    ...typeof value.password === 'string' && value.password !== '' ? { password: value.password } : {},
    ...typeof value.passphrase === 'string' && value.passphrase !== '' ? { passphrase: value.passphrase } : {},
    ...typeof value.profileName === 'string' && value.profileName !== '' ? { profileName: value.profileName } : {},
    ...typeof value.startCommand === 'string' && value.startCommand !== '' ? { startCommand: value.startCommand } : {},
    ...typeof value.color === 'string' && value.color !== '' ? { color: value.color } : {},
    ...value.tintBorder === true ? { tintBorder: true } : {},
  }
}

/** Project a stored dict into a profile map; a mismatched row is dropped. */
export function machinesOf(value: unknown): Map<MachineId, MachineProfile> {
  const profiles = new Map<MachineId, MachineProfile>()
  if (typeof value !== 'object' || value === null)
    return profiles
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const profile = machineProfileOf(raw)
    if (profile === undefined || profile.id !== key)
      continue
    profiles.set(brandMachineId(key), profile)
  }
  return profiles
}

/** Parse one state document; an absent or corrupt file reads as the default state. */
function readState(file: string): SshState {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
  }
  catch {
    return { enabled: false, machines: {} }
  }
  if (typeof parsed !== 'object' || parsed === null)
    return { enabled: false, machines: {} }
  const record = parsed as { enabled?: unknown, machines?: unknown }
  const machines: Record<string, MachineProfile> = {}
  for (const [key, profile] of machinesOf(record.machines))
    machines[key] = profile
  return { enabled: record.enabled === true, machines }
}

/** Atomically replace `file` with `content` (same-directory rename, owner-only). */
function writeStateFile(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(temp, content, { mode: 0o600, flag: 'wx' })
    renameSync(temp, file)
  }
  catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

/**
 * File-backed machine state. The document is read once at construction (the
 * manager needs the profile map synchronously) and every write is atomic and
 * announces itself to the service, which refreshes the manager.
 */
export class MachineStateStore {
  private state: SshState

  private readonly listeners = new Set<() => void>()

  /** @param file - absolute path of the state document. */
  constructor(private readonly file: string) {
    this.state = readState(file)
  }

  /** Whether the SSH feature is switched on. */
  enabled(): boolean {
    return this.state.enabled
  }

  /** The stored manual machines keyed by id. */
  machines(): Map<MachineId, MachineProfile> {
    const profiles = new Map<MachineId, MachineProfile>()
    for (const [key, profile] of Object.entries(this.state.machines)) {
      const id = brandMachineId(key)
      profiles.set(id, { ...profile, id })
    }
    return profiles
  }

  /** Subscribe to in-process changes; returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Flip the feature switch (idempotent). */
  setEnabled(enabled: boolean): void {
    if (this.state.enabled === enabled)
      return
    this.commit({ ...this.state, enabled })
  }

  /** Upsert one machine profile. */
  saveMachine(profile: MachineProfile): void {
    this.commit({ ...this.state, machines: { ...this.state.machines, [profile.id]: profile } })
  }

  /** Delete one machine profile (idempotent for absent ids). */
  removeMachine(machineId: MachineId): void {
    if (this.state.machines[machineId] === undefined)
      return
    const machines = { ...this.state.machines }
    delete machines[machineId]
    this.commit({ ...this.state, machines })
  }

  /** Persist the next state, adopt it, then notify subscribers. */
  private commit(next: SshState): void {
    writeStateFile(this.file, `${JSON.stringify({ version: STATE_VERSION, ...next }, null, 2)}\n`)
    this.state = next
    for (const listener of this.listeners) listener()
  }
}
