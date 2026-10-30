import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'

export * from './adapter'
export type ErrorAction = 'runtime' | 'install' | 'update' | 'remove'

export type { Context } from '@deepseek-ai/cordis'
export type { ModelSelection } from '@deepseek-ai/dsh-agent'
export type {
  ISessions,
  SessionBinding,
  SessionListState,
  SessionProjectionMap,
  SessionProjectionSnapshot,
  SessionSummary,
  UseProjection,
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

export type ClientContext = Omit<Context, 'sessions'> & { sessions: ISessions }

export type LocaleService = LocaleRuntime

export type SlotEntryLike = StoredEntry
export type SlotEntryOptions = StoredEntry['options']
