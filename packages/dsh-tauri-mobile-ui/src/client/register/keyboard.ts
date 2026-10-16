import type { ClientContext } from 'dsh-tauri/client'
import { defineRegister, detectMobileDevice } from 'dsh-tauri/client'

const COMPOSER = '[data-composer-seat], [data-slot="conversation.composer.bar"]'
const SCROLL = '[data-conversation-scroll], [data-slot="conversation.view"]'

export const registerMobileKeyboard = defineRegister<ClientContext>((controller, ctx) => {
  const t = ctx.locale.bind('conversation')
  let touch: { id: number, x: number, y: number } | undefined

  function dismissKeyboard() {
    const editor = document.activeElement
    if (detectMobileDevice() && editor instanceof HTMLElement && editor.closest(COMPOSER)
      && editor.matches('textarea, input, [contenteditable="true"]')) {
      editor.blur()
    }
  }

  controller.listen('click', (event) => {
    if (!(event.target instanceof Element))
      return
    const button = event.target.closest<HTMLButtonElement>('button')
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true' || !button.closest(COMPOSER))
      return
    if ([t('input.send'), t('input.send.queue'), t('input.send.steer')].includes(button.getAttribute('aria-label') ?? ''))
      dismissKeyboard()
  })
  controller.listen('touchstart', (event) => {
    touch = undefined
    if (!detectMobileDevice() || event.touches.length !== 1 || !(event.target instanceof Element) || event.target.closest(COMPOSER) || !event.target.closest(SCROLL))
      return
    const point = event.touches[0]!
    touch = { id: point.identifier, x: point.clientX, y: point.clientY }
  }, { passive: true })
  controller.listen('touchmove', (event) => {
    if (!touch || event.touches.length !== 1)
      return
    const point = event.touches[0]!
    if (point.identifier !== touch.id)
      return
    const dy = Math.abs(point.clientY - touch.y)
    if (dy > 10 && dy > Math.abs(point.clientX - touch.x)) {
      dismissKeyboard()
      touch = undefined
    }
  }, { passive: true })
  function resetTouch() {
    touch = undefined
  }
  controller.listen('touchend', resetTouch, { passive: true })
  controller.listen('touchcancel', resetTouch, { passive: true })
})
