import type { SlotComponent } from '@deepseek-ai/dsh-client-ui-slots'
import type { ComponentType } from 'react'
import type { ClientContext } from '../types'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hidePanel } from './index'

function panelRegistry(): { core: SlotCore, ctx: ClientContext } {
  const core = new SlotCore()
  core.register({
    name: 'root',
    children: {
      'main': { kind: 'keyed', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
    },
  } as never, (() => null) as SlotComponent<never>)
  const ctx = {
    slots: {
      entriesOfSlot: (key: string) => core.entriesOfSlot(key),
      register: core.register.bind(core),
      inject: (_key: string, callback: () => () => void) => callback(),
    },
  } as unknown as ClientContext
  return { core, ctx }
}

afterEach(() => vi.restoreAllMocks())

describe('hidePanel', () => {
  it('shadows only the sidebar icon while preserving the official main entry', () => {
    const { core, ctx } = panelRegistry()
    const originalIcon = () => null
    const originalPage = () => null
    core.register({ name: 'sidebar.panellist', id: 'plugins', label: 'Plugins', order: 40 } as never, originalIcon)
    core.register({ name: 'main', key: 'plugins' }, originalPage)
    const main = core.entriesOfSlot('main')[0]

    const restore = hidePanel(ctx, 'plugins', 'dsh-tauri-extension')
    const winner = core.entriesOfSlot('sidebar.panellist')[0]
    expect(winner.options).toMatchObject({ id: 'plugins', label: 'Plugins', order: 40, priority: -1 })
    const markup = renderToStaticMarkup(createElement(winner.component as ComponentType))
    expect(markup).toContain('data-dsh-hidden-panel="plugins"')
    expect(markup).toContain('data-plugin="dsh-tauri-extension"')
    expect(markup).toContain('button:has([data-dsh-hidden-panel]) { display: none !important; }')
    expect(core.entriesOfSlot('main')[0]).toBe(main)
    expect(core.entries('sidebar.panellist')).toHaveLength(2)

    restore()
    restore()
    expect(core.entriesOfSlot('sidebar.panellist')[0].component).toBe(originalIcon)
    expect(core.entries('sidebar.panellist')).toHaveLength(1)
    expect(core.entriesOfSlot('main')[0].component).toBe(originalPage)
  })

  it('hides a sidebar icon that registers after its main page', () => {
    const { core, ctx } = panelRegistry()
    const restore = hidePanel(ctx, 'plugins', 'dsh-tauri-extension')
    const hidden = core.entriesOfSlot('sidebar.panellist')[0]
    const originalIcon = () => null
    core.register({ name: 'sidebar.panellist', id: 'plugins', order: 40 } as never, originalIcon)
    expect(core.entriesOfSlot('sidebar.panellist')[0]).toBe(hidden)
    restore()
    expect(core.entriesOfSlot('sidebar.panellist')[0].component).toBe(originalIcon)
  })
})
