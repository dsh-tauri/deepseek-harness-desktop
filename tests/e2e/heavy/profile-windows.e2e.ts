import type { Page, Request, Response } from 'playwright'
import type { AppConfig, HealthCheck, RuntimeInfo } from '../setup/harness'
import process from 'node:process'
import { beforeAll, describe, expect, it } from 'vitest'
import { waitHealthy } from '../setup/harness'
import { ASSEMBLY_TIMEOUT_MS, completePreinstall, invoke, shellAppScope, WINDOW_TIMEOUT_MS } from '../setup/shell'

describe('desktop profile window isolation', () => {
  const app = shellAppScope()

  beforeAll(async () => {
    await completePreinstall(app.get().window.page, ASSEMBLY_TIMEOUT_MS)
  }, ASSEMBLY_TIMEOUT_MS)

  // 三个窗口 + 克隆档案同时起多套核心，PR 门禁的共享 runner 上跑不出结果，
  // 因此单独成 desktop-heavy project，只在手动执行时跑。
  it('reuses same-profile cores and isolates cloned-profile windows', async () => {
    const shell = app.get()
    const main = shell.window.page
    await waitHealthy(main)
    const originalConfig = await invoke<AppConfig>(main, 'get_app_config')
    const originalRuntime = await invoke<RuntimeInfo>(main, 'get_runtime_info')

    let cloneId: string | undefined
    let second: Awaited<ReturnType<typeof shell.openWindow>> | undefined
    let third: Awaited<ReturnType<typeof shell.openWindow>> | undefined
    const failures: unknown[] = []
    const networkFailures: object[] = []
    const observed = new WeakSet<Page>()
    const detach: Array<() => void> = []
    let stage = 'clone-profile'
    function observePage(page: Page) {
      if (observed.has(page))
        return
      observed.add(page)
      function record(request: Request, error: string) {
        const resource = new URL(request.url())
        const document = new URL(page.url() || 'about:blank')
        if (networkFailures.length === 32)
          networkFailures.shift()
        networkFailures.push({ time: Date.now(), stage, document: (document.origin + document.pathname).slice(0, 256), method: request.method(), resource: (resource.origin + resource.pathname).slice(0, 256), type: request.resourceType(), error })
      }
      function failed(request: Request) {
        record(request, request.failure()?.errorText ?? 'requestfailed')
      }
      function received(response: Response) {
        if (response.status() >= 400)
          record(response.request(), `HTTP ${response.status()}`)
      }
      page.on('requestfailed', failed)
      page.on('response', received)
      detach.push(() => {
        page.off('requestfailed', failed)
        page.off('response', received)
      })
    }
    for (const context of shell.browser.contexts()) {
      context.on('page', observePage)
      detach.push(() => context.off('page', observePage))
      context.pages().forEach(observePage)
    }
    try {
      const clone = await invoke<{ id: string }>(main, 'clone_profile', {
        sourceId: originalConfig.active_profile,
        name: `e2e-profile-${process.pid}-${Date.now()}`,
      })
      cloneId = clone.id

      stage = 'second-initial'
      second = await shell.openWindow()
      observePage(second.page)
      expect((await invoke<AppConfig>(second.page, 'get_app_config')).active_profile, '同档案窗口必须继承发起窗口档案').toBe(originalConfig.active_profile)
      expect((await invoke<RuntimeInfo>(second.page, 'get_runtime_info')).service_url, '同档案窗口必须复用核心服务地址').toBe(originalRuntime.service_url)
      await waitHealthy(second.page)

      stage = 'second-clone'
      await invoke(second.page, 'set_active_profile', { id: cloneId })
      await invoke(second.page, 'launch_harness')
      await expect.poll(async () => (await invoke<HealthCheck>(second!.page, 'proxy_health_check')).status.startsWith('healthy'), { timeout: WINDOW_TIMEOUT_MS }).toBe(true)
      const targetRuntime = await invoke<RuntimeInfo>(second.page, 'get_runtime_info')
      await invoke(second.page, 'host_harness_document', { url: targetRuntime.service_url })
      const clonedRuntime = await waitHealthy(second.page)
      expect((await invoke<AppConfig>(second.page, 'get_app_config')).active_profile, '切换后窗口必须绑定克隆档案').toBe(cloneId)
      expect(clonedRuntime.service_url, '克隆档案必须使用独立核心服务地址').not.toBe(originalRuntime.service_url)

      stage = 'third-clone'
      third = await shell.openWindow('create_app_window', second)
      observePage(third.page)
      expect((await invoke<AppConfig>(third.page, 'get_app_config')).active_profile, '克隆档案窗口必须继承克隆档案').toBe(cloneId)
      expect((await invoke<RuntimeInfo>(third.page, 'get_runtime_info')).service_url, '克隆档案窗口必须复用克隆核心').toBe(clonedRuntime.service_url)
      await waitHealthy(third.page)

      await shell.closeWindow(third.label)
      third = undefined
      await waitHealthy(second.page)

      await shell.closeWindow(second.label)
      second = undefined
      expect((await waitHealthy(main)).service_url, '关闭克隆档案窗口不得影响原档案核心').toBe(originalRuntime.service_url)
    }
    catch (error) {
      console.error('[profile-client-load]', { stage, networkFailures })
      failures.push(error)
    }
    finally {
      detach.forEach(stop => stop())
      for (const opened of [third, second]) {
        if (!opened)
          continue
        try {
          await shell.closeWindow(opened.label)
        }
        catch (error) {
          failures.push(error)
        }
      }
      if (cloneId) {
        try {
          await expect.poll(
            () => invoke(main, 'remove_profile', { id: cloneId }).then(() => 'removed', error => String(error)),
            { timeout: WINDOW_TIMEOUT_MS, message: '关闭克隆档案窗口后其档案应可删除' },
          ).toBe('removed')
        }
        catch (error) {
          failures.push(error)
        }
      }
    }
    if (failures.length > 0)
      throw new AggregateError(failures, '档案窗口生命周期失败（首项为原始异常）')
  })
})
