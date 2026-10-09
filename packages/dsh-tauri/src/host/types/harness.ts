/**
 * host/types/harness.ts — 宿主侧 harness 类型协议（唯一入口）。
 *
 * ctx 的宿主服务面完全来自上游：`@deepseek-ai/cordis` 的 `Context` 由各宿主包
 * `declare module` 增广（agents / sessions / tools / llm / workspaceRegistry /
 * agentDefaultModel / agentPresets / permissionPresets / connection /
 * storageDomain / approval）。本文件只补桌面端自有的宿主服务（webServer / loader），
 * 并作为 dsh-tauri 宿主侧全部类型的统一出口。
 *
 * 【基准】@deepseek-ai/* 0.2.1-alpha.1（版本由 pnpm-workspace.yaml 的 `dsh` catalog 钉住）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { SessionStore } from '@deepseek-ai/dsh-session'
import type { IncomingMessage } from 'node:http'

export type { Context } from '@deepseek-ai/cordis'
export type { Agent, AgentHandle, AgentRegistry, ModelSelection } from '@deepseek-ai/dsh-agent'
export type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
export type { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
export type {
  ConnectionRequestRejection,
  ConnectionTrustRequest,
  HostConnectionFetch,
  HostConnectionHandle,
  HostConnectionRpc,
} from '@deepseek-ai/dsh-client-connection'
export type { ContentBlock, LlmRuntime, Message, MessageSource, UserMessage } from '@deepseek-ai/dsh-llm'
export type { PermissionPresetService, PresetOption } from '@deepseek-ai/dsh-permission-presets'
export type { Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
export type {
  ToolDefinition,
  ToolExecution,
  ToolExecutionResult,
  ToolRunContext,
  ToolRuntime,
} from '@deepseek-ai/dsh-tools'
export type { WorkspaceId, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
export interface ConnectionGate {
  requestRejection: (request: IncomingMessage) => 401 | 403 | undefined
}

export type HostRoute = WebRoute
export type RouteHandler = WebRoute['handler']
export type RoutesContext = Context

/** JSON 请求体（插件路由自报协议的公共形状）。 */
export type JsonBody = Record<string, unknown>

/** 宿主 webserver 注册面；字段与 `@deepseek-ai/dsh-host-webserver` 的 register 契约逐字一致。 */
export type WebServerService = WebServer

/** 平台模块加载器：从 DSH 安装目录解析核心包（内置插件资源目录没有 node_modules）。 */
export interface HostPluginLoader {
  import: (name: string) => Promise<unknown>
  unwrapExports: (exports: unknown) => unknown
}

/**
 * 宿主 ctx：上游 cordis `Context`（含全部宿主服务增广）+ 桌面端自有服务。
 *
 * `sessions` 单独钉住：上游把 `Context` 同时按宿主/客户端两侧增广，本仓库的单个 TS
 * 程序里两侧都在场，因此不依赖增广合并顺序，显式取宿主权威面 `SessionStore`。
 */
/** 宿主 webserver 的结构化 index 注入行（与 `dsh-host-webserver` 的 renderRow 契约一致）。 */
export type IndexInjectRow
  = | { kind: 'global', name: string, value: unknown }
    | { kind: 'script', placement: 'head' | 'body', text: string }

export type HostContext = Context & {
  sessions: SessionStore
  webServer: WebServerService
  loader: HostPluginLoader
  on: Context['on'] & ((event: 'webserver/index-inject', listener: (table: IndexInjectRow[]) => void) => () => void)
}
