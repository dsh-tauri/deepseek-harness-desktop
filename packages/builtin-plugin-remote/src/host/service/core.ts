import type { CoreProfileItem, CoreSlotState, CoreTarget, CoreTaskAccepted, CoreVersionItem } from '../../shared/core'
import type { MachineId, RemoteSession } from '../types/index'
import type { RemoteCoreCopy } from './core.utils'
import { defineService } from 'dsh-tauri'
import semver from 'semver'
import { REMOTE_CORE_CAPABILITIES, REMOTE_CORE_PLATFORMS, remoteCoreTargetId } from '../../shared/core'
import { messageOf } from '../../shared/error'
import { clearCoreInstallTask, coreInstallTask, hostConfig, hostRuntimeGeneration, registerCoreInstallTask } from '../config/runtime'
import { assertSupportedDshVersion, isPreviewTag, listGithubReleases, MINIMUM_DSH_VERSION, parseVersionFromTag, pkgRepoOf } from '../utils/version'
import { buildCoreVersionInstallScript, createBootstrapLineDispatcher, describeExecFailure, parseBootstrapLine, planRemoteVersionInstall } from './bootstrap.utils'
import { parseRemoteCopies, remoteCopiesProbeCommand } from './core.utils'
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
})

async function readRemoteCopies(session: RemoteSession): Promise<RemoteCoreCopy[]> {
  const result = await session.exec(remoteCopiesProbeCommand())
  if (result.code !== 0)
    throw new Error(`REMOTE_DSH_STATE_UNKNOWN: ${describeExecFailure(result.code, result.stderr)}`)
  return parseRemoteCopies(result.stdout)
}

function slotOf(copy: RemoteCoreCopy, isActive: boolean): CoreSlotState {
  const path = copy.entry === undefined ? {} : { path: copy.entry }
  if (copy.unreadable !== undefined) {
    return {
      kind: 'unreadable',
      slotKey: copy.name,
      ...isActive ? {} : { tag: copy.name },
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
      ...isActive ? {} : { tag: copy.name },
      ...path,
      dir: copy.dir,
      error: messageOf(error),
    }
  }
  return {
    kind: 'installed',
    slotKey: copy.name,
    version,
    ...isActive ? {} : { tag: copy.name },
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
