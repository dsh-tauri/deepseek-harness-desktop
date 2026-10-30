import type { McpImportItem, ParsedMcpJson } from './mcp-tab.types'
import { isEmpty, omitBy, orderBy, uniq } from 'dsh-tauri/client'

export function importGroups(items: McpImportItem[]): Array<{ agent: string, label: string, items: Array<{ item: McpImportItem, index: number }> }> {
  const label = (agent: string): string => agent === 'claude-code' ? 'Claude Code' : agent === 'codex' ? 'Codex' : agent === 'cursor' ? 'Cursor' : agent === 'gemini' ? 'Gemini CLI' : agent
  const order = ['claude-code', 'codex', 'cursor', 'gemini']
  const agents = orderBy(uniq(items.map(item => item.server.agent)), agent => order.indexOf(agent))
  return agents.map(agent => ({
    agent,
    label: label(agent),
    items: items.map((item, index) => ({ item, index })).filter(({ item }) => item.server.agent === agent),
  }))
}

export function parsePairs(text: string, separator: ':' | '='): Record<string, string> {
  const map: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#'))
      continue
    const at = trimmed.indexOf(separator)
    if (at <= 0)
      continue
    map[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim()
  }
  return map
}

export function mapToPairs(map: Record<string, string> | undefined, separator: string): string {
  if (map === undefined)
    return ''
  return Object.entries(map).map(([key, value]) => `${key}${separator}${value.includes('\n') ? JSON.stringify(value) : value}`).join('\n')
}

export function parseMcpJson(text: string): ParsedMcpJson | { error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  }
  catch {
    return { error: 'not valid JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null)
    return { error: 'expected a JSON object' }
  let record = parsed as Record<string, unknown>
  let nameFromWrapper: string | undefined
  const wrapped = record.mcpServers ?? record.mcp_servers ?? record.servers
  if (typeof wrapped === 'object' && wrapped !== null && !Array.isArray(wrapped)) {
    const first = Object.entries(wrapped as Record<string, unknown>)[0]
    if (first === undefined)
      return { error: 'mcpServers object is empty' }
    nameFromWrapper = first[0]
    if (typeof first[1] !== 'object' || first[1] === null)
      return { error: 'server entry is not an object' }
    record = first[1] as Record<string, unknown>
  }
  const stringMap = (value: unknown): Record<string, string> | undefined => {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return undefined
    const out = omitBy(value as Record<string, unknown>, entry => typeof entry !== 'string') as Record<string, string>
    return isEmpty(out) ? undefined : out
  }
  const args = Array.isArray(record.args) && record.args.every(entry => typeof entry === 'string')
    ? record.args as string[]
    : undefined
  const command = typeof record.command === 'string' ? record.command : undefined
  const url = typeof record.url === 'string' ? record.url : undefined
  const declared = typeof record.type === 'string' ? record.type : typeof record.transport === 'string' ? record.transport : undefined
  const httpDeclared = declared === 'http' || declared === 'streamable-http' || declared === 'sse'
  const transport: 'stdio' | 'streamable-http' = command !== undefined && !httpDeclared
    ? 'stdio'
    : url !== undefined ? 'streamable-http' : httpDeclared ? 'streamable-http' : 'stdio'
  if (transport === 'stdio' && command === undefined)
    return { error: 'stdio config needs a "command" field' }
  if (transport === 'streamable-http' && url === undefined)
    return { error: 'http config needs a "url" field' }
  const serverName = nameFromWrapper
    ?? (typeof record.serverName === 'string' ? record.serverName : undefined)
    ?? (typeof record.name === 'string' && record.name !== '@deepseek-ai/dsh-mcp-client' ? record.name : undefined)
  const env = stringMap(record.env)
  const headers = stringMap(record.headers)
  const draft: ParsedMcpJson = { serverName, transport, command, args, env, url, headers }
  return omitBy(draft, value => value === undefined) as ParsedMcpJson
}
