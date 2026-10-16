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

const MAX_TAR_BYTES = 64 * 1024 * 1024

export function argvProfile(argv: readonly string[] = process.argv): string | undefined {
  const flag = argv.indexOf('--profile')
  const value = flag === -1 ? undefined : argv[flag + 1]
  if (value !== undefined && !value.startsWith('-'))
    return value
  return undefined
}

function dshHomeOf(override?: string): string {
  return override ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

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
    }
  }
  return names.sort()
}

export async function packSkills(dir: string, names: readonly string[]): Promise<Buffer> {
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
