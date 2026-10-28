import { describe, expect, it } from 'vitest'
import { compareVersions, isCoreUnsupported, MIN_SUPPORTED_CORE_VERSION } from '@/utils/core-version'

describe('compareVersions', () => {
  it.each([
    ['0.1.7-alpha.1', '0.1.7-rc.1', -1],
    ['0.1.7-beta.2', '0.1.7-rc.1', -1],
    ['0.1.7-rc.0', '0.1.7-rc.1', -1],
    ['0.1.7-rc.1', '0.1.7-rc.1', 0],
    ['0.1.7-rc.10', '0.1.7-rc.2', 1],
    ['0.1.7', '0.1.7-rc.1', 1],
    ['0.2.1-rc.1', '0.2.0', 1],
    ['dsh-src-dsh-0.1.5-rc.3-1', 'src-0.1.7-rc.1', -1],
    ['dsh-0.1.7-rc.0-39009013600', 'src-0.1.7-rc.1', -1],
    ['dsh-0.1.7-rc.1-39009013600', '0.1.7-rc.1', 0],
    ['dsh-0.1.7-39009013600', 'src-0.1.7', 0],
    ['dsh-0.2.1-rc.1-39009013600', 'src-0.2.1-rc.1', 0],
    ['0.2.1-rc.2', '0.2.1-rc.1', 1],
    ['dsh-0.2.1-rc.2-39022695148', 'src-0.2.1-rc.2', 0],
    ['0.2.1-preview-1', '0.2.1-preview', 1],
    ['src-0.2.1-preview-1', '0.2.1-preview', 1],
    ['dsh-0.2.1-preview-1-39009013600', '0.2.1-preview-1', 0],
  ])('%s 与 %s 的版本顺序为 %s', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected)
  })

  it.each([
    ['', '0.2.1-rc.1'],
    ['not-a-version', '0.1.7-rc.1'],
    ['0.2.1-rc.1', ''],
    ['0.1.7-rc.1', 'app'],
  ])('无法解析的比较 %s / %s 返回中立值', (a, b) => {
    expect(compareVersions(a, b)).toBe(0)
  })
})

describe('isCoreUnsupported', () => {
  it('最低支持版本固定为 0.2.1-rc.4', () => {
    expect(MIN_SUPPORTED_CORE_VERSION).toBe('0.2.1-rc.4')
  })

  it.each([
    '0.1.0-rc.7',
    '0.1.2-rc.1',
    '0.1.5-rc.1',
    '0.1.5-rc.3',
    '0.1.6',
    '0.1.7-rc.1',
    '0.2.1-rc.1',
    '0.2.1-rc.3',
    '0.2.1-rc.0',
    '0.2.1-alpha.5',
    'dsh-0.2.1-rc.3-40000000000',
    'dsh-src-0.2.1-rc.3-40000000000',
    'src-0.2.1-rc.3',
    'src-0.2.1-alpha.1',
  ])('%s 低于最低支持版本，判为不兼容', (version) => {
    expect(isCoreUnsupported(version)).toBe(true)
  })

  it.each([
    '0.2.1-rc.4',
    '0.2.1-rc.5',
    '0.2.1',
    '0.2.2-alpha.2',
    'src-0.2.1-rc.4',
    'dsh-src-dsh-0.2.1-rc.4-40372188763',
    'dsh-0.2.1-rc.4-40372188763',
  ])('%s 达到最低支持版本，判为兼容', (version) => {
    expect(isCoreUnsupported(version)).toBe(false)
  })

  it.each(['', 'not-a-version', 'local'])('版本 %s 缺失或不可解析时不误判为不兼容', (version) => {
    expect(isCoreUnsupported(version)).toBe(false)
  })
})
