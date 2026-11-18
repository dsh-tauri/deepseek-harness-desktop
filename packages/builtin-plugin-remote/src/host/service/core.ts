import type { CoreProfileItem, CoreSlotState, CoreTarget, CoreTaskAccepted, CoreVersionItem } from '../../shared/core'
import type { MachineId, MachineProfile, RemoteSession } from '../types/index'
import type { RemoteCoreCopy } from './core.utils'
import type { CoreSwitchLease } from './machine.types'
import { defineService } from 'dsh-tauri'
import semver from 'semver'
import { REMOTE_CORE_CAPABILITIES, REMOTE_CORE_PLATFORMS, remoteCoreTargetId } from '../../shared/core'
import { messageOf } from '../../shared/error'
import { REMOTE_ROOT } from '../config/constants'
import { clearCoreInstallTask, coreInstallTask, hostConfig, hostRuntimeGeneration, registerCoreInstallTask } from '../config/runtime'
import { assertSupportedDshVersion, isPreviewTag, listGithubReleases, MINIMUM_DSH_VERSION, parseVersionFromTag, pkgRepoOf } from '../utils/version'
import { BOOTSTRAP_LOG_PREFIX, buildCoreVersionInstallScript, createBootstrapLineDispatcher, describeExecFailure, parseBootstrapLine, planRemoteVersionInstall, startCommandFor } from './bootstrap.utils'
import { buildCoreSwitchRestoreScript, buildCoreSwitchScript, fallbackActiveTag, parseRemoteCopies, remoteCopiesProbeCommand } from './core.utils'
import { machine } from './machine'
import { tasks } from './tasks'

export const core = defineService({
  async listProfiles(machineId: MachineId): Promise<CoreProfileItem[]> {
    const configured = machine.profileName(machineId)
    const session = await machine.openSession(machineId)
    try {
      const result = await session.exec([
        'DIR="$HOME/.dsh/profiles"',
        '[ -d "$DIR" ] || exit 0',
        'if [ ! -r "$DIR" ] || [ ! -x "$DIR" ]; then',
        '  echo "REMOTE_PROFILES_UNREADABLE" >&2',
        '  exit 1',
        'fi',
        'if ! ls -A "$DIR" >/dev/null 2>&1; then',
        '  echo "REMOTE_PROFILES_UNREADABLE" >&2',
        '  exit 1',
        'fi',
        'for profile in "$DIR"/*; do',
        '  [ -d "$profile" ] || continue',
        '  basename "$profile"',
        'done',
      ].join('\n'))
      if (result.code !== 0)
        throw new Error(`REMOTE_CORE_PROFILES_UNREADABLE: ${describeExecFailure(result.code, result.stderr)}`)
      const names = result.stdout.split('\n')
        .map(name => name.trim())
        .filter(name => /^[\w-]+$/u.test(name))
      return [...new Set([configured, ...names])]
        .sort((left, right) => left.localeCompare(right))
        .map(name => ({ name, configured: name === configured }))
    }
    finally {
      await session.close().catch(() => undefined)
    }
  },

  async listVersions(): Promise<CoreVersionItem[]> {
    const releases = await listGithubReleases(pkgRepoOf(hostConfig().installRepo))
    const byVersion = new Map<string, CoreVersionItem>()
    for (const release of releases) {
      const version = parseVersionFromTag(release.tag)
      if (version === undefined || !semver.satisfies(version, `>=${MINIMUM_DSH_VERSION}`, { includePrerelease: true }))
        continue
      byVersion.set(version, {
        version,
        tag: release.tag,
        preview: release.prerelease || isPreviewTag(release.tag),
      })
    }
    return [...byVersion.values()].sort((left, right) => compareVersionsDesc(left.version, right.version))
  },

  async resolve(machineId: MachineId): Promise<CoreTarget> {
    const remoteProfile = machine.profileName(machineId)
    const base = {
      id: remoteCoreTargetId(machineId, remoteProfile),
      scope: 'remote' as const,
      machineId,
      remoteProfile,
      capabilities: [...REMOTE_CORE_CAPABILITIES],
      platforms: [...REMOTE_CORE_PLATFORMS],
    }
    const session = await machine.openSession(machineId)
    try {
      const copies = await readRemoteCopies(session)
      const active = copies.find(copy => copy.name === 'dsh')
      if (active !== undefined && active.unreadable !== undefined) {
        return {
          ...base,
          availability: 'unreadable',
          error: active.unreadable,
          ...active.entry === undefined ? {} : { path: active.entry },
          slots: [],
        }
      }
      if (copies.length === 0)
        return { ...base, availability: 'absent', slots: [] }
      return {
        ...base,
        availability: 'present',
        slots: copies.map(copy => slotOf(copy, copy.name === 'dsh')),
      }
    }
    catch (error) {
      return {
        ...base,
        availability: 'unreadable',
        error: `REMOTE_DSH_STATE_UNKNOWN: ${messageOf(error)}`,
        slots: [],
      }
    }
    finally {
      await session.close().catch(() => undefined)
    }
  },

  async installVersion(machineId: MachineId, tag: string, options: { force?: boolean } = {}): Promise<CoreTaskAccepted> {
    if (!/^[\w.-]+$/u.test(tag))
      throw new Error(`REMOTE_CORE_SLOT_INVALID: 非法版本目录名 ${tag}`)
    const existing = coreInstallTask(machineId, tag)
    if (existing !== undefined)
      return { taskId: existing }
    const remoteProfile = machine.profileName(machineId)
    const accepted = tasks.create('installVersion', remoteCoreTargetId(machineId, remoteProfile))
    const generation = hostRuntimeGeneration()
    const abort = new AbortController()
    registerCoreInstallTask(machineId, tag, accepted.taskId, abort)
    void installVersionTask(machineId, tag, options.force === true, accepted.taskId, generation, abort)
    return accepted
  },

  async switchVersion(machineId: MachineId, slotKey: string): Promise<CoreTaskAccepted> {
    if (!/^[\w.-]+$/u.test(slotKey) || slotKey === 'dsh')
      throw new Error(`REMOTE_CORE_SLOT_INVALID: 非法目标槽位 ${slotKey}`)
    const remoteProfile = machine.profileName(machineId)
    const accepted = tasks.create('activate', remoteCoreTargetId(machineId, remoteProfile))
    void switchVersionTask(machineId, slotKey, accepted.taskId)
    return accepted
  },
})

async function readRemoteCopies(session: RemoteSession): Promise<RemoteCoreCopy[]> {
  const result = await session.exec(remoteCopiesProbeCommand())
  if (result.code !== 0)
    throw new Error(`REMOTE_DSH_STATE_UNKNOWN: ${describeExecFailure(result.code, result.stderr)}`)
  return parseRemoteCopies(result.stdout)
}

function slotOf(copy: RemoteCoreCopy, isActive: boolean): CoreSlotState {
  const path = copy.entry === undefined ? {} : { path: copy.entry }
  const slotTag = copy.tag ?? (isActive ? undefined : copy.name)
  if (copy.unreadable !== undefined) {
    return {
      kind: 'unreadable',
      slotKey: copy.name,
      ...slotTag === undefined ? {} : { tag: slotTag },
      ...path,
      dir: copy.dir,
      error: copy.unreadable,
    }
  }
  const version = copy.version ?? ''
  try {
    assertSupportedDshVersion(version)
  }
  catch (error) {
    return {
      kind: 'unsupported',
      slotKey: copy.name,
      version,
      ...slotTag === undefined ? {} : { tag: slotTag },
      ...path,
      dir: copy.dir,
      error: messageOf(error),
    }
  }
  return {
    kind: 'installed',
    slotKey: copy.name,
    version,
    ...slotTag === undefined ? {} : { tag: slotTag },
    ...path,
    dir: copy.dir,
    active: isActive,
    removable: !isActive,
    preview: semver.prerelease(version) !== null,
  }
}

function compareVersionsDesc(left: string, right: string): number {
  const leftVersion = semver.parse(left)
  const rightVersion = semver.parse(right)
  if (leftVersion !== null && rightVersion !== null)
    return rightVersion.compare(leftVersion)
  return right.localeCompare(left)
}

async function installVersionTask(machineId: MachineId, tag: string, force: boolean, taskId: string, generation: number, abort: AbortController): Promise<void> {
  let session: RemoteSession | undefined
  const closeOnAbort = (): void => {
    void session?.close().catch(() => undefined)
  }
  abort.signal.addEventListener('abort', closeOnAbort, { once: true })
  try {
    if (generation !== hostRuntimeGeneration())
      throw new Error('REMOTE_CORE_INSTALL_CANCELLED: 运行时已重置')
    session = await machine.openSession(machineId, abort.signal)
    if (generation !== hostRuntimeGeneration())
      throw new Error('REMOTE_CORE_INSTALL_CANCELLED: 运行时已重置')
    try {
      const uname = await session.exec('uname -srm')
      if (uname.code !== 0)
        throw new Error(`REMOTE_CORE_TARGET_UNREACHABLE: 无法探测远端平台（exit ${uname.code}）`)
      // 先核对代次再读配置：重置与重新装配若发生在等待 uname 期间，
      // 旧任务不能拿着新配置去查询发布资产。
      if (generation !== hostRuntimeGeneration())
        throw new Error('REMOTE_CORE_INSTALL_CANCELLED: 运行时已重置')
      const plan = await planRemoteVersionInstall(uname.stdout, hostConfig(), tag)
      if (generation !== hostRuntimeGeneration())
        throw new Error('REMOTE_CORE_INSTALL_CANCELLED: 运行时已重置')
      tasks.append(taskId, 'probe', `准备下载核心版本 ${plan.tag}`)
      for (const note of plan.notes)
        tasks.append(taskId, 'probe', note)
      const dispatch = createBootstrapLineDispatcher((line) => {
        const parsed = parseBootstrapLine(line)
        tasks.append(taskId, parsed.stage, parsed.line)
      })
      const result = await session.exec(buildCoreVersionInstallScript(plan, { slot: tag, force }), {
        timeoutMs: hostConfig().installTimeoutMs ?? 1_800_000,
        onData: chunk => dispatch.push(chunk),
      })
      dispatch.flush()
      if (result.code !== 0) {
        const stream = result.stderr.trim() === '' ? result.stdout.trim() : result.stderr.trim()
        const tail = stream === '' ? '(无输出)' : stream.split('\n').slice(-5).join(' | ')
        throw new Error(`REMOTE_CORE_INSTALL_FAILED: 远端安装 ${plan.tag} 失败（exit ${result.code}）：${tail}`)
      }
      tasks.append(taskId, 'install', `已下载核心版本 ${plan.tag}`, { terminal: 'success' })
    }
    finally {
      await session.close().catch(() => undefined)
    }
  }
  catch (error) {
    const message = messageOf(error)
    tasks.append(taskId, 'failed', message, { terminal: 'failed', reason: message })
  }
  finally {
    abort.signal.removeEventListener('abort', closeOnAbort)
    await session?.close().catch(() => undefined)
    clearCoreInstallTask(machineId, tag, taskId)
  }
}

async function switchVersionTask(machineId: MachineId, slotKey: string, taskId: string): Promise<void> {
  let session: RemoteSession | undefined
  let lease: CoreSwitchLease | undefined
  let switched = false
  let backupTag: string | undefined
  // 固定这台机器的主机与档案：任务期间配置变了就不能继续在旧会话上操作。
  let identity = ''
  try {
    identity = profileIdentityOf(machine.profile(machineId))
    session = await machine.openSession(machineId)
    tasks.append(taskId, 'probe', `检查核心副本 ${slotKey}`)
    const copies = await readRemoteCopies(session)
    const active = copies.find(copy => copy.name === 'dsh')
    const target = copies.find(copy => copy.name === slotKey)
    if (active === undefined)
      throw new Error('REMOTE_CORE_SWITCH_FAILED: 当前使用的核心副本不存在')
    if (target === undefined || target.unreadable !== undefined || target.version === undefined || target.entry === undefined)
      throw new Error(`REMOTE_CORE_SWITCH_FAILED: 目标核心副本 ${slotKey} 不存在或不可读`)
    // 旧核心的入口路径也要知道：连接没建起来时要靠它把旧核心换回去。
    if (active.entry === undefined)
      throw new Error('REMOTE_CORE_SWITCH_FAILED: 当前使用的核心副本不可读，无法切换')
    assertSupportedDshVersion(target.version)
    const candidates = backupCandidatesOf(copies, active, slotKey)

    // 自定义启动命令可能拉起另一份核心：目录换���它也不跟着换，这种机器不能切。
    const profile = machine.profile(machineId)
    if (profile.startCommand !== undefined)
      throw new Error('REMOTE_CORE_SWITCH_FAILED: 该机器配置了自定义启动命令，无法保证切换到目标副本')

    lease = await machine.beginSwitch(machineId)
    // 机器配置在切换期间变了：现在操作的不是刚才那台机器，不能继续动它的目录，
    // 也不能替用户把这台新机器连起来。
    if (profileIdentityOf(machine.profile(machineId)) !== identity)
      throw new Error('REMOTE_CORE_SWITCH_ABORTED: 远端机器配置在切换期间发生变化')

    const config = hostConfig()
    const entryRelativePath = switchEntryRelative(target.entry, slotKey)
    const startCommand = startCommandFor(profile, undefined, { dshBin: switchEntryPath(entryRelativePath) })
    let failure: string | undefined
    for (const candidate of candidates) {
      // 派发前先确认租约还在：用户断开或改了配置就别再动远端目录了。
      if (!machine.switchLeaseValid(lease))
        throw new Error('REMOTE_CORE_SWITCH_ABORTED: 连接已被重置，切换已中止')
      const outcome = await runSwitchScript(session, {
        targetTag: slotKey,
        backupTag: candidate,
        runId: taskId,
        // 停实例用的档案名要与拉起时用的完全一致：拉起走的是 safeProfileName，
        // 这里也必须用它规范化过的名字，否则进程匹配不上，等于没停。
        profileName: machine.profileName(machineId),
        remotePort: profile.remotePort,
        startCommand,
        entryRelativePath,
        healthPollAttempts: config.healthPollAttempts,
        healthPollIntervalMs: config.healthPollIntervalMs,
        activeVersion: active.version,
        targetVersion: target.version,
      })
      if (outcome.ok) {
        switched = true
        backupTag = candidate
        break
      }
      failure = outcome.message
      // 只有备份槽位被别人占了才换一个候选；其它失败重试没有意义。
      if (!outcome.backupTaken || outcome.unknown)
        break
    }
    if (!switched)
      throw new Error(failure ?? 'REMOTE_CORE_SWITCH_FAILED: 互换核心目录失败')

    tasks.append(taskId, 'launch', `重建远端连接 ${target.version}`)
    // 用户在这期间断开或改了配置时，租约失效：不再替他重建连接。
    if (!machine.switchLeaseValid(lease)) {
      tasks.append(taskId, 'switch', `核心已切换至 ${target.version}，但连接已被重置`, { terminal: 'success' })
      return
    }
    // 配置在互换目录期间又变了：目录已经换好，但不能拿新配置去连。
    if (profileIdentityOf(machine.profile(machineId)) !== identity) {
      tasks.append(taskId, 'switch', `核心已切换至 ${target.version}，但远端机器配置已变更，未重建连接`, { terminal: 'success' })
      return
    }
    try {
      await machine.reconnect(machineId, { profileSync: false, lease, dshBin: switchEntryPath(entryRelativePath) })
    }
    catch (error) {
      // 目录已经换成新核心了，连接却没建起来：把它换回旧核心。
      // 只报失败却把远端留在新核心上，用户看到的和实际发生的对不上。
      const restored = await restoreOldCore(session, {
        machineId,
        lease,
        taskId,
        targetTag: slotKey,
        backupTag: backupTag!,
        restoreTag: active.tag,
        profile,
        activeEntry: active.entry,
      })
      const reason = restored
        ? `核心已切换至 ${target.version}，但连接没能恢复；已切回旧核心`
        : `核心已切换至 ${target.version}，但连接没能恢复，旧核心也没切回来：${messageOf(error)}`
      tasks.append(taskId, 'failed', reason, { terminal: 'failed', reason })
      return
    }
    tasks.append(taskId, 'switch', `核心已切换至 ${target.version}`, { terminal: 'success' })
  }
  catch (error) {
    const original = messageOf(error)
    // 机器配置变了：这时连上去的是另一台机器，不能替他重建连接。
    if (original.includes('REMOTE_CORE_SWITCH_ABORTED')) {
      const reason = `${original}；未改动远端目录，也未重建连接`
      tasks.append(taskId, 'failed', reason, { terminal: 'failed', reason })
      return
    }
    // 脚本没恢复旧核心时，目录状态未知：这时不能直接重连，只能把情况说清楚。
    if (original.includes('REMOTE_CORE_SWITCH_UNRECOVERED')) {
      const reason = `${original}；远端核心目录可能处于中间状态，请在远端机器上确认后重试`
      tasks.append(taskId, 'failed', reason, { terminal: 'failed', reason })
      return
    }
    // 只有真的动过这台机器才需要恢复：切换在拿到所有权之前就失败的话，
    // 连接是用户自己的状态，不能替他重连（那会把用户刚做的断开撤销掉）。
    const recovery = switched || lease === undefined ? '' : await recoverOldCore(machineId, lease, identity, taskId)
    const reason = `${normalizeSwitchFailure(original)}${recovery === '' ? '' : `；${recovery}`}`
    tasks.append(taskId, 'failed', reason, { terminal: 'failed', reason })
  }
  finally {
    if (session !== undefined)
      await session.close().catch(() => undefined)
    // 任务结束（成功、失败或恢复结束）后把机器交还给普通连接。
    if (lease !== undefined)
      machine.endSwitch(lease)
  }
}

interface SwitchScriptOptions {
  targetTag: string
  backupTag: string
  runId: string
  profileName: string
  remotePort: number
  startCommand: string
  entryRelativePath: string
  healthPollAttempts: number
  healthPollIntervalMs: number
  activeVersion: string | undefined
  targetVersion: string | undefined
}

interface SwitchScriptOutcome {
  ok: boolean
  message: string
  backupTaken: boolean
  /** 脚本没给出结论（连接断了或超时）：远端目录状态未知，不能重试也不能重连。 */
  unknown: boolean
}

async function runSwitchScript(session: RemoteSession, options: SwitchScriptOptions): Promise<SwitchScriptOutcome> {
  const script = buildCoreSwitchScript(options)
  const timeoutMs = Math.max(60_000, options.healthPollAttempts * options.healthPollIntervalMs + 60_000)
  let result: Awaited<ReturnType<RemoteSession['exec']>>
  try {
    result = await session.exec(script, { timeoutMs })
  }
  catch (error) {
    // 连接断了或超时：远端脚本可能还在跑，目录状态未知。
    return {
      ok: false,
      message: `REMOTE_CORE_SWITCH_UNRECOVERED: 远端连接中断，核心目录状态未知：${messageOf(error)}`,
      backupTaken: false,
      unknown: true,
    }
  }
  if (result.code === 0)
    return { ok: true, message: '', backupTaken: false, unknown: false }
  const failure = switchFailureOf(`${result.stderr}\n${result.stdout}`, result.code)
  return {
    ok: false,
    message: failure.message,
    backupTaken: failure.message.includes('备份槽位已被占用') || failure.message.includes('REMOTE_CORE_SLOT_BUSY:backup'),
    unknown: !failure.fromScript,
  }
}

/** 结论行有两种写法：失败结论直接写 stderr，进度日志行带 `::dsh <阶段> ` 前缀。 */
function switchConclusionLines(output: string): string[] {
  const lines: string[] = []
  for (const raw of output.split('\n')) {
    const line = raw.trim()
    if (line === '')
      continue
    if (!line.startsWith(BOOTSTRAP_LOG_PREFIX)) {
      lines.push(line)
      continue
    }
    const rest = line.slice(BOOTSTRAP_LOG_PREFIX.length)
    const cut = rest.indexOf(' ')
    lines.push(cut < 0 ? rest : rest.slice(cut + 1))
  }
  return lines
}

function switchFailureOf(output: string, code: number | null): { message: string, fromScript: boolean } {
  // 槽位被占用也是脚本给出的明确结论：目录没被动过，不能当成「状态未知」去惊动用户。
  const line = switchConclusionLines(output)
    .filter(item => item.startsWith('REMOTE_CORE_SWITCH') || item.startsWith('REMOTE_CORE_SLOT_BUSY'))
    .at(-1)
  if (line !== undefined)
    return { message: line, fromScript: true }
  const tail = output.trim().split('\n').slice(-3).join(' | ')
  return { message: `REMOTE_CORE_SWITCH_FAILED: 切换脚本失败（exit ${code ?? '?'}）${tail === '' ? '' : `：${tail}`}`, fromScript: false }
}

/** 切换没成功时把旧核心重新拉起来：目录已经换回去了，只需要重建连接。 */
async function recoverOldCore(machineId: MachineId, lease: CoreSwitchLease, identity: string, taskId: string): Promise<string> {
  if (!machine.switchLeaseValid(lease))
    return '连接已被重置，未重建连接'
  // 档案身份变了就不要再连：现在连上去的是另一台机器。
  if (profileIdentityOf(machine.profile(machineId)) !== identity)
    return '远端机器配置已变更，未重建连接'
  try {
    await machine.reconnect(machineId, { profileSync: false, lease })
    tasks.append(taskId, 'rollback', '旧版本已重新连接')
    return '旧版本已重新连接'
  }
  catch (error) {
    return `旧版本重连失败：${messageOf(error)}`
  }
}

interface RestoreOldCoreOptions {
  machineId: MachineId
  lease: CoreSwitchLease
  taskId: string
  targetTag: string
  backupTag: string
  restoreTag: string | undefined
  profile: MachineProfile
  activeEntry: string
}

/**
 * 连接没建起来时把旧核心换回去：目录已经换成新核心了，
 * 只报失败会让远端停在新核心上，用户看到的和实际发生的对不上。
 */
async function restoreOldCore(session: RemoteSession, options: RestoreOldCoreOptions): Promise<boolean> {
  if (!machine.switchLeaseValid(options.lease))
    return false
  const config = hostConfig()
  const startCommand = startCommandFor(options.profile, undefined, {
    dshBin: switchEntryPath(switchEntryRelative(options.activeEntry, 'dsh')),
  })
  tasks.append(options.taskId, 'rollback', '连接未恢复，切回旧核心')
  try {
    const result = await session.exec(buildCoreSwitchRestoreScript({
      targetTag: options.targetTag,
      backupTag: options.backupTag,
      runId: `${options.taskId}-restore`,
      profileName: machine.profileName(options.machineId),
      remotePort: options.profile.remotePort,
      startCommand,
      ...options.restoreTag === undefined ? {} : { restoreTag: options.restoreTag },
      healthPollAttempts: config.healthPollAttempts,
      healthPollIntervalMs: config.healthPollIntervalMs,
    }), { timeoutMs: Math.max(60_000, config.healthPollAttempts * config.healthPollIntervalMs + 60_000) })
    return result.code === 0
  }
  catch (error) {
    console.error('[remote] restore old core failed:', error)
    return false
  }
}

function backupCandidatesOf(copies: RemoteCoreCopy[], active: RemoteCoreCopy, target: string): string[] {
  const occupied = new Set(copies.map(copy => copy.name))
  const preferred = active.tag ?? fallbackActiveTag(active.version)
  const candidates: string[] = []
  for (const name of [preferred, `${preferred}-previous`, `${preferred}-previous-2`]) {
    if (!/^[\w.-]+$/u.test(name) || name === 'dsh' || name === target || occupied.has(name))
      continue
    candidates.push(name)
  }
  if (candidates.length === 0)
    throw new Error('REMOTE_CORE_SWITCH_FAILED: 没有可用的备份槽位')
  return candidates
}

/** 目标副本换到活动目录后，入口路径要跟着换过去。 */
function switchEntryRelative(entry: string, targetTag: string): string {
  const marker = `dependencies/${targetTag}/`
  const index = entry.indexOf(marker)
  if (index < 0)
    throw new Error(`REMOTE_CORE_SLOT_INVALID: 目标核心入口路径与槽位不符 ${entry}`)
  return entry.slice(index + marker.length)
}

function switchEntryPath(relativePath: string): string {
  return `$HOME/${REMOTE_ROOT}/dependencies/dsh/${relativePath}`
}

function profileIdentityOf(profile: MachineProfile): string {
  return [profile.host, profile.user, profile.port, profile.remotePort, profile.profileName ?? ''].join('\u0000')
}

function normalizeSwitchFailure(message: string): string {
  return message.startsWith('REMOTE_CORE_SWITCH') || message.startsWith('REMOTE_DSH_VERSION_UNSUPPORTED')
    ? message
    : `REMOTE_CORE_SWITCH_FAILED: ${message}`
}
