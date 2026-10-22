import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * profile 面板的克隆链路结构契约。
 *
 * 前端不在单测里挂载，因此读源码断言结构（与 close-action.test.ts 同款跨层守卫）：
 * 期望值一律为字面量或独立索引，不与被测实现同源。
 */
const profileSource = (): string => readFileSync(new URL('../src/ui/config/profile.tsx', import.meta.url), 'utf8')

/** 取 `label` 所属的那个 `<Chip …>` 元素文本（从最近的 `<Chip` 到 label）。 */
function chipOf(source: string, label: string): string {
  const labelIndex = source.indexOf(label)
  const openIndex = source.lastIndexOf('<Chip', labelIndex)
  expect(labelIndex).toBeGreaterThan(-1)
  expect(openIndex).toBeGreaterThan(-1)
  return source.slice(openIndex, labelIndex)
}

describe('cloneProfile mutation shape', () => {
  it('invokes clone_profile with sourceId + name and invalidates queries', () => {
    const source = profileSource()

    expect(source).toMatch(/invoke\s*<\s*Profile\s*>\s*\(\s*['"]clone_profile['"]/)
    expect(source).toMatch(/mutationFn:\s*\(params:\s*\{[^}]*sourceId[^}]*name[^}]*\}/)
    expect(source).toMatch(/onSuccess:\s*invalidate/)
  })

  it('wires the cloneProfile helper to the clone mutation', () => {
    const source = profileSource()

    expect(source).toMatch(/cloneProfile\s*\(sourceId\s*:\s*string,\s*name\s*:\s*string\)/)
    expect(source).toMatch(/clone\.mutateAsync\(\{\s*sourceId,\s*name\s*\}\)/)
  })

  it('extends busy to include clone.isPending', () => {
    const source = profileSource()
    const busyIndex = source.indexOf('const busy =')
    expect(busyIndex).toBeGreaterThan(-1)
    const busy = source.slice(busyIndex, source.indexOf('\n', busyIndex))

    for (const mutation of ['create', 'activate', 'remove', 'clone'])
      expect(busy).toContain(`${mutation}.isPending`)
  })
})

describe('clone Chip + naming dialog in ConfigProfile', () => {
  it('renders Clone + Delete Chips on non-default rows and a Reset Chip on the default row', () => {
    const source = profileSource()

    expect(source).toMatch(/profiles\.clone['"]/)
    expect(source).toMatch(/profiles\.remove['"]/)
    // 默认档案渲染「重置」（不可删除），非默认档案渲染「删除」。
    expect(source).toMatch(/profiles\.reset['"]/)
    expect(chipOf(source, `t('profiles.remove')`)).toContain('cursor-not-allowed opacity-50')

    // Clone Chip 必须排在删除/重置 Chip 之前。
    const cloneIndex = source.indexOf(`t('profiles.clone')`)
    const removeIndex = source.indexOf(`t('profiles.remove')`)
    expect(cloneIndex).toBeGreaterThan(-1)
    expect(removeIndex).toBeGreaterThan(-1)
    expect(cloneIndex).toBeLessThan(removeIndex)
  })

  it('disables the Clone Chip while busy', () => {
    const source = profileSource()
    const chip = chipOf(source, `t('profiles.clone')`)

    expect(chip).toContain('cursor-not-allowed opacity-50')
    expect(chip).toContain('if (!busy)')
  })

  it('provides a naming dialog with description, editable Input, and confirm button', () => {
    const source = profileSource()
    const dialogIndex = source.indexOf('<AlertDialog')
    expect(dialogIndex).toBeGreaterThan(-1)
    const dialog = source.slice(dialogIndex)

    expect(dialog).toMatch(/profiles\.clone_dialog_desc/)
    expect(dialog).toMatch(/profiles\.clone_confirm/)
    expect(dialog).toMatch(/profiles\.clone_cancel/)
    expect(dialog).toMatch(/<Input\s+autoFocus/)
  })

  it('shows accent success toast with NO restart action', () => {
    const source = profileSource()

    const successIndex = source.indexOf('profiles.clone_success')
    expect(successIndex).toBeGreaterThan(-1)
    // 克隆成功分支 = 该 toast 调用到紧随其后的 catch；重启入口只属于切换档案。
    const branch = source.slice(source.lastIndexOf('toast(', successIndex), source.indexOf('catch (err)', successIndex))
    expect(branch).toContain('profiles.clone_success')
    expect(branch).toMatch(/variant:\s*['"]accent['"]/)
    expect(branch).not.toMatch(/actionProps/)
    expect(branch).not.toMatch(/restart/)
  })

  it('keeps dialog open on failure with an error toast', () => {
    const source = profileSource()

    const failedIndex = source.indexOf('profiles.clone_failed')
    expect(failedIndex).toBeGreaterThan(-1)
    const failureBranch = source.slice(source.lastIndexOf('catch', failedIndex), source.indexOf('function onActivate', failedIndex))
    expect(failureBranch).toContain('profiles.clone_failed')
    // 失败不能关闭命名对话框，用户可以改名重试。
    expect(failureBranch).not.toContain('setCloning(null)')
  })
})

describe('reset profile (default row)', () => {
  it('invokes reset_profile and gates it behind a danger confirm dialog', () => {
    const source = profileSource()

    expect(source).toMatch(/invoke\s*<\s*void\s*>\s*\(\s*['"]reset_profile['"]/)
    expect(source).toMatch(/profiles\.reset_confirm_title/)
    expect(source).toMatch(/profiles\.reset_confirm_desc/)
  })

  it('swaps the default-row Chip label from remove to reset', () => {
    const source = profileSource()

    expect(source).toMatch(/profile\.default\s*\?\s*t\(\s*['"]profiles\.reset['"]\s*\)\s*:\s*t\(\s*['"]profiles\.remove['"]\s*\)/)
  })

  it('stops the harness and waits before resetting, then relaunches', () => {
    const source = profileSource()
    const resetIndex = source.indexOf('async function onReset')
    expect(resetIndex).toBeGreaterThan(-1)
    const handler = source.slice(resetIndex, source.indexOf('// 备份子视图', resetIndex))

    expect(handler).toContain('shutdown_harness')
    expect(handler).toContain('waitForHarnessStopped')
    expect(handler).toContain('resetProfile(id)')
    expect(handler).toContain('launch_harness')
    // 重置是不可撤销的破坏性操作，必须走 danger 确认。
    expect(handler).toMatch(/status:\s*['"]danger['"]/)
    // 只有使用中的档案会被运行中的服务锁住目录，停/起服务必须以此为条件，
    // 否则重置非当前档案会白白打断在跑的服务。
    expect(handler).toMatch(/if\s*\(\s*target\.active\s*\)/)
  })

  it('keeps the reset Chip disabled while busy', () => {
    const source = profileSource()
    const busyIndex = source.indexOf('const busy =')
    const busy = source.slice(busyIndex, source.indexOf('\n', busyIndex))

    expect(busy).toContain('reset.isPending')
  })
})

describe('i18n parity', () => {
  const keys = [
    'profiles.clone',
    'profiles.clone_dialog_title',
    'profiles.clone_dialog_desc',
    'profiles.clone_name_placeholder',
    'profiles.clone_default_hint',
    'profiles.clone_confirm',
    'profiles.clone_cancel',
    'profiles.clone_success',
    'profiles.clone_success_hint',
    'profiles.clone_failed',
    'profiles.clone_exists',
    'profiles.clone_empty',
    'profiles.clone_invalid',
    'profiles.reset',
    'profiles.reset_confirm_title',
    'profiles.reset_confirm_desc',
    'profiles.reset_confirm',
    'profiles.reset_stopped_toast',
    'profiles.reset_success',
    'profiles.reset_success_hint',
    'profiles.reset_failed',
  ]

  for (const locale of ['zh-CN', 'en-US', 'ko-KR']) {
    it(`includes all profiles.clone* keys in ${locale}`, () => {
      const messages = JSON.parse(readFileSync(new URL(`../src/i18n/locales/${locale}.json`, import.meta.url), 'utf8')) as Record<string, unknown>
      for (const key of keys) {
        expect(typeof messages[key], key).toBe('string')
        expect((messages[key] as string).length, key).toBeGreaterThan(0)
      }
    })
  }
})

describe('shell conventions', () => {
  it('does not use useCallback / useMemo / hardcoded user-facing strings', () => {
    const source = profileSource()

    expect(source).not.toContain('useCallback')
    expect(source).not.toContain('useMemo')
    // clone 相关文案必须来自 t()，不能硬编码。
    expect(source).not.toMatch(/>\s*Clone\s*</)
    expect(source).not.toMatch(/>\s*克隆\s*</)
  })
})
