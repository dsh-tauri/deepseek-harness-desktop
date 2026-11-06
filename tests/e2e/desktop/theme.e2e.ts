import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { expect, it } from 'vitest'
import { ASSEMBLY_TIMEOUT_MS, completePreinstall, diagnose, invoke, SHELL_ROOT, startShellApp } from '../setup/shell'

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
    const themeTrace: object[] = []
    const runtimeErrors: string[] = []
    const settingsWrites: object[] = []
    const patchFile = path.join(app.home, 'home', '.dsh.dev', 'profiles', 'desktop', 'cordis.patch.yml')
    page.on('pageerror', error => runtimeErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error')
        runtimeErrors.push(message.text())
    })
    page.on('response', async (response) => {
      if (response.request().method() !== 'POST' || new URL(response.url()).pathname !== '/api/settings/mutate')
        return
      try {
        const request = response.request().postDataJSON() as { payload?: { args?: { ns?: string } } }
        if (request.payload?.args?.ns === 'ui-theme')
          settingsWrites.push({ request, status: response.status(), result: await response.json() })
      }
      catch (error) {
        settingsWrites.push({ status: response.status(), error: String(error) })
      }
    })
    async function captureTheme(stage: string) {
      themeTrace.push({
        stage,
        ...await page.evaluate(() => ({
          origin: location.origin,
          systemDark: matchMedia('(prefers-color-scheme: dark)').matches,
          source: document.documentElement.dataset.dsThemeSource,
          inlineScheme: document.documentElement.style.colorScheme,
          scheme: getComputedStyle(document.documentElement).colorScheme,
          inlineBackground: document.body.style.backgroundColor,
          background: getComputedStyle(document.body).backgroundColor,
          bootBackground: getComputedStyle(document.body).getPropertyValue('--dsh-boot-bg'),
          buttons: [...document.querySelectorAll('[role="dialog"] button[aria-pressed]')].map(button => ({ text: button.textContent, pressed: button.getAttribute('aria-pressed') })),
        })),
        patch: await readFile(patchFile, 'utf8'),
      })
    }
    try {
      await page.locator(SHELL_ROOT).waitFor({ state: 'visible', timeout: 15000 })
      await page.context().addInitScript(recordThemeFrames)
      await page.emulateMedia({ colorScheme: preference === 'light' ? 'dark' : 'light' })
      await completePreinstall(page, ASSEMBLY_TIMEOUT_MS)
      const info = await invoke<{ service_url: string, data_dir: string }>(page, 'get_runtime_info')
      await expect.poll(() => new URL(page.url()).origin, { message: '产品必须自动导航到真实 Harness 文档' }).toBe(new URL(info.service_url).origin)
      await page.locator('div[class$="_frame"]').waitFor({ state: 'visible', timeout: 60000 })
      const background = preference === 'light' ? 'rgb(255, 255, 255)' : 'rgb(21, 21, 23)'
      const bootFrames = await page.evaluate(() => window.__dshThemeFrames)
      expect(bootFrames.length, '必须采集真实原生文档首帧').toBeGreaterThan(0)
      expect(bootFrames.filter(frame => frame.background !== background), '原生启动至DSH首屏不能出现相反画布帧').toEqual([])
      const accountMenu = page.getByRole('button', { name: /账号菜单|Account menu/, exact: true })
      if (!await accountMenu.isVisible())
        await page.getByTestId('dsh-navbar-sidebar-toggle').click({ timeout: 5000 })
      await accountMenu.click()
      await page.getByRole('menuitem', { name: /设置|Settings/, exact: true }).click()
      const dialog = page.getByRole('dialog', { name: /设置|Settings/, exact: true })
      await dialog.getByRole('button', { name: preference === 'light' ? /浅色|Light/ : /深色|Dark/, exact: true }).waitFor({ timeout: 30000 })
      await expect.poll(() => dialog.getByRole('button', { name: preference === 'light' ? /浅色|Light/ : /深色|Dark/, exact: true }).getAttribute('aria-pressed'), { message: '设置面板必须完成持久主题水合' }).toBe('true')
      const frames = await page.evaluate(() => window.__dshThemeFrames)
      expect(frames.length, '必须采集真实原生文档首帧至就绪阶段').toBeGreaterThan(0)
      expect(frames.filter(frame => frame.background !== background), '启动全链路不能出现与持久主题相反的画布帧').toEqual([])
      await captureTheme('before-system')
      const systemButton = dialog.getByRole('button', { name: /跟随系统|System/, exact: true })
      await systemButton.click()
      await expect.poll(() => systemButton.getAttribute('aria-pressed'), { message: '系统主题按钮必须完成选中状态更新' }).toBe('true')
      await captureTheme('after-system')
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.dsThemeSource), { message: '初始化交接后必须允许用户选择跟随系统' }).toBe('system')
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor), { message: '用户切换跟随系统必须切换到系统画布色' }).toBe(preference === 'light' ? 'rgb(21, 21, 23)' : 'rgb(255, 255, 255)')
      await captureTheme('before-opposite')
      const oppositeButton = dialog.getByRole('button', { name: preference === 'light' ? /深色|Dark/ : /浅色|Light/, exact: true })
      await oppositeButton.click()
      await expect.poll(() => oppositeButton.getAttribute('aria-pressed'), { message: '反色主题按钮必须完成选中状态更新' }).toBe('true')
      await captureTheme('after-opposite')
      await expect.poll(() => readFile(path.join(info.data_dir, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8'), { message: '真实用户主题修改必须持久化' }).toContain(`preference: ${preference === 'light' ? 'dark' : 'light'}`)
    }
    catch (error) {
      await captureTheme('failure').catch(captureError => runtimeErrors.push(String(captureError)))
      console.error('NATIVE_THEME_DIAGNOSTICS', JSON.stringify({ preference, themeTrace, runtimeErrors, settingsWrites }))
      console.error(await diagnose(app))
      throw error
    }
    finally {
      await app.stop()
    }
  }, ASSEMBLY_TIMEOUT_MS)
}
