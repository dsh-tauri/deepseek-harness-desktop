import type { AdapterSessions, AdapterWorkspaces, ClientContext, RegisterController } from 'dsh-tauri/client'
import type { SessionListSnapshot, WorktreeHydrationSessionsRuntime } from '../service/hydration.types'
import { defineRegister, difference, forEach, isEqual } from 'dsh-tauri/client'
import {
  DISCARD_MAX_POLLS,
  DISCARD_POLL_DELAY_MS,
  HYDRATION_RETRY_DELAY_MS,
  SESSION_RECONCILE_MIN_INTERVAL_MS,
  SESSION_SWITCH_MAX_ATTEMPTS,
  SESSION_SWITCH_RETRY_DELAY_MS,
} from '../constants'
import {
  calibrateSession,
  clearRetryBookkeeping,
  createHydrationState,
  isArchived,
  isKnownGit,
  isWorktree,
  loadJobStatus,
  noteAppearances,
  noteListBaseline,
  planDiscardPoll,
  planHandoff,
  planRetry,
  syncBindings,
} from '../service/hydration'
import { switchSession } from '../service/session-switch'
import { attach, discard } from '../service/worktree'
import { store } from '../store'
import { sessionStateOf } from '../store/modules/worktree.utils'
import { createKeyedThrottle } from './hydration.utils'

const BINDINGS_THROTTLE_KEY = '@bindings'

interface WorkspaceRuntime {
  list: {
    getSnapshot: () => { archivedSessionIds: readonly string[] }
    subscribe: (listener: () => void) => () => void
  }
}

export function registerWorktreeHydration(
  controller: RegisterController,
  sessions: AdapterSessions,
  workspaces: AdapterWorkspaces,
): void {
  const sessionsRuntime = sessions as unknown as WorktreeHydrationSessionsRuntime
  const workspacesRuntime = workspaces as unknown as WorkspaceRuntime

  const state = createHydrationState()
  let bindingsInFlight = false
  let knownIds = new Set<string>()
  let lastCurrent: string | undefined

  const reconcileThrottle = createKeyedThrottle({
    intervalMs: SESSION_RECONCILE_MIN_INTERVAL_MS,
    schedule: (fn, ms) => controller.timeout(fn, ms),
  })

  controller.add(() => reconcileThrottle.clear())
  controller.add(() => clearRetryBookkeeping(state))

  const sessionSnapshot = (): SessionListSnapshot => sessionsRuntime.list.getSnapshot() as SessionListSnapshot
  const archivedIds = (): readonly string[] => workspacesRuntime.list.getSnapshot().archivedSessionIds

  function scheduleDiscardPoll(sessionId: string, jobId: string, attempts: number): void {
    if (controller.isDisposed() || attempts >= DISCARD_MAX_POLLS)
      return
    if (!planDiscardPoll(state, sessionId, jobId, attempts))
      return
    controller.timeout(async () => {
      if (controller.isDisposed())
        return
      const status = await loadJobStatus({ sessionId, jobId })
      if (controller.isDisposed())
        return
      if (status?.mode === 'deleting' && status.jobId) {
        scheduleDiscardPoll(sessionId, status.jobId, attempts + 1)
        return
      }
      if (!status) {
        scheduleDiscardPoll(sessionId, jobId, attempts + 1)
        return
      }
      state.discardPolls.delete(sessionId)
      requestSessionReconcile(sessionId)
    }, DISCARD_POLL_DELAY_MS)
  }

  function scheduleRetry(sessionId: string): void {
    if (controller.isDisposed())
      return
    const plan = planRetry(state, sessionId, Date.now())
    if (plan === 'exhausted')
      return
    const delay = plan === 'throttled' ? HYDRATION_RETRY_DELAY_MS * 2 : HYDRATION_RETRY_DELAY_MS
    controller.timeout(() => {
      if (!controller.isDisposed())
        requestGitCalibration(sessionId)
    }, delay)
  }

  function requestBindingsSync(): void {
    reconcileThrottle.request(BINDINGS_THROTTLE_KEY, async () => {
      if (bindingsInFlight || controller.isDisposed())
        return
      bindingsInFlight = true
      try {
        const snapshot = sessionSnapshot()
        const projection = await syncBindings({ state, ids: snapshot.ids, current: snapshot.current })
        if (!projection || controller.isDisposed())
          return
        forEach(projection.bound, entry => maybeHandoffToWorktree(entry.sessionId, entry.sourceSessionId))
        if (projection.current && !isArchived(state, projection.current))
          requestGitCalibration(projection.current)
      }
      finally {
        bindingsInFlight = false
      }
    })
  }

  function requestGitCalibration(sessionId: string): void {
    if (isArchived(state, sessionId) || isKnownGit(state, sessionId) || state.exhausted.has(sessionId))
      return
    reconcileThrottle.request(sessionId, () => {
      if (!isKnownGit(state, sessionId) && !state.exhausted.has(sessionId))
        reconcileSession(sessionId)
    })
  }

  function requestSessionReconcile(sessionId: string): void {
    if (isArchived(state, sessionId) || state.exhausted.has(sessionId))
      return
    reconcileThrottle.request(sessionId, () => {
      if (!state.exhausted.has(sessionId) && !controller.isDisposed())
        reconcileSession(sessionId)
    })
  }

  function requestTurnEndReconcile(sessionId: string): void {
    if (isArchived(state, sessionId) || state.exhausted.has(sessionId) || !isWorktree(sessionId))
      return
    reconcileThrottle.request(sessionId, () => {
      if (isWorktree(sessionId))
        reconcileSession(sessionId)
    })
  }

  function finishSwitch(sourceSessionId: string, targetSessionId: string): void {
    if (state.switching.get(sourceSessionId) === targetSessionId)
      state.switching.delete(sourceSessionId)
  }

  function maybeHandoffToWorktree(sessionId: string, sourceSessionId: string): void {
    const decision = planHandoff({
      state,
      sessionId,
      sourceSessionId,
      current: sessionSnapshot().current,
      now: Date.now(),
    })
    if (!decision)
      return

    const attempt = async (remaining: number): Promise<void> => {
      if (controller.isDisposed() || remaining <= 0) {
        finishSwitch(decision.sourceSessionId, decision.targetSessionId)
        return
      }
      const outcome = await switchSession({
        sessions: sessionsRuntime,
        sourceSessionId: decision.sourceSessionId,
        targetSessionId: decision.targetSessionId,
      })
      if (controller.isDisposed() || outcome !== 'retry') {
        finishSwitch(decision.sourceSessionId, decision.targetSessionId)
        return
      }
      controller.timeout(() => {
        void attempt(remaining - 1)
      }, SESSION_SWITCH_RETRY_DELAY_MS)
    }

    void attempt(SESSION_SWITCH_MAX_ATTEMPTS)
  }

  function reconcileSession(sessionId: string): void {
    if (state.inFlight.has(sessionId)) {
      state.queued.add(sessionId)
      return
    }
    state.inFlight.add(sessionId)

    void calibrateSession({ state, sessionId })
      .then((result) => {
        if (controller.isDisposed())
          return
        if (result.kind === 'pending' || result.kind === 'unknown') {
          scheduleRetry(sessionId)
          return
        }
        if ((result.kind === 'deleting' || result.kind === 'failed') && result.jobId) {
          scheduleDiscardPoll(sessionId, result.jobId, 0)
          return
        }
        if (result.kind === 'worktree') {
          void attach({ sessionId })
          maybeHandoffToWorktree(sessionId, result.sourceSessionId ?? '')
        }
      })
      .finally(() => {
        state.inFlight.delete(sessionId)
        if (state.queued.delete(sessionId) && !controller.isDisposed())
          requestSessionReconcile(sessionId)
      })
  }

  function hydrate(): void {
    const { ids } = sessionSnapshot()
    const changed = !isEqual(new Set(ids), knownIds)
    if (!changed)
      return
    knownIds = new Set(ids)
    requestBindingsSync()
  }

  function handleArchivedSessions(): void {
    const nextArchived = new Set(archivedIds())
    forEach(difference([...nextArchived], [...state.archivedIds]), (sessionId) => {
      const local = sessionStateOf(store.worktree.$state, sessionId)
      if (local.mode === 'worktree' && local.worktreeKey)
        void discard({ sessionId, worktreeKey: local.worktreeKey })
    })
    state.archivedIds = nextArchived
  }

  function bindSessionEvents(): void {
    const unsubscribed = difference(sessionSnapshot().ids, [...state.subscribedSessions])
    forEach(unsubscribed, (sessionId) => {
      if (isArchived(state, sessionId))
        return
      const session = sessionsRuntime.binding(sessionId)?.session
      if (!session?.subscribe)
        return

      state.subscribedSessions.add(sessionId)
      controller.add(session.subscribe(() => {
        if (controller.isDisposed())
          return
        const running = session.getSnapshot?.()?.running
        if (typeof running !== 'boolean') {
          requestTurnEndReconcile(sessionId)
          return
        }
        const previousRunning = state.lastRunning.get(sessionId)
        state.lastRunning.set(sessionId, running)
        if (previousRunning === true && !running)
          requestTurnEndReconcile(sessionId)
      }))
    })
  }

  controller.add(sessionsRuntime.list.subscribe(() => {
    noteListBaseline(state, sessionSnapshot().ids)
    noteAppearances(state, sessionSnapshot().ids, Date.now())
    hydrate()
    bindSessionEvents()

    const { current } = sessionSnapshot()
    if (current && current !== lastCurrent) {
      lastCurrent = current
      state.exhausted.delete(current)
      state.retryAttempts.delete(current)
      state.retryWindowStart.set(current, Date.now())
      if (!isArchived(state, current))
        requestGitCalibration(current)
    }
  }))

  controller.add(workspacesRuntime.list.subscribe(handleArchivedSessions))

  noteListBaseline(state, sessionSnapshot().ids)
  noteAppearances(state, sessionSnapshot().ids, Date.now())
  handleArchivedSessions()
  lastCurrent = sessionSnapshot().current
  hydrate()
  bindSessionEvents()
}

export const hydrationFeature = defineRegister<ClientContext>((controller, _ctx, adapter) => {
  registerWorktreeHydration(controller, adapter.sessions, adapter.workspaces)
})
