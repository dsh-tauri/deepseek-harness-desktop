import type { ClientContext, SlotRegistry, StoredEntry } from 'dsh-tauri/client'
import type { ComponentType } from 'react'
import { defineRegister, get } from 'dsh-tauri/client'
import { createElement } from 'react'
import { PLUGIN_ID } from '../../shared/constants'

const CONTINUE_NOTICE_SLOT = 'conversation.chat.node' as Parameters<SlotRegistry['inject']>[0]

export const registerContinueNotice = defineRegister<ClientContext>((controller, _ctx, adapter) => {
  const slots = adapter.service<SlotRegistry>('slots')
  if (!slots || typeof slots.inject !== 'function' || typeof slots.entries !== 'function'
    || typeof slots.entriesOfSlot !== 'function' || typeof slots.subscribe !== 'function'
    || typeof slots.spec !== 'function' || typeof slots.register !== 'function') {
    console.warn(`[${PLUGIN_ID}] continue 提示隐藏不可用：缺少会话节点槽能力`)
    return
  }

  controller.add(slots.inject(CONTINUE_NOTICE_SLOT, function* () {
    const spec: NonNullable<StoredEntry['children']>[string] | undefined = slots.spec(CONTINUE_NOTICE_SLOT)
    if (spec?.kind !== 'keyed' || spec.scope !== 'session') {
      console.warn(`[${PLUGIN_ID}] continue 提示隐藏不可用：会话节点槽契约不匹配`)
      return
    }
    for (const key of ['context', 'turn-trigger']) {
      let original: StoredEntry | undefined
      let wrapper: unknown
      let unregister: (() => void) | undefined
      const sync = () => {
        const next = slots.entries(CONTINUE_NOTICE_SLOT)
          .find(entry => entry.options.key === key && entry.component !== wrapper)
        if (next === original)
          return
        unregister?.()
        unregister = undefined
        original = next
        if (!next)
          return
        const priority = (next.options.priority ?? 0) - 1
        // ponytail: retired heads keep official fallback; track retirement if survivors need wrapping.
        if (slots.entriesOfSlot(CONTINUE_NOTICE_SLOT).find(entry => entry.options.key === key) !== next
          || Object.keys(next.children ?? {}).length > 0 || !Number.isFinite(priority)
          || priority >= (next.options.priority ?? 0) || next.component == null) {
          console.warn(`[${PLUGIN_ID}] continue 提示隐藏不可用：${key} 渲染器不支持安全包装`)
          return
        }
        const Original = next.component as ComponentType<Record<string, unknown>>
        const ContinueNotice = (props: Record<string, unknown>) => get(props, 'node.data.source.kind') === 'continue'
          ? createElement('span', { 'data-dsh-tauri-ui-continue-notice': '', 'hidden': true })
          : createElement(Original, props)
        wrapper = ContinueNotice
        unregister = slots.register({
          name: CONTINUE_NOTICE_SLOT,
          key,
          priority,
          registrant: PLUGIN_ID,
          locale: next.locale,
          inject: next.inject,
          store: next.store,
        } as never, ContinueNotice as never)
      }
      yield () => unregister?.()
      yield slots.subscribe(CONTINUE_NOTICE_SLOT, sync)
      sync()
    }
  }))
})
