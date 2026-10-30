import type { CNode } from 'css-render'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cssr } from './cssr'
import { mountStyle } from './style'

const STYLE_ID = 'dsh-tauri-ui-test-styles'
const OWNER = 'dsh-tauri-ui-test-owner'

class FakeStyleElement {
  textContent = ''
  parentElement: FakeHead | null = null
  private readonly attributes = new Map<string, string>()

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  remove(): void {
    this.parentElement?.removeChild(this)
  }
}

class FakeHead {
  readonly children: FakeStyleElement[] = []

  create(): FakeStyleElement {
    return new FakeStyleElement()
  }

  querySelector(selector: string): FakeStyleElement | null {
    if (selector === 'style, link')
      return this.children[0] ?? null
    const match = /^style\[cssr-id="(.+)"\]$/.exec(selector)
    if (match === null)
      return null
    return this.children.find(child => child.getAttribute('cssr-id') === match[1]) ?? null
  }

  insertBefore(node: FakeStyleElement, reference: FakeStyleElement | null): void {
    const index = reference === null ? -1 : this.children.indexOf(reference)
    if (index < 0)
      this.children.push(node)
    else
      this.children.splice(index, 0, node)
    node.parentElement = this
  }

  removeChild(node: FakeStyleElement): void {
    const index = this.children.indexOf(node)
    if (index >= 0)
      this.children.splice(index, 1)
    node.parentElement = null
  }
}

function installFakeDocument(): FakeHead {
  const head = new FakeHead()
  vi.stubGlobal('document', {
    head,
    createElement: () => head.create(),
    querySelector: (selector: string) => head.querySelector(selector),
  })
  return head
}

function styleNode(): CNode {
  return cssr.c('div', { color: 'red' })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('mountStyle', () => {
  it('挂载后样式标签自报 data-plugin 归属，释放时摘掉', () => {
    const head = installFakeDocument()
    const release = mountStyle(styleNode(), STYLE_ID, OWNER)

    expect(head.children).toHaveLength(1)
    expect(head.children[0]?.getAttribute('data-plugin')).toBe(OWNER)

    release()
    expect(head.children).toHaveLength(0)
  })

  it('同一个节点重复挂载只落一张表，最后一个消费者释放时才摘掉', () => {
    const head = installFakeDocument()
    const node = styleNode()
    const first = mountStyle(node, STYLE_ID, OWNER)
    const second = mountStyle(node, STYLE_ID, OWNER)

    expect(head.children).toHaveLength(1)

    first()
    expect(head.children, '还有消费者持有，不得摘表').toHaveLength(1)

    second()
    expect(head.children).toHaveLength(0)
  })

  it('标签被外部删掉后再次挂载会补回来，不留「计数非零但样式缺席」', () => {
    const head = installFakeDocument()
    const node = styleNode()
    mountStyle(node, STYLE_ID, OWNER)
    head.children[0]?.remove()
    expect(head.children).toHaveLength(0)

    mountStyle(node, STYLE_ID, OWNER)

    expect(
      head.querySelector(`style[cssr-id="${STYLE_ID}"]`),
      '样式必须在文档里，而不是只在引用计数里',
    ).not.toBeNull()
  })

  it('插件重载：旧实例遗留的同 id 表被换成新节点的活表，旧实例卸载摘不掉它', () => {
    const head = installFakeDocument()
    const stale = mountStyle(styleNode(), STYLE_ID, OWNER)
    const fresh = mountStyle(styleNode(), STYLE_ID, OWNER)
    expect(head.children).toHaveLength(1)

    stale()
    expect(
      head.querySelector(`style[cssr-id="${STYLE_ID}"]`),
      '新实例的活表不得被旧实例摘掉',
    ).not.toBeNull()
    expect(head.children[0]?.getAttribute('data-plugin')).toBe(OWNER)

    fresh()
    expect(head.children).toHaveLength(0)
  })
})
