// @vitest-environment jsdom
import type { Event } from '@tauri-apps/api/event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerAppearance } from './appearance'

const mocks = vi.hoisted(() => ({
  emit: vi.fn(() => Promise.resolve()),
  listeners: new Map<string, (event: { event: string, id: number, payload: unknown }) => void>(),
}))

vi.mock('../service/tauri', () => ({
  emit: mocks.emit,
  emitTo: vi.fn(() => Promise.resolve()),
  invoke: vi.fn(() => Promise.resolve()),
  isTauri: () => true,
  listen: (event: string, handler: (event: unknown) => void) => {
    mocks.listeners.set(event, handler as (event: { event: string, id: number, payload: unknown }) => void)
    return Promise.resolve(() => {
      mocks.listeners.delete(event)
    })
  },
}))

let dispose: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
  document.head.replaceChildren()
  mocks.listeners.clear()
  vi.clearAllMocks()
})

const FRAME_HTML = '<main style="grid-template-columns:280px minmax(400px, 1fr) minmax(0px, 350px)"><aside data-slot="sidebar"></aside><div data-shell-overlay></div></main>'

function makeCtx(frame: () => HTMLElement | null) {
  const theme = {
    getTheme: () => ({ active: { colorScheme: 'dark' as const } }),
    overrideTokens: vi.fn(() => vi.fn()),
  }
  const ctx = {
    get: (name: string) => name === 'theme' ? theme : undefined,
    layout: { toggleSidebar: vi.fn(() => frame()?.toggleAttribute('data-sidebar-collapsed')) },
    on: () => () => {},
  }
  return ctx
}

function send(appearance: unknown) {
  mocks.listeners.get('dsh://appearance')?.({ event: 'dsh://appearance', id: 1, payload: { appearance } } as Event<unknown>)
}

function setup() {
  document.body.innerHTML = FRAME_HTML
  const frame = document.querySelector<HTMLElement>('main')!
  const ctx = makeCtx(() => frame)
  dispose = registerAppearance.call(ctx as never)
  return { frame, ctx }
}

describe('terminal mode', () => {
  it('hides the sidebar when terminal mode turns on', () => {
    const { frame, ctx } = setup()
    send({ terminal: true })
    expect(ctx.layout.toggleSidebar).toHaveBeenCalledTimes(1)
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(true)
    expect(frame.style.getPropertyValue('--dsh-appearance-columns')).toBe('0px minmax(400px, 1fr) minmax(0px, 350px)')
  })

  it('restores the sidebar when terminal mode turns off', () => {
    const { frame, ctx } = setup()
    send({ terminal: true })
    send({ terminal: false })
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(false)
    expect(frame.style.getPropertyValue('--dsh-appearance-columns')).toBe('')
    expect(ctx.layout.toggleSidebar).toHaveBeenCalledTimes(2)
  })

  it('hides the sidebar when terminal mode is already on and the frame mounts later', async () => {
    document.body.innerHTML = '<div id="boot"></div>'
    let frame: HTMLElement | null = null
    const ctx = makeCtx(() => frame)
    dispose = registerAppearance.call(ctx as never)
    send({ terminal: true })
    expect(ctx.layout.toggleSidebar).not.toHaveBeenCalled()
    const main = document.createElement('main')
    main.setAttribute('style', 'grid-template-columns:280px minmax(400px, 1fr) minmax(0px, 350px)')
    main.innerHTML = '<aside data-slot="sidebar"></aside><div data-shell-overlay></div>'
    frame = main
    document.body.replaceChildren(main)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(ctx.layout.toggleSidebar).toHaveBeenCalledTimes(1)
    expect(main.hasAttribute('data-sidebar-collapsed')).toBe(true)
  })
})
