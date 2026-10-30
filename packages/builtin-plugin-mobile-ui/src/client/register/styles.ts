import type { ClientContext } from 'dsh-tauri/client'
import { mountStyle } from 'dsh-tauri-ui/client'
import { defineRegister } from 'dsh-tauri/client'
import { PLUGIN_ID } from '../../shared/constants'
import mobileStyle from '../styles/mobile.cssr'
import settingsStyle from '../styles/settings.cssr'

export const registerStyles = defineRegister<ClientContext>((controller) => {
  controller.add(mountStyle(mobileStyle, `${PLUGIN_ID}-styles`, PLUGIN_ID))
  controller.add(mountStyle(settingsStyle, `${PLUGIN_ID}-settings-styles`, PLUGIN_ID))
  document.documentElement.setAttribute('data-dsh-mobile-ui', '')
  controller.add(() => document.documentElement.removeAttribute('data-dsh-mobile-ui'))
})
