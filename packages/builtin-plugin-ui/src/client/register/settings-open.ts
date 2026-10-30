import type { ClientContext } from 'dsh-tauri/client'
import { defineRegister } from 'dsh-tauri/client'
import { settings } from '../store/modules/settings'

export const SETTINGS_OPEN_MESSAGE = 'dsh://settings:open'

export const registerSettingsOpen = defineRegister<ClientContext>((controller) => {
  controller.add(controller.listenEvent<{ section?: unknown } | null>(SETTINGS_OPEN_MESSAGE, ({ payload }) => {
    const section = payload?.section
    settings.openAt(typeof section === 'string' && section !== '' ? section : undefined)
  }))
})
