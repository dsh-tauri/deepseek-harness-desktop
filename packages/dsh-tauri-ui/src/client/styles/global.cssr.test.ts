// @vitest-environment jsdom
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'
import globalStyle from './global.cssr'

it('始终隐藏 better-sidebar 的 dock fallback 入口', () => {
  const rules = postcss.parse(globalStyle.render()).nodes.filter(node =>
    node.type === 'rule' && node.selector === '[data-dsh-dock-fallback]',
  )
  expect(rules).toMatchObject([{
    nodes: [{ type: 'decl', prop: 'display', value: 'none', important: true }],
  }])
})

describe('desktop settings page width', () => {
  function declarationsFor(markup: string, target: string, property: string): string[] {
    const fixture = document.createElement('div')
    fixture.innerHTML = markup
    const element = fixture.querySelector(target)!
    const declarations: string[] = []
    postcss.parse(globalStyle.render()).walkRules((rule) => {
      if (rule.selector.includes('settings') && element.matches(rule.selector)) {
        rule.walkDecls(property, (declaration) => {
          declarations.push(`${declaration.value}${declaration.important ? ' !important' : ''}`)
        })
      }
    })
    return declarations
  }

  const officialPages = `
    <div data-slot="settings.section" style="display:contents">
      <div id="plugins" class="pbvGtq_section">
        <div class="pbvGtq_panel">
          <div data-slot="settings.plugins.tab" style="display:contents">
            <div id="inventory" class="qSYn7G_section"><div id="card" class="qSYn7G_card"></div></div>
          </div>
        </div>
      </div>
      <section id="presets" class="rtSEdW_section"><section id="group" class="rtSEdW_group"></section></section>
      <div id="general"><div id="control"></div></div>
    </div>`
  const desktop = `<div data-slot-sidebar="dsh-tauri-ui">${officialPages}</div>`

  it.each(['plugins', 'inventory', 'presets', 'general'])('desktop settings root %s delegates width to the sidebar container', (id) => {
    expect(declarationsFor(desktop, `#${id}`, 'max-width')).toEqual(['none !important'])
  })

  it.each(['plugins', 'presets', 'general'])('desktop settings root %s retains its bottom clearance', (id) => {
    expect(declarationsFor(desktop, `#${id}`, 'padding-bottom')).toEqual(['24px'])
  })

  it.each(['card', 'group', 'control'])('nested settings content %s keeps its own width constraints', (id) => {
    expect(declarationsFor(desktop, `#${id}`, 'max-width')).toEqual([])
  })

  it('nested inventory does not receive a second page bottom clearance', () => {
    expect(declarationsFor(desktop, '#inventory', 'padding-bottom')).toEqual([])
  })

  it.each(['plugins', 'inventory', 'presets', 'general'])('official settings root %s outside the desktop sidebar is unchanged', (id) => {
    expect(declarationsFor(officialPages, `#${id}`, 'max-width')).toEqual([])
    expect(declarationsFor(officialPages, `#${id}`, 'padding-bottom')).toEqual([])
  })

  it('a plugin tab outside the settings section keeps its width limit', () => {
    const markup = '<div data-slot-sidebar="dsh-tauri-ui"><div data-slot="settings.plugins.tab"><div id="tab"></div></div><section id="ordinary"></section></div>'
    expect(declarationsFor(markup, '#tab', 'max-width')).toEqual([])
    expect(declarationsFor(markup, '#ordinary', 'max-width')).toEqual([])
  })

  it('the plugin manager page outside settings keeps its own child width limits', () => {
    expect(declarationsFor('<div data-slot="main"><div class="X_2TxG_page"><div id="manager"></div></div></div>', '#manager', 'max-width')).toEqual([])
  })
})

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
 * 官方侧边栏 toggle 契约。
 *
 * 本表在所有客户端加载；远程网页与 App 没有桌面壳 navbar，官方 toggle 是唯一的侧栏开关。
 * 桌面 iframe 里的重复入口由 dsh-tauri 的 `register/sidebar-tweaks.ts` 按文案隐藏。
 */
describe('official sidebar toggle', () => {
  function toggleDisplay(markup: string): string[] {
    const fixture = document.createElement('div')
    fixture.innerHTML = markup
    const toggle = fixture.querySelector('[class$="_toggle"]')!
    const values: string[] = []
    postcss.parse(globalStyle.render()).walkRules(/logoRow|toggle|iconButton/, (rule) => {
      if (toggle.matches(rule.selector)) {
        rule.walkDecls('display', (decl) => {
          values.push(decl.value)
        })
      }
    })
    return values
  }

  it('展开态的折叠按钮不被全局表隐藏', () => {
    expect(toggleDisplay(`
      <div class="hHd-Xa_root">
        <div class="hHd-Xa_logoRow">
          <button class="hHd-Xa_brand hHd-Xa_wide" aria-label="New session"></button>
          <button class="hHd-Xa_iconButton hHd-Xa_toggle" aria-label="Collapse sidebar"></button>
        </div>
      </div>
    `)).toEqual([])
  })

  it('折叠轨道的展开按钮不被全局表改写 display', () => {
    expect(toggleDisplay(`
      <div class="hHd-Xa_root hHd-Xa_collapsed">
        <div class="hHd-Xa_logoRow">
          <button class="hHd-Xa_iconButton hHd-Xa_toggle" aria-label="Open sidebar"></button>
        </div>
      </div>
    `)).toEqual([])
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

  it('可见聊天行保留屏外渲染与尺寸记忆，向左扩展绘制盒且不移动正文（issue #1085）', () => {
    expect(rules['[data-chat-flow] > [data-chat-anchor-key]:not([hidden])']).toEqual({
      'content-visibility': 'auto',
      'contain-intrinsic-size': 'auto 320px',
      'padding-left': '24px',
      'margin-left': '-24px',
    })
  })

  it('隐藏聊天节点不匹配渲染优化，展开后重新匹配（issue #1023）', () => {
    const flow = document.createElement('div')
    flow.setAttribute('data-chat-flow', '')
    const node = document.createElement('div')
    node.setAttribute('data-chat-anchor-key', '')
    flow.append(node)
    document.body.append(flow)
    try {
      const optimized = Object.keys(rules).filter(selector =>
        'content-visibility' in rules[selector] || 'contain-intrinsic-size' in rules[selector],
      )
      expect(optimized.filter(selector => node.matches(selector))).toHaveLength(1)
      for (const hidden of ['until-found', '', 'hidden']) {
        node.setAttribute('hidden', hidden)
        expect(optimized.filter(selector => node.matches(selector)), `hidden="${hidden}"`).toEqual([])
      }
      node.removeAttribute('hidden')
      expect(optimized.filter(selector => node.matches(selector))).toHaveLength(1)
    }
    finally {
      flow.remove()
    }
  })

  it('只移除带 continue 标记的外层聊天节点，不留下间距', () => {
    expect(rules['[data-chat-flow-key]:has(> [data-slot="conversation.chat.node"] > [data-dsh-tauri-ui-continue-notice])']).toEqual({ display: 'none' })
  })

  it('不把内容整块藏起来（保浏览器查找与无障碍树）', () => {
    expect(globalStyle.render()).not.toMatch(/content-visibility:\s*hidden/)
  })
})
