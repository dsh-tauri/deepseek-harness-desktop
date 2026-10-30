import type { ArchivePanelProps } from '../components/archive-panel.types'
import { uniq, useStore, useWatchImmediate } from 'dsh-tauri/client'
import { useSyncExternalStore } from 'react'
import { buildRows, groupArchive } from '../components/archive-panel.utils'
import { locale } from '../locales'
import { store } from '../store'

export function useArchiveView(props: ArchivePanelProps) {
  const ui = useStore(store.archive)
  const sessions = useSyncExternalStore(props.sessionsRuntime.list.subscribe, props.sessionsRuntime.list.getSnapshot)
  const workspaces = useSyncExternalStore(props.workspacesRuntime.list.subscribe, props.workspacesRuntime.list.getSnapshot)

  const archivedIds = uniq([...ui.archived.archivedSessionIds, ...(workspaces.archivedSessionIds ?? [])])
    .filter(id => !ui.suppressedSessionIds.includes(id))
  const rows = buildRows(archivedIds, ui.archived.meta, sessions, workspaces, ui.titleById)

  useWatchImmediate([rows], () => {
    store.archive.mergeTitles(Object.fromEntries(rows.map(row => [row.sessionId, row.title] as const)))
  })

  const query = ui.query.trim().toLowerCase()
  const matched = query
    ? rows.filter(row =>
        row.title.toLowerCase().includes(query)
        || (row.cwd ?? '').toLowerCase().includes(query)
        || (row.workspaceTitle ?? '').toLowerCase().includes(query))
    : rows
  const visible = ui.workspaceId === 'all'
    ? matched
    : matched.filter(row => ui.workspaceId === 'ungrouped' ? !row.workspaceId : row.workspaceId === ui.workspaceId)

  return {
    ui,
    rows,
    visible,
    groups: groupArchive(visible, ui.sort, locale.text('ungrouped')),
    busy: ui.pending || ui.loading,
  }
}
