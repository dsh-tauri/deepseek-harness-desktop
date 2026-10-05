import type { Buffer } from 'node:buffer'
import type { MachineProfile, MachineSaveRow, MachineSecretWrite, MachineView, RemoteInstallResult, RemoteLink, RemoteMachineStatus, RemoteProgress, RemoteSession, RemoteTestResult } from '../types/index'
import type { WorkspaceAllowlist } from '../utils/allowlist'
import type { SshHostBlock } from '../utils/ssh-config'
import type { BootstrapHooks } from './bootstrap.types'
import type { MachineState, ReconnectState } from './machine.types'
import type { RemoteTransportCapabilities } from './transport.types'
import { defineService } from 'dsh-tauri'
import { join } from 'pathe'
import { DEFAULT_REMOTE_PORT, DEFAULT_SSH_PORT } from '../../shared/constants'
import { messageOf } from '../../shared/error'
import { DEFAULT_MACHINE_TRANSPORT, REMOTE_ROOT } from '../config/constants'
import { harnessHome, homeDirPath, hostConfig, machineProfiles, machineRuntimeDeps, machineStates, machineTable, sshDirPath } from '../config/runtime'
import { MachineId, RemoteError } from '../types/index'
import { carryWorkspaceAllowlist } from '../utils/allowlist'
import { syncBundledPlugins } from '../utils/plugins-sync'
import { discoverableHosts, loadSshConfigBlocks, lookupSshConfig, resolveSshAuth } from '../utils/ssh-config'
import { bootstrap } from './bootstrap'
import { checkMissingCommand, credentialsCopyCommand, describeExecFailure, ensurePnpmCommand, firstLineOf, missingComponentsOf, planRemoteInstall, readEnvCredentials, remoteWebTokenCommand, safeProfileName, skippedVerificationSummary } from './bootstrap.utils'
import { events } from './events'
import { gateway } from './gateway'
import { knownHosts } from './known-hosts'
import { fingerprintHostKey } from './known-hosts.utils'
import { state } from './state'

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

  async install(machineId: MachineId, signal?: AbortSignal): Promise<RemoteInstallResult> {
    const profile = requireProfile(machineId)
    requireCapabilities(machineId, profile, ['exec'])
    const target = ensureState(machineId)
    refuseWhileReconnecting(machineId, target)
    if (target.installing === undefined) {
      target.progress = { phase: 'installing' }
      emit(machineId)
      const attempt = performInstall(machineId, profile, signal)
      target.installing = attempt.finally(() => {
        delete machineStates.get(machineId)?.installing
      })
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

async function performConnect(machineId: MachineId, profile: MachineProfile, signal?: AbortSignal): Promise<RemoteLink> {
  const target = ensureState(machineId)
  const generation = target.generation
  let bootstrapSettled = false
  let portExhausted = false
  const onEvent = settlingEventSink(machineId, () => {
    bootstrapSettled = true
  })
  const session = await openSessionOrFail(machineId, profile, signal)
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
      entryPort = entry.port
    }
    catch (error) {
      await tunnel.close().catch(() => undefined)
      portExhausted = isGatewayPortExhausted(error)
      throw error
    }
    const unsubscribe = gateway.subscribe((event) => {
      if (event.id !== entryId || (event.kind !== 'stopped' && event.kind !== 'upstream'))
        return
      // 本回调与网关写回下游响应同处一条调用链：必须让当前响应先出网，否则拆除会截断响应体。
      setImmediate(() => {
        if (machineStates.get(machineId)?.gateway?.id !== entryId)
          return
        detach(machineId, `网关入口异常退出：${event.line}`)
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

/** 网关端口耗尽的判据：内核只在「候选全被登记表占用」或「每个候选都撞上 EADDRINUSE」时抛出，无人重试能改变这一点。 */
function isGatewayPortExhausted(error: unknown): boolean {
  const message = messageOf(error)
  return message.includes('网关端口全部占用') || message.includes('EADDRINUSE')
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
  target.lastError = reason
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
  if (target.reconnect !== undefined)
    return
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
  try {
    await performConnect(machineId, profile)
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

async function performInstall(machineId: MachineId, profile: MachineProfile, signal?: AbortSignal): Promise<RemoteInstallResult> {
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
    const missing = missingComponentsOf((await session.exec(checkMissingCommand())).stdout)
    const skips: string[] = []
    if (missing.length > 0) {
      onEvent('probe', `缺失组件: ${missing.join(', ')}`)
      skips.push(...await bootstrap.install(session, plan, {
        onEvent,
        onProgress: (progress) => {
          if (generation !== target.generation)
            return
          target.progress = progress
          emit(machineId)
        },
      }, 'install 失败'))
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
