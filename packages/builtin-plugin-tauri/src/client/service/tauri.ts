import type { EventCallback, EventName, Options } from '@tauri-apps/api/event'
import { noop } from '@reause/core'
import { isTauri } from '@tauri-apps/api/core'
import { emitTo, emit as tauriEmit, listen as tauriListen, once as tauriOnce } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'

export { invoke, isTauri } from '@tauri-apps/api/core'
export type { InvokeArgs, InvokeOptions } from '@tauri-apps/api/core'
export { emitTo } from '@tauri-apps/api/event'
export type { EventCallback, EventName, EventTarget, Options, Event as TauriEvent, UnlistenFn } from '@tauri-apps/api/event'
export { getCurrentWindow } from '@tauri-apps/api/window'

export function isNativeNotificationAvailable(): boolean {
  return (globalThis as { __DSH_NOTIFICATIONS_AVAILABLE__?: boolean }).__DSH_NOTIFICATIONS_AVAILABLE__ === true
}

function eventOptions(event: EventName, options?: Options): Options | undefined {
  return event.startsWith('dsh://') && options?.target === undefined
    ? { ...options, target: { kind: 'Window', label: getCurrentWindow().label } }
    : options
}

export function emit<T>(event: EventName, payload?: T): Promise<void> {
  if (!isTauri())
    return Promise.resolve()
  return event.startsWith('dsh://')
    ? emitTo({ kind: 'Window', label: getCurrentWindow().label }, event, payload)
    : tauriEmit(event, payload)
}

export function listen<T>(event: EventName, handler: EventCallback<T>, options?: Options) {
  if (!isTauri())
    return Promise.resolve(noop)
  return tauriListen(event, handler, eventOptions(event, options))
}

export function once<T>(event: EventName, handler: EventCallback<T>, options?: Options) {
  if (!isTauri())
    return Promise.resolve(noop)
  return tauriOnce(event, handler, eventOptions(event, options))
}
