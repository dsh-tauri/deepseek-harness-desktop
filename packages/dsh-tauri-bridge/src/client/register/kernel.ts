import type { AdapterSessionCreateOptions, ClientContext, ISessions, SessionId, SlotRegistry } from 'dsh-tauri/client'
import type { BackendId } from '../../shared/types'
import { registerSlotDecoration } from 'dsh-tauri-ui/client'
import { defineRegister } from 'dsh-tauri/client'
import { PLUGIN_ID } from '../../shared/constants'
import { getBackends } from '../apis'
import { HeroKernel } from '../components/hero-kernel'
import { ModelKernel } from '../components/model-kernel'
import { SessionKernel } from '../components/session-kernel'
import { SessionKernelHover } from '../components/session-kernel-hover'
import { HERO_AGENT_PRESET_SLOT, MODEL_KERNEL_SLOT, SIDEBAR_KERNEL_HOVER_SLOT, SIDEBAR_KERNEL_SLOT } from '../constants'
import { backendFromIdentity, kernelFromList } from '../service/kernel-identity'
import { canLockModelEntry } from '../service/kernel-model'
import { createKernelSession } from '../service/kernel-session'
import { kernelStore } from '../store/modules/kernel-store'
import { registerNativeModels } from './kernel-model'

export const kernel = defineRegister<ClientContext>((controller, ctx, adapter) => {
  let detection = 0
  let cancelDetection: (() => void) | undefined
  const warned = new Set<string>()
  const active = (): boolean => !controller.isDisposed()

  function warn(key: string, error?: unknown): void {
    if (controller.isDisposed() || warned.has(key))
      return
    warned.add(key)
    console.warn(`[${PLUGIN_ID}] ${key}`, error)
  }

  async function refreshBackends(startup = false): Promise<void> {
    if (!active())
      return
    cancelDetection?.()
    const request = ++detection
    const abort = new AbortController()
    const cancel = () => abort.abort()
    cancelDetection = cancel
    const unhook = controller.add(cancel)
    const current = (): boolean => active() && request === detection && !abort.signal.aborted
    kernelStore.$patch({ phase: 'loading', error: null })
    try {
      for (let attempt = 0; current(); attempt++) {
        try {
          const backends = await getBackends({ signal: abort.signal })
          if (current())
            kernelStore.$patch({ backends, phase: 'ready', error: null })
          return
        }
        catch (reason) {
          if (!current())
            return
          if (!startup || attempt >= 4 || typeof reason !== 'object' || reason === null || !('status' in reason) || reason.status !== 404)
            throw reason
          await new Promise<void>((resolve) => {
            let stop: (() => void) | undefined
            const finish = () => {
              stop?.()
              abort.signal.removeEventListener('abort', finish)
              resolve()
            }
            stop = controller.timeout(finish, 250 * 2 ** attempt)
            abort.signal.addEventListener('abort', finish, { once: true })
          })
        }
      }
    }
    catch (reason) {
      if (current()) {
        kernelStore.$patch({ phase: 'error', error: reason instanceof Error ? reason.message : String(reason) })
        warn('kernel detection failed', reason)
      }
    }
    finally {
      unhook()
      if (cancelDetection === cancel)
        cancelDetection = undefined
    }
  }

  async function ensureProjection(sessionId: string): Promise<void> {
    if (!active())
      return
    const refresh = adapter.sessions.refreshProjections
    if (refresh === undefined) {
      warn('sessions.refreshProjections unavailable; session kernel identity is unknown')
      return
    }
    try {
      await refresh(sessionId)
      if (!active())
        return
      const sessions = adapter.service<ISessions>('sessions')
      const identity = sessions === undefined ? undefined : kernelFromList(sessions.list.getSnapshot(), sessionId as SessionId)
      if (backendFromIdentity(identity) === undefined)
        warn(`session kernel identity unavailable: ${sessionId}`)
    }
    catch (reason) {
      warn(`session projection read failed: ${sessionId}`, reason)
    }
  }

  const canCreate = (): boolean => active()
    && adapter.has('sessions.create')
    && adapter.has('sessions.refresh')
    && adapter.has('sessions.refreshProjections')
    && adapter.has('navigation.openSession')
    && typeof ctx.layout?.beginNavigation === 'function'

  async function createSession(backend: BackendId, options: AdapterSessionCreateOptions, agentPreset?: string): Promise<void> {
    if (!canCreate())
      throw new Error('Official kernel creation capabilities are unavailable')
    const navigation = ctx.layout.beginNavigation()
    const sessionId = await createKernelSession(adapter, backend, options, active, agentPreset)
    if (!active() || navigation.aborted)
      return
    const opened = adapter.openSession(sessionId)
    if (opened.status !== 'opened')
      throw new Error(opened.reason)
    kernelStore.select(backend)
  }

  const nativeModels = registerNativeModels(controller, adapter)
  const slots = adapter.service<SlotRegistry>('slots')
  controller.add(registerSlotDecoration(slots, {
    slot: HERO_AGENT_PRESET_SLOT,
    scope: 'session-maybe',
    registrant: PLUGIN_ID,
    component: HeroKernel,
    inject: () => ({ canCreate, createSession, ensureProjection, refreshBackends }),
    warn,
  }))
  controller.add(registerSlotDecoration(slots, {
    slot: MODEL_KERNEL_SLOT,
    scope: 'session',
    registrant: PLUGIN_ID,
    mode: 'wrap',
    component: ModelKernel,
    accept: canLockModelEntry,
    inject: () => ({ ensureProjection, ...nativeModels }),
    warn,
  }))
  if (typeof slots?.inject !== 'function' || typeof slots.register !== 'function' || typeof slots.spec !== 'function') {
    warn('sidebar kernel identity unavailable; official slot registration APIs are missing')
  }
  else {
    controller.add(slots.inject(SIDEBAR_KERNEL_SLOT, () => {
      const spec = slots.spec(SIDEBAR_KERNEL_SLOT)
      if (spec?.kind !== 'list' || spec.scope !== 'root') {
        warn('sidebar leading kernel identity unavailable; the official slot contract differs')
        return () => {}
      }
      return slots.register({
        name: SIDEBAR_KERNEL_SLOT,
        id: `${PLUGIN_ID}:kernel`,
        registrant: PLUGIN_ID,
        order: -10,
        inject: () => ({ ensureProjection }),
      }, SessionKernel)
    }))
    controller.add(slots.inject(SIDEBAR_KERNEL_HOVER_SLOT, () => {
      const spec = slots.spec(SIDEBAR_KERNEL_HOVER_SLOT)
      if (spec?.kind !== 'list' || spec.scope !== 'root') {
        warn('sidebar hover kernel identity unavailable; the official slot contract differs')
        return () => {}
      }
      return slots.register({
        name: SIDEBAR_KERNEL_HOVER_SLOT,
        id: `${PLUGIN_ID}:kernel`,
        registrant: PLUGIN_ID,
        order: -10,
        inject: () => ({ ensureProjection }),
      }, SessionKernelHover)
    }))
  }
  void refreshBackends(true)
})
