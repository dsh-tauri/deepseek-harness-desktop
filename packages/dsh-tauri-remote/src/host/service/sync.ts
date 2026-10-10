import type { Buffer } from 'node:buffer'
import type { MachineId, RemoteSession, SyncApplyResult, SyncItemResult, SyncPluginRef, SyncPreview, SyncSkillRef, SyncSkillRoot } from '../types/index'
import type { SyncDeps } from './sync.types'
import { defineService } from 'dsh-tauri'
import { syncRuntimeDeps } from '../config/runtime'
import { carryWorkspaceAllowlist, parseBuildAllowKeys } from '../utils/allowlist'
import { dshEntryProbeCommand, firstLineOf } from './bootstrap.utils'
import { machine } from './machine'
import { buildPreview, dedupeBy, describeFailure, failureLogOf, installSpecOf, pluginAddCommand, skillExtractCommand } from './sync.utils'

export const sync = defineService({
  preview(): SyncPreview {
    const deps = syncRuntimeDeps()
    return buildPreview(deps.profileDependencies(), deps.scanSkills())
  },

  async apply(machineId: MachineId, plugins: readonly SyncPluginRef[], skills: readonly SyncSkillRef[]): Promise<SyncApplyResult> {
    const deps = syncRuntimeDeps()
    const items: SyncItemResult[] = []
    const uniquePlugins = dedupeBy(plugins, ref => ref.spec)
    const uniqueSkills = dedupeBy(skills, ref => `${ref.root}:${ref.name}`)
    if (uniquePlugins.length === 0 && uniqueSkills.length === 0)
      return { items }
    await machine.syncProfiles()
    const profileName = machine.profileName(machineId)
    const progress: SyncProgress = { settled: 0, total: uniquePlugins.length + uniqueSkills.length }
    const session = await machine.openSession(machineId)
    try {
      if (uniquePlugins.length > 0)
        await carryWorkspaceAllowlist(session, profileName, machine.localAllowlist()).then(() => undefined).catch(() => undefined)
      await applyPlugins(session, deps, uniquePlugins, items, progress, machineId, profileName)
      await applySkills(session, deps, uniqueSkills, items, progress, machineId)
    }
    finally {
      await session.close().catch(() => undefined)
      machine.setProgress(machineId)
    }
    return { items }
  },
})

// --- internal ---

interface SyncProgress {
  settled: number
  total: number
}

function announceItem(machineId: MachineId, progress: SyncProgress, name: string): void {
  machine.setProgress(machineId, { phase: 'syncing', attempt: progress.settled + 1, total: progress.total, item: name })
}

async function applyPlugins(
  session: RemoteSession,
  deps: SyncDeps,
  plugins: readonly SyncPluginRef[],
  items: SyncItemResult[],
  progress: SyncProgress,
  machineId: MachineId,
  profileName: string,
): Promise<void> {
  if (plugins.length === 0)
    return
  const dshEntry = firstLineOf((await session.exec(dshEntryProbeCommand())).stdout)
  for (const plugin of plugins) {
    announceItem(machineId, progress, plugin.name)
    if (dshEntry === '') {
      items.push({
        kind: 'plugin',
        name: plugin.name,
        ok: false,
        error: 'no dsh entry under the remote ~/.dsh-desktop install layout; run the machine install first',
      })
      continue
    }
    const deadline = deps.commandTimeoutMs === undefined ? {} : { timeoutMs: deps.commandTimeoutMs }
    const command = pluginAddCommand(dshEntry, installSpecOf(plugin.name, plugin.spec), profileName)
    let result = await session.exec(command, deadline)
    if (result.code !== 0) {
      const granted = await grantBuildKeys(session, profileName, `${result.stdout}\n${result.stderr}`)
      if (granted.length > 0)
        result = await session.exec(command, deadline)
    }
    if (result.code === 0) {
      items.push({ kind: 'plugin', name: plugin.name, ok: true })
    }
    else {
      const log = failureLogOf(result.stdout, result.stderr)
      items.push({
        kind: 'plugin',
        name: plugin.name,
        ok: false,
        error: describeFailure(result.code, result.stdout, result.stderr),
        ...log === undefined ? {} : { log },
      })
    }
    progress.settled += 1
  }
}

async function grantBuildKeys(session: RemoteSession, profileName: string, output: string): Promise<string[]> {
  const keys = parseBuildAllowKeys(output)
  if (keys.length === 0)
    return []
  return carryWorkspaceAllowlist(session, profileName, {
    allowBuilds: Object.fromEntries(keys.map(key => [key, true])),
    onlyBuiltDependencies: [],
  })
}

async function applySkills(
  session: RemoteSession,
  deps: SyncDeps,
  skills: readonly SyncSkillRef[],
  items: SyncItemResult[],
  progress: SyncProgress,
  machineId: MachineId,
): Promise<void> {
  if (skills.length === 0)
    return
  const roots = new Map(deps.scanSkills().map(entry => [entry.root as SyncSkillRoot, entry]))
  for (const [root, entry] of roots) {
    const requested = skills.filter(skill => skill.root === root)
    if (requested.length === 0)
      continue
    const known = new Set(entry.names)
    const transferable: SyncSkillRef[] = []
    for (const skill of requested) {
      if (known.has(skill.name)) {
        transferable.push(skill)
      }
      else {
        items.push({
          kind: 'skill',
          name: skill.name,
          root,
          ok: false,
          error: `not found under the local "${root}" skill root (it may have been removed)`,
        })
        progress.settled += 1
      }
    }
    if (transferable.length === 0)
      continue
    announceItem(machineId, progress, transferable[0]!.name)
    let tar: Buffer
    try {
      tar = await deps.packSkills(entry.dir, transferable.map(skill => skill.name))
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      for (const skill of transferable)
        items.push({ kind: 'skill', name: skill.name, root, ok: false, error: message })
      progress.settled += transferable.length
      continue
    }
    const result = await session.exec(skillExtractCommand(), {
      stdinData: tar,
      ...deps.commandTimeoutMs === undefined ? {} : { timeoutMs: deps.commandTimeoutMs },
    })
    const log = result.code === 0 ? undefined : failureLogOf(result.stdout, result.stderr)
    for (const skill of transferable) {
      items.push(
        result.code === 0
          ? { kind: 'skill', name: skill.name, root, ok: true }
          : {
              kind: 'skill',
              name: skill.name,
              root,
              ok: false,
              error: describeFailure(result.code, result.stdout, result.stderr),
              ...log === undefined ? {} : { log },
            },
      )
    }
    progress.settled += transferable.length
  }
}
