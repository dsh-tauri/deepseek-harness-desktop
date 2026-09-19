import { readFileSync } from 'node:fs'
import { invoke } from '@tauri-apps/api/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeClipboardText } from '../../src/utils/clipboard'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

const CLIPBOARD_CALL_SITES = [
  '../src/ui/config/debug.tsx',
  '../src/layout/components/navbar.tsx',
  '../src/layout/components/setup-preinstall.tsx',
  '../src/layout/components/setup.tsx',
]

describe('clipboard integration', () => {
  afterEach(() => {
    vi.resetAllMocks()
  })

  it('routes every shell copy action through the native helper', () => {
    for (const path of CLIPBOARD_CALL_SITES) {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8')
      expect(source).not.toContain('navigator.clipboard.writeText')
      expect(source).toContain('writeClipboardText(')
      // 成功/失败提示统一在 helper 内弹出，调用点不再各写一份 danger toast
      expect(source).not.toContain('messages.logs_copy_failed')
    }
  })

  it('toasts success and failure inside the helper', () => {
    const source = readFileSync(new URL('../src/utils/clipboard.ts', import.meta.url), 'utf8')
    expect(source).toContain('toast(')
    expect(source).toContain('messages.clipboard_copied')
    expect(source).toContain('messages.clipboard_failed')
  })

  it('writes the exact text through the native clipboard command', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined as never)

    await expect(writeClipboardText('diagnostic logs')).resolves.toBeUndefined()

    expect(invoke).toHaveBeenCalledExactlyOnceWith('write_clipboard_text', { text: 'diagnostic logs' })
  })

  it('propagates native clipboard failures to the caller', async () => {
    const failure = new Error('clipboard unavailable')
    vi.mocked(invoke).mockRejectedValue(failure)

    await expect(writeClipboardText('diagnostic logs')).rejects.toBe(failure)
  })
})
