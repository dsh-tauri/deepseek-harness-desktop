import type {
  ContextMenuExtension,
  SessionId,
  SessionSummaryLike,
  WorkspaceId,
  WorkspaceViewLike,
} from '../types'
import type { MenuComposer } from './context-menu.types'
import { invoke } from 'dsh-tauri/client'
import { confirmDialog } from '../components/confirm-dialog'
import { locale } from '../locales'
import {
  archiveSession,
  archiveSessions,
  deleteWorkspace as deleteWorkspaceAction,
  forkSession,
  isSessionPinned,
  loadUngroupedSessions,
  loadWorkspaceSessions,
  openExternalUrl,
  openInExplorer,
  renameSession,
  startWorkspaceSession,
  supportsSessionPin,
  togglePinSession,
} from '../service/menu'
import { readClipboard } from '../utils/clipboard'
import { pasteInto, replaceSelection, selectAll, selectSurface } from '../utils/editable'
import { externalUrl, selectedUrl } from '../utils/url'
import { redoShortcutLabel, shortcutLabel } from './context-menu.utils'
import { officialAction } from './locate'
import { officialSelect } from './official-menu'

// 官方行菜单项文本会带上当前快捷键绑定（如「分叉会话⇧⌘F」），因此只做前缀匹配、不用全串锚定。
const RENAME_LABELS = [/^重命名/, /^rename\b/i]
const ARCHIVE_SESSION_LABELS = [/^归档会话/, /^archive( session)?\b/i]
const FORK_SESSION_LABELS = [/^分叉会话/, /^fork( session)?\b/i]

export function buildSessionMenu(
  composer: MenuComposer,
  row: Element,
  session: SessionSummaryLike | null,
  sessionWorkspace: { workspace: WorkspaceViewLike } | null,
  extensions: ContextMenuExtension[],
): void {
  const current = session

  // 置顶会话：官方 0.1.7 起提供置顶能力，旧核心不展示该入口。
  if (current && supportsSessionPin(composer.workspaces)) {
    const pinned = isSessionPinned({ workspaces: composer.workspaces, sessionId: current.id })
    composer.add(pinned ? locale.text('unpinSession') : locale.text('pinSession'), async () => {
      const outcome = await togglePinSession({ workspaces: composer.workspaces, sessionId: current.id, pinned })
      if (outcome.ok)
        composer.toast(locale.text(pinned ? 'sessionUnpinned' : 'sessionPinned'))
      return outcome
    })
  }

  composer.add(locale.text('renameSession'), async () => {
    if (officialAction(row))
      return officialSelect(row, RENAME_LABELS, locale.text('officialRenameUnavailable'), composer.delegate(false))
    if (!current)
      throw new Error(locale.text('sessionUnknown'))
    // eslint-disable-next-line no-alert
    const title = globalThis.prompt(locale.text('renameSession'), current.displayTitle || current.title || '')
    if (title === null || title.trim() === (current.title || current.displayTitle))
      return
    if (!title.trim())
      throw new Error(locale.text('sessionNameEmpty'))
    const outcome = await renameSession({ sessions: composer.sessions, sessionId: current.id, title: title.trim() })
    if (outcome.ok)
      composer.toast(locale.text('sessionRenamed'))
    return outcome
  })

  composer.add(locale.text('archiveSession'), async () => {
    if (officialAction(row))
      return officialSelect(row, ARCHIVE_SESSION_LABELS, locale.text('officialArchiveUnavailable'), composer.delegate(false))
    if (!current)
      throw new Error(locale.text('sessionUnknown'))
    const outcome = await archiveSession({ workspaces: composer.workspaces, sessionId: current.id })
    if (outcome.ok)
      composer.toast(locale.text('sessionArchived'))
    return outcome
  })

  const cwd = current?.cwd || sessionWorkspace?.workspace.path
  if (cwd) {
    composer.split()
    composer.add(locale.text('openInExplorer'), () => openInExplorer({ path: cwd }))
    composer.add(locale.text('copyWorkingDirectory'), () => composer.copyText(cwd, locale.text('copiedWorkingDirectory')))
  }
  if (current)
    composer.add(locale.text('copySessionId'), () => composer.copyText(current.id, locale.text('copiedSessionId')))

  composer.split()
  composer.add(locale.text('forkSession'), async () => {
    if (!current)
      throw new Error(locale.text('sessionUnknown'))
    const byService = () => forkSession({ sessions: composer.sessions, sessionId: current.id })
    if (officialAction(row)) {
      try {
        // 优先点官方行菜单里的分叉项；菜单项缺失时 onFailure 退到官方 sessions 服务，而不是只报「无法调用」。
        await officialSelect(row, FORK_SESSION_LABELS, locale.text('officialForkUnavailable'), {
          ...composer.delegate(false),
          onFailure: (message) => {
            void byService().then((outcome) => {
              if (!outcome.ok)
                composer.toast(outcome.error || message)
            })
          },
        })
        return
      }
      catch {
        // 官方行操作按钮取不到：落到下面的服务路径
      }
    }
    return byService()
  })

  const visible = current
    ? extensions.filter(entry => entry.visible?.({ session: current, row }) !== false)
    : []
  if (visible.length) {
    composer.split()
    for (const entry of visible) {
      composer.add(entry.label || entry.id, () => entry.run({
        session: current,
        row,
        sessions: composer.sessions,
        workspaces: composer.workspaces,
        close: composer.close,
      }))
    }
  }

  composer.split()
  if (current && 'dshDesktop' in globalThis) {
    composer.add(locale.text('openInNewWindow'), () => invoke<void>('create_app_window', {
      sessionId: current.id,
      iframeUrl: window.location.origin,
    }))
  }
  composer.add(locale.text('refresh'), reload, shortcutLabel('R'))
}

export function buildUngroupedMenu(composer: MenuComposer): void {
  composer.add(locale.text('archiveUngroupedSessions'), async () => {
    const sessionIds = await loadUngroupedSessions({ workspaces: composer.workspaces, sessions: composer.sessions })
    if (!sessionIds.length) {
      composer.toast(locale.text('noUngroupedSessions'))
      return
    }
    const ok = await confirmDialog({
      title: locale.text('archiveUngroupedTitle', { count: sessionIds.length }),
      description: locale.text('archiveUngroupedDescription', { count: sessionIds.length }),
      confirmLabel: locale.text('archiveWorkspaceConfirmAction'),
    })
    if (ok)
      await archiveAll(composer, sessionIds)
  })
  composer.split()
  composer.add(locale.text('refresh'), reload, shortcutLabel('R'))
}

export function buildWorkspaceMenu(
  composer: MenuComposer,
  target: { workspace: WorkspaceViewLike, row: Element, targetRow: Element },
): void {
  const workspace = target.workspace

  composer.add(locale.text('newSession'), () => startWorkspaceSession({
    workspaces: composer.workspaces,
    workspaceId: workspace.workspaceId as unknown as WorkspaceId,
  }))
  composer.add(locale.text('openInExplorer'), () => openInExplorer({ path: workspace.path }))

  composer.split()
  composer.add(locale.text('renameWorkspace'), () => officialSelect(
    target.row,
    RENAME_LABELS,
    locale.text('officialWorkspaceRenameUnavailable'),
    composer.delegate(true),
  ))
  composer.add(locale.text('copyWorkspacePath'), () => composer.copyText(workspace.path, locale.text('copiedWorkspacePath')))

  composer.split()
  composer.add(locale.text('archiveWorkspaceSessions'), async () => {
    const sessionIds = await loadWorkspaceSessions({ workspaces: composer.workspaces, workspace })
    if (!sessionIds.length) {
      composer.toast(locale.text('noWorkspaceSessions'))
      return
    }
    const ok = await confirmDialog({
      title: locale.text('archiveWorkspaceTitle', { count: sessionIds.length }),
      description: locale.text('archiveWorkspaceDescription', { workspace: workspace.title }),
      confirmLabel: locale.text('archiveWorkspaceConfirmAction'),
    })
    if (ok)
      await archiveAll(composer, sessionIds)
  })
  composer.add(locale.text('deleteWorkspace'), async () => {
    const ok = await confirmDialog({
      title: locale.text('deleteWorkspaceTitle'),
      description: locale.text('deleteWorkspaceDescription', { title: workspace.title }),
      confirmLabel: locale.text('deleteWorkspaceConfirm'),
    })
    if (!ok)
      return
    const outcome = await deleteWorkspaceAction({ workspaces: composer.workspaces, workspaceId: workspace.workspaceId })
    if (outcome.ok)
      composer.toast(locale.text('workspaceDeleted'))
    return outcome
  }, '', true)

  composer.split()
  composer.add(locale.text('refresh'), reload, shortcutLabel('R'))
}

export function buildEditableMenu(composer: MenuComposer, editable: HTMLElement, selection: string): void {
  composer.add(locale.text('undo'), () => {
    editable.focus()
    if (!document.execCommand('undo'))
      throw new Error(locale.text('useUndoShortcut', { key: shortcutLabel('Z') }))
  }, shortcutLabel('Z'))
  composer.add(locale.text('redo'), () => {
    editable.focus()
    if (!document.execCommand('redo'))
      throw new Error(locale.text('useRedoShortcut', { key: redoShortcutLabel() }))
  }, redoShortcutLabel())

  composer.split()
  composer.add(locale.text('cut'), async () => {
    if (selection)
      await composer.copyText(selection, locale.text('cutDone'))
    if (!replaceSelection(editable, ''))
      throw new Error(locale.text('editPositionUnknown'))
  }, shortcutLabel('X'))
  composer.add(locale.text('copy'), () => composer.copyText(selection, locale.text('copied')), shortcutLabel('C'))
  composer.add(locale.text('paste'), async () => {
    const clipboard = await readClipboard()
    if (clipboard === null)
      throw new Error(locale.text('clipboardReadFailed', { key: shortcutLabel('V') }))
    if (!pasteInto(editable, clipboard))
      throw new Error(locale.text('editPositionUnknown'))
  }, shortcutLabel('V'))

  composer.split()
  composer.add(locale.text('selectAll'), () => selectAll(editable), shortcutLabel('A'))

  composer.split()
  composer.add(locale.text('refresh'), reload, shortcutLabel('R'))
}

export function buildSelectionMenu(
  composer: MenuComposer,
  selection: string,
  link: HTMLAnchorElement | null,
  surface: HTMLElement | null,
): void {
  if (selection)
    composer.add(locale.text('copySelectedText'), () => composer.copyText(selection, locale.text('copied')), shortcutLabel('C'))

  const url = externalUrl(link?.href || '') || selectedUrl(selection)
  if (url) {
    if (selection)
      composer.split()
    composer.add(locale.text('openInDefaultBrowser'), () => openExternalUrl({ url }))
    composer.add(locale.text('copyLink'), () => composer.copyText(url, locale.text('linkCopied')))
  }

  const surfaceNode = surface
  if (surfaceNode) {
    if (selection || url)
      composer.split()
    composer.add(locale.text('selectCurrentContent'), () => selectSurface(surfaceNode), shortcutLabel('A'))
  }

  composer.split()
  composer.add(locale.text('refresh'), reload, shortcutLabel('R'))
}

// --- internal ---

async function archiveAll(composer: MenuComposer, sessionIds: SessionId[]): Promise<void> {
  const outcome = await archiveSessions({ workspaces: composer.workspaces, sessionIds })
  if (!outcome.ok)
    throw new Error(outcome.error || locale.text('unknownError'))
  composer.toast(locale.text('workspaceSessionsArchived', { count: sessionIds.length }))
}

function reload(): void {
  globalThis.location.reload()
}
