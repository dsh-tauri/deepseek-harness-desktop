import type { AdapterSessions, AdapterWorkspaces, ClientAdapter, ClientContext } from 'dsh-tauri/client'
import type { SelectorHook } from '../types/selector'
import type { SessionListStateLike } from '../ui/hero-workspace.types'
import { defineRegister } from 'dsh-tauri/client'
import { useSyncExternalStore } from 'react'
import { PLUGIN_ID } from '../../shared/constants'
import {
  HERO_WORKSPACE_FLOW_SLOT,
  HERO_WORKSPACE_PRIORITY,
  HERO_WORKSPACE_SLOT,
} from '../constants'
import { startUngroupedSession } from '../service/ungrouped-session'
import { HeroWorkspace } from '../ui/hero-workspace'

export const heroWorkspaceFeature = defineRegister<ClientContext>((controller, ctx, adapter) => {
  const directoryFlow = {
    getSnapshot: () => ctx.slots.entries(HERO_WORKSPACE_FLOW_SLOT as never).length > 0,
    subscribe: (listener: () => void) => ctx.slots.subscribe(HERO_WORKSPACE_FLOW_SLOT as never, listener),
  }

  controller.add(ctx.slots.inject(HERO_WORKSPACE_SLOT as never, () => {
    return ctx.slots.register(
      {
        name: HERO_WORKSPACE_SLOT,
        registrant: PLUGIN_ID,
        priority: HERO_WORKSPACE_PRIORITY,
        inject: () => ({
          createWorkspace: readCreateWorkspace(adapter),
          startUngrouped: () => startUngroupedSession(ctx, adapter),
          useSessions: selectSessionsFrom(adapter),
          hooks: { directoryFlow },
        }),
      } as never,
      HeroWorkspace as never,
    )
  }))
})

function readCreateWorkspace(adapter: ClientAdapter): AdapterWorkspaces['create'] {
  const workspaces = adapter.service<AdapterWorkspaces>('workspaces')
  return workspaces?.create?.bind(workspaces)
}

function selectSessionsFrom(adapter: ClientAdapter): SelectorHook<SessionListStateLike> {
  const absent: SessionListStateLike = {}
  return function useSessionList<S>(select: (state: SessionListStateLike) => S): S {
    const list = (adapter.sessions ?? adapter.service<AdapterSessions>('sessions'))?.list
    const read = (): SessionListStateLike => (list?.getSnapshot() ?? absent) as SessionListStateLike
    return select(useSyncExternalStore(
      listener => list?.subscribe(listener) ?? (() => {}),
      read,
      read,
    ))
  }
}
