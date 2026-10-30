import { describe, expect, it } from 'vitest'
import { normalizeZoomFactor } from '../../src/store/modules/setting/utils'
import {
  zoomActionFromPayload,
  zoomActionFromShortcut,
} from '../../src/utils/zoom'

function shortcut(
  key: string,
  modifiers: Partial<Omit<KeyboardEvent, 'key'>> = {},
) {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...modifiers,
  }
}

describe('desktop zoom shortcuts', () => {
  it('maps Ctrl and Command zoom shortcuts', () => {
    expect(zoomActionFromShortcut(shortcut('+', { ctrlKey: true }))).toBe('increase')
    expect(zoomActionFromShortcut(shortcut('=', { metaKey: true }))).toBe('increase')
    expect(zoomActionFromShortcut(shortcut('-', { ctrlKey: true }))).toBe('decrease')
    expect(zoomActionFromShortcut(shortcut('_', { metaKey: true }))).toBe('decrease')
    expect(zoomActionFromShortcut(shortcut('0', { ctrlKey: true }))).toBe('reset')
  })

  it('rejects unmodified, AltGr-like, and unrelated shortcuts', () => {
    expect(zoomActionFromShortcut(shortcut('+'))).toBeNull()
    expect(zoomActionFromShortcut(shortcut('+', { ctrlKey: true, altKey: true }))).toBeNull()
    expect(zoomActionFromShortcut(shortcut('1', { ctrlKey: true }))).toBeNull()
  })

  it('reads the zoom action from the event payload', () => {
    expect(zoomActionFromPayload({ action: 'increase' })).toBe('increase')
    expect(zoomActionFromPayload({ action: 'reset' })).toBe('reset')
    expect(zoomActionFromPayload({ action: 'unsupported' })).toBeNull()
    expect(zoomActionFromPayload(null)).toBeNull()
  })
})
describe('zoom factor stepping (mirrors Rust normalize_zoom_factor)', () => {
  it('clamps to [0.5, 2.0] and snaps to the 0.1 grid', () => {
    expect(normalizeZoomFactor(0.1)).toBe(0.5)
    expect(normalizeZoomFactor(3)).toBe(2)
    expect(normalizeZoomFactor(1.14)).toBeCloseTo(1.1, 10)
    expect(normalizeZoomFactor(1.16)).toBeCloseTo(1.2, 10)
    // 非有限值回落 100%
    expect(normalizeZoomFactor(Number.NaN)).toBe(1)
    expect(normalizeZoomFactor(Number.POSITIVE_INFINITY)).toBe(1)
  })

  // `nextZoomFactor` 已从实现中移除：步进现在由 UI 组件按 ZOOM_FACTOR_STEP
  // 计算后交给 normalizeZoomFactor 归一化。这里断言同一语义的现役路径。
  it('steps by 0.1 and resets to 100%', () => {
    const step = (from: number, delta: number) => normalizeZoomFactor(from + delta)

    expect(step(1, 0.1)).toBeCloseTo(1.1, 10)
    expect(step(1, -0.1)).toBeCloseTo(0.9, 10)
    expect(normalizeZoomFactor(1.7)).toBe(1.7)
    // 到顶/到底后不再越界
    expect(step(2, 0.1)).toBe(2)
    expect(step(0.5, -0.1)).toBe(0.5)
  })
})
