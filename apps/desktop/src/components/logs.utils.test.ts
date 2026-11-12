import { describe, expect, it } from 'vitest'
import { containsPortInUseError, pickErrorLines } from './logs.utils'

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
describe('pickErrorLines', () => {
  it('保留 pending (waiting for service:) 行，即使错误行已占满预算', () => {
    const lines = [
      'ERROR dsh: startup failed',
      'ERROR dsh: 1 required plugin did not activate',
      'ERROR dsh: retry attempt 1 failed',
      'ERROR dsh: retry attempt 2 failed',
      'ERROR dsh: retry attempt 3 failed',
      'ERROR dsh: retry attempt 4 failed',
      'ERROR dsh: retry attempt 5 failed',
      'ERROR dsh: retry attempt 6 failed',
      'dsh-tauri-rightclick: pending (waiting for service: remote.session)',
    ]

    expect(pickErrorLines(lines)).toContain('dsh-tauri-rightclick: pending (waiting for service: remote.session)')
  })

  it('保留多服务等待与 mcp-client(<server>) 卡点行', () => {
    const lines = [
      'FATAL ERROR: Reached heap limit Allocation failed',
      '@scope/dsh-plugin-x: pending (waiting for services: uiRenderer, remote.session)',
      'mcp-client(github): server listed tool "search" more than once — invalid tool list',
    ]

    expect(pickErrorLines(lines)).toEqual([
      'FATAL ERROR: Reached heap limit Allocation failed',
      '@scope/dsh-plugin-x: pending (waiting for services: uiRenderer, remote.session)',
      'mcp-client(github): server listed tool "search" more than once — invalid tool list',
    ])
  })

  it('不把普通 pending / 裸 mcp-client 文本误当卡点行', () => {
    const lines = [
      'some package: pending without parentheses',
      'dsh-tauri-rightclick: pending (waiting for nothing)',
      'mcp-client: not a server label',
      'ERROR dsh: startup failed',
    ]

    expect(pickErrorLines(lines)).toEqual(['ERROR dsh: startup failed'])
  })

  it('结果总数封顶 8 行，卡点行优先于普通错误行占用预算', () => {
    const lines = [
      ...Array.from({ length: 8 }, (_, index) => `ERROR dsh: failure ${index}`),
      'a: pending (waiting for service: x)',
      'mcp-client(s): connection stalled',
    ]

    const picked = pickErrorLines(lines)

    expect(picked).toHaveLength(8)
    expect(picked).toEqual(expect.arrayContaining([
      'a: pending (waiting for service: x)',
      'mcp-client(s): connection stalled',
    ]))
  })

  it('保留被早期可恢复警告淹没的启动错误', () => {
    const warnings = Array.from({ length: 8 }, (_, index) => `WARN failed to refresh optional entry ${index}`)
    const terminal = 'ERROR cannot bind the main HTTP server: permission denied'
    expect(pickErrorLines([...warnings, terminal])).toEqual([...warnings.slice(1), terminal])
  })

  it('后续清理警告不会挤掉启动错误或服务卡点', () => {
    const terminal = 'ERROR cannot bind the main HTTP server: permission denied'
    const stall = 'mcp-client(local): connection stalled'
    const cleanup = Array.from({ length: 8 }, (_, index) => `WARN failed to clean up entry ${index}`)
    expect(pickErrorLines([terminal, stall, ...cleanup])).toEqual([terminal, ...cleanup.slice(-6), stall])
  })

  it('八条致命报告占满预算时不插入普通错误或卡点', () => {
    const reports = Array.from({ length: 9 }, (_, index) => `ERROR HARNESS_FATAL_REPORT: report ${index}`)
    const terminal = 'ERROR cannot bind the main HTTP server: permission denied'
    const stall = 'mcp-client(local): connection stalled'
    expect(pickErrorLines([...reports, terminal, stall])).toEqual(reports.slice(-8))
  })

  it('没有可定位证据时退回最后 8 行', () => {
    const lines = Array.from({ length: 10 }, (_, index) => `INFO line ${index}`)

    expect(pickErrorLines(lines)).toEqual(lines.slice(-8))
  })
})
