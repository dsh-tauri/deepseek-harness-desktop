import type { ThemeRuntime } from '@deepseek-ai/dsh-client-ui-theme/client'
import type { Appearance } from '../../shared/appearance'
import type { ClientContext } from '../types'
import { appearanceBootCss, appearanceColors, appearanceSidebarFill, appearanceTokens, appearanceTranslucent, normalizeAppearance } from '../../shared/appearance'
import { PLUGIN_ID } from '../../shared/constants'
import { invokeParent } from '../service/invoke-parent'
import { listenParent } from '../service/listen-parent'
import { defineRegister } from './index'

export const registerAppearance = defineRegister<ClientContext>((controller, ctx, adapter) => {
  const theme = adapter.service<ThemeRuntime>('theme')
  if (typeof theme?.overrideTokens !== 'function') {
    console.warn('[appearance] the core theme API is unavailable')
    return
  }
  const style = document.createElement('style')
  style.id = 'dsh-tauri:appearance'
  style.dataset.plugin = PLUGIN_ID
  document.head.append(style)
  let current: Appearance | undefined
  let removeTokens: (() => void) | undefined
  // keep:effect 切换时立即释放观察器，避免 controller.observe 累积断开的实例；卸载由 controller 托管。
  let frameObserver: MutationObserver | undefined
  let waitingObserver: MutationObserver | undefined
  let frame: HTMLElement | null = null
  let restoreSidebar = false

  function updateStyles() {
    if (!current)
      return
    const { canvas, panel } = appearanceColors(current, theme!.getTheme().active.colorScheme)
    const translucent = appearanceTranslucent(current)
    style.textContent = [
      translucent ? `html{background:transparent!important}body{background:${appearanceSidebarFill(canvas, panel, translucent, current.opacity)}!important}` : '',
      translucent && current.sidebarOnly
        ? `body :has(>[data-slot="main"]),body [data-rightbar-col]{--dsw-alias-bg-base:${canvas};background:${canvas}!important} `
        + `[data-slot="settings.content"]{--dsw-alias-bg-base:${canvas};background:${canvas}!important}`
        : '',
      translucent ? `body [data-composer-seat]{--dsw-alias-bg-base:${canvas}}` : '',
      current.terminal ? 'body [data-sidebar-collapsed]:has(>[data-shell-overlay]){grid-template-columns:var(--dsh-appearance-columns)!important}body [data-sidebar-collapsed] [data-slot="sidebar"]{visibility:hidden}' : '',
      appearanceBootCss(current),
    ].filter(Boolean).join('\n')
  }

  function syncColumns() {
    if (!frame)
      return
    const columns = frame.style.gridTemplateColumns.replace(/^\S+\s+/, '0px ')
    if (frame.style.getPropertyValue('--dsh-appearance-columns') !== columns)
      frame.style.setProperty('--dsh-appearance-columns', columns)
  }

  function attachFrame(): boolean {
    frame = document.querySelector<HTMLElement>('[data-shell-overlay]')?.parentElement ?? null
    if (!frame)
      return false
    waitingObserver?.disconnect()
    waitingObserver = undefined
    syncColumns()
    frameObserver = new MutationObserver(syncColumns)
    frameObserver.observe(frame, { attributes: true, attributeFilter: ['style'] })
    restoreSidebar = !frame.hasAttribute('data-sidebar-collapsed')
    if (restoreSidebar)
      ctx.layout.toggleSidebar()
    return true
  }

  function stopTerminal() {
    waitingObserver?.disconnect()
    frameObserver?.disconnect()
    waitingObserver = frameObserver = undefined
    frame?.style.removeProperty('--dsh-appearance-columns')
    if (restoreSidebar && frame?.hasAttribute('data-sidebar-collapsed'))
      ctx.layout.toggleSidebar()
    restoreSidebar = false
    frame = null
  }

  controller.add(listenParent<{ type: string, appearance?: unknown }>((message) => {
    const next = normalizeAppearance(message.appearance)
    if (current && JSON.stringify(current) === JSON.stringify(next))
      return
    const terminalChanged = next.terminal !== current?.terminal
    current = next
    removeTokens?.()
    const tokens = appearanceTokens(next)
    if (appearanceTranslucent(next)) {
      tokens['--dsw-alias-bg-base'] = { dark: 'transparent', light: 'transparent' }
      tokens['--dsw-specific-sidebar-fill'] = { dark: 'transparent', light: 'transparent' }
    }
    removeTokens = Object.keys(tokens).length ? theme.overrideTokens('dsh-tauri:appearance', tokens) : undefined
    updateStyles()
    invokeParent({ type: 'dsh://appearance:applied' })
    if (terminalChanged) {
      stopTerminal()
      if (next.terminal && !attachFrame()) {
        waitingObserver = new MutationObserver(attachFrame)
        waitingObserver.observe(document.body, { childList: true, subtree: true })
      }
    }
  }, 'dsh://appearance'))
  controller.add(ctx.on('theme/change', updateStyles))
  controller.add(() => {
    stopTerminal()
    removeTokens?.()
    style.remove()
  })
  invokeParent({ type: 'dsh://appearance:ready' })
})
