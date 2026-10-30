import { describe, expect, it } from 'vitest'
import { ASSEMBLY_TIMEOUT_MS, completePreinstall, installErrorCollector, invoke, pageErrors, SETTLE_MS, SHELL_ROOT, SHELL_WEBVIEW, shellAppScope } from './setup/shell'

const shell = shellAppScope()

describe('electron 主窗口', () => {
  it('主窗口渲染出 React 根节点', async () => {
    await expect
      .poll(() => shell.get().window.page.locator(`${SHELL_ROOT} *`).count(), { message: '主窗口应挂载 React 树', timeout: 60_000 })
      .toBeGreaterThan(0)
  })

  it('Tauri IPC 往返返回真实命令结果', async () => {
    const dev = await invoke<boolean>(shell.get().window.page, 'is_dev_build')
    expect(dev, 'debug 产物应返回 is_dev_build=true').toBe(true)
  })

  it('壳层内嵌页面指向本机内核且无页面级报错', async () => {
    const page = shell.get().window.page
    await installErrorCollector(page)
    await completePreinstall(page)

    const webview = page.locator(SHELL_WEBVIEW)
    await expect.poll(() => webview.count(), { message: '壳层未挂载内嵌页面', timeout: ASSEMBLY_TIMEOUT_MS }).toBe(1)

    const src = await webview.getAttribute('src')
    expect(src, '内嵌页面未指向本机内核服务地址').toMatch(/^http:\/\/127\.0\.0\.1:\d+/)

    await new Promise(resolve => setTimeout(resolve, SETTLE_MS))
    expect(await pageErrors(page), '壳层出现页面级报错').toEqual([])
  }, ASSEMBLY_TIMEOUT_MS)
})
