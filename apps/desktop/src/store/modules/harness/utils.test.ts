import type { InternalPluginPhaseDetail, InternalPluginsPhasePayload } from './types'
import { describe, expect, it } from 'vitest'
import { internalPluginReason } from './utils'

const COPY: Record<string, string> = {
  'status.internal_waiting': 'Waiting for internal plugins.',
  'status.internal_checking': 'Checking {{total}} internal plugins.',
  'status.internal_installing': 'Installing {{total}} internal plugins.',
  'status.internal_current': 'Working on {{entry}}',
  'status.internal_done': 'Checked {{total}} internal plugins.',
  'status.internal_timeout': 'Internal plugin installation timeout.',
  'status.internal_cancelled': 'Internal plugin installation cancelled.',
}

function translate(key: string, options?: Record<string, number | string>): string {
  return COPY[key].replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? ''))
}

function payload(detail: InternalPluginPhaseDetail, extra: Partial<InternalPluginsPhasePayload> = {}): InternalPluginsPhasePayload {
  return { phase: 'progress', detail, completed: 0, total: 3, ...extra }
}

describe('internalPluginReason', () => {
  it('核对阶段点名当前正在处理的条目', () => {
    expect(internalPluginReason(payload('checking', { entry: 'dsh-tauri' }), '', translate))
      .toBe('Checking 3 internal plugins. · Working on dsh-tauri')
  })

  it('安装阶段点名当前正在处理的条目', () => {
    expect(internalPluginReason(payload('installing', { entry: '@scope/dsh-plugin-x' }), '', translate))
      .toBe('Installing 3 internal plugins. · Working on @scope/dsh-plugin-x')
  })

  it('事件未带条目时不留悬空分隔符', () => {
    expect(internalPluginReason(payload('checking'), '', translate))
      .toBe('Checking 3 internal plugins.')
    expect(internalPluginReason(payload('checking', { entry: '' }), '', translate))
      .toBe('Checking 3 internal plugins.')
  })

  it('heartbeat 沿用上一次原因而不覆盖条目', () => {
    expect(internalPluginReason(payload('heartbeat', { entry: 'dsh-tauri' }), 'Working on dsh-tauri', translate))
      .toBe('Working on dsh-tauri')
  })

  it('done / timeout / cancelled 不带条目后缀', () => {
    expect(internalPluginReason(payload('done', { entry: 'dsh-tauri', phase: 'done' }), '', translate))
      .toBe('Checked 3 internal plugins.')
    expect(internalPluginReason(payload('timeout', { entry: 'dsh-tauri', phase: 'done' }), '', translate))
      .toBe('Internal plugin installation timeout.')
    expect(internalPluginReason(payload('cancelled', { entry: 'dsh-tauri', phase: 'done' }), '', translate))
      .toBe('Internal plugin installation cancelled.')
  })
})
