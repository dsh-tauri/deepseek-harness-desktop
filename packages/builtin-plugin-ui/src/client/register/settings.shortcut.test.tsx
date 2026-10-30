// @vitest-environment jsdom
import type { ActionsDecl, PropsStore, StoreHandle, StoreInstance } from '@deepseek-ai/dsh-client-store'
import type { ComponentType } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { store } from '../store'
import { registerSettings } from './settings'

const modal = vi.hoisted(() => ({ available: true, useModalLayer: vi.fn(), mount: vi.fn() }))

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const { useLayoutEffect } = await import('react')
  function useModalLayer(dialog: { current: HTMLElement | null }, open: boolean, onClose: () => void): void {
    modal.useModalLayer(dialog, open, onClose)
    useLayoutEffect(() => {
      modal.mount(dialog.current, open)
    }, [dialog, open])
  }
  return {
    get useModalLayer() {
      return modal.available ? useModalLayer : undefined
    },
  }
})

vi.mock('dsh-tauri/client', async () => ({
  ...await import('../../../../builtin-plugin-tauri/src/client/register'),
  ...await import('../../../../builtin-plugin-tauri/src/client/modules/valtio-define'),
  ...await import('../../../../builtin-plugin-tauri/src/client/modules/reause'),
  ...await import('../../../../builtin-plugin-tauri/src/client/utils/device'),
  ...await import('../../../../builtin-plugin-tauri/src/client/modules/lodash-es'),
  ...await import('../../../../builtin-plugin-tauri/src/client/modules/tailwind-variants'),
}))
vi.mock('@deepseek-ai/dsh-client-ui-renderer', () => ({
  SlotOutlet: ({ opts }: { opts: { only: string } }) => <div data-testid="settings-section">{opts.only}</div>,
}))
vi.mock('../locales', () => ({ locale: { useLocale: () => {}, text: (key: string) => key } }))
vi.mock('../ui/settings-trigger', () => ({ SettingsTrigger: () => null }))
vi.mock('../components/icon', () => ({ Icon: () => null }))
vi.mock('../components/official', async () => {
  const { createElement } = await import('react')
  return { Input: (props: import('react').ComponentProps<'input'>) => createElement('input', props) }
})

interface ShellState {
  open: boolean
  activeId: string | undefined
}

interface ShellActions extends ActionsDecl<ShellState> {
  open: (draft: ShellState) => void
  close: (draft: ShellState) => void
  select: (draft: ShellState, id: string) => void
  openSection: (draft: ShellState, id: string) => void
}

type ShellHandle = StoreHandle<ShellState, ShellActions>
type ShellInstance = StoreInstance<ShellState, ShellActions>

interface Registration {
  options: { name: string, id?: string, priority?: number, registrant?: string, store?: ShellHandle }
  component: ComponentType<PropsStore<ShellHandle>>
}

const disposers: Array<() => void> = []

beforeEach(() => {
  modal.available = true
  vi.clearAllMocks()
  store.settings.close()
  store.settings.setLauncherAvailable(false)
  store.settings.setLauncherShortcut(undefined)
  store.sections.setRows([
    { id: 'general', label: 'General', order: 0 },
    { id: 'models', label: 'Models', order: 1 },
  ])
})

afterEach(() => {
  cleanup()
  for (const dispose of disposers.splice(0))
    dispose()
  store.settings.close()
  store.settings.setLauncherAvailable(false)
  store.settings.setLauncherShortcut(undefined)
  store.sections.setRows([])
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function createOfficialShell() {
  let snapshot: ShellState = { open: false, activeId: undefined }
  const listeners = new Set<() => void>()
  function update(next: ShellState): void {
    snapshot = next
    listeners.forEach(listener => listener())
  }
  const instance: ShellInstance = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    clearPersisted() {},
    actions: {
      open: () => update({ ...snapshot, open: true }),
      close: () => update({ open: false, activeId: undefined }),
      select: id => update({ ...snapshot, activeId: id }),
      openSection: id => update({ open: true, activeId: id }),
    },
  }
  const handle: ShellHandle = {
    spec: {
      init: () => ({ open: false, activeId: undefined }),
      actions: {
        open(draft) { draft.open = true },
        close(draft) {
          draft.open = false
          draft.activeId = undefined
        },
        select(draft, id) { draft.activeId = id },
        openSection(draft, id) {
          draft.open = true
          draft.activeId = id
        },
      },
    },
    create: vi.fn(() => instance),
  }
  return { handle, instance, listeners, openCommand: () => instance.actions.open() }
}

function activate(owner?: unknown) {
  const registrations: Registration[] = []
  const ledgerListeners = new Set<() => void>()
  const renderListeners = new Set<() => void>()
  const instances = new Map<ShellHandle, ShellInstance>()
  let entries = owner ? [{ store: owner, registrant: '@deepseek-ai/dsh-client-ui-settings-general' }] : []
  let revision = 0
  function notifyRender(): void {
    revision++
    renderListeners.forEach(listener => listener())
  }
  const registerCommand = vi.fn(() => {
    throw new Error('Duplicate shortcut command: settings.open')
  })
  const slots = {
    inject(_key: string, callback: () => () => void) {
      return callback()
    },
    register(options: Registration['options'], component: Registration['component']) {
      const entry = { options, component }
      registrations.push(entry)
      notifyRender()
      return () => {
        registrations.splice(registrations.indexOf(entry), 1)
        notifyRender()
      }
    },
    entries: () => entries,
    subscribe(_key: string, listener: () => void) {
      ledgerListeners.add(listener)
      return () => ledgerListeners.delete(listener)
    },
  }
  const ctx = {
    slots,
    get(name: string) {
      if (name === 'slots')
        return slots
      if (name === 'shortcuts')
        return { register: registerCommand, catalog: { getSnapshot: () => [{ id: 'settings.open', keys: ['Ctrl+,'] }] } }
    },
    effect: (callback: () => () => void) => callback(),
  }
  const dispose = registerSettings.call(ctx)
  disposers.push(dispose)

  function BoundEntry({ entry }: { entry: Registration }) {
    const { component: Component, options } = entry
    if (!options.store)
      return <Component {...{} as PropsStore<ShellHandle>} />
    let instance = instances.get(options.store)
    if (!instance) {
      instance = options.store.create()
      instances.set(options.store, instance)
    }
    const source = instance
    function useStore<T>(selector: (state: ShellState) => T): T {
      return selector(useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot))
    }
    return <Component useStore={useStore} actions={source.actions} />
  }

  function Overlays() {
    useSyncExternalStore(
      (listener) => {
        renderListeners.add(listener)
        return () => renderListeners.delete(listener)
      },
      () => revision,
      () => revision,
    )
    return registrations.filter(entry => entry.options.name === 'shell.overlay').map(entry => (
      <BoundEntry key={entry.options.id} entry={entry} />
    ))
  }

  function setOwner(next?: unknown): void {
    entries = next ? [{ store: next, registrant: '@deepseek-ai/dsh-client-ui-settings-general' }] : []
    ledgerListeners.forEach(listener => listener())
  }

  return { Overlays, registrations, ledgerListeners, setOwner, dispose, registerCommand }
}

describe('patched settings shortcut store route', () => {
  it('opens the replacement from the existing command and resets the hidden shell for reopening', () => {
    const owner = createOfficialShell()
    const host = activate(owner.handle)
    render(<host.Overlays />)
    expect(screen.queryByRole('dialog')).toBeNull()

    act(owner.openCommand)

    expect(screen.getByRole('dialog').dataset.slotSidebar).toBe('dsh-tauri-ui')
    expect(owner.instance.getSnapshot().open).toBe(false)
    expect(host.registerCommand).not.toHaveBeenCalled()
    expect(host.registrations.filter(entry => entry.options.store === owner.handle)).toHaveLength(1)
    expect(owner.handle.create).toHaveBeenCalledTimes(1)

    act(() => store.settings.close())
    expect(screen.queryByRole('dialog')).toBeNull()
    act(owner.openCommand)
    expect(screen.getByRole('dialog').dataset.slotSidebar).toBe('dsh-tauri-ui')
    expect(owner.instance.getSnapshot().open).toBe(false)
  })

  it('preserves an official section request and existing menu/deep-link state', () => {
    const owner = createOfficialShell()
    const host = activate(owner.handle)
    render(<host.Overlays />)
    act(() => owner.instance.actions.openSection('models'))

    expect(screen.getByTestId('settings-section').textContent).toBe('models')
    expect(owner.instance.getSnapshot()).toEqual({ open: false, activeId: undefined })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Models' } })
    expect(store.settings.query).toBe('Models')

    act(() => store.settings.close())
    act(() => store.settings.openAt('general'))
    expect(screen.getByTestId('settings-section').textContent).toBe('general')
    expect(store.settings.query).toBe('')
  })

  it('tracks late owners, avoids duplicate seats, and disconnects replaced owners and unloads', () => {
    const first = createOfficialShell()
    const second = createOfficialShell()
    const host = activate()
    const view = render(<host.Overlays />)

    act(() => host.setOwner(first.handle))
    act(first.openCommand)
    expect(screen.getByRole('dialog').dataset.slotSidebar).toBe('dsh-tauri-ui')
    act(() => store.settings.close())

    act(() => host.setOwner(first.handle))
    expect(first.handle.create).toHaveBeenCalledTimes(1)
    act(() => host.setOwner(second.handle))
    act(first.openCommand)
    expect(screen.queryByRole('dialog')).toBeNull()
    act(second.openCommand)
    expect(screen.getByRole('dialog').dataset.slotSidebar).toBe('dsh-tauri-ui')

    act(() => host.setOwner())
    act(() => store.settings.close())
    act(second.openCommand)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(host.registrations.some(entry => entry.options.store)).toBe(false)

    view.unmount()
    host.dispose()
    host.dispose()
    expect(host.ledgerListeners.size).toBe(0)
    expect(first.listeners.size).toBe(0)
    expect(second.listeners.size).toBe(0)
    expect(host.registrations).toEqual([])
    expect(store.settings.launcherShortcut).toBeUndefined()
    expect(host.registerCommand).not.toHaveBeenCalled()
  })

  it('ignores incompatible owner stores without creating a relay seat', () => {
    const host = activate()
    render(<host.Overlays />)
    const owner = createOfficialShell()
    for (const candidate of [null, {}, () => owner.handle, { create: owner.handle.create, spec: { actions: {} } }]) {
      act(() => host.setOwner(candidate))
      expect(host.registrations.some(entry => entry.options.store)).toBe(false)
    }
    expect(owner.handle.create).not.toHaveBeenCalled()
    act(() => store.settings.openAt('models'))
    expect(screen.getByTestId('settings-section').textContent).toBe('models')
  })

  it('gives the official modal layer the mounted settings dialog and close callback', () => {
    const host = activate()
    render(<host.Overlays />)
    act(() => store.settings.openAt())
    const dialog = screen.getByRole('dialog')

    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.dataset.shortcutModal).toBe('settings')
    expect(modal.mount).toHaveBeenLastCalledWith(dialog, true)
    const [ref, open, close] = modal.useModalLayer.mock.lastCall!
    expect(ref.current).toBe(dialog)
    expect(open).toBe(true)
    act(close)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('does not race the official modal layer with an independent Escape handler', () => {
    const host = activate()
    render(<host.Overlays />)
    act(() => store.settings.openAt())
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', code: 'Escape' })
    expect(store.settings.open).toBe(true)
  })

  it('keeps Escape closing functional when the core has no modal layer hook', () => {
    modal.available = false
    const host = activate()
    render(<host.Overlays />)
    act(() => store.settings.openAt())
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', code: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(modal.useModalLayer).not.toHaveBeenCalled()
  })

  it('mirrors the conversation content width recorded before opening', () => {
    const dock = document.createElement('div')
    dock.dataset.slot = 'conversation.input.dock'
    dock.style.setProperty('--dsh-chat-content-width', '912px')
    document.body.append(dock)
    disposers.push(() => dock.remove())
    const host = activate()
    render(<host.Overlays />)

    act(() => store.settings.openAt('general'))

    expect(screen.getByRole('dialog').style.getPropertyValue('--dsh-chat-content-width')).toBe('912px')
  })
})
