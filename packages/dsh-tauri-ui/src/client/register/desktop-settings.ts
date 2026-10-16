import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ClientContext } from 'dsh-tauri/client'
import { defineRegister, detectMobileDevice } from 'dsh-tauri/client'
import { PLUGIN_ID } from '../../shared/constants'
import { DesktopSettings } from '../ui/desktop-settings'

const SETTINGS_GENERAL_ITEM_SLOT = 'settings.general.item'

export const registerDesktopSettings = defineRegister<ClientContext>((controller, ctx) => {
  if (detectMobileDevice() || !('dshDesktop' in globalThis))
    return

  controller.add(ctx.slots.inject(SETTINGS_GENERAL_ITEM_SLOT, () => ctx.slots.register({
    name: SETTINGS_GENERAL_ITEM_SLOT,
    id: 'desktop-settings',
    order: Number.MIN_SAFE_INTEGER,
    registrant: PLUGIN_ID,
    inject: () => ({}),
  }, DesktopSettings)))
})
