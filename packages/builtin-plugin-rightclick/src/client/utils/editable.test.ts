/**
 * editable.test.ts — editable.ts 粘贴/选区工具的 DOM 逻辑单测。
 *
 * 默认 node 环境（无 jsdom），用轻量替身 stub DOM 全局（DataTransfer /
 * ClipboardEvent / InputEvent / document / getSelection）模拟三态元素与
 * contenteditable 编辑器接管行为，验证 pasteInto 的逐级回退阶梯：
 * 合成 paste 事件（preventDefault / 同步写入视为接管）→ execCommand('insertText') → 原 DOM 写入。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

// 与实现文件同源：import 引用即验证导出面，避免未导出被遗漏。
import { pasteInto } from './editable'

class FakeDataTransfer {
  private data = new Map<string, string>()
  setData(type: string, value: string): void {
    this.data.set(type, value)
  }

  getData(type: string): string {
    return this.data.get(type) ?? ''
  }
}

interface FakeClipboardEventInit {
  bubbles?: boolean
  cancelable?: boolean
  clipboardData?: FakeDataTransfer | null
}

class FakeClipboardEvent extends Event {
  clipboardData: FakeDataTransfer | null
  constructor(type: string, init: FakeClipboardEventInit = {}) {
    super(type, init)
    // Chromium 构造器支持 clipboardData init；node 替身手工回填。
    this.clipboardData = init.clipboardData ?? null
  }
}

interface FakeInputEventInit {
  bubbles?: boolean
  inputType?: string
  data?: string | null
}

class FakeInputEvent extends Event {
  inputType: string
  data: string | null
  constructor(type: string, init: FakeInputEventInit = {}) {
    super(type, init)
    this.inputType = init.inputType ?? ''
    this.data = init.data ?? null
  }
}

class StubInputElement {}

interface EditableLike {
  focus: ReturnType<typeof vi.fn>
  textContent: string | null
  contains: (node: unknown) => boolean
  dispatchEvent: ReturnType<typeof vi.fn>
  value: string
  selectionStart: number | null
  selectionEnd: number | null
  setRangeText: ReturnType<typeof vi.fn>
}

/** 构造 contenteditable 风格替身（非 HTMLInputElement 实例），记录派发的事件。 */
function contentEditableStub(initial: string): EditableLike & { received: unknown[] } {
  const stub: EditableLike & { received: unknown[] } = {
    textContent: initial,
    focus: vi.fn(),
    contains: () => false,
    dispatchEvent: vi.fn(),
    value: '',
    selectionStart: null,
    selectionEnd: null,
    setRangeText: vi.fn(),
    received: [],
  }
  stub.dispatchEvent = vi.fn((event: Event) => {
    stub.received.push(event)
    return true
  })
  return stub
}

/** 构造 HTMLInputElement 替身（走 replaceSelection 路径）。 */
function inputStub(initial: string): EditableLike {
  return Object.assign(Object.create(StubInputElement.prototype), {
    value: initial,
    selectionStart: null,
    selectionEnd: null,
    setRangeText: vi.fn(),
    focus: vi.fn(),
    contains: () => false,
    dispatchEvent: vi.fn(),
  })
}

/** contenteditable 场景的公共全局 stub。 */
function stubContentEditableGlobals(): void {
  vi.stubGlobal('HTMLInputElement', class {})
  vi.stubGlobal('HTMLTextAreaElement', class {})
  vi.stubGlobal('DataTransfer', FakeDataTransfer)
  vi.stubGlobal('ClipboardEvent', FakeClipboardEvent)
}

/** input 场景的公共全局 stub（HTMLInputElement 命中 + 粘贴路径所需全局齐备）。 */
function stubInputGlobals(): void {
  vi.stubGlobal('HTMLInputElement', StubInputElement)
  vi.stubGlobal('HTMLTextAreaElement', class {})
  vi.stubGlobal('InputEvent', FakeInputEvent)
  vi.stubGlobal('DataTransfer', FakeDataTransfer)
  vi.stubGlobal('ClipboardEvent', FakeClipboardEvent)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pasteInto — input/textarea', () => {
  it('委托 replaceSelection：setRangeText + 合成 input 事件', () => {
    stubInputGlobals()
    const input = inputStub('abc')

    pasteInto(input as unknown as HTMLElement, 'X')

    // 无选区时取 value.length：start/end = 3，追加在末尾。
    expect(input.setRangeText).toHaveBeenCalledWith('X', 3, 3, 'end')
    const event = input.dispatchEvent.mock.calls[0]?.[0] as FakeInputEvent
    expect(event).toBeInstanceOf(FakeInputEvent)
    expect(event.type).toBe('input')
    expect(event.inputType).toBe('insertText')
    expect(event.data).toBe('X')
  })
})

describe('pasteInto — contenteditable', () => {
  it('编辑器接管合成 paste 事件时写入并短路（不再 execCommand / DOM 写入）', () => {
    stubContentEditableGlobals()
    const execCommand = vi.fn(() => true)
    vi.stubGlobal('document', { execCommand })
    const stub = contentEditableStub('ab')
    // 模拟 Lexical 式编辑器：读取 clipboardData 纯文本并同步写入 + preventDefault。
    stub.dispatchEvent = vi.fn((event: FakeClipboardEvent) => {
      stub.received.push(event)
      stub.textContent = `${stub.textContent}${event.clipboardData?.getData('text/plain') ?? ''}`
      event.preventDefault()
      return false
    })

    pasteInto(stub as unknown as HTMLElement, 'X')

    expect(stub.textContent).toBe('abX')
    const event = stub.received[0] as FakeClipboardEvent
    expect(event.type).toBe('paste')
    expect(event.bubbles).toBe(true)
    expect(event.cancelable).toBe(true)
    expect(event.clipboardData?.getData('text/plain')).toBe('X')
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('接收方 preventDefault 但 DOM 异步更新（ProseMirror 竞态）：不触发兜底插入', () => {
    stubContentEditableGlobals()
    const execCommand = vi.fn(() => true)
    vi.stubGlobal('document', { execCommand })
    const stub = contentEditableStub('ab')
    // 模拟内核粘贴命令：preventDefault + 异步写模型，同步 textContent 仍是旧值。
    // 修复前会被误判“没插入”而走 execCommand 兜底 → 右键粘贴重复两次。
    stub.dispatchEvent = vi.fn((event: FakeClipboardEvent) => {
      stub.received.push(event)
      event.preventDefault()
      return false
    })

    expect(() => pasteInto(stub as unknown as HTMLElement, 'X')).not.toThrow()

    expect(stub.textContent).toBe('ab')
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('编辑器未接管（内容未变化）时回退 execCommand(\'insertText\')', () => {
    stubContentEditableGlobals()
    const execCommand = vi.fn(() => true)
    vi.stubGlobal('document', { execCommand })
    const stub = contentEditableStub('ab')

    pasteInto(stub as unknown as HTMLElement, 'X')

    expect(stub.textContent).toBe('ab')
    expect(execCommand).toHaveBeenCalledWith('insertText', false, 'X')
  })

  it('execCommand 也失败时退回原 DOM 写入（选区未知则返回 false）', () => {
    stubContentEditableGlobals()
    vi.stubGlobal('document', { execCommand: vi.fn(() => false) })
    vi.stubGlobal('getSelection', () => ({ rangeCount: 0 }))
    const stub = contentEditableStub('ab')

    expect(pasteInto(stub as unknown as HTMLElement, 'X')).toBe(false)
  })
})
