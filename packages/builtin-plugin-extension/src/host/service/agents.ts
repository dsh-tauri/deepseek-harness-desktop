import type { ImportedServer } from './agents.types'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { defineService } from 'dsh-tauri'
import { compact, filter, isEmpty, isObject, isString, pickBy, uniqBy } from 'lodash-es'
import { join } from 'pathe'
import { parse as parseToml } from 'smol-toml'

const CLAUDE_MCP_FILES = ['.claude/settings.json', '.claude.json'] as const

const CURSOR_MCP_FILE = '.cursor/mcp.json'

const GEMINI_MCP_FILE = '.gemini/settings.json'

const CODEX_MCP_FILE = '.codex/config.toml'

const AGENT_SKILL_DIRECTORIES = ['.claude/skills', '.codex/skills'] as const

export const agents = defineService({
  resolve(home: string = homedir()): ImportedServer[] {
    return uniqBy(
      [
        ...scanClaudeMcp(home),
        ...scanCodexMcp(home),
        ...scanJsonMcp(home, CURSOR_MCP_FILE, (name, entry) => mapMcpServersEntry('cursor', name, entry)),
        ...scanJsonMcp(home, GEMINI_MCP_FILE, (name, entry) => mapAgentEntry('gemini', name, entry, 'httpUrl')),
      ],
      server => `${server.agent}/${server.name}`,
    )
  },

  peek(home: string = homedir()): string[] {
    return AGENT_SKILL_DIRECTORIES
      .map(directory => join(home, directory))
      .filter(path => existsSync(path))
  },
})

function stringEntries(value: unknown): Record<string, string> | undefined {
  if (!isObject(value) || Array.isArray(value))
    return undefined
  const out = pickBy(value as Record<string, unknown>, isString)
  return isEmpty(out) ? undefined : out
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value))
    return undefined
  const out = filter(value, isString)
  return isEmpty(out) ? undefined : out
}

function mapMcpServersEntry(agent: ImportedServer['agent'], name: string, entry: unknown): ImportedServer | null {
  if (!isObject(entry))
    return null
  const record = entry as Record<string, unknown>
  const type = isString(record.type) ? record.type : 'stdio'
  if (type === 'stdio') {
    if (!isString(record.command) || record.command === '')
      return null
    return {
      agent,
      name,
      transport: 'stdio',
      command: record.command,
      args: stringArray(record.args),
      env: stringEntries(record.env),
    }
  }
  if (type === 'http' || type === 'streamable-http') {
    if (!isString(record.url) || record.url === '')
      return null
    return {
      agent,
      name,
      transport: 'streamable-http',
      url: record.url,
      headers: stringEntries(record.headers),
    }
  }
  return null
}

function mapAgentEntry(
  agent: ImportedServer['agent'],
  name: string,
  entry: unknown,
  urlKey: 'httpUrl' | 'url',
): ImportedServer | null {
  if (!isObject(entry))
    return null
  const record = entry as Record<string, unknown>
  if (isString(record.command) && record.command !== '') {
    return {
      agent,
      name,
      transport: 'stdio',
      command: record.command,
      args: stringArray(record.args),
      env: stringEntries(record.env),
    }
  }
  const url = record[urlKey]
  if (isString(url) && url !== '')
    return { agent, name, transport: 'streamable-http', url }
  return null
}

function scanClaudeMcp(home: string): ImportedServer[] {
  const merged: Record<string, unknown> = {}
  for (const file of CLAUDE_MCP_FILES) {
    const path = join(home, file)
    if (!existsSync(path))
      continue
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: unknown }
      if (isObject(parsed.mcpServers))
        Object.assign(merged, parsed.mcpServers)
    }
    catch {
      continue
    }
  }
  return compact(Object.entries(merged).map(([name, entry]) => mapMcpServersEntry('claude-code', name, entry)))
}

function scanJsonMcp(home: string, filename: string, mapEntry: (name: string, entry: unknown) => ImportedServer | null): ImportedServer[] {
  const file = join(home, filename)
  if (!existsSync(file))
    return []
  let parsed: { mcpServers?: unknown }
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: unknown }
  }
  catch {
    return []
  }
  if (!isObject(parsed.mcpServers))
    return []
  return compact(Object.entries(parsed.mcpServers).map(([name, entry]) => mapEntry(name, entry)))
}

function scanCodexMcp(home: string): ImportedServer[] {
  const file = join(home, CODEX_MCP_FILE)
  if (!existsSync(file))
    return []
  let root: Record<string, unknown>
  try {
    root = parseToml(readFileSync(file, 'utf8')) as Record<string, unknown>
  }
  catch {
    return []
  }
  const table = root.mcp_servers
  if (!isObject(table))
    return []
  return compact(Object.entries(table).map(([name, entry]) => mapAgentEntry('codex', name, entry, 'url')))
}
