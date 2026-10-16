import type { RemoteSession } from '../types/index'
import { parse, stringify } from 'yaml'
import { shQuote } from './shell'

export interface WorkspaceAllowlist {
  allowBuilds: Record<string, boolean>
  onlyBuiltDependencies: string[]
}

export const EMPTY_ALLOWLIST: WorkspaceAllowlist = { allowBuilds: {}, onlyBuiltDependencies: [] }

export const WORKSPACE_TEMPLATE = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'

export function remoteProfileDir(profileName: string): string {
  return `.dsh/profiles/${profileName}`
}

export function isPortableAllowKey(key: string): boolean {
  const value = key.trim()
  if (value === '')
    return false
  if (value.includes('\\'))
    return false
  if (/^[a-z]:[\\/]/iu.test(value))
    return false
  const resolution = value.includes('@') ? value.slice(value.indexOf('@') + 1) : value
  if (/^(?:file|link|workspace):/iu.test(resolution))
    return false
  return true
}

function allowedValue(value: unknown): boolean {
  return value !== false
}

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
          break
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

function isIndented(line: string): boolean {
  return line.startsWith(' ') || line.startsWith('\t')
}

export function allowlistReadCommand(profileName: string): string {
  return `cat "$HOME/${remoteProfileDir(profileName)}/pnpm-workspace.yaml" 2>/dev/null || true`
}

export function allowlistWriteCommand(profileName: string, yamlText: string): string {
  const dir = `$HOME/${remoteProfileDir(profileName)}`
  return `mkdir -p "${dir}" && printf %s ${shQuote(yamlText)} > "${dir}/pnpm-workspace.yaml"`
}

export async function carryWorkspaceAllowlist(
  session: RemoteSession,
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
