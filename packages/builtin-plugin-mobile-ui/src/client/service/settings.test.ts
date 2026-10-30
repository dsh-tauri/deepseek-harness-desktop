import type { MobileSettingsSnapshot } from '../types/settings'
import { describe, expect, it } from 'vitest'
import { resolveSettingsPresentation } from './settings'

const detail: MobileSettingsSnapshot = { ready: true, view: 'detail', title: 'General' }
const menu: MobileSettingsSnapshot = { ready: true, view: 'menu', title: 'General' }
const facts = {
  entering: false,
  changing: false,
  launcher: false,
  navigation: false,
  selectionChanged: false,
  title: 'General',
  focused: { list: false, options: false, controls: false },
}

describe('mobile settings presentation projection', () => {
  it.each([
    { name: 'official launcher', patch: { entering: true, launcher: true }, view: 'menu', focus: null },
    { name: 'unknown entry', patch: { entering: true }, view: 'detail', focus: 'back' },
    { name: 'replacement content', patch: { changing: true, launcher: true }, view: 'detail', focus: 'back' },
    { name: 'empty ledger', patch: { title: null }, view: 'menu', focus: null },
    { name: 'empty ledger after detail', previous: detail, patch: { title: null }, view: 'menu', focus: 'category' },
    { name: 'same section native click', patch: { navigation: true }, view: 'detail', focus: 'back' },
    { name: 'external selection', patch: { selectionChanged: true, title: 'Models' }, view: 'detail', focus: 'back' },
    { name: 'unchanged categories', patch: {}, view: 'menu', focus: null },
    { name: 'ordinary detail input', previous: detail, patch: {}, view: 'detail', focus: null },
    { name: 'focus inside hidden navigation', previous: detail, patch: { focused: { ...facts.focused, list: true } }, view: 'detail', focus: 'back' },
    { name: 'focus inside hidden options', patch: { focused: { ...facts.focused, options: true } }, view: 'menu', focus: 'category' },
    { name: 'focus inside retiring Back', patch: { focused: { ...facts.focused, controls: true } }, view: 'menu', focus: 'category' },
  ])('projects $name without owning a native section id', ({ previous = menu, patch, view, focus }) => {
    const result = resolveSettingsPresentation(previous, previous.view, { ...facts, ...patch })
    expect(result).toEqual({ snapshot: { ready: true, view, title: patch.title === null ? '' : patch.title ?? 'General' }, focus })
  })

  it('preserves snapshot identity for unchanged native facts', () => {
    expect(resolveSettingsPresentation(detail, 'detail', facts).snapshot).toBe(detail)
  })

  it('keeps a label-only update in categories without stealing focus', () => {
    expect(resolveSettingsPresentation(menu, 'menu', { ...facts, title: '常规设置' })).toEqual({
      snapshot: { ready: true, view: 'menu', title: '常规设置' },
      focus: null,
    })
  })

  it('prioritizes an empty ledger over launcher or navigation intent', () => {
    expect(resolveSettingsPresentation(detail, 'detail', { ...facts, entering: true, launcher: true, navigation: true, title: null })).toEqual({
      snapshot: { ready: true, view: 'menu', title: '' },
      focus: 'category',
    })
  })

  it('returns to categories without changing the current native label', () => {
    expect(resolveSettingsPresentation(detail, 'menu', facts)).toEqual({ snapshot: menu, focus: 'category' })
  })
})
