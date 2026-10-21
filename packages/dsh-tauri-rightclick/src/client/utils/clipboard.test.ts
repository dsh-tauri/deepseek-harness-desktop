// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pasteNativeClipboard, readClipboard } from './clipboard'

const invoke = vi.hoisted(() => vi.fn())

vi.mock('dsh-tauri/client', () => ({ invoke }))

function stubWebClipboard(readText: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal('navigator', { clipboard: { readText } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  invoke.mockReset()
})

describe('readClipboard — 桌面载体', () => {
  it('桌面载体在调用前就分流到原生 read_clipboard_text（issue #858）', async () => {
    vi.stubGlobal('dshDesktop', { protocolVersion: 1 })
    const readText = vi.fn().mockRejectedValue(new Error('NotAllowedError'))
    stubWebClipboard(readText)
    invoke.mockResolvedValue('native text')

    await expect(readClipboard()).resolves.toBe('native text')
    expect(invoke).toHaveBeenCalledExactlyOnceWith('read_clipboard_text')
    expect(readText).not.toHaveBeenCalled()
  })

  it('桌面载体的 Web Clipboard 可用时也不改走它，读取通路保持唯一', async () => {
    vi.stubGlobal('dshDesktop', { protocolVersion: 1 })
    const readText = vi.fn().mockResolvedValue('web text')
    stubWebClipboard(readText)
    invoke.mockResolvedValue('native text')

    await expect(readClipboard()).resolves.toBe('native text')
    expect(readText).not.toHaveBeenCalled()
  })

  it('系统剪贴板没有文本时给 null，交给菜单提示', async () => {
    vi.stubGlobal('dshDesktop', { protocolVersion: 1 })
    stubWebClipboard(vi.fn())
    invoke.mockResolvedValue(null)

    await expect(readClipboard()).resolves.toBeNull()
  })

  it('原生命令失败时给 null，不把异常抛进菜单动作', async () => {
    vi.stubGlobal('dshDesktop', { protocolVersion: 1 })
    stubWebClipboard(vi.fn())
    invoke.mockRejectedValue(new Error('CLIPBOARD_TEXT_ACCESS: no clipboard'))

    await expect(readClipboard()).resolves.toBeNull()
  })
})

describe('pasteNativeClipboard — 宿主 paste 垫片', () => {
  it('没有垫片时按未处理返回，浏览器直开不额外弹错', async () => {
    await expect(pasteNativeClipboard(document.createElement('div'))).resolves.toBe(false)
  })

  it('把目标元素交给垫片并透传是否已处理（issue #1190）', async () => {
    const paste = vi.fn().mockResolvedValue(true)
    vi.stubGlobal('__dsh_paste_clipboard__', paste)
    const editable = document.createElement('div')

    await expect(pasteNativeClipboard(editable)).resolves.toBe(true)
    expect(paste).toHaveBeenCalledExactlyOnceWith(editable)
  })

  it('垫片抛错时按未处理返回，不把异常抛进菜单动作', async () => {
    vi.stubGlobal('__dsh_paste_clipboard__', vi.fn().mockRejectedValue(new Error('bridge failed')))

    await expect(pasteNativeClipboard(document.createElement('div'))).resolves.toBe(false)
  })
})

describe('readClipboard — 浏览器直开', () => {
  it('没有 dshDesktop 标记时只用 Web Clipboard，不碰原生命令', async () => {
    stubWebClipboard(vi.fn().mockResolvedValue('web text'))

    await expect(readClipboard()).resolves.toBe('web text')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('浏览器拒绝 Web Clipboard 且没有桌面载体时给 null', async () => {
    stubWebClipboard(vi.fn().mockRejectedValue(new Error('NotAllowedError')))

    await expect(readClipboard()).resolves.toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })
})
