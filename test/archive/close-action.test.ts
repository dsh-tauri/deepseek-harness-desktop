import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CLOSE_ACTION_DEFAULT,
  CLOSE_ACTION_OPTIONS,
  normalizeCloseAction,
} from '../../src/utils/close-action'

describe('close action normalization', () => {
  it('defaults to hiding in tray', () => {
    expect(CLOSE_ACTION_DEFAULT).toBe('tray')
  })

  it('exposes exactly the tray and quit options', () => {
    expect(CLOSE_ACTION_OPTIONS).toEqual(['tray', 'quit'])
  })

  it('keeps the two supported literal values', () => {
    expect(normalizeCloseAction('tray')).toBe('tray')
    expect(normalizeCloseAction('quit')).toBe('quit')
  })

  it('falls back to tray for anything outside the whitelist', () => {
    expect(normalizeCloseAction(undefined)).toBe('tray')
    expect(normalizeCloseAction(null)).toBe('tray')
    expect(normalizeCloseAction('')).toBe('tray')
    expect(normalizeCloseAction('TRAY')).toBe('tray')
    expect(normalizeCloseAction('bogus')).toBe('tray')
    expect(normalizeCloseAction({})).toBe('tray')
  })
})

describe('config close action control contract', () => {
  it('reads closeAction from the setting store and writes it through the backend command', () => {
    const source = readFileSync(new URL('../src/ui/config/components/close-action.tsx', import.meta.url), 'utf8')

    expect(source).toContain('export function ConfigCloseAction')
    // 读走 setting store（与 Rust 共享 .store.dat，后端改动经 setting_updated 回流）
    expect(source).toContain('useStore(store.setting)')
    // 写仍走命令：后端归一化并在锁内落盘，避免与 Rust 的整对象写入互相覆盖
    expect(source).toContain('invoke(\'update_app_config\', { closeAction')
    // 受控值始终经归一化，未加载到配置时回落 tray 而不是给 HeroUI 传 undefined
    expect(source).toContain('selectedKey={normalizeCloseAction(')
  })

  it('no longer carries its own config query cache', () => {
    const source = readFileSync(new URL('../src/ui/config/components/close-action.tsx', import.meta.url), 'utf8')

    expect(source).not.toContain('useQueryClient')
    expect(source).not.toContain('useAppConfig')
    expect(source).not.toContain('setQueryData')
  })

  it('surfaces failures as a danger toast without a success toast', () => {
    const source = readFileSync(new URL('../src/ui/config/components/close-action.tsx', import.meta.url), 'utf8')

    expect(source).toContain('messages.close_action_failed')
    expect(source).toContain('variant: \'danger\'')
    expect(source).not.toContain('messages.close_action_saved')
  })

  it('stays within the shell conventions', () => {
    const source = readFileSync(new URL('../src/ui/config/components/close-action.tsx', import.meta.url), 'utf8')

    expect(source).not.toContain('useCallback')
    expect(source).not.toContain('useMemo')
    expect(source).not.toContain('navigator.clipboard')
  })
})
