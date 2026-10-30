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

export type JsonBody = Record<string, unknown>

export type WebServerService = WebServer

export interface HostPluginLoader {
  import: (name: string) => Promise<unknown>
  unwrapExports: (exports: unknown) => unknown
}

export type IndexInjectRow
  = | { kind: 'global', name: string, value: unknown }
    | { kind: 'script', placement: 'head' | 'body', text: string }

export type HostContext = Context & {
  sessions: SessionStore
  webServer: WebServerService
  loader: HostPluginLoader
  on: Context['on'] & ((event: 'webserver/index-inject', listener: (table: IndexInjectRow[]) => void) => () => void)
}
