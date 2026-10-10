import type { ClientAdapter, ISessions, RegisterController, SessionId } from 'dsh-tauri/client'
import type { NativeModelActions, NativeModelScope } from '../types/kernel-model'
import { isEqual, noop } from 'dsh-tauri/client'
import { loadNativeModels, selectNativeModel } from '../service/kernel-model'
import { isNativeTurnOptions, nativeModelDirectory } from '../service/kernel-model.utils'
import { nativeModel } from '../store/modules/native-model'

export function registerNativeModels(controller: RegisterController, adapter: ClientAdapter): NativeModelActions {
  const scopes = new Map<string, { scope: number, backend: string, nativeSessionId: string, references: number }>()
  const canSelectNativeModel = (): boolean => !controller.isDisposed() && adapter.has('sessions.refreshProjections')
    && adapter.has('sessions.list')
  const scopeOf = (sessionId: string, binding: { backend: string, nativeSessionId: string, sessionId: string }): NativeModelScope | undefined => {
    const lease = scopes.get(sessionId)
    return canSelectNativeModel() && binding.sessionId === sessionId && lease?.backend === binding.backend
      && lease.nativeSessionId === binding.nativeSessionId
      ? { sessionId, scope: lease.scope, active: () => !controller.isDisposed() && scopes.get(sessionId) === lease && lease.references > 0 }
      : undefined
  }
  controller.add(() => {
    for (const [sessionId, lease] of scopes)
      nativeModel.close(sessionId, lease.scope)
    scopes.clear()
  })
  const actions: NativeModelActions = {
    canSelectNativeModel,
    createNativeModelDirectory(sessionId, binding, current) {
      const initial = nativeModelDirectory(binding.backend, current, null)
      return {
        getSnapshot: () => {
          const entry = nativeModel.$state.entries[sessionId]
          return scopeOf(sessionId, binding) === undefined ? initial : entry?.directory ?? initial
        },
        subscribe(listener) {
          if (!canSelectNativeModel() || binding.sessionId !== sessionId)
            return noop
          const release = actions.acquireNativeModel(sessionId, binding)
          const state = adapter.service<ISessions>('sessions')?.list.getSnapshot()
          const values = state?.projectionsBySession?.[sessionId as SessionId]?.values ?? state?.byId[sessionId as SessionId]?.projectionValues
          const latest = isEqual(values?.bridgeKernel, binding) && isNativeTurnOptions(values?.bridgeModel) ? values.bridgeModel : current
          actions.syncNativeModel(sessionId, binding, latest)
          const unsubscribe = nativeModel.$subscribe(listener)
          let stopped = false
          const dispose = () => {
            if (stopped)
              return
            stopped = true
            unsubscribe()
            release()
          }
          const unhook = controller.add(dispose)
          return () => {
            dispose()
            unhook()
          }
        },
      }
    },
    acquireNativeModel(sessionId, binding) {
      if (!canSelectNativeModel() || binding.sessionId !== sessionId)
        return noop
      let lease = scopes.get(sessionId)
      if (lease === undefined || lease.backend !== binding.backend || lease.nativeSessionId !== binding.nativeSessionId) {
        const current = { model: null, reasoningEffort: null }
        lease = { scope: nativeModel.nextScope(), backend: binding.backend, nativeSessionId: binding.nativeSessionId, references: 0 }
        scopes.set(sessionId, lease)
        nativeModel.open({ ...lease, sessionId, backend: binding.backend, request: 0, catalog: null, current, directory: nativeModelDirectory(binding.backend, current, null) })
      }
      lease.references += 1
      const owned = lease
      let released = false
      return () => {
        if (released || scopes.get(sessionId) !== owned)
          return
        released = true
        if (--owned.references === 0) {
          queueMicrotask(() => {
            if (scopes.get(sessionId) !== owned || owned.references !== 0)
              return
            scopes.delete(sessionId)
            nativeModel.close(sessionId, owned.scope)
          })
        }
      }
    },
    syncNativeModel(sessionId, binding, current) {
      const scope = scopeOf(sessionId, binding)
      const entry = nativeModel.$state.entries[sessionId]
      if (scope === undefined || entry === undefined || isEqual(entry.current, current))
        return
      nativeModel.update(sessionId, scope.scope, { current, directory: nativeModelDirectory(entry.backend, current, entry.catalog, entry.directory) })
    },
    async loadNativeModels(sessionId, binding) {
      const scope = scopeOf(sessionId, binding)
      if (scope !== undefined)
        await loadNativeModels(scope)
    },
    async selectNativeModel(sessionId, binding, selection) {
      const scope = scopeOf(sessionId, binding)
      if (scope === undefined)
        return undefined
      return selectNativeModel({
        ...scope,
        selection,
        async refreshProjection(id) {
          if (controller.isDisposed() || !scope.active())
            throw new Error('Native model selection scope is unavailable')
          await adapter.sessions.refreshProjections!(id)
          if (controller.isDisposed() || !scope.active())
            throw new Error('Native model selection scope is unavailable')
          const sessions = adapter.service<ISessions>('sessions')
          const state = sessions?.list.getSnapshot()
          const values = state?.projectionsBySession?.[id as SessionId]?.values ?? state?.byId[id as SessionId]?.projectionValues
          if (!isEqual(values?.bridgeKernel, binding) || !isNativeTurnOptions(values?.bridgeModel))
            throw new Error('Native model selection projection is unavailable')
          return values.bridgeModel
        },
      })
    },
  }
  return actions
}
