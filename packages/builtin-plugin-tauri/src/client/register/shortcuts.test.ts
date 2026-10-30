import type { ClientContext } from '../types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchEvent, emitted, listenerCount, resetTauriMock } from '../test-utils/tauri-mock'
import { CMD_SHORTCUTS_OPEN, EVENT_SHORTCUTS, shortcutsFeature } from './shortcuts'

vi.mock('../service/tauri', async () => (await import('../test-utils/tauri-mock')).tauriMock)

const dispatchers = new Set<(event: KeyboardEvent) => void>()

const CMD_VIEW_COMMAND = 'dsh://view:command'

function stubEnv() {
  dispatchers.clear()
  vi.stubGlobal('window', {
    addEventListener: (type: string, handler: (event: never) => void) => {
      if (type === 'keydown')
        dispatchers.add(handler as (event: KeyboardEvent) => void)
    },
    removeEventListener: (_type: string, handler: (event: never) => void) => {
      dispatchers.delete(handler as (event: KeyboardEvent) => void)
    },
    dispatchEvent: (event: KeyboardEvent) => {
      for (const handler of dispatchers)
        handler(event)
      return true
    },
  })
  vi.stubGlobal('document', { execCommand: vi.fn(() => true) })
  return {
    sent: emitted,
    listeners: listenerCount,
    dispatch(data: { type: string, command?: unknown }) {
      dispatchEvent(data.type, data.command === undefined ? undefined : { command: data.command })
    },
  }
}

const disposers: (() => void)[] = []

function fakeCtx(service: unknown): ClientContext {
  return { get: () => service } as unknown as ClientContext
}

function runFeature(ctx: ClientContext): () => void {
  const dispose = shortcutsFeature.call(ctx)
  disposers.push(dispose)
  return dispose
}

function catalogService(rows: unknown[], subscribe?: (listener: () => void) => () => void) {
  return { catalog: { getSnapshot: () => rows, ...subscribe === undefined ? {} : { subscribe } } }
}

afterEach(() => {
  for (const dispose of disposers.splice(0))
    dispose()
  resetTauriMock()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('shortcutsFeature', () => {
  it('projects the catalog to the shell and republishes on change', () => {
    const env = stubEnv()
    let notify = (): void => {}
    const ctx = fakeCtx(catalogService([
      { id: 'session.new', label: 'New chat', keys: ['Ctrl+N'], aria: 'Control+N', modified: false },
      { id: 'workspace.add', label: 'Open folder', keys: ['Ctrl+O'] },
      { id: 'sidebar.left.toggle', label: 'Toggle sidebar', keys: ['⌥', '⌘', 'B'], binding: { code: 'KeyB', modifiers: ['alt', 'meta'] }, issue: null, conflicts: [] },
      { id: 42, label: 'broken' },
      { id: 'no.label' },
    ], (listener) => {
      notify = listener
      return () => {}
    }))

    runFeature(ctx)

    expect(env.sent).toEqual([{
      event: EVENT_SHORTCUTS,
      payload: { rows: [
        { id: 'session.new', label: 'New chat', keys: ['Ctrl+N'], aria: 'Control+N', available: false },
        { id: 'workspace.add', label: 'Open folder', keys: ['Ctrl+O'], available: false },
        { id: 'sidebar.left.toggle', label: 'Toggle sidebar', keys: ['⌥', '⌘', 'B'], available: true },
      ] },
    }])
    expect(env.listeners()).toBe(2)

    notify()
    expect(env.sent).toHaveLength(2)
  })

  it('stays inert when the core has no shortcuts service', () => {
    const env = stubEnv()

    expect(() => runFeature(fakeCtx(undefined))).not.toThrow()
    expect(env.sent).toEqual([])
    expect(env.listeners()).toBe(0)
  })

  it('opens the official reference with the effective binding', () => {
    const env = stubEnv()
    class FakeKeyboardEvent {
      code: string
      ctrlKey: boolean
      metaKey: boolean
      altKey: boolean
      shiftKey: boolean
      constructor(_type: string, init: KeyboardEventInit = {}) {
        this.code = init.code ?? ''
        this.ctrlKey = Boolean(init.ctrlKey)
        this.metaKey = Boolean(init.metaKey)
        this.altKey = Boolean(init.altKey)
        this.shiftKey = Boolean(init.shiftKey)
      }
    }
    vi.stubGlobal('KeyboardEvent', FakeKeyboardEvent)
    let seen: FakeKeyboardEvent | undefined
    const handler = (event: FakeKeyboardEvent): void => {
      seen = event
    }
    dispatchers.add(handler as unknown as (event: KeyboardEvent) => void)

    runFeature(fakeCtx(catalogService([
      { id: 'shortcuts.open', label: 'Shortcuts', keys: ['Ctrl+/'], binding: { code: 'Slash', modifiers: ['control'] } },
    ])))
    env.dispatch({ type: CMD_SHORTCUTS_OPEN })

    expect(seen?.code).toBe('Slash')
    expect(seen?.ctrlKey).toBe(true)
    expect(seen?.metaKey).toBe(false)
    dispatchers.delete(handler as unknown as (event: KeyboardEvent) => void)
  })

  it.each(['sidebar.left.toggle', 'sidebar.right.toggle', 'terminal.new', 'session.search'])('invokes %s once with its current binding', (id) => {
    const env = stubEnv()
    class FakeKeyboardEvent {
      constructor(readonly type: string, readonly init: KeyboardEventInit) {}
    }
    vi.stubGlobal('KeyboardEvent', FakeKeyboardEvent)
    const received = vi.fn()
    dispatchers.add(received)
    const rows = [{ id, label: id, keys: ['⌘', 'T'], binding: { code: 'KeyT', modifiers: ['meta'] } }]
    runFeature(fakeCtx(catalogService(rows)))

    env.dispatch({ type: CMD_VIEW_COMMAND, command: id })
    expect(received).toHaveBeenCalledExactlyOnceWith(new FakeKeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      code: 'KeyT',
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      shiftKey: false,
    }))

    rows[0].binding = { code: 'KeyU', modifiers: ['control', 'shift'] }
    env.dispatch({ type: CMD_VIEW_COMMAND, command: id })
    expect(received).toHaveBeenCalledTimes(2)
    expect(received).toHaveBeenLastCalledWith(new FakeKeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      code: 'KeyU',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: true,
    }))
  })

  it.each([
    { binding: null },
    { binding: { code: 'KeyB', modifiers: ['meta'] }, conflicts: ['other.command'] },
    { binding: { code: 'KeyB', modifiers: ['meta'] }, issue: 'reserved' },
    { binding: { code: 'KeyB', secondCode: 'KeyC', modifiers: ['meta'] } },
  ])('disables unavailable bindings without dispatching a fallback: %j', (input) => {
    const env = stubEnv()
    vi.stubGlobal('KeyboardEvent', vi.fn())
    runFeature(fakeCtx(catalogService([
      { id: 'sidebar.left.toggle', label: 'Sidebar', keys: ['⌘', 'B'], ...input },
      { id: 'shortcuts.open', label: 'Shortcuts', keys: [], binding: null },
    ])))

    expect((env.sent[0].payload as { rows: unknown }).rows).toEqual([
      { id: 'sidebar.left.toggle', label: 'Sidebar', keys: ['⌘', 'B'], available: false },
      { id: 'shortcuts.open', label: 'Shortcuts', keys: [], available: false },
    ])
    env.dispatch({ type: CMD_VIEW_COMMAND, command: 'sidebar.left.toggle' })
    env.dispatch({ type: CMD_SHORTCUTS_OPEN })
    expect(KeyboardEvent).not.toHaveBeenCalled()
  })

  it('rejects commands outside the View whitelist', () => {
    const env = stubEnv()
    vi.stubGlobal('KeyboardEvent', vi.fn())
    runFeature(fakeCtx(catalogService([
      { id: 'session.archive', label: 'Archive', keys: ['⌘', 'A'], binding: { code: 'KeyA', modifiers: ['meta'] } },
    ])))
    env.dispatch({ type: CMD_VIEW_COMMAND, command: 'session.archive' })
    env.dispatch({ type: CMD_VIEW_COMMAND, command: 42 })
    expect(KeyboardEvent).not.toHaveBeenCalled()
  })

  it('clears the shell catalog when the bridge is disposed', async () => {
    const env = stubEnv()
    const dispose = runFeature(fakeCtx(catalogService([
      { id: 'terminal.new', label: 'Terminal', keys: ['Ctrl+`'], binding: { code: 'Backquote', modifiers: ['control'] } },
    ])))
    await Promise.resolve()
    dispose()
    await Promise.resolve()
    expect(env.sent).toEqual([
      { event: EVENT_SHORTCUTS, payload: { rows: [{ id: 'terminal.new', label: 'Terminal', keys: ['Ctrl+`'], available: true }] } },
      { event: EVENT_SHORTCUTS, payload: { rows: [] } },
    ])
    expect(env.listeners()).toBe(0)
  })
})
