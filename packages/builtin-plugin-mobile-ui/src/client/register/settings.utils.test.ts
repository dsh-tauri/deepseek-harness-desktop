// @vitest-environment jsdom
import type { MobileSettingsNodes } from './settings.utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSettingsAttributePatch, findMobileSettingsPanel, resolveMobileSettingsPanel } from './settings.utils'

interface SettingsFixture {
  nodes: MobileSettingsNodes
  slots: Record<'header' | 'action' | 'close' | 'section', HTMLDivElement>
  buttons: HTMLButtonElement[]
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.append(...children)
  return node
}

function slot(name: string, ...children: (Node | string)[]): HTMLDivElement {
  const node = element('div', ...children)
  node.setAttribute('data-slot', name)
  node.style.display = 'contents'
  return node
}

function button(label: string): HTMLButtonElement {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  icon.setAttribute('aria-hidden', 'true')
  const node = element('button', icon, element('span', label))
  node.type = 'button'
  return node
}

// Fixtures mirror official settings-general/lib/client.js 0.2.1-alpha.1:275-341 / 0.1.5-rc.3:99-172 and renderer SlotOutlet's display:contents div anchors.
function mountSettings({ version = 'current', titleId = ':r0:', empty = false }: {
  version?: 'current' | 'legacy'
  titleId?: string
  empty?: boolean
} = {}): SettingsFixture {
  const headerSlot = slot('settings.header', 'Settings')
  const title = element('div', headerSlot)
  title.id = titleId
  const buttons = empty ? [] : [button('General'), button('Plugins')]
  const current = buttons[0] ?? null
  current?.setAttribute('aria-current', 'true')
  const list = element('div', ...buttons)
  const nav = element('nav', title, list)
  const back = button('Back to settings')
  back.setAttribute('data-dsh-mobile-settings-back', '')
  back.setAttribute('aria-label', 'Back to settings')
  const sectionTitle = element('span', 'General')
  sectionTitle.setAttribute('data-dsh-mobile-settings-section-title', '')
  sectionTitle.setAttribute('role', 'heading')
  sectionTitle.setAttribute('aria-level', '2')
  const controls = element('div', back, sectionTitle)
  controls.setAttribute('data-dsh-mobile-settings-controls', '')
  controls.hidden = true
  const actionSlot = slot('settings.action', controls, button('Open document'))
  const actions = element('div', actionSlot)
  const closeSlot = slot('settings.close', 'Close')
  const close = button('')
  close.lastElementChild!.append(closeSlot)
  const header = element('div', actions, close)
  const input = element('input')
  input.type = 'search'
  const sectionSlot = slot('settings.section', element('div', input))
  const options = element('div', ...empty ? [] : [sectionSlot])
  const content = element('div', header, options)
  const panel = element('div', nav, content)
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-labelledby', titleId)
  const mask = element('div')
  mask.setAttribute('aria-hidden', 'true')
  const overlay = element('div', mask, panel)
  overlay.setAttribute('role', 'presentation')
  const root = slot('sidebar.settings')
  document.body.append(root)
  if (version === 'current') {
    panel.tabIndex = -1
    panel.setAttribute('data-shortcut-modal', 'settings')
    title.tabIndex = -1
    ;(current ?? title).setAttribute('data-modal-autofocus', '')
    document.body.append(overlay)
  }
  else {
    root.append(overlay)
  }
  return {
    nodes: { panel, overlay, nav, title, list, content, header, actions, close, options, controls, back, current },
    slots: { header: headerSlot, action: actionSlot, close: closeSlot, section: sectionSlot },
    buttons,
  }
}

function expectNodes(actual: MobileSettingsNodes | null, expected: MobileSettingsNodes): void {
  expect(actual, 'The supported official fixture must resolve').not.toBeNull()
  if (actual === null)
    throw new Error('The supported official fixture did not resolve')
  for (const key of Object.keys(expected) as (keyof MobileSettingsNodes)[])
    expect(actual[key], `Resolved ${key} must be the original node`).toBe(expected[key])
}

beforeEach(() => document.body.replaceChildren())

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('resolveMobileSettingsPanel', () => {
  it.each(['current', 'legacy'] as const)('resolves the %s official shell with display:contents slot wrappers', (version) => {
    const fixture = mountSettings({ version })
    expectNodes(resolveMobileSettingsPanel(fixture.nodes.panel), fixture.nodes)
  })

  it.each(['current', 'legacy'] as const)('resolves %s empty sections without inventing a current button', (version) => {
    const fixture = mountSettings({ version, empty: true })
    expectNodes(resolveMobileSettingsPanel(fixture.nodes.panel), fixture.nodes)
    expect(fixture.nodes.current).toBeNull()
    expect(fixture.nodes.options.children).toHaveLength(0)
  })

  it('resolves a colon-containing title id with surrounding aria-labelledby whitespace', () => {
    const fixture = mountSettings({ titleId: ':r12:' })
    fixture.nodes.panel.setAttribute('aria-labelledby', '  :r12:  ')
    expectNodes(resolveMobileSettingsPanel(fixture.nodes.panel), fixture.nodes)
  })

  it('returns the selected second button rather than the first row', () => {
    const fixture = mountSettings()
    fixture.buttons[0].removeAttribute('aria-current')
    fixture.buttons[1].setAttribute('aria-current', 'true')
    expectNodes(resolveMobileSettingsPanel(fixture.nodes.panel), { ...fixture.nodes, current: fixture.buttons[1] })
  })

  it('preserves a disabled current row while Back and Close remain usable', () => {
    const fixture = mountSettings()
    fixture.buttons[0].disabled = true
    expectNodes(resolveMobileSettingsPanel(fixture.nodes.panel), fixture.nodes)
  })

  it.each(['list', 'options'] as const)('still resolves the shell after the presentation hides its %s', (part) => {
    const fixture = mountSettings()
    fixture.nodes[part].hidden = true
    fixture.nodes[part].setAttribute('inert', '')
    expectNodes(resolveMobileSettingsPanel(fixture.nodes.panel), fixture.nodes)
  })

  it('ignores nested modal slots when the original settings anchors remain present', () => {
    const fixture = mountSettings()
    const foreign = element(
      'div',
      slot('settings.header', 'Foreign header'),
      slot('settings.action'),
      slot('settings.close', 'Foreign close'),
      slot('settings.section'),
    )
    foreign.setAttribute('role', 'dialog')
    foreign.setAttribute('aria-modal', 'true')
    fixture.slots.section.append(foreign)
    expectNodes(resolveMobileSettingsPanel(fixture.nodes.panel), fixture.nodes)
  })

  it.each(['header', 'action', 'close', 'section'] as const)('rejects a missing settings.%s slot', (name) => {
    const fixture = mountSettings()
    fixture.slots[name].remove()
    expect(resolveMobileSettingsPanel(fixture.nodes.panel)).toBeNull()
  })

  it.each(['header', 'action', 'close', 'section'] as const)('rejects a duplicated owned settings.%s slot', (name) => {
    const fixture = mountSettings()
    const original = fixture.slots[name]
    original.parentElement!.append(original.cloneNode(true))
    expect(resolveMobileSettingsPanel(fixture.nodes.panel)).toBeNull()
  })

  it.each(['header', 'action', 'close', 'section'] as const)('rejects a settings.%s slot found only inside a foreign modal', (name) => {
    const fixture = mountSettings()
    const foreign = element('div', fixture.slots[name])
    foreign.setAttribute('role', 'dialog')
    foreign.setAttribute('aria-modal', 'true')
    fixture.nodes.options.append(foreign)
    expect(resolveMobileSettingsPanel(fixture.nodes.panel)).toBeNull()
  })

  it.each(['controls', 'back', 'title', 'list', 'options'] as const)('rejects a missing %s node', (name) => {
    const fixture = mountSettings()
    fixture.nodes[name].remove()
    expect(resolveMobileSettingsPanel(fixture.nodes.panel)).toBeNull()
  })

  it.each(['controls', 'back'] as const)('rejects a duplicated owned %s marker', (name) => {
    const fixture = mountSettings()
    const original = fixture.nodes[name]
    original.parentElement!.append(original.cloneNode(true))
    expect(resolveMobileSettingsPanel(fixture.nodes.panel)).toBeNull()
  })

  it.each(['panel', 'nav', 'content', 'header'] as const)('rejects an extra direct child changing the official %s shape', (name) => {
    const fixture = mountSettings()
    fixture.nodes[name].append(element('div'))
    expect(resolveMobileSettingsPanel(fixture.nodes.panel)).toBeNull()
  })

  it.each(['list', 'options'] as const)('rejects a non-div %s container', (name) => {
    const fixture = mountSettings()
    const replacement = element('section', ...fixture.nodes[name].childNodes)
    fixture.nodes[name].replaceWith(replacement)
    expect(resolveMobileSettingsPanel(fixture.nodes.panel)).toBeNull()
  })

  it.each(['nav', 'content', 'close'] as const)('rejects an additional wrapper around the official %s node', (name) => {
    const fixture = mountSettings()
    const original = fixture.nodes[name]
    const parent = original.parentElement!
    const wrapper = element('div', original)
    parent.append(wrapper)
    expect(resolveMobileSettingsPanel(fixture.nodes.panel)).toBeNull()
  })

  it('rejects an action slot nested under an extra wrapper', () => {
    const fixture = mountSettings()
    fixture.nodes.actions.append(element('div', fixture.slots.action))
    expect(resolveMobileSettingsPanel(fixture.nodes.panel)).toBeNull()
  })

  it('rejects a header slot no longer directly owned by the labelled title', () => {
    const fixture = mountSettings()
    fixture.nodes.title.append(element('span', fixture.slots.header))
    expect(resolveMobileSettingsPanel(fixture.nodes.panel)).toBeNull()
  })

  it('rejects controls outside the settings.action slot', () => {
    const fixture = mountSettings()
    fixture.nodes.options.append(fixture.nodes.controls)
    expect(resolveMobileSettingsPanel(fixture.nodes.panel)).toBeNull()
  })

  it('rejects a section outlet nested under an extra options wrapper', () => {
    const fixture = mountSettings()
    fixture.nodes.options.append(element('div', fixture.slots.section))
    expect(resolveMobileSettingsPanel(fixture.nodes.panel)).toBeNull()
  })

  it('rejects a navigation row that is not a button', () => {
    const fixture = mountSettings()
    fixture.buttons[1].replaceWith(element('a', 'Plugins'))
    expect(resolveMobileSettingsPanel(fixture.nodes.panel)).toBeNull()
  })

  it.each([null, 'false'] as const)('rejects nonempty navigation without an aria-current=true row (%s)', (value) => {
    const fixture = mountSettings()
    if (value === null)
      fixture.buttons[0].removeAttribute('aria-current')
    else
      fixture.buttons[0].setAttribute('aria-current', value)
    expect(resolveMobileSettingsPanel(fixture.nodes.panel)).toBeNull()
  })

  it('rejects multiple aria-current=true rows', () => {
    const fixture = mountSettings()
    fixture.buttons[1].setAttribute('aria-current', 'true')
    expect(resolveMobileSettingsPanel(fixture.nodes.panel)).toBeNull()
  })

  it('rejects a section outlet when there are no navigation rows', () => {
    const fixture = mountSettings({ empty: true })
    fixture.nodes.options.append(fixture.slots.section)
    expect(resolveMobileSettingsPanel(fixture.nodes.panel)).toBeNull()
  })

  it.each(['back', 'close'] as const)('rejects a directly disabled %s button', (name) => {
    const fixture = mountSettings()
    fixture.nodes[name].disabled = true
    expect(resolveMobileSettingsPanel(fixture.nodes.panel)).toBeNull()
  })

  it.each(['back', 'close'] as const)('rejects a %s anchor whose enclosing element is not a button', (name) => {
    const fixture = mountSettings()
    const replacement = element('span')
    if (name === 'back')
      replacement.setAttribute('data-dsh-mobile-settings-back', '')
    else
      replacement.append(fixture.slots.close)
    fixture.nodes[name].replaceWith(replacement)
    expect(resolveMobileSettingsPanel(fixture.nodes.panel)).toBeNull()
  })

  it.each([
    ['role', null],
    ['role', 'alertdialog'],
    ['aria-modal', null],
    ['aria-modal', 'false'],
  ])('rejects the shell when %s is %s', (name, value) => {
    const fixture = mountSettings()
    if (value === null)
      fixture.nodes.panel.removeAttribute(name!)
    else
      fixture.nodes.panel.setAttribute(name!, value)
    expect(resolveMobileSettingsPanel(fixture.nodes.panel)).toBeNull()
  })

  it.each([
    ['panel', 'hidden'],
    ['overlay', 'hidden'],
    ['body', 'hidden'],
    ['panel', 'inert'],
    ['overlay', 'inert'],
    ['body', 'inert'],
  ] as const)('rejects a shell below %s[%s]', (name, attribute) => {
    const fixture = mountSettings()
    const target = name === 'body' ? document.body : fixture.nodes[name]
    target.setAttribute(attribute, '')
    const result = resolveMobileSettingsPanel(fixture.nodes.panel)
    target.removeAttribute(attribute)
    expect(result).toBeNull()
  })

  it.each(['panel', 'overlay'] as const)('rejects the shell after its %s is disconnected', (name) => {
    const fixture = mountSettings()
    fixture.nodes[name].remove()
    expect(resolveMobileSettingsPanel(fixture.nodes.panel)).toBeNull()
  })

  it.each([null, '', '   ', ':unknown:', ':r0: :another:', ':r0:\n:another:'])('rejects an absent, unknown or multi-token title reference (%j)', (value) => {
    const fixture = mountSettings()
    if (value === null)
      fixture.nodes.panel.removeAttribute('aria-labelledby')
    else
      fixture.nodes.panel.setAttribute('aria-labelledby', value)
    expect(resolveMobileSettingsPanel(fixture.nodes.panel)).toBeNull()
  })

  it('rejects a labelled title outside the settings panel', () => {
    const fixture = mountSettings()
    const foreignTitle = element('div', 'Foreign title')
    foreignTitle.id = ':foreign:'
    document.body.append(foreignTitle)
    fixture.nodes.panel.setAttribute('aria-labelledby', ':foreign:')
    expect(resolveMobileSettingsPanel(fixture.nodes.panel)).toBeNull()
  })

  it.each(['panel', 'document'] as const)('rejects an aria-labelledby id that is duplicated inside the %s', (location) => {
    const fixture = mountSettings()
    const duplicate = element('div', 'Foreign title')
    duplicate.id = fixture.nodes.title.id
    const target = location === 'panel' ? fixture.nodes.options : document.body
    target.append(duplicate)
    expect(resolveMobileSettingsPanel(fixture.nodes.panel)).toBeNull()
  })

  it('rejects a back marker whose only button belongs to a nested foreign modal', () => {
    const fixture = mountSettings()
    fixture.nodes.back.remove()
    const foreignBack = button('Foreign back')
    foreignBack.setAttribute('data-dsh-mobile-settings-back', '')
    const foreign = element('div', foreignBack)
    foreign.setAttribute('role', 'dialog')
    foreign.setAttribute('aria-modal', 'true')
    fixture.nodes.controls.append(foreign)
    expect(resolveMobileSettingsPanel(fixture.nodes.panel)).toBeNull()
  })
})

describe('findMobileSettingsPanel', () => {
  it('returns null when no dialog exists', () => {
    expect(findMobileSettingsPanel()).toBeNull()
  })

  it.each(['current', 'legacy'] as const)('finds the %s official shell without changing or replacing nodes', (version) => {
    const fixture = mountSettings({ version })
    const markup = document.body.innerHTML
    const children = [...fixture.nodes.panel.children]
    expectNodes(findMobileSettingsPanel(), fixture.nodes)
    expectNodes(resolveMobileSettingsPanel(fixture.nodes.panel), fixture.nodes)
    expect(document.body.innerHTML).toBe(markup)
    expect([...fixture.nodes.panel.children]).toEqual(children)
  })

  it('ignores non-settings dialogs before and after the valid shell', () => {
    const fixture = mountSettings()
    for (const position of ['before', 'after'] as const) {
      const foreign = element('div', button('Dismiss'))
      foreign.setAttribute('role', 'dialog')
      foreign.setAttribute('aria-modal', 'true')
      if (position === 'before')
        document.body.prepend(foreign)
      else
        document.body.append(foreign)
    }
    expectNodes(findMobileSettingsPanel(), fixture.nodes)
  })

  it('rejects ambiguous valid current and legacy settings shells', () => {
    const current = mountSettings({ titleId: ':current:' })
    const legacy = mountSettings({ version: 'legacy', titleId: ':legacy:' })
    expectNodes(resolveMobileSettingsPanel(current.nodes.panel), current.nodes)
    expectNodes(resolveMobileSettingsPanel(legacy.nodes.panel), legacy.nodes)
    expect(findMobileSettingsPanel()).toBeNull()
  })

  it('returns the sole valid shell when another settings candidate fails its shape check', () => {
    const invalid = mountSettings({ titleId: ':invalid:' })
    invalid.slots.action.remove()
    const valid = mountSettings({ titleId: ':valid:' })
    expect(resolveMobileSettingsPanel(invalid.nodes.panel)).toBeNull()
    expectNodes(findMobileSettingsPanel(), valid.nodes)
  })

  it.each(['hidden', 'inert'] as const)('ignores a second supported shell hidden through its %s overlay', (attribute) => {
    const excluded = mountSettings({ titleId: ':excluded:' })
    excluded.nodes.overlay.setAttribute(attribute, '')
    const valid = mountSettings({ titleId: ':visible:' })
    expectNodes(findMobileSettingsPanel(), valid.nodes)
  })
})

describe('createSettingsAttributePatch', () => {
  it.each([null, '', 'original'] as const)('restores the exact prior attribute value %j', (previous) => {
    const target = element('div')
    if (previous !== null)
      target.setAttribute('data-dsh-mobile-settings-view', previous)
    const patch = createSettingsAttributePatch()
    patch.set(target, 'data-dsh-mobile-settings-view', 'detail')
    expect(target.getAttribute('data-dsh-mobile-settings-view')).toBe('detail')
    patch.restore()
    expect(target.getAttribute('data-dsh-mobile-settings-view')).toBe(previous)
    expect(target.hasAttribute('data-dsh-mobile-settings-view')).toBe(previous !== null)
  })

  it.each(['', 'native'] as const)('restores a removed attribute whose prior value was %j', (previous) => {
    const target = element('div')
    target.setAttribute('inert', previous)
    const patch = createSettingsAttributePatch()
    patch.set(target, 'inert', null)
    expect(target.hasAttribute('inert')).toBe(false)
    patch.restore()
    expect(target.getAttribute('inert')).toBe(previous)
  })

  it('restores the original attribute after multiple owned updates', () => {
    const target = element('div')
    target.setAttribute('data-dsh-mobile-settings-view', 'native')
    const patch = createSettingsAttributePatch()
    patch.set(target, 'data-dsh-mobile-settings-view', 'menu')
    patch.set(target, 'data-dsh-mobile-settings-view', 'detail')
    expect(target.getAttribute('data-dsh-mobile-settings-view')).toBe('detail')
    patch.restore()
    expect(target.getAttribute('data-dsh-mobile-settings-view')).toBe('native')
  })

  it('retains the first snapshot across owned removal and recreation', () => {
    const target = element('div')
    target.setAttribute('hidden', 'native')
    const patch = createSettingsAttributePatch()
    patch.set(target, 'hidden', '')
    patch.set(target, 'hidden', null)
    expect(target.hasAttribute('hidden')).toBe(false)
    patch.set(target, 'hidden', 'detail')
    expect(target.getAttribute('hidden')).toBe('detail')
    patch.restore()
    expect(target.getAttribute('hidden')).toBe('native')
  })

  it('restores independent attributes on multiple nodes without altering unrelated data', () => {
    const first = element('div')
    const second = element('div')
    first.setAttribute('hidden', 'native-hidden')
    first.setAttribute('aria-label', 'Settings')
    second.setAttribute('inert', 'native-inert')
    const patch = createSettingsAttributePatch()
    patch.set(first, 'hidden', '')
    patch.set(first, 'inert', '')
    patch.set(second, 'hidden', '')
    patch.set(second, 'inert', null)
    expect(first.getAttribute('hidden')).toBe('')
    expect(first.getAttribute('inert')).toBe('')
    expect(second.getAttribute('hidden')).toBe('')
    expect(second.hasAttribute('inert')).toBe(false)
    patch.restore()
    expect(first.getAttribute('hidden')).toBe('native-hidden')
    expect(first.hasAttribute('inert')).toBe(false)
    expect(first.getAttribute('aria-label')).toBe('Settings')
    expect(second.hasAttribute('hidden')).toBe(false)
    expect(second.getAttribute('inert')).toBe('native-inert')
  })

  it('does not mutate the DOM when an owned set already matches the attribute', () => {
    const target = element('div')
    target.setAttribute('hidden', '')
    const set = vi.spyOn(target, 'setAttribute')
    const remove = vi.spyOn(target, 'removeAttribute')
    const patch = createSettingsAttributePatch()
    patch.set(target, 'hidden', '')
    patch.set(target, 'hidden', '')
    patch.set(target, 'inert', null)
    expect(set).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })

  it('restores each attribute only while its last written value still owns it', () => {
    const target = element('div')
    target.setAttribute('hidden', 'native')
    const patch = createSettingsAttributePatch()
    patch.set(target, 'hidden', '')
    patch.set(target, 'inert', '')
    target.setAttribute('hidden', 'later-owner')
    patch.restore()
    expect(target.getAttribute('hidden')).toBe('later-owner')
    expect(target.hasAttribute('inert')).toBe(false)
  })

  it('preserves a later owner that removes the plugin-written attribute', () => {
    const target = element('div')
    target.setAttribute('hidden', 'native')
    const patch = createSettingsAttributePatch()
    patch.set(target, 'hidden', '')
    target.removeAttribute('hidden')
    patch.set(target, 'hidden', 'detail')
    expect(target.hasAttribute('hidden')).toBe(false)
    patch.restore()
    expect(target.hasAttribute('hidden')).toBe(false)
  })

  it('preserves a later owner that recreates a plugin-removed attribute', () => {
    const target = element('div')
    target.setAttribute('inert', 'native')
    const patch = createSettingsAttributePatch()
    patch.set(target, 'inert', null)
    target.setAttribute('inert', 'later-owner')
    patch.set(target, 'inert', '')
    expect(target.getAttribute('inert')).toBe('later-owner')
    patch.restore()
    expect(target.getAttribute('inert')).toBe('later-owner')
  })

  it('restores a removed DOM node before releasing its recorded ownership', () => {
    const target = element('div')
    target.setAttribute('hidden', 'native')
    document.body.append(target)
    const patch = createSettingsAttributePatch()
    patch.set(target, 'hidden', '')
    target.remove()
    patch.restore()
    expect(target.isConnected).toBe(false)
    expect(target.getAttribute('hidden')).toBe('native')
  })

  it('releases restored ownership so a second restore cannot touch a later owner', () => {
    const target = element('div')
    const patch = createSettingsAttributePatch()
    patch.set(target, 'hidden', '')
    patch.restore()
    expect(target.hasAttribute('hidden')).toBe(false)
    target.setAttribute('hidden', 'later-owner')
    patch.restore()
    expect(target.getAttribute('hidden')).toBe('later-owner')
  })

  it('captures a new baseline when reused after restore', () => {
    const target = element('div')
    const patch = createSettingsAttributePatch()
    patch.set(target, 'hidden', '')
    patch.restore()
    target.setAttribute('hidden', 'new-native')
    patch.set(target, 'hidden', 'detail')
    expect(target.getAttribute('hidden')).toBe('detail')
    patch.restore()
    expect(target.getAttribute('hidden')).toBe('new-native')
  })

  it('forgets relinquished attributes after restore and can start a fresh ownership cycle', () => {
    const target = element('div')
    const patch = createSettingsAttributePatch()
    patch.set(target, 'hidden', '')
    target.setAttribute('hidden', 'later-owner')
    patch.restore()
    patch.set(target, 'hidden', 'detail')
    expect(target.getAttribute('hidden')).toBe('detail')
    patch.restore()
    expect(target.getAttribute('hidden')).toBe('later-owner')
  })

  it('leaves a later owner untouched by an attempted update or restore', () => {
    const target = element('div')
    const patch = createSettingsAttributePatch()
    patch.set(target, 'hidden', '')
    target.setAttribute('hidden', 'later-owner')
    patch.set(target, 'hidden', null)
    expect(target.getAttribute('hidden')).toBe('later-owner')
    patch.restore()
    expect(target.getAttribute('hidden')).toBe('later-owner')
  })
})
