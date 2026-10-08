import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PLUGIN_ID, REMOTE_TAB_ACCESS as PLUGIN_TAB_ACCESS, REMOTE_TAB_MACHINES as PLUGIN_TAB_MACHINES, REMOTE_TAB_SYNC as PLUGIN_TAB_SYNC, SETTINGS_SECTION_ID } from '../packages/dsh-tauri-remote/src/client/constants/index'
import { REMOTE_SECTION, REMOTE_TAB_ACCESS, REMOTE_TAB_MACHINES, REMOTE_TAB_SYNC } from '../src/layout/components/nav-bridge'

const ROOT = resolve(import.meta.dirname, '..')
const PLUGIN = 'dsh-tauri-remote'
const PREFIX = `/api/tauri/${PLUGIN.replace('dsh-tauri-', '')}`

const HOST_ROUTES = 'packages/dsh-tauri-remote/src/host/server/index.ts'
const PANEL_ROUTES = 'packages/dsh-tauri-remote/src/host/server/panel.ts'
const RUST_BRIDGE = 'src-tauri/src/bridge/remote.rs'
const SHELL_API = 'src/apis/remote.ts'
const PLUGIN_API = 'packages/dsh-tauri-remote/src/client/apis/index.ts'
const PLUGIN_API_TYPES = 'packages/dsh-tauri-remote/src/client/apis/index.type.ts'
const EVENTS_ROUTE = 'packages/dsh-tauri-remote/src/host/server/routes/machines/events/get.ts'

function source(relative: string): string {
  return readFileSync(resolve(ROOT, relative), 'utf8')
}

/** 从 `app.<verb>('<path>', handler)` 逐条取注册表的「方法 + 路径」；路径是字面量，不从插件名派生。 */
function hostRoutes(relative: string): string[] {
  const pattern = /app\.(get|post|put|delete|patch)\('([^']+)'/g
  return [...source(relative).matchAll(pattern)].map(match => `${match[1].toUpperCase()} ${match[2]}`)
}

/** 从 `ofetch<T>("<path>", { method: "<verb>" })` 取生成客户端的「方法 + 完整 URL」。 */
function clientCalls(relative: string): string[] {
  const pattern = /ofetch<[^>]+>\("([^"]+)",\s*\{\s*method:\s*"(\w+)"/g
  return [...source(relative).matchAll(pattern)].map(match => `${match[2].toUpperCase()} ${match[1]}`)
}

function exportedApiNames(relative: string): string[] {
  return [...source(relative).matchAll(/export function (\w+)\(/g)].map(match => match[1])
}

/** Rust 里出现的全部 `"<VERB> /api/tauri/…"` 字面量：生产 match、单测允许列表与负例共用同一文件。 */
function rustEndpointLiterals(): string[] {
  return [...source(RUST_BRIDGE).matchAll(/"((?:GET|POST|DELETE|PUT|PATCH) \/api\/tauri\/[^"]*)"/g)].map(match => match[1])
}

/** 生成客户端里 `params?: Types.<X>` 引用的具名查询契约。 */
function queryTypeNames(): string[] {
  return [...source(PLUGIN_API).matchAll(/params\?: Types\.(\w+)/g)].map(match => match[1])
}

const EXPECTED_ENDPOINTS = [
  `POST ${PREFIX}/machines/connect`,
  `GET ${PREFIX}/machines`,
  `POST ${PREFIX}/machines`,
  `DELETE ${PREFIX}/machines`,
  `POST ${PREFIX}/machines/disconnect`,
  `GET ${PREFIX}/machines/events`,
  `POST ${PREFIX}/machines/install`,
  `POST ${PREFIX}/machines/test`,
  `GET ${PREFIX}/session/role`,
  `GET ${PREFIX}/settings`,
  `POST ${PREFIX}/settings`,
  `POST ${PREFIX}/sync/apply`,
  `GET ${PREFIX}/sync/preview`,
]

const HOST_ROUTE_ORDER = [
  `GET ${PREFIX}/settings`,
  `POST ${PREFIX}/settings`,
  `GET ${PREFIX}/session/role`,
  `GET ${PREFIX}/machines`,
  `POST ${PREFIX}/machines`,
  `DELETE ${PREFIX}/machines`,
  `POST ${PREFIX}/machines/test`,
  `POST ${PREFIX}/machines/connect`,
  `POST ${PREFIX}/machines/disconnect`,
  `POST ${PREFIX}/machines/install`,
  `GET ${PREFIX}/machines/events`,
  `GET ${PREFIX}/sync/preview`,
  `POST ${PREFIX}/sync/apply`,
]

/**
 * 面板专用入口（S4/S5）：只在 `server/panel.ts` 登记，由面板 iframe 同源 fetch 消费，
 * **不进**桌面壳白名单与两份生成客户端；新增这类路由必须在此显式登记。
 */
const ACCESS_ROUTE_ORDER = [
  `GET ${PREFIX}/access`,
  `POST ${PREFIX}/access`,
  `POST ${PREFIX}/access/token`,
  `DELETE ${PREFIX}/access/token`,
  `POST ${PREFIX}/access/tunnel`,
  `DELETE ${PREFIX}/access/tunnel`,
]

describe('shell ↔ plugin identity contract', () => {
  it('the shell settings section id is the plugin id the section registers under', () => {
    expect(REMOTE_SECTION).toBe(PLUGIN_ID)
    expect(SETTINGS_SECTION_ID).toBe(PLUGIN_ID)
    expect(PLUGIN_ID).toBe(PLUGIN)
  })

  it('the shell deep-link tabs are the tabs the plugin keys its panels by', () => {
    expect([REMOTE_TAB_MACHINES, REMOTE_TAB_SYNC, REMOTE_TAB_ACCESS]).toEqual([PLUGIN_TAB_MACHINES, PLUGIN_TAB_SYNC, PLUGIN_TAB_ACCESS])
  })

  it('both generated clients inline the plugin prefix on every call', () => {
    const shell = clientCalls(SHELL_API)
    expect(shell.length).toBeGreaterThan(0)
    for (const call of shell)
      expect(call).toContain(`${PREFIX}/`)
    for (const call of clientCalls(PLUGIN_API))
      expect(call).toContain(`${PREFIX}/`)
  })
})

describe('13-endpoint agreement across the four lists', () => {
  it('the management route table declares exactly the 13 endpoints', () => {
    expect(hostRoutes(HOST_ROUTES)).toEqual(HOST_ROUTE_ORDER)
  })

  it('the panel route table declares exactly the exposed access endpoints', () => {
    expect(hostRoutes(PANEL_ROUTES)).toEqual(ACCESS_ROUTE_ORDER)
  })

  it('the shell and plugin generated clients cover exactly the management route table', () => {
    expect([...clientCalls(SHELL_API)].sort()).toEqual([...EXPECTED_ENDPOINTS].sort())
    expect([...clientCalls(PLUGIN_API)].sort()).toEqual([...EXPECTED_ENDPOINTS].sort())
  })

  it('neither generated client nor the rust bridge carries a panel-only route', () => {
    for (const route of ACCESS_ROUTE_ORDER) {
      expect(clientCalls(SHELL_API)).not.toContain(route)
      expect(clientCalls(PLUGIN_API)).not.toContain(route)
      expect(rustEndpointLiterals()).not.toContain(route)
    }
  })

  it('the rust desktop bridge whitelists exactly the management route table', () => {
    const literals = rustEndpointLiterals()
    const whitelisted = [...new Set(literals)].filter(literal => EXPECTED_ENDPOINTS.includes(literal))
    expect(whitelisted.sort()).toEqual([...EXPECTED_ENDPOINTS].sort())
    // 生产 match 与单测的允许列表各写一次；负例（PUT、大小写、多余查询、换行）不引入新端点。
    for (const endpoint of EXPECTED_ENDPOINTS)
      expect(literals.filter(literal => literal === endpoint).length, endpoint).toBeGreaterThanOrEqual(2)
  })

  it('every plugin generated function is named after its route file path', () => {
    expect([...exportedApiNames(PLUGIN_API)].sort()).toEqual([...[
      'postMachinesConnect',
      'getMachines',
      'postMachines',
      'deleteMachines',
      'postMachinesDisconnect',
      'getMachinesEvents',
      'postMachinesInstall',
      'postMachinesTest',
      'getSessionRole',
      'getSettings',
      'postSettings',
      'postSyncApply',
      'getSyncPreview',
    ]].sort())
    expect(exportedApiNames(PLUGIN_API)).toHaveLength(EXPECTED_ENDPOINTS.length)
    expect(exportedApiNames(SHELL_API)).toEqual(exportedApiNames(PLUGIN_API))
  })

  it('the generated query contracts are the ones the route handlers declare', () => {
    expect(queryTypeNames()).toEqual(['GetApiTauriRemoteMachinesEventsQuery'])
    expect(source(EVENTS_ROUTE)).toContain('GetMachinesEventsQuery')
    expect(source(PLUGIN_API_TYPES)).toContain('export interface GetApiTauriRemoteMachinesEventsQuery {')
  })

  it('no stale ssh identifier survives in either generated client', () => {
    expect(source(SHELL_API)).not.toMatch(/ssh/i)
    expect(source(PLUGIN_API)).not.toMatch(/ssh/i)
    expect(source(PLUGIN_API_TYPES)).not.toMatch(/ssh/i)
  })
})
