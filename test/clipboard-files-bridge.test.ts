// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readLocale, readSource } from './setup/read-source'

/**
 * 剪贴板文件回退桥的协议契约（issue #1160）。
 *
 * Linux/WebKitGTK 下 iframe 的 paste 事件拿不到 `text/uri-list` 文件条目，由注入脚本
 * （`src-tauri/src/desktop/paste.rs` 的 `PASTE_SHIM_JS`）向宿主请求原生读取，
 * 宿主（`src/layout/components/iframe.tsx` → `bridge::read_clipboard_files`）回包后
 * 重新合成一次带全部附件的 paste。
 *
 * 与图片桥（#610）同源：两端只按 `type` 字面量互相识别，任何一侧改名都会让贴图/贴文件
 * 静默失败。这些用例把 shim、宿主、命令注册与 Rust 实现的字面量锁在一起。
 */
const REQ_TYPE = 'dsh://clipboard-files:read'
const REPLY_TYPE = 'dsh://clipboard-files:reply'

describe('clipboard files bridge protocol', () => {
  const shim = readSource('src-tauri/src/desktop/paste.rs')
  const iframe = readSource('src/layout/components/iframe.tsx')
  const builder = readSource('src-tauri/src/desktop/builder.rs')
  const clipboard = readSource('src-tauri/src/bridge/clipboard.rs')

  it('shim and host negotiate the same request/reply types', () => {
    expect(shim).toContain(`var REQ_FILES_TYPE = '${REQ_TYPE}'`)
    expect(shim).toContain(`var RES_FILES_TYPE = '${REPLY_TYPE}'`)
    expect(iframe).toContain(`case '${REQ_TYPE}':`)
    expect(iframe).toContain(`type: '${REPLY_TYPE}'`)
  })

  it('identifies host replies by type only, for both image and files', () => {
    expect(shim).toContain('data.type !== RES_TYPE && data.type !== RES_FILES_TYPE')
    expect(shim).toContain('event.source !== window.parent')
    expect(iframe).not.toContain(`source: '${REPLY_TYPE}'`)
  })

  it('asks the host for files first, then falls back to the image read', () => {
    const filesFirst = shim.indexOf(`request(REQ_FILES_TYPE)`)
    const imageAfter = shim.indexOf(`request(REQ_TYPE)`)
    expect(filesFirst).toBeGreaterThan(-1)
    expect(imageAfter).toBeGreaterThan(filesFirst)
  })

  it('dispatches every accepted file in one synthetic paste', () => {
    // dsh 输入框按 `clipboardData.items` 采集附件：多文件必须进同一个 DataTransfer
    expect(shim).toContain('dt.items.add(files[i])')
    expect(shim).toContain('dispatchFilesPaste(target, entries)')
  })

  it('host replies with the files/rejected payload shape the shim reads', () => {
    expect(shim).toContain('fileData && fileData.files')
    expect(iframe).toContain('files, rejected')
    expect(clipboard).toContain('pub struct ClipboardFilesResponse')
    // Rust 序列化为 snake_case，两端字段名一致
    expect(clipboard).toContain('pub files: Vec<ClipboardFileEntry>')
    expect(clipboard).toContain('pub rejected: Vec<ClipboardFileRejection>')
  })

  it('command is implemented and registered', () => {
    expect(clipboard).toContain('pub async fn read_clipboard_files')
    // arboard 3.6.1 的公开读取 API（不存在 get_file_list/Unavailable，用错会编译失败）
    expect(clipboard).toContain('clipboard.get().file_list()')
    expect(clipboard).not.toContain('Error::Unavailable')
    expect(clipboard).toContain('arboard::Error::ClipboardNotSupported')
    expect(builder).toContain('crate::bridge::read_clipboard_files,')
  })

  it('rejection notice is localized in both locales', () => {
    for (const locale of ['zh-CN', 'en-US']) {
      const messages = readLocale(locale)
      expect(messages['messages.clipboard_files_partial']).toContain('{{total}}')
      expect(messages['messages.clipboard_files_partial']).toContain('{{names}}')
    }
  })

  it('exposes the native paste entry point used by the right-click menu (issue #1190)', () => {
    expect(shim).toContain('function pasteFromNative(target)')
    expect(shim).toContain('window.__dsh_paste_clipboard__ = pasteFromNative')
  })

  it('keeps the image bridge untouched (regression guard for #610)', () => {
    expect(shim).toContain(`var RES_TYPE = 'dsh://clipboard-image:reply'`)
    expect(iframe).toContain('read_clipboard_image')
  })
})
