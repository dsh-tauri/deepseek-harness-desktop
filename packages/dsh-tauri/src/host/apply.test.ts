import type { HostContext, IndexInjectRow } from './types'
import { createContext, runInContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from './apply'
import { MEDIA_RECORDER_SHIM_SCRIPT } from './media-recorder-shim'
import { TEXT_AUTOSPACE_SHIM_SCRIPT } from './text-autospace-shim'
import { WEBRTC_FALLBACK_SCRIPT } from './webrtc-fallback-shim'

afterEach(() => {
  vi.unstubAllEnvs()
})

function activate() {
  const listeners: ((table: IndexInjectRow[]) => void)[] = []
  const on = vi.fn((event: string, listener: (table: IndexInjectRow[]) => void) => {
    expect(event).toBe('webserver/index-inject')
    listeners.push(listener)
    return () => {
      const index = listeners.indexOf(listener)
      if (index >= 0) {
        listeners.splice(index, 1)
      }
    }
  })
  const ctx = {
    connection: { authorizeIndex: () => false },
    webServer: { register: () => () => {} },
    effect: (callback: () => unknown) => { callback() },
    on,
  } as unknown as HostContext
  apply(ctx)
  return { on, collect: (): IndexInjectRow[] => {
    const table: IndexInjectRow[] = []
    for (const listener of listeners) listener(table)
    return table
  } }
}

/** 在最小页面语境里执行注入脚本，取回 `globalThis.dshDesktop` 的落地值。 */
interface Marker {
  protocolVersion?: number
  deviceInfo?: () => Promise<string>
  updates?: unknown
  browser?: unknown
}

function runMarker(script: string, search: string): Marker | undefined {
  const sandbox: Record<string, unknown> = { location: { search }, URLSearchParams, navigator: { userAgent: 'tauri-test-agent' } }
  runInContext(script, createContext(sandbox))
  return sandbox.dshDesktop as Marker | undefined
}

describe('desktop account marker', () => {
  /** 官方账号 UI 的准入就是 `'dshDesktop' in globalThis`，因此这里验的是真实脚本行为。 */
  it('marks the embedded index only when the shell claimed it', async () => {
    vi.stubEnv('DSH_TAURI_EMBEDDED', '1')
    const { collect, on } = activate()

    expect(on).toHaveBeenCalled()
    const rows = collect()
    const row = rows.find(item => item.kind === 'script' && item.text.includes('protocolVersion'))
    expect(row?.kind).toBe('script')
    expect(row?.kind === 'script' ? row.placement : undefined).toBe('head')

    const script = row?.kind === 'script' ? row.text : ''
    // 与官方 preload 的非 app 来源分支同值：只声明协议版本，产品 API 一律缺席。
    const carrier = runMarker(script, '?t=1&dshDesktop=1')
    expect(carrier?.protocolVersion).toBe(1)
    expect(carrier?.updates).toBeUndefined()
    expect(carrier?.browser).toBeUndefined()
    // 官方 0.2.0 反馈表单读 `dshDesktop.deviceInfo?.()`；Tauri 侧以 userAgent 兜底。
    await expect(carrier?.deviceInfo?.()).resolves.toBe('tauri-test-agent')
    expect(runMarker(script, '?t=1')).toBeUndefined()
  })

  it('injects the media recorder shim into the head', () => {
    vi.stubEnv('DSH_TAURI_EMBEDDED', '1')
    const rows = activate().collect()

    const shim = rows.find(item => item.kind === 'script' && item.text === MEDIA_RECORDER_SHIM_SCRIPT)
    expect(shim?.kind === 'script' ? shim.placement : undefined).toBe('head')
  })

  it('does not advertise a desktop carrier to standalone web', () => {
    vi.stubEnv('DSH_TAURI_EMBEDDED', '0')
    const { collect, on } = activate()

    expect(on).not.toHaveBeenCalled()
    expect(collect()).toEqual([])
  })
})

const WEBKITGTK_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
const CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'

interface RecorderCall {
  stream: unknown
  options?: Record<string, unknown>
}

function installRecorder(userAgent: string) {
  const calls: RecorderCall[] = []
  class FakeMediaRecorder {
    static isTypeSupported(type: string): boolean {
      return type === 'audio/webm;codecs=opus' || type === 'audio/ogg;codecs=opus'
    }

    constructor(stream: unknown, options?: Record<string, unknown>) {
      calls.push({ stream, options })
    }
  }
  const sandbox: Record<string, unknown> = { navigator: { userAgent }, MediaRecorder: FakeMediaRecorder }
  runInContext(MEDIA_RECORDER_SHIM_SCRIPT, createContext(sandbox))
  return { sandbox, calls, original: FakeMediaRecorder }
}

interface RecorderInstance {
  stream: unknown
  options?: Record<string, unknown>
}

function recorderOf(sandbox: Record<string, unknown>) {
  return sandbox.MediaRecorder as unknown as new (stream: unknown, options?: Record<string, unknown>) => RecorderInstance
}

describe('media recorder mime default', () => {
  /** WebKitGTK 不指定 mimeType 时录不到数据；补默认类型是该脚本唯一目的。 */
  it('fills a supported mimeType for default calls in WebKitGTK', () => {
    const { sandbox, calls } = installRecorder(WEBKITGTK_UA)

    Reflect.construct(recorderOf(sandbox), ['stream'])

    expect(calls).toHaveLength(1)
    expect(calls[0]?.options).toEqual({ mimeType: 'audio/webm;codecs=opus' })
  })

  it('keeps explicit options untouched', () => {
    const { sandbox, calls } = installRecorder(WEBKITGTK_UA)

    Reflect.construct(recorderOf(sandbox), ['stream', { mimeType: 'audio/ogg;codecs=opus', audioBitsPerSecond: 128000 }])

    expect(calls[0]?.options).toEqual({ mimeType: 'audio/ogg;codecs=opus', audioBitsPerSecond: 128000 })
  })

  it('preserves other options when adding the mimeType', () => {
    const { sandbox, calls } = installRecorder(WEBKITGTK_UA)

    Reflect.construct(recorderOf(sandbox), ['stream', { audioBitsPerSecond: 128000 }])

    expect(calls[0]?.options).toEqual({ audioBitsPerSecond: 128000, mimeType: 'audio/webm;codecs=opus' })
  })

  it('leaves recorders without isTypeSupported untouched', () => {
    class BareRecorder {}
    const sandbox: Record<string, unknown> = { navigator: { userAgent: WEBKITGTK_UA }, MediaRecorder: BareRecorder }
    runInContext(MEDIA_RECORDER_SHIM_SCRIPT, createContext(sandbox))

    expect(sandbox.MediaRecorder).toBe(BareRecorder)
  })

  it('treats an empty mimeType as omitted', () => {
    const { sandbox, calls } = installRecorder(WEBKITGTK_UA)

    Reflect.construct(recorderOf(sandbox), ['stream', { mimeType: '' }])

    expect(calls[0]?.options).toEqual({ mimeType: 'audio/webm;codecs=opus' })
  })

  it('keeps native constructor semantics', () => {
    const { sandbox, calls } = installRecorder(WEBKITGTK_UA)
    const Recorder = recorderOf(sandbox)
    class SubRecorder extends Recorder {}
    const sub = new SubRecorder('stream')

    expect(sub).toBeInstanceOf(SubRecorder)
    expect((sandbox.MediaRecorder as unknown as { name: string }).name).toBe('FakeMediaRecorder')
    expect(() => (Recorder as unknown as (stream: unknown) => unknown)('stream')).toThrow(TypeError)
    expect(calls).toHaveLength(1)
  })

  it('does not touch non-WebKitGTK pages', () => {
    const { sandbox, original } = installRecorder(CHROME_UA)

    expect(recorderOf(sandbox)).toBe(original)
  })

  it('wraps only once', () => {
    const { sandbox, calls } = installRecorder(WEBKITGTK_UA)
    runInContext(MEDIA_RECORDER_SHIM_SCRIPT, createContext(sandbox))

    Reflect.construct(recorderOf(sandbox), ['stream'])

    expect(calls).toHaveLength(1)
    expect(calls[0]?.options).toEqual({ mimeType: 'audio/webm;codecs=opus' })
  })
})

interface FakeStyle {
  attrs: Record<string, string>
  textContent: string
  setAttribute: (name: string, value: string) => void
}

function runAutospace(userAgent: string) {
  const appended: FakeStyle[] = []
  const style: FakeStyle = {
    attrs: {},
    textContent: '',
    setAttribute(name, value) {
      this.attrs[name] = value
    },
  }
  const sandbox: Record<string, unknown> = {
    navigator: { userAgent },
    document: { createElement: () => style, head: { appendChild: (node: FakeStyle) => appended.push(node) } },
  }
  runInContext(TEXT_AUTOSPACE_SHIM_SCRIPT, createContext(sandbox))
  return appended
}

describe('text autospace override', () => {
  it('injects the style row into the head', () => {
    vi.stubEnv('DSH_TAURI_EMBEDDED', '1')
    const rows = activate().collect()

    const row = rows.find(item => item.kind === 'script' && item.text === TEXT_AUTOSPACE_SHIM_SCRIPT)
    expect(row?.kind === 'script' ? row.placement : undefined).toBe('head')
  })

  it('disables text-autospace under WebKitGTK', () => {
    const appended = runAutospace(WEBKITGTK_UA)

    expect(appended).toHaveLength(1)
    expect(appended[0]?.textContent).toBe('html,body{text-autospace:no-autospace!important}')
  })

  it('leaves Chromium pages alone', () => {
    expect(runAutospace(CHROME_UA)).toHaveLength(0)
  })

  it('leaves macOS WebKit alone', () => {
    expect(runAutospace('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15')).toHaveLength(0)
  })
})

interface FallbackNode {
  children: FallbackNode[]
  attrs: Record<string, string>
  textContent: string
  isConnected: boolean
  listeners: Record<string, () => void>
}

function runFallback(userAgent: string, withRtc = false, language = 'en-US') {
  const posted: unknown[] = []
  const mounted: FallbackNode[] = []
  const makeNode = (): FallbackNode => ({
    children: [],
    attrs: {},
    textContent: '',
    isConnected: false,
    listeners: {},
    ...{
      setAttribute(this: FallbackNode, key: string, value: string) { this.attrs[key] = value },
      addEventListener(this: FallbackNode, type: string, fn: () => void) { this.listeners[type] = fn },
      append(this: FallbackNode, ...nodes: FallbackNode[]) { this.children.push(...nodes) },
      remove(this: FallbackNode) { this.isConnected = false },
      appendChild(this: FallbackNode, node: FallbackNode) {
        node.isConnected = true
        mounted.push(node)
      },
      style: {},
    },
  })
  const body = makeNode()
  const sandbox: Record<string, unknown> = {
    navigator: { userAgent, language },
    location: { href: 'http://127.0.0.1:3080/chat?x=1&dshDesktop=1' },
    URL,
    DOMException,
    parent: { postMessage: (message: unknown) => posted.push(message) },
    document: { body, documentElement: body, createElement: makeNode },
  }
  if (withRtc)
    sandbox.RTCPeerConnection = function Native() {}
  sandbox.globalThis = sandbox
  runInContext(WEBRTC_FALLBACK_SCRIPT, createContext(sandbox))
  return { sandbox, posted, mounted }
}

describe('webrtc fallback', () => {
  it('keeps RTCPeerConnection undefined and offers the browser when WebKitGTK lacks WebRTC', () => {
    const { sandbox, posted, mounted } = runFallback(WEBKITGTK_UA)

    expect(sandbox.RTCPeerConnection).toBeUndefined()
    expect(mounted).toHaveLength(1)
    const [message, open] = mounted[0]!.children
    expect(message!.textContent).toContain('WebRTC')
    open!.listeners.click!()
    expect(posted).toEqual([expect.objectContaining({
      type: 'dsh://tauri:invoke',
      cmd: 'open_external_url',
      args: { url: 'http://127.0.0.1:3080/chat?x=1' },
    })])
  })

  it('localizes the prompt', () => {
    const { sandbox, mounted } = runFallback(WEBKITGTK_UA, false, 'zh-CN')
    expect(sandbox.RTCPeerConnection).toBeUndefined()
    expect(mounted[0]!.children[0]!.textContent).toContain('实时语音')
  })

  it('keeps native WebRTC and non-WebKitGTK pages untouched', () => {
    const native = runFallback(WEBKITGTK_UA, true)
    expect((native.sandbox.RTCPeerConnection as { name: string }).name).toBe('Native')
    expect(runFallback(CHROME_UA).sandbox.RTCPeerConnection).toBeUndefined()
  })

  it('is injected into the embedded head', () => {
    vi.stubEnv('DSH_TAURI_EMBEDDED', '1')
    const row = activate().collect().find(item => item.kind === 'script' && item.text === WEBRTC_FALLBACK_SCRIPT)
    expect(row?.kind === 'script' ? row.placement : undefined).toBe('head')
  })
})
