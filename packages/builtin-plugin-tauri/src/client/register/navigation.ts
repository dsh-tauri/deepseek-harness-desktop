import type { ClientContext } from '../types'
import type { ClientAdapter, RegisterController } from './index'
import { reportPluginError } from '../utils/error'
import { defineRegister } from './index'
import { closeWhenArchived, isolateSidebarLayout, PRESENTATION_FULL_SIDEBAR, presentFullSidebar } from './sidebar-fullwindow'

const CMD_NEW_SESSION = 'dsh://session:new'

const CMD_ADD_WORKSPACE = 'dsh://workspace:add'

const NAVIGATION_GLOBAL = '__DSH_NAVIGATION__'

const NAVIGATION_CONSUMED_KEY = '__DSH_NAVIGATION_CONSUMED__'

const NAVIGATION_POLL_MS = 500
const NAVIGATION_TIMEOUT_MS = 30_000

interface InjectedNavigation {
  sessionId?: unknown
  presentation?: unknown
}

function injectedSessionConsumed(sessionId: string): boolean {
  try {
    return window.sessionStorage.getItem(NAVIGATION_CONSUMED_KEY) === sessionId
  }
  catch {
    return false
  }
}

function markInjectedSessionConsumed(sessionId: string): void {
  try {
    window.sessionStorage.setItem(NAVIGATION_CONSUMED_KEY, sessionId)
  }
  catch {
  }
}

function takeInjectedNavigation(): { sessionId?: string, presentation?: string, consumed: boolean } {
  const host = window as unknown as Record<string, unknown>
  const payload = host[NAVIGATION_GLOBAL] as InjectedNavigation | undefined
  if (payload === undefined)
    return { consumed: false }
  delete host[NAVIGATION_GLOBAL]
  if (typeof payload !== 'object' || payload === null)
    return { consumed: false }
  const presentation = payload.presentation === PRESENTATION_FULL_SIDEBAR ? PRESENTATION_FULL_SIDEBAR : undefined
  const sessionId = payload.sessionId
  if (typeof sessionId !== 'string' || sessionId.trim() === '')
    return { presentation, consumed: false }
  return { sessionId, presentation, consumed: injectedSessionConsumed(sessionId) }
}

function consumeInjectedSession(controller: RegisterController, adapter: ClientAdapter, sessionId: string): void {
  let settled = false
  let cancelPoll = () => {}
  let cancelTimeout = () => {}

  function settle(error?: unknown): void {
    if (settled)
      return
    settled = true
    cancelPoll()
    cancelTimeout()
    if (error !== undefined)
      reportPluginError(error)
  }

  function open(): void {
    if (settled)
      return
    const list = adapter.sessionList()
    if (list === undefined || !list.ids.includes(sessionId) || !adapter.has('navigation.openSession'))
      return
    settle()
    void (async () => {
      const outcome = adapter.openSession(sessionId)
      if (outcome.status !== 'opened')
        throw new Error(outcome.reason)
      await outcome.value
      markInjectedSessionConsumed(sessionId)
    })().catch((error: unknown) => reportPluginError(error))
  }

  cancelPoll = controller.interval(open, NAVIGATION_POLL_MS)
  cancelTimeout = controller.timeout(
    () => settle(`dsh-tauri: session ${sessionId} was not opened (missing from the list or no openSession capability)`),
    NAVIGATION_TIMEOUT_MS,
  )
  open()
}

export const navigationFeature = defineRegister<ClientContext>((controller, _ctx, adapter) => {
  controller.listenEvent(CMD_NEW_SESSION, () => {
    void adapter.startSession().catch((error: unknown) => reportPluginError(error))
  })
  controller.listenEvent(CMD_ADD_WORKSPACE, () => {
    void adapter.addWorkspace({ openSession: true }).catch((error: unknown) => reportPluginError(error))
  })

  const { sessionId, presentation, consumed } = takeInjectedNavigation()
  console.warn('[dsh-tauri] navigation: injected', { sessionId, presentation, consumed })
  if (presentation === PRESENTATION_FULL_SIDEBAR) {
    if (sessionId !== undefined) {
      isolateSidebarLayout(sessionId)
      closeWhenArchived(controller, sessionId)
    }
    presentFullSidebar(controller)
  }
  if (sessionId !== undefined && !consumed)
    consumeInjectedSession(controller, adapter, sessionId)
})
