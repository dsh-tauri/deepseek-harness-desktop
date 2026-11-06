import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { expect, it } from 'vitest'
import { invoke, startShellApp } from '../setup/shell'

declare global {
  interface Window {
    __dshThemeFrames: ThemeFrame[]
  }
}

interface ThemeFrame {
  background: string
  scheme: string
  source: string | undefined
}

function recordThemeFrames() {
  const frames: ThemeFrame[] = []
  Object.assign(window, { __dshThemeFrames: frames })
  function sample() {
    if (document.body) {
      const frame = {
        background: getComputedStyle(document.body).backgroundColor,
        scheme: getComputedStyle(document.documentElement).colorScheme,
        source: document.documentElement.dataset.dsThemeSource,
      }
      if (JSON.stringify(frames.at(-1)) !== JSON.stringify(frame))
        frames.push(frame)
    }
    requestAnimationFrame(sample)
  }
  requestAnimationFrame(sample)
}

for (const preference of ['light', 'dark'] as const) {
  it(`preserves saved ${preference} through native Harness hydration on the opposite system theme`, async () => {
    const app = await startShellApp({
      prepareHome: async (home) => {
        const profile = path.join(home, 'home', '.dsh.dev', 'profiles', 'desktop')
        await mkdir(profile, { recursive: true })
        await writeFile(path.join(profile, 'cordis.patch.yml'), `- id: ui-theme\n  config:\n    preference: ${preference}\n`)
        if (process.env.DSH_E2E_CORE_ROOT) {
          await writeFile(path.join(home, 'download-cache', 'dependencies.json'), JSON.stringify({
            dsh: path.resolve(process.env.DSH_E2E_CORE_ROOT),
            pnpm: null,
            git: null,
          }))
        }
      },
    })
    const page = app.window.page
    try {
      await page.context().addInitScript(recordThemeFrames)
      await page.emulateMedia({ colorScheme: preference === 'light' ? 'dark' : 'light' })
      await invoke(page, 'launch_harness')
      await expect.poll(async () => {
        const health = await invoke<{ status: string }>(page, 'proxy_health_check')
        return health.status.startsWith('healthy')
      }, { timeout: 60000, message: '真实 Harness 服务必须完成启动' }).toBe(true)
      const info = await invoke<{ service_url: string, data_dir: string }>(page, 'get_runtime_info')
      await invoke(page, 'host_harness_document', { url: info.service_url })
      await page.locator('div[class$="_frame"]').waitFor({ state: 'visible', timeout: 60000 })
      const background = preference === 'light' ? 'rgb(255, 255, 255)' : 'rgb(21, 21, 23)'
      const bootFrames = await page.evaluate(() => window.__dshThemeFrames)
      expect(bootFrames.length, '必须采集真实原生文档首帧').toBeGreaterThan(0)
      expect(bootFrames.filter(frame => frame.background !== background), '原生启动至DSH首屏不能出现相反画布帧').toEqual([])
      await page.getByTestId('dsh-navbar-sidebar-toggle').click()
      await page.getByRole('button', { name: /账号菜单|Account menu/, exact: true }).click()
      await page.getByRole('menuitem', { name: /设置|Settings/, exact: true }).click()
      const dialog = page.getByRole('dialog', { name: /设置|Settings/, exact: true })
      await dialog.getByRole('button', { name: preference === 'light' ? /浅色|Light/ : /深色|Dark/, exact: true }).waitFor({ timeout: 30000 })
      await expect.poll(() => dialog.getByRole('button', { name: preference === 'light' ? /浅色|Light/ : /深色|Dark/, exact: true }).getAttribute('aria-pressed'), { message: '设置面板必须完成持久主题水合' }).toBe('true')
      const frames = await page.evaluate(() => window.__dshThemeFrames)
      expect(frames.length, '必须采集真实原生文档首帧至就绪阶段').toBeGreaterThan(0)
      expect(frames.filter(frame => frame.background !== background), '启动全链路不能出现与持久主题相反的画布帧').toEqual([])
      await dialog.getByRole('button', { name: /跟随系统|System/, exact: true }).click()
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.dsThemeSource), { message: '初始化交接后必须允许用户选择跟随系统' }).toBe('system')
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor), { message: '用户切换跟随系统必须切换到系统画布色' }).toBe(preference === 'light' ? 'rgb(21, 21, 23)' : 'rgb(255, 255, 255)')
      await dialog.getByRole('button', { name: preference === 'light' ? /深色|Dark/ : /浅色|Light/, exact: true }).click()
      await expect.poll(() => readFile(path.join(info.data_dir, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8'), { message: '真实用户主题修改必须持久化' }).toContain(`preference: ${preference === 'light' ? 'dark' : 'light'}`)
    }
    finally {
      await app.stop()
    }
  }, 180000)
}
