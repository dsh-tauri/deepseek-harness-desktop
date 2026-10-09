import type { PropsRuntime, SlotMap, SlotScope } from '@deepseek-ai/dsh-client-ui-slots'
import type { SlotRegistry, StoredEntry } from 'dsh-tauri/client'
import type { ComponentType } from 'react'
import { createElement, Fragment } from 'react'

export interface SlotDecorationOriginalProps {
  Original: ComponentType<Record<string, unknown>>
}

export type SlotDecorationOptions<K extends keyof SlotMap & string, I extends object> = {
  slot: K
  scope: SlotScope
  registrant: string
  accept?: (entry: StoredEntry) => boolean
  inject: () => I
  warn: (reason: string) => void
} & ({
  mode?: 'append'
  component: ComponentType<PropsRuntime<K> & I>
} | {
  mode: 'wrap'
  component: ComponentType<PropsRuntime<K> & I & SlotDecorationOriginalProps>
})

export function registerSlotDecoration<K extends keyof SlotMap & string, I extends object>(
  slots: SlotRegistry | undefined,
  options: SlotDecorationOptions<K, I>,
): () => void {
  if (typeof slots?.inject !== 'function' || typeof slots.spec !== 'function'
    || typeof slots.entries !== 'function' || typeof slots.entriesOfSlot !== 'function'
    || typeof slots.subscribe !== 'function' || typeof slots.register !== 'function'
    || typeof slots.onEntryError !== 'function') {
    options.warn('slot decoration unavailable; official registration APIs are missing')
    return () => {}
  }
  return slots.inject(options.slot, function* () {
    const spec = slots.spec(options.slot)
    if (spec?.kind !== 'single' || spec.scope !== options.scope) {
      options.warn('slot decoration unavailable; the official slot contract differs')
      return
    }
    let original: StoredEntry | undefined
    let wrapper: unknown
    let unregister: (() => void) | undefined
    let disposed = false

    function sync(): void {
      if (disposed)
        return
      const next = slots!.entries(options.slot).find(entry => entry.component !== wrapper)
      if (next === original)
        return
      unregister?.()
      unregister = undefined
      wrapper = undefined
      original = next
      if (next === undefined)
        return
      const priority = (next.options.priority ?? 0) - 1
      const component = next.component
      if (slots!.entriesOfSlot(options.slot)[0] !== next
        || Object.keys(next.children ?? {}).length > 0
        || !Number.isFinite(priority) || priority >= (next.options.priority ?? 0)
        || !(typeof component === 'function' || (typeof component === 'object' && component !== null && '$$typeof' in component))) {
        options.warn('slot decoration unavailable; the official renderer cannot be safely composed')
        return
      }
      if (options.accept !== undefined && !options.accept(next)) {
        options.warn('slot decoration unavailable; the official renderer capability is unverified')
        return
      }
      const source = next
      const Original = component as ComponentType<Record<string, unknown>>
      const Addition = options.component as ComponentType<Record<string, unknown>>
      function Decorated(props: Record<string, unknown>) {
        if (!slots!.entries(options.slot).includes(source))
          return null
        return options.mode === 'wrap'
          ? createElement(Addition, { ...props, Original })
          : createElement(Fragment, null, createElement(Original, props), createElement(Addition, props))
      }
      wrapper = Decorated
      const originalInject = next.inject as ((...args: unknown[]) => Record<string, unknown>) | undefined
      const register = slots!.register as unknown as (
        registration: Pick<StoredEntry, 'locale' | 'store'> & {
          name: K
          priority: number
          registrant: string
          inject: (...args: unknown[]) => Record<string, unknown>
        },
        renderer: ComponentType<Record<string, unknown>>,
      ) => () => void
      unregister = register.call(slots, {
        name: options.slot,
        priority,
        registrant: options.registrant,
        locale: next.locale,
        store: next.store,
        inject: (...args) => slots!.entries(options.slot).includes(source)
          ? { ...originalInject?.(...args), ...options.inject() }
          : {},
      }, Decorated)
    }

    yield () => {
      disposed = true
      unregister?.()
    }
    yield slots.subscribe(options.slot, sync)
    yield slots.onEntryError((key, entry, _error, info) => {
      if (!disposed && key === options.slot && info.abdicated
        && (entry === original || entry.component === wrapper)) {
        unregister?.()
        unregister = undefined
        wrapper = undefined
        options.warn('slot decoration disabled after renderer retirement; the official fallback is preserved')
      }
    })
    sync()
  })
}
