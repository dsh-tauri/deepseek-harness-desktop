import type { Buffer } from 'node:buffer'
import type { ClientRequest } from 'node:http'
import type { MachineProfile, MachineSaveRow, MachineSecretWrite, MachineView, RemoteInstallResult, RemoteLink, RemoteMachineStatus, RemoteProgress, RemoteSession, RemoteStreamHandle, RemoteTestResult } from '../types/index'
import type { WorkspaceAllowlist } from '../utils/allowlist'
import type { SshHostBlock } from '../utils/ssh-config'
import type { BootstrapHooks } from './bootstrap.types'
import type { CoreSwitchLease, MachineState, ReconnectState } from './machine.types'
import type { RemoteTransportCapabilities } from './transport.types'
import { request } from 'node:http'
import { defineService } from 'dsh-tauri'
import { join } from 'pathe'
import { DEFAULT_REMOTE_PORT, DEFAULT_SSH_PORT } from '../../shared/constants'
import { messageOf } from '../../shared/error'
import { DEFAULT_MACHINE_TRANSPORT, REMOTE_ROOT } from '../config/constants'
import { harnessHome, homeDirPath, hostConfig, machineProfiles, machineRuntimeDeps, machineStates, machineTable, sshDirPath } from '../config/runtime'
import { MachineId, RemoteError } from '../types/index'
import { carryWorkspaceAllowlist } from '../utils/allowlist'
import { remoteInstanceStopCommand } from '../utils/instance'
import { syncBundledPlugins } from '../utils/plugins-sync'
import { discoverableHosts, loadSshConfigBlocks, lookupSshConfig, resolveSshAuth } from '../utils/ssh-config'
import { bootstrap } from './bootstrap'
import { assertRemoteDshVersion, checkMissingCommand, credentialsCopyCommand, describeExecFailure, ensurePnpmCommand, firstLineOf, missingComponentsOf, planRemoteInstall, readEnvCredentials, remoteWebTokenCommand, safeProfileName, skippedVerificationSummary } from './bootstrap.utils'
import { events } from './events'
import { gateway } from './gateway'
import { knownHosts } from './known-hosts'
import { fingerprintHostKey } from './known-hosts.utils'
import { state } from './state'

const TUNNEL_PROBE_TIMEOUT_MS = 2_000

const GATEWAY_PORTS_EXHAUSTED = 'ERR_GATEWAY_PORTS_EXHAUSTED'

export const machine = defineService({
  enabled(): boolean {
    return machineTable.enabled
  },

  async setEnabled(enabled: boolean): Promise<void> {
    await state.setEnabled(enabled)
    if (!enabled)
      await machine.dispose()
  },

  async start(): Promise<void> {
    await state.load()
    await machine.syncProfiles()
  },

  async syncProfiles(): Promise<void> {
    const manual = applyStartDefaults(manualProfiles())
    const blocks = await loadSshConfigBlocks(sshDirPath(), homeDirPath())
    const merged = new Map<MachineId, MachineProfile>(manual)
    for (const [id, profile] of discoveredProfiles(blocks, manual))
      merged.set(id, profile)
    machine.refreshProfiles(merged)
  },

  refreshProfiles(next: ReadonlyMap<MachineId, MachineProfile>): void {
    machineProfiles.clear()
    for (const [id, profile] of next)
      machineProfiles.set(id, profile)
    for (const id of machineStates.keys()) {
      if (!machineProfiles.has(id)) {
        events.forget(id)
        void machine.disconnect(id)
      }
    }
  },

  profileViews(): MachineView[] {
    return [...manualProfiles().values()].map(profileView)
  },

  async discoveredViews(): Promise<MachineView[]> {
    const manual = manualProfiles()
    const blocks = await loadSshConfigBlocks(sshDirPath(), homeDirPath())
    return [...discoveredProfiles(blocks, manual).values()].map(profileView)
  },

  statuses(): RemoteMachineStatus[] {
    return [...machineProfiles.keys()].map(id => machine.status(id))
  },

  localAllowlist(): WorkspaceAllowlist {
    return machineRuntimeDeps().localAllowlist()
  },

  profileName(machineId: MachineId): string {
    return safeProfileName(machineProfiles.get(machineId)?.profileName)
  },

  profile(machineId: MachineId): MachineProfile {
    return requireProfile(machineId)
  },

  setProgress(machineId: MachineId, progress?: RemoteProgress): void {
    const target = ensureState(machineId)
    if (progress === undefined)
      delete target.progress
    else
      target.progress = progress
    emit(machineId)
  },

  status(machineId: MachineId): RemoteMachineStatus {
    const target = machineStates.get(machineId)
    const lastError = target?.lastError
    const progress = target?.progress
    const nextRetryAt = target?.reconnect?.nextRetryAt
    const authMethod = target?.authMethod
    return {
      machineId,
      state: target?.phase ?? 'disconnected',
      ...target?.link !== undefined ? { tunnelBaseUrl: target.link.tunnelBaseUrl } : {},
      ...lastError === undefined ? {} : { lastError },
      ...target?.dshMissing === true ? { dshMissing: true } : {},
      ...progress === undefined ? {} : { progress },
      ...nextRetryAt === undefined ? {} : { nextRetryAt },
      ...authMethod === undefined ? {} : { authMethod },
    }
  },

  link(machineId: MachineId): RemoteLink | undefined {
    return machineStates.get(machineId)?.link
  },

  async test(machineId: MachineId, signal?: AbortSignal): Promise<RemoteTestResult> {
    const profile = requireProfile(machineId)
    if (!transportCapabilities(profile).exec)
      return { ok: false, message: unsupportedCapabilityMessage(profile, 'exec') }
    const target = ensureState(machineId)
    const previousPhase = target.phase
    target.phase = 'testing'
    target.progress = { phase: 'handshake' }
    emit(machineId)
    const restore = (): void => {
      const current = machineStates.get(machineId)
      if (current === target && current.phase === 'testing') {
        current.phase = previousPhase === 'testing' ? 'disconnected' : previousPhase
        delete current.progress
      }
      emit(machineId)
    }
    let session: RemoteSession
    try {
      session = await openTransportSession(profile, signal)
    }
    catch (error) {
      restore()
      return { ok: false, message: redacted(machineId, describeSshFailure(error)) }
    }
    try {
      const result = await session.exec('uname -srm')
      if (result.code !== 0)
        return { ok: false, message: describeExecFailure(result.code, result.stderr) }
      return { ok: true, banner: result.stdout.trim() }
    }
    catch (error) {
      return { ok: false, message: redacted(machineId, describeSshFailure(error)) }
    }
    finally {
      restore()
      await session.close()
    }
  },

  async connect(machineId: MachineId, signal?: AbortSignal): Promise<RemoteLink> {
    const profile = requireProfile(machineId)
    requireCapabilities(machineId, profile, ['exec', 'stream'])
    const target = ensureState(machineId)
    if (target.link !== undefined)
      return target.link
    refuseWhileSwitching(machineId, target)
    refuseWhileReconnecting(machineId, target)
    if (target.connecting === undefined) {
      target.phase = 'connecting'
      delete target.lastError
      delete target.dshMissing
      delete target.gatewayExhausted
      target.progress = { phase: 'handshake' }
      emit(machineId)
      const generation = target.generation
      const attempt = performConnect(machineId, profile, signal)
      target.connecting = attempt.finally(() => {
        delete machineStates.get(machineId)?.connecting
      })
      void attempt.catch((error) => {
        const current = machineStates.get(machineId)
        if (current === undefined || current.generation !== generation)
          return
        if (terminalConnectFailure(error, current)) {
          giveUp(machineId, current)
          return
        }
        beginReconnect(machineId)
      })
    }
    return target.connecting
  },

  async openSession(machineId: MachineId, signal?: AbortSignal): Promise<RemoteSession> {
    const profile = requireProfile(machineId)
    requireCapabilities(machineId, profile, ['exec'])
    refuseWhileReconnecting(machineId, ensureState(machineId))
    return await openTransportSession(profile, signal)
  },

  async beginSwitch(machineId: MachineId): Promise<CoreSwitchLease> {
    const target = ensureState(machineId)
    // 切换期间这台机器归切换任务独占：普通连接、安装和另一次切换都要让开，
    // 否则它们可能在目录互换前连回旧核心，或让两次切换互相踩。
    if (target.switchOwner !== undefined)
      throw new RemoteError('machine-busy', machineId, 'machine is already switching the core')
    if (target.connecting !== undefined || target.installing !== undefined || target.installReserved === true)
      throw new RemoteError('machine-busy', machineId, 'machine is already connecting or installing')
    // 自动重连已经跑起来了就不能切：它可能在切换停机或互换目录期间把旧实例拉起来。
    if (target.reconnect?.attempting !== undefined)
      throw new RemoteError('machine-busy', machineId, 'machine is reconnecting; wait for the automatic retry or disconnect first')
    target.generation += 1
    // 代次要在这里就抓住：等资源关闭这段时间里用户可能断开并让另一次切换接手，
    // 那时读到的代次已经不是本次的了。
    const generation = target.generation
    stopReconnect(target)
    const entry = target.gateway
    const tunnel = target.tunnel
    const session = target.session
    delete target.gateway
    delete target.tunnel
    delete target.session
    delete target.link
    delete target.progress
    delete target.lastError
    delete target.dshMissing
    delete target.gatewayExhausted
    target.phase = 'switching'
    if (entry !== undefined)
      entry.unsubscribe()
    emit(machineId)
    await Promise.all([
      entry === undefined ? undefined : gateway.stop(entry.id).catch(() => undefined),
      tunnel === undefined ? undefined : tunnel.close().catch(() => undefined),
      session === undefined ? undefined : session.close().catch(() => undefined),
    ])
    // 等的过程中状态被改过（用户断开、配置变更、另一次切换接手）：本次租约作废。
    if (target.generation !== generation)
      throw new RemoteError('machine-busy', machineId, 'machine state changed while releasing the connection')
    const lease: CoreSwitchLease = { machineId, generation }
    target.switchOwner = lease
    return lease
  },

  /** 切换任务结束后把机器交还给普通连接。 */
  endSwitch(lease: CoreSwitchLease): void {
    const target = machineStates.get(lease.machineId)
    if (target === undefined || target.switchOwner?.generation !== lease.generation)
      return
    delete target.switchOwner
    // 切换结束却没有重建连接时，机器不能停在「切换中」：界面会一直挡着。
    if (target.phase === 'switching')
      target.phase = 'disconnected'
    emit(lease.machineId)
  },

  /**
   * 切换租约是否仍然有效：用户断开、配置变更或插件停用都会让它失效。
   *
   * 不看显示阶段：连通性测试会临时把阶段改成 `testing`，
   * 拿阶段当依据会让切换在测试跑完的瞬间失效。
   */
  switchLeaseValid(lease: CoreSwitchLease): boolean {
    const target = machineStates.get(lease.machineId)
    return target !== undefined
      && target.generation === lease.generation
      && target.switchOwner?.generation === lease.generation
  },

  async reconnect(machineId: MachineId, options: { profileSync?: boolean, lease?: CoreSwitchLease, dshBin?: string } = {}): Promise<RemoteLink> {
    const profile = requireProfile(machineId)
    requireCapabilities(machineId, profile, ['exec', 'stream'])
    const target = ensureState(machineId)
    // 切换独占期间只有持有租约的切换任务能重建连接。
    if (target.switchOwner !== undefined && target.switchOwner.generation !== options.lease?.generation)
      throw new RemoteError('machine-busy', machineId, 'machine is switching the core')
    if (target.link !== undefined)
      return target.link
    if (target.connecting !== undefined)
      return await target.connecting
    target.phase = 'connecting'
    delete target.lastError
    delete target.dshMissing
    delete target.gatewayExhausted
    target.progress = { phase: 'handshake' }
    emit(machineId)
    const generation = target.generation
    // 切换后的重建连接只验证与启动现有的那份副本，不重新解析安装计划：
    // 切换不能依赖发行源，也不能改写刚换过去的活动目录。
    const attempt = performConnect(machineId, profile, undefined, {
      ...options.profileSync === false ? { profileSync: false } : {},
      skipInstall: true,
      ...options.dshBin === undefined ? {} : { dshBin: options.dshBin },
    })
    const pending: Promise<RemoteLink> = attempt.finally(() => {
      const current = machineStates.get(machineId)
      if (current?.connecting === pending)
        delete current.connecting
    })
    target.connecting = pending
    void attempt.catch((error) => {
      const current = machineStates.get(machineId)
      // 旧尝试的失败不能盖掉用户随后发起的连接。
      if (current === undefined || current.generation !== generation || current.connecting !== pending)
        return
      // 任务已经失败了，机器不能停在「连接中」：没有在飞的尝试，状态要落到终态。
      current.phase = 'disconnected'
      delete current.progress
      current.lastError = redacted(machineId, messageOf(error))
      emit(machineId)
      events.append(machineId, 'auth', current.lastError)
    })
    return await pending
  },

  async disconnect(machineId: MachineId): Promise<void> {
    const target = machineStates.get(machineId)
    if (target === undefined)
      return
    target.generation += 1
    stopReconnect(target)
    delete target.lastError
    delete target.dshMissing
    delete target.gatewayExhausted
    delete target.progress
    const entry = target.gateway
    const tunnel = target.tunnel
    const session = target.session
    delete target.gateway
    delete target.tunnel
    delete target.session
    delete target.link
    target.phase = 'disconnected'
    if (entry !== undefined) {
      entry.unsubscribe()
      await gateway.stop(entry.id).catch(() => undefined)
    }
    if (tunnel !== undefined)
      await tunnel.close().catch(() => undefined)
    if (session !== undefined)
      await session.close().catch(() => undefined)
    emit(machineId)
  },

  async dispose(): Promise<void> {
    await Promise.all([...machineStates.keys()].map(id => machine.disconnect(id)))
  },

  async install(machineId: MachineId, options: { force?: boolean } = {}, signal?: AbortSignal): Promise<RemoteInstallResult> {
    const profile = requireProfile(machineId)
    requireCapabilities(machineId, profile, ['exec'])
    const target = ensureState(machineId)
    refuseWhileSwitching(machineId, target)
    refuseWhileReconnecting(machineId, target)
    if (target.installing === undefined) {
      // 占位要先登记：强装要先等断开，这段等待里不能让核心切换插进来。
      target.installReserved = true
      try {
        if (options.force === true && target.link !== undefined)
          await machine.disconnect(machineId)
        target.progress = { phase: 'installing' }
        emit(machineId)
        const attempt = performInstall(machineId, profile, options, signal)
        const tracked: Promise<RemoteInstallResult> = attempt.finally(() => {
          const current = machineStates.get(machineId)
          if (current?.installing === tracked)
            delete current.installing
        })
        target.installing = tracked
      }
      finally {
        const current = machineStates.get(machineId)
        if (current !== undefined)
          delete current.installReserved
      }
    }
    return target.installing
  },

  async save(machineId: MachineId, row: MachineSaveRow, secrets?: MachineSecretWrite): Promise<void> {
    await state.save(buildProfile(machineId, row, secrets, machineTable.machines.get(machineId)))
    await machine.syncProfiles()
  },

  async remove(machineId: MachineId): Promise<void> {
    await state.remove(machineId)
    await machine.syncProfiles()
  },
})

// --- internal ---

function manualProfiles(): Map<MachineId, MachineProfile> {
  return new Map(machineTable.machines)
}

function buildProfile(machineId: MachineId, row: MachineSaveRow, secrets: MachineSecretWrite | undefined, existing: MachineProfile | undefined): MachineProfile {
  const next: MachineProfile = {
    id: machineId,
    name: row.name,
    host: row.host,
    port: row.port,
    user: row.user,
    remotePort: row.remotePort,
  }
  if (existing !== undefined) {
    if (existing.password !== undefined)
      next.password = existing.password
    if (existing.passphrase !== undefined)
      next.passphrase = existing.passphrase
  }
  if (row.startCommand !== undefined && row.startCommand !== '')
    next.startCommand = row.startCommand
  if (row.profileName !== undefined && row.profileName !== '')
    next.profileName = row.profileName
  if (row.color !== undefined && row.color !== '')
    next.color = row.color
  if (row.tintBorder === true)
    next.tintBorder = true
  if (secrets !== undefined) {
    if (secrets.password !== undefined && secrets.password !== '')
      next.password = secrets.password
    if (secrets.passphrase !== undefined && secrets.passphrase !== '')
      next.passphrase = secrets.passphrase
  }
  return next
}

function defaultStartCommandFor(remotePort: number): string | undefined {
  const template = hostConfig().startCommand
  if (template === undefined || template === '')
    return undefined
  return template.replaceAll('{port}', String(remotePort))
}

function applyStartDefaults(profiles: Map<MachineId, MachineProfile>): Map<MachineId, MachineProfile> {
  const next = new Map<MachineId, MachineProfile>()
  for (const [id, profile] of profiles) {
    const startCommand = profile.startCommand ?? defaultStartCommandFor(profile.remotePort)
    next.set(id, { ...profile, ...startCommand === undefined ? {} : { startCommand } })
  }
  return next
}

function discoveredProfiles(blocks: SshHostBlock[], manual: Map<MachineId, MachineProfile>): Map<MachineId, MachineProfile> {
  const discovered = new Map<MachineId, MachineProfile>()
  const remotePort = hostConfig().remotePort ?? DEFAULT_REMOTE_PORT
  const startCommand = defaultStartCommandFor(remotePort)
  for (const alias of discoverableHosts(blocks)) {
    const id = MachineId(alias)
    if (manual.has(id))
      continue
    const settings = lookupSshConfig(blocks, alias)
    discovered.set(id, {
      id,
      name: alias,
      host: alias,
      port: settings.port ?? DEFAULT_SSH_PORT,
      user: settings.user ?? '',
      remotePort,
      ...startCommand === undefined ? {} : { startCommand },
    })
  }
  return discovered
}

function requireProfile(machineId: MachineId): MachineProfile {
  const profile = machineProfiles.get(machineId)
  if (profile === undefined)
    throw new RemoteError('machine-not-found', machineId, `no SSH machine profile "${machineId}"`)
  return profile
}

function transportCapabilities(profile: MachineProfile): RemoteTransportCapabilities {
  return machineRuntimeDeps().transport.resolve(profile).capabilities
}

function unsupportedCapabilityMessage(profile: MachineProfile, capability: keyof RemoteTransportCapabilities): string {
  return `transport "${profile.transport ?? DEFAULT_MACHINE_TRANSPORT}" cannot ${capability} on this machine`
}

function requireCapabilities(machineId: MachineId, profile: MachineProfile, required: readonly (keyof RemoteTransportCapabilities)[]): void {
  const capabilities = transportCapabilities(profile)
  for (const capability of required) {
    if (!capabilities[capability])
      throw new RemoteError('machine-transport-unsupported', machineId, unsupportedCapabilityMessage(profile, capability))
  }
}

function ensureState(machineId: MachineId): MachineState {
  let target = machineStates.get(machineId)
  if (target === undefined) {
    target = { generation: 0, phase: 'disconnected' }
    machineStates.set(machineId, target)
  }
  return target
}

async function openTransportSession(profile: MachineProfile, signal?: AbortSignal): Promise<RemoteSession> {
  const deps = machineRuntimeDeps()
  const config = hostConfig()
  return await deps.transport.resolve(profile).connect(
    profile,
    (label, key) => checkHostKey(MachineId(label), key),
    {
      readyTimeoutMs: config.connectTimeoutMs,
      resolveProfile: profile => resolveSshAuth(profile, sshDirPath(), homeDirPath()),
      keepaliveIntervalMs: config.keepaliveIntervalMs,
      keepaliveCountMax: config.keepaliveCountMax,
    },
    signal,
  )
}

async function readRemoteWebToken(session: RemoteSession): Promise<string | undefined> {
  try {
    const result = await session.exec(remoteWebTokenCommand())
    const token = result.stdout.trim()
    return token === '' ? undefined : token
  }
  catch {
    return undefined
  }
}

async function checkHostKey(machineId: MachineId, hostKey: Buffer): Promise<boolean> {
  const fingerprint = fingerprintHostKey(hostKey)
  const verdict = await knownHosts.verify(machineId, fingerprint)
  if (verdict === 'accepted')
    return true
  if (verdict === 'unknown') {
    await knownHosts.accept(machineId, fingerprint)
    return true
  }
  return false
}

class AttemptCancelled extends Error {}

async function performConnect(machineId: MachineId, profile: MachineProfile, signal?: AbortSignal, options: { profileSync?: boolean, skipInstall?: boolean, dshBin?: string } = {}): Promise<RemoteLink> {
  const target = ensureState(machineId)
  const generation = target.generation
  const withProfile = options.profileSync !== false
  let bootstrapSettled = false
  let portExhausted = false
  const onEvent = settlingEventSink(machineId, () => {
    bootstrapSettled = true
  })
  const session = await openSessionOrFail(machineId, profile, signal)
  // 切换核心时只重建连接，不碰远端档案：常规连接的档案同步会改远端工作区白名单与插件链接，
  // 切换失败回滚时这些改动撤不回来。
  if (withProfile) {
    try {
      await syncBundledPlugins(session, safeProfileName(profile.profileName), profile.remotePort, {
        tree: machineRuntimeDeps().bundledPluginsTree,
        onEvent: (stage, line) => {
          if (generation === target.generation)
            events.append(machineId, stage, line)
        },
      })
    }
    catch (error) {
      events.append(machineId, 'install', `捆绑插件同步失败（降级原生 UI）: ${messageOf(error)}`)
    }
    try {
      await session.exec(ensurePnpmCommand())
      events.append(machineId, 'install', '远端 pnpm 垫片就绪（dsh plugin 依赖它）')
    }
    catch (error) {
      events.append(machineId, 'install', `远端 pnpm 垫片写入失败: ${messageOf(error)}`)
    }
    try {
      const added = await carryWorkspaceAllowlist(session, safeProfileName(profile.profileName), machine.localAllowlist())
      if (added.length > 0)
        events.append(machineId, 'install', `远端构建放行白名单已补齐 ${added.length} 项（git 插件 prepare 门禁）`)
    }
    catch (error) {
      events.append(machineId, 'install', `构建放行白名单同步失败: ${messageOf(error)}`)
    }
  }
  try {
    await bootstrap.provision(
      session,
      profile,
      {
        onProgress: (progress) => {
          if (generation === target.generation) {
            target.progress = progress
            emit(machineId)
          }
        },
        onEvent,
      },
      {
        ...options.skipInstall === true ? { install: false } : {},
        ...options.dshBin === undefined ? {} : { dshBin: options.dshBin },
      },
    )
    const tunnel = await session.stream(profile.remotePort, target.preferredTunnelPort)
    if (generation !== target.generation) {
      await tunnel.close().catch(() => undefined)
      throw new AttemptCancelled()
    }
    const entryId = outboundEntryId(machineId)
    let entryPort: number
    try {
      const entry = await gateway.start({
        id: entryId,
        kind: 'outbound',
        upstream: `http://127.0.0.1:${tunnel.localPort}`,
        port: target.preferredGatewayPort ?? 0,
        tokenProvider: async (authority) => {
          const token = await readRemoteWebToken(session)
          return token === undefined ? undefined : `http://${authority}/?token=${token}`
        },
      })
      if (generation !== target.generation) {
        await cancelAttempt(entryId, tunnel)
        throw new AttemptCancelled()
      }
      entryPort = entry.port
    }
    catch (error) {
      if (!(error instanceof AttemptCancelled)) {
        await tunnel.close().catch(() => undefined)
        portExhausted = isGatewayPortExhausted(error)
      }
      throw error
    }
    const unsubscribe = gateway.subscribe((event) => {
      if (event.id !== entryId || (event.kind !== 'stopped' && event.kind !== 'upstream' && event.kind !== 'cookie' && event.kind !== 'compression'))
        return
      if (machineStates.get(machineId)?.tunnel !== tunnel)
        return
      // 铸造 / 压缩失败只留可读事件：单条请求的降级不该改写 link 级状态
      if (event.kind === 'cookie' || event.kind === 'compression') {
        events.append(machineId, 'reconnect', redacted(machineId, `网关转发异常：${event.line}`))
        return
      }
      // 本回调与网关写回下游响应同处一条调用链：必须让当前响应先出网，否则拆除会截断响应体。
      const dead = event.kind === 'stopped'
      setImmediate(() => {
        void gatewayFailure(machineId, tunnel, event.line, dead)
      })
    })
    const link: RemoteLink = { machineId, tunnelBaseUrl: `http://127.0.0.1:${entryPort}` }
    const reconnected = target.reconnect !== undefined ? target.reconnect.reasons.length : undefined
    target.session = session
    target.tunnel = tunnel
    target.gateway = { id: entryId, unsubscribe }
    target.link = link
    target.preferredTunnelPort = tunnel.localPort
    target.preferredGatewayPort = entryPort
    if (session.authMethod === undefined)
      delete target.authMethod
    else
      target.authMethod = session.authMethod
    delete target.progress
    stopReconnect(target)
    target.phase = 'connected'
    session.onClosed(() => {
      if (machineStates.get(machineId)?.session !== session)
        return
      detach(machineId, 'SSH connection closed')
    })
    emit(machineId)
    events.append(
      machineId,
      'auth',
      redacted(machineId, `connected to ${profile.host}${session.authMethod === undefined ? '' : ` (auth: ${session.authMethod})`}`),
      { terminal: 'success' },
    )
    if (reconnected !== undefined) {
      events.append(
        machineId,
        'reconnect',
        redacted(machineId, `reconnected to ${profile.host} after ${reconnected} failed attempt(s)`),
        { terminal: 'success' },
      )
    }
    return link
  }
  catch (error) {
    await session.close().catch(() => undefined)
    if (error instanceof AttemptCancelled)
      throw new RemoteError('machine-connect-failed', machineId, 'connection cancelled by disconnect')
    const message = redacted(machineId, messageOf(error))
    if (generation === target.generation && !bootstrapSettled)
      onEvent('failed', 'bootstrap 失败', { terminal: 'failed', reason: message })
    if (generation === target.generation) {
      delete target.progress
      noteConnectFailure(machineId, message)
      if (portExhausted)
        target.gatewayExhausted = true
      target.phase = 'disconnected'
      emit(machineId)
    }
    throw new RemoteError('machine-bootstrap-failed', machineId, message)
  }
}

function outboundEntryId(machineId: MachineId): string {
  return `remote-outbound:${machineId}`
}

async function cancelAttempt(entryId: string, tunnel: RemoteStreamHandle): Promise<void> {
  await Promise.all([
    gateway.stop(entryId).catch(() => undefined),
    tunnel.close().catch(() => undefined),
  ])
}

/**
 * 网关的 `upstream` 是**逐请求**错误通道（超时 504 / 不可达 502），不是链路级死亡通知；只有入口自身停止
 * （`dead`）或回环隧道口不再接受连接才说明链路丢了。探测把这两种情况分开，否则一条慢请求的 504 就会
 * 换掉整条 SSH 会话与 iframe，远端实例重启窗口内的 502 也会被误判成入口死亡。
 */
async function gatewayFailure(machineId: MachineId, tunnel: RemoteStreamHandle, line: string, dead: boolean): Promise<void> {
  const target = machineStates.get(machineId)
  if (target === undefined || target.tunnel !== tunnel)
    return
  if (!dead && !await tunnelRefused(tunnel.localPort)) {
    recordGatewayIncident(machineId, `网关转发失败：${line}`)
    return
  }
  detach(machineId, `网关入口异常退出：${line}`)
}

/** 直连隧道口：只有本机回环上的 ECONNREFUSED 才等于「隧道口不再监听」；转发腿上的复位与超时都算隧道仍在。 */
function tunnelRefused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = probeRequest(port)
    const timer = setTimeout(() => {
      request.destroy()
      resolve(false)
    }, TUNNEL_PROBE_TIMEOUT_MS)
    const settle = (refused: boolean): void => {
      clearTimeout(timer)
      resolve(refused)
    }
    request.on('response', (response) => {
      response.resume()
      settle(false)
    })
    request.on('error', (error) => {
      settle(codeOf(error) === 'ECONNREFUSED')
    })
    request.end()
  })
}

function probeRequest(port: number): ClientRequest {
  return request({ host: '127.0.0.1', port, method: 'HEAD', path: '/', agent: false, headers: { connection: 'close' } })
}

function recordGatewayIncident(machineId: MachineId, reason: string): void {
  const target = machineStates.get(machineId)
  if (target === undefined)
    return
  target.lastError = redacted(machineId, reason)
  events.append(machineId, 'reconnect', target.lastError)
  emit(machineId)
}

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

/** 网关端口耗尽的判据：内核只在「候选全被登记表占用」或「每个候选都撞上 EADDRINUSE」时抛出，无人重试能改变这一点。 */
function isGatewayPortExhausted(error: unknown): boolean {
  const code = codeOf(error)
  return code === 'EADDRINUSE' || code === GATEWAY_PORTS_EXHAUSTED
}

function terminalConnectFailure(error: unknown, target: MachineState): boolean {
  if (target.dshMissing === true || target.gatewayExhausted === true)
    return true
  return error instanceof RemoteError && error.code === 'machine-dsh-missing'
}

function noteConnectFailure(machineId: MachineId, message: string): void {
  const target = machineStates.get(machineId)
  if (target === undefined)
    return
  const redactedMessage = redacted(machineId, message)
  target.lastError = redactedMessage
  if (message.includes('REMOTE_NOT_INSTALLED'))
    target.dshMissing = true
  events.append(machineId, 'auth', redactedMessage)
}

function detach(machineId: MachineId, reason: string): void {
  const target = machineStates.get(machineId)
  if (target === undefined)
    return
  const entry = target.gateway
  const tunnel = target.tunnel
  const session = target.session
  delete target.gateway
  delete target.session
  delete target.tunnel
  delete target.link
  delete target.progress
  target.lastError = redacted(machineId, reason)
  if (entry !== undefined)
    entry.unsubscribe()
  const pending = Promise.all([
    entry === undefined ? undefined : gateway.stop(entry.id).catch(() => undefined),
    tunnel === undefined ? undefined : tunnel.close().catch(() => undefined),
    session === undefined ? undefined : session.close().catch(() => undefined),
  ]).then(() => undefined)
  beginReconnect(machineId, pending)
}

function beginReconnect(machineId: MachineId, pending?: Promise<void>): void {
  const target = ensureState(machineId)
  if (target.reconnect !== undefined) {
    if (pending !== undefined) {
      const previous = target.reconnect.pending
      target.reconnect.pending = previous === undefined ? pending : Promise.all([previous, pending]).then(() => undefined)
    }
    return
  }
  target.reconnect = {
    generation: target.generation,
    attempt: 0,
    reasons: [target.lastError ?? 'connection failed'],
    ...pending === undefined ? {} : { pending },
  }
  scheduleReconnect(machineId)
}

function scheduleReconnect(machineId: MachineId): void {
  const target = machineStates.get(machineId)
  const rec = target?.reconnect
  if (target === undefined || rec === undefined)
    return
  const config = hostConfig()
  rec.attempt += 1
  if (rec.attempt > config.reconnectMaxAttempts) {
    giveUp(machineId, target)
    return
  }
  const delay = Math.min(config.reconnectInitialDelayMs * 2 ** (rec.attempt - 1), config.reconnectMaxDelayMs)
  rec.nextRetryAt = Date.now() + delay
  target.phase = 'reconnecting'
  delete target.progress
  emit(machineId)
  events.append(
    machineId,
    'reconnect',
    redacted(machineId, `retrying in ${Math.round(delay / 100) / 10} s (attempt ${rec.attempt} of ${config.reconnectMaxAttempts})`),
  )
  rec.timer = setTimeout(() => {
    void attemptReconnect(machineId, rec)
  }, delay)
  rec.timer.unref?.()
}

async function attemptReconnect(machineId: MachineId, expected: ReconnectState): Promise<void> {
  const target = machineStates.get(machineId)
  const rec = target?.reconnect
  if (target === undefined || rec !== expected || rec.generation !== target.generation)
    return
  const profile = machineProfiles.get(machineId)
  if (profile === undefined)
    return
  const pending = rec.pending
  delete rec.pending
  if (pending !== undefined)
    await pending
  const current = machineStates.get(machineId)
  const active = current?.reconnect
  if (current === undefined || active !== rec || rec.generation !== current.generation)
    return
  delete rec.nextRetryAt
  current.progress = { phase: 'handshake' }
  emit(machineId)
  // 登记这次尝试：切换必须等它结束，不能与一次正在跑的自动重连并行。
  const attempting = performConnect(machineId, profile)
  rec.attempting = attempting.then(() => undefined, () => undefined).finally(() => {
    if (machineStates.get(machineId)?.reconnect === rec)
      delete rec.attempting
  })
  try {
    await attempting
  }
  catch (error) {
    if (error instanceof AttemptCancelled)
      return
    const after = machineStates.get(machineId)
    const loop = after?.reconnect
    if (after === undefined || loop !== rec || rec.generation !== after.generation)
      return
    if (terminalConnectFailure(error, after)) {
      giveUp(machineId, after)
      return
    }
    loop.reasons.push(after.lastError ?? describeSshFailure(error))
    scheduleReconnect(machineId)
  }
}

function giveUp(machineId: MachineId, target: MachineState): void {
  const rec = target.reconnect
  stopReconnect(target)
  delete target.progress
  target.phase = 'given-up'
  const last = rec?.reasons[rec.reasons.length - 1] ?? target.lastError ?? 'connection failed'
  target.lastError = rec === undefined
    ? redacted(machineId, last)
    : redacted(machineId, `connect failed after ${rec.reasons.length} attempt(s): ${last}`)
  emit(machineId)
  events.append(machineId, 'reconnect', target.lastError, { terminal: 'failed', reason: target.lastError })
}

function stopReconnect(target: MachineState): void {
  if (target.reconnect?.timer !== undefined)
    clearTimeout(target.reconnect.timer)
  delete target.reconnect
}

/** 切换独占期间拒绝普通连接与安装：它们会跟切换任务抢这台机器。 */
function refuseWhileSwitching(machineId: MachineId, target: MachineState): void {
  if (target.switchOwner === undefined)
    return
  throw new RemoteError('machine-busy', machineId, 'machine is switching the core; wait for the switch to finish')
}

function refuseWhileReconnecting(machineId: MachineId, target: MachineState): void {
  const rec = target.reconnect
  if (rec === undefined)
    return
  throw new RemoteError(
    'machine-reconnecting',
    machineId,
    `machine is reconnecting (attempt ${rec.attempt} of ${hostConfig().reconnectMaxAttempts}); `
    + 'wait for the automatic retry or disconnect first',
  )
}

function redacted(machineId: MachineId, text: string): string {
  const profile = machineProfiles.get(machineId)
  let out = text
  for (const secret of [profile?.password, profile?.passphrase]) {
    if (secret !== undefined && secret !== '')
      out = out.replaceAll(secret, '***')
  }
  return out
}

async function performInstall(machineId: MachineId, profile: MachineProfile, options: { force?: boolean }, signal?: AbortSignal): Promise<RemoteInstallResult> {
  const force = options.force === true
  const config = hostConfig()
  const target = ensureState(machineId)
  const generation = target.generation
  let settled = false
  const onEvent = settlingEventSink(machineId, () => {
    settled = true
  })
  const session = await openSessionOrFail(machineId, profile, signal, () => beginReconnect(machineId))
  try {
    onEvent('probe', '探测远端平台 (uname -srm)')
    const uname = await session.exec('uname -srm')
    if (uname.code !== 0)
      throw new Error(`cannot probe remote platform: ${describeExecFailure(uname.code, uname.stderr)}`)
    const plan = await planRemoteInstall(uname.stdout, config)
    onEvent('probe', `远端平台 ${plan.os}/${plan.arch}，安装源 ${plan.repo}${plan.dsh.kind === 'pkg-zip' ? ` tag ${plan.dsh.tag}` : ` npm ${plan.dsh.version}`}`)
    for (const note of plan.notes)
      onEvent('probe', note)
    await assertRemoteDshVersion(session, true)
    if (force) {
      const stopped = await session.exec(remoteInstanceStopCommand(safeProfileName(profile.profileName), profile.remotePort).join('\n'))
      onEvent('probe', stopped.code === 0 ? '重新安装: 已停止远端旧实例' : '重新安装: 停止远端旧实例失败，继续安装')
    }
    const missing = missingComponentsOf((await session.exec(checkMissingCommand())).stdout)
    const skips: string[] = []
    if (missing.length > 0 || force) {
      onEvent('probe', missing.length > 0 ? `缺失组件: ${missing.join(', ')}` : '重新安装: 按请求强制重装远端三件套')
      skips.push(...await bootstrap.install(session, plan, {
        onEvent,
        onProgress: (progress) => {
          if (generation !== target.generation)
            return
          target.progress = progress
          emit(machineId)
        },
      }, { force, failureLine: 'install 失败' }))
      if (generation !== target.generation)
        throw new AttemptCancelled()
    }
    else {
      onEvent('probe', '三件套已就绪，跳过安装')
    }
    const dshExpr = `"$HOME/${REMOTE_ROOT}/dependencies/dsh/${plan.dshEntry}"`
    const entryCheck = await session.exec(`test -f ${dshExpr} && printf '%s\\n' ${dshExpr}`)
    const dshPath = firstLineOf(entryCheck.stdout)
    if (entryCheck.code !== 0 || dshPath === '') {
      throw new RemoteError(
        'machine-dsh-missing',
        machineId,
        `dsh install finished on "${profile.host}" but the entry ${dshExpr} is not present`,
      )
    }
    await assertRemoteDshVersion(session)
    let credentialsCopied = false
    let credentialsError: string | undefined
    try {
      credentialsCopied = await copyCredentials(session)
    }
    catch (error) {
      credentialsError = error instanceof Error ? error.message : String(error)
    }
    const dshRef = plan.dsh.kind === 'pkg-zip' ? plan.dsh.tag : `npm:${plan.dsh.version}`
    onEvent('install', `dsh 安装成功 (${dshRef})${skippedVerificationSummary(plan.notes, skips)}`, { terminal: 'success' })
    await session.close().catch(() => undefined)
    if (generation === target.generation) {
      delete target.progress
      delete target.dshMissing
      delete target.lastError
      target.phase = 'disconnected'
      emit(machineId)
      void machine.connect(machineId).catch(() => undefined)
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
    if (error instanceof AttemptCancelled)
      throw new RemoteError('machine-install-failed', machineId, 'install cancelled by disconnect')
    const message = redacted(machineId, messageOf(error))
    if (generation === target.generation && !settled)
      onEvent('failed', 'install 失败', { terminal: 'failed', reason: message })
    if (generation === target.generation) {
      delete target.progress
      target.lastError = message
      target.phase = 'disconnected'
      emit(machineId)
    }
    if (error instanceof RemoteError)
      throw error
    throw new RemoteError('machine-install-failed', machineId, message)
  }
}

async function copyCredentials(session: RemoteSession): Promise<boolean> {
  const credentials = readEnvCredentials(join(harnessHome(), '.env'))
  const apiKey = credentials.apiKey
  if (apiKey === undefined)
    return false
  const result = await session.exec(credentialsCopyCommand({
    apiKey,
    ...credentials.baseUrl === undefined ? {} : { baseUrl: credentials.baseUrl },
  }))
  if (result.code !== 0)
    throw new Error(`writing remote credentials failed: ${describeExecFailure(result.code, result.stderr)}`)
  return result.stdout.includes('copied')
}

function emit(machineId: MachineId): void {
  machineRuntimeDeps().emitStatus(machineId, machine.status(machineId))
}

function profileView(profile: MachineProfile): MachineView {
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

async function openSessionOrFail(
  machineId: MachineId,
  profile: MachineProfile,
  signal?: AbortSignal,
  onFail?: () => void,
): Promise<RemoteSession> {
  const target = ensureState(machineId)
  const generation = target.generation
  try {
    return await openTransportSession(profile, signal)
  }
  catch (error) {
    const message = redacted(machineId, describeSshFailure(error))
    if (generation === target.generation) {
      delete target.progress
      noteConnectFailure(machineId, message)
      onFail?.()
    }
    throw new RemoteError('machine-connect-failed', machineId, message)
  }
}

function settlingEventSink(machineId: MachineId, onSettle: () => void): NonNullable<BootstrapHooks['onEvent']> {
  return (stage, line, options) => {
    if (options?.terminal !== undefined)
      onSettle()
    events.append(machineId, stage, line, options)
  }
}

function describeSshFailure(error: unknown): string {
  return messageOf(error) || 'SSH connection failed'
}
