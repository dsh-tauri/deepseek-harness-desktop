/**
 * 批次 · `dsh-tauri-remote` 入站访问面板（S6）在真实浏览器里的走查。
 *
 * 断言的是**用户可见行为**：设置侧栏「远程访问」页三张分组卡（局域网 / 公网隧道 / 访问控制）的
 * 渲染与操作回执。面板只保留可配置项与凭据本身——不再渲染链接、二维码、日志、认证开关与监听摘要，
 * 因此链接形态（回环 / 局域网）、隧道公网地址等数据改为经宿主 `/api/tauri/remote/access` 取回断言，
 * 面板侧只断言「不出现」以及证书行的显隐往返。截图落在 `test/e2e/.artifacts/`，作为人工复核证据。
 *
 * 非回环监听的前置状态用同一套 HTTP 路由布置（面板下拉在 iframe 里的指针命中不稳，
 * 不适合做断言支点）；面板侧只断言渲染与凭据开关的真实回写。
 * 隧道用例默认关闭：它会真的下载 cloudflared 并占用公网随机域名，不适合放进常规门禁；
 * 打开后用例自带收尾（停止隧道、关闭暴露），不把状态留给后续用例。
 */

import type { Browser } from 'playwright'
import type { DshPage } from '../support/browser'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { launchDshBrowser, newDshPage, openSettings, selectSettingsSection } from '../support/browser'

const ARTIFACTS = join(import.meta.dirname, '..', '.artifacts')
const ACCESS_API = '/api/tauri/remote/access'
const PANEL = '[data-testid="access-section"]'
const LAN = '局域网'
const TUNNEL = '公网隧道'
const ACCESS_TOGGLE = '[data-testid="access-toggle"]'
const LAN_ADDRESS = '[data-testid="access-lan-address"]'
const LAN_DRAFT = '[data-testid="access-lan-draft"]'
const PAIRING = '[data-testid="access-pairing"]'
const PAIRING_CODE = '[data-testid="access-pairing-code"]'
const PAIRING_COUNTDOWN = '[data-testid="access-pairing-countdown"]'
const PERMANENT = '[data-testid="access-permanent"]'
const PERMANENT_VALUE = '[data-testid="access-permanent-value"]'
const PERMANENT_REVEAL = '[data-testid="access-permanent-reveal"]'
const TOKEN_ROTATE = '[data-testid="access-token-rotate"]'
const TOKEN_REVOKE = '[data-testid="access-token-revoke"]'
const TUNNEL_TOGGLE = '[data-testid="access-tunnel-toggle"]'
const TUNNEL_MODE = '[data-testid="access-tunnel-mode"]'
const TUNNEL_START = '[data-testid="access-tunnel-start"]'
const TUNNEL_STOP = '[data-testid="access-tunnel-stop"]'
const TUNNEL_STATE = '[data-testid="access-tunnel-state"]'
const PROGRESS = '[data-testid="access-tunnel-progress"]'
const REMOVED = [
  '[data-testid^="access-logs"]',
  '[data-testid="access-events"]',
  '[data-testid="access-tunnel-events"]',
  '[data-testid="access-auth-toggle"]',
  '[data-testid="access-auth-scope"]',
  '[data-testid^="access-generated-password"]',
  '[data-testid="access-link"]',
  '[data-testid="access-mask-link"]',
  '[data-testid="access-link-hint"]',
  '[data-testid="access-pairing-qr"]',
  '[data-testid="access-permanent-state"]',
  '[data-testid="access-tunnel-url"]',
  '[data-testid="access-tunnel-ready"]',
  '[data-testid="access-tunnel-code"]',
  '[data-testid="access-tunnel-qr"]',
].join(', ')
const CODE = /^[2-9A-HJ-NP-Z]{8}$/u
const MASK = '••••••••'
const TUNNEL_E2E = process.env.DSH_E2E_TUNNEL === '1'

interface AccessStatusPayload {
  enabled: boolean
  listen: { address: string, port: number }
  link?: string
  maskLink?: string
  linkSource?: string
  auth: { enabled: boolean, token?: string }
  pairing?: { code: string, expiresAt: number, link?: string, tunnelLink?: string }
  tunnel: { enabled: boolean, mode: string, state: string, url?: string }
}

let browser: Browser

beforeAll(async () => {
  browser = await launchDshBrowser()
  mkdirSync(ARTIFACTS, { recursive: true })
})

afterAll(async () => {
  await browser?.close()
})

function apiHeaders(): Record<string, string> {
  return { 'cookie': inject('dshCookie'), 'content-type': 'application/json' }
}

async function apiPost(path: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${inject('dshBaseUrl')}${path}`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify(body) })
  expect(response.status, `${path} 必须返回 200`).toBe(200)
}

async function apiDelete(path: string): Promise<void> {
  const response = await fetch(`${inject('dshBaseUrl')}${path}`, { method: 'DELETE', headers: apiHeaders() })
  expect(response.status, `${path} 必须返回 200`).toBe(200)
}

/** 面板不再展示链接与隧道地址，这些数据的唯一断言支点是宿主状态接口。 */
async function accessStatus(): Promise<AccessStatusPayload> {
  const response = await fetch(`${inject('dshBaseUrl')}${ACCESS_API}`, { headers: apiHeaders() })
  expect(response.status, `${ACCESS_API} 必须返回 200`).toBe(200)
  return await response.json() as AccessStatusPayload
}

function authParamOf(link: string | undefined): string | undefined {
  if (link === undefined)
    return undefined
  return new URL(link).searchParams.get('auth') ?? undefined
}

async function shoot(app: DshPage, name: string): Promise<void> {
  await app.page.screenshot({ path: join(ARTIFACTS, `${name}.png`) })
}

function switchOf(app: DshPage, name: string) {
  return app.frame.getByRole('switch', { name }).first()
}

async function openAccessPanel(app: DshPage): Promise<void> {
  await openSettings(app.page, app.frame, app.syntheticFallbacks)
  await selectSettingsSection(app.page, app.frame, '远程访问', app.syntheticFallbacks)
  // iframe 内的指针命中偶发丢失（与监听地址下拉同一现象），因此按 aria-selected 重试点击。
  const tab = app.frame.getByTestId('remote-tabs').getByRole('tab', { name: '远程访问' })
  await tab.waitFor({ state: 'visible', timeout: 30_000 })
  await expect.poll(async () => {
    if (await tab.getAttribute('aria-selected') === 'true')
      return 'true'
    await tab.click({ timeout: 5_000 }).catch(() => undefined)
    return await tab.getAttribute('aria-selected')
  }, { timeout: 60_000 }).toBe('true')
  await app.frame.locator(PANEL).waitFor({ state: 'attached', timeout: 20_000 })
}

async function readText(app: DshPage, selector: string): Promise<string> {
  return await app.frame.locator(selector).first().textContent() ?? ''
}

/** 面板已删除的行/块：一律按「不出现」断言，绝不再拿它们做支点。 */
async function removedCount(app: DshPage): Promise<number> {
  return await app.frame.locator(PANEL).first().evaluate((panel, selector) => panel.querySelectorAll(selector).length, REMOVED)
}

/** 用例前后：关暴露、关认证、清密码、复位监听地址并撤销隧道与永久码，不依赖 UI，避免把状态留给同宿主里的后续用例。 */
async function resetExposure(): Promise<void> {
  await apiPost(ACCESS_API, { enabled: false, address: '127.0.0.1', authEnabled: false, password: null })
  await apiDelete(`${ACCESS_API}/tunnel`)
  await apiDelete(`${ACCESS_API}/token`)
}

describe('入站访问面板（真实浏览器）', () => {
  it('只渲染可配置项与凭据：无链接/二维码/日志/认证开关，配对码与宿主链接一致', async () => {
    await resetExposure()
    const app = await newDshPage(browser, { ready: '[data-slot="sidebar"]' })
    try {
      await openAccessPanel(app)
      await expect.poll(() => app.frame.locator(PANEL).isVisible()).toBe(true)
      expect(await app.frame.locator(`${PANEL} img`).count(), '面板不再渲染二维码图片').toBe(0)
      expect(await removedCount(app), '已删除的行与块不再出现在面板里').toBe(0)
      expect(await app.frame.locator(LAN_DRAFT).count(), '监听地址未改动时不出现草稿行').toBe(0)
      expect(await app.frame.locator(PAIRING).count(), '访问控制卡始终给出临时配对码行').toBe(1)
      expect(await app.frame.locator(PERMANENT).count(), '访问控制卡始终给出永久访问码行').toBe(1)
      expect(await app.frame.locator(TOKEN_ROTATE).count(), '没有永久码时只给「生成」').toBe(1)
      expect(await app.frame.locator(PERMANENT_VALUE).count()).toBe(0)

      expect(await app.frame.locator(ACCESS_TOGGLE).count(), '局域网开关暴露 access-toggle').toBe(1)
      const lan = switchOf(app, LAN)
      expect(await lan.getAttribute('aria-checked')).toBe('false')
      await shoot(app, 'access-1-panel')

      await lan.click()
      await expect.poll(() => lan.getAttribute('aria-checked'), { timeout: 20_000 }).toBe('true')
      await expect.poll(() => app.frame.locator(LAN_ADDRESS).count(), { timeout: 20_000 }).toBe(1)

      const code = await readText(app, PAIRING_CODE)
      expect(code, '临时配对码是 8 位无易混淆字符').toMatch(CODE)
      await expect.poll(() => readText(app, PAIRING_COUNTDOWN), { timeout: 20_000 }).toMatch(/^剩余 \d+:\d{2}$/u)
      const status = await accessStatus()
      expect(status.enabled).toBe(true)
      expect(status.auth.enabled, '开启监听即自动带认证（开关已从面板移出）').toBe(true)
      expect(status.listen.address).toBe('127.0.0.1')
      expect(status.linkSource, '回环监听不外发局域网链接').toBe('loopback')
      expect(status.maskLink, '回环地址只以本机主机名给出').toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u)
      expect(authParamOf(status.link), '回环 + 无永久码时链接不带凭据').toBeUndefined()
      expect(authParamOf(status.pairing?.link), '面板配对码就是宿主链接里的 auth').toBe(code)
      await shoot(app, 'access-2-loopback')

      await lan.click()
      await expect.poll(() => app.frame.locator(LAN_ADDRESS).count(), { timeout: 20_000 }).toBe(0)
      await expect.poll(() => readText(app, PAIRING_CODE), { timeout: 20_000 }).toBe('开启监听后这里会给出配对码。')
      expect(await app.frame.locator(PAIRING_COUNTDOWN).count(), '没有配对码时不再渲染倒计时').toBe(0)
    }
    finally {
      await resetExposure()
      await app.page.close()
    }
  }, 120_000)

  it('开放到全部网卡并签发永久码后，永久码掩码/显示/作废可往返', async () => {
    await resetExposure()
    await apiPost(ACCESS_API, { enabled: true, address: '0.0.0.0', authEnabled: true, password: 'e2e-panel-pass', scope: 'public_only' })
    await apiPost(`${ACCESS_API}/token`, {})
    const app = await newDshPage(browser, { ready: '[data-slot="sidebar"]' })
    try {
      await openAccessPanel(app)
      await expect.poll(() => app.frame.locator(PAIRING_CODE).count(), { timeout: 30_000 }).toBe(1)
      const status = await accessStatus()
      expect(status.linkSource, '全部网卡走局域网公开地址').toBe('lan')
      expect(status.listen.address).toBe('0.0.0.0')
      expect(status.link, '局域网入口带已签发的永久码').toMatch(/\?auth=/u)
      expect(status.auth.token).toMatch(CODE)
      expect(authParamOf(status.pairing?.link), '面板配对码就是宿主链接里的 auth').toBe(await readText(app, PAIRING_CODE))
      expect(await app.frame.locator(LAN_ADDRESS).count(), '已开启监听时给出监听地址行').toBe(1)

      expect(await app.frame.locator(TOKEN_ROTATE).count(), '已有永久码时不再给「生成」').toBe(0)
      expect(await readText(app, PERMANENT_VALUE), '永久码默认掩码').toBe(MASK)
      expect(await app.frame.locator(TOKEN_REVOKE).count()).toBe(1)
      await shoot(app, 'access-3-permanent-masked')

      await app.frame.locator(PERMANENT_REVEAL).click()
      await expect.poll(() => readText(app, PERMANENT_VALUE), { timeout: 20_000 }).toMatch(CODE)
      expect(await readText(app, PERMANENT_VALUE), '点显示才出明文，且与宿主一致').toBe(status.auth.token)

      await app.frame.locator(PERMANENT_REVEAL).click()
      await expect.poll(() => readText(app, PERMANENT_VALUE), { timeout: 20_000 }).toBe(MASK)

      // 面板必须能把自己签发的永久码作废，否则共享宿主会把凭据留给后续用例
      await app.frame.locator(TOKEN_REVOKE).click()
      await expect.poll(() => app.frame.locator(PERMANENT_VALUE).count(), { timeout: 20_000 }).toBe(0)
      await expect.poll(() => app.frame.locator(TOKEN_ROTATE).count(), { timeout: 20_000 }).toBe(1)
      expect(authParamOf((await accessStatus()).pairing?.link), '作废永久码不影响临时配对码').toBe(await readText(app, PAIRING_CODE))
    }
    finally {
      await resetExposure()
      await app.page.close()
    }
  }, 120_000)

  it.skipIf(!TUNNEL_E2E)('启动真实 quick 隧道并拿到公网地址，随后停止回收', async () => {
    await resetExposure()
    const app = await newDshPage(browser, { ready: '[data-slot="sidebar"]' })
    try {
      await openAccessPanel(app)
      await expect.poll(() => app.frame.locator(TUNNEL_TOGGLE).count(), { timeout: 20_000 }).toBe(1)
      await switchOf(app, TUNNEL).click()
      await expect.poll(() => app.frame.locator(TUNNEL_MODE).count(), { timeout: 20_000 }).toBe(1)
      await app.frame.locator(TUNNEL_START).click()
      // 启动期边轮询边采样：进度必须在拿到公网地址之前至少出现过一次（不能静默）
      let sawProgress = false
      await expect.poll(async () => {
        if (await app.frame.locator(PROGRESS).count() > 0)
          sawProgress = true
        return (await accessStatus()).tunnel.url === undefined ? 0 : 1
      }, { timeout: 180_000, interval: 500 }).toBe(1)
      expect(sawProgress, '启动期必须能看到阶段进度').toBe(true)

      const status = await accessStatus()
      expect(status.tunnel.state).toBe('running')
      expect(status.tunnel.url, '面板不再展示公网地址，只能从宿主状态取').toMatch(/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/u)
      expect(await readText(app, PAIRING_CODE), '隧道链接只带宿主签发的短期配对码').toBe(authParamOf(status.pairing?.tunnelLink))
      await expect.poll(() => readText(app, TUNNEL_STATE), { timeout: 30_000 }).toBe('隧道运行中')
      await shoot(app, 'access-4-tunnel')

      await app.frame.locator(TUNNEL_STOP).click()
      await expect.poll(async () => (await accessStatus()).tunnel.url === undefined, { timeout: 30_000 }).toBe(true)
      await expect.poll(() => app.frame.locator(TUNNEL_STATE).count(), { timeout: 30_000 }).toBe(0)
    }
    finally {
      await resetExposure()
      await app.page.close()
    }
  }, 300_000)
})
