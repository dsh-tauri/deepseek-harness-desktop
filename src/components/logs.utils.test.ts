import { describe, expect, it } from 'vitest'
import { containsPortInUseError } from './logs.utils'

describe('containsPortInUseError', () => {
  it('命中 dsh 端口冲突的真实日志形态', () => {
    const lines = [
      'WARN dsh: dsh: startup failed: 1 required plugin did not activate',
      '  webserver (required)',
      '    Error: listen EADDRINUSE: address already in use 127.0.0.1:3080',
    ]
    expect(containsPortInUseError(lines)).toBe(true)
  })

  it('只有 EADDRINUSE 而无 address already in use 不算端口冲突', () => {
    expect(containsPortInUseError(['some other EADDRINUSE context'])).toBe(false)
  })

  it('其它崩溃不误判为端口冲突', () => {
    const lines = [
      'FATAL ERROR: Reached heap limit Allocation failed',
      'JavaScript heap out of memory',
    ]
    expect(containsPortInUseError(lines)).toBe(false)
  })

  it('空日志不命中', () => {
    expect(containsPortInUseError([])).toBe(false)
  })
})
