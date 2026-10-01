import postcss from 'postcss'
import { describe, expect, it } from 'vitest'
import globalStyle from './global.cssr'

describe('conversation input dock stack', () => {
  const rules: Record<string, Record<string, string>> = {}
  postcss.parse(globalStyle.render()).walkRules((rule) => {
    if (rule.selector.includes('conversation.input.dock')) {
      rules[rule.selector] = {}
      rule.walkDecls((decl) => {
        rules[rule.selector][decl.prop] = decl.value
      })
    }
  })

  const dock = '[data-slot="conversation.input.dock"]:has(> :nth-child(3 of :not([data-dsh-tauri-worktree-mode-anchor])))'

  it.each([
    [2, 'scale(0.98)'],
    [3, 'scale(0.96)'],
    [4, 'scale(0.94)'],
  ])('reduces the real height of non-anchor child %s when collapsed', (index, transform) => {
    expect(rules[`${dock}:not(:has(> :not([data-dsh-tauri-worktree-mode-anchor]):hover)):not(:focus-within) > :nth-last-child(${index} of :not([data-dsh-tauri-worktree-mode-anchor]))`]).toEqual({ height: '12px', transform })
  })

  it.each([2, 3, 4])('restores non-anchor child %s on hover or focus', (index) => {
    expect(rules[`${dock}:is(:has(> :not([data-dsh-tauri-worktree-mode-anchor]):hover), :focus-within) > :nth-last-child(${index} of :not([data-dsh-tauri-worktree-mode-anchor]))`]).toEqual({ 'transform': 'scale(1)', 'margin-bottom': '6px', 'overflow': 'visible' })
    expect(rules[`${dock} > :nth-last-child(${index} of :not([data-dsh-tauri-worktree-mode-anchor]))`]).toEqual({
      'position': 'relative',
      'height': 'auto',
      'min-height': '0',
      'margin-block': '0',
      'box-sizing': 'border-box',
      'overflow': 'clip',
      'transform-origin': 'top center',
      'interpolate-size': 'allow-keywords',
      'transition': 'height 220ms ease, transform 220ms ease, margin-bottom 220ms ease',
    })
  })

  it('adds no stack declarations to the last child or children earlier than the fourth last', () => {
    expect(Object.keys(rules).filter(selector => selector.includes(':nth-last-child(') && !selector.endsWith('::after'))).toHaveLength(9)
    expect(Object.keys(rules).some(selector => selector.includes(':nth-last-child(1 '))).toBe(false)
    expect(Object.keys(rules).some(selector => selector.includes(':nth-last-child(5 '))).toBe(false)
  })
})

describe('mobile conversation layout', () => {
  const root = postcss.parse(globalStyle.render())

  it('keeps current mobile layout overrides scoped to mobile devices', () => {
    const media = root.nodes.find(node => node.type === 'atrule' && node.name === 'media' && node.params === '(hover: none) and (any-pointer: coarse) and (any-hover: none)')
    expect(media?.type).toBe('atrule')
    if (media?.type !== 'atrule')
      throw new Error('Missing mobile media query')
    expect(media.params).toBe('(hover: none) and (any-pointer: coarse) and (any-hover: none)')
    const rules: Record<string, unknown> = {}
    media.walkRules((rule) => {
      rules[rule.selector] = rule.nodes.map(node => node.type === 'decl' ? [node.prop, node.value, node.important] : [])
    })
    expect(rules).toEqual({
      '[data-slot="conversation.composer.bar"] [class$="_dock"]': [['display', 'none', true]],
      '[class$="_composerStack"] > [data-slot="conversation.input.dock"]': [['display', 'none', true]],
      '[class$="_turnErrorCode"]': [['display', 'none', true]],
      '[data-slot="conversation.header"] [class$="_header"]': [['display', 'none', true]],
      '[data-slot="main"] header[class*="_pageHead"]': [['padding-left', '0', true], ['padding-top', '24px', true]],
      'header[class*="_pageHead"] [class*="_toolbar"]': [['display', 'none', true]],
      '[data-slot="conversation.view"] [class$="_scroll"]': [['padding', '16px', true]],
      '[class*="_userStack"]': [['max-width', '100%', true]],
      '[data-slot="main"] [data-conversation-scroll]': [['padding-bottom', '0', true]],
    })
  })

  it('overrides conversation scroll bottom padding to zero inside the mobile media query', () => {
    const declarations: unknown[] = []
    root.walkRules('[data-slot="main"] [data-conversation-scroll]', (rule) => {
      const parent = rule.parent
      expect(parent?.type).toBe('atrule')
      if (parent?.type === 'atrule')
        expect(parent.params).toBe('(hover: none) and (any-pointer: coarse) and (any-hover: none)')
      rule.walkDecls((decl) => {
        declarations.push([decl.prop, decl.value, decl.important])
      })
    })
    expect(declarations).toEqual([['padding-bottom', '0', true]])
  })
})

/**
 * 侧边栏 rail 的 logo 契约。
 *
 * 官方侧边栏折叠后，logo 不再来自 `logoRow` 上的品牌块（它只在展开态渲染），
 * 而是画在 logo 行里那枚 toggle 内（`railMark` 鲸鱼，悬停互换为展开图标）。
 * 本仓为去掉重复入口在展开态隐藏该 toggle —— 该规则不得在折叠态继续命中，
 * 否则 rail 上的 logo 整块消失。这里按生成 CSS 断言这条恢复规则存在且特异性更高。
 */
describe('sidebar rail logo', () => {
  const css = globalStyle.render()

  it('展开态隐藏重复的折叠 toggle', () => {
    expect(css).toMatch(/\[class\$="logoRow"\][^{]*\[class\$="toggle"\][^{]*\{[^}]*display:\s*none\s*!important/)
  })

  it('折叠态把承载 logo 的 toggle 恢复显示（特异性高于隐藏规则）', () => {
    const recovery = /\[class\*="collapsed"\]\s*\[class\$="logoRow"\]\s*\[class\$="toggle"\][^{]*\{[^}]*display:\s*inline-flex\s*!important/.exec(css)
    expect(recovery, '缺少折叠轨道的 logo 恢复规则').not.toBeNull()

    const hide = css.indexOf('[class$="logoRow"] [class$="toggle"]')
    const show = css.indexOf('[class*="collapsed"] [class$="logoRow"] [class$="toggle"]')
    expect(show, '恢复规则必须排在隐藏规则之后').toBeGreaterThan(hide)
  })
})

/**
 * 中栏表面契约。
 *
 * 官方桌面端（Windows 标题栏形态）把中栏画成「别名底色 + 左上 16px 圆角」，触发条件是
 * 宿主在文档根打的 `data-windows-titlebar`（`dsh-client-ui-layout` 的
 * `[data-windows-titlebar] .centerCol`）。桌面壳的标题栏在 iframe 之外，该属性在本仓
 * 永不存在——中栏一旦保持透明，整块右栏（插件页一并）就会露出布局帧的侧栏底色，
 * 圆角也无从渲染。这里按生成 CSS 断言等价声明存在，且不再依赖无人写入的标记选择器。
 */
describe('center column surface', () => {
  const css = globalStyle.render()

  it('中栏按类名后缀以别名底色绘制并带左上 16px 圆角', () => {
    expect(css).toMatch(
      /\[class\$="centerCol"\]\s*\{[^}]*background:\s*var\(--dsw-alias-bg-base\);[^}]*border-radius:\s*16px 0 0 0;[^}]*corner-shape:\s*round;[^}]*\}/,
    )
  })

  it('中栏规则不再依赖运行时无人写入的 data-dsh-center-col 标记', () => {
    expect(css).not.toContain('data-dsh-center-col')
  })
})
