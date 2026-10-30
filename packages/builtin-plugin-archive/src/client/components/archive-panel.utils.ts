import type { GetApiTauriArchiveSessionArchiveResponse as ArchivedListPayload } from '../apis/index.type'
import type { ArchiveSort } from '../store/modules/archive.types'
import type { SessionListSnapshot, WorkspaceListSnapshot } from '../types/runtime'
import type { ArchiveGroupRow, ArchiveRow } from './archive-panel.types'
import { format, groupBy, keyBy, orderBy } from 'dsh-tauri/client'
import { locale } from '../locales'

export function buildRows(
  archivedSessionIds: readonly string[],
  meta: ArchivedListPayload['meta'],
  sessions: SessionListSnapshot,
  workspaces: WorkspaceListSnapshot,
  titleById: Record<string, string>,
): ArchiveRow[] {
  const byPath = keyBy(workspaces.items, 'path')

  const rows: ArchiveRow[] = []
  for (const sessionId of archivedSessionIds) {
    const summary = sessions.byId[sessionId]
    const entry = meta[sessionId]
    if ((!summary && !entry) || summary?.blank === true)
      continue
    const cwd = summary?.cwd ?? entry?.cwd
    const workspace = workspaces.items.find(item => (item.sessionIds as readonly string[]).includes(sessionId))
      ?? (cwd ? byPath[cwd] : undefined)
    rows.push({
      sessionId,
      title: summary?.displayTitle ?? summary?.title ?? entry?.title ?? titleById[sessionId] ?? (cwd ? workspaceTitleOf(cwd) : undefined) ?? locale.text('untitled'),
      cwd,
      createdAt: entry?.createdAt,
      updatedAt: summary?.updatedAt,
      workspaceId: workspace?.workspaceId,
      workspaceTitle: workspace?.title ?? (workspace ? workspaceTitleOf(workspace.path) : undefined),
    })
  }
  return rows
}

export function projectOptions(rows: readonly ArchiveRow[]): Array<{ value: string, label: string }> {
  const scoped = rows.filter((row): row is ArchiveRow & { workspaceId: string } => Boolean(row.workspaceId))
  return Object.entries(keyBy(scoped, 'workspaceId')).map(([id, row]) => ({ value: id, label: row.workspaceTitle ?? id }))
}

export function formatTime(row: ArchiveRow): string {
  const value = row.updatedAt ?? row.createdAt
  if (!value)
    return ''
  return format(new Date(value), locale.isEnglishLocale() ? 'yyyy-MM-dd HH:mm' : 'yyyy年MM月dd日 HH:mm')
}

export function groupArchive(rows: readonly ArchiveRow[], sort: ArchiveSort, ungroupedLabel: string): ArchiveGroupRow[] {
  const pick = rowSortKey(sort)
  const order: 'asc' | 'desc' = sort === 'title' ? 'asc' : 'desc'
  const entries = Object.entries(groupBy(rows, row => row.workspaceId ?? 'ungrouped')).map(([id, members]) => {
    const ordered = orderBy(members, pick, order)
    const anchor = sort === 'createdAt' ? ordered[ordered.length - 1] : ordered[0]
    return {
      key: anchor ? pick(anchor) : '',
      group: {
        id,
        title: members.find(row => row.workspaceId)?.workspaceTitle ?? (id === 'ungrouped' ? ungroupedLabel : ''),
        rows: ordered,
      },
    }
  })
  return orderBy(entries, entry => entry.key, order).map(entry => entry.group)
}

function workspaceTitleOf(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

function rowSortKey(sort: ArchiveSort): (row: ArchiveRow) => number | string {
  if (sort === 'title')
    return row => row.title.toLowerCase()
  if (sort === 'createdAt')
    return row => row.createdAt ?? 0
  return row => row.updatedAt ?? 0
}
