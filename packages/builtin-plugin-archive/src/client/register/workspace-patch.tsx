import type { ClientContext } from 'dsh-tauri/client'
import type { Root } from 'react-dom/client'
import type { SessionsRuntimeLike, WorkspacesRuntimeLike, WorkspaceViewLike } from '../types/runtime'
import type { WorkspaceArchiveTarget } from './workspace-patch.types'
import { defineRegister } from 'dsh-tauri/client'
import { createRoot } from 'react-dom/client'
import { ArchiveWorkspaceDialog } from '../components/archive-workspace-dialog'
import {
  ARCHIVE_MENU_ITEM_ATTRIBUTE,
  ARCHIVE_MENU_PATCH_ATTRIBUTE,
  MENU_ITEM_SELECTOR,
  SIDEBAR_SELECTOR,
  TIMELINE_ROW_SELECTOR,
} from '../constants'
import { locale } from '../locales'
import { archiveSession, archiveWorkspace } from '../service/archive'
import {
  collectWorkspaceSessionIds,
  decorateArchiveMenuItem,
  isDeleteWorkspaceMenuItem,
  workspaceFromRow,
} from './workspace-patch.utils'

export const workspacePatchFeature = defineRegister<ClientContext>((controller, _ctx, adapter) => {
  if (typeof document === 'undefined')
    return

  const workspacesRuntime = adapter.workspaces as unknown as WorkspacesRuntimeLike
  const sessionsRuntime = adapter.sessions as unknown as SessionsRuntimeLike
  const targets = new Map<HTMLElement, WorkspaceArchiveTarget>()
  let pendingWorkspace: WorkspaceViewLike | undefined
  let dialogRoot: Root | undefined
  let dialogHost: HTMLDivElement | undefined

  function closeDialog(): void {
    dialogRoot?.unmount()
    dialogRoot = undefined
    dialogHost?.remove()
    dialogHost = undefined
  }

  function openDialog(target: WorkspaceArchiveTarget): void {
    closeDialog()
    dialogHost = document.createElement('div')
    document.body.append(dialogHost)
    dialogRoot = createRoot(dialogHost)
    let settled = false
    const close = (): void => {
      if (settled)
        return
      settled = true
      closeDialog()
    }
    dialogRoot.render(
      <ArchiveWorkspaceDialog
        sessionIds={target.sessionIds}
        workspaceTitle={target.workspace?.title ?? target.workspace?.path.split(/[\\/]/).pop() ?? locale.text('ungrouped')}
        onClose={close}
        onConfirm={() => {
          close()
          void archiveGroup(target)
        }}
      />,
    )
  }

  function archiveGroup(target: WorkspaceArchiveTarget): Promise<unknown> {
    if (target.workspace)
      return archiveWorkspace({ workspaceId: target.workspace.workspaceId, sessionIds: target.sessionIds })
    return Promise.all(target.sessionIds.map(sessionId => archiveSession({ sessionId })))
  }

  function patchMenu(item: HTMLButtonElement): void {
    const menu = item.closest<HTMLElement>('[role="menu"]')
    if (!menu || menu.hasAttribute(ARCHIVE_MENU_PATCH_ATTRIBUTE))
      return
    menu.setAttribute(ARCHIVE_MENU_PATCH_ATTRIBUTE, '1')

    const workspace = pendingWorkspace
    const sessionIds = workspace ? collectWorkspaceSessionIds(workspace, workspacesRuntime, sessionsRuntime) : []
    if (sessionIds.length === 0)
      return

    const archiveItem = item.cloneNode(true) as HTMLButtonElement
    if (!decorateArchiveMenuItem(archiveItem, locale.text('archiveWorkspaceMenu')))
      return
    targets.set(archiveItem, { workspace, sessionIds })
    item.before(archiveItem)
  }

  function scan(): void {
    for (const element of targets.keys()) {
      if (!element.isConnected)
        targets.delete(element)
    }
    for (const item of document.querySelectorAll<HTMLButtonElement>(MENU_ITEM_SELECTOR)) {
      if (isDeleteWorkspaceMenuItem(item))
        patchMenu(item)
    }
  }

  controller.add(closeDialog)
  controller.observe(document.body, scan, { childList: true, subtree: true })

  controller.listen('click', (event) => {
    const origin = event.target
    if (!(origin instanceof Element))
      return
    const archiveItem = origin.closest<HTMLElement>(`[${ARCHIVE_MENU_ITEM_ATTRIBUTE}]`)
    if (archiveItem) {
      const target = targets.get(archiveItem)
      if (!target)
        return
      event.preventDefault()
      event.stopImmediatePropagation()
      openDialog(target)
      const PointerEventCtor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent
      document.dispatchEvent(new PointerEventCtor('pointerdown', { bubbles: true, cancelable: true }))
      return
    }
    const row = origin.closest('button')?.closest(TIMELINE_ROW_SELECTOR)
    pendingWorkspace = row ? workspaceFromRow(row, workspacesRuntime) ?? undefined : undefined
  }, { capture: true })

  if (document.querySelector(SIDEBAR_SELECTOR))
    scan()
})
