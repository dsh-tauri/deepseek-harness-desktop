import { Ghost, Icon } from 'dsh-tauri-ui/client'
import { describe, expect, it, vi } from 'vitest'
import { decoratePetMenuItem, isSettingsMenuItem } from './settings-menu.utils'

const { roots } = vi.hoisted(() => ({
  roots: [] as { container: unknown, node: unknown }[],
}))

vi.mock('react-dom/client', () => ({
  createRoot: (container: unknown) => ({
    render: (node: unknown) => {
      roots.push({ container, node })
    },
    unmount: () => {},
  }),
}))

vi.mock('dsh-tauri-ui/client', () => ({
  Ghost: () => null,
  Icon: () => null,
}))

interface FakeNode {
  textContent?: string
  label: FakeLabel | null
  icon: FakeIcon | null
  shortcut: FakeShortcut | null
  attributes: Record<string, string>
}

interface FakeLabel {
  textContent: string
}

interface FakeIcon {
  innerHTML: string
}

interface FakeShortcut {
  removed: boolean
  remove: () => void
}

function fakeItem(text: string, structure = true, buttonText = text): HTMLButtonElement {
  const label: FakeLabel | null = structure ? { textContent: text } : null
  const icon: FakeIcon | null = structure ? { innerHTML: '<svg data-official="1"></svg>' } : null
  const shortcut: FakeShortcut | null = structure ? { removed: false, remove: () => {} } : null
  const node = {
    textContent: buttonText,
    label,
    icon,
    shortcut,
    attributes: {} as Record<string, string>,
    cloneNode(): unknown {
      return fakeItem(text, structure, buttonText)
    },
    querySelector(selector: string): unknown {
      if (selector.includes('itemLabel'))
        return node.label
      if (selector.includes('itemIcon'))
        return node.icon
      if (selector.includes('shortcut'))
        return node.shortcut
      return null
    },
    setAttribute(name: string, value: string): void {
      node.attributes[name] = value
    },
  }
  if (shortcut !== null) {
    shortcut.remove = () => {
      shortcut.removed = true
    }
  }
  return node as unknown as HTMLButtonElement
}

describe('isSettingsMenuItem', () => {
  it('matches only the settings labels', () => {
    expect(isSettingsMenuItem(fakeItem('设置'))).toBe(true)
    expect(isSettingsMenuItem(fakeItem('Settings'))).toBe(true)
    expect(isSettingsMenuItem(fakeItem('删除工作区'))).toBe(false)
    expect(isSettingsMenuItem(fakeItem('设置宠物'))).toBe(false)
  })

  it('ignores the shortcut keycaps appended to the row text', () => {
    expect(isSettingsMenuItem(fakeItem('设置', true, '设置Ctrl+,'))).toBe(true)
  })
})

describe('decoratePetMenuItem', () => {
  it('rewrites the label, drops the keycaps and marks the clone', () => {
    const source = fakeItem('设置', true, '设置Ctrl+,')

    const item = decoratePetMenuItem(source, '启用宠物')
    const clone = item as unknown as FakeNode

    expect(clone).not.toBe(source)
    expect(clone.label?.textContent).toBe('启用宠物')
    expect(clone.shortcut?.removed).toBe(true)
    expect(clone.attributes['data-dsh-tauri-pet-menu-item']).toBe('1')
  })

  it('mounts the shared Ghost icon into the cloned icon node', () => {
    roots.length = 0
    const source = fakeItem('设置')
    const item = decoratePetMenuItem(source, '启用宠物') as unknown as FakeNode

    expect(roots).toHaveLength(1)
    expect(roots[0].container).toBe(item.icon)
    expect((roots[0].node as { type: unknown, props: { as: unknown } }).type).toBe(Icon)
    expect((roots[0].node as { props: { as: unknown } }).props.as).toBe(Ghost)
  })

  it('refuses to decorate a non-primitives item', () => {
    expect(decoratePetMenuItem(fakeItem('设置', false), '启用宠物')).toBeNull()
  })
})
