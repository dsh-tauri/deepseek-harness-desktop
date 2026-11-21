import type { ShellWindow } from '../setup/shell'
import { describe, expect, it } from 'vitest'
import { collectPageErrors, installErrorCollector, invoke, pageErrors, SHELL_ROOT, shellAppScope, WINDOW_TIMEOUT_MS } from '../setup/shell'

describe('desktop window lifecycle', () => {
  const app = shellAppScope()

  it('opens a remote shell with its machine target', async () => {
    const shell = app.get()
    const main = shell.window.page
    await main.context().addInitScript(collectPageErrors)
    const machineId = 'e2e-machine " &/?#\\target'
    for (const url of ['', 'http://127.0.0.1:4001']) {
      const before = await shell.windows()
      let opened: ShellWindow | undefined
      try {
        await invoke(main, 'remote_open_window', { machineId, url })
        await expect.poll(async () => {
          opened = (await shell.windows()).find(candidate => !before.some(window => window.label === candidate.label))
          return Boolean(opened)
        }, { timeout: WINDOW_TIMEOUT_MS, message: `远端命令必须创建独立 Electron 壳层（url=${url}）` }).toBe(true)
        const remote = opened!
        await expect.poll(() => remote.page.locator(SHELL_ROOT).isVisible(), { timeout: WINDOW_TIMEOUT_MS, message: '远端壳层必须完成首屏渲染' }).toBe(true)
        expect(new URL(remote.page.url()).pathname).toBe('/index.html')
        expect(new URLSearchParams(new URL(remote.page.url()).hash.slice(1)).get('remoteMachineId')).toBe(machineId)
        expect(await remote.page.evaluate(() => window.__TAURI_INTERNALS__.metadata?.currentWindow?.label)).toBe(remote.label)
        expect(await invoke(remote.page, 'remote_bridge_ping')).toBe('ok')
        await invoke(main, 'remote_open_window', { machineId, url })
        expect((await shell.windows()).map(window => window.label).sort()).toEqual([...before.map(window => window.label), remote.label].sort())
        expect(await pageErrors(remote.page)).toEqual([])
      }
      finally {
        if (opened)
          await shell.closeWindow(opened.label)
      }
    }
  })

  it('creates and destroys a real secondary Electron window through Tauri IPC', async () => {
    const shell = app.get()
    await shell.window.page.context().addInitScript(collectPageErrors)
    await installErrorCollector(shell.window.page)
    const before = await shell.windows()
    expect(before.map(window => window.label), '启动后必须存在主窗口').toContain('main')

    const nativeBefore = await invoke<string[]>(shell.window.page, 'plugin:window|get_all_windows')
    expect(nativeBefore, '原生窗口管理器必须包含主窗口').toContain('main')

    const opened = await shell.openWindow()
    try {
      expect((await invoke<string[]>(shell.window.page, 'plugin:window|get_all_windows')).sort(), '原生窗口管理器必须注册且仅注册一个新窗口').toEqual([...nativeBefore, opened.label].sort())
      expect(opened.label, '新窗口必须使用独立的原生窗口标签').not.toBe('main')
      expect(opened.page, '新窗口必须使用独立的 CDP 页面').not.toBe(shell.window.page)
      expect(await opened.page.evaluate(() => window.__TAURI_INTERNALS__.metadata?.currentWindow?.label), 'CDP 页面元数据必须指向新窗口').toBe(opened.label)
      expect((await shell.windows()).map(window => window.label), '新窗口必须真实出现在 Electron 窗口集合中').toContain(opened.label)
      expect(await pageErrors(opened.page), '新窗口 IPC 交互不应产生页面异常').toEqual([])
      expect(await pageErrors(shell.window.page), '主窗口 IPC 交互不应产生页面异常').toEqual([])
    }
    finally {
      await shell.closeWindow(opened.label)
    }

    expect(opened.page.isClosed(), '关闭 IPC 必须真正销毁新窗口的 CDP 页面').toBe(true)
    await expect.poll(async () => (await invoke<string[]>(shell.window.page, 'plugin:window|get_all_windows')).sort(), { timeout: WINDOW_TIMEOUT_MS, message: '关闭后原生窗口管理器必须注销新窗口' }).toEqual(nativeBefore.sort())
    expect((await shell.windows()).map(window => window.label), '关闭新窗口后原有窗口集合必须保持不变').toEqual(before.map(window => window.label))
  })
})
