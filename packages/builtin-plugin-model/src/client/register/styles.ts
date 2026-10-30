import { mountStyle } from 'dsh-tauri-ui/client'
import { defineRegister } from 'dsh-tauri/client'
import { PLUGIN_ID } from '../../shared/constants'
import { OVERRIDES_STYLE_ID, STYLES_ID } from '../constants'
import { modelsStylesNode } from '../models/styles'
import { modelsOverridesNode } from '../models/styles.overrides'

export const registerStyles = defineRegister((controller) => {
  controller.add(mountStyle(modelsStylesNode, STYLES_ID, PLUGIN_ID))
  controller.add(mountStyle(modelsOverridesNode, OVERRIDES_STYLE_ID, PLUGIN_ID))
})
