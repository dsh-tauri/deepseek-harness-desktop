import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('setup error page copy-logs contract (SYST-04)', () => {
  it('exposes a copyLogsHandler that fetches run logs via the Tauri command', () => {
    const source = readFileSync(new URL('../src/layout/components/setup.tsx', import.meta.url), 'utf8')
    expect(source).toContain('copyLogsHandler')
    expect(source).toContain(`invoke<string>('read_run_logs')`)
  })

  it('routes the logs through the native clipboard helper, never navigator.clipboard', () => {
    const source = readFileSync(new URL('../src/layout/components/setup.tsx', import.meta.url), 'utf8')
    expect(source).not.toContain('navigator.clipboard.writeText')
    expect(source).toContain('writeClipboardText(')
  })

  it('surfaces copy success with the shared logs_copied toast', () => {
    const source = readFileSync(new URL('../src/layout/components/setup.tsx', import.meta.url), 'utf8')
    expect(source).toContain('messages.logs_copied')
  })

  it('delegates copy feedback to the shared clipboard helper', () => {
    const source = readFileSync(new URL('../src/layout/components/setup.tsx', import.meta.url), 'utf8')
    const nativeWrite = source.indexOf('writeClipboardText(')
    expect(nativeWrite).toBeGreaterThan(-1)
    // 调用点只记录日志（失败提示统一由 helper 弹出），成功文案经第二个参数传入
    const callSite = source.slice(nativeWrite, nativeWrite + 500)
    expect(callSite).toContain('catch (err)')
    expect(callSite).toContain('messages.logs_copied')

    const helper = readFileSync(new URL('../src/utils/clipboard.ts', import.meta.url), 'utf8')
    expect(helper).toContain('messages.clipboard_failed')
    expect(helper).toContain('variant: \'danger\'')
  })

  it('renders a ghost button labelled with the copy_logs i18n key', () => {
    const source = readFileSync(new URL('../src/layout/components/setup.tsx', import.meta.url), 'utf8')
    expect(source).toContain('button({ tone: \'ghost\'')
    expect(source).toContain('buttons.copy_logs')
  })

  it('decorates the button with the Copy icon from the project icon set', () => {
    const source = readFileSync(new URL('../src/layout/components/setup.tsx', import.meta.url), 'utf8')
    expect(source).toContain('Copy')
    expect(source).toContain('@gravity-ui/icons')
  })
})
