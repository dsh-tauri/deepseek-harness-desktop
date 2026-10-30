import { emit } from '../service/tauri'
import { defineRegister } from './index'

export const EVENT_SHORTCUTS = 'dsh://shortcuts'

export const CMD_SHORTCUTS_OPEN = 'dsh://shortcuts:open'

const CMD_VIEW_COMMAND = 'dsh://view:command'
const VIEW_COMMANDS = new Set(['sidebar.left.toggle', 'sidebar.right.toggle', 'terminal.new', 'session.search'])

export interface ShortcutRowReport {
  id: string
  label: string
  keys: readonly string[]
  aria?: string
  available: boolean
}

interface CatalogLike {
  getSnapshot?: () => unknown
  subscribe?: (listener: () => void) => () => void
}

interface ShortcutsLike {
  catalog?: CatalogLike
}

const ROW_MAX = 200

export const shortcutsFeature = defineRegister((controller, ctx) => {
  const service = ctx.get('shortcuts') as ShortcutsLike | undefined
  const catalog = service?.catalog
  const snapshot = catalog?.getSnapshot
  if (typeof snapshot !== 'function')
    return
  const readCatalog = snapshot.bind(catalog)

  function report(): void {
    void emit(EVENT_SHORTCUTS, { rows: project(readCatalog()) })
  }
  report()
  controller.add(() => void emit(EVENT_SHORTCUTS, { rows: [] }))
  if (typeof catalog?.subscribe === 'function')
    controller.add(catalog.subscribe(report))

  controller.listenEvent(CMD_SHORTCUTS_OPEN, () => dispatchShortcut(readCatalog(), 'shortcuts.open'))
  controller.listenEvent<{ command?: unknown }>(CMD_VIEW_COMMAND, ({ payload }) => {
    const command = payload?.command
    if (typeof command === 'string' && VIEW_COMMANDS.has(command))
      dispatchShortcut(readCatalog(), command)
  })
})

function project(rows: unknown): ShortcutRowReport[] {
  if (!Array.isArray(rows))
    return []
  const out: ShortcutRowReport[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null)
      continue
    const entry = row as { id?: unknown, label?: unknown, keys?: unknown, aria?: unknown }
    if (typeof entry.id !== 'string' || typeof entry.label !== 'string')
      continue
    const keys = Array.isArray(entry.keys) ? entry.keys.filter((key): key is string => typeof key === 'string') : []
    out.push({
      id: entry.id,
      label: entry.label,
      keys,
      ...typeof entry.aria === 'string' ? { aria: entry.aria } : {},
      available: bindingOf(rows, entry.id) !== undefined,
    })
    if (out.length >= ROW_MAX)
      break
  }
  return out
}

function dispatchShortcut(rows: unknown, id: string): void {
  if (typeof window === 'undefined' || typeof KeyboardEvent !== 'function')
    return
  const binding = bindingOf(rows, id)
  if (binding === undefined)
    return
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...binding,
  })
  window.dispatchEvent(event)
}

function bindingOf(rows: unknown, id: string): KeyboardEventInit | undefined {
  if (!Array.isArray(rows))
    return undefined
  for (const row of rows) {
    if (typeof row !== 'object' || row === null)
      continue
    const entry = row as { id?: unknown, binding?: unknown, conflicts?: unknown, issue?: unknown }
    if (entry.id !== id)
      continue
    if (entry.issue != null || (Array.isArray(entry.conflicts) && entry.conflicts.length > 0))
      return undefined
    const binding = entry.binding
    if (typeof binding !== 'object' || binding === null)
      return undefined
    const { code, modifiers, secondCode } = binding as { code?: unknown, modifiers?: unknown, secondCode?: unknown }
    if (typeof code !== 'string' || code.length === 0 || secondCode != null)
      return undefined
    const list = Array.isArray(modifiers) ? modifiers.filter((value): value is string => typeof value === 'string') : []
    return {
      code,
      ctrlKey: list.some(value => value === 'control' || value === 'ctrl'),
      metaKey: list.some(value => value === 'meta' || value === 'command' || value === 'cmd'),
      altKey: list.some(value => value === 'alt' || value === 'option'),
      shiftKey: list.includes('shift'),
    }
  }
  return undefined
}
