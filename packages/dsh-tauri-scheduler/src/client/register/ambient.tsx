import type { ClientContext, RegisterController } from 'dsh-tauri/client'
import type { ComponentType } from 'react'
import { defineRegister, noop } from 'dsh-tauri/client'
import { ScheduleCatalogAction } from '../components/schedule-catalog-action'
import { ScheduleDeletionOverlay } from '../components/schedule-deletion-overlay'
import { ScheduleTurnCard } from '../components/schedule-turn-card'
import { SessionScheduleHover } from '../components/session-schedule-hover'
import { SessionScheduleMark } from '../components/session-schedule-mark'
import { PLUGIN_ID } from '../constants'
import { locale } from '../locales'
import { scheduleTurnDefinition } from '../service/schedule-turn'
import { store } from '../store'

const DELETION_OVERLAY_ID = `${PLUGIN_ID}.delete-toast`

interface AmbientSlotSpec {
  readonly kind: string
  readonly scope: string
}

interface AmbientSlotEntry {
  readonly name: string
  readonly id: string
  readonly order?: number
  readonly locale: string
  readonly inject?: (sessionId: string) => object
}

interface AmbientSlots {
  spec: (name: string) => AmbientSlotSpec | undefined
  inject: (name: string, setup: () => () => void) => () => void
  register: <Props extends object>(entry: AmbientSlotEntry, component: ComponentType<Props>) => () => void
}

interface AmbientConversation {
  readonly events?: {
    register: (definition: typeof scheduleTurnDefinition) => () => void
  }
}

export const ambientFeature = defineRegister<ClientContext>((controller, ctx, adapter) => {
  const slots = adapter.service<AmbientSlots>('slots')
  if (!slots || typeof slots.spec !== 'function' || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
    console.warn('[scheduler ambient] Public slot spec/inject/register capability unavailable; ambient surfaces disabled.')
    return
  }
  const registerSeat = <Props extends object>(entry: AmbientSlotEntry, scope: 'root' | 'session', component: ComponentType<Props>, owner: RegisterController = controller) => {
    try {
      if (slots.spec(entry.name) === undefined)
        console.warn(`[scheduler ambient] Public seat ${entry.name} unavailable; disabled until declared.`)
      owner.add(slots.inject(entry.name, () => {
        if (controller.isDisposed() || owner.isDisposed())
          return noop
        const spec = slots.spec(entry.name)
        if (spec?.kind !== 'list' || spec.scope !== scope) {
          console.warn(`[scheduler ambient] Public seat ${entry.name} incompatible; expected list/${scope}.`)
          return noop
        }
        try {
          return slots.register(entry, component)
        }
        catch (error) {
          console.warn(`[scheduler ambient] Public seat ${entry.name} registration failed; surface disabled.`, error)
          return noop
        }
      }))
    }
    catch (error) {
      console.warn(`[scheduler ambient] Public seat ${entry.name} capability failed; surface disabled.`, error)
    }
  }
  const taskNavigation = (sessionId: string) => ({
    openTaskDetail: (id: string) => store.navigation.request({ id, sessionId }),
  })
  const turnFeature = defineRegister<ClientContext>((turnController, _turnCtx, turnAdapter) => {
    if (controller.isDisposed())
      return
    const conversation = turnAdapter.service<AmbientConversation>('uiConversation')
    if (typeof conversation?.events?.register !== 'function') {
      console.warn('[scheduler ambient] uiConversation.events.register unavailable; created turn cards disabled.')
      return
    }
    try {
      turnController.add(conversation.events.register(scheduleTurnDefinition))
      registerSeat({
        name: 'conversation.chat.turnTail',
        id: 'schedule-created',
        order: 20,
        locale: locale.NS,
        inject: taskNavigation,
      }, 'session', ScheduleTurnCard, turnController)
    }
    catch (error) {
      console.warn('[scheduler ambient] Conversation definition registration failed; created turn cards disabled.', error)
    }
  })
  if (typeof ctx.inject === 'function') {
    if (adapter.service('uiConversation') === undefined)
      console.warn('[scheduler ambient] uiConversation unavailable; created turn cards disabled until declared.')
    try {
      const fiber = ctx.inject(['uiConversation'], scoped => scoped.effect(turnFeature, 'scheduler: ambient turn'))
      controller.add(() => void fiber.dispose())
    }
    catch (error) {
      console.warn('[scheduler ambient] Conversation dependency injection failed; created turn cards disabled.', error)
    }
  }
  else {
    controller.add(turnFeature.call(ctx))
  }
  registerSeat({
    name: 'conversation.session.header.utilities',
    id: 'schedule-catalog',
    order: -5,
    locale: locale.NS,
    inject: sessionId => ({ ...taskNavigation(sessionId), sessionId }),
  }, 'session', ScheduleCatalogAction)
  registerSeat({ name: 'sidebar.session.row.leading', id: 'schedule-mark', order: 10, locale: locale.NS }, 'root', SessionScheduleMark)
  registerSeat({ name: 'sidebar.session.row.hover', id: 'schedule-tasks', order: 10, locale: locale.NS }, 'root', SessionScheduleHover)
  registerSeat({ name: 'shell.overlay', id: DELETION_OVERLAY_ID, locale: locale.NS }, 'root', ScheduleDeletionOverlay)
})
