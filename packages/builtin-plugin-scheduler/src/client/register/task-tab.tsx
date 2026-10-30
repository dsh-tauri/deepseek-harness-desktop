import type { ClientContext, ILayout, SessionListState, WorkspaceSnapshot } from 'dsh-tauri/client'
import type { SidebarRight, SidebarRightTabs } from '../types/task-tab'
import { defineAdapter, defineRegister } from 'dsh-tauri/client'
import { sessionLinkState } from '../components/session-link'
import { TaskTab } from '../components/task-tab'
import { TaskTabTitle } from '../components/task-tab-title'
import { SCHEDULE_TASK_ID, SCHEDULE_TASK_KIND } from '../constants'
import { locale } from '../locales'
import { TaskTabBindings } from '../service/task-tab-bindings'
import { store } from '../store'
import { liveTaskTabIds, openTaskTab } from './task-tab.navigation'

export const taskTabFeature = defineRegister<ClientContext>((controller, ctx, adapter) => {
  let installed = false
  let pending: AbortController | undefined
  const warn = () => console.warn('[scheduler task tab] Public right-sidebar capability unavailable; task tabs disabled.')
  const fiber = ctx.inject(['sidebarRight', 'sidebarRightTabs'], (scoped) => {
    const current = defineAdapter(scoped)
    const sidebar = current.service<SidebarRight>('sidebarRight')
    const registry = current.service<SidebarRightTabs>('sidebarRightTabs')
    const slots = current.service<ClientContext['slots']>('slots')
    const layout = current.service<ILayout>('layout')
    if (!sidebar || typeof sidebar.openTab !== 'function' || typeof sidebar.mounted?.subscribe !== 'function' || typeof sidebar.mounted.getSnapshot !== 'function'
      || typeof registry?.register !== 'function' || typeof slots?.spec !== 'function' || typeof slots.inject !== 'function' || typeof slots.register !== 'function' || !layout) {
      warn()
      return
    }
    const taskBindings = new TaskTabBindings(id => liveTaskTabIds(sidebar, id))
    const openHistorySession = async (id: string): Promise<{ ok: boolean, error?: string }> => {
      const state = sessionLinkState(id, ctx.sessions.list.getSnapshot(), ctx.workspaces.list.getSnapshot())
      if (state !== 'available')
        return { ok: false, error: locale.text(`session.${state}`) }
      try {
        const result = current.openSession(id)
        if (result.status !== 'opened')
          return { ok: false, error: locale.text('openRunFailed') }
        await result.value
        store.scheduler.markSessionRead(id)
        return { ok: true }
      }
      catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
    const injected = () => ({ t: locale.text, taskBindings, openHistorySession })
    const disposers: Array<() => void> = []
    let complete = false
    let bodyReady = false
    let titleReady = false
    function updateReadiness(): void {
      installed = complete && bodyReady && titleReady
      if (!installed)
        pending?.abort()
    }
    try {
      disposers.push(registry.register({ id: SCHEDULE_TASK_ID, kind: SCHEDULE_TASK_KIND, priority: 'extension', keepMounted: true, title: () => locale.text('editDialogTitle') }))
      disposers.push(slots.inject('sidebar.right.pane.tab', () => {
        const spec = slots.spec('sidebar.right.pane.tab')
        if (spec?.kind !== 'keyed' || spec.scope !== 'session') {
          warn()
          return () => {}
        }
        const dispose = slots.register({ name: 'sidebar.right.pane.tab', key: SCHEDULE_TASK_ID, inject: injected }, TaskTab)
        bodyReady = true
        updateReadiness()
        return () => {
          bodyReady = false
          updateReadiness()
          dispose()
        }
      }))
      disposers.push(slots.inject('sidebar.right.pane.tab.title', () => {
        const spec = slots.spec('sidebar.right.pane.tab.title')
        if (spec?.kind !== 'keyed' || spec.scope !== 'session') {
          warn()
          return () => {}
        }
        const dispose = slots.register({ name: 'sidebar.right.pane.tab.title', key: SCHEDULE_TASK_ID, inject: injected }, TaskTabTitle)
        titleReady = true
        updateReadiness()
        return () => {
          titleReady = false
          updateReadiness()
          dispose()
        }
      }))
      complete = true
      updateReadiness()
    }
    catch (error) {
      complete = false
      updateReadiness()
      disposers.reverse().forEach(dispose => dispose())
      taskBindings.clear()
      console.warn('[scheduler task tab] Public right-sidebar registration failed.', error)
      return
    }
    return () => {
      complete = false
      updateReadiness()
      disposers.reverse().forEach(dispose => dispose())
      taskBindings.clear()
    }
  })
  controller.add(() => {
    pending?.abort()
    void fiber.dispose()
  })
  const navigate = () => {
    const { target, seq } = store.navigation
    if (!target)
      return
    pending?.abort()
    if (!installed) {
      warn()
      store.navigation.finish(seq, locale.text('navigation.unavailable'))
      return
    }
    const sidebar = adapter.service<SidebarRight>('sidebarRight')
    const layout = adapter.service<ILayout>('layout')
    if (!sidebar || !layout) {
      store.navigation.finish(seq, locale.text('navigation.unavailable'))
      return
    }
    pending = new AbortController()
    const request = pending
    void openTaskTab({
      controller,
      adapter,
      sidebar,
      layout,
      target,
      signal: request.signal,
      t: locale.text,
      sessions: () => ctx.sessions.list.getSnapshot() as SessionListState,
      workspaces: () => ctx.workspaces.list.getSnapshot() as WorkspaceSnapshot,
    }).then(() => {
      if (!controller.isDisposed() && !request.signal.aborted)
        store.navigation.finish(seq)
    }).catch((error: unknown) => {
      if (!controller.isDisposed() && !request.signal.aborted)
        store.navigation.finish(seq, error instanceof Error ? error.message : String(error))
    })
  }
  controller.add(store.navigation.$subscribeKey('seq', navigate))
  navigate()
})
