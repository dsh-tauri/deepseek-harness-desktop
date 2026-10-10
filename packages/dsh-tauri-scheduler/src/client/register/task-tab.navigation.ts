import type { ClientAdapter, ILayout, ISessions, LifecycleController, SessionId, SessionListState, WorkspaceSnapshot } from 'dsh-tauri/client'
import type { Translate } from '../locales/index.types'
import type { SidebarRight, TaskTabNavigation } from '../types/task-tab'
import { sessionLinkState } from '../components/session-link'
import { SCHEDULE_TASK_KIND } from '../constants'

interface NavigationRuntime {
  controller: LifecycleController
  adapter: ClientAdapter
  layout: ILayout
  sidebar: SidebarRight
  target: TaskTabNavigation
  signal: AbortSignal
  t: Translate
  sessions: () => SessionListState
  workspaces: () => WorkspaceSnapshot
}

export async function openTaskTab({ controller, adapter, layout, sidebar, target, signal, t, sessions, workspaces }: NavigationRuntime): Promise<void> {
  signal.throwIfAborted()
  if (controller.isDisposed())
    throw new Error(t('navigation.failed'))
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let started = false
    let navigated = false
    let owner: string | undefined
    const previouslyMounted = sidebar.mounted.getSnapshot()
    let cancelRetry = () => {}
    let unsubscribe = () => {}
    let unsubscribePanel = () => {}
    let cancelDeadline = () => {}
    let unhookDisposal = () => {}
    const finish = (error?: unknown) => {
      if (settled)
        return
      settled = true
      cancelRetry()
      cancelDeadline()
      unsubscribe()
      unsubscribePanel()
      unhookDisposal()
      signal.removeEventListener('abort', abort)
      error === undefined ? resolve() : reject(error)
    }
    const fail = (error: unknown) => finish(error ?? new Error(t('navigation.failed')))
    function abort(): void {
      fail(signal.reason)
    }
    const retry = () => {
      cancelRetry()
      cancelRetry = controller.timeout(attempt, 25)
    }
    function attempt(): void {
      if (settled)
        return
      if (signal.aborted || controller.isDisposed()) {
        abort()
        return
      }
      if (!started) {
        const list = sessions()
        const workspace = workspaces()
        if (list.phase === 'pending' || workspace.phase === 'pending') {
          retry()
          return
        }
        if (workspace.state === 'error' || workspace.error) {
          finish(new Error(t('navigation.unavailable')))
          return
        }
        const linked = target.sessionId && sessionLinkState(target.sessionId, list, workspace) === 'available' ? target.sessionId : undefined
        const current = adapter.sessionList()?.current
        owner = linked ?? (current && sessionLinkState(current, list, workspace) === 'available' ? current : undefined)
          ?? list.ids.find(id => sessionLinkState(id, list, workspace) === 'available')
        started = true
        try {
          layout.selectPanel(null)
          let opening: unknown
          if (owner) {
            const result = adapter.openSession(owner)
            if (result.status !== 'opened') {
              finish(new Error(t('navigation.unavailable')))
              return
            }
            opening = result.value
          }
          else {
            const sessions = adapter.service<Partial<ISessions>>('sessions')
            if (typeof sessions?.create === 'function') {
              if (!adapter.resolveOpenSession()) {
                finish(new Error(t('navigation.unavailable')))
                return
              }
              opening = sessions.create().then((id) => {
                if (settled || signal.aborted || controller.isDisposed())
                  return
                owner = id
                const result = adapter.openSession(id)
                if (result.status !== 'opened')
                  throw new Error(t('navigation.unavailable'))
                return result.value
              })
            }
            else {
              const start = adapter.resolveStartSession()
              if (!start) {
                finish(new Error(t('navigation.unavailable')))
                return
              }
              opening = start()
            }
          }
          void Promise.resolve(opening).then(() => {
            if (settled)
              return
            navigated = true
            attempt()
          }, fail)
        }
        catch (error) {
          fail(error)
        }
        return
      }
      if (!navigated)
        return
      const mounted = sidebar.mounted.getSnapshot()
      if (!mounted || (owner && mounted !== owner)) {
        if (mounted && mounted !== previouslyMounted)
          finish(new Error(t('navigation.failed')))
        return
      }
      if (sessionLinkState(mounted, sessions(), workspaces()) !== 'available') {
        retry()
        return
      }
      try {
        sidebar.openTab(SCHEDULE_TASK_KIND, { params: target })
        finish()
      }
      catch (error) {
        if (error instanceof Error && error.message === 'sidebarRight: no session surface is mounted')
          retry()
        else
          fail(error)
      }
    }
    try {
      signal.addEventListener('abort', abort, { once: true })
      unhookDisposal = controller.add(() => fail(undefined))
      cancelDeadline = controller.timeout(() => fail(undefined), 5_000)
      unsubscribe = sidebar.mounted.subscribe(attempt)
      unsubscribePanel = layout.panelInfo.subscribe(() => {
        if (layout.panelInfo.getSnapshot().activePanelId !== null)
          fail(undefined)
      })
      if (settled) {
        unsubscribe()
        unsubscribePanel()
      }
      else {
        attempt()
      }
    }
    catch (error) {
      fail(error)
    }
  })
}

export function liveTaskTabIds(sidebar: SidebarRight | undefined, sessionId: string): readonly string[] | undefined {
  return sidebar?.tabsIn?.(sessionId as SessionId).map(tab => tab.id)
}
