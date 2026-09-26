import type { Buffer } from 'node:buffer'
import type { Config } from '../storage/index'
/**
 * Per-machine connection manager: profile map, the connection state machine
 * (disconnected/testing/connecting/connected/reconnecting/given-up), TOFU
 * host-key gating, remote-instance assurance, the tunnel lifecycle, and the
 * watchdog-driven reconnect loop (exponential backoff, tunnel rebuild).
 * Transport-agnostic — tests inject a fake transport and never touch the
 * network.
 * @module dsh-tauri-ssh/host/service/manager
 */

import type { MachineProfile, MachineView, SshInstallResult, SshLink, SshMachineStage, SshMachineStatus, SshProgress, SshTestResult } from '../types/index'
import type { WorkspaceAllowlist } from './allowlist'
import type { BootstrapHooks } from './bootstrap'
import type { SshMachineEvents } from './events'
import type { KnownHostsStore } from './host-keys'
import type { SshSession, SshTransport, SshTunnelHandle, TunnelHeaderInjection } from './transport'
import { homedir } from 'node:os'
import process from 'node:process'
import { join } from 'pathe'
import { MachineId, SshError } from '../types/index'
import { carryWorkspaceAllowlist, EMPTY_ALLOWLIST } from './allowlist'
import { checkMissingCommand, credentialsCopyCommand, describeError, describeExecFailure, ensurePnpmCommand, ensureRemoteInstance, firstLineOf, missingComponentsOf, planRemoteInstall, readEnvCredentials, REMOTE_ROOT, remoteWebTokenCommand, runInstallScript, safeProfileName, skippedVerificationSummary } from './bootstrap'
import { fingerprintHostKey } from './host-keys'
import { syncBundledPlugins } from './plugins-sync'
import { mintTunnelCookie } from './transport'

/** One machine's live connection state. */
interface MachineState {
  /** Monotonic attempt counter; a disconnect invalidates in-flight connects. */
  generation: number
  /** Published connection phase; the status source of truth. */
  phase: 'disconnected' | 'testing' | 'connecting' | 'connected' | 'reconnecting' | 'given-up'
  /** In-flight connect promise; concurrent connects share it. */
  connecting?: Promise<SshLink>
  /** In-flight install promise; concurrent installs share it. */
  installing?: Promise<SshInstallResult>
  /** The authenticated SSH session, while connected. */
  session?: SshSession
  /** The local tunnel listener, while connected. */
  tunnel?: SshTunnelHandle
  /** The published link, while connected. */
  link?: SshLink
  /** Operator-facing description of the last failed transition. */
  lastError?: string
  /** Whether the last failure was "dsh not installed on the remote". */
  dshMissing?: boolean
  /** Live progress of the in-flight operation. */
  progress?: SshProgress
  /** The active reconnect loop, while one owns the machine. */
  reconnect?: ReconnectState
  /** Local port to prefer when (re)binding the tunnel, keeping the URL stable. */
  preferredTunnelPort?: number
  /** Which credential the live (or last successful) connection used. */
  authMethod?: SshSession['authMethod']
}

/** The background reconnect loop's bookkeeping. */
interface ReconnectState {
  /** Generation this loop belongs to; a disconnect invalidates it. */
  generation: number
  /** Number of the retry that runs next, 1-based; exceeds the budget → give up. */
  attempt: number
  /** Epoch ms when the scheduled retry fires; absent while a retry is in flight. */
  nextRetryAt?: number
  /** The pending retry timer; a disconnect clears it. */
  timer?: NodeJS.Timeout
  /** Redacted reason of every failed attempt so far, first attempt included. */
  reasons: string[]
}

/** Manager dependencies (all transport seams injectable for tests). */
export interface SshManagerDeps {
  transport: SshTransport
  knownHosts: KnownHostsStore
  config: Config
  /** The machine event channel (C-EVENT): bootstrap log/progress events. */
  events: SshMachineEvents
  /** The install-plan resolver (overridable so tests never touch the network). */
  planInstall?: (unameOut: string, config: Pick<Config, 'installRepo' | 'installRef'>) => Promise<import('./bootstrap').RemoteInstallPlan>
  /** Publish one machine's status change (the service emits the seam event). */
  emitStatus: (machineId: MachineId, status: SshMachineStatus) => void
  /** Local dsh `.env` credentials to copy after an install (defaults to the host's own). */
  readEnvCredentials?: () => ReturnType<typeof readEnvCredentials>
  /**
   * Mint the tunnel's session cookie: one local GET of the authenticated URL
   * (no redirect follow), resolving the `name=value` pair from `set-cookie`.
   * Defaults to the node:http implementation; tests stub it to stay offline.
   */
  mintCookie?: (authenticatedUrl: string) => Promise<string | undefined>
  /**
   * The local profile's build allowlist to carry to the remote (defaults to
   * none; the plugin wires the real reader). See {@link carryWorkspaceAllowlist}.
   */
  localAllowlist?: () => WorkspaceAllowlist
  /**
   * Sync the desktop-bundled plugins to the remote (defaults to the real
   * tarball pipeline; tests stub it to stay offline). Returns whether the
   * remote was modified (a running instance gets restarted by the sync).
   */
  syncPlugins?: (session: SshSession, profileName: string, remotePort: number, hooks: { onEvent?: (stage: SshMachineStage, line: string) => void }) => Promise<boolean>
}

/** The sentinel rethrown when an in-flight attempt loses to a disconnect. */
class AttemptCancelled extends Error {}

/**
 * The per-machine state machine. All public methods are safe to call
 * concurrently: connects dedupe on the in-flight promise, disconnects settle
 * a live link idempotently, and session-closed callbacks race-check their
 * ownership before tearing down. Every transition publishes through
 * `emitStatus` exactly when it happens; a superseded attempt never publishes.
 */
export class SshManager {
  private readonly profiles = new Map<MachineId, MachineProfile>()
  private readonly states = new Map<MachineId, MachineState>()

  /**
   * @param deps - transport, TOFU store, timing config, and the status publisher.
   */
  constructor(private readonly deps: SshManagerDeps) {}

  /**
   * Replace the profile map (settings changed). Machines whose profile
   * vanished are disconnected; live connections keep their established link
   * until the operator reconnects (a profile edit applies on next connect).
   * @param profiles - the new profile map keyed by machine id.
   */
  refreshProfiles(profiles: ReadonlyMap<MachineId, MachineProfile>): void {
    this.profiles.clear()
    for (const [id, profile] of profiles) this.profiles.set(id, profile)
    for (const id of this.states.keys()) {
      if (!this.profiles.has(id)) {
        this.deps.events.forget(id)
        void this.disconnect(id)
      }
    }
  }

  /** Redacted views of every profile, in settings order. */
  profileViews(): MachineView[] {
    return [...this.profiles.values()].map(profileView)
  }

  /** Transport status of every known machine, in settings order. */
  statuses(): SshMachineStatus[] {
    return [...this.profiles.keys()].map(id => this.status(id))
  }

  /** The local profile's build allowlist (empty when no reader is wired). */
  localAllowlist(): WorkspaceAllowlist {
    return (this.deps.localAllowlist ?? (() => EMPTY_ALLOWLIST))()
  }

  /**
   * The remote dsh profile this machine serves (its configured name, falling
   * back to the default). Callers that install plugins on the remote must
   * target it: the tunnel only ever serves this one profile.
   * @param machineId - the machine to look up.
   * @returns the shell-safe profile name.
   */
  profileName(machineId: MachineId): string {
    return safeProfileName(this.profiles.get(machineId)?.profileName)
  }

  /**
   * Publish (or clear, with no value) the live progress of an operation the
   * manager does not own a lifecycle for — the sync engine's item-by-item
   * pass. The status line is the only channel the settings page polls, so an
   * externally driven operation reports itself here to stay visible.
   * @param machineId - the machine the operation runs against.
   * @param progress - the progress to publish; omit to clear.
   */
  setProgress(machineId: MachineId, progress?: SshProgress): void {
    const state = this.ensureState(machineId)
    if (progress === undefined)
      delete state.progress
    else
      state.progress = progress
    this.emit(machineId)
  }

  /** Transport status of one machine; unknown ids report `disconnected`. */
  status(machineId: MachineId): SshMachineStatus {
    const state = this.states.get(machineId)
    const lastError = state?.lastError
    const progress = state?.progress
    const nextRetryAt = state?.reconnect?.nextRetryAt
    const authMethod = state?.authMethod
    return {
      machineId,
      state: state?.phase ?? 'disconnected',
      ...state?.link !== undefined ? { tunnelBaseUrl: state.link.tunnelBaseUrl } : {},
      ...lastError === undefined ? {} : { lastError },
      ...state?.dshMissing === true ? { dshMissing: true } : {},
      ...progress === undefined ? {} : { progress },
      ...nextRetryAt === undefined ? {} : { nextRetryAt },
      ...authMethod === undefined ? {} : { authMethod },
    }
  }

  /** The current tunnel link of one machine, when connected. */
  link(machineId: MachineId): SshLink | undefined {
    return this.states.get(machineId)?.link
  }

  /**
   * One-shot probe: authenticate, run `uname -srm`, close. Never starts the
   * remote instance and never leaves a connection behind. Publishes the
   * transient `testing` state for the probe's duration, then restores the
   * phase it found (unless something else transitioned the machine in the
   * meantime — reconnects and disconnects own their transitions).
   * @param machineId - the machine to probe.
   * @param signal - aborts the probe.
   * @returns the probe outcome.
   * @throws {SshError} `machine-not-found` for an unknown id.
   */
  async test(machineId: MachineId, signal?: AbortSignal): Promise<SshTestResult> {
    const profile = this.requireProfile(machineId)
    const state = this.ensureState(machineId)
    const previousPhase = state.phase
    state.phase = 'testing'
    state.progress = { phase: 'handshake' }
    this.emit(machineId)
    const restore = (): void => {
      const current = this.states.get(machineId)
      // Only test() ever sets `testing`, so a different phase means another
      // transition (drop, reconnect, disconnect) took ownership meanwhile.
      if (current === state && current.phase === 'testing') {
        current.phase = previousPhase === 'testing' ? 'disconnected' : previousPhase
        delete current.progress
      }
      this.emit(machineId)
    }
    let session: SshSession
    try {
      session = await this.deps.transport.connect(profile, (label, key) => this.checkHostKey(MachineId(label), key), signal)
    }
    catch (error) {
      restore()
      return { ok: false, message: this.redacted(machineId, describeSshFailure(error)) }
    }
    try {
      const result = await session.exec('uname -srm')
      if (result.code !== 0) {
        return { ok: false, message: describeExecFailure(result.code, result.stderr) }
      }
      return { ok: true, banner: result.stdout.trim() }
    }
    catch (error) {
      return { ok: false, message: this.redacted(machineId, describeSshFailure(error)) }
    }
    finally {
      restore()
      await session.close()
    }
  }

  /**
   * Establish (or reuse) the machine link: SSH connection, remote-instance
   * assurance, and the local tunnel. Idempotent. A failed attempt hands the
   * machine to the background reconnect loop (the caller sees the failure;
   * the loop keeps retrying with exponential backoff and either reconnects
   * or lands in the `given-up` terminal state).
   * @param machineId - the machine to connect.
   * @param signal - aborts the connection attempt.
   * @returns the live link.
   * @throws {SshError} on any failure, or `machine-reconnecting` while the
   *   reconnect loop owns the machine.
   */
  async connect(machineId: MachineId, signal?: AbortSignal): Promise<SshLink> {
    const profile = this.requireProfile(machineId)
    const state = this.ensureState(machineId)
    if (state.link !== undefined)
      return state.link
    this.refuseWhileReconnecting(machineId, state)
    if (state.connecting === undefined) {
      state.phase = 'connecting'
      delete state.lastError
      delete state.dshMissing
      state.progress = { phase: 'handshake' }
      this.emit(machineId)
      const generation = state.generation
      const attempt = this.performConnect(machineId, profile, signal)
      state.connecting = attempt.finally(() => {
        // The slot is only ever replaced while undefined, so the settling
        // attempt always owns it at this point.
        delete this.states.get(machineId)?.connecting
      })
      // The caller sees the first failure; the reconnect loop keeps trying
      // in the background (unless the failure is persistent dsh-missing or
      // a disconnect superseded the attempt).
      void attempt.catch((error) => {
        const current = this.states.get(machineId)
        if (current === undefined || current.generation !== generation)
          return
        if ((error instanceof SshError && error.code === 'machine-dsh-missing') || current.dshMissing === true) {
          this.giveUp(machineId, current)
          return
        }
        this.beginReconnect(machineId)
      })
    }
    return state.connecting
  }

  /**
   * Open one dedicated authenticated session to the machine — handshake and
   * TOFU gate only, no remote-instance bootstrap and no tunnel. Callers that
   * drive plain remote commands (the sync engine) get an independent
   * lifecycle: closing the returned session never touches a live link.
   * @param machineId - the machine to reach.
   * @param signal - aborts the handshake.
   * @returns the authenticated session; the caller owns closing it.
   * @throws {SshError} `machine-not-found` for an unknown id, or
   *   `machine-reconnecting` while the reconnect loop owns the machine.
   */
  async openSession(machineId: MachineId, signal?: AbortSignal): Promise<SshSession> {
    const profile = this.requireProfile(machineId)
    // 与 connect/install 一致：重连窗口拥有机器时拒绝新会话（S3 的在途操
    // 作一致性语义——sync 引擎经此开专用会话，裸 /api-ssh 调用方同样拿到
    // 可区分的 machine-reconnecting 而非并行建连）。
    this.refuseWhileReconnecting(machineId, this.ensureState(machineId))
    return await this.deps.transport.connect(profile, (label, key) => this.checkHostKey(MachineId(label), key), signal)
  }

  /**
   * Tear down one machine's link, invalidating any in-flight connect and any
   * running reconnect loop. Idempotent for an absent link; unknown ids
   * resolve without writing anything.
   * @param machineId - the machine to disconnect.
   */
  async disconnect(machineId: MachineId): Promise<void> {
    const state = this.states.get(machineId)
    if (state === undefined)
      return
    state.generation += 1
    this.stopReconnect(state)
    delete state.lastError
    delete state.dshMissing
    delete state.progress
    const tunnel = state.tunnel
    const session = state.session
    delete state.tunnel
    delete state.session
    delete state.link
    state.phase = 'disconnected'
    if (tunnel !== undefined)
      await tunnel.close().catch(() => undefined)
    if (session !== undefined)
      await session.close().catch(() => undefined)
    this.emit(machineId)
  }

  /**
   * Disconnect every machine (composition teardown).
   */
  async dispose(): Promise<void> {
    await Promise.all([...this.states.keys()].map(id => this.disconnect(id)))
  }

  /** @throws {SshError} `machine-not-found` for an unknown id. */
  private requireProfile(machineId: MachineId): MachineProfile {
    const profile = this.profiles.get(machineId)
    if (profile === undefined) {
      throw new SshError('machine-not-found', machineId, `no SSH machine profile "${machineId}"`)
    }
    return profile
  }

  private ensureState(machineId: MachineId): MachineState {
    let state = this.states.get(machineId)
    if (state === undefined) {
      state = { generation: 0, phase: 'disconnected' }
      this.states.set(machineId, state)
    }
    return state
  }

  /**
   * Best-effort launch-token read from the remote web log. No exec timeout:
   * a timeout in this session implementation closes the whole connection,
   * and a slow grep must never kill a healthy link — any failure simply
   * degrades to the bare tunnel URL.
   */
  private async readRemoteWebToken(session: SshSession): Promise<string | undefined> {
    try {
      const result = await session.exec(remoteWebTokenCommand())
      const token = result.stdout.trim()
      return token === '' ? undefined : token
    }
    catch {
      return undefined
    }
  }

  /** TOFU gate: accept a known fingerprint, remember a first sight, reject a mismatch. */
  private async checkHostKey(machineId: MachineId, hostKey: Buffer): Promise<boolean> {
    const fingerprint = fingerprintHostKey(hostKey)
    const verdict = await this.deps.knownHosts.verify(machineId, fingerprint)
    if (verdict === 'accepted')
      return true
    if (verdict === 'unknown') {
      await this.deps.knownHosts.accept(machineId, fingerprint)
      return true
    }
    return false
  }

  /**
   * One full connection attempt. Publishes exactly one terminal transition
   * (connected or disconnected) unless a disconnect superseded the attempt —
   * a superseded attempt closes its session and throws without publishing.
   * The bootstrap event stream likewise settles on every failure (its own
   * settling events, or the catch for transport exceptions that bypass
   * them), except a superseded attempt: cancellation by an explicit
   * disconnect is the documented no-terminal case. Failures record the
   * (redacted, auth-stage) reason — the caller decides whether the reconnect
   * loop takes over.
   */
  private async performConnect(machineId: MachineId, profile: MachineProfile, signal?: AbortSignal): Promise<SshLink> {
    const state = this.ensureState(machineId)
    const generation = state.generation
    // The settling guard: remembers whether this attempt's bootstrap already
    // settled the event stream (failBootstrap/emitReady fire their own
    // terminal events), so the catch below settles only the gaps — transport
    // exceptions such as exec timeouts or a dropped session, which bypass
    // the bootstrap's own failure reporting.
    let bootstrapSettled = false
    const onEvent: NonNullable<BootstrapHooks['onEvent']> = (stage, line, options) => {
      if (options?.terminal !== undefined)
        bootstrapSettled = true
      this.deps.events.append(machineId, stage, line, options)
    }
    let session: SshSession
    try {
      session = await this.deps.transport.connect(profile, (label, key) => this.checkHostKey(MachineId(label), key), signal)
    }
    catch (error) {
      // The locally captured, redacted message: a superseded attempt must
      // not read state.lastError back — that slot may already belong to a
      // newer try.
      const message = this.redacted(machineId, describeSshFailure(error))
      if (generation === state.generation) {
        delete state.progress
        this.noteConnectFailure(machineId, message)
      }
      throw new SshError('machine-connect-failed', machineId, message)
    }
    // 桌面捆绑插件随远端实例走（远端窗口与本体唯一区别=后端）：树变化时
    // 上传并重启实例，随后的 ensure 按新 profile 拉起。best-effort：同步
    // 失败降级为原生远端 UI，连接本身不受影响。
    try {
      await (this.deps.syncPlugins ?? syncBundledPlugins)(session, safeProfileName(profile.profileName), profile.remotePort, {
        onEvent: (stage, line) => {
          if (generation === state.generation)
            this.deps.events.append(machineId, stage, line)
        },
      })
    }
    catch (error) {
      this.deps.events.append(machineId, 'install', `捆绑插件同步失败（降级原生 UI）: ${describeError(error)}`)
    }
    // 远端自带的 pnpm 只在 dependencies/pnpm 下，PATH 上没有裸 `pnpm`——而
    // `dsh plugin add`（同步面板装第三方插件、远端自己装插件）都找它。补一个
    // 指向布局自带 pnpm 的垫片（幂等、不需联网），失败只记一行日志。
    try {
      await session.exec(ensurePnpmCommand())
      this.deps.events.append(machineId, 'install', '远端 pnpm 垫片就绪（dsh plugin 依赖它）')
    }
    catch (error) {
      this.deps.events.append(machineId, 'install', `远端 pnpm 垫片写入失败: ${describeError(error)}`)
    }
    // 本机已放行的构建白名单（桌面端插件安装器写进 profile 的 pnpm-workspace.yaml）
    // 带到远端：git 托管的插件在远端同样要过 pnpm 的 prepare 门禁，而远端 profile
    // 是从模板起的、一个放行项都没有。
    try {
      const added = await carryWorkspaceAllowlist(session, safeProfileName(profile.profileName), (this.deps.localAllowlist ?? (() => EMPTY_ALLOWLIST))())
      if (added.length > 0)
        this.deps.events.append(machineId, 'install', `远端构建放行白名单已补齐 ${added.length} 项（git 插件 prepare 门禁）`)
    }
    catch (error) {
      this.deps.events.append(machineId, 'install', `构建放行白名单同步失败: ${describeError(error)}`)
    }
    try {
      await ensureRemoteInstance(
        session,
        profile,
        {
          config: this.deps.config,
          healthCheckTimeoutMs: this.deps.config.healthCheckTimeoutMs,
          healthPollIntervalMs: this.deps.config.healthPollIntervalMs,
          healthPollAttempts: this.deps.config.healthPollAttempts,
        },
        {
          onProgress: (progress) => {
            if (generation === state.generation) {
              state.progress = progress
              this.emit(machineId)
            }
          },
          onEvent,
        },
        this.deps.planInstall,
      )
      // Prefer the previously published tunnel port so a reconnect keeps
      // the machine's URL stable for consumers (falls back to ephemeral).
      // Cookie 注入槽先挂上：隧道一旦发布即可服务；mint 落定后每条连接
      // 自动带 Cookie（ mint 前的纯裸管阶段只发生在发布前，外部不可见）。
      const injection: TunnelHeaderInjection = { cookie: undefined }
      const tunnel = await session.openTunnel(profile.remotePort, state.preferredTunnelPort, injection)
      // A disconnect that landed anywhere above (bootstrap, tunnel opening)
      // must not publish a link; tear the tunnel down and abort the attempt.
      if (generation !== state.generation) {
        await tunnel.close().catch(() => undefined)
        throw new AttemptCancelled()
      }
      // dsh web 的 launch token：隧道 URL 带上 ?token= 后，首次加载即 mint
      // 该 authority 的鉴权 cookie（303 → /），壳层 iframe 与新窗口免登录；
      // 读不到（实例非本插件拉起/日志无记录）退化为裸 URL（401 页自行呈现）。
      const webToken = await this.readRemoteWebToken(session)
      // 会话 cookie 是 SameSite=Strict：iframe 第三方上下文存不下也发不出
      // （壳层内嵌 401 的根因）——隧道自注 Cookie 才是不挑嵌入上下文的解法；
      // URL 同时保留 ?token=（顶层导航的新窗口/浏览器自举用）。
      if (webToken !== undefined) {
        const mint = this.deps.mintCookie ?? mintTunnelCookie
        injection.cookie = await mint(`http://127.0.0.1:${tunnel.localPort}/?token=${webToken}`)
      }
      const link: SshLink = {
        machineId,
        tunnelBaseUrl: `http://127.0.0.1:${tunnel.localPort}${webToken === undefined ? '' : `/?token=${webToken}`}`,
      }
      const reconnected = state.reconnect !== undefined ? state.reconnect.reasons.length : undefined
      state.session = session
      state.tunnel = tunnel
      state.link = link
      state.preferredTunnelPort = tunnel.localPort
      state.authMethod = session.authMethod
      delete state.progress
      this.stopReconnect(state)
      state.phase = 'connected'
      session.onClosed(() => {
        const current = this.states.get(machineId)
        if (current?.session !== session)
          return
        // The established connection dropped (server went away, network,
        // keepalive watchdog): hand the machine to the reconnect loop.
        const tunnel = current.tunnel
        delete current.session
        delete current.tunnel
        delete current.link
        delete current.progress
        void tunnel?.close().catch(() => undefined)
        current.lastError = 'SSH connection closed'
        this.beginReconnect(machineId)
      })
      this.emit(machineId)
      this.deps.events.append(
        machineId,
        'auth',
        this.redacted(machineId, `connected to ${profile.host}${session.authMethod === undefined ? '' : ` (auth: ${session.authMethod})`}`),
        { terminal: 'success' },
      )
      if (reconnected !== undefined) {
        this.deps.events.append(
          machineId,
          'reconnect',
          this.redacted(machineId, `reconnected to ${profile.host} after ${reconnected} failed attempt(s)`),
          { terminal: 'success' },
        )
      }
      return link
    }
    catch (error) {
      await session.close().catch(() => undefined)
      if (error instanceof AttemptCancelled) {
        throw new SshError('machine-connect-failed', machineId, 'connection cancelled by disconnect')
      }
      // The locally captured message: a superseded attempt must not read
      // state.lastError back — that slot may already belong to a newer try.
      const message = error instanceof Error ? error.message : String(error)
      if (generation === state.generation && !bootstrapSettled) {
        onEvent('failed', 'bootstrap 失败', { terminal: 'failed', reason: this.redacted(machineId, message) })
      }
      if (generation === state.generation) {
        delete state.progress
        this.noteConnectFailure(machineId, message)
        state.phase = 'disconnected'
        this.emit(machineId)
      }
      throw new SshError('machine-bootstrap-failed', machineId, this.redacted(machineId, message))
    }
  }

  /**
   * Record one failed connection attempt: redacted `lastError`, the
   * dsh-missing marker, and an `auth`-stage event line on the machine event
   * channel. Never publishes the phase — the caller owns that transition.
   */
  private noteConnectFailure(machineId: MachineId, message: string): void {
    const state = this.states.get(machineId)
    if (state === undefined)
      return
    const redactedMessage = this.redacted(machineId, message)
    state.lastError = redactedMessage
    // The start script's own "not installed" verdict keeps the UI's install
    // hint alive (the auto-bootstrap could not complete).
    if (message.includes('REMOTE_NOT_INSTALLED'))
      state.dshMissing = true
    this.deps.events.append(machineId, 'auth', redactedMessage)
  }

  /**
   * Hand one machine to the reconnect loop after its first failed attempt
   * (user connect, install connect, or a dropped established connection).
   * Idempotent — a machine already owned by a loop stays on its schedule.
   */
  private beginReconnect(machineId: MachineId): void {
    const state = this.ensureState(machineId)
    if (state.reconnect !== undefined)
      return
    state.reconnect = {
      generation: state.generation,
      attempt: 0,
      reasons: [state.lastError ?? 'connection failed'],
    }
    this.scheduleReconnect(machineId)
  }

  /**
   * Schedule the loop's next retry (or give up when the budget is spent):
   * exponential backoff from the configured initial delay, capped at the
   * configured ceiling. Publishes the `reconnecting` phase with the retry
   * hint each time the schedule changes.
   */
  private scheduleReconnect(machineId: MachineId): void {
    const state = this.states.get(machineId)
    const rec = state?.reconnect
    if (state === undefined || rec === undefined)
      return
    rec.attempt += 1
    if (rec.attempt > this.deps.config.reconnectMaxAttempts) {
      this.giveUp(machineId, state)
      return
    }
    const base = this.deps.config.reconnectInitialDelayMs
    const ceiling = this.deps.config.reconnectMaxDelayMs
    const delay = Math.min(base * 2 ** (rec.attempt - 1), ceiling)
    rec.nextRetryAt = Date.now() + delay
    state.phase = 'reconnecting'
    delete state.progress
    this.emit(machineId)
    this.deps.events.append(
      machineId,
      'reconnect',
      this.redacted(machineId, `retrying in ${Math.round(delay / 100) / 10} s (attempt ${rec.attempt} of ${this.deps.config.reconnectMaxAttempts})`),
    )
    rec.timer = setTimeout(() => {
      void this.attemptReconnect(machineId)
    }, delay)
    // A pending retry must never hold the host process open on its own.
    rec.timer.unref?.()
  }

  /**
   * One background reconnect attempt: re-reads the live profile (an edit
   * during the outage — e.g. a fixed password — applies on the next retry)
   * and stops silently when a disconnect superseded the loop.
   */
  private async attemptReconnect(machineId: MachineId): Promise<void> {
    const state = this.states.get(machineId)
    const rec = state?.reconnect
    if (state === undefined || rec === undefined || rec.generation !== state.generation)
      return
    const profile = this.profiles.get(machineId)
    if (profile === undefined)
      return
    delete rec.nextRetryAt
    state.progress = { phase: 'handshake' }
    this.emit(machineId)
    try {
      await this.performConnect(machineId, profile)
      // performConnect published `connected`, cleared the loop, and emitted
      // the success events.
    }
    catch (error) {
      if (error instanceof AttemptCancelled)
        return
      const current = this.states.get(machineId)
      const loop = current?.reconnect
      if (current === undefined || loop === undefined || loop.generation !== current.generation)
        return
      if ((error instanceof SshError && error.code === 'machine-dsh-missing') || current.dshMissing === true) {
        // A missing dsh runtime is persistent — retrying cannot fix it, and
        // the given-up state frees the machine for the install flow.
        this.giveUp(machineId, current)
        return
      }
      loop.reasons.push(current.lastError ?? describeSshFailure(error))
      this.scheduleReconnect(machineId)
    }
  }

  /**
   * Land one machine in the `given-up` terminal state: summarized failure
   * reason, loop cleared, terminal event emitted. A fresh `connect` exits it.
   */
  private giveUp(machineId: MachineId, state: MachineState): void {
    const rec = state.reconnect
    this.stopReconnect(state)
    delete state.progress
    state.phase = 'given-up'
    const last = rec?.reasons[rec.reasons.length - 1] ?? state.lastError ?? 'connection failed'
    state.lastError = rec === undefined
      ? this.redacted(machineId, last)
      : this.redacted(machineId, `connect failed after ${rec.reasons.length} attempt(s): ${last}`)
    this.emit(machineId)
    this.deps.events.append(machineId, 'reconnect', state.lastError, { terminal: 'failed', reason: state.lastError })
  }

  /** Clear one machine's reconnect loop (timer and bookkeeping). */
  private stopReconnect(state: MachineState): void {
    if (state.reconnect?.timer !== undefined)
      clearTimeout(state.reconnect.timer)
    delete state.reconnect
  }

  /** @throws {SshError} `machine-reconnecting` while the reconnect loop owns the machine. */
  private refuseWhileReconnecting(machineId: MachineId, state: MachineState): void {
    const rec = state.reconnect
    if (rec === undefined)
      return
    throw new SshError(
      'machine-reconnecting',
      machineId,
      `machine is reconnecting (attempt ${rec.attempt} of ${this.deps.config.reconnectMaxAttempts}); `
      + 'wait for the automatic retry or disconnect first',
    )
  }

  /** Scrub the profile's secret values out of any operator-facing text. */
  private redacted(machineId: MachineId, text: string): string {
    const profile = this.profiles.get(machineId)
    let out = text
    for (const secret of [profile?.password, profile?.passphrase]) {
      if (secret !== undefined && secret !== '')
        out = out.replaceAll(secret, '***')
    }
    return out
  }

  /**
   * One-shot remote dsh install (binary distribution): authenticate, probe
   * the platform, download/verify/install the missing runtime components
   * from the pinned release, copy the local API credentials into the remote
   * `~/.dsh/.env`, then hand off to {@link connect} automatically.
   * Idempotent while in flight. Refused while the reconnect loop owns the
   * machine.
   * @param machineId - the machine to install on.
   * @param signal - aborts the attempt.
   * @returns the install outcome.
   * @throws {SshError} on any failure (connect, install, or probe), or
   *   `machine-reconnecting` while reconnecting.
   */
  async install(machineId: MachineId, signal?: AbortSignal): Promise<SshInstallResult> {
    const profile = this.requireProfile(machineId)
    const state = this.ensureState(machineId)
    this.refuseWhileReconnecting(machineId, state)
    if (state.installing === undefined) {
      state.progress = { phase: 'installing' }
      this.emit(machineId)
      const attempt = this.performInstall(machineId, profile, signal)
      state.installing = attempt.finally(() => {
        // The slot is only ever replaced while undefined, so the settling
        // attempt always owns it at this point.
        delete this.states.get(machineId)?.installing
      })
    }
    return state.installing
  }

  /**
   * One full install attempt. Publishes the terminal transition unless a
   * disconnect superseded the attempt; a successful install hands off to
   * {@link connect} (fire-and-forget — its outcome lands in the status).
   * The event stream settles on every failure — the install script's own
   * terminal event, or the catch for exception failures (probe, planner,
   * transport rejects, missing entry) that bypass it. A superseded attempt
   * (cancellation by an explicit disconnect) is the documented no-terminal
   * case. A failed install connection hands the machine to the reconnect
   * loop, like a failed connect.
   */
  private async performInstall(machineId: MachineId, profile: MachineProfile, signal?: AbortSignal): Promise<SshInstallResult> {
    const state = this.ensureState(machineId)
    const generation = state.generation
    const events = this.deps.events
    // The settling guard mirrors the connect path: the install script's own
    // failure path (and the success line below) settle the stream exactly
    // once; the catch below covers the exception failures that bypass them.
    let settled = false
    const onEvent: NonNullable<BootstrapHooks['onEvent']> = (stage, line, options) => {
      if (options?.terminal !== undefined)
        settled = true
      events.append(machineId, stage, line, options)
    }
    let session: SshSession
    try {
      session = await this.deps.transport.connect(profile, (label, key) => this.checkHostKey(MachineId(label), key), signal)
    }
    catch (error) {
      // The locally captured, redacted message: a superseded attempt must
      // not read state.lastError back — that slot may already belong to a
      // newer try.
      const message = this.redacted(machineId, describeSshFailure(error))
      if (generation === state.generation) {
        delete state.progress
        this.noteConnectFailure(machineId, message)
        this.beginReconnect(machineId)
      }
      throw new SshError('machine-connect-failed', machineId, message)
    }
    try {
      const installTimeoutMs = this.deps.config.installTimeoutMs
      onEvent('probe', '探测远端平台 (uname -srm)')
      const uname = await session.exec('uname -srm')
      if (uname.code !== 0) {
        throw new Error(`cannot probe remote platform: ${describeExecFailure(uname.code, uname.stderr)}`)
      }
      const plan = await (this.deps.planInstall ?? planRemoteInstall)(uname.stdout, this.deps.config)
      onEvent('probe', `远端平台 ${plan.os}/${plan.arch}，安装源 ${plan.repo}${plan.dsh.kind === 'pkg-zip' ? ` tag ${plan.dsh.tag}` : ` npm ${plan.dsh.version}`}`)
      for (const note of plan.notes)
        onEvent('probe', note)
      const missing = missingComponentsOf((await session.exec(checkMissingCommand())).stdout)
      const skips: string[] = []
      if (missing.length > 0) {
        onEvent('probe', `缺失组件: ${missing.join(', ')}`)
        // The single install executor (shared with the connect-time
        // bootstrap): line-buffered stage streaming, the collected-stdout
        // fallback for tap-less transports, and its own settling failure.
        skips.push(...await runInstallScript(session, plan, installTimeoutMs, {
          onEvent,
          onProgress: (progress) => {
            if (generation !== state.generation)
              return
            state.progress = progress
            this.emit(machineId)
          },
        }, 'install 失败'))
        if (generation !== state.generation)
          throw new AttemptCancelled()
      }
      else {
        onEvent('probe', '三件套已就绪，跳过安装')
      }
      // The entry check doubles as $HOME expansion: the shell prints the
      // absolute path the type contract promises (never a literal `$HOME`).
      const dshExpr = `"$HOME/${REMOTE_ROOT}/dependencies/dsh/${plan.dshEntry}"`
      const entryCheck = await session.exec(`test -f ${dshExpr} && printf '%s\\n' ${dshExpr}`)
      const dshPath = firstLineOf(entryCheck.stdout)
      if (entryCheck.code !== 0 || dshPath === '') {
        throw new SshError(
          'machine-dsh-missing',
          machineId,
          `dsh install finished on "${profile.host}" but the entry ${dshExpr} is not present`,
        )
      }
      let credentialsCopied = false
      let credentialsError: string | undefined
      try {
        credentialsCopied = await this.copyCredentials(session)
      }
      catch (error) {
        credentialsError = error instanceof Error ? error.message : String(error)
      }
      const dshRef = plan.dsh.kind === 'pkg-zip' ? plan.dsh.tag : `npm:${plan.dsh.version}`
      // The install operation settles here regardless of the connect handoff
      // that follows: S4 can tell "installed, connect pending" from a failed
      // install purely from the channel's terminal event. Skipped
      // verifications (fail-open checks) ride the settling line.
      onEvent('install', `dsh 安装成功 (${dshRef})${skippedVerificationSummary(plan.notes, skips)}`, { terminal: 'success' })
      await session.close().catch(() => undefined)
      if (generation === state.generation) {
        delete state.progress
        delete state.dshMissing
        delete state.lastError
        state.phase = 'disconnected'
        this.emit(machineId)
        // The operator's intent behind "install" is "connect": hand off and
        // let the connect plane report its own progress/outcome.
        void this.connect(machineId).catch(() => undefined)
      }
      return {
        installed: missing,
        dshRef,
        dshVersion: plan.dshVersion,
        dshPath,
        credentialsCopied,
        ...credentialsError === undefined ? {} : { credentialsError },
      }
    }
    catch (error) {
      await session.close().catch(() => undefined)
      if (error instanceof AttemptCancelled) {
        throw new SshError('machine-install-failed', machineId, 'install cancelled by disconnect')
      }
      // The locally captured message: a superseded attempt must not read
      // state.lastError back — that slot may already belong to a newer try.
      // 与其它失败路径对称地过脱敏（纵深防御：安装错误源今天不含 secret，
      // 但不留给未来调用方）。
      const message = this.redacted(machineId, error instanceof Error ? error.message : String(error))
      // Exception failures (platform probe, planner rejects such as
      // REMOTE_PLATFORM_UNSUPPORTED, transport exec rejects including the
      // install timeout, the missing entry) never reach the script's own
      // settling path: settle the channel here so S4 can tell a failed
      // install from a still-running one purely from the stream.
      if (generation === state.generation && !settled) {
        onEvent('failed', 'install 失败', { terminal: 'failed', reason: message })
      }
      if (generation === state.generation) {
        delete state.progress
        state.lastError = message
        state.phase = 'disconnected'
        this.emit(machineId)
      }
      if (error instanceof SshError)
        throw error
      throw new SshError('machine-install-failed', machineId, message)
    }
  }

  /**
   * Copy the local API credentials into the remote `~/.dsh/.env`, unless the
   * remote already carries a key (kept untouched). A failure to read the
   * local `.env` is not an error — it just reports `false`.
   * @param session - the authenticated session (install connection).
   * @returns whether the credentials were copied.
   */
  private async copyCredentials(session: SshSession): Promise<boolean> {
    const credentials = (this.deps.readEnvCredentials ?? defaultEnvCredentials)()
    const apiKey = credentials.apiKey
    if (apiKey === undefined)
      return false
    const result = await session.exec(credentialsCopyCommand({
      apiKey,
      ...credentials.baseUrl === undefined ? {} : { baseUrl: credentials.baseUrl },
    }))
    if (result.code !== 0) {
      throw new Error(`writing remote credentials failed: ${describeExecFailure(result.code, result.stderr)}`)
    }
    return result.stdout.includes('copied')
  }

  private emit(machineId: MachineId): void {
    this.deps.emitStatus(machineId, this.status(machineId))
  }
}

/** Redacted wire view of one profile. */
export function profileView(profile: MachineProfile): MachineView {
  return {
    id: profile.id,
    name: profile.name,
    host: profile.host,
    port: profile.port,
    user: profile.user,
    hasPassword: profile.password !== undefined,
    hasPassphrase: profile.passphrase !== undefined,
    remotePort: profile.remotePort,
    ...profile.profileName === undefined ? {} : { profileName: profile.profileName },
    ...profile.startCommand === undefined ? {} : { startCommand: profile.startCommand },
    ...profile.color === undefined ? {} : { color: profile.color },
    ...profile.tintBorder === true ? { tintBorder: true } : {},
  }
}

/** One operator-facing fragment for an SSH transport failure. */
export function describeSshFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message === '')
    return 'SSH connection failed'
  return message
}

/** The default local `.env` read: the harness home (`$DSH_HOME`, else `~/.dsh`). */
function defaultEnvCredentials(): ReturnType<typeof readEnvCredentials> {
  return readEnvCredentials(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.env'))
}
