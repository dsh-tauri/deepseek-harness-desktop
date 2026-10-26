import type { ClientContext } from './types'
import { accountSignInFeature } from './register/account'
import { registerAppearance } from './register/appearance'
import { keyRepeatFeature } from './register/key-repeat'
import { navigationFeature } from './register/navigation'
import { shortcutsFeature } from './register/shortcuts'
import { sidebarFeature } from './register/sidebar'
import { sidebarFullwindowFeature } from './register/sidebar-fullwindow'
import { sidebarTweaksFeature } from './register/sidebar-tweaks'
import { registerStyle } from './register/style'
import { zoomShortcutFeature } from './register/zoom-shortcut'

const SIDEBAR_TOGGLE_EFFECT = 'dsh-tauri: sidebar (toggle command + collapsed report)'
const NAVIGATION_EFFECT = 'dsh-tauri: navigation (session target, new session, add workspace)'
const ZOOM_SHORTCUT_EFFECT = 'dsh-tauri: zoom shortcuts (ctrl/cmd +/-/0)'
const SIDEBAR_TWEAKS_EFFECT = 'dsh-tauri: sidebar tweaks (hide collapse toggle, center brand)'
const SIDEBAR_FULLWINDOW_EFFECT = 'dsh-tauri: sidebar full window (open-in-new-window button + full-screen setup)'
const STYLE_EFFECT = 'dsh-tauri: style (sidebar background)'
const ACCOUNT_SIGN_IN_EFFECT = 'dsh-tauri: account sign-in (auto-open the authorize url)'
const APPEARANCE_EFFECT = 'dsh-tauri: appearance'
const SHORTCUTS_EFFECT = 'dsh-tauri: shortcuts (catalog report + edit commands)'
const KEY_REPEAT_EFFECT = 'dsh-tauri: key repeat normalization (issue #1172)'

export function apply(ctx: ClientContext): void {
  if (typeof window === 'undefined' || typeof document === 'undefined' || window.parent === window)
    return

  ctx.effect(keyRepeatFeature, KEY_REPEAT_EFFECT)
  ctx.effect(registerAppearance, APPEARANCE_EFFECT)
  ctx.effect(registerStyle, STYLE_EFFECT)
  ctx.effect(sidebarFeature, SIDEBAR_TOGGLE_EFFECT)
  ctx.inject(['sessions'], (scoped) => {
    scoped.effect(navigationFeature, NAVIGATION_EFFECT)
  })
  ctx.effect(zoomShortcutFeature, ZOOM_SHORTCUT_EFFECT)
  ctx.effect(sidebarTweaksFeature, SIDEBAR_TWEAKS_EFFECT)
  ctx.effect(sidebarFullwindowFeature, SIDEBAR_FULLWINDOW_EFFECT)
  ctx.effect(accountSignInFeature, ACCOUNT_SIGN_IN_EFFECT)
  ctx.effect(shortcutsFeature, SHORTCUTS_EFFECT)
}
