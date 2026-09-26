/**
 * Local-source readers for the sync engine: the profile's package.json
 * dependencies and the user-level skill roots, plus the local `tar` packer.
 * These are the fs/process touchpoints the engine's seams abstract, kept
 * apart from the pure engine so tests import neither.
 * @module dsh-tauri-ssh/host/service/sync-local
 */

import type { Buffer } from 'node:buffer'
import type { SyncSkillRoot } from '../types/index'
import type { WorkspaceAllowlist } from './allowlist'
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import process from 'node:process'
import { promisify } from 'node:util'
import { join } from 'pathe'
import { EMPTY_ALLOWLIST, parseAllowlist } from './allowlist'

const execFileAsync = promisify(execFile)

/** The tar stream size budget (a skill folder can carry fixtures and assets). */
const MAX_TAR_BYTES = 64 * 1024 * 1024

/** Profile that boots this process: `--profile <name>` on the CLI invocation. */
export function argvProfile(argv: readonly string[] = process.argv): string | undefined {
  const flag = argv.indexOf('--profile')
  const value = flag === -1 ? undefined : argv[flag + 1]
  if (value !== undefined && !value.startsWith('-'))
    return value
  return undefined
}

/** The harness home: `$DSH_HOME`, else `~/.dsh`. */
function dshHomeOf(override?: string): string {
  return override ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * Read the local profile's plugin dependencies (`profiles/<name>/package.json`
 * → `dependencies`). A missing or malformed manifest yields an empty map: "no
 * plugins installed here" is a state to show, not a failure to raise.
 * @param dshHome - harness-home override (tests).
 * @returns the dependency-name → spec map.
 */
export function profileDependenciesReader(dshHome?: string): () => Record<string, string> {
  return () => {
    const profile = argvProfile() ?? 'web'
    const manifestPath = join(dshHomeOf(dshHome), 'profiles', profile, 'package.json')
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, unknown> }
      const out: Record<string, string> = {}
      for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
        if (typeof spec === 'string')
          out[name] = spec
      }
      return out
    }
    catch {
      return {}
    }
  }
}

/**
 * Read the local profile's build allowlist (`pnpm-workspace.yaml` →
 * `allowBuilds` + `onlyBuiltDependencies`). A missing or unparsable file reads
 * as empty: nothing to carry is a state, not a failure. Paths go through
 * `pathe`, so a Windows host resolves the same document as a POSIX one.
 * @param dshHome - harness-home override (tests).
 * @param profile - profile-name override (tests); defaults to the `--profile` the process runs under.
 * @returns the allowlist sections to carry to a remote profile.
 */
export function profileAllowlistReader(dshHome?: string, profile?: string): () => WorkspaceAllowlist {
  return () => {
    const workspacePath = join(dshHomeOf(dshHome), 'profiles', profile ?? argvProfile() ?? 'web', 'pnpm-workspace.yaml')
    try {
      return parseAllowlist(readFileSync(workspacePath, 'utf8'))
    }
    catch {
      return { ...EMPTY_ALLOWLIST }
    }
  }
}

/**
 * Scan the user-level skill roots (`<dsh-home>/skills`, `~/.agents/skills`)
 * for SKILL.md-carrying directories. Absent roots simply contribute nothing.
 * @param dshHome - harness-home override (tests).
 * @param homeDir - user-home override (tests).
 * @returns per root: the label, its directory, and its sorted skill names.
 */
export function skillRootsScanner(dshHome?: string, homeDir?: string): () => Array<{ root: SyncSkillRoot, dir: string, names: string[] }> {
  return () => {
    const roots: Array<{ root: SyncSkillRoot, dir: string }> = [
      { root: 'dsh', dir: join(dshHomeOf(dshHome), 'skills') },
      { root: 'agents', dir: join(homeDir ?? homedir(), '.agents', 'skills') },
    ]
    return roots.map(({ root, dir }) => ({
      root,
      dir,
      names: skillNamesOf(dir),
    }))
  }
}

/** The SKILL.md directories under one root, sorted; absent roots stay empty. */
function skillNamesOf(dir: string): string[] {
  if (!existsSync(dir))
    return []
  const names: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory())
      continue
    try {
      if (statSync(join(dir, entry.name, 'SKILL.md')).isFile())
        names.push(entry.name)
    }
    catch {
      // A broken symlink or unreadable entry is not a skill; skip it.
    }
  }
  return names.sort()
}

/**
 * The local `tar` packer: one streamed archive (`tar -cf -`) of the selected
 * skill directories under their root, exactly as the remote extract expects.
 * @returns the tar bytes.
 */
export function tarPacker(): (dir: string, names: readonly string[]) => Promise<Buffer> {
  return async (dir, names) => {
    // `--` 分隔符：防止以 `-` 开头的 skill 目录名被 tar 当作选项。
    const { stdout, stderr } = await execFileAsync('tar', ['-cf', '-', '-C', dir, '--', ...names], {
      maxBuffer: MAX_TAR_BYTES,
      windowsHide: true,
      encoding: 'buffer',
    })
    if (stdout.length === 0) {
      throw new Error(`packing skills produced no archive${stderr.length === 0 ? '' : `: ${stderr.toString('utf8').trim()}`}`)
    }
    return stdout
  }
}
