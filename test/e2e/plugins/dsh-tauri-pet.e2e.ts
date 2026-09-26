/**
 * PP1：`dsh-tauri-pet` 的宿主 SSE 路由在真实 dsh 进程里可用。
 *
 * 断言对象是外部世界（HTTP 响应字节），不是插件的自我报告：连接建立后服务端
 * 立刻刷一帧注释（`get.ts` 的 pushComment），所以「收到 `:` 开头的一行」就是
 * 「路由已注册且 handler 跑起来了」的正向证据。
 *
 * 上半部分只走 HTTP：断言对象是路由注册与 SSE 字节；下半部分是浏览器层用例，
 * 覆盖 Bundle Slot 挂载。
 */

import type { Browser } from 'playwright'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import {
  expectNoSyntheticFallbacks,
  launchDshBrowser,
  newDshPage,
  openSettings,
  PET_STYLES,
  selectSettingsSection,
  SETTINGS_NAV_ITEM,
  SETTINGS_TRIGGER,
} from '../support/browser'

/** 与 `packages/dsh-tauri-pet/src/shared/constants.ts` 的 SESSION_STREAM_PATH 对齐。 */
const SESSION_STREAM_PATH = '/api/desktop/dsh-tauri-pet/session/stream'

/** `/api/**` 要求浏览器会话；Cookie 由编排在根路径用一次性 token 换得。 */
function apiHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { cookie: inject('dshCookie'), ...extra }
}

/** 带超时地读一段响应体（SSE 永不结束，读满即中止）。 */
async function readChunk(response: Response, minimumChars: number, timeoutMs = 15_000): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined)
    throw new Error('响应没有 body 流')

  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + timeoutMs
  while (text.length < minimumChars) {
    if (Date.now() > deadline)
      throw new Error(`读取 SSE 首帧超时（${timeoutMs}ms）；已收到：${JSON.stringify(text)}`)
    const { value, done } = await reader.read()
    if (done)
      break
    text += decoder.decode(value, { stream: true })
  }
  await reader.cancel()
  return text
}

/** 心跳周期（与 `packages/dsh-tauri-pet/src/shared/constants.ts` 的 SSE_KEEPALIVE_MS 对齐）。 */
const KEEPALIVE_MS = 15_000

/** 第 2 帧心跳的可接受上界：一个周期 + 2s 抖动余量，不因读慢了就放宽。 */
const KEEPALIVE_WINDOW_MAX_MS = 17_000

/** 一次读取的结果：累计文本、自建连起的耗时、已消费的响应块数。 */
interface SseRead {
  text: string
  elapsedMs: number
  chunks: number
}

/** 一条可中止的 SSE 连接；读游标跨多次读取保持累计。 */
interface SseStream {
  readonly response: Response
  readKeepalives: (count: number, timeoutMs: number) => Promise<SseRead>
  abort: () => Promise<void>
}

/** 累计文本里的 `: keepalive` 注释帧个数（h3 的 pushComment 产出 `<comment>\n\n`）。 */
function keepaliveCount(text: string): number {
  return text.match(/: keepalive/g)?.length ?? 0
}

/**
 * 建立 SSE 连接，并按「读到第 N 次 keepalive」为止累计响应体。
 *
 * `readChunk` 读满字符数就中止，证明不了周期心跳与多帧共存；这里保留读游标，
 * 由调用方决定何时停（心跳 15s 一跳，调用方负责给足超时）。
 */
async function openStream(): Promise<SseStream> {
  const controller = new AbortController()
  const startedAt = performance.now()
  const response = await fetch(`${inject('dshBaseUrl')}${SESSION_STREAM_PATH}`, {
    headers: apiHeaders({ accept: 'text/event-stream' }),
    signal: controller.signal,
  })

  const reader = response.body?.getReader()
  if (reader === undefined)
    throw new Error('响应没有 body 流')

  const decoder = new TextDecoder()
  let text = ''
  let chunks = 0

  return {
    response,
    async readKeepalives(count: number, timeoutMs: number): Promise<SseRead> {
      const deadline = Date.now() + timeoutMs
      while (keepaliveCount(text) < count) {
        if (Date.now() > deadline)
          throw new Error(`等待第 ${count} 次 keepalive 超时（${timeoutMs}ms）；已收到：${JSON.stringify(text)}`)
        const { value, done } = await reader.read()
        if (done)
          break
        chunks += 1
        text += decoder.decode(value, { stream: true })
      }
      return { text, elapsedMs: performance.now() - startedAt, chunks }
    },
    async abort(): Promise<void> {
      controller.abort()
      await reader.cancel().catch(() => {})
    },
  }
}

it('验证 SSE 路由连上后立刻下发就绪帧', async () => {
  const response = await fetch(`${inject('dshBaseUrl')}${SESSION_STREAM_PATH}`, {
    headers: apiHeaders({ accept: 'text/event-stream' }),
  })

  expect(response.status, 'SSE 路由必须存在且返回 200').toBe(200)
  expect(response.headers.get('content-type') ?? '', '必须是 text/event-stream').toContain('text/event-stream')

  const body = await readChunk(response, 4)
  expect(body, '接入即刷一帧注释帧（连接已就绪）').toMatch(/^:\s*keepalive/)
})

it('[反向] 验证同一路径拒绝未声明的方法', async () => {
  const response = await fetch(`${inject('dshBaseUrl')}${SESSION_STREAM_PATH}`, {
    method: 'POST',
    headers: apiHeaders(),
    body: '{}',
  })
  expect(response.status, '只声明了 GET，POST 必须 405').toBe(405)
  expect(response.headers.get('allow') ?? '').toContain('GET')
})

it('验证长连接期间按 15s 周期持续下发心跳注释帧', async () => {
  const stream = await openStream()
  try {
    expect(stream.response.status, 'SSE 路由必须存在且返回 200').toBe(200)

    const read = await stream.readKeepalives(2, KEEPALIVE_MS + 5_000)
    expect(keepaliveCount(read.text), '长连接内必须收到两帧心跳').toBeGreaterThanOrEqual(2)
    expect(read.elapsedMs, '第 2 帧不得早于一个心跳周期（否则不是周期心跳）').toBeGreaterThanOrEqual(KEEPALIVE_MS)
    expect(read.elapsedMs, '第 2 帧必须落在 15s–17s 窗口内').toBeLessThanOrEqual(KEEPALIVE_WINDOW_MAX_MS)

    const between = read.text.split(': keepalive').slice(1, 2).join('')
    expect(between, '两帧心跳之间没有会话事件，不得伪造 data: 帧').not.toContain('data:')
  }
  finally {
    await stream.abort()
  }
}, 40_000)

it('验证连接断开后重连仍能立刻拿到就绪帧', async () => {
  const first = await openStream()
  const firstRead = await first.readKeepalives(1, KEEPALIVE_MS + 5_000)
  expect(firstRead.text, '连接 A 必须先拿到就绪帧').toContain(': keepalive')
  await first.abort()

  await new Promise(resolve => setTimeout(resolve, 200))

  const second = await openStream()
  try {
    expect(second.response.status, '重连必须同样返回 200').toBe(200)

    const read = await second.readKeepalives(1, KEEPALIVE_MS + 5_000)
    expect(read.chunks, '就绪帧必须在首个响应块内到达，而不是等 15s 心跳').toBe(1)
    expect(read.text, '重连后必须立刻拿到就绪帧').toContain(': keepalive')
  }
  finally {
    await second.abort()
  }

  const log = readFileSync(join(inject('dshHome'), 'dsh-web.log'), 'utf8')
  expect(log, '断开重连不得在宿主留下未捕获异常').not.toMatch(/ERR_STREAM_|nhandledPromiseRejection|nhandled [Rr]ejection|ncaught [Ee]xception/)
})

it('验证两个并发消费者各自独立就绪', async () => {
  const [first, second] = await Promise.all([openStream(), openStream()])
  try {
    expect(first.response.status, '消费者 A 必须拿到 200').toBe(200)
    expect(second.response.status, '消费者 B 必须拿到 200').toBe(200)

    const [readA, readB] = await Promise.all([
      first.readKeepalives(1, KEEPALIVE_MS + 5_000),
      second.readKeepalives(1, KEEPALIVE_MS + 5_000),
    ])
    expect(readA.text, 'A 必须各自收到就绪帧').toContain(': keepalive')
    expect(readB.text, 'B 必须各自收到就绪帧').toContain(': keepalive')

    await first.abort()
    const afterAbort = await second.readKeepalives(2, KEEPALIVE_MS + 5_000)
    expect(keepaliveCount(afterAbort.text), 'A 断开后 B 仍必须继续收到第 2 帧心跳').toBeGreaterThanOrEqual(2)
  }
  finally {
    await first.abort()
    await second.abort()
  }
})

describe('L2 客户端', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await launchDshBrowser()
  })

  afterAll(async () => {
    await browser.close()
  })

  it('验证顶层页面不注册任何桌宠槽位', async () => {
    const top = await newDshPage(browser, { path: '/', ready: SETTINGS_TRIGGER })
    try {
      await openSettings(top.page, top.frame, top.syntheticFallbacks)

      const slots = await top.frame.evaluate(() => ({
        hasTrigger: document.querySelector('.dshp-settings-trigger') !== null,
        petStyles: document.querySelectorAll('style[cssr-id="dsh-tauri-pet-styles"]').length,
        petSections: document.querySelectorAll('[id="dsh-tauri-pet-settings"]').length,
      }))

      expect(slots.hasTrigger, '顶层页面必须真的渲染出设置触发器（否则这条断言是空转）').toBe(true)
      expect(slots.petStyles, '顶层页面不得挂载桌宠样式与菜单补丁（window.parent === window 早退）').toBe(0)
      expect(slots.petSections, '顶层页面不得注册桌宠设置分区').toBe(0)
      expectNoSyntheticFallbacks(top)
      expect(top.errors, '早退路径不得产出应用级错误').toEqual([])
    }
    finally {
      await top.close()
    }
  })

  it('验证 iframe 内桌宠设置分区正常渲染且无崩溃', async () => {
    const app = await newDshPage(browser, { ready: PET_STYLES })
    try {
      await openSettings(app.page, app.frame, app.syntheticFallbacks)

      const nav = app.frame.locator(SETTINGS_NAV_ITEM).filter({ hasText: '宠物' })
      expect(await nav.count(), '桌宠分区必须在导航里注册且唯一（同 id 不得重复注册）').toBe(1)
      expect(
        await nav.first().evaluate(element => element.className.includes('nav-item')),
        '分区导航项必须由设置侧栏渲染',
      ).toBe(true)

      await selectSettingsSection(app.page, app.frame, '宠物', app.syntheticFallbacks)

      const panel = app.frame.locator('.dshp-pet__page')
      await expect.poll(
        async () => await panel.count(),
        { timeout: 20_000, message: '切到桌宠分区后必须渲染出 dshp-pet__page' },
      ).toBe(1)

      const panelState = await panel.evaluate(element => ({
        tabs: Array.from(element.querySelectorAll('[role="tab"]')).map(tab => ({
          text: tab.textContent?.trim(),
          selected: tab.getAttribute('aria-selected'),
        })),
        sizeSlider: (() => {
          const slider = element.querySelector('input[type="range"]') as HTMLInputElement | null
          return slider === null ? null : { min: slider.min, max: slider.max, label: slider.getAttribute('aria-label') }
        })(),
        alerts: Array.from(element.querySelectorAll('[role="alert"]')).map(alert => alert.textContent?.trim()),
      }))

      expect(panelState.tabs.length, '桌宠分区必须渲染出两个来源标签').toBe(2)
      expect(panelState.tabs.filter(tab => tab.selected === 'true').length, '恰有一个标签处于激活态').toBe(1)
      expect(panelState.tabs[0]?.selected, '第一个标签必须是激活态').toBe('true')
      expect(panelState.sizeSlider, '桌宠分区必须渲染尺寸滑块').not.toBeNull()
      expect(panelState.sizeSlider!.min, '尺寸下限必须与插件常量一致').toBe('50')
      expect(panelState.sizeSlider!.max, '尺寸上限必须与插件常量一致').toBe('200')
      expect(panelState.alerts, '正常渲染时不得出现错误条').toEqual([])
      expectNoSyntheticFallbacks(app)
      expect(app.errors, '分区注册与渲染不得抛出应用级错误').toEqual([])
    }
    finally {
      await app.close()
    }
  })
})
