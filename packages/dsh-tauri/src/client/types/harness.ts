/**
 * client/types/harness.ts — 客户端 harness 类型协议（唯一入口）。
 *
 * ctx 的类型完全来自上游：各上游 client 入口通过 `declare module` 增广
 * `@deepseek-ai/cordis` 的 `Context`（slots / uiRenderer / sessions / workspaces /
 * locale / layout），因此 `ClientContext` 就是增强后的 cordis `Context`，不再自行声明
 * 自包含接口。本文件同时是客户端全部类型（上游类型 + Tauri 桥/适配层协议）的唯一出口。
 *
 * 【基准】@deepseek-ai/* 0.2.1-alpha.1（版本由 pnpm-workspace.yaml 的 `dsh` catalog 钉住）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'

export * from './adapter'
export * from './bridge'
export * from './iframe'
export * from './tauri'

export type { Context } from '@deepseek-ai/cordis'
export type { ModelSelection } from '@deepseek-ai/dsh-agent'
export type {
  ISessions,
  SessionBinding,
  SessionListState,
  SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/client'
export type {
  IWorkspaces,
  WorkspaceId,
  WorkspaceSnapshot,
  WorkspaceSource,
  WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
export type {
  LocaleDict,
  LocaleId,
  LocaleRuntime,
  LocaleSnapshot,
  Translate,
} from '@deepseek-ai/dsh-client-locale/client'
export type { ILayout, MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
export type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
export type { SlotLabel, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
export type { SessionId } from '@deepseek-ai/dsh-session'
export type { ToolExecution, ToolRunContext } from '@deepseek-ai/dsh-tools'

/**
 * 客户端 ctx：上游 cordis `Context` 的客户端增广面。
 *
 * `sessions` 单独钉住：上游把 `Context` 同时按宿主/客户端两侧增广，本仓库的单个 TS
 * 程序里宿主侧 `dsh-session` 也增广 `sessions`（`SessionStore`），因此不依赖增广合并
 * 顺序，显式取客户端权威面 `ISessions`。
 */
export type ClientContext = Omit<Context, 'sessions'> & { sessions: ISessions }

/** 上游 `LocaleRuntime` 的插件侧别名（ctx.locale）。 */
export type LocaleService = LocaleRuntime

export type SlotEntryLike = StoredEntry
export type SlotEntryOptions = StoredEntry['options']
