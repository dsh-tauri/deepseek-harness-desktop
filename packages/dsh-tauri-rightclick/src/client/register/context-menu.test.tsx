// @vitest-environment jsdom
import type { Menu, MenuEntry } from 'dsh-tauri-ui/client'
import type { ClientAdapter, ClientContext, RegisterController, RegisterSetup } from 'dsh-tauri/client'
import type { ComponentProps } from 'react'
import { act, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { contextMenuFeature } from './context-menu'

const { menuProps } = vi.hoisted(() => ({ menuProps: vi.fn() }))

vi.mock('dsh-tauri/client', async () => {
  const lodash = await import('../../../../dsh-tauri/src/client/modules/lodash-es')
  const { defineLocale } = await import('../../../../dsh-tauri/src/client/locale')
  const { ofetch } = await import('../../../../dsh-tauri/src/client/request')
  const { invoke } = await import('../../../../dsh-tauri/src/client/service/invoke')
  return {
    ...await import('../../../../dsh-tauri/src/client/utils/device'),
    ...lodash,
    defineLocale,
    ofetch,
    invoke,
    defineRegister: (setup: RegisterSetup<ClientContext>) => function (this: ClientContext) {
      const disposers: Array<() => void> = []
      const controller = {
        add: (dispose: () => void) => disposers.push(dispose),
        listen: (type: string, listener: EventListener, options: AddEventListenerOptions) => {
          window.addEventListener(type, listener, options)
          disposers.push(() => window.removeEventListener(type, listener, options))
        },
      }
      const adapter = {
        sessions: { list: { getSnapshot: () => ({ current: null, ids: [], byId: {} }) } },
        workspaces: { list: { getSnapshot: () => ({ items: [] }) } },
      }
      setup(controller as unknown as RegisterController, this, adapter as unknown as ClientAdapter)
      return () => disposers.splice(0).reverse().forEach(dispose => dispose())
    },
  }
})
vi.mock('dsh-tauri-ui/client', async () => ({
  Menu: (props: ComponentProps<typeof Menu>) => {
    menuProps(props)
    if (!props.items)
      throw new Error('Context menu did not provide its entries')
    return <div role="menu">{props.items.map((entry: MenuEntry) => <div key={entry.id}>{'label' in entry ? entry.label : null}</div>)}</div>
  },
  Toast: () => null,
}))

const disposers: Array<() => void> = []

afterEach(() => {
  act(() => disposers.splice(0).reverse().forEach(dispose => dispose()))
  cleanup()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  menuProps.mockClear()
})

function setup(mobile: boolean, finePointer = false): void {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: mobile && !(finePointer && query === '(pointer: coarse)') }))
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 15)', clipboard: undefined })
  disposers.push(contextMenuFeature.call({}))
}

function contextmenu(target: Element): MouseEvent {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 40 })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

describe('mobile context menu', () => {
  it.each(['input', 'textarea', 'contenteditable'])('preserves native long-press paste for %s without a Clipboard API', (kind) => {
    setup(true)
    const editable = document.createElement(kind === 'contenteditable' ? 'div' : kind)
    if (kind === 'contenteditable') {
      editable.setAttribute('contenteditable', 'true')
      editable.innerHTML = '<span>caret</span>'
    }
    document.body.appendChild(editable)
    const bubble = vi.fn()
    window.addEventListener('contextmenu', bubble, { once: true })
    disposers.push(() => window.removeEventListener('contextmenu', bubble))
    const event = contextmenu(editable.firstElementChild ?? editable)
    expect(event.defaultPrevented).toBe(false)
    expect(bubble).toHaveBeenCalledOnce()
    expect(menuProps).not.toHaveBeenCalled()
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('keeps custom menus for mobile links without desktop shortcut hints', () => {
    setup(true)
    const link = document.createElement('a')
    link.href = 'https://example.com'
    link.textContent = 'example'
    document.body.appendChild(link)
    expect(contextmenu(link).defaultPrevented).toBe(true)
    expect(menuProps).toHaveBeenCalledOnce()
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('Refresh')
    expect(document.querySelector('[role="menu"]')?.textContent).not.toMatch(/Ctrl\+|⌘|⇧/)
  })

  it.each([{ mobile: false, finePointer: false }, { mobile: true, finePointer: true }])('keeps desktop editing menus with a mouse (%j)', ({ mobile, finePointer }) => {
    setup(mobile, finePointer)
    const editable = document.createElement('textarea')
    document.body.appendChild(editable)
    expect(contextmenu(editable).defaultPrevented).toBe(true)
    expect(menuProps).toHaveBeenCalledOnce()
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('Ctrl+Z')
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('Ctrl+V')
  })

  it('removes the capture handler on unload', () => {
    setup(false)
    act(() => disposers.splice(0).reverse().forEach(dispose => dispose()))
    const editable = document.createElement('textarea')
    document.body.appendChild(editable)
    expect(contextmenu(editable).defaultPrevented).toBe(false)
    expect(menuProps).not.toHaveBeenCalled()
  })
})
