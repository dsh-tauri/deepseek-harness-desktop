import type { ClientContext } from 'dsh-tauri/client'
import { defineRegister } from 'dsh-tauri/client'
import globalStyle, { GLOBAL_STYLE_ID } from '../styles/global.cssr'
import { mountStyle } from '../utils/style'

export const registerStyles = defineRegister<ClientContext>((controller) => {
  controller.add(mountStyle(globalStyle, GLOBAL_STYLE_ID))
})
