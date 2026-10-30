import type { PropsStore, StoreHandle } from '@deepseek-ai/dsh-client-store'
import type { ClientContext, SlotRegistry } from 'dsh-tauri/client'
import { SlotOutlet } from '@deepseek-ai/dsh-client-ui-renderer'
import { defineRegister, detectMobileDevice, useWatchImmediate } from 'dsh-tauri/client'
import {
  SETTINGS_LAUNCHER_SLOT,
  SETTINGS_REGISTRANT,
  SETTINGS_SHELL_OVERLAY_SLOT,
  SETTINGS_SIDEBAR_ID,
  SETTINGS_SIDEBAR_SLOT,
  SETTINGS_TRIGGER_PRIORITY,
} from '../constants'
import { store } from '../store'
import { SettingsSidebar } from '../ui/settings-sidebar'
import { SettingsTrigger } from '../ui/settings-trigger'

const SETTINGS_SHORTCUT_EFFECT = 'dsh-tauri-ui: settings launcher shortcut'
const SETTINGS_OPEN_RELAY_ID = 'dsh-tauri-ui-settings-open-relay'

type SettingsShell = StoreHandle<{ open: boolean, activeId?: string }, {
  open: (draft: { open: boolean }) => void
  close: (draft: { open: boolean }) => void
}>

export const registerSettings = defineRegister<ClientContext>((controller, ctx, adapter) => {
  if (typeof SlotOutlet !== 'function') {
    console.warn(
      '[dsh-tauri-ui] <SlotOutlet> unavailable (renderer patch missing) — settings sidebar disabled, official dialog stays.',
    )
    return
  }

  if (detectMobileDevice())
    return

  controller.add(
    ctx.slots.inject(SETTINGS_SHELL_OVERLAY_SLOT, () => {
      const disposeSidebar = ctx.slots.register(
        { name: SETTINGS_SHELL_OVERLAY_SLOT, id: SETTINGS_SIDEBAR_ID, registrant: SETTINGS_REGISTRANT, inject: () => ({}) } as never,
        SettingsSidebar as never,
      )
      const disposeRelay = registerSettingsOpenRelay(adapter.service<SlotRegistry>('slots'))
      return () => {
        disposeRelay()
        disposeSidebar()
      }
    }),
  )
  controller.add(
    ctx.slots.inject(SETTINGS_SIDEBAR_SLOT as never, () =>
      ctx.slots.register(
        { name: SETTINGS_SIDEBAR_SLOT, priority: SETTINGS_TRIGGER_PRIORITY, registrant: SETTINGS_REGISTRANT } as never,
        SettingsTrigger,
      )),
  )
  controller.add(
    ctx.slots.inject(SETTINGS_LAUNCHER_SLOT, () => {
      store.settings.setLauncherAvailable(true)
      return () => store.settings.setLauncherAvailable(false)
    }),
  )
  controller.add(ctx.effect(() => publishLauncherShortcut(adapter.service<ShortcutsLike>('shortcuts')), SETTINGS_SHORTCUT_EFFECT))
})

function registerSettingsOpenRelay(slots?: SlotRegistry): () => void {
  if (typeof slots?.entries !== 'function' || typeof slots.subscribe !== 'function')
    return () => {}

  let handle: SettingsShell | undefined
  let disposeSeat: (() => void) | undefined
  function refresh(): void {
    const next = slots!.entries(SETTINGS_SIDEBAR_SLOT as never).find(entry =>
      entry.registrant !== SETTINGS_REGISTRANT
      && typeof entry.store === 'object' && entry.store !== null
      && typeof entry.store.create === 'function'
      && typeof entry.store.spec?.actions?.open === 'function'
      && typeof entry.store.spec?.actions?.close === 'function',
    )?.store as SettingsShell | undefined
    if (next === handle)
      return
    disposeSeat?.()
    handle = next
    disposeSeat = next
      ? slots!.register(
          { name: SETTINGS_SHELL_OVERLAY_SLOT, id: SETTINGS_OPEN_RELAY_ID, registrant: SETTINGS_REGISTRANT, store: next } as never,
          SettingsOpenRelay as never,
        )
      : undefined
  }
  refresh()
  const off = slots.subscribe(SETTINGS_SIDEBAR_SLOT as never, refresh)
  return () => {
    off()
    disposeSeat?.()
  }
}

function SettingsOpenRelay({ useStore, actions }: PropsStore<SettingsShell>): null {
  const state = useStore(state => state)
  useWatchImmediate([state.open, state.activeId], () => {
    if (state.open !== true)
      return
    store.settings.openAt(typeof state.activeId === 'string' ? state.activeId : undefined)
    actions.close()
  })
  return null
}

function publishLauncherShortcut(shortcuts?: ShortcutsLike): () => void {
  const catalog = shortcuts?.catalog
  const snapshot = catalog?.getSnapshot
  if (typeof snapshot !== 'function')
    return () => {}

  const publish = (): void => {
    store.settings.setLauncherShortcut(shortcutOf(snapshot.call(catalog)))
  }
  publish()
  const off = typeof catalog?.subscribe === 'function' ? catalog.subscribe(publish) : undefined
  return () => {
    off?.()
    store.settings.setLauncherShortcut(undefined)
  }
}

function shortcutOf(rows: unknown): { keys: readonly string[], aria?: string } | undefined {
  if (!Array.isArray(rows))
    return undefined
  for (const row of rows) {
    if (typeof row !== 'object' || row === null)
      continue
    const entry = row as { id?: unknown, keys?: unknown, aria?: unknown }
    if (entry.id !== 'settings.open')
      continue
    const keys = Array.isArray(entry.keys) ? entry.keys.filter((key): key is string => typeof key === 'string') : []
    if (keys.length === 0)
      return undefined
    return { keys, ...typeof entry.aria === 'string' ? { aria: entry.aria } : {} }
  }
  return undefined
}

interface ShortcutsLike {
  catalog?: {
    getSnapshot?: () => unknown
    subscribe?: (listener: () => void) => () => void
  }
}
