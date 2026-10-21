import type { Document, YAMLMap } from 'yaml'
import type { McpCheckOptions, McpCheckResult, McpInput, McpListResult, McpRow, McpRowView } from './mcp.types'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { defineService, DSH_HOME } from 'dsh-tauri'
import { compact } from 'lodash-es'
import { join } from 'pathe'
import { MCP_PLUGIN, PATCH_FILE_NAME } from '../config/constants'
import { mcpAuth } from './mcp-auth'
import {
  insertListOf,
  loadPatch,
  managedInsert,
  mcpRowItems,
  readRows,
  rowSeq,
  savePatch,
  takenIds,
  toNode,
  updateRow,
} from './mcp.utils'

const MCP_CHECK_TIMEOUT_MS = 5_000

export const mcp = defineService({
  list(profileDirPath: string): McpListResult {
    let globalRows: McpRow[] = []
    let globalError: string | undefined
    if (existsSync(join(DSH_HOME, PATCH_FILE_NAME))) {
      try {
        globalRows = readRows(DSH_HOME)
      }
      catch (error) {
        globalError = error instanceof Error ? error.message : String(error)
      }
    }
    const globalIds = new Set(compact(globalRows.map(row => row.id)))
    return {
      servers: [
        ...globalRows.map((row): McpRowView => ({ ...row, scope: 'global' })),
        ...readRows(profileDirPath).map((row): McpRowView => ({
          ...row,
          scope: 'profile',
          ...(globalIds.has(row.id) ? { shadowed: true } : {}),
        })),
      ],
      ...(globalError !== undefined ? { globalError } : {}),
    }
  },

  peek(dirPath: string): McpRow[] {
    return readRows(dirPath)
  },

  save(dirPath: string, input: McpInput): string {
    const inputId = input.id ?? ''
    const doc = loadPatch(dirPath)
    const list = managedInsert(doc)
    const existing = inputId !== ''
      ? mcpRowItems(doc).find(({ node }) => String(node.get('id') ?? '') === inputId)
      : undefined
    if (existing !== undefined) {
      updateRow(doc, existing.node, input)
      savePatch(dirPath, doc)
      return inputId
    }

    const id = freeId(doc, inputId !== '' ? inputId : `mcp-${input.serverName}`, input.serverName)
    const node = toNode<YAMLMap>({ id, name: MCP_PLUGIN })
    updateRow(doc, node, input)
    list.add(node)
    savePatch(dirPath, doc)
    return id
  },

  copy(sourceDirPath: string, targetDirPath: string, id: string): string | undefined {
    const source = mcpRowItems(loadPatch(sourceDirPath)).find(({ node }) => String(node.get('id') ?? '') === id)
    if (source === undefined)
      return undefined
    const doc = loadPatch(targetDirPath)
    const list = managedInsert(doc)
    const node = source.node.clone() as YAMLMap
    const serverName = String(node.getIn(['config', 'serverName']) ?? '')
    const copyId = freeId(doc, `mcp-${serverName}`, serverName)
    node.set('id', copyId)
    list.add(node)
    savePatch(targetDirPath, doc)
    return copyId
  },

  remove(dirPath: string, id: string): boolean {
    const doc = loadPatch(dirPath)
    managedInsert(doc)
    const hit = mcpRowItems(doc).find(({ node }) => String(node.get('id') ?? '') === id)
    if (hit === undefined || hit.list === undefined)
      return false
    hit.list.items.splice(hit.list.items.indexOf(hit.node), 1)

    const seq = rowSeq(doc)
    const owner = (seq.items ?? []).find(item => insertListOf(item) === hit.list)
    if (owner !== undefined && hit.list.items.length === 0 && owner.items.length === 1)
      seq.items.splice(seq.items.indexOf(owner), 1)

    savePatch(dirPath, doc)
    return true
  },

  toggle(dirPath: string, id: string, disabled: boolean): boolean {
    const doc = loadPatch(dirPath)
    managedInsert(doc)
    const hit = mcpRowItems(doc).find(({ node }) => String(node.get('id') ?? '') === id)
    if (hit === undefined)
      return false
    if (disabled)
      hit.node.set('disabled', true)
    else
      hit.node.delete('disabled')
    savePatch(dirPath, doc)
    return true
  },

  async check(row: McpRow, options: McpCheckOptions = {}): Promise<McpCheckResult> {
    const pathEnv = options.pathEnv ?? process.env.PATH ?? ''
    if (row.transport === 'stdio') {
      const command = row.command ?? ''
      if (command === '')
        return { ok: false, detail: 'row has no command' }
      return resolveCommandOnPath(command, pathEnv, options.platform)
        ? { ok: true, detail: command }
        : { ok: false, detail: `${command} not found on PATH` }
    }
    if (row.url === undefined || !/^https?:\/\//.test(row.url))
      return { ok: false, detail: 'row has no http url' }
    return mcpAuth.check(row, options.timeoutMs ?? MCP_CHECK_TIMEOUT_MS)
  },
})

// --- internal ---

function freeId(doc: Document, preferred: string, serverName: string): string {
  const taken = takenIds(doc)
  let id = preferred
  let suffix = 2
  while (taken.has(id))
    id = `mcp-${serverName}-${suffix++}`
  return id
}

function resolveCommandOnPath(command: string, pathEnv: string, platform: string = process.platform): boolean {
  if (command.includes('/') || command.includes('\\'))
    return existsSync(command)
  const exts = platform === 'win32' ? ['', '.com', '.exe', '.bat', '.cmd'] : ['']
  const separator = platform === 'win32' ? ';' : ':'
  for (const rawDir of pathEnv.split(separator)) {
    const dir = rawDir.trim().replace(/^"|"$/g, '')
    if (dir === '')
      continue
    for (const ext of exts) {
      if (existsSync(join(dir, command + ext)))
        return true
    }
  }
  return false
}
