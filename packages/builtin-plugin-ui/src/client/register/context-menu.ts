import type { ContextMenuTargetMap } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { ClientContext, IWorkspaces, SessionId, WorkspaceId } from 'dsh-tauri/client'
import { invoke } from 'dsh-tauri/client'
import { PLUGIN_ID } from '../../shared/constants'
import { postPathOpen } from '../apis'
import { locale } from '../locales'
import { MENU_ICON_ARCHIVE, MENU_ICON_COPY, MENU_ICON_OPEN_IN_NEW_WINDOW, MENU_ICON_SHOW_IN_FOLDER } from './context-menu.icons'

const MENU_ORDER = 700

const MENU_ORDER_STEP = 10

const DESKTOP_GLOBAL = 'dshDesktop'

function copyText(text: string): void {
  void navigator.clipboard.writeText(text)
}

function isFormalSession(ctx: ClientContext, sessionId: SessionId): boolean {
  const summary = ctx.sessions.list.getSnapshot().byId[sessionId]
  return summary !== undefined && summary.blank !== true && summary.origin !== 'subagent'
}

function unarchivedSessionIds(workspaces: IWorkspaces, workspaceId: WorkspaceId): SessionId[] {
  const snapshot = workspaces.list.getSnapshot()
  const workspace = snapshot.items.find(item => item.workspaceId === workspaceId)
  const archived = new Set<string>(snapshot.archivedSessionIds)
  return (workspace?.sessionIds ?? []).filter(id => !archived.has(id))
}

function cwdOf(ctx: ClientContext, sessionId: SessionId): string | undefined {
  const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
  return typeof cwd === 'string' && cwd ? cwd : undefined
}

async function openDirectory(path: string): Promise<void> {
  const result = await postPathOpen({ path })
  if (!result?.ok)
    throw new Error(result?.error || locale.text('menuOpenFailed'))
}

export function registerContextMenu(ctx: ClientContext): () => void {
  const menus = ctx.get('contextMenus')
  if (!menus || typeof menus.register !== 'function') {
    console.warn(`[${PLUGIN_ID}] 右键菜单不可用：缺少 contextMenus 服务`)
    return () => {}
  }
  const workspaces = ctx.workspaces
  const disposers: (() => void)[] = []
  const contribute = <K extends keyof ContextMenuTargetMap>(contribution: Parameters<typeof menus.register<K>>[0]): void => {
    try {
      disposers.push(menus.register(contribution))
    }
    catch (error) {
      console.warn(`[${PLUGIN_ID}] 右键菜单项 '${contribution.id}' 注册失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  contribute({
    id: 'open-in-new-window',
    target: 'session',
    order: MENU_ORDER,
    observe: () => [ctx.sessions.list],
    resolve: ({ sessionId }) => DESKTOP_GLOBAL in globalThis
      ? [{
          id: 'open-in-new-window',
          label: locale.text('menuOpenInNewWindow'),
          icon: { key: MENU_ICON_OPEN_IN_NEW_WINDOW },
          failureLabel: locale.text('menuOpenFailed'),
          run: () => invoke('create_app_window', { sessionId }),
        }]
      : [],
  })

  contribute({
    id: 'show-session-in-folder',
    target: 'session',
    order: MENU_ORDER + MENU_ORDER_STEP,
    observe: () => [ctx.sessions.list],
    resolve: ({ sessionId }) => {
      const cwd = cwdOf(ctx, sessionId)
      return cwd === undefined
        ? []
        : [{
            id: 'show-session-in-folder',
            label: locale.text('menuShowInFolder'),
            icon: { key: MENU_ICON_SHOW_IN_FOLDER },
            failureLabel: locale.text('menuOpenFailed'),
            run: () => openDirectory(cwd),
          }]
    },
  })

  contribute({
    id: 'copy-session-working-directory',
    target: 'session',
    order: MENU_ORDER + MENU_ORDER_STEP * 2,
    observe: () => [ctx.sessions.list],
    resolve: ({ sessionId }) => {
      const cwd = cwdOf(ctx, sessionId)
      return cwd === undefined
        ? []
        : [{
            id: 'copy-session-working-directory',
            label: locale.text('menuCopyWorkingDirectory'),
            icon: { key: MENU_ICON_COPY },
            failureLabel: locale.text('menuCopyFailed'),
            run: () => copyText(cwd),
          }]
    },
  })

  contribute({
    id: 'archive-workspace',
    target: 'workspace',
    order: MENU_ORDER,
    observe: () => [ctx.workspaces.list, ctx.sessions.list],
    resolve: ({ workspaceId }) => {
      const sessionIds = unarchivedSessionIds(workspaces, workspaceId).filter(id => isFormalSession(ctx, id))
      return sessionIds.length === 0
        ? []
        : [{
            id: 'archive-workspace',
            label: locale.text('menuArchiveWorkspace'),
            icon: { key: MENU_ICON_ARCHIVE },
            failureLabel: locale.text('menuArchiveWorkspaceFailed'),
            run: async () => {
              for (const sessionId of sessionIds)
                await workspaces.archiveSession(sessionId)
              menus.notify(locale.text('menuArchivedCount', { count: sessionIds.length }), true)
            },
          }]
    },
  })

  contribute({
    id: 'show-workspace-in-folder',
    target: 'workspace',
    order: MENU_ORDER + MENU_ORDER_STEP,
    resolve: ({ path }) => [{
      id: 'show-workspace-in-folder',
      label: locale.text('menuShowInFolder'),
      icon: { key: MENU_ICON_SHOW_IN_FOLDER },
      failureLabel: locale.text('menuOpenFailed'),
      run: () => openDirectory(path),
    }],
  })

  contribute({
    id: 'copy-workspace-path',
    target: 'workspace',
    order: MENU_ORDER + MENU_ORDER_STEP * 2,
    resolve: ({ path }) => [{
      id: 'copy-workspace-path',
      label: locale.text('menuCopyWorkspacePath'),
      icon: { key: MENU_ICON_COPY },
      failureLabel: locale.text('menuCopyFailed'),
      run: () => copyText(path),
    }],
  })

  return () => {
    for (const dispose of disposers) dispose()
  }
}
