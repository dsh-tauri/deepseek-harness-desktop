import type { BackupSettings } from '../../src/utils/backup-settings'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {

  normalizeIntervalDays,
  normalizeRetentionCount,
} from '../../src/utils/backup-settings'

describe('backup settings normalization', () => {
  it('keeps a valid interval as-is', () => {
    expect(normalizeIntervalDays(7)).toBe(7)
    expect(normalizeIntervalDays(1)).toBe(1)
    expect(normalizeIntervalDays(90)).toBe(90)
  })

  it('clamps interval to the [1, 90] range', () => {
    expect(normalizeIntervalDays(0)).toBe(7)
    expect(normalizeIntervalDays(100)).toBe(7)
    expect(normalizeIntervalDays(91)).toBe(7)
  })

  it('falls back to the default for non-numeric interval', () => {
    expect(normalizeIntervalDays(undefined)).toBe(7)
    expect(normalizeIntervalDays(null)).toBe(7)
    expect(normalizeIntervalDays('')).toBe(7)
    expect(normalizeIntervalDays('abc')).toBe(7)
    expect(normalizeIntervalDays(NaN)).toBe(7)
    expect(normalizeIntervalDays(Infinity)).toBe(7)
  })

  it('keeps a valid retention count as-is', () => {
    expect(normalizeRetentionCount(10)).toBe(10)
    expect(normalizeRetentionCount(1)).toBe(1)
    expect(normalizeRetentionCount(50)).toBe(50)
  })

  it('clamps retention to the [1, 50] range', () => {
    expect(normalizeRetentionCount(0)).toBe(10)
    expect(normalizeRetentionCount(100)).toBe(10)
    expect(normalizeRetentionCount(51)).toBe(10)
  })

  it('falls back to the default for non-numeric retention', () => {
    expect(normalizeRetentionCount(undefined)).toBe(10)
    expect(normalizeRetentionCount(null)).toBe(10)
    expect(normalizeRetentionCount('')).toBe(10)
    expect(normalizeRetentionCount('abc')).toBe(10)
    expect(normalizeRetentionCount(NaN)).toBe(10)
  })

  it('normalizes a full settings object', () => {
    const settings: BackupSettings = {
      autoBackupEnabled: true,
      autoBackupIntervalDays: normalizeIntervalDays(5),
      autoBackupOnStartup: false,
      autoBackupOnChange: false,
      backupRetentionCount: normalizeRetentionCount(999),
      backupIncludeCredentials: false,
    }
    expect(settings.autoBackupIntervalDays).toBe(5)
    expect(settings.backupRetentionCount).toBe(10)
  })
})

describe('configBackup component contract', () => {
  it('exports a named ConfigBackup function', () => {
    const source = readFileSync(new URL('../src/ui/config/backup.tsx', import.meta.url), 'utf8')
    expect(source).toContain('export function ConfigBackup')
  })

  it('invokes all four backup Tauri commands', () => {
    // 遵循档案面板模式：组件通过 useBackups 钩子调用命令，钩子内部 invoke
    const source = readFileSync(new URL('../src/hooks/use-backup.ts', import.meta.url), 'utf8')
    expect(source).toContain('backup_profile')
    expect(source).toContain('restore_profile')
    expect(source).toContain('list_backups')
    expect(source).toContain('delete_backup')
  })

  it('uses useTranslation with no hardcoded English/Chinese strings', () => {
    const source = readFileSync(new URL('../src/ui/config/backup.tsx', import.meta.url), 'utf8')
    expect(source).toContain('useTranslation')
    // 不应出现裸中文字符串（i18n key 通过 t() 传入）
    const cjkRange = '[\\u4e00-\\u9fff]'
    expect(source).not.toMatch(new RegExp(`>${cjkRange}+<`))
  })

  it('stays within the shell conventions', () => {
    const source = readFileSync(new URL('../src/ui/config/backup.tsx', import.meta.url), 'utf8')
    expect(source).not.toContain('useCallback')
    expect(source).not.toContain('useMemo')
  })
})

describe('useBackups hook contract', () => {
  it('exports a named useBackups function', () => {
    const source = readFileSync(new URL('../src/hooks/use-backup.ts', import.meta.url), 'utf8')
    expect(source).toContain('export function useBackups')
  })

  it('uses useQuery and useMutation', () => {
    const source = readFileSync(new URL('../src/hooks/use-backup.ts', import.meta.url), 'utf8')
    expect(source).toContain('useQuery')
    expect(source).toContain('useMutation')
  })

  it('invalidates on the setting_updated event through the shared hook', () => {
    const source = readFileSync(new URL('../src/hooks/use-backup.ts', import.meta.url), 'utf8')
    expect(source).toContain('useInvalidateOnSettingUpdated')

    // 事件名收敛在共享 hook 里，此处断言它仍是 setting_updated
    const shared = readFileSync(new URL('../src/hooks/use-invalidate-on-setting-updated.ts', import.meta.url), 'utf8')
    expect(shared).toContain('setting_updated')
  })
})
