// @vitest-environment jsdom
import { createContext, runInContext } from 'node:vm'
import { expect, it } from 'vitest'
import script from '../src-tauri/src/desktop/frontend_preload.js.inc?raw'

const template = '<!doctype html><html lang="en"><head>\n<meta charset="utf-8"><script type="module" crossorigin src="./assets/app.js"></script>\n</head><body>\n<div id="root"></div>\n</body></html>'
const head = '<base href="./"><script>globalThis.order = ["loader"]; globalThis.__ModuleLoader__ = {};</script><script src="plugins/bootstrap/client.js?rev=1&amp;x=2"></script><script>globalThis["__DSH_BOOT__"] = {entries:[]}; order.push("graph");</script><script>globalThis.dshDesktop = {protocolVersion:1};</script>'
const ready = '<script>(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()</script>'
const live = template.replace('<head>', `<head>${head}`).replace('<body>', `<body>${ready}`)

function createHarness() {
  const document = new DOMParser().parseFromString(template, 'text/html')
  const messages: { type: string, id: string }[] = []
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const pending: HTMLScriptElement[] = []
  const parent = {
    postMessage(message: { type: string, id: string }, origin: string) {
      expect(origin).toBe('http://tauri.localhost')
      messages.push(message)
    },
  }
  const window = {
    parent,
    addEventListener(type: string, listener: (event: unknown) => void) {
      if (!listeners.has(type))
        listeners.set(type, new Set())
      listeners.get(type)!.add(listener)
    },
    removeEventListener(type: string, listener: (event: unknown) => void) {
      listeners.get(type)?.delete(listener)
    },
  }
  const VmContext = createContext({
    document,
    window,
    DOMParser,
    Node,
    URL,
    Promise,
    location: new URL('http://127.0.0.1:3081/?dshDesktop&_dshPreload=7'),
    preload: { id: '7', parentOrigin: 'http://tauri.localhost', template },
  })
  function fire(type: string, event: unknown) {
    for (const listener of [...(listeners.get(type) ?? [])])
      listener(event)
  }
  for (const target of [document.head, document.body]) {
    const insert = target.insertBefore.bind(target)
    target.insertBefore = function insertAndRun<T extends Node>(node: T, anchor: Node | null): T {
      const result = insert(node, anchor)
      if (node.nodeName === 'SCRIPT') {
        const element = node as unknown as HTMLScriptElement
        if (element.hasAttribute('src')) {
          pending.push(element)
        }
        else {
          try {
            runInContext(element.textContent ?? '', VmContext)
          }
          catch (error) {
            fire('error', { error })
          }
        }
      }
      return result
    }
  }
  runInContext(script, VmContext)
  function send(html = live, overrides: Record<string, unknown> = {}) {
    fire('message', {
      source: parent,
      origin: 'http://tauri.localhost',
      data: { source: 'dsh-desktop', type: 'dsh://frontend-preload:boot', id: '7', html },
      ...overrides,
    })
  }
  return { context: VmContext, document, messages, pending, send, fire }
}

it('keeps the real frontend gate closed until same-parent live injections and blocking scripts finish', async () => {
  const frame = createHarness()
  let resolved = false
  void frame.context.__DSH_BOOT_READY__.promise.then(() => {
    resolved = true
  })
  frame.fire('DOMContentLoaded', {})
  expect(frame.messages).toEqual([{ type: 'dsh://frontend-preload:waiting', id: '7', detail: undefined }])
  frame.send(live, { source: {} })
  frame.send(live, { origin: 'http://untrusted.test' })
  frame.send(live, { data: { source: 'dsh-desktop', type: 'dsh://frontend-preload:boot', id: '6', html: live } })
  expect(frame.pending).toHaveLength(0)
  expect(frame.context.__ModuleLoader__).toBeUndefined()

  frame.send()
  expect(frame.context.order).toEqual(['loader'])
  expect(frame.pending[0].getAttribute('src')).toBe('plugins/bootstrap/client.js?rev=1&x=2')
  expect(resolved).toBe(false)
  runInContext('order.push("bootstrap"); __ModuleLoader__.loaded = true', frame.context)
  frame.pending[0].onload!(new Event('load'))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(resolved).toBe(true)
  expect(frame.context.order).toEqual(['loader', 'bootstrap', 'graph'])
  expect(frame.context.__DSH_BOOT__).toEqual({ entries: [] })
  expect(frame.context.dshDesktop).toEqual({ protocolVersion: 1 })
  expect(frame.context.__DSH_TRANSPORT__).toBeUndefined()
  expect(frame.document.head.firstElementChild?.tagName).toBe('BASE')
  expect(frame.document.querySelectorAll('script[type="module"]')).toHaveLength(1)
  expect(frame.messages.at(-1)?.type).toBe('dsh://frontend-preload:applied')
})

it('rejects unknown live templates and non-owned script sources before executing any injection', async () => {
  for (const html of [
    live.replace('assets/app.js', 'assets/other.js'),
    live.replace('plugins/bootstrap/client.js', 'https://untrusted.test/plugins/client.js'),
    live.replace('<script src=', '<script async src='),
    live.replace(ready, ''),
  ]) {
    const frame = createHarness()
    frame.send(html)
    await Promise.resolve()
    await Promise.resolve()
    expect(frame.context.__ModuleLoader__).toBeUndefined()
    expect(frame.messages.at(-1)?.type).toBe('dsh://frontend-preload:failed')
  }
})

it('rejects failed bootstrap scripts instead of resolving a partial or fake session', async () => {
  const frame = createHarness()
  let resolved = false
  void frame.context.__DSH_BOOT_READY__.promise.then(() => {
    resolved = true
  }, () => {})
  frame.send(live.replace('order.push("graph");', 'throw new Error("bad graph");'))
  frame.pending[0].onload!(new Event('load'))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(resolved).toBe(false)
  expect(frame.messages.at(-1)?.type).toBe('dsh://frontend-preload:failed')
  expect(frame.messages.some(message => message.type === 'dsh://frontend-preload:applied')).toBe(false)
})
