/**
 * 批次 · `dsh-tauri-remote` 入站访问面板（S6）在真实浏览器里的走查。
 *
 * 断言的是**用户可见行为**：设置侧栏「服务器 → 本机访问」页的渲染与操作回执、
 * 链接与二维码、以及（`DSH_E2E_TUNNEL=1` 时）真实 cloudflared quick 隧道的启停。
 * 截图落在 `test/e2e/.artifacts/`，作为人工复核证据。
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
const ACCESS_API = '/api/desktop/dsh-tauri-remote/access'
const PANEL = '[data-testid="access-section"]'
const TOGGLE = '[data-testid="access-toggle"]'
const TUNNEL_START = '[data-testid="access-tunnel-start"]'
const TUNNEL_STOP = '[data-testid="access-tunnel-stop"]'
const TUNNEL_URL = '[data-testid="access-tunnel-url"]'
const TUNNEL_READY = '[data-testid="access-tunnel-ready"]'
const TUNNEL_STATE = '[data-testid="access-tunnel-state"]'
const LINK = '[data-testid="access-link"]'
const QR = '[data-testid="access-link-qr"]'
const PASSWORD_INPUT = 'input[type="password"]'
const PASSWORD_CLEAR = '[data-testid="access-password-clear"]'
const ENABLE = '[data-testid="remote-enable"]'
const TABS = '[data-testid="remote-tabs"]'
const TUNNEL_E2E = process.env.DSH_E2E_TUNNEL === '1'

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

async function shoot(app: DshPage, name: string): Promise<void> {
  await app.page.screenshot({ path: join(ARTIFACTS, `${name}.png`) })
}

function authSwitch(app: DshPage) {
  return app.frame.getByRole('switch', { name: '要求密码或链接 Token' }).first()
}

async function openAccessPanel(app: DshPage): Promise<void> {
  await openSettings(app.page, app.frame, app.syntheticFallbacks)
  await selectSettingsSection(app.page, app.frame, '服务器', app.syntheticFallbacks)
  // 插件默认关闭：Hero 状态先「启用 SSH」，启用后分区才切成 Tabs。
  if (await app.frame.locator(ENABLE).count() > 0) {
    await app.frame.locator(ENABLE).first().click()
    await app.frame.locator(TABS).waitFor({ state: 'attached', timeout: 30_000 })
  }
  await app.frame.getByRole('tab', { name: '本机访问' }).click()
  await app.frame.locator(PANEL).waitFor({ state: 'attached', timeout: 20_000 })
}

async function readText(app: DshPage, selector: string): Promise<string> {
  return await app.frame.locator(selector).first().textContent() ?? ''
}

/** 收尾：只要暴露还开着就关掉，避免把 LAN 端口与凭据留给后续用例。 */
async function disableExposure(app: DshPage): Promise<void> {
  const toggle = app.frame.locator(TOGGLE)
  if (await toggle.count() === 0 || await toggle.first().textContent() !== '关闭暴露')
    return
  await toggle.first().click()
  await expect.poll(async () => await toggle.first().textContent(), { timeout: 30_000 }).toBe('开启暴露')
}

describe('入站访问面板（真实浏览器）', () => {
  it('渲染「本机访问」页、开启回环监听并给出访问链接', async () => {
    const app = await newDshPage(browser, { ready: '[data-slot="sidebar"]' })
    try {
      await openAccessPanel(app)
      await expect.poll(() => app.frame.locator(PANEL).isVisible()).toBe(true)
      expect(await readText(app, TOGGLE)).toBe('开启暴露')
      await shoot(app, 'access-1-panel')

      await app.frame.locator(TOGGLE).click()
      await expect.poll(() => app.frame.locator(LINK).count(), { timeout: 20_000 }).toBe(1)
      expect(await readText(app, LINK)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u)
      expect(await app.frame.locator(QR).count(), '回环监听不生成二维码').toBe(0)
      expect(await authSwitch(app).getAttribute('aria-checked')).toBe('false')
      await shoot(app, 'access-2-loopback')

      await app.frame.locator(TOGGLE).click()
      await expect.poll(() => app.frame.locator(LINK).count(), { timeout: 20_000 }).toBe(0)
    }
    finally {
      await disableExposure(app)
      await app.page.close()
    }
  }, 120_000)

  it('开放到全部网卡并配置认证后，面板渲染带 Token 的链接与二维码，凭据开关回写生效', async () => {
    await apiPost(ACCESS_API, { enabled: true, address: '0.0.0.0', authEnabled: true, password: 'e2e-panel-pass', scope: 'public_only' })
    await apiPost(`${ACCESS_API}/token`, {})
    const app = await newDshPage(browser, { ready: '[data-slot="sidebar"]' })
    try {
      await openAccessPanel(app)
      await expect.poll(() => app.frame.locator(QR).count(), { timeout: 30_000 }).toBe(1)
      expect(await readText(app, LINK)).toMatch(/\?auth=/u)
      expect(await app.frame.locator(QR).first().getAttribute('src')).toMatch(/^data:image\/png;base64,/u)
      expect(await app.frame.locator(PASSWORD_INPUT).first().getAttribute('placeholder')).toContain('已设置密码')
      expect(await authSwitch(app).getAttribute('aria-checked')).toBe('true')
      await shoot(app, 'access-3-qr')

      await authSwitch(app).click()
      await expect.poll(() => authSwitch(app).getAttribute('aria-checked'), { timeout: 20_000 }).toBe('false')

      // 面板必须能把自己设下的密码清掉，否则共享宿主会把凭据留给后续用例
      await app.frame.locator(PASSWORD_CLEAR).click()
      await expect.poll(async () => await app.frame.locator(PASSWORD_INPUT).first().getAttribute('placeholder'), { timeout: 20_000 }).toContain('尚未设置密码')
    }
    finally {
      await disableExposure(app)
      await apiDelete(`${ACCESS_API}/token`)
      await app.page.close()
    }
  }, 120_000)

  it.skipIf(!TUNNEL_E2E)('启动真实 quick 隧道并拿到公网地址，随后停止回收', async () => {
    const app = await newDshPage(browser, { ready: '[data-slot="sidebar"]' })
    try {
      await openAccessPanel(app)
      await app.frame.locator(TUNNEL_START).click()
      await expect.poll(() => app.frame.locator(TUNNEL_URL).count(), { timeout: 180_000, interval: 1_000 }).toBe(1)
      const url = await readText(app, TUNNEL_URL)
      expect(url).toMatch(/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/u)
      expect(await readText(app, TUNNEL_STATE)).toBe('隧道运行中')
      expect(await readText(app, TUNNEL_READY)).toContain('公网隧道已就绪')
      await shoot(app, 'access-4-tunnel')

      await app.frame.locator(TUNNEL_STOP).click()
      await expect.poll(() => app.frame.locator(TUNNEL_STATE).textContent(), { timeout: 30_000 }).toBe('隧道未运行')
      await expect.poll(() => app.frame.locator(TUNNEL_URL).count(), { timeout: 20_000 }).toBe(0)
    }
    finally {
      await disableExposure(app)
      await app.page.close()
    }
  }, 300_000)
})
