import { afterEach, describe, expect, it, vi } from 'vitest'
import { redoShortcutLabel, shortcutLabel } from './context-menu.utils'

vi.mock('dsh-tauri/client', () => import('../../../../dsh-tauri/src/client/utils/device'))

function stubUserAgent(userAgent: string): void {
  vi.stubGlobal('navigator', { userAgent })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('shortcutLabel', () => {
  it('macOS 渲染 ⌘，不再给出平台上不存在的 Ctrl 键位（issue #858）', () => {
    stubUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15')

    expect(shortcutLabel('V')).toBe('⌘V')
    expect(shortcutLabel('A')).toBe('⌘A')
  })

  it('非 macOS 平台保持 Ctrl+ 文案', () => {
    stubUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')

    expect(shortcutLabel('V')).toBe('Ctrl+V')
  })

  it('没有 navigator 时按非 macOS 兜底，不抛异常', () => {
    vi.stubGlobal('navigator', undefined)

    expect(shortcutLabel('R')).toBe('Ctrl+R')
  })
})

describe('mobile shortcut hints', () => {
  it.each(['Linux; Android 15', 'iPhone; CPU iPhone OS 18_0 like Mac OS X', 'Macintosh; Intel Mac OS X 10_15_7'])('hides every desktop key on a touch-only device (%s)', (platform) => {
    stubUserAgent(`Mozilla/5.0 (${platform})`)
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) })
    for (const key of ['Z', 'X', 'C', 'V', 'A', 'R'])
      expect(shortcutLabel(key)).toBe('')
    expect(redoShortcutLabel()).toBe('')
  })

  it('retains keyboard hints while the primary pointer is not a touch device', () => {
    stubUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    vi.stubGlobal('window', { matchMedia: (query: string) => ({ matches: query !== '(pointer: coarse)' && query !== '(any-pointer: coarse)' }) })
    expect(shortcutLabel('Z')).toBe('Ctrl+Z')
    expect(redoShortcutLabel()).toBe('Ctrl+Y')
  })
})

describe('redoShortcutLabel', () => {
  it('macOS 按 AppKit 约定给 ⇧⌘Z 而不是 Ctrl+Y', () => {
    stubUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')

    expect(redoShortcutLabel()).toBe('⇧⌘Z')
  })

  it('非 macOS 平台的重做保持 Ctrl+Y', () => {
    stubUserAgent('Mozilla/5.0 (X11; Linux x86_64)')

    expect(redoShortcutLabel()).toBe('Ctrl+Y')
  })
})
