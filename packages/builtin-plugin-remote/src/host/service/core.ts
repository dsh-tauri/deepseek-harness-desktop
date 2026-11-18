import type { CoreProfileItem, CoreSlotState, CoreTarget, CoreTaskAccepted, CoreVersionItem } from '../../shared/core'
import type { MachineId, RemoteSession } from '../types/index'
import type { RemoteCoreCopy } from './core.utils'
import { defineService } from 'dsh-tauri'
import semver from 'semver'
import { REMOTE_CORE_CAPABILITIES, REMOTE_CORE_PLATFORMS, remoteCoreTargetId } from '../../shared/core'
import { messageOf } from '../../shared/error'
import { clearCoreInstallTask, coreInstallTask, hostConfig, hostRuntimeGeneration, registerCoreInstallTask } from '../config/runtime'
import { remoteInstanceStopCommand } from '../utils/instance'
import { assertSupportedDshVersion, isPreviewTag, listGithubReleases, MINIMUM_DSH_VERSION, parseVersionFromTag, pkgRepoOf } from '../utils/version'
import { buildCoreVersionInstallScript, createBootstrapLineDispatcher, describeExecFailure, parseBootstrapLine, planRemoteVersionInstall } from './bootstrap.utils'
import { buildCoreSwitchRollbackScript, buildCoreSwitchScript, fallbackActiveTag, parseRemoteCopies, remoteCopiesProbeCommand } from './core.utils'
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
  let suspended = false
  let switched = false
  let backupTag: string | undefined
  let restoreTag: string | undefined
  try {
    session = await machine.openSession(machineId)
    tasks.append(taskId, 'probe', `检查核心副本 ${slotKey}`)
    const copies = await readRemoteCopies(session)
    const active = copies.find(copy => copy.name === 'dsh')
    const target = copies.find(copy => copy.name === slotKey)
    if (active === undefined)
      throw new Error('REMOTE_CORE_SWITCH_FAILED: 当前使用的核心副本不存在')
    if (target === undefined || target.unreadable !== undefined || target.version === undefined)
      throw new Error(`REMOTE_CORE_SWITCH_FAILED: 目标核心副本 ${slotKey} 不存在或不可读`)
    assertSupportedDshVersion(target.version)
    restoreTag = active.tag
    backupTag = uniqueBackupTag(copies.map(copy => copy.name), active.tag ?? fallbackActiveTag(active.version), slotKey)

    tasks.append(taskId, 'switch', '停止远端核心实例')
    await machine.beginSwitch(machineId)
    suspended = true
    const profile = machineProfileOf(machineId)
    const stopped = await session.exec([
      ...remoteInstanceStopCommand(profile.name, profile.port),
      'sleep 1',
      'true',
    ].join('\n'))
    if (stopped.code !== 0)
      throw new Error(`REMOTE_CORE_SWITCH_STOP_FAILED: ${describeExecFailure(stopped.code, stopped.stderr)}`)

    tasks.append(taskId, 'switch', `互换核心目录 ${slotKey}`)
    const swapped = await session.exec(buildCoreSwitchScript(slotKey, backupTag, taskId), { timeoutMs: 30_000 })
    if (swapped.code !== 0)
      throw new Error(swapped.stderr.trim() || swapped.stdout.trim() || 'REMOTE_CORE_SWITCH_FAILED: 互换核心目录失败')
    switched = true

    tasks.append(taskId, 'launch', `拉起远端核心 ${target.version}`)
    await machine.reconnect(machineId)
    tasks.append(taskId, 'switch', `核心已切换至 ${target.version}`, { terminal: 'success' })
  }
  catch (error) {
    const original = messageOf(error)
    const recovery = suspended
      ? await recoverSwitch(machineId, session, slotKey, backupTag, restoreTag, switched, taskId)
      : ''
    const reason = `${normalizeSwitchFailure(original)}${recovery === '' ? '' : `；${recovery}`}`
    tasks.append(taskId, 'failed', reason, { terminal: 'failed', reason })
  }
  finally {
    if (session !== undefined)
      await session.close().catch(() => undefined)
  }
}

async function recoverSwitch(
  machineId: MachineId,
  session: RemoteSession | undefined,
  slotKey: string,
  backupTag: string | undefined,
  restoreTag: string | undefined,
  switched: boolean,
  taskId: string,
): Promise<string> {
  let recoverySession = session
  let closeRecovery = false
  const notes: string[] = []
  try {
    if (switched && backupTag !== undefined) {
      tasks.append(taskId, 'rollback', '恢复切换前的核心')
      try {
        if (recoverySession === undefined)
          throw new Error('missing session')
        await recoverySession.exec([
          ...remoteInstanceStopCommand(machineProfileOf(machineId).name, machineProfileOf(machineId).port),
          'sleep 1',
          'true',
        ].join('\n'))
      }
      catch {
        recoverySession = await machine.openSession(machineId)
        closeRecovery = true
        await recoverySession.exec([
          ...remoteInstanceStopCommand(machineProfileOf(machineId).name, machineProfileOf(machineId).port),
          'sleep 1',
          'true',
        ].join('\n')).catch(() => undefined)
      }
      const rollback = await recoverySession.exec(buildCoreSwitchRollbackScript(slotKey, backupTag, restoreTag, `${taskId}-rollback`), { timeoutMs: 30_000 })
      if (rollback.code !== 0)
        notes.push(`目录回滚失败：${rollback.stderr.trim() || rollback.stdout.trim() || `exit ${rollback.code ?? '?'}`}`)
      else
        notes.push('目录已回滚')
    }
    try {
      await machine.reconnect(machineId)
      notes.push('旧版本已重新连接')
    }
    catch (error) {
      notes.push(`旧版本重连失败：${messageOf(error)}`)
    }
  }
  catch (error) {
    notes.push(`自动回滚失败：${messageOf(error)}`)
  }
  finally {
    if (closeRecovery && recoverySession !== undefined)
      await recoverySession.close().catch(() => undefined)
  }
  return notes.join('；')
}

function uniqueBackupTag(names: string[], preferred: string, target: string): string {
  const occupied = new Set(names.filter(name => name !== 'dsh'))
  let candidate = preferred
  let suffix = 1
  while (!/^[\w.-]+$/u.test(candidate) || candidate === 'dsh' || candidate === target || occupied.has(candidate)) {
    candidate = `${preferred}-previous${suffix === 1 ? '' : `-${suffix}`}`
    suffix += 1
  }
  return candidate
}

function machineProfileOf(machineId: MachineId): { name: string, port: number } {
  const profile = machine.profile(machineId)
  return { name: profile.profileName ?? machine.profileName(machineId), port: profile.remotePort }
}

function normalizeSwitchFailure(message: string): string {
  return message.startsWith('REMOTE_CORE_SWITCH') || message.startsWith('REMOTE_DSH_VERSION_UNSUPPORTED')
    ? message
    : `REMOTE_CORE_SWITCH_FAILED: ${message}`
}
