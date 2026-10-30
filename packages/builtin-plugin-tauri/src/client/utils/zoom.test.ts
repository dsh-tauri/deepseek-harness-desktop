import { describe, expect, it } from 'vitest'
import { zoomActionFromShortcut } from './zoom'

function shortcut(key: string, modifiers: Partial<{ ctrlKey: boolean, metaKey: boolean, altKey: boolean }> = {}) {
  return { key, ctrlKey: false, metaKey: false, altKey: false, ...modifiers }
}

describe('zoomActionFromShortcut', () => {
  it('把 Ctrl/Cmd + +/-/0 映射到三个缩放动作', () => {
    expect(zoomActionFromShortcut(shortcut('+', { ctrlKey: true }))).toBe('increase')
    expect(zoomActionFromShortcut(shortcut('=', { metaKey: true }))).toBe('increase')
    expect(zoomActionFromShortcut(shortcut('-', { ctrlKey: true }))).toBe('decrease')
    expect(zoomActionFromShortcut(shortcut('_', { metaKey: true }))).toBe('decrease')
    expect(zoomActionFromShortcut(shortcut('0', { ctrlKey: true }))).toBe('reset')
  })

  it('无 Ctrl/Cmd、Alt 组合与其它按键一律不处理', () => {
    expect(zoomActionFromShortcut(shortcut('+'))).toBeNull()
    expect(zoomActionFromShortcut(shortcut('0'))).toBeNull()
    expect(zoomActionFromShortcut(shortcut('+', { ctrlKey: true, altKey: true }))).toBeNull()
    expect(zoomActionFromShortcut(shortcut('0', { metaKey: true, altKey: true }))).toBeNull()
    expect(zoomActionFromShortcut(shortcut('1', { ctrlKey: true }))).toBeNull()
  })
})
