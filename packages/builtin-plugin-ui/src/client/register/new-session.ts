import type { ClientContext } from 'dsh-tauri/client'
import { defineRegister } from 'dsh-tauri/client'
import { startUngroupedSession } from '../service/ungrouped-session'
import { newSessionButtonFrom, ungroupedCreateButtonFrom } from './new-session.utils'

function newSessionFeature(matcher: (target: unknown) => Element | null) {
  return defineRegister<ClientContext>((controller, ctx, adapter) => {
    if (typeof document === 'undefined')
      return

    controller.listen('click', (event) => {
      if (matcher(event.target) === null)
        return
      event.preventDefault()
      event.stopImmediatePropagation()
      startUngroupedSession(ctx, adapter)
    }, { capture: true })
  })
}

export const sidebarNewSessionFeature = newSessionFeature(newSessionButtonFrom)

export const ungroupedNewSessionFeature = newSessionFeature(ungroupedCreateButtonFrom)
