import type { ClientContext } from 'dsh-tauri/client'
import { defineRegister } from 'dsh-tauri/client'
import { PrefillBridge } from '../components/prefill-bridge'
import {
  CONVERSATION_INPUT_LEFT_SLOT,
  INPUT_PREFILL_ID,
  INPUT_PREFILL_ORDER,
  INPUT_PREFILL_PRIORITY,
  PLUGIN_ID,
} from '../constants'
import { store } from '../store'

export const prefillFeature = defineRegister<ClientContext>((controller, ctx) => {
  controller.add(ctx.slots.inject(CONVERSATION_INPUT_LEFT_SLOT, () => ctx.slots.register({
    name: CONVERSATION_INPUT_LEFT_SLOT,
    id: INPUT_PREFILL_ID,
    registrant: PLUGIN_ID,
    order: INPUT_PREFILL_ORDER,
    priority: INPUT_PREFILL_PRIORITY,
  }, PrefillBridge)))
  controller.add(() => store.prefill.clear())
})
