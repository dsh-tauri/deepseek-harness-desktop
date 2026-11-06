import type { ComponentType, ReactElement } from 'react'
import type { ClientContext, Translate } from '../types'

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
