import type { SelectorHook } from '../types/selector'

export interface WorkspaceItemLike {
  workspaceId: string
  title: string
}

export interface WorkspaceListStateLike {
  items: readonly WorkspaceItemLike[]
  phase: string
}

export interface SessionListStateLike {
  current?: string
}

export interface HeroWorkspaceOwnerProps {
  open: boolean
  selectedId?: string
  onPick: (workspaceId: string) => void
  onClose: () => void
}

export interface HeroWorkspaceInjectedProps {
  useWorkspaces: SelectorHook<WorkspaceListStateLike>
  useSessions?: SelectorHook<SessionListStateLike>
  useDirectoryFlow?: SelectorHook<boolean>
  createWorkspace?: (input: { path: string }) => Promise<{ workspaceId: string }>
  startUngrouped: () => void
}

export type HeroWorkspaceProps = HeroWorkspaceOwnerProps & HeroWorkspaceInjectedProps
