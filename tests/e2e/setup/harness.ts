import type { Page } from 'playwright'
import { expect } from 'vitest'
import { invoke, WINDOW_TIMEOUT_MS } from './shell'

export interface RuntimeInfo {
  app_version: string
  node_version: string
  service_url: string
  data_dir: string
  log_path: string
  platform: string
  arch: string
}

export interface AppConfig {
  active_profile: string
}

export interface HealthCheck {
  status: string
  service_url: string
  boot_html?: string
}

/**
 * 等 Harness 真正就绪：先确认本窗口仍持有核心，再走产品自身的那条门禁
 * （`proxy_health_check` 同时验证服务在监听与客户端模块都可取）。
 *
 * 就绪判据只能有一条：E2E 自造的判据（页面加载完、能取到 bundle）与产品实际
 * 认可的时机不同，切换档案、复用核心时会把「还没就绪」认成「已就绪」（issue #1384）。
 * 这里只做一件事——核心进程已退出时立刻失败，不把崩溃耗成超时。
 */
export async function waitHealthy(page: Page): Promise<HealthCheck> {
  let documentState: { protocol: string, readyState: DocumentReadyState } | undefined
  await expect.poll(async () => {
    try {
      documentState = await page.evaluate(() => ({ protocol: location.protocol, readyState: document.readyState }))
    }
    catch (error) {
      if (String(error).includes('Execution context was destroyed, most likely because of a navigation'))
        return false
      throw error
    }
    return documentState.protocol === 'chrome-error:' || documentState.readyState === 'complete'
  }, { timeout: WINDOW_TIMEOUT_MS, message: '顶层 Harness 文档必须完成加载后才能调用原生命令' }).toBe(true)
  if (documentState?.protocol === 'chrome-error:')
    throw new Error('Harness 顶层导航进入 chrome-error，禁止继续等待原生命令')
  expect(documentState?.readyState, '顶层 Harness 文档必须完成加载后才能调用原生命令').toBe('complete')
  let serviceUrl = ''
  await expect.poll(async () => {
    const info = await invoke<RuntimeInfo>(page, 'get_runtime_info')
    serviceUrl = info.service_url
    try {
      await invoke(page, 'harness_ownership')
    }
    catch (error) {
      if (String(error).includes('HARNESS_NOT_OWNED'))
        throw new Error(`Harness 核心已退出：${String(error)}`)
    }
    // 就绪判据沿用产品自身那条门禁：它同时验证「服务在监听」与「客户端模块都可取」，
    // 是壳与 Core 共同认可的信号。核心进程退出已在上面快速失败，不会耗成超时。
    const health = await invoke<HealthCheck>(page, 'proxy_health_check')
    return health.status.startsWith('healthy')
  }, { timeout: WINDOW_TIMEOUT_MS, message: 'Harness 核心未达到就绪状态' }).toBe(true)
  const origin = new URL(serviceUrl).origin
  await expect.poll(() => new URL(page.url()).origin, { timeout: WINDOW_TIMEOUT_MS, message: '产品必须自行导航至所属核心文档' }).toBe(origin)
  await page.locator('div[class$="_frame"]').waitFor({ state: 'visible', timeout: WINDOW_TIMEOUT_MS })
  return { service_url: serviceUrl, status: `healthy - ${origin}` }
}
