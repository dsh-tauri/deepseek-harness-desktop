import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { SlotHookFactory } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId, SessionListState } from 'dsh-tauri/client'
import type { TaskFormState } from './index'

export type TaskTabNavigation
  = | { id: string, sessionId?: string, draft?: false }
    | { draft: true, sessionId?: string, initial?: TaskFormState }

export interface TaskTabPage {
  readonly id: string
  readonly kind: string
  readonly contentId: string
}

export interface TaskTabInfo {
  readonly tab: TaskTabPage & {
    readonly title: string
    readonly visible: boolean
    readonly navigation: { readonly params?: unknown, readonly revision: number }
    readonly signal: AbortSignal
    readonly actions: {
      close: () => void
      openTab: (kind: string, options: { params: TaskTabNavigation }) => void
      bindCommands: (commands: { refresh: () => void }) => () => void
    }
  }
}

export interface SidebarRight {
  readonly mounted: {
    getSnapshot: () => SessionId | undefined
    subscribe: (listener: () => void) => () => void
  }
  openTab: (kind: string, options: { params: TaskTabNavigation }) => void
  tabsIn?: (sessionId: SessionId) => readonly TaskTabPage[]
}

export interface SidebarRightTabs {
  register: (definition: {
    id: string
    kind: string
    priority: 'extension'
    keepMounted: boolean
    title: () => string
  }) => () => void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SessionStandardProps {
    sessionId: SessionId
  }
  interface GlobalStandardProps {
    useSessions: SnapshotSelectorHook<SessionListState>
  }
  interface SlotMap {
    'sidebar.right.pane.tab': {
      kind: 'keyed'
      scope: 'session'
      hookContext: unknown
      inject: { hooks: { tabInfo: SlotHookFactory<'sidebar.right.pane.tab', () => TaskTabInfo> } }
    }
    'sidebar.right.pane.tab.title': {
      kind: 'keyed'
      scope: 'session'
      hookContext: unknown
      inject: { hooks: { tabInfo: SlotHookFactory<'sidebar.right.pane.tab.title', () => TaskTabInfo> } }
    }
  }
}
