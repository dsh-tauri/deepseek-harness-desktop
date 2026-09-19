import { describe, expect, it } from 'vitest'
import {
  nextZoomFactor,
  normalizeZoomFactor,
  zoomActionFromBridgeMessage,
  zoomActionFromShortcut,
  zoomFactorFromLevel,
  zoomLevelFromFactor,
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

  it('accepts only the strict iframe bridge protocol', () => {
    expect(zoomActionFromBridgeMessage({
      source: 'dsh-zoom-shortcut-bridge',
      type: 'dsh://zoom-shortcut',
      action: 'increase',
    })).toBe('increase')
    // 来源不再参与判定（宿主侧由 useIframeMessage 校验 origin），但 type 必须完全匹配
    expect(zoomActionFromBridgeMessage({
      source: 'dsh-zoom-shortcut-bridge',
      type: 'dsh://other-message',
      action: 'increase',
    })).toBeNull()
    expect(zoomActionFromBridgeMessage({
      source: 'dsh-zoom-shortcut-bridge',
      type: 'dsh://zoom-shortcut',
      action: 'unsupported',
    })).toBeNull()
    expect(zoomActionFromBridgeMessage(null)).toBeNull()
  })
})

describe('zoom level ↔ factor mapping (Chromium base 1.2)', () => {
  it('maps levels to factors', () => {
    expect(zoomFactorFromLevel(0)).toBe(1)
    expect(zoomFactorFromLevel(1)).toBeCloseTo(1.2, 10)
    expect(zoomFactorFromLevel(-1)).toBeCloseTo(1 / 1.2, 10)
    expect(zoomFactorFromLevel(3)).toBeCloseTo(1.728, 10)
  })

  it('maps factors back to levels', () => {
    expect(zoomLevelFromFactor(1)).toBe(0)
    expect(zoomLevelFromFactor(1.2)).toBeCloseTo(1, 10)
    expect(zoomLevelFromFactor(1.44)).toBeCloseTo(2, 10)
    // 比例不是 1.2 的整数次幂 → 小数级别（Electron `getZoomLevel()` 同样可能返回小数）
    expect(zoomLevelFromFactor(1.4)).toBeCloseTo(1.8455, 3)
  })

  it('round-trips level → factor → level', () => {
    for (const level of [-2, -1, 0, 1, 2, 5]) {
      expect(zoomLevelFromFactor(zoomFactorFromLevel(level))).toBeCloseTo(level, 10)
    }
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

  it('steps by 0.1 and resets to 100%', () => {
    expect(nextZoomFactor(1, 'increase')).toBeCloseTo(1.1, 10)
    expect(nextZoomFactor(1, 'decrease')).toBeCloseTo(0.9, 10)
    expect(nextZoomFactor(1.7, 'reset')).toBe(1)
    // 到顶/到底后不再越界
    expect(nextZoomFactor(2, 'increase')).toBe(2)
    expect(nextZoomFactor(0.5, 'decrease')).toBe(0.5)
  })
})
