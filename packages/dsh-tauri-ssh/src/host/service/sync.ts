/**
 * Plugin & skill sync (local → one remote machine): the S4-owned `sync.*`
 * surface behind `/api-ssh`. `preview` reads the local dsh profile's plugin
 * dependencies and the user-level skill roots; `apply` installs the selected
 * plugins on the remote (`<dsh> plugin --profile web add <spec>`, one exec
 * per plugin so every item earns its own outcome) and streams the selected
 * skills as a tarball over the command's stdin (`tar -xf -`). The apply
 * result is deliberately per-item — a partial failure must never hide
 * behind a batched error string (the defect this panel was rebuilt to fix).
 * Command builders are pure functions; the engine's fs/ssh seams are
 * injectable so tests never touch the network.
 * @module dsh-tauri-ssh/host/service/sync
 */

import type { Buffer } from 'node:buffer'
import type { MachineId, SyncApplyResult, SyncItemResult, SyncPluginItem, SyncPluginRef, SyncPreview, SyncSkillItem, SyncSkillRef, SyncSkillRoot } from '../types/index'
import type { SshSession } from './transport'
import { DEFAULT_REMOTE_PROFILE } from '../storage/index'
import { allowlistReadCommand, allowlistWriteCommand, mergeWorkspaceAllowlist, parseBuildAllowKeys } from './allowlist'
import { dshEntryProbeCommand, firstLineOf, layoutBinDir, layoutNodeBinary } from './bootstrap'
import { shQuote } from './transport'

/**
 * Fallback remote profile for plugin installs when the caller names none —
 * the same default the tunnel bootstrap serves ({@link DEFAULT_REMOTE_PROFILE}).
 * Callers that know the machine (the `/api-ssh` service) always pass the
 * machine's own profile, so plugins land where the tunnel actually looks.
 */
export const REMOTE_PLUGIN_PROFILE = DEFAULT_REMOTE_PROFILE

/** How many output lines an item failure carries (the operator-facing tail). */
const FAILURE_TAIL_LINES = 5

/** How many cause lines the headline carries: the earliest ones are the root cause. */
const FAILURE_CAUSE_LINES = 2

/** The lines a cause is picked from: every real error signature pnpm/node-gyp emit. */
const FAILURE_CAUSE = /ERR_PNPM_|gyp ERR!|error:|Error:|Error \d|not ok|not found|No such file|Permission denied|exit code|Command failed|ELIFECYCLE/u

/** The full output an item carries for on-demand display (lines, then bytes). */
const FAILURE_LOG_LINES = 60
const FAILURE_LOG_BYTES = 8000

/**
 * The desktop's own bundled plugins (`dsh-tauri*`). They ride the connect-time
 * bundle sync automatically, so the manual sync list must not offer them:
 * their `link:` specs are local paths that could never resolve remotely, and
 * listing them as "not syncable" reads as a defect rather than a fact.
 */
const BUNDLED_PLUGIN_NAME = /^dsh-tauri(?:-|$)/u

/** Classify one dependency spec: can a remote `dsh plugin add` resolve it? */
export function classifySpec(spec: string): { syncable: boolean, reason?: string } {
  const value = spec.trim()
  if (value === '')
    return { syncable: false, reason: 'empty dependency spec' }
  if (/^(?:github:|git\+|git@)/u.test(value))
    return { syncable: true }
  if (/^(?:file:|link:|workspace:)/u.test(value))
    return { syncable: false, reason: 'local-path dependency; it cannot be resolved on the remote' }
  if (/^https?:\/\//u.test(value))
    return { syncable: false, reason: 'URL dependencies are not supported' }
  // Anything else is an npm version spec (^1.0.0, 0.16.0, latest, …).
  return { syncable: true }
}

/**
 * Build the preview from the local sources: profile dependencies minus the
 * `@deepseek-ai/` core packages (the remote release ships those) and minus
 * {@link BUNDLED_PLUGIN_NAME} (they sync with the bundle automatically), plus
 * the scanned skill roots. Both halves sorted by name for a stable panel order.
 * @param dependencies - the profile package.json dependency map.
 * @param skillRoots - per root, the SKILL.md directory names found locally.
 * @returns the preview payload.
 */
export function buildPreview(dependencies: Record<string, string>, skillRoots: ReadonlyArray<{ root: SyncSkillRoot, names: readonly string[] }>): SyncPreview {
  const plugins: SyncPluginItem[] = Object.entries(dependencies)
    .filter(([name]) => !name.startsWith('@deepseek-ai/') && !BUNDLED_PLUGIN_NAME.test(name))
    .map(([name, spec]) => {
      const verdict = classifySpec(spec)
      return {
        name,
        spec,
        syncable: verdict.syncable,
        ...verdict.reason === undefined ? {} : { reason: verdict.reason },
      }
    })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  const skills: SyncSkillItem[] = []
  for (const entry of skillRoots) {
    for (const name of [...entry.names].sort()) {
      skills.push({ name, root: entry.root })
    }
  }
  return { plugins, skills }
}

/**
 * The `dsh plugin add` argument for one profile dependency: a git spec is a
 * complete locator on its own, while a version spec (`^1.0.0`, `latest`) only
 * means something together with the package name — passing the bare range
 * makes pnpm reject the install.
 */
export function installSpecOf(name: string, spec: string): string {
  const value = spec.trim()
  return /^(?:github:|git\+|git@)/u.test(value) ? value : `${name}@${value}`
}

/**
 * The remote plugin-install command for one dependency (dsh add is
 * pnpm-backed). The dsh entry is a Node script in the binary layout, so it
 * always runs under the layout's Node binary (never a bare `dsh` from the
 * login PATH).
 * @param dshEntry - the absolute entry path the layout probe resolved.
 * @param target - the install argument, see {@link installSpecOf}.
 * @param profileName - the remote profile to install into.
 * @returns the shell command line.
 */
export function pluginAddCommand(dshEntry: string, target: string, profileName: string = REMOTE_PLUGIN_PROFILE): string {
  // `dsh plugin add` spawns a bare `pnpm`: the layout bin dir carries the
  // shim the connect pipeline writes (see `ensurePnpmCommand`), so prepend it
  // to PATH for this command only.
  return `PATH="${layoutBinDir()}:$PATH" ${layoutNodeBinary()} ${shQuote(dshEntry)} plugin --profile ${shQuote(profileName)} add ${shQuote(target)}`
}

/** The remote skill-extract command; the tarball arrives on its stdin. */
export function skillExtractCommand(): string {
  return `mkdir -p "$HOME/.dsh/skills" && tar -xf - -C "$HOME/.dsh/skills"`
}

/**
 * The lines of one command's output, trimmed, blanks dropped.
 * @param stdout - captured stdout.
 * @param stderr - captured stderr.
 * @returns stdout lines first, then stderr lines.
 */
function outputLines(stdout: string, stderr: string): string[] {
  return `${stdout}\n${stderr}`.split('\n').map(line => line.trim()).filter(line => line !== '')
}

/**
 * One operator-facing failure for a finished remote command.
 *
 * The headline names the *cause* first: a multi-minute install buries the real
 * error (`gyp ERR! stack Error: make failed…`, `ERR_PNPM_PREPARE_PACKAGE`) well
 * above the last few lines, and the sweeping guidance pnpm/dsh print last is
 * generic — reading only the tail tells the operator the wrong story. The tail
 * still rides along as context, and the full output travels in the item's
 * `log` for on-demand display.
 * @param code - the command's exit code.
 * @param stdout - captured stdout.
 * @param stderr - captured stderr.
 * @returns the operator-facing message.
 */
function describeFailure(code: number | null, stdout: string, stderr: string): string {
  const lines = outputLines(stdout, stderr)
  // 有原因行就只报原因（最早的几条=根因），不再掺末尾的通用指引——那句往往
  // 与真实原因无关（真机案例：构建门禁已放行，末尾仍在讲门禁，真因是缺 g++）。
  const causes = lines.filter(line => FAILURE_CAUSE.test(line)).slice(0, FAILURE_CAUSE_LINES)
  const picked = causes.length > 0 ? causes : lines.slice(-FAILURE_TAIL_LINES)
  const parts = picked.map(line => (line.length > 300 ? `${line.slice(0, 300)}…` : line))
  return `exit ${code ?? '?'}${parts.length === 0 ? '' : `: ${parts.join(' | ')}`}`
}

/** The trimmed full output an item keeps for on-demand display (newest kept). */
function failureLogOf(stdout: string, stderr: string): string | undefined {
  const lines = outputLines(stdout, stderr)
  if (lines.length === 0)
    return undefined
  const kept = lines.slice(-FAILURE_LOG_LINES).join('\n')
  return kept.length > FAILURE_LOG_BYTES ? `${kept.slice(kept.length - FAILURE_LOG_BYTES)}` : kept
}

/** Engine seams — the fs/ssh touchpoints, injectable for tests. */
export interface SyncEngineDeps {
  /** The local profile's package.json dependency map. */
  profileDependencies: () => Record<string, string>
  /** The local skill roots as scanned, with their directories. */
  scanSkills: () => Array<{ root: SyncSkillRoot, dir: string, names: string[] }>
  /** Pack skill directories into a tar stream (local `tar -cf -`). */
  packSkills: (dir: string, names: readonly string[]) => Promise<Buffer>
  /** Open one dedicated authenticated session; the engine closes it. */
  openSession: (machineId: MachineId) => Promise<SshSession>
  /** Per-remote-command deadline (plugin adds are install-class operations). */
  commandTimeoutMs?: number
}

/** One apply run's options. */
export interface SyncApplyOptions {
  /**
   * Live progress of the run: the item about to start (1-based position), the
   * deduped item count, and the item's display name. Called before every
   * remote command, so the UI can show progress instead of a silent
   * multi-minute wait.
   */
  onItem?: (position: number, total: number, name: string) => void
  /**
   * The remote dsh profile the plugins install into. The tunnel serves this
   * machine's configured profile (default {@link DEFAULT_REMOTE_PROFILE}), so
   * installing anywhere else would leave the synced plugins inert.
   */
  profileName?: string
  /**
   * Runs once on the freshly opened session before the first plugin install
   * (the caller's chance to prepare the remote profile — e.g. carry the local
   * build allowlist). Best-effort by contract: it must not fail the sync, and
   * is skipped entirely for skill-only runs.
   */
  beforePlugins?: (session: SshSession) => Promise<void>
}

/**
 * The sync engine: preview from local sources, apply over one SSH session.
 * Apply never throws for command-level failures — every requested item
 * settles into the returned list, so the panel can render each outcome.
 */
export class SyncEngine {
  constructor(private readonly deps: SyncEngineDeps) {}

  /** The selectable local plugins and skills. */
  preview(): SyncPreview {
    return buildPreview(this.deps.profileDependencies(), this.deps.scanSkills())
  }

  /**
   * Sync the selected plugins and skills to one machine, item by item.
   * @param machineId - the target machine.
   * @param plugins - the plugin refs to install (name is display identity).
   * @param skills - the skill refs to copy (root picks the local source).
   * @param options - live progress and the install target profile.
   * @returns one outcome per requested item, in request order.
   */
  async apply(
    machineId: MachineId,
    plugins: readonly SyncPluginRef[],
    skills: readonly SyncSkillRef[],
    options: SyncApplyOptions = {},
  ): Promise<SyncApplyResult> {
    const items: SyncItemResult[] = []
    const uniquePlugins = dedupeBy(plugins, ref => ref.spec)
    const uniqueSkills = dedupeBy(skills, ref => `${ref.root}:${ref.name}`)
    if (uniquePlugins.length === 0 && uniqueSkills.length === 0)
      return { items }
    // 进度只按「已结算的条目数」推进：公告的 position 恒为 settled + 1，UI 的
    // 「第 n/N 项」因此在任何失败路径下都不跳号（本地校验出局的条目也结算）。
    const progress: SyncProgress = { settled: 0, total: uniquePlugins.length + uniqueSkills.length }
    const session = await this.deps.openSession(machineId)
    try {
      if (uniquePlugins.length > 0)
        await options.beforePlugins?.(session).catch(() => undefined)
      await this.applyPlugins(session, uniquePlugins, items, progress, options)
      await this.applySkills(session, uniqueSkills, items, progress, options)
    }
    finally {
      await session.close().catch(() => undefined)
    }
    return { items }
  }

  /** Install each plugin spec in its own exec so outcomes stay per-item. */
  private async applyPlugins(
    session: SshSession,
    plugins: readonly SyncPluginRef[],
    items: SyncItemResult[],
    progress: SyncProgress,
    options: SyncApplyOptions,
  ): Promise<void> {
    if (plugins.length === 0)
      return
    const dshEntry = firstLineOf((await session.exec(dshEntryProbeCommand())).stdout)
    for (const plugin of plugins) {
      announceItem(progress, options, plugin.name)
      if (dshEntry === '') {
        items.push({
          kind: 'plugin',
          name: plugin.name,
          ok: false,
          error: 'no dsh entry under the remote ~/.dsh-desktop install layout; run the machine install first',
        })
        continue
      }
      const deadline = this.deps.commandTimeoutMs === undefined ? {} : { timeoutMs: this.deps.commandTimeoutMs }
      const command = pluginAddCommand(dshEntry, installSpecOf(plugin.name, plugin.spec), options.profileName)
      let result = await session.exec(command, deadline)
      if (result.code !== 0) {
        // pnpm 的 prepare 门禁会打印它要求的 allowBuilds 键（git depPath 钉的是
        // 解析出来的 commit，本机旧键对不上远端今天解析到的 commit）：补写一次
        // 白名单再原样重试一次，与桌面端本地安装器的做法一致。
        const granted = await this.grantBuildKeys(session, options.profileName, `${result.stdout}\n${result.stderr}`)
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

  /**
   * Grant the build keys a failed install asked for, into the remote profile's
   * `pnpm-workspace.yaml`. Best-effort: a remote file that cannot be parsed, or
   * output naming no key, simply yields no grant (the item then reports the
   * original failure — never a masked one).
   * @returns the keys actually added.
   */
  private async grantBuildKeys(session: SshSession, profileName: string | undefined, output: string): Promise<string[]> {
    const keys = parseBuildAllowKeys(output)
    if (keys.length === 0)
      return []
    const remote = await session.exec(allowlistReadCommand(profileName ?? REMOTE_PLUGIN_PROFILE))
    const { yaml, added } = mergeWorkspaceAllowlist(
      remote.stdout,
      { allowBuilds: Object.fromEntries(keys.map(key => [key, true])), onlyBuiltDependencies: [] },
    )
    if (added.length > 0)
      await session.exec(allowlistWriteCommand(profileName ?? REMOTE_PLUGIN_PROFILE, yaml))
    return added
  }

  /** Copy skills per root: local validation per item, one tar stream per root. */
  private async applySkills(
    session: SshSession,
    skills: readonly SyncSkillRef[],
    items: SyncItemResult[],
    progress: SyncProgress,
    options: SyncApplyOptions,
  ): Promise<void> {
    if (skills.length === 0)
      return
    const roots = new Map(this.deps.scanSkills().map(entry => [entry.root as SyncSkillRoot, entry]))
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
      // 一个 root 的全部 skill 走同一份 tar：公告取批首那条，位置即批次起点。
      announceItem(progress, options, transferable[0]!.name)
      let tar: Buffer
      try {
        tar = await this.deps.packSkills(entry.dir, transferable.map(skill => skill.name))
      }
      catch (error) {
        // The local pack failed: every transferable item carries the reason.
        const message = error instanceof Error ? error.message : String(error)
        for (const skill of transferable) {
          items.push({ kind: 'skill', name: skill.name, root, ok: false, error: message })
        }
        progress.settled += transferable.length
        continue
      }
      const result = await session.exec(skillExtractCommand(), {
        stdinData: tar,
        ...this.deps.commandTimeoutMs === undefined ? {} : { timeoutMs: this.deps.commandTimeoutMs },
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
}

/** The live progress bookkeeping of one apply run (see `SyncProgressHook`). */
interface SyncProgress {
  /** Items already settled (success or failure); the next item is `settled + 1`. */
  settled: number
  /** Deduped item count of the run. */
  total: number
}

/** Announce the item about to run; no-op when the caller passed no hook. */
function announceItem(progress: SyncProgress, options: SyncApplyOptions, name: string): void {
  options.onItem?.(progress.settled + 1, progress.total, name)
}

/** Keep the first occurrence of each keyed item, preserving request order. */
function dedupeBy<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of items) {
    const key = keyOf(item)
    if (seen.has(key))
      continue
    seen.add(key)
    out.push(item)
  }
  return out
}
