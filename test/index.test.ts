import { describe, expect, it } from 'vitest'
import { containsHeapOomError, containsInotifyLimitError, formatLogLine, pickErrorLines } from '../src/components/logs.utils'

describe('formatLogLine', () => {
  it('strips the official GitHub release download prefix', () => {
    const url = 'https://github.com/dsh-tauri-desk/deepseek-harness-pkg/releases/download/dsh-0.1.1-rc.1-32457794457/deepseek-harness-pkg-windows.zip'
    expect(formatLogLine(`Download ${url}`)).toBe(
      'Download dsh-0.1.1-rc.1-32457794457/deepseek-harness-pkg-windows.zip',
    )
  })

  it('strips every mirror wrapper prefix', () => {
    const asset = 'https://github.com/dsh-tauri-desk/deepseek-harness-pkg/releases/download/dsh-0.1.x-x/deepseek-harness-pkg-linux.zip'
    for (const prefix of ['https://gh-proxy.com/', 'https://gh.llkk.cc/', 'https://ghfast.top/', 'https://ghproxy.net/']) {
      const formatted = formatLogLine(`Download ${prefix}${asset}`)
      expect(formatted).toBe('Download dsh-0.1.x-x/deepseek-harness-pkg-linux.zip')
    }
  })

  it('leaves ordinary log lines untouched', () => {
    expect(formatLogLine('[info] task 1 completed')).toBe('[info] task 1 completed')
  })
})

describe('pickErrorLines', () => {
  it('picks lines matching error markers, capped at 8', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`)
    lines[1] = 'fatal: something broke'
    lines[9] = 'Error: ENOENT'
    const picked = pickErrorLines(lines)
    expect(picked).toContain('fatal: something broke')
    expect(picked).toContain('Error: ENOENT')
    expect(picked.length).toBeLessThanOrEqual(8)
  })

  it('falls back to the last 8 lines when nothing matches', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `plain log ${i}`)
    const picked = pickErrorLines(lines)
    expect(picked).toEqual(lines.slice(-8))
  })

  it('handles empty input', () => {
    expect(pickErrorLines([])).toEqual([])
  })
})

describe('containsHeapOomError', () => {
  it('recognizes the V8 heap exhaustion message', () => {
    expect(containsHeapOomError([
      'FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory',
    ])).toBe(true)
  })

  it('recognizes the heap exhaustion marker even when split across lines', () => {
    expect(containsHeapOomError([
      'FATAL ERROR: Ineffective mark-compacts near heap limit',
      'Allocation failed - JavaScript heap out of memory',
    ])).toBe(true)
  })

  it('does not treat a generic abort or unrelated memory error as V8 heap exhaustion', () => {
    expect(containsHeapOomError(['Owned Harness process 42 exited with code 134; HARNESS_HEAP_OOM suspected'])).toBe(false)
    expect(containsHeapOomError(['Error: JavaScript memory allocation failed'])).toBe(false)
    expect(containsHeapOomError([])).toBe(false)
  })
})

describe('containsInotifyLimitError', () => {
  it('detects the Linux inotify ENOSPC signature', () => {
    const lines = [
      'Error: ENOSPC: System limit for number of file watchers reached, watch \'/home/u/.dsh/profiles/web\'',
      '  code: \'ENOSPC\',',
    ]
    expect(containsInotifyLimitError(lines)).toBe(true)
  })

  it('is case-insensitive on the ENOSPC marker', () => {
    expect(containsInotifyLimitError(['enospc: number of file watchers reached'])).toBe(true)
  })

  it('does not match a lone ENOSPC (must also mention file watchers)', () => {
    expect(containsInotifyLimitError(['Error: ENOSPC: no space left on device'])).toBe(false)
  })

  it('does not match unrelated file-watcher lines', () => {
    expect(containsInotifyLimitError(['file watchers initialized'])).toBe(false)
    expect(containsInotifyLimitError(['watch /x started'])).toBe(false)
  })

  it('handles empty input', () => {
    expect(containsInotifyLimitError([])).toBe(false)
  })
})
