import type { ClientContext, PanelHandle } from 'dsh-tauri/client'
import { definePanel, defineRegister } from 'dsh-tauri/client'
import { SchedulerNavIcon } from '../components/scheduler-nav-icon'
import { SchedulerPanel } from '../components/scheduler-panel'
import { sessionLinkState } from '../components/session-link'
import { PANEL_ACTION_ORDER, PANEL_ID, REFRESH_INTERVAL_MS } from '../constants'
import { locale } from '../locales'
import { loadScheduler } from '../service/scheduler'
import { store } from '../store'

export const panelFeature = defineRegister<ClientContext>((controller, ctx, adapter) => {
  const holder: { current?: PanelHandle } = {}
  void loadScheduler(true)
  controller.interval(() => void loadScheduler(false), REFRESH_INTERVAL_MS)
  controller.listen('visibilitychange', () => {
    if (document.visibilityState === 'visible')
      void loadScheduler(false)
  })
  controller.listenWindow('focus', () => void loadScheduler(false))
  const sessionList = adapter.sessionList()
  if (sessionList) {
    controller.add(sessionList.subscribe(() => {
      const current = adapter.sessionList()?.current
      if (current)
        store.scheduler.markSessionRead(current)
    }))
  }
  holder.current = definePanel(ctx, {
    id: PANEL_ID,
    order: PANEL_ACTION_ORDER,
    locale: locale.NS,
    label: () => locale.text('scheduler'),
    icon: props => <SchedulerNavIcon size={props.size} />,
    render: () => (
      <SchedulerPanel
        t={locale.text}
        sessionsRuntime={ctx.sessions}
        workspacesRuntime={ctx.workspaces}
        openHistorySession={async (id) => {
          const state = sessionLinkState(id, ctx.sessions.list.getSnapshot(), ctx.workspaces.list.getSnapshot())
          if (state !== 'available')
            return { ok: false, error: locale.text(`session.${state}`) }
          try {
            const result = adapter.openSession(id)
            if (result.status !== 'opened')
              return { ok: false, error: locale.text('openRunFailed') }
            await result.value
            holder.current?.close()
            return { ok: true }
          }
          catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) }
          }
        }}
        onViaChat={() => {
          store.prefill.set(locale.text('chatPrompt'))
          holder.current?.close()
        }}
      />
    ),
  })
  controller.add(holder.current.dispose)
})
