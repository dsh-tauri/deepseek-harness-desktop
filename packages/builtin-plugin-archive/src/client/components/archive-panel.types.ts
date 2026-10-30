import type { SessionsRuntimeLike, WorkspacesRuntimeLike } from '../types/runtime'

export interface ArchiveRow {
  sessionId: string
  title: string
  cwd?: string
  createdAt?: number
  updatedAt?: number
  workspaceId?: string
  workspaceTitle?: string
}

export interface ArchiveGroupRow {
  id: string
  title: string
  rows: ArchiveRow[]
}

export interface ArchivePanelProps {
  close?: () => void
  sessionsRuntime: SessionsRuntimeLike
  workspacesRuntime: WorkspacesRuntimeLike
}

export interface ArchiveWorkspaceDialogProps {
  workspaceTitle: string
  sessionIds: readonly string[]
  onClose: () => void
  onConfirm: () => void
}

export type DeleteConfirm
  = | null
    | { kind: 'single', sessionId: string }
    | { kind: 'all' }
    | { kind: 'workspace', workspaceTitle: string, sessionIds: string[] }
