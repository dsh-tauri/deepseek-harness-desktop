import { emit } from '../service/tauri'
import { zoomActionFromShortcut } from '../utils/zoom'
import { defineRegister } from './index'

const TYPE_ZOOM_SHORTCUT = 'dsh://zoom-shortcut'

export const zoomShortcutFeature = defineRegister((controller) => {
  controller.listen('keydown', (event) => {
    const action = zoomActionFromShortcut(event)
    if (action === null)
      return
    event.preventDefault()
    void emit(TYPE_ZOOM_SHORTCUT, { action })
  }, { capture: true })
})
