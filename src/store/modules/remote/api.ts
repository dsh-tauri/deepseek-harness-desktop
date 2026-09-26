/**
 * `/api-ssh` 客户端：壳层与 SSH 引擎（本地实例上的 dsh-tauri-ssh 插件）的
 * 全部数据往来。协议是 S1 契约的最小 JSON 信封（同源 POST、loopback-only）：
 *
 *   POST /api-ssh  { "method": "machine.list", "payload": {} }
 *   → 200          { "ok": true, "value": ... } | { "ok": false, "error": {...} }
 *
 * 壳层消费：`machine.list`（轮询）、`machine.connect`/`machine.disconnect`
 * （切换与断开）、`machine.save`/`machine.remove`/`machine.test`（管理面板）、
 * `machine.events`（连接进度弹窗的实时日志）。fetch 与基础 URL 均可注入，
 * 便于单测与复用。
 * @module store/remote/api
 */

import type { SshConnectionState, SshEventEntry, SshMachineListValue, SshMachineProfile, SshMachineRow, SshProgress, SshSecrets } from './types'

/** 一次请求信封。 */
interface SshApiRequest {
  method: string
  payload?: Record<string, unknown>
}

/** 一次应答信封。 */
type SshApiResponse
  = | { ok: true, value: unknown }
    | { ok: false, error: { code: string, message: string } }

/** fetch 函数形状（与全局 fetch 兼容，可注入 mock）。 */
export type SshFetchFn = (input: string, init?: RequestInit) => Promise<Response>

/**
 * 本地实例答了，但没有 SSH API：插件未加载 / 未启用（404、405 或非 JSON 响应）。
 * 与网络失败区分——前者是「SSH 不可用」，后者才是「本地实例不可达」。
 */
export class SshApiHttpError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`SSH_API_HTTP_${status}`)
    this.status = status
  }
}

/** `machine.list` 的应答值：SSH 开关 + 机器行。 */
export interface SshMachineList {
  /** SSH 功能是否已启用；未启用时机器行为空，壳层不渲染切换器。 */
  enabled: boolean
  machines: SshMachineRow[]
}

/** 本客户端面向壳层暴露的引擎动作。 */
export interface SshApiClient {
  /** `machine.list`：SSH 开关 + 手动机器与 ~/.ssh/config 别名机器（已按名排序合并）。 */
  listMachines: () => Promise<SshMachineList>
  /** `machine.connect`：阻塞到隧道就绪，返回隧道 URL。 */
  connect: (machineId: string) => Promise<{ tunnelBaseUrl: string }>
  /** `machine.disconnect`：主动断开（远端实例保持运行）。 */
  disconnect: (machineId: string) => Promise<void>
  /** `machine.save`：保存（新增/覆盖）手动机器；secrets 仅显式传入时更新。 */
  save: (machine: SshMachineProfile, secrets?: SshSecrets) => Promise<void>
  /** `machine.remove`：删除手动机器。 */
  remove: (machineId: string) => Promise<void>
  /** `machine.test`：快速 SSH 握手探测（不建隧道）。 */
  test: (machineId: string) => Promise<{ ok: boolean, banner?: string }>
  /** `machine.events`：增量事件日志（seq 游标）。 */
  events: (machineId: string, sinceSeq?: number) => Promise<{ items: SshEventEntry[] }>
}

/** 非法机器行兜底：缺 id/name/state 的行直接丢弃，不让坏数据进切换器。 */
function machineRowOf(raw: unknown): SshMachineRow | undefined {
  if (typeof raw !== 'object' || raw === null)
    return undefined
  const value = raw as Record<string, unknown>
  if (typeof value.id !== 'string' || value.id === '')
    return undefined
  if (typeof value.name !== 'string' || value.name === '')
    return undefined
  const STATES: SshConnectionState[] = ['disconnected', 'testing', 'connecting', 'connected', 'reconnecting', 'given-up']
  if (!STATES.includes(value.state as SshConnectionState))
    return undefined
  return {
    id: value.id,
    name: value.name,
    ...typeof value.color === 'string' && value.color !== '' ? { color: value.color } : {},
    ...value.tintBorder === true ? { tintBorder: true } : {},
    ...typeof value.host === 'string' && value.host !== '' ? { host: value.host } : {},
    ...typeof value.port === 'number' ? { port: value.port } : {},
    ...typeof value.user === 'string' && value.user !== '' ? { user: value.user } : {},
    ...typeof value.remotePort === 'number' ? { remotePort: value.remotePort } : {},
    ...typeof value.startCommand === 'string' && value.startCommand !== '' ? { startCommand: value.startCommand } : {},
    ...value.hasPassword === true ? { hasPassword: true } : {},
    ...value.hasPassphrase === true ? { hasPassphrase: true } : {},
    state: value.state as SshConnectionState,
    ...typeof value.tunnelBaseUrl === 'string' ? { tunnelBaseUrl: value.tunnelBaseUrl } : {},
    ...typeof value.lastError === 'string' ? { lastError: value.lastError } : {},
    ...typeof value.nextRetryAt === 'number' ? { nextRetryAt: value.nextRetryAt } : {},
    ...value.authMethod === 'agent' || value.authMethod === 'key' || value.authMethod === 'password'
      ? { authMethod: value.authMethod }
      : {},
    ...progressOf(value.progress),
  }
}

/** progress 投影：phase 合法才保留，附带可选 attempt/total/log。 */
function progressOf(raw: unknown): { progress?: SshProgress } {
  if (typeof raw !== 'object' || raw === null)
    return {}
  const value = raw as Record<string, unknown>
  const PHASES: SshProgress['phase'][] = ['handshake', 'installing', 'starting', 'probing']
  if (!PHASES.includes(value.phase as SshProgress['phase']))
    return {}
  return {
    progress: {
      phase: value.phase as SshProgress['phase'],
      ...typeof value.attempt === 'number' ? { attempt: value.attempt } : {},
      ...typeof value.total === 'number' ? { total: value.total } : {},
      ...typeof value.log === 'string' ? { log: value.log } : {},
    },
  }
}

/**
 * 组一个 `/api-ssh` 客户端。
 *
 * @param fetchFn - fetch 实现（默认全局 fetch；测试注入 mock）。
 * @param getBaseUrl - 本地实例基址（默认读 harness store 的 serviceUrl）。
 */
export function createSshApiClient(
  fetchFn: SshFetchFn,
  getBaseUrl: () => string,
): SshApiClient {
  async function call<T>(method: string, payload?: Record<string, unknown>): Promise<T> {
    const response = await fetchFn(`${getBaseUrl()}/api-ssh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, payload: payload ?? {} } satisfies SshApiRequest),
    })
    // 非 2xx 与空/非 JSON 响应都不是信封：抛稳定的 HTTP 错误码，避免把
    // `Unexpected end of JSON input` 这类原生解析异常泄漏到界面/降级提示。
    if (!response.ok)
      throw new SshApiHttpError(response.status)
    let envelope: SshApiResponse
    try {
      envelope = await response.json() as SshApiResponse
    }
    catch {
      throw new SshApiHttpError(response.status)
    }
    if (!envelope.ok)
      throw new Error(envelope.error?.message || envelope.error?.code || 'SSH_API_ERROR')
    return envelope.value as T
  }

  return {
    async listMachines() {
      const value = await call<SshMachineListValue>('machine.list')
      const items = (value?.items ?? []).map(machineRowOf).filter((row): row is SshMachineRow => row !== undefined)
      const discovered = (value?.discovered ?? []).map(machineRowOf).filter((row): row is SshMachineRow => row !== undefined)
      // 确定性排序（localeCompare 的 ICU 整序在不同环境不稳定）
      const machines = [...items, ...discovered].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      return { enabled: value?.enabled === true, machines }
    },
    connect: machineId => call<{ tunnelBaseUrl: string }>('machine.connect', { machineId }),
    disconnect: async (machineId) => {
      await call<unknown>('machine.disconnect', { machineId })
    },
    /** 保存（新增/覆盖）一台手动机器；secrets 仅在显式传入时更新。 */
    save: async (machine: SshMachineProfile, secrets?: SshSecrets) => {
      await call<unknown>('machine.save', { machine, secrets })
    },
    remove: async (machineId) => {
      await call<unknown>('machine.remove', { machineId })
    },
    /** 快速 SSH 握手探测（不建隧道）；失败时引擎错误消息即原因。 */
    test: machineId => call<{ ok: boolean, banner?: string }>('machine.test', { machineId }),
    /** 增量取事件日志（seq 游标；空数组 = 无新事件）。 */
    events: (machineId, sinceSeq = 0) => call<{ items: SshEventEntry[] }>('machine.events', { machineId, sinceSeq }),
  }
}
