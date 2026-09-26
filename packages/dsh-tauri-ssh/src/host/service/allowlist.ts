/**
 * Profile build-allowlist carry-over (local → remote).
 *
 * pnpm refuses to run a git-hosted plugin's `prepare` build unless the profile
 * allows it (`allowBuilds` map, pnpm 11; `onlyBuiltDependencies` list, pnpm 10;
 * both in the profile's `pnpm-workspace.yaml`). The desktop's own installer
 * writes those keys back locally after a gated install, but a remote profile
 * starts from the bare template — so every git-hosted plugin the sync panel
 * pushed died on pnpm's prepare gate. This module reads the two sections from
 * the local profile and merges the missing keys into the remote profile's file.
 *
 * Cross-platform: keys describing the *local* filesystem (drive letters,
 * backslash paths, `file:`/`link:`/`workspace:` resolutions) can never match on
 * a POSIX remote, so they are dropped instead of copied. The merge is a YAML
 * round-trip (never string concatenation): git depPath keys carry `@`, `:`,
 * `/` and `#`, which only a real serializer quotes correctly.
 * @module dsh-tauri-ssh/host/service/allowlist
 */

import type { SshSession } from './transport'
import { parse, stringify } from 'yaml'
import { shQuote } from './transport'

/** The two build-allowlist sections of one profile's `pnpm-workspace.yaml`. */
export interface WorkspaceAllowlist {
  /** pnpm 11's map form: depPath (or package name) → allowed. */
  allowBuilds: Record<string, boolean>
  /** pnpm 10's list form: package names allowed to run build scripts. */
  onlyBuiltDependencies: string[]
}

/** The empty allowlist (a profile that installed nothing gated). */
export const EMPTY_ALLOWLIST: WorkspaceAllowlist = { allowBuilds: {}, onlyBuiltDependencies: [] }

/** The template dsh writes for a fresh profile (mirrors the desktop's fallback). */
export const WORKSPACE_TEMPLATE = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'

/** The remote profile directory, relative to `$HOME` (the layout's own convention). */
export function remoteProfileDir(profileName: string): string {
  return `.dsh/profiles/${profileName}`
}

/**
 * Whether one allowlist key can ever match on a POSIX remote: a key that names
 * a local-only resolution (`C:\…`, `file:…`, `link:…`, `workspace:…`) or spells
 * a Windows path is dropped — pnpm could never satisfy it there, and copying it
 * would only suggest the remote has a permission it does not.
 */
export function isPortableAllowKey(key: string): boolean {
  const value = key.trim()
  if (value === '')
    return false
  if (value.includes('\\'))
    return false
  if (/^[a-z]:[\\/]/iu.test(value))
    return false
  // The resolution decides: a bare name is the resolution, and a `name@spec`
  // key keeps only its spec. Scoped names (`@scope/pkg`) start with `@`; the
  // slice below then yields `scope/pkg`, which still matches neither marker.
  const resolution = value.includes('@') ? value.slice(value.indexOf('@') + 1) : value
  if (/^(?:file|link|workspace):/iu.test(resolution))
    return false
  return true
}

/** Read one boolean-ish YAML value; anything but an explicit false reads as allowed. */
function allowedValue(value: unknown): boolean {
  return value !== false
}

/**
 * Parse the two allowlist sections out of one workspace document. Unparsable
 * text, a non-mapping document, or missing sections all read as empty: the
 * caller carries what it can without ever blocking the connection.
 */
export function parseAllowlist(text: string): WorkspaceAllowlist {
  let doc: unknown
  try {
    doc = parse(text)
  }
  catch {
    return { ...EMPTY_ALLOWLIST }
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc))
    return { ...EMPTY_ALLOWLIST }
  const record = doc as Record<string, unknown>
  const allowBuilds: Record<string, boolean> = {}
  const rawBuilds = record.allowBuilds
  if (typeof rawBuilds === 'object' && rawBuilds !== null && !Array.isArray(rawBuilds)) {
    for (const [key, value] of Object.entries(rawBuilds as Record<string, unknown>)) {
      if (isPortableAllowKey(key))
        allowBuilds[key] = allowedValue(value)
    }
  }
  const onlyBuilt: string[] = []
  if (Array.isArray(record.onlyBuiltDependencies)) {
    for (const entry of record.onlyBuiltDependencies) {
      if (typeof entry === 'string' && isPortableAllowKey(entry) && !onlyBuilt.includes(entry))
        onlyBuilt.push(entry)
    }
  }
  return { allowBuilds, onlyBuiltDependencies: onlyBuilt }
}

/**
 * Merge the local allowlist into one remote workspace document.
 *
 * Only *missing* keys are carried: an explicit `false` the operator wrote on
 * the remote stays a denial. The document is round-tripped through the YAML
 * library, so every other key (packages, nodeLinker, user settings) survives
 * and the emitted quoting is always valid.
 * @param remoteYaml - the remote profile's current document (empty when absent).
 * @param incoming - the local profile's allowlist sections.
 * @returns the document to write and the keys that were actually added
 * (empty `added` means the remote already allows everything: do not write).
 * @throws {Error} when the remote document is not valid YAML — rewriting it
 * would destroy whatever the operator has there.
 */
export function mergeWorkspaceAllowlist(remoteYaml: string, incoming: WorkspaceAllowlist): { yaml: string, added: string[] } {
  const text = remoteYaml.trim() === '' ? WORKSPACE_TEMPLATE : remoteYaml
  let doc: unknown
  try {
    doc = parse(text)
  }
  catch (error) {
    throw new Error(`remote pnpm-workspace.yaml is not valid YAML: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc))
    throw new Error('remote pnpm-workspace.yaml is not a YAML mapping')
  const record = doc as Record<string, unknown>
  const added: string[] = []

  const builds = typeof record.allowBuilds === 'object' && record.allowBuilds !== null && !Array.isArray(record.allowBuilds)
    ? record.allowBuilds as Record<string, unknown>
    : {}
  for (const [key, value] of Object.entries(incoming.allowBuilds).sort(([left], [right]) => left.localeCompare(right))) {
    if (key in builds || !isPortableAllowKey(key))
      continue
    builds[key] = value
    added.push(key)
  }
  if (Object.keys(builds).length > 0)
    record.allowBuilds = builds

  const onlyBuilt = Array.isArray(record.onlyBuiltDependencies)
    ? record.onlyBuiltDependencies.filter((entry): entry is string => typeof entry === 'string')
    : []
  for (const name of [...incoming.onlyBuiltDependencies].sort()) {
    if (onlyBuilt.includes(name) || !isPortableAllowKey(name))
      continue
    onlyBuilt.push(name)
    added.push(name)
  }
  if (onlyBuilt.length > 0)
    record.onlyBuiltDependencies = onlyBuilt

  if (added.length === 0)
    return { yaml: remoteYaml, added }
  return { yaml: stringify(record), added }
}

/**
 * Parse the build keys pnpm names in a failed install's output, mirroring the
 * desktop's own installer (its `parse_allowlist_keys`): the guidance prints an
 * `allowBuilds:` example whose following indented `<key>: true` line is the
 * exact depPath to allow, and older pnpm prints an `onlyBuiltDependencies:`
 * list ("Ignored build scripts: name@version"). Both forms are read here.
 *
 * Needed because a git depPath pins the *resolved commit*: the key recorded on
 * this machine for an older commit never matches the commit a remote resolves
 * today, so the failure output is the only correct source for that key.
 * @param output - the failed command's stdout and stderr, concatenated.
 * @returns the keys to grant, deduped and in output order.
 */
export function parseBuildAllowKeys(output: string): string[] {
  const keys: string[] = []
  const push = (key: string): void => {
    const value = key.trim().replace(/^['"]|['"]$/gu, '')
    if (value !== '' && isPortableAllowKey(value) && !keys.includes(value))
      keys.push(value)
  }
  const lines = output.split('\n')
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()
    if (trimmed === 'allowBuilds:') {
      // 条目必须缩进且形如 `<key>: true`：先切掉缩进，再按「冒号 + true」判定
      const entry = lines[index + 1] ?? ''
      const match = isIndented(entry) ? /^(.*):[ \t]*true$/u.exec(entry.trim()) : null
      if (match?.[1] !== undefined)
        push(match[1])
    }
    if (trimmed === 'onlyBuiltDependencies:') {
      for (const next of lines.slice(index + 1)) {
        const indented = isIndented(next)
        const body = next.trim()
        if (indented && body.startsWith('-')) {
          push(body.slice(1).trim())
          continue
        }
        if (body !== '' && !indented)
          break // 顶层键：列表已结束
      }
    }
    const ignored = line.includes('Ignored build scripts:') ? line.split('Ignored build scripts:')[1] ?? '' : ''
    for (const token of ignored.split(/[,\s]+/u)) {
      if (token.trim() !== '')
        push(token.trim().replace(/@[^@]*$/u, ''))
    }
  }
  return keys
}

/** Whether one output line is indented (a block entry rather than a top-level key). */
function isIndented(line: string): boolean {
  return line.startsWith(' ') || line.startsWith('\t')
}

/** Read the remote profile's workspace document (empty when it does not exist yet). */
export function allowlistReadCommand(profileName: string): string {
  return `cat "$HOME/${remoteProfileDir(profileName)}/pnpm-workspace.yaml" 2>/dev/null || true`
}

/**
 * Write the merged document back. The payload is one shell-quoted argument
 * (never a heredoc or a base64 pipe): `shQuote` keeps every `@`, `:`, `#` and
 * newline intact, and the text is emitted with LF endings on every platform.
 */
export function allowlistWriteCommand(profileName: string, yamlText: string): string {
  const dir = `$HOME/${remoteProfileDir(profileName)}`
  return `mkdir -p "${dir}" && printf %s ${shQuote(yamlText)} > "${dir}/pnpm-workspace.yaml"`
}

/**
 * Carry the local allowlist into the remote profile over one live session.
 * Idempotent and quiet when there is nothing to add; a remote document that
 * cannot be parsed leaves the file untouched.
 * @param session - the authenticated session to run the file commands on.
 * @param profileName - the remote profile whose workspace file is the target.
 * @param local - the local profile's allowlist sections.
 * @returns the keys that were added (empty when the remote was already complete).
 */
export async function carryWorkspaceAllowlist(
  session: SshSession,
  profileName: string,
  local: WorkspaceAllowlist,
): Promise<string[]> {
  if (Object.keys(local.allowBuilds).length === 0 && local.onlyBuiltDependencies.length === 0)
    return []
  const remote = await session.exec(allowlistReadCommand(profileName))
  const { yaml, added } = mergeWorkspaceAllowlist(remote.stdout, local)
  if (added.length > 0)
    await session.exec(allowlistWriteCommand(profileName, yaml))
  return added
}
