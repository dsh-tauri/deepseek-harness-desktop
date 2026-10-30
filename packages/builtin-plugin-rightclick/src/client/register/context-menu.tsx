import type { MenuEntry } from 'dsh-tauri-ui/client'
import type { ClientContext } from 'dsh-tauri/client'
import type { ReactNode } from 'react'
import type { ActionOutcome, SessionsRuntimeLike, WorkspacesRuntimeLike } from '../types'
import type { MenuComposer, OfficialSelectOptions } from './context-menu.types'
import { Menu, Toast } from 'dsh-tauri-ui/client'
import { defineRegister, detectMobileDevice } from 'dsh-tauri/client'
import { createRoot } from 'react-dom/client'
import { CONTEXT_MENU_EVENT, LINK_SELECTOR, TOAST_DURATION_MS } from '../constants'
import { locale } from '../locales'
import { loadRegistry } from '../service/registry'
import { writeClipboard } from '../utils/clipboard'
import { selectionSurface } from '../utils/editable'
import {
  buildEditableMenu,
  buildSelectionMenu,
  buildSessionMenu,
  buildUngroupedMenu,
  buildWorkspaceMenu,
} from './context-menu.menu'
import {
  editableFrom,
  officialAction,
  resolveSession,
  rowFrom,
  selectedText,
  ungroupedRowFrom,
  workspaceForSession,
  workspaceFrom,
} from './locate'

/** 带快捷键提示的官方菜单项文案：官方 `Menu` 只吃 ReactNode，提示与标签同行两端对齐。 */
function menuLabel(label: string, shortcut: string): ReactNode {
  if (shortcut === '')
    return label
  return (
    <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, width: '100%' }}>
      <span>{label}</span>
      <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 }}>{shortcut}</span>
    </span>
  )
}

/**
 * 右键菜单特性：解析右键目标 → 组装菜单 → 动作经 `service/` 收口。
 * 弹层（菜单与 toast）一律走官方 primitives，插件只补充宿主能力与扩展项。
 */
export const contextMenuFeature = defineRegister<ClientContext>((controller, _ctx, adapter) => {
  const sessions = adapter.sessions as unknown as SessionsRuntimeLike
  const workspaces = adapter.workspaces as unknown as WorkspacesRuntimeLike
  const registry = loadRegistry()

  let host: HTMLDivElement | null = null
  let root: ReturnType<typeof createRoot> | null = null
  let toastHost: HTMLDivElement | null = null
  let toastRoot: ReturnType<typeof createRoot> | null = null
  let toastSeq = 0
  let cursor = { x: 0, y: 0 }

  const close = (): void => {
    if (root === null)
      return
    const current = root
    const currentHost = host
    root = null
    host = null
    current.unmount()
    currentHost?.remove()
  }

  const toast = (message: string): void => {
    if (typeof document === 'undefined')
      return
    if (toastRoot === null) {
      toastHost = document.createElement('div')
      document.body.appendChild(toastHost)
      toastRoot = createRoot(toastHost)
    }
    const seq = ++toastSeq
    toastRoot.render(
      <Toast
        key={seq}
        text={message}
        holdMs={TOAST_DURATION_MS}
        onDone={() => {
          if (seq === toastSeq)
            toastRoot?.render(null)
        }}
      />,
    )
  }

  const copyText = async (value: string, message: string): Promise<void> => {
    if (!await writeClipboard(value))
      throw new Error(locale.text('clipboardUnavailable'))
    toast(message)
  }

  const createComposer = (): { composer: MenuComposer, actions: Map<string, () => Promise<ActionOutcome | void> | void>, entries: MenuEntry[] } => {
    const actions = new Map<string, () => Promise<ActionOutcome | void> | void>()
    const entries: MenuEntry[] = []
    let seq = 0

    const add = (
      label: string,
      action: () => Promise<ActionOutcome | void> | void,
      shortcut = '',
      danger = false,
    ): void => {
      const id = `item:${seq++}`
      actions.set(id, action)
      entries.push({ id, label: menuLabel(label, shortcut), danger })
    }

    const split = (): void => {
      const last = entries.at(-1)
      if (last === undefined || ('type' in last && last.type === 'separator'))
        return
      entries.push({ type: 'separator', id: `separator:${seq++}` })
    }

    const composer: MenuComposer = {
      sessions,
      workspaces,
      add,
      split,
      toast,
      copyText,
      close,
      delegate: (workspace: boolean): OfficialSelectOptions => ({
        workspace,
        schedule: (fn, ms) => controller.timeout(fn, ms),
        onFailure: toast,
      }),
    }
    return { composer, actions, entries }
  }

  const runAction = async (actions: Map<string, () => Promise<ActionOutcome | void> | void>, id: string): Promise<void> => {
    const action = actions.get(id)
    close()
    if (action === undefined)
      return
    try {
      const outcome = await action()
      if (outcome && !outcome.ok)
        toast(outcome.error || locale.text('unknownError'))
    }
    catch (error) {
      toast(error instanceof Error ? error.message : String(error))
    }
  }

  const onContextMenu = (event: MouseEvent): void => {
    if (event.defaultPrevented)
      return
    const row = rowFrom(event.target)
    const ungroupedRow = !row ? ungroupedRowFrom(event.target) : null
    const domSessionWorkspace = row ? workspaceFrom(event.target, workspaces) : null
    const session = row ? resolveSession(sessions, row, domSessionWorkspace?.workspace ?? null) : null
    // 可见的空白「新会话」只是临时输入目标，不弹菜单。
    if (session?.blank === true)
      return
    const resolvedWorkspace = domSessionWorkspace?.workspace || workspaceForSession(workspaces, session)
    const sessionWorkspace = resolvedWorkspace ? { workspace: resolvedWorkspace } : null
    const workspaceTarget = !row && !ungroupedRow ? workspaceFrom(event.target, workspaces) : null
    const editable = editableFrom(event.target)
    if (editable && detectMobileDevice()) {
      close()
      return
    }
    const selection = selectedText(editable).trim()
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>(LINK_SELECTOR) : null
    const surface = selectionSurface(event.target)
    if (!row && !ungroupedRow && !workspaceTarget && !editable && !selection && !link && !surface)
      return

    event.preventDefault()
    event.stopPropagation()
    close()

    const extensions = registry.list()
    globalThis.dispatchEvent(new CustomEvent(CONTEXT_MENU_EVENT, {
      detail: {
        row: row || ungroupedRow || workspaceTarget?.targetRow || null,
        action: row ? officialAction(row) : null,
        session,
        workspace: workspaceTarget?.workspace || null,
        target: event.target,
        x: event.clientX,
        y: event.clientY,
        extensions,
      },
    }))

    const { composer, actions, entries } = createComposer()
    if (row)
      buildSessionMenu(composer, row, session, sessionWorkspace, extensions)
    else if (ungroupedRow)
      buildUngroupedMenu(composer)
    else if (workspaceTarget)
      buildWorkspaceMenu(composer, workspaceTarget)
    else if (editable)
      buildEditableMenu(composer, editable, selection)
    else
      buildSelectionMenu(composer, selection, link, surface)
    if (entries.length === 0)
      return

    cursor = { x: event.clientX, y: event.clientY }
    host = document.createElement('div')
    document.body.appendChild(host)
    const current = createRoot(host)
    root = current
    current.render(
      <Menu
        open
        autoFocus
        portal
        align="start"
        items={entries}
        anchor={<span />}
        getAnchorRect={() => new DOMRect(cursor.x, cursor.y, 0, 0)}
        onSelect={id => void runAction(actions, id)}
        onClose={close}
      />,
    )
  }

  controller.add(registry.hold())
  controller.add(close)
  controller.add(() => {
    toastRoot?.unmount()
    toastHost?.remove()
    toastRoot = null
    toastHost = null
  })
  controller.listen('contextmenu', onContextMenu, { capture: true })
})
