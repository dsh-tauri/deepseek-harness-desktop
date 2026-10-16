import { readFileSync } from 'node:fs'
import i18next from 'i18next'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resources } from '../src/i18n/index.resource'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => vi.fn()) }))
vi.mock('@/config/client', () => ({ queryClient: { invalidateQueries: vi.fn() } }))
vi.mock('../src/store/modules/harness-updater', () => ({
  harnessUpdater: { checkForUpdate: vi.fn() },
}))

const { harness } = await import('../src/store/modules/harness')
const { IFRAME_FRAME_GRACE_TIMEOUT, IFRAME_LOAD_TIMEOUT } = await import('../src/store/modules/harness/constants')

function locale(file: 'zh-CN.json' | 'en-US.json'): Record<string, string> {
  const raw = readFileSync(new URL(`../src/i18n/locales/${file}`, import.meta.url), 'utf8')
  return JSON.parse(raw) as Record<string, string>
}

/**
 * 摆出「服务已就绪、iframe 已挂载」的状态并等观察者落地。
 *
 * valtio 的订阅回调在微任务里批处理，状态变更后必须放一个 tick，看门狗才会按新
 * 状态重新计时（`advanceTimersByTimeAsync` 同时推进真实微任务）。
 */
async function mountIframe(overrides: Record<string, unknown> = {}) {
  Object.assign(harness, {
    status: 'ready',
    serviceHealthy: true,
    serviceRunning: true,
    iframeLoaded: false,
    iframeError: false,
    iframeAliveKey: null,
    busyAction: null,
    ...overrides,
  })
  await vi.advanceTimersByTimeAsync(0)
}

beforeAll(async () => {
  // 与壳层同一份资源初始化默认 i18next 实例：断言的是真实译文，而不是未初始化时的 key 回退
  await i18next.init({
    resources,
    lng: 'zh-CN',
    keySeparator: false,
    nsSeparator: false,
    initAsync: false,
  })
})

beforeEach(async () => {
  vi.useFakeTimers()
  await mountIframe({ serviceHealthy: false, iframeLoaded: true, iframeError: true })
})

afterEach(async () => {
  harness.serviceHealthy = false
  await vi.advanceTimersByTimeAsync(0)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('iframe dsh document watchdog', () => {
  it('logs arm, load rearm and expiry once with the current recovery flags', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await mountIframe({ iframeKey: 1077 })
    const context = {
      status: 'ready',
      serviceRunning: true,
      serviceHealthy: true,
      iframeKey: 1077,
      iframeAlive: false,
      iframeLoaded: false,
      iframeError: false,
    }
    expect(warn).toHaveBeenCalledWith('[Harness] iframe watchdog armed', { ...context, timeoutMs: 20000 })
    harness.startupReason = 'unrelated activity'
    await vi.advanceTimersByTimeAsync(0)
    expect(warn).toHaveBeenCalledTimes(1)

    harness.markIframeLoaded()
    await vi.advanceTimersByTimeAsync(0)
    expect(warn).toHaveBeenLastCalledWith('[Harness] iframe watchdog armed', { ...context, iframeLoaded: true, timeoutMs: 5000 })
    expect(warn).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(4999)
    expect(harness.iframeError).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(warn).toHaveBeenLastCalledWith('[Harness] iframe watchdog expired', { ...context, iframeLoaded: true, timeoutMs: 5000 })
    expect(harness.showIframeError).toBe(true)
    expect(warn).toHaveBeenCalledTimes(3)
  })

  it.each(['alive', 'unhealthy', 'error'] as const)('logs cancellation when the frame becomes %s without changing the deadline', async (reason) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await mountIframe()
    if (reason === 'alive')
      harness.markIframeAlive()
    else if (reason === 'unhealthy')
      harness.serviceHealthy = false
    else
      harness.fail('startup failure', undefined, undefined, undefined, true)
    await vi.advanceTimersByTimeAsync(0)
    expect(warn).toHaveBeenLastCalledWith('[Harness] iframe watchdog cancelled', expect.objectContaining({
      status: reason === 'error' ? 'error' : 'ready',
      serviceHealthy: reason !== 'unhealthy',
      iframeAlive: reason === 'alive',
    }))
    expect(warn).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(20000)
    expect(harness.iframeError).toBe(false)
  })

  // issue #705：浏览器内部错误页（代理拦截、DNS 失败等）同样触发 iframe 的 load，
  // 只按 load 判定就会把它当成加载成功，用户看不到任何重试入口。
  it('shows the retryable error screen when the frame commits a document but never reports a dsh page', async () => {
    await mountIframe({ iframeLoaded: true })

    await vi.advanceTimersByTimeAsync(IFRAME_FRAME_GRACE_TIMEOUT - 1)
    expect(harness.iframeError).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(harness.iframeError).toBe(true)
    expect(harness.iframeLoaded).toBe(false)
  })

  it('falls back to the full load deadline when the frame never commits a document at all', async () => {
    await mountIframe()

    await vi.advanceTimersByTimeAsync(IFRAME_LOAD_TIMEOUT - 1)
    expect(harness.iframeError).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(harness.iframeError).toBe(true)
  })

  it('never shows the error screen while the frame reports a live dsh page', async () => {
    await mountIframe()
    harness.markIframeAlive()
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(IFRAME_LOAD_TIMEOUT + IFRAME_FRAME_GRACE_TIMEOUT)
    expect(harness.iframeError).toBe(false)
  })

  it('requires a fresh frame report after the retry remounts the iframe', async () => {
    await mountIframe({ iframeLoaded: true })
    harness.markIframeAlive()
    await vi.advanceTimersByTimeAsync(0)

    harness.refreshIframe()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.iframeAlive).toBe(false)

    await vi.advanceTimersByTimeAsync(800)
    await mountIframe({ iframeLoaded: true })
    await vi.advanceTimersByTimeAsync(IFRAME_FRAME_GRACE_TIMEOUT)
    expect(harness.iframeError).toBe(true)
  })

  // 上一代文档在重挂窗口（refreshIframe 的 800ms）里发出的迟到消息不能替新文档背书。
  it('ignores a late frame report that belongs to the previous iframe generation', async () => {
    await mountIframe({ iframeLoaded: true })
    harness.markIframeAlive()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.iframeAlive).toBe(true)

    harness.refreshIframe()
    harness.markIframeAlive()
    await vi.advanceTimersByTimeAsync(800)

    // 新文档提交（浏览器错误页同样会触发 load），但整代下来只有上一代的迟到自报
    harness.markIframeLoaded()
    await vi.advanceTimersByTimeAsync(IFRAME_FRAME_GRACE_TIMEOUT)

    expect(harness.iframeAlive).toBe(false)
    expect(harness.iframeError).toBe(true)
  })

  // 帧内导航（整帧跳到远端登录/错误页）不换 iframe 元素：自报过的文档离开后必须重新确认。
  it('requires a fresh frame report after the frame document navigates away', async () => {
    await mountIframe()
    harness.markIframeAlive()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.iframeAlive).toBe(true)

    harness.markIframeLeaving()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.iframeAlive).toBe(false)
    expect(harness.iframeLoaded).toBe(false)

    // 新文档再没自报（远端页面加载失败）→ 整体加载上限内给出可重试界面
    await vi.advanceTimersByTimeAsync(IFRAME_LOAD_TIMEOUT)
    expect(harness.iframeError).toBe(true)
  })

  it('keeps the frame alive again when the next document reports itself', async () => {
    await mountIframe({ iframeLoaded: true })
    harness.markIframeAlive()
    harness.markIframeLeaving()
    await vi.advanceTimersByTimeAsync(0)

    harness.markIframeAlive()
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(IFRAME_LOAD_TIMEOUT + IFRAME_FRAME_GRACE_TIMEOUT)
    expect(harness.iframeError).toBe(false)
  })

  it('explains the failure only when the frame never reported a dsh page', async () => {
    await mountIframe({ iframeError: true })
    expect(harness.iframeErrorHint).toBe(locale('zh-CN.json')['ui.iframe_unreachable_hint'])

    harness.markIframeAlive()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.iframeErrorHint).toBe('')
  })
})

describe('iframe unreachable i18n contract', () => {
  it('defines the unreachable hint in both locales', () => {
    expect(locale('zh-CN.json')['ui.iframe_unreachable_hint']).toBeTypeOf('string')
    expect(locale('en-US.json')['ui.iframe_unreachable_hint']).toBeTypeOf('string')
  })
})
