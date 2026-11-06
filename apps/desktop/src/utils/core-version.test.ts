import { describe, expect, it } from 'vitest'
import { compareVersions, isCoreUnsupported } from './core-version'

describe('核心版本兼容范围', () => {
  it.each([
    '0.2.2-rc.1',
    '0.2.2-rc.2',
    '0.2.2',
    '0.2.2+build.1',
    'src-0.2.2-rc.1',
    'dsh-0.2.2-rc.1-41234040595',
    'dsh-src-0.2.2-41234040595',
    'v0.2.2',
  ])('接受 0.2.2 系列且不低于 rc.1：%s', (version) => {
    expect(isCoreUnsupported(version)).toBe(false)
  })

  it.each([
    '0.2.1',
    '0.2.2-beta.9',
    '0.2.2-rc.0',
    '0.2.3-alpha.1',
    '0.2.3-rc.1',
    '0.2.3',
    '0.3.0',
    '1.2.2',
    'dsh-0.2.3-rc.1-41234040595',
    '',
    'invalid',
    '0.2',
  ])('拒绝支持范围之外或无法识别的版本：%s', (version) => {
    expect(isCoreUnsupported(version)).toBe(true)
  })

  it('预打包 tag 排序忽略发布编号但保留预发布版本顺序', () => {
    expect(compareVersions('dsh-0.2.2-rc.2-1', 'dsh-src-0.2.2-rc.1-999')).toBeGreaterThan(0)
    expect(compareVersions('dsh-0.2.2-1', '0.2.2')).toBe(0)
  })
})
