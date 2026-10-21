import { invoke } from 'dsh-tauri/client'

export async function writeClipboard(value: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value)
      return true
    }
    catch {}
  }
  return legacyCopy(value)
}

export async function readClipboard(): Promise<string | null> {
  // macOS 的 WKWebView 从不授权 Web Clipboard 读取，右键「粘贴」因此在调用前就注定失败
  // （issue #858）；桌面载体的读取能力同步判定后直接走原生命令，不靠捕获拒绝兜底。
  if ('dshDesktop' in globalThis) {
    try {
      return await invoke<string | null>('read_clipboard_text')
    }
    catch (error) {
      console.warn('[rightclick] read_clipboard_text failed:', error)
      return null
    }
  }
  if (navigator.clipboard?.readText) {
    try {
      return await navigator.clipboard.readText()
    }
    catch (error) {
      console.warn('[rightclick] navigator.clipboard.readText failed:', error)
    }
  }
  return null
}

/**
 * 剪贴板里没有纯文本时（复制的是文件/图片），交给宿主注入的 paste 垫片
 * （`src-tauri/src/desktop/paste.rs` 的 `__dsh_paste_clipboard__`）向原生补读
 * 并合成一次带附件的 paste（issue #1190）。浏览器直开没有该垫片。
 */
export async function pasteNativeClipboard(editable: HTMLElement): Promise<boolean> {
  const bridge = (globalThis as { __dsh_paste_clipboard__?: (target: HTMLElement) => Promise<boolean> }).__dsh_paste_clipboard__
  if (typeof bridge !== 'function')
    return false
  try {
    return await bridge(editable)
  }
  catch (error) {
    console.warn('[rightclick] native clipboard paste failed:', error)
    return false
  }
}

// --- internal ---

/** Clipboard API 不可写时的兜底：临时 textarea + execCommand。 */
function legacyCopy(value: string): boolean {
  const field = document.createElement('textarea')
  field.value = value
  field.setAttribute('readonly', '')
  field.style.cssText = 'position:fixed;left:-9999px;top:0'
  document.body.appendChild(field)
  field.select()
  const copied = document.execCommand('copy')
  field.remove()
  return copied
}
