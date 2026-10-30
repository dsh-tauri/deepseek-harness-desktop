import type { SessionsRuntimeLike, WorkspacesRuntimeLike, WorkspaceViewLike } from '../types/runtime'
import {
  ARCHIVE_MENU_ITEM_ATTRIBUTE,
  DELETE_WORKSPACE_LABELS,
  MENU_ITEM_ICON_SELECTOR,
  MENU_ITEM_LABEL_SELECTOR,
  MENU_ITEM_WRAP_SELECTOR,
} from '../constants'
import { ARCHIVE_MENU_ICON_SVG } from '../constants/archive-icon'

export function workspaceFromRow(row: Element, workspaces: WorkspacesRuntimeLike): WorkspaceViewLike | null {
  const matches = workspaces.list.getSnapshot().items.filter((workspace) => {
    const title = workspace.title?.trim()
    if (!title)
      return false
    if ([row.getAttribute('aria-label'), row.getAttribute('title')].some(value => value?.trim() === title))
      return true
    return [...row.querySelectorAll('span,button,div')].some(node =>
      node.closest('[role="treeitem"]') === row
      && node.children.length === 0
      && node.textContent?.trim() === title)
  })
  return matches.length === 1 ? matches[0] : null
}

export function collectWorkspaceSessionIds(
  workspace: WorkspaceViewLike,
  workspaces: WorkspacesRuntimeLike,
  sessions: SessionsRuntimeLike,
): string[] {
  const archived = new Set(workspaces.list.getSnapshot().archivedSessionIds ?? [])
  const byId = sessions.list.getSnapshot().byId
  return workspace.sessionIds.filter((id) => {
    if (archived.has(id))
      return false
    const session = byId[id]
    return session !== undefined && session.blank !== true && session.origin !== 'subagent'
  })
}

export function isDeleteWorkspaceMenuItem(item: HTMLElement): boolean {
  if (!item.closest(MENU_ITEM_WRAP_SELECTOR))
    return false
  const label = item.textContent?.trim() ?? ''
  return label.length > 0 && DELETE_WORKSPACE_LABELS.some(needle => label.includes(needle))
}

export function decorateArchiveMenuItem(item: HTMLButtonElement, label: string): boolean {
  const labelNode = item.querySelector<HTMLElement>(MENU_ITEM_LABEL_SELECTOR)
  if (!labelNode)
    return false
  labelNode.textContent = label
  item.setAttribute(ARCHIVE_MENU_ITEM_ATTRIBUTE, '1')
  const icon = item.querySelector<HTMLElement>(MENU_ITEM_ICON_SELECTOR)
  if (icon)
    icon.innerHTML = ARCHIVE_MENU_ICON_SVG
  return true
}
