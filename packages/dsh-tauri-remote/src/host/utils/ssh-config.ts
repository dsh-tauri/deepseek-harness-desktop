import type { MachineProfile } from '../types/index'

import { readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { isAbsolute, join, sep } from 'pathe'

export const DEFAULT_IDENTITY_FILES = ['id_ed25519', 'id_ecdsa', 'id_rsa']

export const SSH_CONFIG_FILE = 'config'

export const INCLUDE_DEPTH_LIMIT = 8

export interface SshHostBlock {
  patterns: string[]
  values: Record<string, string[]>
}

export interface SshHostSettings {
  hostName?: string
  user?: string
  port?: number
  identityFiles: string[]
  proxyJump: string[]
}

export interface ResolvedSshAuth {
  host: string
  port: number
  username: string
  password?: string
  keys: Array<{ privateKey: string, passphrase?: string }>
  proxyJump: string[]
}

export function expandTokenPath(path: string, homeDir: string, host: string, user: string): string {
  const out = expandPathTokens(path, homeDir, host, user)
  return isAbsolute(out) ? out : join(homeDir, out)
}

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

export function globMatches(glob: string, value: string): boolean {
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

export function parseSshConfig(text: string): SshHostBlock[] {
  const blocks: SshHostBlock[] = []
  let current: SshHostBlock | undefined
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/#.*$/u, '').trim()
    if (line === '')
      continue
    const equals = line.indexOf('=')
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

export function expandIncludePath(path: string, sshDir: string, homeDir: string, host: string, user: string): string[] {
  const tokens = expandPathTokens(path, homeDir, host, user)
  const expanded = isAbsolute(tokens) ? tokens : join(sshDir, tokens)
  const slash = expanded.lastIndexOf(sep)
  const dir = expanded.slice(0, slash)
  const basename = expanded.slice(slash + 1)
  if (!/[?*]/u.test(basename))
    return [expanded]
  return readdirSyncSafe(dir)
    .filter(name => globMatches(basename, name))
    .sort()
    .map(name => join(dir, name))
}

function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  }
  catch {
    return []
  }
}

export async function loadSshConfigBlocks(sshDir: string, homeDir: string): Promise<SshHostBlock[]> {
  const blocks: SshHostBlock[] = []
  const visited = new Set<string>()
  await collectConfigBlocks(sshDir, homeDir, join(sshDir, SSH_CONFIG_FILE), 0, visited, blocks)
  return blocks
}

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

export async function resolveSshAuth(
  profile: MachineProfile,
  sshDir: string,
  homeDir: string,
  defaultUser: string = process.env.USER ?? '',
): Promise<ResolvedSshAuth> {
  const blocks = await loadSshConfigBlocks(sshDir, homeDir)
  const settings = lookupSshConfig(blocks, profile.host)
  const username = profile.user !== '' ? profile.user : settings.user ?? defaultUser
  const host = settings.hostName ?? profile.host
  const port = settings.port ?? profile.port
  const passphrase = profile.passphrase === undefined || profile.passphrase === '' ? undefined : profile.passphrase
  const password = profile.password === undefined || profile.password === '' ? undefined : profile.password
  const identityPaths = settings.identityFiles.length > 0
    ? settings.identityFiles
    : DEFAULT_IDENTITY_FILES.map(name => join(sshDir, name))
  const keys: ResolvedSshAuth['keys'] = []
  for (const path of identityPaths) {
    const privateKey = await readFile(expandTokenPath(path, homeDir, host, username), 'utf8').catch(() => undefined)
    if (privateKey !== undefined)
      keys.push({ privateKey, ...passphrase === undefined ? {} : { passphrase } })
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
