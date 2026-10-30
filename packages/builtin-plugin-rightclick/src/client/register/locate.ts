import type {
  SessionsRuntimeLike,
  SessionSummaryLike,
  WorkspacesRuntimeLike,
  WorkspaceViewLike,
} from '../types'
import { compact, filter, find, includes, map } from 'dsh-tauri/client'
import {
  ACTION_BUTTON_SELECTOR,
  EDITABLE_SELECTOR,
  TREE_ITEM_EXPANDED_SELECTOR,
  TREE_ITEM_SELECTOR,
} from '../constants'

const UNGROUPED_LABEL = /^(?:未分组|Ungrouped)$/i
const NEW_SESSION_TITLE = /^(?:新会话|new session)$/i

/** 会话行「操作」按钮判定（zh/en 双语文案）。 */
export function isAction(button: Element): boolean {
  const label = (button.getAttribute('aria-label') || '').toLocaleLowerCase()
  return (label.includes('会话') && label.includes('操作')) || (label.includes('session') && label.includes('action'))
}

/** 工作区行「操作」按钮判定（zh/en 双语文案）。 */
export function isWorkspaceAction(button: Element): boolean {
  const label = (button.getAttribute('aria-label') || '').toLocaleLowerCase()
  return (label.includes('工作区') && label.includes('操作')) || (label.includes('workspace') && label.includes('action'))
}

/** 从目标元素向上找会话行（[role=treeitem]，带 aria-selected 或含操作按钮）。 */
export function rowFrom(target: unknown): Element | null {
  const row = target instanceof Element ? target.closest(TREE_ITEM_SELECTOR) : null
  if (!row)
    return null
  if (row.hasAttribute('aria-selected'))
    return row
  return find(row.querySelectorAll(ACTION_BUTTON_SELECTOR), isAction) ? row : null
}

/** 官方「未分组」分组头没有操作按钮，靠 aria-expanded 与文案识别。 */
export function ungroupedRowFrom(target: unknown): Element | null {
  const row = target instanceof Element ? target.closest(TREE_ITEM_EXPANDED_SELECTOR) : null
  if (!row)
    return null
  const texts = map(
    filter(row.querySelectorAll('span'), node => node.children.length === 0),
    node => node.textContent?.trim() || '',
  )
  const label = find(
    [row.getAttribute('aria-label'), row.getAttribute('title'), ...texts],
    value => typeof value === 'string' && UNGROUPED_LABEL.test(value),
  )
  if (label === undefined || find(row.querySelectorAll(ACTION_BUTTON_SELECTOR), isWorkspaceAction))
    return null
  return row
}

/** 行是否命中某个工作区（按 aria-label/title/纯文本三路匹配，要求唯一命中）。 */
function treeItemWorkspace(row: Element, items: readonly WorkspaceViewLike[]): WorkspaceViewLike | null {
  if (!row)
    return null
  const matches = filter(items, (workspace) => {
    if ([row.getAttribute('aria-label'), row.getAttribute('title')].some(value => value?.trim() === workspace.title))
      return true
    return find(row.querySelectorAll('span,button,div'), node =>
      node.closest(TREE_ITEM_SELECTOR) === row
      && node.children.length === 0
      && node.textContent?.trim() === workspace.title) !== undefined
  })
  return matches.length === 1 ? matches[0] : null
}

/** 从目标向上解析所属工作区（先沿祖先链，再回扫同级更上层行）。 */
export function workspaceFrom(target: unknown, workspaces: WorkspacesRuntimeLike): {
  workspace: WorkspaceViewLike
  row: Element
  targetRow: Element
} | null {
  const targetRow = target instanceof Element ? target.closest(TREE_ITEM_SELECTOR) : null
  if (!targetRow)
    return null
  const items = workspaces.list.getSnapshot().items
  for (let row: Element | null = targetRow; row; row = row.parentElement?.closest(TREE_ITEM_SELECTOR) ?? null) {
    const workspace = treeItemWorkspace(row, items)
    if (workspace)
      return { workspace, row, targetRow }
  }

  const rows = [...document.querySelectorAll(TREE_ITEM_SELECTOR)]
  const level = Number(targetRow.getAttribute('aria-level'))
  for (let index = rows.indexOf(targetRow) - 1; index >= 0; index -= 1) {
    const candidate = rows[index]
    const candidateLevel = Number(candidate.getAttribute('aria-level'))
    if (Number.isFinite(level) && Number.isFinite(candidateLevel) && candidateLevel >= level)
      continue
    if (rowFrom(candidate))
      continue
    const workspace = treeItemWorkspace(candidate, items)
    if (workspace)
      return { workspace, row: candidate, targetRow }
    if (Number.isFinite(level) && Number.isFinite(candidateLevel) && candidateLevel < level)
      break
  }
  return null
}

/** 行内的官方会话操作按钮（行内没有时按标题匹配全局操作按钮）。 */
export function officialAction(row: Element): HTMLButtonElement | null {
  const direct = find(row.querySelectorAll<HTMLButtonElement>(ACTION_BUTTON_SELECTOR), isAction)
  if (direct)
    return direct
  const title = find(
    row.querySelectorAll('span'),
    (node: HTMLSpanElement) => node.children.length === 0 && Boolean(node.textContent?.trim()),
  )?.textContent?.trim()
  return find(document.querySelectorAll<HTMLButtonElement>(ACTION_BUTTON_SELECTOR), button =>
    isAction(button) && (!title || includes(button.getAttribute('aria-label') || '', title))) ?? null
}

/** 会话行标题：优先从操作按钮 aria-label 提取引号内标题，回退首个文本子节点。 */
export function titleFrom(row: Element): string {
  const label = find(row.querySelectorAll(ACTION_BUTTON_SELECTOR), isAction)?.getAttribute('aria-label') || ''
  return label.match(/[“"](.+?)[”"]/)?.[1] || row.firstElementChild?.textContent?.trim() || ''
}

/** 解析行对应的会话对象（唯一匹配才返回；同名歧义时返回 null 保留默认菜单）。 */
export function resolveSession(
  sessions: SessionsRuntimeLike,
  row: Element,
  workspace: WorkspaceViewLike | null,
): SessionSummaryLike | null {
  const state = sessions.list.getSnapshot()
  const current = state.current
  if (row.getAttribute('aria-selected') === 'true' && current)
    return state.byId[current] || null
  const title = titleFrom(row)
  if (!title)
    return null
  const ids = workspace?.sessionIds || state.ids
  const matches = filter(compact(ids.map(id => state.byId[id])), item =>
    item.title === title
    || item.displayTitle === title
    || (item.blank === true && NEW_SESSION_TITLE.test(title)))
  return matches.length === 1 ? matches[0] : null
}

/** 会话所属工作区（按 sessionIds 归属反查）。 */
export function workspaceForSession(workspaces: WorkspacesRuntimeLike, session: SessionSummaryLike | null): WorkspaceViewLike | null {
  if (!session)
    return null
  return find(workspaces.list.getSnapshot().items, workspace => includes(workspace.sessionIds, session.id)) || null
}

/** 从目标向上找可编辑元素（input/textarea/contenteditable）。 */
export function editableFrom(target: unknown): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(EDITABLE_SELECTOR) : null
}

/** 当前选中文本（可编辑元素内取选区值；外层取全局选区，且须在可编辑元素内）。 */
export function selectedText(editable: HTMLElement | null): string {
  if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement)
    return editable.value.slice(editable.selectionStart ?? 0, editable.selectionEnd ?? 0)
  const selection = globalThis.getSelection()
  if (!selection)
    return ''
  if (editable && (!editable.contains(selection.anchorNode) || !editable.contains(selection.focusNode)))
    return ''
  return selection.toString()
}
