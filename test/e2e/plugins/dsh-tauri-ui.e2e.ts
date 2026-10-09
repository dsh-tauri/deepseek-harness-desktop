/**
 * 批次 06 · `dsh-tauri-ui` 宿主路由与设置侧栏（契约见 `docs/specs/plugin.test.md`）。
 *
 * 宿主侧只覆盖续跑路由的两条拒绝分支：缺参（400）与会话不存在（404）。断言对象是外部
 * 世界（HTTP 状态码与响应字节），不采信插件自报；`error` 文案必须逐字相等，否则
 * 「路由在跑」与「路由换了实现」在测试里不可区分。
 *
 * 复用 globalSetup 的共享宿主（`also` 默认已挂载本插件），不另起进程。
 * 运行中 / 已正常结束（409）与两条注入失败（500：loader 缺失 / `dsh-llm` 导出缺失）都需要
 * 真实会话，scratch 宿主无造会话手段，保持待补。
 */

import type { Browser } from 'playwright'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import {
  COMPOSER_CARD,
  expectNoSyntheticFallbacks,
  launchDshBrowser,
  newDshPage,
  openSettings,
  SETTINGS_SIDEBAR,
  SETTINGS_TRIGGER,
} from '../support/browser'

/** 与 `packages/dsh-tauri-ui/src/host/server/index.ts:6` 的会话恢复路由对齐。 */
const RESUME_PATH = '/api/tauri/ui/session/resume'

/** 未分组目录解析路由（`packages/dsh-tauri-ui/src/host/server/ungrouped/get.ts`）。 */
const UNGROUPED_PATH = '/api/tauri/ui/ungrouped'

/** `/api/**` 要求浏览器会话；Cookie 由编排在根路径用一次性 token 换得。 */
function headers(): Record<string, string> {
  return { 'cookie': inject('dshCookie'), 'content-type': 'application/json' }
}

/** 插件接管后的英雄区工作区 chip（`ui/hero-workspace.tsx` 渲染）。 */
const HERO_WORKSPACE_CHIP = '[data-hero-workspace]'

/**
 * 官方英雄区工作区 chip：与插件 chip 共用 aria-label（官方 conversation 词典 `hero.chooseWorkspace`），
 * 用 `:not([data-hero-workspace])` 把两者分开。官方行类名取自官方 ConversationRoot 模块。
 */
const OFFICIAL_HERO_WORKSPACE_CHIP = '[class$="heroWorkspaceRow"] button[aria-label="选择工作区"]:not([data-hero-workspace])'

/**
 * 官方侧边栏「新建会话」按钮（官方 sidebar 词典 `session.new.label`）。
 *
 * 品牌按钮与工具栏按钮共用这条文案，两者都是「新建会话」入口；按可见性取第一枚即可——
 * 用例先断言它们全都在侧边栏内，确保点到的不是别的控件。
 */
const SIDEBAR_NEW_SESSION = 'button[aria-label="新建会话"]:visible'

function url(): string {
  return `${inject('dshBaseUrl')}${RESUME_PATH}`
}

interface ResumeBody {
  error?: string
  ok?: boolean
}

interface UngroupedBody {
  cwd?: string
  error?: string
}

describe('L2 宿主路由', () => {
  it('[反向] 验证续跑缺 sessionId 返回 400', async () => {
    const response = await fetch(url(), { method: 'POST', headers: headers(), body: '{}' })

    expect(response.status, '缺参必须在读体后立刻以 400 结束').toBe(400)

    const body = await response.json() as ResumeBody
    expect(body.error, '缺参文案必须逐字相等，才能与其它 400 区分').toBe('缺少 sessionId')
    expect(JSON.stringify(body), '缺参不得走到注入成功分支').not.toContain('"ok":true')
  })

  it('[反向] 验证未知会话返回 404', async () => {
    const response = await fetch(url(), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ sessionId: 'does-not-exist' }),
    })

    expect(response.status, '会话不存在必须是 404，而不是 500（服务内部抛错）').toBe(404)

    const body = await response.json() as ResumeBody
    expect(body.error, '会话不存在文案必须逐字相等').toBe('会话不存在或尚未运行')
    expect(JSON.stringify(body), '未知会话不得走到注入成功分支').not.toContain('"ok":true')
  })

  it('验证未分组目录解析路由落在 scratch DSH_HOME 下的 ungrouped，且不是核心安装目录', async () => {
    const home = inject('dshHome')
    const response = await fetch(`${inject('dshBaseUrl')}${UNGROUPED_PATH}`, { headers: headers() })

    expect(response.status, '目录解析是只读推导，必须 200').toBe(200)

    const body = await response.json() as UngroupedBody
    expect(Object.keys(body).sort(), '成功响应必须恰为 cwd 一个字段').toEqual(['cwd'])
    expect(typeof body.cwd, 'cwd 必须是字符串路径').toBe('string')
    expect(body.cwd, 'cwd 必须是绝对路径').toMatch(/^[A-Z]:\\|^\//)
    // 症状本身：桌面壳把 dsh 进程的 cwd 固定为核心安装目录（`dependencies/dsh`），
    // 不显式给 cwd 的未分组会话就会落进那个目录，形成伪项目分组。
    expect(body.cwd, '必须落在宿主自己的 DSH_HOME 之下，而不是进程 cwd（核心安装目录）').not.toMatch(/dependencies[\\/]dsh$/)
    expect(
      String(body.cwd).startsWith(home),
      `cwd 必须位于 scratch DSH_HOME 之下（实测 cwd=${String(body.cwd)} home=${home}）`,
    ).toBe(true)
    expect(String(body.cwd).split(/[\\/]/).at(-1), '未分组目录名必须是 ungrouped').toBe('ungrouped')
    expect(body.error, '成功响应不得带 error').toBeUndefined()
  })
})

describe('L2 客户端', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await launchDshBrowser()
  })

  afterAll(async () => {
    await browser.close()
  })

  it('验证设置侧栏与触发器被注入 dsh 界面', async () => {
    const app = await newDshPage(browser, { ready: SETTINGS_TRIGGER })
    try {
      const triggerHost = await app.frame.evaluate(() => {
        const trigger = document.querySelector('[data-settings-trigger]')
        const sidebar = document.querySelector('[data-slot="sidebar"]')
        return {
          triggerInsideSidebar: Boolean(trigger && sidebar?.contains(trigger)),
          triggerTag: trigger?.tagName,
        }
      })
      expect(triggerHost.triggerInsideSidebar, '设置触发器必须是侧栏内的原生按钮').toBe(true)
      expect(triggerHost.triggerTag, '触发器必须是 button').toBe('BUTTON')

      await openSettings(app.page, app.frame, app.syntheticFallbacks)

      const state = await app.frame.evaluate(() => {
        const root = document.querySelector('[data-slot-sidebar="dsh-tauri-ui"]')
        const nav = root?.querySelector('nav')
        return {
          rootCount: document.querySelectorAll('[data-slot-sidebar="dsh-tauri-ui"]').length,
          hasSearch: root?.querySelector('input') !== null,
          navLabels: Array.from(nav?.querySelectorAll('button') ?? []).map(button => button.textContent?.trim()),
          railWidth: root === null ? null : Math.round((root.firstElementChild as HTMLElement).getBoundingClientRect().width),
        }
      })

      expect(state.rootCount, '设置侧栏标记必须唯一').toBe(1)
      expect(state.hasSearch, '设置侧栏必须带搜索框').toBe(true)
      expect(state.navLabels.length, '设置侧栏必须至少渲染一个导航项').toBeGreaterThan(0)
      expect(state.navLabels, '插件分区与核心分区必须同时出现在同一侧栏').toContain('宠物')
      expect(state.navLabels, '本插件提供的设置分区必须在同一侧栏').toContain('插件')
      expect(state.railWidth, '侧栏宽度必须落在插件声明的 264–420px 夹紧区间内（插件不覆写宿主宽度）')
        .toBeGreaterThanOrEqual(264)
      expect(state.railWidth!).toBeLessThanOrEqual(420)
      expectNoSyntheticFallbacks(app)
      expect(app.errors, '侧栏注入不得抛出应用级错误').toEqual([])
    }
    finally {
      await app.close()
    }
  })

  it('验证触发器 aria-expanded 随设置侧栏开合变化', async () => {
    const app = await newDshPage(browser, { ready: SETTINGS_TRIGGER })
    try {
      const trigger = app.frame.locator(SETTINGS_TRIGGER).first()
      expect(await trigger.getAttribute('aria-expanded'), '初始必须为 false').toBe('false')
      expect(await app.frame.locator(SETTINGS_SIDEBAR).count(), '初始不得渲染设置侧栏').toBe(0)

      await openSettings(app.page, app.frame, app.syntheticFallbacks)
      expect(await trigger.getAttribute('aria-expanded'), '首次点击后必须为 true').toBe('true')
      await expect.poll(
        async () => await app.frame.locator(SETTINGS_SIDEBAR).first().isVisible(),
        { timeout: 10_000, message: '展开后设置侧栏必须可见' },
      ).toBe(true)

      // 展开态下设置触发器被设置侧栏整体盖住（`trigger.boundingBox()` 为 null），
      // 收起只能走侧栏自身的 Escape 通道（`sidebar.tsx` 的 keydown 监听）。
      await app.page.keyboard.press('Escape')
      await expect.poll(
        async () => await trigger.getAttribute('aria-expanded'),
        { timeout: 10_000, message: 'Escape 后必须回到 false' },
      ).toBe('false')
      expect(await app.frame.locator(SETTINGS_SIDEBAR).count(), '收起后设置侧栏必须卸载').toBe(0)
      expectNoSyntheticFallbacks(app)
      expect(app.errors, '开合不得抛出应用级错误').toEqual([])
    }
    finally {
      await app.close()
    }
  })

  it('[反向] 验证无可续跑轮次时主按钮不被改写为「继续任务」', async () => {
    const app = await newDshPage(browser, { ready: COMPOSER_CARD })
    try {
      const state = await app.frame.evaluate(() => {
        const card = document.querySelector('[data-composer-card]')
        const buttons = Array.from(card?.querySelectorAll('button') ?? [])
        const primary = buttons[buttons.length - 1]
        return {
          cardExists: card !== null,
          placeholderVisible: card?.querySelector('[data-composer-placeholder]') !== null,
          label: primary?.getAttribute('aria-label') ?? null,
          svgWidth: primary?.querySelector('svg')?.style.width ?? null,
        }
      })

      expect(state.cardExists, 'composer 卡片必须存在（否则这条断言没有目标）').toBe(true)
      expect(state.placeholderVisible, 'scratch 宿主无活动会话，草稿必然为空').toBe(true)
      expect(state.label, '没有可续跑轮次时不得把主按钮改写成「继续任务」').not.toBe('继续任务')
      expect(state.svgWidth, '未被补丁改写时不得带补丁的 14px 内联宽度').not.toBe('14px')
      expect(app.errors, '补丁在无匹配轮次时必须静默').toEqual([])
    }
    finally {
      await app.close()
    }
  })

  it('验证空草稿下并发保护不启用发送按钮', async () => {
    const app = await newDshPage(browser, { ready: COMPOSER_CARD })
    try {
      const state = await app.frame.evaluate(() => {
        const card = document.querySelector('[data-composer-card]')
        const buttons = Array.from(card?.querySelectorAll('button') ?? [])
        const primary = buttons[buttons.length - 1] as HTMLButtonElement | undefined
        const placeholder = card?.querySelector('[data-composer-placeholder]')
        return {
          empty: placeholder !== null,
          disabled: primary?.disabled ?? null,
          label: primary?.getAttribute('aria-label') ?? null,
        }
      })

      expect(state.empty, '夹具前置：草稿必须为空').toBe(true)
      expect(state.disabled, '空草稿的主按钮必须保持不可点击').toBe(true)
      expect(state.label, '空草稿的按钮文案必须是官方文案').not.toBe('继续任务')
      expect(app.errors, '空草稿不得触发补丁异常').toEqual([])
    }
    finally {
      await app.close()
    }
  })

  it('验证英雄区工作区选择被插件接管，官方 chip 让位且菜单首位是「未分组」', async () => {
    const app = await newDshPage(browser, { ready: HERO_WORKSPACE_CHIP })
    try {
      // 官方 chip 与插件 chip 共用 aria-label（官方 conversation 词典 `hero.chooseWorkspace`），
      // 用类名把两者分开：官方那枚必须仍在 DOM 里（接管失败时可原样回来）但被样式隐藏。
      const chips = await app.frame.evaluate((officialSelector) => {
        const row = document.querySelector('[class$="heroWorkspaceRow"]')
        const official = row?.querySelector(officialSelector) ?? null
        return {
          rowExists: row !== null,
          officialInRow: official !== null,
          officialDisplay: official === null ? null : getComputedStyle(official).display,
          oursInRow: row?.querySelector('[data-hero-workspace]') !== null,
          oursCount: document.querySelectorAll('[data-hero-workspace]').length,
        }
      }, OFFICIAL_HERO_WORKSPACE_CHIP)

      expect(chips.rowExists, '英雄区工作区行必须存在（否则这条断言没有目标）').toBe(true)
      expect(chips.officialInRow, '官方 chip 必须仍在 DOM 中：接管条目退位时要能原样回来').toBe(true)
      expect(chips.officialDisplay, '官方 chip 必须被隐藏，否则会出现两枚选择控件').toBe('none')
      expect(chips.oursInRow, '接管后的 chip 必须渲染在官方同一行内').toBe(true)
      expect(chips.oursCount, '接管后的 chip 必须唯一').toBe(1)

      const capability = await app.frame.evaluate(() => document.documentElement.getAttribute('data-dsh-composer-cwd'))
      expect(capability, '桌面壳 composer 补丁的能力标记必须到位（「未分组」入口的前置，缺失即退级禁用）').toBe('1')

      await app.frame.locator(HERO_WORKSPACE_CHIP).click()

      // 只认当前**可见**的菜单：文档里可能同时挂着别的已挂载菜单（portal 到 body），
      // 不限定范围会把别的菜单条目当成这条选择器的结果。
      const menu = await app.frame.evaluate(() => {
        const chip = document.querySelector('[data-hero-workspace]')
        const menus = Array.from(document.querySelectorAll('[role="menu"]'))
          .filter(menu => menu.getClientRects().length > 0)
        const items = Array.from(menus[0]?.querySelectorAll('button[role="menuitem"]') ?? []) as HTMLButtonElement[]
        const anchor = chip?.getBoundingClientRect() ?? null
        const rect = menus[0]?.getBoundingClientRect() ?? null
        return {
          expanded: chip?.getAttribute('aria-expanded') ?? null,
          visibleMenus: menus.length,
          count: items.length,
          labels: items.map(item => item.textContent?.trim() ?? ''),
          firstDisabled: items[0]?.disabled ?? null,
          visibility: menus[0] === undefined ? null : getComputedStyle(menus[0]).visibility,
          left: rect === null ? null : Math.round(rect.left),
          top: rect === null ? null : Math.round(rect.top),
          width: rect === null ? null : Math.round(rect.width),
          gapBelowChip: rect === null || anchor === null ? null : Math.round(rect.top - anchor.bottom),
          leftOffsetFromChip: rect === null || anchor === null ? null : Math.round(rect.left - anchor.left),
        }
      })

      expect(menu.expanded, '菜单打开时 chip 必须回报 aria-expanded').toBe('true')
      // 定位断言：chip 未把 ref 转交给 button 时 `getAnchorRect()` 恒返回 null，
      // 官方 Menu 会静默跳过定位，菜单留在测量态（内联 `visibility: hidden` + `left/top: 0`）。
      // 只断言「有可见菜单」抓不到这个故障——测量态菜单仍参与布局，同样满足 `getClientRects().length > 0`。
      expect(menu.visibility, '菜单必须完成定位，不得停在测量态').not.toBe('hidden')
      expect(menu.left, '菜单不得停在左上角原点（测量态特征）').toBeGreaterThan(0)
      expect(menu.top, '菜单不得停在左上角原点（测量态特征）').toBeGreaterThan(0)
      expect(menu.width, '菜单必须有真实宽度，而非零尺寸测量态').toBeGreaterThan(0)
      // 几何契约取自官方 primitives 的 portal 定位：`side === 'bottom'` 时 `y = anchor.bottom + 4`，
      // `align === 'start'` 时 `x = anchor.left`，随后各自按 12px 视口边距夹紧。
      expect(menu.gapBelowChip, '菜单必须紧贴 chip 下方').toBeGreaterThanOrEqual(0)
      expect(menu.gapBelowChip, '菜单必须紧贴 chip 下方').toBeLessThanOrEqual(16)
      expect(menu.leftOffsetFromChip, '菜单左缘必须对齐 chip 左缘').toBeGreaterThanOrEqual(0)
      expect(menu.leftOffsetFromChip, '菜单左缘必须对齐 chip 左缘').toBeLessThanOrEqual(12)
      expect(menu.visibleMenus, '打开后必须只有本选择器这一个可见菜单（否则断言对象不确定）').toBe(1)
      expect(menu.count, '打开后必须渲染菜单条目').toBeGreaterThan(0)
      expect(menu.labels[0], '「未分组」必须是第一个选项').toBe('未分组')
      expect(menu.labels.filter(label => label === '未分组'), '「未分组」只能出现一次').toHaveLength(1)
      expect(menu.firstDisabled, '目录流程空闲时「未分组」必须可选').toBe(false)
      expectNoSyntheticFallbacks(app)
      expect(app.errors, '接管英雄区选择控件不得抛出应用级错误').toEqual([])
    }
    finally {
      await app.close()
    }
  })

  it('验证侧边栏「新建会话」默认落到未分组，不再强制先选工作区', async () => {
    const app = await newDshPage(browser, { ready: HERO_WORKSPACE_CHIP })
    try {
      const before = await app.frame.evaluate(() => ({
        inert: document.querySelector('[data-composer-card] [aria-label="选择工作区"]') !== null,
      }))
      expect(before.inert, '夹具前置：没有会话时 composer 是官方的「选择工作区」触发器').toBe(true)

      // 品牌按钮与工具栏按钮共用 aria-label（官方 sidebar 词典 `session.new.label`），两者都是
      // 「新建会话」入口、都该走未分组；工作区分组行的「+」是另一条带工作区名字的文案，
      // 必须不在其中——否则本用例点到的就不是「侧边栏新建会话」。
      const newSessionButtons = await app.frame.evaluate(() => {
        const sidebar = document.querySelector('[data-slot="sidebar"]')
        const visible = Array.from(document.querySelectorAll('button[aria-label="新建会话"]'))
          .filter(button => button.getClientRects().length > 0)
        return {
          count: visible.length,
          allInSidebar: visible.every(button => sidebar?.contains(button) === true),
        }
      })
      expect(newSessionButtons.count, '夹具前置：侧边栏必须有可见的「新建会话」入口').toBeGreaterThan(0)
      expect(newSessionButtons.allInSidebar, '该 aria-label 的按钮必须都在侧边栏内（分组行「+」用的是另一条文案）').toBe(true)

      await app.frame.locator(SIDEBAR_NEW_SESSION).first().click()

      await expect.poll(
        async () => await app.frame.evaluate(() => document.querySelector('[data-hero-workspace]')?.textContent?.trim() ?? null),
        { timeout: 20_000, message: '新建会话后 chip 必须显示「未分组」' },
      ).toBe('未分组')

      // composer 是否仍停在官方的「选择工作区」不可用态：宿主回填 cwd 后必然解除。
      await expect.poll(
        async () => await app.frame.evaluate(() => document.querySelector('[data-composer-card] [aria-label="选择工作区"]') !== null),
        { timeout: 20_000, message: '会话已就位，composer 不得再停在「必须先选工作区」的不可用态' },
      ).toBe(false)

      expectNoSyntheticFallbacks(app)
      expect(app.errors, '未分组新建会话不得抛出应用级错误').toEqual([])
    }
    finally {
      await app.close()
    }
  })

  // chip 文案依赖官方列表快照的 `current` 投影，与本用例的观测面（磁盘）无关，因此独立成条：
  // 即便 chip 断言在别的环境里失败，cwd 的端到端证据仍然会执行。
  it('验证未分组新会话的 cwd 落在 scratch DSH_HOME/ungrouped，而非宿主进程 cwd', async () => {
    const home = inject('dshHome')
    const app = await newDshPage(browser, { ready: HERO_WORKSPACE_CHIP })
    try {
      await app.frame.locator(SIDEBAR_NEW_SESSION).first().click()

      // 会话的项目目录由 cwd 决定，而空白会话尚未落盘（persistence 的 materialize 只在
      // 首个事件批次时发生），因此磁盘上能观测到的最早产物是宿主建会话前的
      // `mkdir -p cwd`（`dsh-api-session-controller` 的 ensureSession）。不显式传 cwd 时
      // 宿主退回 `process.cwd()`——那是既有目录，绝不会新建出 ungrouped。
      await expect.poll(
        () => existsSync(join(home, 'ungrouped')),
        { timeout: 20_000, message: '未分组会话的 cwd 必须是 DSH_HOME/ungrouped（宿主据此目录建会话）' },
      ).toBe(true)

      // 反向证据：宿主进程 cwd（scratch 车道里是 profile 目录 `<home>/profiles/web`）不得
      // 出现会话痕迹。空白会话尚未 materialize，所以这里断言的是「没有它的项目目录」。
      const sessionsRoot = join(home, 'sessions')
      const projectDirs = existsSync(sessionsRoot) ? readdirSync(sessionsRoot) : []
      expect(projectDirs.filter(entry => entry.includes('profiles-web')), '未分组会话不得落进宿主进程 cwd 对应的项目目录').toEqual([])

      expectNoSyntheticFallbacks(app)
      expect(app.errors, '未分组新会话不得抛出应用级错误').toEqual([])
    }
    finally {
      await app.close()
    }
  })

  /**
   * 样式的**归属**是宿主回收的前提（issue #655）。
   *
   * 宿主的客户端模块系统在每个插件 factory 物化后调 `claimStyles`：把文档里所有没有
   * `data-plugin` 的 `<style>` 盖上「刚物化的那个插件」的戳，之后该插件重载
   * （`removeOwnedStyles`）就把它们一并删掉。css-render 只写 `cssr-id`，不自报归属的
   * 表会被别的插件收养、再被别人的重载误删；而插件的引用计数还停在 >0，样式不会回挂——
   * 症状就是用户报的「偶发 UI 整体混乱，刷新才好」。断言对象是真实页面里的 DOM。
   */
  it('验证插件 cssr 样式标签都自报 data-plugin 归属，不会被别人的重载连带删除', async () => {
    const app = await newDshPage(browser, { ready: SETTINGS_TRIGGER })
    try {
      const ownership = await app.frame.evaluate(() => {
        const tags = Array.from(document.querySelectorAll('style[cssr-id]'))
        return {
          total: tags.length,
          untagged: tags.filter(tag => !tag.hasAttribute('data-plugin')).map(tag => tag.getAttribute('cssr-id')),
        }
      })

      expect(ownership.total, '前置：本批插件必须真的挂上了 cssr 样式表，否则这条断言无从谈起').toBeGreaterThan(0)
      expect(
        ownership.untagged,
        `未自报归属的 cssr 标签会被 claimStyles 认领给下一个物化的插件，再被它的 removeOwnedStyles 删除（实测未归属：${JSON.stringify(ownership.untagged)}）`,
      ).toEqual([])
      expect(app.errors, '样式归属不得抛出应用级错误').toEqual([])
    }
    finally {
      await app.close()
    }
  })
})
