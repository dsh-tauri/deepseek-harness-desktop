import type { Browser } from 'playwright'
import type { DshPage } from '../../../../apps/desktop/tests/e2e/support/browser'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { expectNoSyntheticFallbacks, launchDshBrowser, newDshPage } from '../../../../apps/desktop/tests/e2e/support/browser'

const ROUTE_PREFIX = '/api/tauri/extension'

interface ErrorBody {
  error?: string
}

interface SkillsBody {
  skills?: SkillRow[]
  error?: string
}

interface SkillRow {
  name?: unknown
}

interface McpListBody {
  servers?: unknown[]
  restartNeeded?: boolean
  error?: string
}

interface SkillDetailBody {
  name?: string
  content?: string
  error?: string
}

interface ImportScanBody {
  servers?: unknown[]
  existing?: unknown[]
  error?: string
}

interface ImportApplyBody {
  ok?: boolean
  results?: unknown[]
  restartNeeded?: boolean
  error?: string
}

interface RootsBody {
  roots?: unknown[]
  error?: string
}

function skillNames(rows: SkillRow[] | undefined): string[] {
  return (rows ?? []).map(row => String(row.name)).sort()
}

function apiUrl(path: string): string {
  return `${inject('dshBaseUrl')}${ROUTE_PREFIX}${path}`
}

function apiHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { cookie: inject('dshCookie'), ...extra }
}

function jsonHeaders(): Record<string, string> {
  return apiHeaders({ 'content-type': 'application/json' })
}

function patchFilePath(): string {
  return join(inject('dshHome'), 'profiles', 'web', 'cordis.patch.yml')
}

function readPatchFile(): string | null {
  const path = patchFilePath()
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

describe('extension 宿主路由', () => {
  it('验证技能清单返回数组结构且不含错误', async () => {
    const response = await fetch(apiUrl('/skills'), { headers: apiHeaders() })

    expect(response.status, '技能清单必须可读').toBe(200)

    const body = await response.json() as SkillsBody
    expect(Array.isArray(body.skills), '响应体必须带 skills 数组字段').toBe(true)
    expect(body.error, '成功路径不得带 error 字段').toBeUndefined()
    expect(body.skills?.every(row => typeof row.name === 'string'), '每行必须带技能名').toBe(true)
  })

  it('[反向] 验证查询不存在的技能返回 404', async () => {
    const response = await fetch(apiUrl('/skill?name=definitely-missing'), { headers: apiHeaders() })

    expect(response.status, '不存在的技能必须 404').toBe(404)

    const body = await response.json() as ErrorBody
    expect(body.error, '404 的领域文案必须精确').toBe('skill not found')
  })

  it('验证 MCP 列表结构固定且按宿主热加载能力标记', async () => {
    const response = await fetch(apiUrl('/mcp'), { headers: apiHeaders() })

    expect(response.status, 'MCP 列表必须可读').toBe(200)

    const body = await response.json() as McpListBody
    expect(Array.isArray(body.servers), '响应体必须带 servers 数组字段').toBe(true)
    expect(typeof body.restartNeeded, 'restartNeeded 必须是布尔标记').toBe('boolean')
    expect(body.restartNeeded, '共享宿主已挂载 hmr 服务，MCP 变更无需重启').toBe(false)
    expect(body.error, '成功路径不得带 error 字段').toBeUndefined()
  })

  it('[反向] 验证 MCP 删除缺 id 返回 400', async () => {
    const before = readPatchFile()
    expect(before, '夹具前置：patch 文件必须由脚手架产出').not.toBeNull()

    const response = await fetch(apiUrl('/mcp'), {
      method: 'DELETE',
      headers: jsonHeaders(),
      body: '{}',
    })

    expect(response.status, '缺 id 必须 400').toBe(400)

    const body = await response.json() as ErrorBody
    expect(body.error, '400 的领域文案必须精确').toBe('id is required')
    expect(body.error, '拒绝的请求不得进入删除分支').not.toContain('not found')
    expect(readPatchFile(), '被拒的删除不得改写 patch 文件').toBe(before)
  })

  it('[反向] 验证 MCP 切换缺字段返回 400', async () => {
    const response = await fetch(apiUrl('/mcp/toggle'), {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ id: 'x' }),
    })

    expect(response.status, '缺 disabled 必须 400').toBe(400)

    const body = await response.json() as ErrorBody
    expect(body.error, '400 的领域文案必须精确').toBe('id and disabled are required')
  })

  it('[反向] 验证打开目录的未知 target 被拒', async () => {
    const response = await fetch(apiUrl('/open/dir'), {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ target: 'unknown-target' }),
    })

    expect(response.status, '白名单外的 target 必须 400').toBe(400)

    const body = await response.json() as ErrorBody
    expect(body.error, '400 的领域文案必须精确').toBe('unknown target')
    expect(JSON.stringify(body), '拒绝的请求不得回报打开成功').not.toContain('"ok"')
  })

  it('[反向] 验证技能根创建只接受 local / git', async () => {
    const response = await fetch(apiUrl('/roots'), {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ kind: 'svn', path: '/tmp' }),
    })

    expect(response.status, '未知 kind 必须 400').toBe(400)

    const body = await response.json() as ErrorBody
    expect(body.error, '400 的领域文案必须精确').toBe('kind must be local or git')
    expect(body.error, '拒绝的请求不得落到缺 path / url 的分支').not.toContain('is required')
  })

  it('[反向] 验证宿主重启在本机无来源头时被拒', async () => {
    const alive = await fetch(apiUrl('/skills'), { headers: apiHeaders() })
    expect(alive.status, '重启前的宿主必须可用').toBe(200)

    const response = await fetch(apiUrl('/host/restart'), {
      method: 'POST',
      headers: jsonHeaders(),
      body: '{}',
    })

    expect(response.status, '无 Origin 的重启请求必须 403').toBe(403)

    const body = await response.json() as ErrorBody
    expect(body.error, '拒绝必须点明来源不可信').toBe('untrusted origin')
    expect(JSON.stringify(body), '被拒的重启不得回报 ok / pid').not.toContain('pid')

    const after = await fetch(apiUrl('/skills'), { headers: apiHeaders() })
    expect(after.status, '宿主必须仍由同一实例服务（未被重启）').toBe(200)
  })

  it('[反向] 验证带转发头的重启请求同样被拒', async () => {
    const origin = new URL(inject('dshBaseUrl')).origin

    const response = await fetch(apiUrl('/host/restart'), {
      method: 'POST',
      headers: apiHeaders({
        'content-type': 'application/json',
        'origin': origin,
        'x-forwarded-for': '10.0.0.1',
      }),
      body: '{}',
    })

    expect(response.status, '带转发头的重启请求必须 403').toBe(403)

    const body = await response.json() as ErrorBody
    expect(body.error, '同源 Origin 也救不回转发头').toBe('untrusted origin')
    expect(JSON.stringify(body), '被拒的重启不得回报 ok / pid').not.toContain('pid')
  })

  it('验证技能刷新同步返回与清单同源的新目录', async () => {
    const catalog = await fetch(apiUrl('/skills'), { headers: apiHeaders() })
    expect(catalog.status, '刷新前的技能清单必须可读').toBe(200)

    const before = await catalog.json() as SkillsBody

    const response = await fetch(apiUrl('/skills/refresh'), {
      method: 'POST',
      headers: jsonHeaders(),
      body: '{}',
    })

    expect(response.status, '刷新必须同步返回重挂载后的目录').toBe(200)

    const body = await response.json() as SkillsBody
    expect(Array.isArray(body.skills), '刷新响应必须带 skills 数组字段').toBe(true)
    expect(body.error, '成功路径不得带 error 字段').toBeUndefined()
    expect(skillNames(body.skills), '刷新不得改变技能目录的构成').toEqual(skillNames(before.skills))
  })

  it('验证按名查询已有技能返回定义与正文', async () => {
    const catalog = await fetch(apiUrl('/skills'), { headers: apiHeaders() })
    const name = ((await catalog.json() as SkillsBody).skills ?? [])
      .map(row => row.name)
      .find((value): value is string => typeof value === 'string')

    expect(typeof name, '夹具前置：运行机用户技能目录必须至少提供一个技能名').toBe('string')

    const response = await fetch(apiUrl(`/skill?name=${encodeURIComponent(name ?? '')}`), { headers: apiHeaders() })

    expect(response.status, '存在的技能必须 200').toBe(200)

    const body = await response.json() as SkillDetailBody
    expect(body.name, '回传的技能名必须与查询参数一致').toBe(name)
    expect(typeof body.content, '技能详情必须带 SKILL.md 正文').toBe('string')
    expect((body.content ?? '').length, '技能正文不得为空').toBeGreaterThan(0)
  })

  it('[反向] 验证保存技能缺 name 返回 400', async () => {
    const response = await fetch(apiUrl('/skill'), {
      method: 'POST',
      headers: jsonHeaders(),
      body: '{}',
    })

    expect(response.status, '空名字必须 400').toBe(400)

    const body = await response.json() as ErrorBody
    expect(body.error, '400 的领域文案必须精确').toBe('name must be kebab-case (a-z, 0-9, dashes)')
    expect(JSON.stringify(body), '被拒的保存不得落到写入分支').not.toContain('"ok"')
  })

  it('[反向] 验证技能策略缺参返回 400', async () => {
    const response = await fetch(apiUrl('/skill/policy'), {
      method: 'POST',
      headers: jsonHeaders(),
      body: '{}',
    })

    expect(response.status, '缺 name / enabled 必须 400').toBe(400)

    const body = await response.json() as ErrorBody
    expect(body.error, '400 的领域文案必须精确').toBe('name and enabled are required')
    expect(body.error, '拒绝的请求不得落到技能文件写入分支').not.toContain('no file on disk')
  })

  it('[反向] 验证新增 MCP 行的非法 serverName 被拒', async () => {
    const before = readPatchFile()
    expect(before, '夹具前置：patch 文件必须由脚手架产出').not.toBeNull()

    const response = await fetch(apiUrl('/mcp'), {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ serverName: '' }),
    })

    expect(response.status, '空 serverName 必须 400').toBe(400)

    const body = await response.json() as ErrorBody
    expect(body.error, '400 的领域文案必须精确').toBe('serverName must be 1-32 chars of A-Z a-z 0-9 _ -')
    expect(readPatchFile(), '被拒的新增不得改写 patch 文件').toBe(before)
  })

  it('[反向] 验证 MCP 探测的缺 id 与未知 id 两类失败', async () => {
    const missingId = await fetch(apiUrl('/mcp/check'), {
      method: 'POST',
      headers: jsonHeaders(),
      body: '{}',
    })

    expect(missingId.status, '缺 id 必须 400').toBe(400)
    expect((await missingId.json() as ErrorBody).error, '缺参文案必须逐字相等').toBe('id is required')

    const unknown = await fetch(apiUrl('/mcp/check'), {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ id: 'definitely-missing' }),
    })

    expect(unknown.status, '未知 id 必须 404，而不是 500（服务内部抛错）').toBe(404)

    const unknownBody = await unknown.json() as ErrorBody
    expect(unknownBody.error, '未知行文案必须逐字相等').toBe('server row not found')
    expect(Object.keys(unknownBody), '没有行可探测时不得回传探测结果').toEqual(['error'])
  })

  it('[反向] 验证复制 MCP 行缺 id 返回 400', async () => {
    const before = readPatchFile()
    expect(before, '夹具前置：patch 文件必须由脚手架产出').not.toBeNull()

    const response = await fetch(apiUrl('/mcp/copy'), {
      method: 'POST',
      headers: jsonHeaders(),
      body: '{}',
    })

    expect(response.status, '缺 id 必须 400').toBe(400)

    const body = await response.json() as ErrorBody
    expect(body.error, '400 的领域文案必须精确').toBe('id is required')
    expect(readPatchFile(), '被拒的复制不得改写 patch 文件').toBe(before)
  })

  it('验证导入扫描返回候选来源与已存在名两份清单', async () => {
    const response = await fetch(apiUrl('/import/scan'), { headers: apiHeaders() })

    expect(response.status, '导入扫描必须可读').toBe(200)

    const body = await response.json() as ImportScanBody
    expect(Array.isArray(body.servers), '响应体必须带 servers 数组字段').toBe(true)
    expect(Array.isArray(body.existing), '响应体必须带 existing 数组字段').toBe(true)
    expect(body.error, '成功路径不得带 error 字段').toBeUndefined()
    expect(
      (body.existing ?? []).every(value => typeof value === 'string'),
      'existing 必须是 MCP server 名清单',
    ).toBe(true)
  })

  it('验证导入应用的空 items 是无写入的无操作分支', async () => {
    const before = readPatchFile()
    expect(before, '夹具前置：patch 文件必须由脚手架产出').not.toBeNull()

    const response = await fetch(apiUrl('/import/apply'), {
      method: 'POST',
      headers: jsonHeaders(),
      body: '{}',
    })

    expect(response.status, '空 items 不得报错，只能无操作返回').toBe(200)

    const body = await response.json() as ImportApplyBody
    expect(body.ok, '无操作分支仍须回报 ok:true').toBe(true)
    expect(body.results, '没有候选行时逐行结果必须为空').toEqual([])
    expect(typeof body.restartNeeded, 'restartNeeded 必须是布尔标记').toBe('boolean')
    expect(body.restartNeeded, '共享宿主已挂载 hmr 服务，变更无需重启').toBe(false)
    expect(readPatchFile(), '空 items 不得改写 patch 文件').toBe(before)
  })

  it('验证技能根清单形状与删除缺参被拒', async () => {
    const response = await fetch(apiUrl('/roots'), { headers: apiHeaders() })

    expect(response.status, '技能根清单必须可读').toBe(200)

    const body = await response.json() as RootsBody
    expect(Array.isArray(body.roots), '响应体必须带 roots 数组字段').toBe(true)
    expect(body.error, '成功路径不得带 error 字段').toBeUndefined()

    const rejected = await fetch(apiUrl('/roots'), {
      method: 'DELETE',
      headers: jsonHeaders(),
      body: '{}',
    })

    expect(rejected.status, '删除技能根缺 id 必须 400').toBe(400)
    expect((await rejected.json() as ErrorBody).error, '400 的领域文案必须精确').toBe('id is required')

    const after = await fetch(apiUrl('/roots'), { headers: apiHeaders() })
    expect(await after.json(), '被拒的删除不得改动技能根清单').toEqual(body)
  })
})

const OFFICIAL_PAGE = '[data-dsh-extension-plugins] [data-plugin-panel]'
const MAIN_HEADER = 'header:has(> div:first-child > h1)'
const BACK = '[data-dsh-plugins-back]'

let browser: Browser
beforeAll(async () => {
  browser = await launchDshBrowser()
})
afterAll(async () => {
  await browser?.close()
})

async function openPlugins(app: DshPage, touch = false): Promise<void> {
  if (touch) {
    await app.frame.locator('[data-dsh-mobile-sidebar-toggle]').tap()
    await expect.poll(() => app.frame.locator('html[data-dsh-mobile-sidebar-open]').count(), { message: '触屏侧栏必须真实展开' }).toBe(1)
    const row = app.frame.getByRole('button', { name: '插件扩展', exact: true })
    await row.tap()
    await expect.poll(() => row.getAttribute('aria-current'), { message: '触屏点击必须真实激活插件扩展入口' }).toBe('page')
    await app.frame.locator(OFFICIAL_PAGE).waitFor({ state: 'visible' })
    await app.frame.locator('[data-dsh-mobile-sidebar-shade]').tap()
    await expect.poll(() => app.frame.locator('html[data-dsh-mobile-sidebar-open]').count(), { message: '进入插件面板后必须真实收起触屏侧栏以解除主槽 inert' }).toBe(0)
  }
  else {
    await app.frame.getByRole('button', { name: '插件扩展', exact: true }).click()
  }
  await app.frame.locator(OFFICIAL_PAGE).waitFor({ state: 'visible' })
}

describe('extension panel official plugins composition', () => {
  it('hides the original sidebar row and mounts the official page only while its first tab is active', async () => {
    const app = await newDshPage(browser, { ready: '[data-dsh-hidden-panel="plugins"]' })
    try {
      const originalRow = app.frame.locator('button:has([data-dsh-hidden-panel="plugins"])')
      expect(await originalRow.count(), '原插件入口必须保留注册但隐藏整行').toBe(1)
      expect(await originalRow.evaluate(el => getComputedStyle(el).display), '原插件入口必须隐藏布局').toBe('none')
      expect(await originalRow.isVisible(), '原插件入口不得重复展示').toBe(false)

      await openPlugins(app)
      const tabs = app.frame.getByRole('tablist', { name: '插件扩展' })
      const pluginsTab = tabs.getByRole('tab', { name: '插件', exact: true })
      await expect.poll(() => tabs.getByRole('tab').first().textContent(), { message: '官方插件必须是首个 Tab' }).toBe('插件')
      await expect.poll(() => pluginsTab.getAttribute('aria-selected'), { message: '打开入口必须选中官方插件 Tab' }).toBe('true')

      const officialPage = app.frame.locator(OFFICIAL_PAGE)
      expect(await officialPage.count(), '只能挂载一个真实官方插件页面').toBe(1)
      expect(await officialPage.evaluate((el) => {
        const style = getComputedStyle(el)
        return { padding: style.padding, overflow: style.overflow }
      }), '官方页必须由外层插件面板管理滚动与内边距').toEqual({ padding: '0px', overflow: 'visible' })
      const header = officialPage.locator(MAIN_HEADER)
      expect(await header.evaluate(el => getComputedStyle(el).paddingTop), '两端基线主页页头均不得叠加顶距').toBe('0px')

      const heading = header.locator(':scope > div:first-child > h1')
      const intro = header.locator(':scope > div:first-child > :is(p, div)')
      const titleStyle = await heading.evaluate((el) => {
        const style = getComputedStyle(el)
        return { fontSize: style.fontSize, lineHeight: style.lineHeight, fontWeight: style.fontWeight }
      })
      const introStyle = await intro.evaluate((el) => {
        const style = getComputedStyle(el)
        return { fontSize: style.fontSize, lineHeight: style.lineHeight, color: style.color }
      })
      expect(titleStyle, '官方标题必须使用插件面板的统一字号').toEqual({ fontSize: '16px', lineHeight: '24px', fontWeight: '500' })
      expect(introStyle, '官方简介必须使用插件面板的统一字号').toMatchObject({ fontSize: '12px', lineHeight: '18px' })
      expect(await header.evaluate(el => getComputedStyle(el).rowGap), '主页标题与简介间距必须保持一致').toBe('14px')
      const sparkle = app.frame.locator('[data-dsh-plugins-icon] svg')
      expect(await sparkle.isVisible(), '官方闪光图标必须出现在主页页头').toBe(true)
      expect(await sparkle.getAttribute('width'), '主页图标不得放大').toBe('16')

      await expect.poll(() => officialPage.locator('[data-plugin-item]').count(), { timeout: 15_000, message: '必须加载真实官方插件条目' }).toBeGreaterThan(0)
      await officialPage.locator('[data-plugin-item]').first().getByRole('button').first().click()
      const detail = officialPage.locator('[data-plugin-item-detail]')
      await detail.waitFor({ state: 'visible' })
      const detailTop = detail.locator(':scope > div[data-window-drag]')
      expect(await detailTop.evaluate(el => getComputedStyle(el).paddingTop), '详情顶部间距必须为 12px').toBe('12px')
      expect(await sparkle.isVisible(), '详情页不显示主页图标').toBe(false)
      const detailBack = detail.getByRole('button', { name: '返回插件', exact: true })
      expect(await detailBack.count(), '官方详情必须保留唯一原生返回入口').toBe(1)
      expect(await detailBack.evaluate(el => el.getBoundingClientRect().top - el.closest('[data-plugin-item-detail]')!.getBoundingClientRect().top), '原生返回入口距详情顶部必须真实留出 12px').toBeCloseTo(12, 1)
      expect(await detailBack.getAttribute('data-dsh-plugins-back'), '详情返回不得冒充更多页回退').toBeNull()
      await detailBack.click()
      await header.waitFor({ state: 'visible' })

      await tabs.getByRole('tab', { name: '技能', exact: true }).click()
      const skillsPanel = app.frame.getByRole('tabpanel', { name: '技能', exact: true, includeHidden: true })
      await expect.poll(() => skillsPanel.isVisible(), { message: '技能 Tab 必须正常挂载' }).toBe(true)
      expect(await skillsPanel.locator(':scope > div > div:first-child > h3').evaluate((el) => {
        const style = getComputedStyle(el)
        return { fontSize: style.fontSize, lineHeight: style.lineHeight, fontWeight: style.fontWeight }
      }), '插件标题尺寸必须与技能页一致').toEqual(titleStyle)
      expect(await skillsPanel.locator(':scope > div > p').first().evaluate((el) => {
        const style = getComputedStyle(el)
        return { fontSize: style.fontSize, lineHeight: style.lineHeight, color: style.color }
      }), '插件描述尺寸和颜色必须与技能页一致').toEqual(introStyle)
      await expect.poll(() => app.frame.locator('[data-plugin-panel]').count(), { message: '离开插件 Tab 必须卸载官方页面，不能仅 hidden' }).toBe(0)

      await tabs.getByRole('tab', { name: 'MCP', exact: true }).click()
      expect(await skillsPanel.count(), '其他已访问 Tab 仍须保留挂载').toBe(1)
      expect(await skillsPanel.isVisible(), '非活动技能页必须隐藏').toBe(false)
      await pluginsTab.click()
      await expect.poll(() => officialPage.isVisible(), { message: '切回插件 Tab 必须恢复官方页面' }).toBe(true)
      expect(await originalRow.isVisible(), '原侧栏入口不得因重挂载复现').toBe(false)
      expectNoSyntheticFallbacks(app)
      expect(app.errors, '复用官方页面和切换 Tab 不得产生浏览器错误').toEqual([])
    }
    finally {
      await app.close()
    }
  })

  it.each([
    { name: '桌面', width: 1400, height: 900, touch: false },
    { name: '触屏', width: 399, height: 938, touch: true },
  ])('$name：更多只保留唯一回退，返回原主页且标题、图标和按钮互不遮挡', async ({ width, height, touch }) => {
    const app = await newDshPage(browser, {
      ready: '[data-dsh-hidden-panel="plugins"]',
      viewport: { width, height },
      hasTouch: touch,
      isMobile: touch,
    })
    try {
      await openPlugins(app, touch)
      const officialPage = app.frame.locator(OFFICIAL_PAGE)
      const tabs = app.frame.getByRole('tablist', { name: '插件扩展' })
      const initialTabs = await tabs.getByRole('tab').evaluateAll(elements => elements.map(element => ({ id: element.id, text: element.textContent })))
      const selectedTab = await tabs.getByRole('tab', { selected: true }).getAttribute('id')
      const mainHeader = officialPage.locator(MAIN_HEADER)
      const originalTitle = await mainHeader.locator('h1').textContent()
      const mainGeometry = await officialPage.evaluate((el) => {
        const wrapper = el.closest('[data-dsh-extension-plugins]')!
        const header = el.querySelector(':scope > header')!
        const title = header.querySelector('h1')!
        const icon = wrapper.querySelector('[data-dsh-plugins-icon]')!
        const titleBox = title.getBoundingClientRect()
        const iconBox = icon.getBoundingClientRect()
        return {
          headerPaddingTop: getComputedStyle(header).paddingTop,
          titleCenter: titleBox.top + titleBox.height / 2,
          iconCenter: iconBox.top + iconBox.height / 2,
          titleLeft: titleBox.left,
          iconLeft: iconBox.left,
          iconWidth: iconBox.width,
          titlePaddingLeft: Number.parseFloat(getComputedStyle(title).paddingLeft),
        }
      })
      expect(mainGeometry.headerPaddingTop, '主页页头不得叠加主槽的顶距').toBe('0px')
      expect(Math.abs(mainGeometry.iconCenter - mainGeometry.titleCenter), '闪光图标必须与主页标题同轴').toBeLessThanOrEqual(1)
      expect(mainGeometry.iconLeft, '图标必须落在标题的左内边距内').toBeCloseTo(mainGeometry.titleLeft, 1)
      expect(mainGeometry.iconWidth + 10, '图标盒加 10px 间距必须等于标题的 32px 缩进').toBeCloseTo(mainGeometry.titlePaddingLeft, 1)
      expect(await officialPage.locator(BACK).count(), '主页不得伪造回退按钮').toBe(0)

      const more = officialPage.locator('[data-plugin-group="extensions"]').getByRole('button', { name: '更多', exact: true })
      await expect.poll(() => more.count(), { timeout: 15_000, message: '必须提供唯一真实官方更多入口' }).toBe(1)
      await more.click()
      await officialPage.locator('[data-plugin-group="more"]').waitFor({ state: 'visible' })
      await expect.poll(() => officialPage.locator(BACK).count(), { message: '更多页只能有一个回退按钮' }).toBe(1)
      const back = officialPage.locator(BACK)
      expect(await back.getAttribute('aria-label'), '回退按钮必须有本地化无障碍名称').toBe('回退')
      expect(await back.textContent(), '回退按钮必须显示中文文案').toBe('回退')
      expect(await officialPage.getByRole('button', { name: '回退', exact: true }).count(), '不可有重复的可访问回退入口').toBe(1)
      expect(await back.locator('span').count(), '回退文案不得重复注入').toBe(1)
      expect(await back.locator('svg').count(), '必须保留官方原生回退图标').toBe(1)
      expect(await app.frame.locator('[data-dsh-plugins-icon]').isVisible(), '更多页不得叠加主页闪光图标').toBe(false)
      const geometry = await officialPage.evaluate((el) => {
        const header = el.querySelector(':scope > header')!
        const button = header.querySelector('[data-dsh-plugins-back]')!
        const title = header.querySelector(':scope > h1')!
        const icon = button.querySelector('svg')!
        const label = button.querySelector('span')!
        const rect = (node: Element) => {
          const box = node.getBoundingClientRect()
          return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height }
        }
        return {
          header: rect(header),
          button: rect(button),
          title: rect(title),
          icon: rect(icon),
          label: rect(label),
          titlePadding: getComputedStyle(title).paddingLeft,
          headerPadding: getComputedStyle(header).paddingTop,
        }
      })
      expect(geometry.headerPadding, '更多页页头不得残留主页顶距').toBe('0px')
      expect(geometry.titlePadding, '更多页标题不得残留主页图标缩进').toBe('0px')
      expect(geometry.button.width, '回退按钮必须真实占据可点击空间').toBeGreaterThan(28)
      expect(geometry.label.width, '中文回退文案必须真实可见').toBeGreaterThan(0)
      expect(geometry.icon.width, '官方回退图标必须真实可见').toBeGreaterThan(0)
      expect(geometry.icon.right, '回退图标和中文文案不得相交').toBeLessThanOrEqual(geometry.label.left)
      expect(geometry.button.right + 9, '回退按钮与实验性插件标题必须保留间距且不相交').toBeLessThanOrEqual(geometry.title.left)
      expect(Math.abs((geometry.button.top + geometry.button.bottom - geometry.title.top - geometry.title.bottom) / 2), '回退与更多标题必须同轴').toBeLessThanOrEqual(1)
      expect(geometry.title.right, '更多标题不得越出页头').toBeLessThanOrEqual(geometry.header.right + 1)
      expect(await tabs.getByRole('tab').evaluateAll(elements => elements.map(element => ({ id: element.id, text: element.textContent }))), '进入更多不得重建或改写外层 Tab').toEqual(initialTabs)
      expect(await tabs.getByRole('tab', { selected: true }).getAttribute('id'), '进入更多不得切换外层 Tab').toBe(selectedTab)

      await back.click()
      await mainHeader.waitFor({ state: 'visible' })
      await expect.poll(() => officialPage.locator(BACK).count(), { message: '返回主页必须回收回退标记' }).toBe(0)
      expect(await mainHeader.locator('h1').textContent(), '回退必须返回原官方主页而非重定向到其他面板').toBe(originalTitle)
      expect(await officialPage.locator('[data-plugin-group="more"]').count(), '回退后必须卸载更多页').toBe(0)
      expect(await app.frame.locator('[data-dsh-plugins-icon]').isVisible(), '返回主页必须恢复闪光图标').toBe(true)
      expect(await tabs.getByRole('tab').evaluateAll(elements => elements.map(element => ({ id: element.id, text: element.textContent }))), '导航往返必须保留原外层 Tab').toEqual(initialTabs)
      expect(await tabs.getByRole('tab', { selected: true }).getAttribute('id'), '导航往返必须保留原选中 Tab').toBe(selectedTab)
      expectNoSyntheticFallbacks(app)
      expect(app.errors, '两端基线真实官方页面导航不得产生浏览器错误').toEqual([])
    }
    finally {
      await app.close()
    }
  })
})
