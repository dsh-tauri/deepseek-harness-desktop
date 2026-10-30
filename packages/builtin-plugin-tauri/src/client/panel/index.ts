import type { ComponentType, ReactElement } from 'react'
import type { ClientContext, Translate } from '../types'
import { createElement } from 'react'

const PANEL_LIST_SLOT = 'sidebar.panellist'
const PANEL_MAIN_SLOT = 'main'

export interface PanelIconProps {
  size: number
  active: boolean
}

export interface PanelEntry {
  id: string
  render: ComponentType<{ t?: Translate }>
  label: string | (() => string)
  icon: (props: PanelIconProps) => ReactElement
  order?: number
  locale?: string
}

export interface PanelHandle {
  select: () => void
  close: () => void
  dispose: () => void
}

export function hidePanel(ctx: ClientContext, id: string, registrant: string): () => void {
  return ctx.slots.inject(PANEL_LIST_SLOT as never, () => {
    const entry = ctx.slots.entriesOfSlot(PANEL_LIST_SLOT as never).find(entry => entry.options.id === id)
    return ctx.slots.register({
      ...entry?.options,
      name: PANEL_LIST_SLOT,
      id,
      priority: (entry?.options.priority ?? 0) - 1,
      registrant,
    } as never, () => createElement(
      'span',
      { 'data-dsh-hidden-panel': id },
      createElement('style', { 'data-plugin': registrant }, 'button:has([data-dsh-hidden-panel]) { display: none !important; }'),
    ))
  })
}

export function definePanel(ctx: ClientContext, entry: PanelEntry): PanelHandle {
  const { id } = entry
  const disposers: Array<() => void> = [
    ctx.slots.inject(PANEL_LIST_SLOT as never, () => ctx.slots.register(
      {
        name: PANEL_LIST_SLOT,
        id,
        order: entry.order ?? 0,
        label: entry.label,
        registrant: id,
      } as never,
      (props: PanelIconProps) => entry.icon(props),
    )),
    ctx.slots.inject(PANEL_MAIN_SLOT as never, () => ctx.slots.register(
      {
        name: PANEL_MAIN_SLOT,
        key: id,
        ...(entry.locale === undefined ? {} : { locale: entry.locale }),
        registrant: id,
      } as never,
      entry.render as never,
    )),
  ]

  let disposed = false
  return {
    select: () => {
      const occupants = ctx.slots.entriesOfSlot(PANEL_MAIN_SLOT)
      if (!occupants.some(occupant => occupant.options.key === id)) {
        console.error(`dsh-tauri/client: panel "${id}" has no main-slot registration; select() ignored`)
        return
      }
      ctx.layout.selectPanel(id as never)
    },
    close: () => ctx.layout.selectPanel(null),
    dispose: () => {
      if (disposed)
        return
      disposed = true
      for (const dispose of disposers)
        dispose()
    },
  }
}
