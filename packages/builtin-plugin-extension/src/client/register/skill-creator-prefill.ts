import { defineRegister } from 'dsh-tauri/client'
import { SkillCreatorPrefill } from '../components/skill-creator-prefill'
import {
  CONVERSATION_INPUT_LEFT_SLOT,
  INPUT_PREFILL_ID,
  INPUT_PREFILL_ORDER,
  INPUT_PREFILL_PRIORITY,
  PLUGIN_ID,
} from '../constants'
import { store } from '../store'

export const skillCreatorPrefillFeature = defineRegister((controller, ctx) => {
  store.prefill.clear()
  controller.add(ctx.slots.inject(CONVERSATION_INPUT_LEFT_SLOT as never, () => ctx.slots.register({
    name: CONVERSATION_INPUT_LEFT_SLOT,
    id: INPUT_PREFILL_ID,
    registrant: PLUGIN_ID,
    order: INPUT_PREFILL_ORDER,
    priority: INPUT_PREFILL_PRIORITY,
    inject: (sessionId: string) => ({ sessionId }),
  } as never, SkillCreatorPrefill)))
  controller.add(() => store.prefill.clear())
})
