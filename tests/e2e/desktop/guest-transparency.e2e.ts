import type { Page } from 'playwright'
import type { ShellWindow } from '../setup/shell'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { expect, it } from 'vitest'
import { collectPageErrors, installErrorCollector, invoke, pageErrors, SHELL_ROOT, shellAppScope, WINDOW_TIMEOUT_MS } from '../setup/shell'

const app = shellAppScope()

it('preserves native Harness guest alpha while retaining opaque content', async () => {
  const shell = app.get()
  const main = shell.window.page
  await main.context().addInitScript(collectPageErrors)
  await installErrorCollector(main)
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><style>
      html,body{margin:0;width:100%;height:100%;background:transparent}
      body{display:grid;grid-template-columns:repeat(3,1fr)}
      #opaque{background:rgb(24,128,216)}
      #partial{background:rgba(24,128,216,.5)}
    </style></head><body><div id="opaque"></div><div id="partial"></div><div></div></body></html>`)
  })
  let remote: ShellWindow | undefined
  let label: string | undefined
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('透明度夹具未获得回环 TCP 地址')
    const url = `http://127.0.0.1:${address.port}/alpha`
    const before = new Set((await shell.windows()).map(window => window.label))
    await invoke(main, 'remote_open_window', { machineId: 'e2e-guest-alpha', url: '' })
    await expect.poll(async () => {
      remote = (await shell.windows()).find(window => !before.has(window.label))
      return remote?.label.startsWith('remote-')
    }, { timeout: WINDOW_TIMEOUT_MS, message: '必须创建允许回环服务的真实远端壳层' }).toBe(true)
    const page = remote!.page
    await expect.poll(() => page.locator(SHELL_ROOT).isVisible(), { timeout: WINDOW_TIMEOUT_MS, message: '远端壳层必须完成渲染' }).toBe(true)
    label = await invoke<string>(page, 'prepare_harness_webview', { url })
    expect(label, '必须通过应用命令创建 Harness 子视图').toMatch(/^harness-/)
    await invoke(page, 'update_harness_webview', { label, x: 10, y: 60, width: 360, height: 180, visible: true, zoomFactor: 1 })

    let guest: Page | undefined
    await expect.poll(() => {
      guest = shell.browser.contexts().flatMap(context => context.pages()).find(page => page.url() === url)
      return Boolean(guest)
    }, { timeout: WINDOW_TIMEOUT_MS, message: '子视图必须加载真实 HTTP 夹具' }).toBe(true)
    await guest!.waitForLoadState('load', { timeout: WINDOW_TIMEOUT_MS })
    expect(await guest!.evaluate(() => (window.__TAURI_INTERNALS__.metadata as { currentWebview?: { label?: string } })?.currentWebview?.label), '截图和夹具必须对应同一个原生子视图').toBe(label)
    await installErrorCollector(guest!)

    await expect.poll(async () => {
      const capture = await invoke<string>(page, 'capture_harness_webview', { label })
      return page.evaluate(async (source) => {
        const image = new Image()
        image.src = source
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth
        canvas.height = image.naturalHeight
        const context = canvas.getContext('2d')!
        context.drawImage(image, 0, 0)
        function pixel(fraction: number) {
          return Array.from(context.getImageData(Math.floor(canvas.width * fraction), Math.floor(canvas.height / 2), 1, 1).data)
        }
        return {
          opaque: pixel(1 / 6),
          partialAlpha: pixel(1 / 2)[3] / 255,
          clearAlpha: pixel(5 / 6)[3],
        }
      }, capture)
    }, { timeout: WINDOW_TIMEOUT_MS, interval: 250, message: '真实原生截图应保留不透明色块、半透明 alpha 和全透明 alpha，不能合成到白色底板' }).toEqual({
      opaque: [24, 128, 216, 255],
      partialAlpha: expect.closeTo(0.5, 2),
      clearAlpha: 0,
    })
    expect(await pageErrors(guest!), '夹具渲染不得产生页面异常').toEqual([])
    expect(await pageErrors(page), '原生子视图 IPC 不得产生壳层异常').toEqual([])
  }
  finally {
    try {
      if (remote && label)
        await invoke(remote.page, 'release_harness_webview', { label })
    }
    finally {
      try {
        if (remote)
          await shell.closeWindow(remote.label)
      }
      finally {
        if (server.listening) {
          server.closeAllConnections()
          await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
        }
      }
    }
  }
})
