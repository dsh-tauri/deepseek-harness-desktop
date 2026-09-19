// @vitest-environment node
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * 桌宠素材响应头 / 取消清理契约。
 *
 * 1. **响应头**：`raw.githubusercontent.com` 对非 ASCII 文件名会附上
 *    `content-disposition: attachment; filename=.../待机呼吸休闲.webm`，而
 *    `@tauri-apps/plugin-http` 用 `new Headers(responseHeaders)` 复刻响应头，这个
 *    构造器只接受 ISO-8859-1 ⇒ 整条 fetch reject ⇒ `dsh-pet-component` 静默降级为
 *    「直连远端播放」⇒ IndexedDB 永远只有空库（dsh-pet 动画名全是中文，即 100% 命中）。
 * 2. **取消清理**：`fetch_read_body` 读到 EOF 就关掉 Rust 侧的响应资源，于是
 *    fire-and-forget 的 `fetch_cancel` / `fetch_cancel_body` 必然收到
 *    `The resource id ... is invalid`；不吞掉就会让每次中止（切动画 / 关窗口）都冒一个
 *    unhandled rejection，被桌宠窗口的全局处理器记成 ERROR 日志刷屏。
 *
 * 两处都由 pnpm patch 修在 `dist-js/index.js` + `index.cjs`：这里既锁「补丁在册且已装
 * 进产物」，也打桩 `window.__TAURI_INTERNALS__.invoke` 跑真实 `fetch`（含中止路径）。
 */
const ANIMATION_URL = 'https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/e1ff8c1e4001878cbb80441262d530e16541f138/dsh-pet/assets/webm/%E5%BE%85%E6%9C%BA%E5%91%BC%E5%90%B8%E4%BC%91%E9%97%B2.webm'
const HAZARDOUS_HEADERS: [string, string][] = [
  ['content-type', 'audio/webm'],
  ['content-disposition', 'attachment; filename=dsh-pet/assets/webm/待机呼吸休闲.webm'],
]

let bodyReads = 0
let hanging = false
const invoke = vi.fn(async (command: string) => {
  if (command === 'plugin:http|fetch')
    return 1
  if (command === 'plugin:http|fetch_send')
    return { status: 200, statusText: 'OK', url: ANIMATION_URL, headers: HAZARDOUS_HEADERS, rid: 2 }
  if (command === 'plugin:http|fetch_read_body')
    return hanging ? new Promise<number[]>(() => {}) : (bodyReads++ === 0 ? [104, 105, 0] : [1])
  if (command === 'plugin:http|fetch_cancel' || command === 'plugin:http|fetch_cancel_body')
    return hanging ? Promise.reject(new Error('The resource id 1234 is invalid')) : undefined
  return undefined
})

describe('pet asset headers contract', () => {
  beforeAll(() => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } })
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it('fetches an asset whose response carries a non ISO-8859-1 header', async () => {
    const { fetch: pluginFetch } = await import('@tauri-apps/plugin-http')
    const response = await pluginFetch(ANIMATION_URL, { cache: 'force-cache' })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('audio/webm')
    // 中文文件名头被剔除（组件从不读它），而不是让整条 fetch 炸掉。
    expect(response.headers.get('content-disposition')).toBeNull()
    expect(await response.text()).toBe('hi')
  })

  it('does not leak unhandled rejections when cancellation cleanup fails', async () => {
    const { fetch: pluginFetch } = await import('@tauri-apps/plugin-http')
    const rejections: unknown[] = []
    const collect = (reason: unknown) => void rejections.push(reason)
    const controller = new AbortController()

    hanging = true
    try {
      const response = await pluginFetch(ANIMATION_URL, { signal: controller.signal })
      process.on('unhandledRejection', collect)
      controller.abort()
      await expect(response.text()).rejects.toThrow('Request cancelled')
      await new Promise(resolve => setTimeout(resolve, 50))
      process.off('unhandledRejection', collect)

      expect(invoke).toHaveBeenCalledWith('plugin:http|fetch_cancel', { rid: 1 }, undefined)
      expect(invoke).toHaveBeenCalledWith('plugin:http|fetch_cancel_body', { rid: 2 }, undefined)
      expect(rejections).toEqual([])
    }
    finally {
      process.off('unhandledRejection', collect)
      hanging = false
    }
  })

  it('keeps the filter patch registered in the workspace and applied on disk', () => {
    const workspace = readFileSync(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8')
    expect(workspace).toContain('@tauri-apps/plugin-http@2.6.0')
    expect(workspace).toContain('patches/@tauri-apps__plugin-http@2.6.0.patch')

    const patch = readFileSync(new URL('../patches/@tauri-apps__plugin-http@2.6.0.patch', import.meta.url), 'utf8')
    expect(patch).toContain('ISO_8859_1_ONLY')

    for (const file of ['index.js', 'index.cjs']) {
      const bundle = readFileSync(new URL(`../node_modules/@tauri-apps/plugin-http/dist-js/${file}`, import.meta.url), 'utf8')
      expect(bundle).toContain('toResponseHeaders(responseHeaders)')
      expect(bundle).not.toContain('new Headers(responseHeaders)')
      expect(bundle.match(/\.catch\(\(\) => \{\}\)/g)?.length).toBeGreaterThanOrEqual(2)
    }
  })

  it('reports pet asset failures instead of swallowing them', () => {
    const source = readFileSync(new URL('../src/pet/app.tsx', import.meta.url), 'utf8')
    expect(source).toContain('onError={reportPetAssetError}')
    expect(source).toMatch(/reportPetIssue\('asset'/)
  })
})
