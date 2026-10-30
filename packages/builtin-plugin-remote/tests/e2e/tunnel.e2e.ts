import type { Browser } from 'playwright'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { expectNoSyntheticFallbacks, launchDshBrowser, newDshPage, openSettings, selectSettingsSection } from '../../../../apps/desktop/tests/e2e/support/browser'

if (!process.env.DSH_E2E_INTEGRATIONS?.split(',').includes('tunnel'))
  throw new Error('请通过 DSH_E2E_INTEGRATIONS=tunnel 显式选择人工外部集成。')

if (process.env.CI || process.env.GITHUB_ACTIONS)
  throw new Error('人工外部集成禁止在 CI 运行。')

const API = '/api/tauri/remote/access'
let browser: Browser

beforeAll(async () => {
  browser = await launchDshBrowser()
})

afterAll(async () => {
  await browser?.close()
})

async function api(method: string, path: string, body?: object): Promise<Response> {
  const response = await fetch(`${inject('dshBaseUrl')}${path}`, {
    method,
    headers: { 'cookie': inject('dshCookie'), 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  })
  expect(response.status, '专用宿主接口必须真实成功').toBe(200)
  return response
}

async function resetExposure(): Promise<void> {
  await api('POST', API, { enabled: false, address: '127.0.0.1', authEnabled: false, password: null })
  await api('DELETE', `${API}/tunnel`)
  await api('DELETE', `${API}/token`)
}

async function status(): Promise<{ tunnel: { state: string, url?: string }, pairing?: { tunnelLink?: string } }> {
  return await (await api('GET', API)).json()
}

describe('人工公网集成：真实 Cloudflare quick 隧道', () => {
  it('真实下载、启动、展示进度与配对凭据，随后停止回收', async () => {
    await resetExposure()
    const app = await newDshPage(browser)
    try {
      await openSettings(app.page, app.frame, app.syntheticFallbacks)
      await selectSettingsSection(app.page, app.frame, '远程访问', app.syntheticFallbacks)
      const tab = app.frame.getByTestId('remote-tabs').getByRole('tab', { name: '远程访问' })
      await tab.click()
      await expect.poll(() => tab.getAttribute('aria-selected'), { message: '远程访问 Tab 必须打开' }).toBe('true')
      const panel = app.frame.getByTestId('access-section')
      await panel.getByRole('switch', { name: '公网隧道' }).click()
      await panel.getByTestId('access-tunnel-mode').waitFor({ state: 'visible' })
      await panel.getByTestId('access-tunnel-start').click()
      let sawProgress = false
      await expect.poll(async () => {
        sawProgress ||= await panel.getByTestId('access-tunnel-progress').isVisible()
        return (await status()).tunnel.url
      }, { message: '真实隧道必须签发 quick 公网地址', timeout: 180_000, interval: 500 }).toMatch(/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/u)
      expect(sawProgress, '启动期必须能看到真实阶段进度').toBe(true)
      const running = await status()
      expect(running.tunnel.state, '宿主必须报告真实隧道运行状态').toBe('running')
      const pairingLink = running.pairing?.tunnelLink
      expect(pairingLink, '真实公网隧道必须签发短期配对链接').toBeDefined()
      expect(new URL(pairingLink!).searchParams.get('auth'), '面板配对码必须与公网链接一致').toBe(await panel.getByTestId('access-pairing-code').textContent())
      await expect.poll(() => panel.getByTestId('access-tunnel-state').textContent(), { message: '面板必须展示运行回执' }).toBe('隧道运行中')
      await panel.getByTestId('access-tunnel-stop').click()
      await expect.poll(async () => (await status()).tunnel.url, { message: '停止后必须回收公网入口', timeout: 30_000 }).toBeUndefined()
      await expect.poll(() => panel.getByTestId('access-tunnel-state').count(), { message: '面板必须回收运行状态' }).toBe(0)
      expectNoSyntheticFallbacks(app)
      expect(app.errors, '真实公网集成不得产生浏览器错误').toEqual([])
    }
    finally {
      try {
        await resetExposure()
      }
      finally {
        await app.close()
      }
    }
  }, 300_000)
})
