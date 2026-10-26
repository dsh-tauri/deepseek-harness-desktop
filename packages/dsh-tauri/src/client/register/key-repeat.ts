import { defineRegister } from './index'

export function keyIdentity(event: Pick<KeyboardEvent, 'code' | 'key'>): string {
  return event.code || event.key
}

export const keyRepeatFeature = defineRegister((controller) => {
  const pressed = new Set<string>()

  controller.listen('keydown', (event) => {
    if (!event.isTrusted)
      return
    const id = keyIdentity(event)
    if (event.repeat && !pressed.has(id))
      Object.defineProperty(event, 'repeat', { value: false, configurable: true })
    pressed.add(id)
  }, { capture: true })

  controller.listen('keyup', (event) => {
    pressed.delete(keyIdentity(event))
  }, { capture: true })

  controller.listenWindow('blur', () => {
    pressed.clear()
  })
})
