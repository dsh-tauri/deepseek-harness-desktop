import type { ClientContext } from 'dsh-tauri/client'
import { defineRegister } from 'dsh-tauri/client'
import globalStyle, { GLOBAL_STYLE_ID } from '../styles/global.cssr'
import heroWorkspaceStyle, { HERO_WORKSPACE_STYLE_ID } from '../ui/hero-workspace.cssr'
import { mountStyle } from '../utils/style'

export const registerStyles = defineRegister<ClientContext>((controller) => {
  controller.add(mountStyle(globalStyle, GLOBAL_STYLE_ID))
  controller.add(mountStyle(heroWorkspaceStyle, HERO_WORKSPACE_STYLE_ID))
})
