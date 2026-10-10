import { beforeEach, describe, expect, it } from 'vitest'
import { consumePortConflictRestart, resetPortConflictRestarts } from './utils'

const PORT_LINES = ['Error: listen EADDRINUSE: address already in use 127.0.0.1:3080']
const OTHER_LINES = ['JavaScript heap out of memory']

describe('端口冲突自动重启预算', () => {
  beforeEach(() => {
    resetPortConflictRestarts()
  })

  it('非端口冲突的崩溃不消耗预算', () => {
    expect(consumePortConflictRestart(OTHER_LINES)).toBe(false)
    expect(consumePortConflictRestart(OTHER_LINES)).toBe(false)
    expect(consumePortConflictRestart(PORT_LINES)).toBe(true)
  })

  it('端口冲突在预算内可反复自愈', () => {
    expect(consumePortConflictRestart(PORT_LINES)).toBe(true)
    expect(consumePortConflictRestart(PORT_LINES)).toBe(true)
  })

  it('预算耗尽后交回错误页，避免无限重启', () => {
    expect(consumePortConflictRestart(PORT_LINES)).toBe(true)
    expect(consumePortConflictRestart(PORT_LINES)).toBe(true)
    expect(consumePortConflictRestart(PORT_LINES)).toBe(true)
    expect(consumePortConflictRestart(PORT_LINES)).toBe(false)
    expect(consumePortConflictRestart(PORT_LINES)).toBe(false)
  })

  it('就绪后重置预算', () => {
    consumePortConflictRestart(PORT_LINES)
    consumePortConflictRestart(PORT_LINES)
    resetPortConflictRestarts()
    expect(consumePortConflictRestart(PORT_LINES)).toBe(true)
    expect(consumePortConflictRestart(PORT_LINES)).toBe(true)
    expect(consumePortConflictRestart(PORT_LINES)).toBe(true)
  })
})
