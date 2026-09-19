import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Frontend contract test for profile cloning (TDD RED stage).
 *
 * Reads source files via readFileSync and asserts structural contracts,
 * mirroring the close-action.test.ts pattern. The frontend is not mounted
 * in unit tests — these assertions verify the wiring exists.
 */
describe('cloneProfile mutation shape', () => {
  it('invokes clone_profile with sourceId + name and invalidates queries', () => {
    const source = readFileSync(new URL('../src/ui/config/profile.tsx', import.meta.url), 'utf8')

    expect(source).toContain('clone_profile')
    expect(source).toContain('sourceId')
    expect(source).toContain('name')
    expect(source).toMatch(/invoke\s*<\s*Profile\s*>\s*\(\s*['"]clone_profile['"]/)
    expect(source).toMatch(/onSuccess:\s*invalidate/)
  })

  it('wires the cloneProfile helper to the clone mutation', () => {
    const source = readFileSync(new URL('../src/ui/config/profile.tsx', import.meta.url), 'utf8')

    expect(source).toMatch(/cloneProfile\s*\(sourceId\s*:\s*string,\s*name\s*:\s*string\)/)
    expect(source).toMatch(/clone\.mutateAsync\(\{\s*sourceId,\s*name\s*\}\)/)
  })

  it('extends busy to include clone.isPending', () => {
    const source = readFileSync(new URL('../src/ui/config/profile.tsx', import.meta.url), 'utf8')

    expect(source).toMatch(/clone\.isPending/)
    expect(source).toMatch(/busy\s*=\s*create\.isPending\s*\|\|\s*activate\.isPending\s*\|\|\s*remove\.isPending\s*\|\|\s*clone\.isPending/)
  })
})

describe('clone Chip + naming dialog in ConfigProfile', () => {
  it('renders a Clone Chip on non-default rows with profiles.clone label', () => {
    const source = readFileSync(new URL('../src/ui/config/profile.tsx', import.meta.url), 'utf8')

    expect(source).toMatch(/profiles\.clone['"]/)
    // 删除按钮常驻所有行：默认档案渲染为灰色不可用，而非整体隐藏
    expect(source).toMatch(/profiles\.remove['"]/)
    expect(source).toMatch(/profile\.default \|\| busy \? ' cursor-not-allowed opacity-50'/)
    // Chip positioned before delete Chip
    const cloneIdx = source.indexOf('profiles.clone')
    const removeIdx = source.indexOf('profiles.remove')
    expect(cloneIdx).toBeGreaterThan(-1)
    expect(removeIdx).toBeGreaterThan(-1)
    expect(cloneIdx).toBeLessThan(removeIdx)
  })

  it('disables the Clone Chip while busy', () => {
    const source = readFileSync(new URL('../src/ui/config/profile.tsx', import.meta.url), 'utf8')

    expect(source).toMatch(/cursor-not-allowed opacity-50/)
  })

  it('provides a naming dialog with description, editable Input, and confirm button', () => {
    const source = readFileSync(new URL('../src/ui/config/profile.tsx', import.meta.url), 'utf8')

    expect(source).toMatch(/profiles\.clone_dialog_desc/)
    expect(source).toMatch(/profiles\.clone_confirm/)
    expect(source).toMatch(/profiles\.clone_cancel/)
    expect(source).toMatch(/<Input/)
    expect(source).toMatch(/autoFocus/)
  })

  it('shows accent success toast with NO restart action', () => {
    const source = readFileSync(new URL('../src/ui/config/profile.tsx', import.meta.url), 'utf8')

    expect(source).toMatch(/profiles\.clone_success/)
    expect(source).toMatch(/variant:\s*['"]accent['"]/)
    // clone success branch must NOT include a restart action (distinct from activate)
    const cloneSuccessIdx = source.indexOf('profiles.clone_success')
    expect(cloneSuccessIdx).toBeGreaterThan(-1)
    const afterSuccess = source.slice(cloneSuccessIdx, cloneSuccessIdx + 500)
    expect(afterSuccess).not.toMatch(/actionProps/)
    expect(afterSuccess).not.toMatch(/restart/)
  })

  it('keeps dialog open on failure with an error toast', () => {
    const source = readFileSync(new URL('../src/ui/config/profile.tsx', import.meta.url), 'utf8')

    expect(source).toMatch(/profiles\.clone_failed/)
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
  ]

  for (const locale of ['zh-CN', 'en-US']) {
    it(`includes all profiles.clone* keys in ${locale}`, () => {
      const content = readFileSync(new URL(`../src/i18n/locales/${locale}.json`, import.meta.url), 'utf8')
      for (const key of keys) {
        expect(content).toContain(`"${key}"`)
      }
    })
  }
})

describe('shell conventions', () => {
  it('does not use useCallback / useMemo / hardcoded user-facing strings', () => {
    const source = readFileSync(new URL('../src/ui/config/profile.tsx', import.meta.url), 'utf8')

    expect(source).not.toContain('useCallback')
    expect(source).not.toContain('useMemo')
    // clone-related labels must come from t(), not hardcoded
    expect(source).not.toMatch(/>\s*Clone\s*</)
    expect(source).not.toMatch(/>\s*克隆\s*</)
  })
})
