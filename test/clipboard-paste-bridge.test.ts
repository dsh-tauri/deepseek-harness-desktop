// @vitest-environment node
import { Buffer } from 'node:buffer'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { readSource } from './setup/read-source'

/**
 * `PASTE_SHIM_JS` 的可执行契约：右键菜单在没有纯文本时调用
 * `window.__dsh_paste_clipboard__`，由垫片向宿主补读文件/图片并合成 paste（issue #1190）。
 *
 * 这些用例在 vm 里执行真实注入脚本，锁住暴露范围、文件优先顺序与返回值语义；
 * 字符串断言无法发现全局被移出子 frame 守卫或布尔语义被改坏。
 */
const SHIM = readSource('src-tauri/src/desktop/paste.rs').match(/PASTE_SHIM_JS: &str = r#"([\s\S]*?)"#;/)?.[1] ?? ''

const REQ_FILES = 'dsh://clipboard-files:read'
const RES_FILES = 'dsh://clipboard-files:reply'
const REQ_IMAGE = 'dsh://clipboard-image:read'
const RES_IMAGE = 'dsh://clipboard-image:reply'
const FILE = { data_url: 'data:text/plain;base64,QQ==', mime: 'text/plain', filename: 'a.txt' }
const IMAGE = { data_url: 'data:image/png;base64,AAAA' }

interface ShimReply {
  files?: unknown[]
  rejected?: unknown[]
  data_url?: string
}

function loadShim(options: { childFrame: boolean, files?: ShimReply, image?: ShimReply }) {
  const requests: string[] = []
  const events: unknown[] = []
  const listeners: ((event: { source: unknown, data: unknown }) => void)[] = []
  const parent: Record<string, unknown> = {}

  class TestDataTransfer {
    files: unknown[] = []
    items = { add: (item: unknown) => { this.files.push(item) } }
    getData = (): string => ''
    setData = (): void => {}
  }

  class TestClipboardEvent {
    clipboardData: unknown
    constructor(_type: string, init?: { clipboardData?: unknown }) {
      this.clipboardData = init?.clipboardData
    }
  }

  class TestBlob {
    constructor(public parts: unknown[], public init: { type?: string } = {}) {}
    get type(): string {
      return this.init.type ?? ''
    }
  }

  class TestFile extends TestBlob {
    constructor(parts: unknown[], public name: string, init: { type?: string } = {}) {
      super(parts, init)
    }
  }

  const window: Record<string, any> = {
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (type === 'message')
        listeners.push(listener as (event: { source: unknown, data: unknown }) => void)
    },
  }
  window.parent = options.childFrame ? parent : window
  window.parent.postMessage = (message: { type: string, id: string }) => {
    requests.push(message.type)
    const reply = message.type === REQ_FILES ? options.files : options.image
    if (!reply)
      return
    const type = message.type === REQ_FILES ? RES_FILES : RES_IMAGE
    queueMicrotask(() => {
      for (const listener of listeners)
        listener({ source: window.parent, data: { type, id: message.id, ...reply } })
    })
  }

  runInNewContext(SHIM, {
    window,
    document: { activeElement: null, addEventListener: () => {} },
    DataTransfer: TestDataTransfer,
    ClipboardEvent: TestClipboardEvent,
    Event: class { constructor() {} },
    Blob: TestBlob,
    File: TestFile,
    atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
    setTimeout,
    clearTimeout,
    queueMicrotask,
  })

  return {
    window,
    requests,
    events,
    target: { isConnected: true, dispatchEvent: (event: unknown) => events.push(event) },
  }
}

describe('paste shim — 右键菜单原生粘贴入口', () => {
  it('脚本可从 Rust 源中提取（防止格式变动后测试空跑）', () => {
    expect(SHIM).toContain('function pasteFromNative(target)')
  })

  it('只在子 frame 暴露入口，顶层壳层文档没有全局', () => {
    const top = loadShim({ childFrame: false })
    const child = loadShim({ childFrame: true })

    expect(top.window.__dsh_paste_clipboard__).toBeUndefined()
    expect(typeof child.window.__dsh_paste_clipboard__).toBe('function')
  })

  it('文件优先：派发一次 paste 后不再请求图片', async () => {
    const { window, requests, events, target } = loadShim({ childFrame: true, files: { files: [FILE] } })

    await expect(window.__dsh_paste_clipboard__(target)).resolves.toBe(true)
    expect(requests).toEqual([REQ_FILES])
    expect(events).toHaveLength(1)
    expect((events[0] as { clipboardData: { files: unknown[] } }).clipboardData.files).toHaveLength(1)
  })

  it('文件全部被拒时返回已处理，且不回落图片通路', async () => {
    const { window, requests, events, target } = loadShim({
      childFrame: true,
      files: { files: [], rejected: [{ filename: 'big.zip', reason: 'too_large' }] },
    })

    await expect(window.__dsh_paste_clipboard__(target)).resolves.toBe(true)
    expect(requests).toEqual([REQ_FILES])
    expect(events).toHaveLength(0)
  })

  it('剪贴板只有图片时走图片通路', async () => {
    const { window, requests, events, target } = loadShim({
      childFrame: true,
      files: { files: [] },
      image: IMAGE,
    })

    await expect(window.__dsh_paste_clipboard__(target)).resolves.toBe(true)
    expect(requests).toEqual([REQ_FILES, REQ_IMAGE])
    expect(events).toHaveLength(1)
    const file = (events[0] as { clipboardData: { files: { name: string, type: string }[] } }).clipboardData.files[0]
    expect(file.name).toBe('clipboard-image.png')
    expect(file.type).toBe('image/png')
  })

  it('剪贴板为空时返回未处理，调用方保留原提示', async () => {
    const { window, requests, events, target } = loadShim({ childFrame: true, files: { files: [] }, image: {} })

    await expect(window.__dsh_paste_clipboard__(target)).resolves.toBe(false)
    expect(requests).toEqual([REQ_FILES, REQ_IMAGE])
    expect(events).toHaveLength(0)
  })

  it('目标无法接收 paste 时不谎报已处理', async () => {
    const { window, events } = loadShim({ childFrame: true, files: { files: [FILE] }, image: {} })
    const detached = { isConnected: false, dispatchEvent: (event: unknown) => events.push(event) }

    await expect(window.__dsh_paste_clipboard__(detached)).resolves.toBe(false)
    expect(events).toHaveLength(0)
  })
})
