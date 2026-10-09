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

/**
 * 聊天流屏外渲染契约。
 *
 * 官方 `ChatView` 把整条会话的节点全量挂在 `[data-chat-flow]` 列里，没有滚动虚拟化：
 * 每个节点是列的直接子元素 `[data-chat-anchor-key]`（`flowItem`）。长会话因此把上千棵
 * markdown 与工具卡片子树留在文档里，布局与绘制开销随会话长度线性增长。本仓不动 DOM
 * 与产品逻辑，把浏览器原生的 `content-visibility: auto` 交给这些节点：屏外节点跳过
 * 布局与绘制，滚回来仍按真实尺寸渲染；`contain-intrinsic-size` 的 `auto` 关键字让浏览器
 * 记住上次渲染尺寸，只有首次滚过用估算值，避免把滚动位置顶偏。这里按生成 CSS 断言规则
 * 只做「跳过渲染」，不得用 `hidden`（那会让屏外内容在浏览器查找与无障碍树里消失）。
 */
describe('chat flow off-screen rendering', () => {
  const rules: Record<string, Record<string, string>> = {}
  postcss.parse(globalStyle.render()).walkRules((rule) => {
    if (rule.selector.includes('data-chat-flow')) {
      rules[rule.selector] = {}
      rule.walkDecls((decl) => {
        rules[rule.selector][decl.prop] = decl.value
      })
    }
  })

  it('对聊天流锚点启用原生屏外跳过渲染并保留尺寸记忆', () => {
    expect(rules['[data-chat-flow] > [data-chat-anchor-key]']).toEqual({
      'content-visibility': 'auto',
      'contain-intrinsic-size': 'auto 320px',
    })
  })

  it('只移除带 continue 标记的外层聊天节点，不留下间距', () => {
    expect(rules['[data-chat-flow-key]:has(> [data-slot="conversation.chat.node"] > [data-dsh-tauri-ui-continue-notice])']).toEqual({ display: 'none' })
  })

  it('不把内容整块藏起来（保浏览器查找与无障碍树）', () => {
    expect(globalStyle.render()).not.toMatch(/content-visibility:\s*hidden/)
  })
})
