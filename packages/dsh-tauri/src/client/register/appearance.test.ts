// @vitest-environment jsdom
import type { ClientContext } from '../types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerAppearance } from './appearance'

const disposers: Array<() => void> = []

afterEach(() => {
  disposers.splice(0).forEach(dispose => dispose())
  document.body.replaceChildren()
  document.head.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function setup() {
  document.body.innerHTML = '<main style="grid-template-columns:280px minmax(400px, 1fr) minmax(0px, 350px)"><aside data-slot="sidebar"></aside><div></div><aside></aside><div data-shell-overlay></div></main>'
  const frame = document.querySelector('main')!
  const listeners = new Set<() => void>()
  let scheme: 'dark' | 'light' = 'dark'
  const retract = vi.fn()
  const theme = {
    getTheme: () => ({ active: { colorScheme: scheme } }),
    overrideTokens: vi.fn((_source: string, _tokens: Record<string, unknown>) => retract),
  }
  const ctx = {
    get: (name: string) => name === 'theme' ? theme : undefined,
    layout: { toggleSidebar: vi.fn(() => frame.toggleAttribute('data-sidebar-collapsed')) },
    on: (_event: string, callback: () => void) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
  }
  const post = vi.fn()
  vi.stubGlobal('parent', { postMessage: post })
  disposers.push(registerAppearance.call(ctx as unknown as ClientContext))
  function send(appearance: unknown, source: MessageEventSource = window.parent) {
    window.dispatchEvent(new MessageEvent('message', { source, data: { type: 'dsh://appearance', appearance } }))
  }
  return { frame, ctx, theme, retract, post, send, listeners, setScheme(value: 'dark' | 'light') {
    scheme = value
    listeners.forEach(fn => fn())
  } }
}

describe('desktop appearance bridge', () => {
  it('requests initial settings once and leaves defaults and layout untouched', () => {
    const { post, send, ctx, theme } = setup()
    expect(post.mock.calls[0][0]).toMatchObject({ type: 'dsh://appearance:ready' })
    send({})
    expect(theme.overrideTokens).not.toHaveBeenCalled()
    expect(ctx.layout.toggleSidebar).not.toHaveBeenCalled()
    expect(document.querySelector('style')!.textContent).toBe('')
  })

  it('ignores messages from windows other than the desktop parent', () => {
    const { send, theme } = setup()
    send({ palette: 'nord' }, {} as MessageEventSource)
    expect(theme.overrideTokens).not.toHaveBeenCalled()
  })

  it('applies a palette once and retracts it on reset', () => {
    const { send, theme, retract } = setup()
    send({ palette: 'nord' })
    send({ palette: 'nord' })
    expect(theme.overrideTokens).toHaveBeenCalledTimes(1)
    expect(theme.overrideTokens.mock.calls[0]).toEqual(['dsh-tauri:appearance', expect.objectContaining({ '--dsw-alias-label-primary': { dark: '#eceff4', light: '#2e3440' } })])
    send({})
    expect(retract).toHaveBeenCalledOnce()
    expect(document.querySelector('style')!.textContent).toBe('')
  })

  it('puts alpha on the background only and follows light/dark changes', () => {
    const { send, theme, setScheme } = setup()
    send({ palette: 'nord', opacity: 70 })
    expect(document.querySelector('style')!.textContent).toContain('#2e3440 70%')
    expect(document.querySelector('style')!.textContent).not.toMatch(/(?:^|[;{])opacity:/)
    expect(theme.overrideTokens.mock.calls[0]).toEqual(['dsh-tauri:appearance', expect.objectContaining({ '--dsw-alias-bg-base': { dark: 'transparent', light: 'transparent' }, '--dsw-specific-menu': { dark: '#343c4a', light: '#e5e9f0' } })])
    setScheme('light')
    expect(document.querySelector('style')!.textContent).toContain('#eceff4 70%')
  })

  it('paints the translucent canvas once: a backdrop filter would composite the fill twice', () => {
    const { send } = setup()
    send({ palette: 'nord', transparency: true, opacity: 70, blur: true })
    const css = document.querySelector('style')!.textContent!
    expect(css).toContain('body{background:color-mix(in srgb,#2e3440 70%,transparent)!important}')
    expect(css).not.toContain('backdrop-filter')
    send({ transparency: false, opacity: 70, blur: true })
    expect(document.querySelector('style')!.textContent).toBe('')
  })

  it.each([false, true])('fills a still-mounted boot page like the shell bar when sidebarOnly=%s', (sidebarOnly) => {
    const { send } = setup()
    document.body.innerHTML = '<div id="root"><div data-dsh-boot><span>HARNESS</span><span>Loading plugins...</span></div></div>'
    const boot = document.querySelector('[data-dsh-boot]')!
    const markup = boot.outerHTML
    send({ palette: 'nord', transparency: true, opacity: 70, sidebarOnly })
    const css = document.querySelector('style')!.textContent!
    expect(css).toContain('body[data-ds-dark-theme] > #root > [data-dsh-boot]{background:color-mix(in srgb,#2e3440 70%,transparent)!important}')
    expect(css).toContain('body:not([data-ds-dark-theme]) > #root > [data-dsh-boot]{background:color-mix(in srgb,#eceff4 70%,transparent)!important}')
    expect(css).not.toContain('#root > [data-dsh-boot]{background:transparent')
    expect(boot.outerHTML).toBe(markup)
  })

  it('keeps the boot page opaque unless transparency is effective', () => {
    const { send } = setup()
    document.body.innerHTML = '<div id="root"><div data-dsh-boot></div></div>'
    send({ palette: 'nord', transparency: false, opacity: 70 })
    expect(document.querySelector('style')!.textContent).toBe('')
    send({ palette: 'nord', transparency: true, opacity: 100 })
    expect(document.querySelector('style')!.textContent).toBe('')
  })

  it('acknowledges each applied appearance only after its stylesheet and tokens are live', () => {
    const { send, post, theme } = setup()
    post.mockClear()
    send({ palette: 'nord', transparency: true, opacity: 70 })
    expect(post.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'dsh://appearance:applied' })
    expect(theme.overrideTokens.mock.invocationCallOrder[0]).toBeLessThan(post.mock.invocationCallOrder.at(-1)!)
    expect(document.querySelector('style')!.textContent).toContain('#2e3440 70%')
    send({ palette: 'nord', transparency: true, opacity: 70 })
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('keeps the canvas opaque when transparency is explicitly disabled', () => {
    const { send, theme } = setup()
    send({ transparency: false, opacity: 70 })
    expect(document.querySelector('style')!.textContent).toBe('')
    expect(theme.overrideTokens).not.toHaveBeenCalled()
  })

  it('keeps the pinned composer backing opaque in full-window transparency', () => {
    const { send, setScheme } = setup()
    send({ palette: 'nord', transparency: true, opacity: 70, sidebarOnly: false })
    expect(document.querySelector('style')!.textContent).toContain('body [data-composer-seat]{--dsw-alias-bg-base:#2e3440}')
    setScheme('light')
    expect(document.querySelector('style')!.textContent).toContain('body [data-composer-seat]{--dsw-alias-bg-base:#eceff4}')
    send({})
    expect(document.querySelector('style')!.textContent).toBe('')
  })

  it('hides the collapsed sidebar while retaining the live right-panel width and restores layout on reset', async () => {
    const { send, frame, ctx } = setup()
    send({ terminal: true })
    expect(document.querySelector('style')!.textContent).not.toMatch(/font-family|monospace/)
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(true)
    expect(frame.style.getPropertyValue('--dsh-appearance-columns')).toBe('0px minmax(400px, 1fr) minmax(0px, 350px)')
    frame.style.gridTemplateColumns = '56px minmax(0px, 1fr) minmax(0px, 480px)'
    await vi.waitFor(() => expect(frame.style.getPropertyValue('--dsh-appearance-columns')).toBe('0px minmax(0px, 1fr) minmax(0px, 480px)'))
    ctx.layout.toggleSidebar()
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(false)
    ctx.layout.toggleSidebar()
    send({})
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(false)
    expect(frame.style.getPropertyValue('--dsh-appearance-columns')).toBe('')
    expect(document.querySelector('style')!.textContent).toBe('')
  })

  it('removes styles, subscriptions and token overrides on unload', () => {
    const { send, theme, retract, listeners } = setup()
    send({ palette: 'forest', terminal: true })
    disposers.pop()!()
    expect(retract).toHaveBeenCalledOnce()
    expect(listeners.size).toBe(0)
    expect(document.querySelector('style')).toBeNull()
    send({ palette: 'amber' })
    expect(theme.overrideTokens).toHaveBeenCalledOnce()
  })

  it('releases terminal observers when disabled instead of retaining them until unload', () => {
    const observe = vi.spyOn(MutationObserver.prototype, 'observe')
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect')
    const { send } = setup()
    send({})
    expect(observe).not.toHaveBeenCalled()
    for (let i = 0; i < 20; i++) {
      send({ terminal: true })
      send({ terminal: false })
    }
    expect(observe).toHaveBeenCalledTimes(20)
    expect(disconnect).toHaveBeenCalledTimes(20)
    disposers.pop()!()
    expect(disconnect).toHaveBeenCalledTimes(20)
  })
})
