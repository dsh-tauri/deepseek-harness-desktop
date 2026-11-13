import process from 'node:process'
import { beforeAll, expect, it } from 'vitest'
import { ASSEMBLY_TIMEOUT_MS, completePreinstall, CONFIG_DIALOG, CONFIG_DIALOG_CLOSE, CONFIG_DIALOG_TITLE, CONFIG_NAV_APPLICATION, installErrorCollector, invoke, MAIN_LABEL, NAVBAR_ITEM_PROFILES, NAVBAR_MENU_CONFIG, pageErrors, PROFILE_MIGRATE_CANCEL, PROFILE_MIGRATE_DIALOG, PROFILE_MIGRATE_OPEN, shellAppScope, WINDOW_TIMEOUT_MS } from '../setup/shell'

const app = shellAppScope()

beforeAll(async () => {
  await completePreinstall(app.get().window.page)
}, ASSEMBLY_TIMEOUT_MS)

it('nested profile dialog blocks the parent and restores interaction after closing', async () => {
  const page = app.get().window.page
  await installErrorCollector(page)
  const config = await invoke<{ active_profile: string }>(page, 'get_app_config')
  const clone = await invoke<{ id: string }>(page, 'clone_profile', { sourceId: config.active_profile, name: 'nested-dialog-source' })
  try {
    if (process.platform === 'darwin') {
      await invoke(page, 'plugin:event|emit_to', { target: { kind: 'Window', label: MAIN_LABEL }, event: 'macos-menu-action', payload: 'desktop-profiles' })
    }
    else {
      await page.locator(NAVBAR_MENU_CONFIG).click({ timeout: WINDOW_TIMEOUT_MS })
      await page.locator(NAVBAR_ITEM_PROFILES).click({ timeout: WINDOW_TIMEOUT_MS })
    }
    const outer = page.locator(CONFIG_DIALOG)
    await outer.waitFor({ state: 'visible', timeout: WINDOW_TIMEOUT_MS })
    const title = page.locator(CONFIG_DIALOG_TITLE)
    await title.click({ clickCount: 3, timeout: WINDOW_TIMEOUT_MS })
    expect(await outer.evaluate(element => window.getSelection()?.containsNode(element, true)), '父弹窗文字在未遮罩时必须可以选中').toBe(true)
    await page.evaluate(() => window.getSelection()?.removeAllRanges())
    const titleBox = await title.boundingBox()
    expect(titleBox).not.toBeNull()
    const parentNav = page.locator(CONFIG_NAV_APPLICATION)
    const child = page.locator(PROFILE_MIGRATE_DIALOG)
    for (let cycle = 0; cycle < 2; cycle++) {
      await page.locator(PROFILE_MIGRATE_OPEN).click({ timeout: WINDOW_TIMEOUT_MS })
      await child.waitFor({ state: 'visible', timeout: WINDOW_TIMEOUT_MS })
      await expect.poll(async () => ({
        parentInert: await outer.evaluate(element => element.closest('[inert]') !== null),
        childInert: await child.evaluate(element => element.closest('[inert]') !== null),
      }), { message: '子弹窗就绪后必须隔离父弹窗并保持自身可交互' }).toEqual({
        parentInert: true,
        childInert: false,
      })
      expect(await parentNav.getAttribute('aria-current')).toBeNull()
      const box = await parentNav.boundingBox()
      expect(box, '父弹窗导航必须具有真实点击区域').not.toBeNull()
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
      expect(await parentNav.getAttribute('aria-current'), '子弹窗打开时点击遮罩不得切换父弹窗面板').toBeNull()
      expect(await child.isVisible(), '点击遮罩后迁移弹窗必须保持打开').toBe(true)
      await expect.poll(() => child.evaluate(element => element.closest('[inert]') === null)).toBe(true)
      expect(await outer.evaluate(element => element.closest('[inert]') !== null), '子弹窗打开时父弹窗必须隔离交互').toBe(true)
      await page.mouse.move(titleBox!.x + 1, titleBox!.y + titleBox!.height / 2)
      await page.mouse.down()
      await page.mouse.move(titleBox!.x + titleBox!.width - 1, titleBox!.y + titleBox!.height / 2, { steps: 10 })
      await page.mouse.up()
      expect(await outer.evaluate(element => window.getSelection()?.containsNode(element, true)), '子弹窗打开时拖动遮罩不得选中父弹窗文字').toBe(false)
      await page.keyboard.press('Tab')
      expect(await child.evaluate(element => element.contains((element.getRootNode() as ShadowRoot).activeElement)), '键盘焦点必须保留在子弹窗中').toBe(true)
      await page.screenshot({ path: 'test-results/nested-dialog.png' })
      await page.locator(PROFILE_MIGRATE_CANCEL).click({ timeout: WINDOW_TIMEOUT_MS })
      await child.waitFor({ state: 'detached', timeout: WINDOW_TIMEOUT_MS })
      expect(await outer.isVisible(), '关闭子弹窗必须保留父弹窗').toBe(true)
      expect(await outer.evaluate(element => element.closest('[inert]')), '关闭子弹窗后父弹窗必须恢复交互').toBeNull()
    }
    await parentNav.click({ timeout: WINDOW_TIMEOUT_MS })
    expect(await parentNav.getAttribute('aria-current')).toBe('true')
    await page.locator(CONFIG_DIALOG_CLOSE).click({ timeout: WINDOW_TIMEOUT_MS })
    expect(await pageErrors(page), '嵌套弹窗交互不得产生页面异常').toEqual([])
  }
  finally {
    await invoke(page, 'remove_profile', { id: clone.id })
  }
})
