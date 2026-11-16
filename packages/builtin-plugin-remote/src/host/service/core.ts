import type { CoreProfileItem, CoreTarget, CoreTargetState, CoreVersionItem } from '../../shared/core'
import type { MachineId, RemoteSession } from '../types/index'
import { defineService } from 'dsh-tauri'
import semver from 'semver'
import { REMOTE_CORE_CAPABILITIES, REMOTE_CORE_PLATFORMS, remoteCoreTargetId } from '../../shared/core'
import { messageOf } from '../../shared/error'
import { hostConfig } from '../config/runtime'
import { assertSupportedDshVersion, isPreviewTag, listGithubReleases, MINIMUM_DSH_VERSION, parseVersionFromTag, pkgRepoOf } from '../utils/version'
import { describeExecFailure, dshEntryProbeCommand, firstLineOf, readRemoteDshPackage } from './bootstrap.utils'
import { machine } from './machine'

export const core = defineService({
  async listProfiles(machineId: MachineId): Promise<CoreProfileItem[]> {
    const configured = machine.profileName(machineId)
    const session = await machine.openSession(machineId)
    try {
      const result = await session.exec([
        'DIR="$HOME/.dsh/profiles"',
        '[ -d "$DIR" ] || exit 0',
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
    const versions: CoreVersionItem[] = []
    for (const release of releases) {
      const version = parseVersionFromTag(release.tag)
      if (version === undefined || !semver.satisfies(version, `>=${MINIMUM_DSH_VERSION}`, { includePrerelease: true })) {
        continue
      }
      versions.push({
        version,
        tag: release.tag,
        preview: release.prerelease || isPreviewTag(release.tag),
      })
    }
    return versions
  },

  async resolve(machineId: MachineId): Promise<CoreTarget> {
    const remoteProfile = machine.profileName(machineId)
    const session = await machine.openSession(machineId)
    try {
      const [packageState, entry] = await Promise.all([
        readRemoteDshPackage(session).catch(error => ({
          kind: 'unreadable' as const,
          error: `REMOTE_DSH_PACKAGE_UNREADABLE: ${messageOf(error)}`,
        })),
        readRemoteDshEntry(session),
      ])
      return {
        id: remoteCoreTargetId(machineId, remoteProfile),
        scope: 'remote',
        machineId,
        remoteProfile,
        capabilities: [...REMOTE_CORE_CAPABILITIES],
        platforms: [...REMOTE_CORE_PLATFORMS],
        ...targetStateOf(packageState, entry),
      }
    }
    finally {
      await session.close().catch(() => undefined)
    }
  },
})

interface RemoteDshEntry {
  path?: string
  error?: string
}

async function readRemoteDshEntry(session: RemoteSession): Promise<RemoteDshEntry> {
  try {
    const result = await session.exec(dshEntryProbeCommand())
    if (result.code !== 0)
      return { error: describeExecFailure(result.code, result.stderr) }
    const path = firstLineOf(result.stdout)
    return path === '' ? {} : { path }
  }
  catch (error) {
    return { error: messageOf(error) }
  }
}

function targetStateOf(packageState: Awaited<ReturnType<typeof readRemoteDshPackage>>, entry: RemoteDshEntry): CoreTargetState {
  const pathOfEntry = entry.path === undefined ? {} : { path: entry.path }
  if (packageState.kind === 'installed') {
    try {
      assertSupportedDshVersion(packageState.version)
      return {
        availability: 'present',
        slots: [{
          kind: 'installed',
          slotKey: 'current',
          version: packageState.version,
          ...pathOfEntry,
          active: true,
          preview: semver.prerelease(packageState.version) !== null,
        }],
      }
    }
    catch (error) {
      return {
        availability: 'present',
        slots: [{
          kind: 'unsupported',
          slotKey: 'current',
          version: packageState.version,
          ...pathOfEntry,
          error: messageOf(error),
        }],
      }
    }
  }
  if (packageState.kind === 'unreadable')
    return { availability: 'unreadable', ...pathOfEntry, error: packageState.error, slots: [] }
  if (entry.path !== undefined)
    return { availability: 'unreadable', path: entry.path, error: 'REMOTE_DSH_PACKAGE_INVALID: 安装入口存在但包元数据缺失', slots: [] }
  if (entry.error !== undefined)
    return { availability: 'unreadable', error: `REMOTE_DSH_STATE_UNKNOWN: ${entry.error}`, slots: [] }
  return { availability: 'absent', slots: [] }
}
