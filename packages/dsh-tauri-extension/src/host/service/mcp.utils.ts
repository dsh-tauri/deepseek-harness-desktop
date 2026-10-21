import type { YAMLMap, YAMLSeq } from 'yaml'
import type { McpInput, McpRow, McpScope } from './mcp.types'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { DSH_HOME } from 'dsh-tauri'
import { compact, isEmpty, isObject, isPlainObject, isString, mapValues } from 'lodash-es'
import { join } from 'pathe'
import { Document, isMap, isNode, isScalar, isSeq, parseDocument } from 'yaml'
import { MCP_PLUGIN, PATCH_FILE_NAME } from '../config/constants'

const SERVER_NAME_RE = /^[\w-]{1,32}$/

const EMPTY_PATCH = '[]'

const COMMAND_TOKEN_RE = /"([^"]*)"|'([^']*)'|(\S+)/g

/** 按 shell 习惯切 token，保留引号内的空格（`"C:/Program Files/node.exe" --flag`）。 */
export function splitCommandLine(line: string): string[] {
  const tokens: string[] = []
  for (const match of line.matchAll(COMMAND_TOKEN_RE)) {
    const token = match[1] ?? match[2] ?? match[3]
    if (token !== undefined && token !== '')
      tokens.push(token)
  }
  return tokens
}

/**
 * 把 stdio 源归一成内核契约（`command` 是可执行文件，参数进 `args`）。
 *
 * Cursor 等客户端会把整条命令行塞进 `command`（`args` 留空），内核拿它当可执行文件
 * spawn，条目必然起不来；写入侧拆开，历史条目读出来也走同一条归一。
 * 显式给了 args、或本身就是一个存在的路径（含空格，如 Program Files）时原样保留。
 */
export function normalizeStdioCommand(command: string, args: readonly string[] | undefined): { command: string, args?: string[] } {
  const given = args ?? []
  if (given.length > 0)
    return { command, args: [...given] }
  const trimmed = command.trim()
  if (trimmed === '' || !/\s/.test(trimmed) || existsSync(trimmed))
    return { command }
  const [head, ...rest] = splitCommandLine(trimmed)
  if (head === undefined)
    return { command }
  return rest.length === 0 ? { command: head } : { command: head, args: rest }
}

export function normalizeMcpScope(value: unknown): McpScope {
  return value === 'global' ? 'global' : 'profile'
}

export function mcpScopeDir(scope: McpScope, profileDirPath: string): string {
  return scope === 'global' ? DSH_HOME : profileDirPath
}

export function validateMcpInput(input: McpInput): string | null {
  if (!SERVER_NAME_RE.test(input.serverName))
    return 'serverName must be 1-32 chars of A-Z a-z 0-9 _ -'
  const id = input.id ?? ''
  if (id.includes('/') || id.includes('..'))
    return 'invalid id'
  if (input.transport === 'stdio') {
    if (input.command === undefined || input.command.trim() === '')
      return 'stdio transport requires a command'
  }
  else if (input.url === undefined || !/^https?:\/\//.test(input.url)) {
    return 'http transport requires an http(s) url'
  }
  return null
}

export function loadPatch(dirPath: string): Document {
  const path = join(dirPath, PATCH_FILE_NAME)
  const text = existsSync(path) ? readFileSync(path, 'utf8') : EMPTY_PATCH
  const doc = parseDocument(text)
  assertPatchParses(path, doc)
  const contents = doc.contents as YAMLSeq | null
  if (contents !== null && contents.flow === true && contents.items.length === 0)
    contents.flow = false
  return doc
}

export function savePatch(dirPath: string, doc: Document): void {
  mkdirSync(dirPath, { recursive: true })
  writeFileSync(join(dirPath, PATCH_FILE_NAME), String(doc), 'utf8')
}

export function toNode<T>(value: unknown): T {
  return new Document(value as never).contents as T
}

export function rowSeq(doc: Document): YAMLSeq<YAMLMap> {
  if (doc.contents === null) {
    const seq = toNode<YAMLSeq<YAMLMap>>([])
    seq.flow = false
    doc.contents = seq
  }
  return doc.contents as YAMLSeq<YAMLMap>
}

export function insertListOf(item: YAMLMap): YAMLSeq<YAMLMap> | undefined {
  if (item.has('id'))
    return undefined
  const node = item.get('insert')
  return isSeqNode(node) ? node : undefined
}

export function mcpRowItems(doc: Document): { node: YAMLMap, list?: YAMLSeq<YAMLMap> }[] {
  const found: { node: YAMLMap, list?: YAMLSeq<YAMLMap> }[] = []
  for (const item of rowSeq(doc).items ?? []) {
    if (item.get('name') === MCP_PLUGIN)
      found.push({ node: item })
    const list = insertListOf(item)
    for (const row of list?.items ?? []) {
      if (row.get('name') === MCP_PLUGIN)
        found.push({ node: row, list })
    }
  }
  return found
}

export function managedInsert(doc: Document): YAMLSeq<YAMLMap> {
  const seq = rowSeq(doc)
  const bare: YAMLMap[] = []
  let target: YAMLSeq<YAMLMap> | undefined
  for (const item of seq.items ?? []) {
    if (item.get('name') === MCP_PLUGIN)
      bare.push(item)
    const list = insertListOf(item)
    if (list !== undefined && list.items.some(row => row.get('name') === MCP_PLUGIN))
      target ??= list
  }
  if (target === undefined) {
    const entry = toNode<YAMLMap>({ insert: [] })
    seq.add(entry)
    target = entry.get('insert') as YAMLSeq<YAMLMap>
    target.flow = false
  }
  for (const row of bare) {
    seq.items.splice(seq.items.indexOf(row), 1)
    target.add(row)
  }
  return target
}

export function takenIds(doc: Document): Set<string> {
  const nodes = (rowSeq(doc).items ?? []).flatMap(item => [item, ...(insertListOf(item)?.items ?? [])])
  return new Set(compact(nodes.map(node => String(node.get('id') ?? ''))))
}

export function readRows(dirPath: string): McpRow[] {
  const doc = loadPatch(dirPath)
  return mcpRowItems(doc).map(({ node }) => rowToMcp(doc, node))
}

/** 原地改写已有行：只写表单管的字段，值没变的节点原样保留（`!!js` 标签、表单外的字段不丢）。 */
export function updateRow(doc: Document, row: YAMLMap, input: McpInput): void {
  const current = row.get('config', true)
  const config = isMap(current) ? current : toNode<YAMLMap>({})
  for (const [key, value] of Object.entries(formConfig(input))) {
    if (isEmpty(value))
      config.delete(key)
    else
      config.set(key, keepUnchanged(doc, config.get(key, true), value))
  }
  row.set('config', config)
  if (input.disabled === true)
    row.set('disabled', true)
  else if (input.disabled === false)
    row.delete('disabled')
}

// --- internal ---

function assertPatchParses(path: string, doc: Document): void {
  if (doc.errors.length === 0)
    return
  const at = String(doc.errors[0].message).split('\n', 1)[0]
  const total = doc.errors.length > 1 ? `, +${doc.errors.length - 1} more` : ''
  throw new Error(
    `配置文件 ${path} 存在 YAML 语法错误（${at}${total}），未写入任何内容，请修复该文件后重试`
    + ` / YAML syntax error in the patch file (${at}${total}); nothing was written — fix it and retry`,
  )
}

function isSeqNode(value: unknown): value is YAMLSeq<YAMLMap> {
  return typeof value === 'object' && value !== null && Array.isArray((value as YAMLSeq).items)
}

function valueText(value: unknown): string {
  return isString(value) ? value : JSON.stringify(value)
}

function textMap(value: unknown): Record<string, string> | undefined {
  return isPlainObject(value) ? mapValues(value as Record<string, unknown>, valueText) : undefined
}

function formConfig(input: McpInput): Record<string, unknown> {
  if (input.transport !== 'stdio') {
    return {
      serverName: input.serverName,
      transport: input.transport,
      url: input.url,
      headers: input.headers,
      command: undefined,
      args: undefined,
      env: undefined,
      cwd: undefined,
    }
  }
  const stdio = normalizeStdioCommand(input.command ?? '', input.args)
  return {
    serverName: input.serverName,
    transport: input.transport,
    command: stdio.command,
    args: stdio.args,
    env: input.env,
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    url: undefined,
    headers: undefined,
  }
}

function keepUnchanged(doc: Document, current: unknown, next: unknown): unknown {
  if (Array.isArray(next)) {
    const items: unknown[] = isSeq(current) ? current.items : []
    const kept = next.map((value, index) => keepUnchanged(doc, items[index], value))
    return kept.length === items.length && kept.every((item, index) => item === items[index])
      ? current
      : toNode(kept)
  }
  if (isPlainObject(next)) {
    const map = isMap(current) ? current : toNode<YAMLMap>({})
    const keys = Object.keys(next as Record<string, unknown>)
    for (const pair of [...map.items]) {
      if (!keys.includes(String(isScalar(pair.key) ? pair.key.value : pair.key)))
        map.delete(pair.key)
    }
    for (const [key, value] of Object.entries(next as Record<string, unknown>))
      map.set(key, keepUnchanged(doc, map.get(key, true), value))
    return map
  }
  return isNode(current) && valueText(current.toJS(doc)) === next ? current : toNode(next)
}

function rowToMcp(doc: Document, item: YAMLMap): McpRow {
  const configNode = item.get('config') as unknown
  const plain = (isObject(configNode) && typeof (configNode as { toJS?: unknown }).toJS === 'function'
    ? (configNode as { toJS: (document: Document) => unknown }).toJS(doc)
    : {}) as Record<string, unknown>
  const env = textMap(plain.env)
  const headers = textMap(plain.headers)
  return {
    id: String(item.get('id') ?? ''),
    serverName: String(plain.serverName ?? ''),
    transport: plain.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
    disabled: item.get('disabled') === true,
    ...(typeof plain.command === 'string' && plain.command !== '' ? { command: plain.command } : {}),
    ...(Array.isArray(plain.args) ? { args: plain.args.map(valueText) } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(typeof plain.cwd === 'string' && plain.cwd !== '' ? { cwd: plain.cwd } : {}),
    ...(typeof plain.url === 'string' && plain.url !== '' ? { url: plain.url } : {}),
    ...(headers !== undefined ? { headers } : {}),
  }
}
