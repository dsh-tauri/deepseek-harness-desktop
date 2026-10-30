import type { ClientContext, LocaleService, PanelHandle, SlotRegistry } from 'dsh-tauri/client'
import type { ReactElement } from 'react'
import { Icon, IconSparkleRegular, mountStyle, Panel, Puzzle, SlotOutlet } from 'dsh-tauri-ui/client'
import { definePanel, defineRegister, hidePanel } from 'dsh-tauri/client'
import { useSyncExternalStore } from 'react'
import { ExtensionPanel } from '../components/extension-panel'
import { PANEL_ACTION_ORDER, PANEL_ID, PLUGINS_MORE_HEADER_SELECTOR } from '../constants'
import { locale } from '../locales'
import { store } from '../store'
import { pluginsStyle } from '../styles/plugins.cssr'
import { chooseWorkspace, sessionSnapshotOf, workspaceSnapshotOf } from './extension-panel.utils'

export const extensionPanelFeature = defineRegister<ClientContext>((controller, ctx, adapter) => {
  let panel: PanelHandle | undefined
  const slots = adapter.service<SlotRegistry>('slots')
  let restorePlugins: (() => void) | undefined

  function hasPlugins(): boolean {
    return typeof SlotOutlet === 'function'
      && typeof slots?.subscribe === 'function'
      && typeof slots?.entriesOfSlot === 'function'
      && slots.entriesOfSlot('main').some(entry => entry.options.key === 'plugins')
  }

  function subscribePlugins(listener: () => void): () => void {
    if (typeof slots?.subscribe !== 'function')
      return () => {}
    return slots.subscribe('main', listener)
  }

  function syncPlugins(): void {
    if (hasPlugins()) {
      restorePlugins ??= hidePanel(ctx, 'plugins', PANEL_ID)
    }
    else {
      restorePlugins?.()
      restorePlugins = undefined
    }
  }

  const backButtons = new Map<HTMLButtonElement, { label: HTMLSpanElement, original: string | null, applied: string }>()
  function syncBackButtons(buttons: Iterable<HTMLButtonElement>): void {
    const current = new Set(buttons)
    for (const [button, entry] of backButtons) {
      if (current.has(button))
        continue
      entry.label.remove()
      button.removeAttribute('data-dsh-plugins-back')
      if (button.getAttribute('aria-label') === entry.applied) {
        if (entry.original === null)
          button.removeAttribute('aria-label')
        else
          button.setAttribute('aria-label', entry.original)
      }
      backButtons.delete(button)
    }
    const text = locale.text('pluginsBack')
    for (const button of current) {
      let entry = backButtons.get(button)
      if (entry === undefined) {
        const label = document.createElement('span')
        entry = { label, original: button.getAttribute('aria-label'), applied: text }
        backButtons.set(button, entry)
      }
      else if (button.getAttribute('aria-label') !== entry.applied) {
        entry.original = button.getAttribute('aria-label')
      }
      if (entry.label.textContent !== text)
        entry.label.textContent = text
      if (entry.label.parentElement !== button)
        button.append(entry.label)
      if (!button.hasAttribute('data-dsh-plugins-back'))
        button.setAttribute('data-dsh-plugins-back', '')
      entry.applied = text
      if (button.getAttribute('aria-label') !== text)
        button.setAttribute('aria-label', text)
    }
  }
  const syncBack = (): void => syncBackButtons(document.querySelectorAll<HTMLButtonElement>(`${PLUGINS_MORE_HEADER_SELECTOR} > button:first-child`))
  controller.add(mountStyle(pluginsStyle, `${PANEL_ID}-plugins`, PANEL_ID))
  controller.observe(document.body, syncBack, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label'] })
  const localeService = adapter.service<LocaleService>('locale')
  if (typeof localeService?.subscribe === 'function')
    controller.add(localeService.subscribe(syncBack))
  controller.add(() => syncBackButtons([]))
  syncBack()
  if (typeof slots?.subscribe === 'function')
    controller.add(subscribePlugins(syncPlugins))
  syncPlugins()
  controller.add(() => restorePlugins?.())

  async function createSkill(): Promise<void> {
    const id = chooseWorkspace(
      sessionSnapshotOf(adapter.sessions.list?.getSnapshot()),
      workspaceSnapshotOf(adapter.workspaces.list?.getSnapshot()),
    )
    if (id === undefined)
      throw new Error(locale.text('workspaceUnavailable'))
    const sessionId = await adapter.workspaces.connectWorkspace?.(id)
    if (typeof sessionId !== 'string' || sessionId === '')
      throw new Error(locale.text('workspaceUnavailable'))
    store.prefill.add(sessionId)
    panel?.close()
    adapter.sessions.open?.(sessionId)
  }

  panel = definePanel(ctx, {
    id: PANEL_ID,
    order: PANEL_ACTION_ORDER,
    locale: locale.NS,
    label: () => locale.text('extension'),
    icon: props => <Icon as={Puzzle} size={props.size} />,
    render: function ExtensionPage() {
      const available = useSyncExternalStore(subscribePlugins, hasPlugins, hasPlugins)
      let plugins: ReactElement | undefined
      if (available && typeof SlotOutlet === 'function') {
        plugins = (
          <div data-dsh-extension-plugins>
            <span data-dsh-plugins-icon aria-hidden="true"><IconSparkleRegular size={16} /></span>
            <SlotOutlet slotKey="main" opts={{ entryKey: 'plugins' }} />
          </div>
        )
      }
      return (
        <Panel>
          <ExtensionPanel plugins={plugins} createSkill={createSkill} />
        </Panel>
      )
    },
  })
  controller.add(panel.dispose)
})
