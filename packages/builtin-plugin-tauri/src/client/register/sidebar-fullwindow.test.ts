import type { ClientContext } from '../types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '../service/tauri'
import { sidebarFullwindowFeature } from './sidebar-fullwindow'

vi.mock('../service/tauri', () => ({ invoke: vi.fn(() => Promise.resolve()), emit: vi.fn(() => Promise.resolve()) }))

interface FakeNode {
  attributes: Map<string, string>
  className: string
  clicks: number
  innerHTML: string
  parentElement: FakeContainer | null
  style: { display: string, removeProperty: (name: string) => void, setProperty: (name: string, value: string) => void }
  title: string
  setAttribute: (name: string, value: string) => void
  getAttribute: (name: string) => string | null
  addEventListener: (type: string, handler: () => void) => void
  click: () => void
  closest: () => unknown
}

interface FakeContainer {
  children: FakeNode[]
  insertBefore: (node: FakeNode, before: FakeNode) => FakeNode
}

function createNode(): FakeNode {
  const listeners = new Map<string, () => void>()
  const node: FakeNode = {
    attributes: new Map(),
    className: '',
    clicks: 0,
    innerHTML: '',
    parentElement: null,
    style: {
      display: '',
      setProperty: (name, value) => {
        if (name === 'display')
          node.style.display = value
      },
      removeProperty: (name) => {
        if (name === 'display')
          node.style.display = ''
      },
    },
    title: '',
    setAttribute(name, value) { node.attributes.set(name, value) },
    getAttribute: name => node.attributes.get(name) ?? null,
    addEventListener(type, handler) { listeners.set(type, handler) },
    click() {
      node.clicks += 1
      listeners.get('click')?.()
    },
    closest: () => ({ getAttribute: (name: string) => name === 'data-sidebar-right-session' ? 'session-1' : null }),
  }
  return node
}

function stubDom(options: { fullSidebar?: boolean, tabs?: number } = {}) {
  const container: FakeContainer = {
    children: [],
    insertBefore(node, before) {
      const at = container.children.indexOf(node)
      if (at >= 0)
        container.children.splice(at, 1)
      container.children.splice(container.children.indexOf(before), 0, node)
      node.parentElement = container
      return node
    },
  }
  const toggle = createNode()
  toggle.setAttribute('data-sidebar-right-toggle', '')
  const mode = createNode()
  mode.className = 'P3OORG_iconButton'
  mode.setAttribute('aria-label', '全屏')
  mode.setAttribute('data-sidebar-right-mode', 'fullscreen')
  mode.parentElement = container
  container.children.push(mode)
  const expand = createNode()
  expand.setAttribute('data-sidebar-right-expand', '')
  const closes = Array.from({ length: options.tabs ?? 2 }, () => {
    const tab = createNode()
    tab.setAttribute('data-dockkit-tab', 'tab')
    const close = createNode()
    close.setAttribute('data-dockkit-tab-close', 'tab')
    tab.parentElement = container
    tab.closest = () => tab
    return { close, tab }
  })
  const tabs = closes.map(entry => entry.tab)
  const contextHandlers = new Map<string, (event: unknown) => void>()

  vi.stubGlobal('document', {
    body: { style: { setProperty: vi.fn(), removeProperty: vi.fn() } },
    documentElement: {
      setAttribute: vi.fn(),
      hasAttribute: () => options.fullSidebar ?? false,
    },
    createElement: () => createNode(),
    addEventListener: (type: string, handler: (event: unknown) => void) => contextHandlers.set(type, handler),
    removeEventListener: (type: string) => contextHandlers.delete(type),
    querySelector: (selector: string) => {
      if (selector === '[data-sidebar-right-mode]')
        return mode
      if (selector === '[data-sidebar-right-expand]')
        return expand
      if (selector === '[data-sidebar-right-toggle]')
        return toggle
      if (selector === '[data-dsh-tauri-open-window]')
        return container.children.find(node => node.attributes.has('data-dsh-tauri-open-window')) ?? null
      return null
    },
    querySelectorAll: (selector: string) => {
      if (selector === '[data-dockkit-tab]')
        return tabs
      return selector === '[data-dockkit-tab-close]' ? closes.map(entry => entry.close) : []
    },
  })
  vi.stubGlobal('HTMLElement', class {})
  vi.stubGlobal('Element', class {})
  vi.stubGlobal('MutationObserver', class {
    observe() {}
    disconnect() {}
  })
  return { closes, container, contextHandlers, mode, tabs, toggle }
}

function runFeature(): () => void {
  return sidebarFullwindowFeature.call({ get: () => undefined } as unknown as ClientContext)
}

beforeEach(() => {
  vi.mocked(invoke).mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('sidebarFullwindowFeature', () => {
  it('在全屏按钮左侧注入官方同款按钮，并按官方按钮语言取文案', () => {
    const { container, mode } = stubDom()
    const dispose = runFeature()

    const [button] = container.children
    expect(container.children).toHaveLength(2)
    expect(container.children[1]).toBe(mode)
    expect(button.attributes.has('data-dsh-tauri-open-window')).toBe(true)
    expect(button.className).toBe(mode.className)
    expect(button.getAttribute('aria-label')).toBe('在新窗口全屏打开')
    expect(button.innerHTML).toContain('<svg')
    dispose()
  })

  it('点击后按当前会话的 id 走宿主建窗，并带上全屏形态标记，同时收起本窗口右栏', async () => {
    const { container, toggle } = stubDom()
    const dispose = runFeature()

    container.children[0].click()

    expect(invoke).toHaveBeenCalledExactlyOnceWith('create_app_window', {
      sessionId: 'session-1',
      presentation: 'full-sidebar',
    })
    expect(toggle.clicks).toBe(1)
    dispose()
  })

  it('已经是全屏形态的按钮不重复注入', () => {
    const { container } = stubDom()
    runFeature()
    runFeature()

    expect(container.children).toHaveLength(2)
  })

  it('全屏形态窗口只剩一个 tab 时收掉关闭按钮并吞掉右键菜单', () => {
    const { closes, contextHandlers, tabs } = stubDom({ fullSidebar: true, tabs: 1 })
    const dispose = runFeature()

    expect(closes[0].close.style.display).toBe('none')
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()
    contextHandlers.get('contextmenu')?.({ preventDefault, stopPropagation, target: tabs[0] })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(stopPropagation).toHaveBeenCalledOnce()
    dispose()
  })

  it('多 tab 时不介入右键菜单', () => {
    const { closes, contextHandlers, tabs } = stubDom({ fullSidebar: true, tabs: 2 })
    const dispose = runFeature()

    expect(closes[0].close.style.display).toBe('')
    const preventDefault = vi.fn()
    contextHandlers.get('contextmenu')?.({ preventDefault, stopPropagation: vi.fn(), target: tabs[0] })
    expect(preventDefault).not.toHaveBeenCalled()
    dispose()
  })
})
