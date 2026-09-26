import type { MachineProfile } from '../types/index'
/**
 * The host's own `~/.ssh` as the credential source: `ssh_config` parsing
 * (Host blocks, HostName/User/Port/IdentityFile, Include expansion), the
 * OpenSSH matching semantics (first matching pattern decides; first obtained
 * value per parameter; IdentityFile accumulates), and the resolver that turns
 * one machine profile into a concrete connection plan (connect host/port/user
 * plus the ordered identity files to try). Keys are read fresh on every
 * connect — a key added to `~/.ssh` is picked up without touching DSH.
 *
 * `ProxyJump` resolves to the ordered hop list (alias form `[user@]host[:port]`,
 * comma-separated for multi-hop; `none` disables); the transport walks it.
 * Deliberate subset: `Match` blocks, `ProxyCommand`, and agent forwarding are
 * out of scope; a host with no config match falls back to the profile fields
 * and the default identity files, exactly like a bare `ssh host` would.
 * @module dsh-tauri-ssh/host/service/ssh-config
 */

import { readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { join, sep } from 'pathe'

/** Default identity file basenames, tried in order when no config `IdentityFile` exists. */
export const DEFAULT_IDENTITY_FILES = ['id_ed25519', 'id_ecdsa', 'id_rsa']

/** The config file name inside the ssh directory. */
export const SSH_CONFIG_FILE = 'config'

/** Recursion cap for `Include` chains; OpenSSH effectively has none, this one is for safety. */
export const INCLUDE_DEPTH_LIMIT = 8

/** One `Host` block: the patterns it applies to and the settings it carries. */
export interface SshHostBlock {
  /** The `Host` pattern list of this block (may contain `!`, `*`, `?`). */
  patterns: string[]
  /** Settings keyed by lower-cased keyword; every keyword may appear multiple times. */
  values: Record<string, string[]>
}

/** The resolved per-host settings for one connection. */
export interface SshHostSettings {
  /** `HostName` override; absent means "connect to the requested host directly". */
  hostName?: string
  /** `User` override. */
  user?: string
  /** `Port` override (parsed). */
  port?: number
  /** Every `IdentityFile` from the matching blocks, in order. */
  identityFiles: string[]
  /**
   * The `ProxyJump` hops (first obtained value wins, comma-split, `none`
   * filtered out); each entry is the raw `[user@]alias[:port]` token.
   */
  proxyJump: string[]
}

/** The concrete connection plan one machine profile resolves to. */
export interface ResolvedSshAuth {
  /** The host to actually connect to. */
  host: string
  /** The TCP port to actually connect to. */
  port: number
  /** The login user name. */
  username: string
  /** The stored password fallback, when the profile carries one. */
  password?: string
  /** The identity files to try, in order, as raw file contents. */
  keys: Array<{ privateKey: string, passphrase?: string }>
  /** The resolved ProxyJump hop tokens (`[user@]alias[:port]`), in order; empty when direct. */
  proxyJump: string[]
}

/** Token expansion for `~`, `%d`, `%h`, `%r` in config paths (the OpenSSH subset). */
export function expandTokenPath(path: string, homeDir: string, host: string, user: string): string {
  let out = expandPathTokens(path, homeDir, host, user)
  if (!out.startsWith('/')) {
    // ssh_config resolves bare relative IdentityFile paths under the home dir.
    out = join(homeDir, out)
  }
  return out
}

/** Expand `~`, `~/"`, `%d`, `%h`, `%r` without anchoring a bare relative path. */
function expandPathTokens(path: string, homeDir: string, host: string, user: string): string {
  let out = path
  if (out === '~') {
    out = homeDir
  }
  else if (out.startsWith('~/')) {
    out = join(homeDir, out.slice(2))
  }
  return out.replaceAll('%d', homeDir).replaceAll('%h', host).replaceAll('%r', user)
}

/**
 * Whether one `Host` pattern matches a host name. `*` matches any run of
 * characters, `?` exactly one; the pattern may be comma-separated, each
 * alternative tried in order — the first one that matches decides, and a
 * leading `!` (negation) turns that decision into "no match". Case-insensitive,
 * like OpenSSH host names.
 */
export function hostPatternMatches(pattern: string, host: string): boolean {
  const lowered = host.toLowerCase()
  for (const alternative of pattern.split(',')) {
    const negated = alternative.startsWith('!')
    const body = negated ? alternative.slice(1) : alternative
    if (globMatches(body.toLowerCase(), lowered))
      return !negated
  }
  return false
}

/** Match one glob (only `*` and `?`) against a string. */
export function globMatches(glob: string, value: string): boolean {
  // A greedy two-pointer matcher: walk both strings, backtrack on `*`.
  let globIndex = 0
  let valueIndex = 0
  let starGlob = -1
  let starValue = -1
  while (valueIndex < value.length) {
    const g = glob[globIndex]
    if (g === '*') {
      starGlob = globIndex
      starValue = valueIndex
      globIndex += 1
    }
    else if (g === '?' || g === value[valueIndex]) {
      globIndex += 1
      valueIndex += 1
    }
    else if (starGlob !== -1) {
      globIndex = starGlob + 1
      starValue += 1
      valueIndex = starValue
    }
    else {
      return false
    }
  }
  while (glob[globIndex] === '*') globIndex += 1
  return globIndex === glob.length
}

/**
 * Parse one ssh_config document into `Host` blocks. Keywords are
 * case-insensitive; `#` starts a comment; `key value` and `key=value` both
 * parse. Only `Host` opens a block; a top-level `Include` (before any `Host`)
 * becomes a synthetic pattern-less block the loader expands in place. Other
 * lines outside any block are dropped (OpenSSH applies them to every host,
 * but the common `Host *` form parses the same way).
 */
export function parseSshConfig(text: string): SshHostBlock[] {
  const blocks: SshHostBlock[] = []
  let current: SshHostBlock | undefined
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/#.*$/u, '').trim()
    if (line === '')
      continue
    const equals = line.indexOf('=')
    // The line is non-blank, so the split always yields a first token.
    const key = (equals === -1 ? line.split(/\s+/u)[0]! : line.slice(0, equals)).trim().toLowerCase()
    if (key === '')
      continue
    const value = equals === -1
      ? line.slice(key.length).trim()
      : line.slice(equals + 1).trim()
    if (value === '')
      continue
    if (key === 'host') {
      current = {
        patterns: value.split(/\s+/u).filter(part => part !== ''),
        values: {},
      }
      blocks.push(current)
      continue
    }
    if (current === undefined) {
      if (key === 'include') {
        current = { patterns: [], values: {} }
        blocks.push(current)
      }
      else {
        continue
      }
    }
    const values = current.values[key] ?? (current.values[key] = [])
    values.push(value)
  }
  return blocks
}

/**
 * Resolve one host name against parsed blocks, with the OpenSSH rules: a
 * block applies when its first matching pattern decides (a matching negation
 * excludes the block), the first obtained value per parameter wins, and
 * `IdentityFile` accumulates across all matching blocks.
 */
export function lookupSshConfig(blocks: SshHostBlock[], host: string): SshHostSettings {
  const settings: SshHostSettings = { identityFiles: [], proxyJump: [] }
  for (const block of blocks) {
    const applies = block.patterns.some(pattern => hostPatternMatches(pattern, host))
    if (!applies)
      continue
    const hostname = block.values.hostname?.[0]
    if (settings.hostName === undefined && hostname !== undefined) {
      settings.hostName = hostname
    }
    const user = block.values.user?.[0]
    if (settings.user === undefined && user !== undefined) {
      settings.user = user
    }
    const port = block.values.port?.[0]
    if (settings.port === undefined && port !== undefined) {
      settings.port = Number(port)
    }
    if (block.values.identityfile !== undefined) {
      settings.identityFiles.push(...block.values.identityfile)
    }
    if (settings.proxyJump.length === 0 && block.values.proxyjump !== undefined) {
      settings.proxyJump = block.values.proxyjump[0]!
        .split(',')
        .map(token => token.trim())
        .filter(token => token !== '' && token.toLowerCase() !== 'none')
    }
  }
  return settings
}

/**
 * The literal `Host` aliases worth surfacing as machines: every pattern token
 * that names one concrete host — no `*`/`?` wildcards, no `!` negation, no
 * comma alternation. Multi-pattern entries contribute each literal token;
 * the result is deduplicated and sorted.
 */
export function discoverableHosts(blocks: SshHostBlock[]): string[] {
  const hosts = new Set<string>()
  for (const block of blocks) {
    for (const pattern of block.patterns) {
      if (pattern === '' || /[?*,!]/u.test(pattern))
        continue
      hosts.add(pattern)
    }
  }
  return [...hosts].sort()
}

/**
 * Expand one `Include` path into the file paths it names (sorted, missing
 * targets dropped). OpenSSH anchors relative paths under the ssh directory
 * (the user config home) and globs the basename.
 */
export function expandIncludePath(path: string, sshDir: string, homeDir: string, host: string, user: string): string[] {
  let expanded = expandPathTokens(path, homeDir, host, user)
  if (!expanded.startsWith('/'))
    expanded = join(sshDir, expanded)
  // The path is absolute by now, so a separator always exists.
  const slash = expanded.lastIndexOf(sep)
  const dir = expanded.slice(0, slash)
  const basename = expanded.slice(slash + 1)
  if (!/[?*]/u.test(basename))
    return [expanded]
  // Basename globs only (the common `Include ~/.ssh/config.d/*` shape);
  // readdirSyncSafe never throws, an unreadable directory reads as empty.
  return readdirSyncSafe(dir)
    .filter(name => globMatches(basename, name))
    .sort()
    .map(name => join(dir, name))
}

/** One synchronous directory listing; failures read as an empty list. */
function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  }
  catch {
    return []
  }
}

/**
 * Load every `Host` block reachable from the ssh config, following `Include`
 * chains (depth-capped, cycle-safe, missing targets silently skipped).
 * @param sshDir - the ssh directory (defaults to `~/.ssh`).
 * @param homeDir - the home directory for `~` expansion.
 * @returns the concatenated blocks, outermost first.
 */
export async function loadSshConfigBlocks(sshDir: string, homeDir: string): Promise<SshHostBlock[]> {
  const blocks: SshHostBlock[] = []
  const visited = new Set<string>()
  await collectConfigBlocks(sshDir, homeDir, join(sshDir, SSH_CONFIG_FILE), 0, visited, blocks)
  return blocks
}

/** One recursive leg of {@link loadSshConfigBlocks}. */
async function collectConfigBlocks(
  sshDir: string,
  homeDir: string,
  file: string,
  depth: number,
  visited: Set<string>,
  out: SshHostBlock[],
): Promise<void> {
  if (depth > INCLUDE_DEPTH_LIMIT || visited.has(file))
    return
  visited.add(file)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  }
  catch {
    return
  }
  for (const block of parseSshConfig(text)) {
    const includes = block.values.include
    if (includes === undefined) {
      out.push(block)
      continue
    }
    // OpenSSH splices include content in place: a Host block that carries an
    // Include keeps its own settings (the Include keyword is not itself a
    // setting), and the included files' blocks follow it. A synthetic
    // pattern-less block (top-level Include) contributes only its includes.
    if (block.patterns.length > 0) {
      const { include: _dropped, ...values } = block.values
      out.push({ patterns: block.patterns, values })
    }
    for (const path of includes) {
      for (const target of expandIncludePath(path, sshDir, homeDir, '', '')) {
        await collectConfigBlocks(sshDir, homeDir, target, depth + 1, visited, out)
      }
    }
  }
}

/**
 * The credential resolver: reads the host's `~/.ssh` and turns one machine
 * profile into the concrete connection plan. Pure file access — no network,
 * no ssh2 — so tests drive it with a scratch ssh directory.
 */
export class SshConfigResolver {
  /**
   * @param sshDir - the ssh directory holding `config` and the identity files.
   * @param homeDir - the home directory used for `~` expansion.
   * @param defaultUser - the OS user name used when neither the profile nor
   *   the config names a user (what a bare `ssh` would log in as).
   */
  constructor(
    private readonly sshDir: string,
    private readonly homeDir: string,
    private readonly defaultUser: string = process.env.USER ?? '',
  ) {}

  /**
   * Resolve one machine profile into the connection plan.
   * @param profile - the machine profile to connect.
   * @returns the host/port/user to connect and the ordered credentials.
   */
  async resolve(profile: MachineProfile): Promise<ResolvedSshAuth> {
    const blocks = await loadSshConfigBlocks(this.sshDir, this.homeDir)
    const settings = lookupSshConfig(blocks, profile.host)
    const username = profile.user !== '' ? profile.user : settings.user ?? this.defaultUser
    const host = settings.hostName ?? profile.host
    const port = settings.port ?? profile.port
    const passphrase = profile.passphrase === undefined || profile.passphrase === '' ? undefined : profile.passphrase
    const password = profile.password === undefined || profile.password === '' ? undefined : profile.password
    const identityPaths = settings.identityFiles.length > 0
      ? settings.identityFiles
      : DEFAULT_IDENTITY_FILES.map(name => join(this.sshDir, name))
    const keys: ResolvedSshAuth['keys'] = []
    for (const path of identityPaths) {
      const expanded = expandTokenPath(path, this.homeDir, host, username)
      try {
        const privateKey = await readFile(expanded, 'utf8')
        keys.push({ privateKey, ...passphrase === undefined ? {} : { passphrase } })
      }
      catch {
        // Missing or unreadable identity files are skipped, like ssh does.
      }
    }
    return {
      host,
      port,
      username,
      keys,
      proxyJump: settings.proxyJump,
      ...password === undefined ? {} : { password },
    }
  }
}
