import process from 'node:process'
import { expect, it } from 'vitest'
import { ASSEMBLY_TIMEOUT_MS, completePreinstall, diagnose, invoke, MAIN_LABEL, NAVBAR_MENU_CONFIG, SHELL_HOST, SHELL_ROOT, startShellApp } from '../setup/shell'

interface RestartObservation {
  url: string
  loading: boolean
  success: boolean
  covered: boolean
  ready: boolean
  right: boolean
  bottom: boolean
}

declare global {
  interface Window {
    __dshRestartObservation: (value: RestartObservation) => Promise<void>
  }
}

function observeRestart() {
  const seen = new Set<string>()
  const roots = new WeakSet<ShadowRoot>()
  const observer = new MutationObserver(sample)
  function sample() {
    const root = document.querySelector('[data-dsh-shell-host]')?.shadowRoot
    if (!root)
      return
    if (!roots.has(root)) {
      roots.add(root)
      observer.observe(root, { childList: true, subtree: true })
    }
    const frame = document.querySelector('div[class$="_frame"]')
    const style = frame ? getComputedStyle(frame) : null
    const bounds = frame?.getBoundingClientRect()
    const ready = Boolean(frame && frame.childElementCount > 0 && bounds && bounds.width > 0 && bounds.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden')
    const covered = root.querySelector('[data-testid="dsh-hosted-loading"]') !== null
    const toasts = [...root.querySelectorAll('[role="alert"], [role="status"], [data-slot="toast"]')]
    const loading = toasts.find(el => /正在重启 Harness|Restarting Harness|Harness를 다시 시작하는 중|Перезапуск Harness/.test(el.textContent ?? ''))
    const success = toasts.find(el => /Harness 重启成功|Harness restarted|Harness를 다시 시작했습니다|Harness перезапущен/.test(el.textContent ?? ''))
    const toast = success ?? loading
    const rect = toast?.getBoundingClientRect()
    const value = { url: location.href, loading: Boolean(loading), success: Boolean(success), covered, ready, right: Boolean(rect && rect.right > innerWidth / 2), bottom: Boolean(rect && rect.y > innerHeight / 2) }
    const key = JSON.stringify(value)
    if (!seen.has(key)) {
      seen.add(key)
      void window.__dshRestartObservation(value)
    }
  }
  observer.observe(document, { childList: true, subtree: true })
  sample()
}

it('restarts through the local shell before stopping DSH and reports success only for the new ready document', async () => {
  const app = await startShellApp()
  const page = app.window.page
  const bootstrapUrl = page.url()
  const observations: RestartObservation[] = []
  const errors: Array<{ url: string, message: string }> = []
  const navigations: string[] = []
  const failedResponses: Array<{ status: number, resource: string, time: number }> = []
  page.on('response', (response) => {
    if (response.status() < 400 || failedResponses.length >= 20)
      return
    const resource = new URL(response.url())
    failedResponses.push({ status: response.status(), resource: resource.origin + resource.pathname, time: Date.now() })
  })
  page.on('console', (message) => {
    if (message.type() === 'error')
      errors.push({ url: page.url(), message: message.text() })
  })
  page.on('pageerror', error => errors.push({ url: page.url(), message: error.stack ?? error.message }))
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame())
      navigations.push(frame.url())
  })
  try {
    await page.locator(SHELL_ROOT).waitFor({ state: 'visible', timeout: 15000 })
    await page.exposeFunction('__dshRestartObservation', (value: RestartObservation) => observations.push(value))
    await page.addInitScript(observeRestart)
    await completePreinstall(page, ASSEMBLY_TIMEOUT_MS)
    await page.locator('div[class$="_frame"]').waitFor({ state: 'visible', timeout: 60000 })
    await page.evaluate(observeRestart)
    const oldUrl = page.url()
    expect(await page.evaluate(async () => {
      const response = await fetch('/', { cache: 'no-store' })
      await response.arrayBuffer()
      return response.status
    }), '重启前旧文档的真实认证请求必须成功').toBe(200)
    await page.evaluate(() => {
      const controller = new AbortController()
      const timer = setInterval(() => {
        void fetch('/', { cache: 'no-store', signal: controller.signal }).then(response => response.arrayBuffer()).catch((error) => {
          if (!controller.signal.aborted)
            console.error(error)
        })
      }, 20)
      window.addEventListener('pagehide', () => {
        clearInterval(timer)
        controller.abort()
      }, { once: true })
    })
    const first = observations.length
    navigations.length = 0
    if (process.platform === 'darwin') {
      await invoke(page, 'plugin:event|emit_to', { target: { kind: 'Window', label: MAIN_LABEL }, event: 'macos-menu-action', payload: 'desktop-restart' })
    }
    else {
      await page.locator(NAVBAR_MENU_CONFIG).click()
      await page.locator(`${SHELL_HOST} >> [data-testid="dsh-navbar-item-application-restart"]`).click({ noWaitAfter: true })
    }
    await expect.poll(() => observations.slice(first).some(value => value.url === oldUrl && value.loading && value.right && value.bottom), { timeout: 15000, message: '离开旧文档前必须显示右下角加载提示' }).toBe(true)
    await expect.poll(() => navigations.includes(bootstrapUrl), { timeout: 30000, message: '必须先离开 DSH 并返回本次应用的真实本地壳层' }).toBe(true)
    await expect.poll(() => observations.slice(first).some(value => value.url === bootstrapUrl && value.loading && value.covered), { timeout: 30000, message: '本地接续文档必须恢复加载提示和加载覆盖' }).toBe(true)
    await page.waitForURL(url => url.href !== oldUrl && url.origin !== new URL(bootstrapUrl).origin, { timeout: 120000 })
    const newUrl = page.url()
    const runtime = await invoke<{ service_url: string }>(page, 'get_runtime_info')
    expect(new URL(newUrl).origin, '新文档必须属于重启后的真实运行端口').toBe(new URL(runtime.service_url).origin)
    await expect.poll(() => observations.some(value => value.url === newUrl && value.success), { timeout: 60000, message: '新的 DSH 文档真实就绪后才能提示重启成功' }).toBe(true)
    const success = observations.find(value => value.url === newUrl && value.success)!
    expect(success.ready, '成功提示必须绑定非空且可见的新 DSH 内容').toBe(true)
    expect(observations.some(value => value.url === newUrl && value.covered && !value.ready), '新 DSH 就绪前必须仍有加载覆盖').toBe(true)
    expect(observations.some(value => value.url === newUrl && value.loading && !value.success), '新 DSH 文档必须先恢复加载再提示成功').toBe(true)
    expect(observations.slice(first).filter(value => value.success && value.url !== newUrl), '旧 DSH 与本地接续文档不能误报成功').toEqual([])
    expect(await invoke(page, 'get_harness_restart'), '成功后原生操作标记必须消费清空').toBeNull()
    expect(errors, '重启全程不得出现页面异常或控制台错误').toEqual([])
  }
  catch (error) {
    console.error('Restart resource failures:', failedResponses)
    console.error(await diagnose(app))
    throw error
  }
  finally {
    await app.stop()
  }
}, ASSEMBLY_TIMEOUT_MS)
