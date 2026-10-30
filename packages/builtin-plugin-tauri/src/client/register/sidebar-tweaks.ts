import { PLUGIN_ID } from '../../shared/constants'
import { NEW_SESSION_SELECTOR } from '../constants'
import { CssRender } from '../modules/css-render'
import { reportPluginError } from '../utils/error'
import { defineRegister } from './index'

const COLLAPSE_SIDEBAR_SELECTOR = 'button[aria-label="收起侧边栏"],button[aria-label="Collapse sidebar"]'

const SIDEBAR_TWEAKS_STYLE_ID = 'dsh-tauri:sidebar-tweaks'

export const sidebarTweaksFeature = defineRegister((controller) => {
  try {
    const { c } = CssRender()
    const style = c([
      c(COLLAPSE_SIDEBAR_SELECTOR, { display: 'none !important' }),
      c(NEW_SESSION_SELECTOR, { justifyContent: 'center !important' }),
    ])
    style.mount({ id: SIDEBAR_TWEAKS_STYLE_ID, head: true }).setAttribute('data-plugin', PLUGIN_ID)
    controller.add(() => style.unmount({ id: SIDEBAR_TWEAKS_STYLE_ID }))
  }
  catch (error) {
    reportPluginError(error)
  }
})
