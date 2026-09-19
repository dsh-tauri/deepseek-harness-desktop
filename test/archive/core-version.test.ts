import { describe, expect, it } from 'vitest'
import { compareVersions, isCoreBelowBaseline } from '@/utils/core-version'

/**
 * issue #596：随包内置插件按推荐核心版本（`version-recommend.json`）编译，本地核心
 * 低于该基线时 client bundle 需要的 `@deepseek-ai/*` 平台模块在运行时模块表里不存在
 * （`@deepseek-ai/dsh-client-store` 首版为 dsh 0.1.2-alpha.2，0.1.5 起才成为平台种子
 * 词），插件必然加载失败并把应用卡在启动阶段。
 *
 * 后端据此回退预打包核心，前端核心面板据此标注「不兼容」并拒绝激活；这里锁住两侧
 * 共用的版本判定：低于基线为 true，等于/高于为 false，不可解析不误判。
 */
describe('isCoreBelowBaseline', () => {
  it('detects the issue #596 local core (0.1.0-rc.7) as below the bundled baseline', () => {
    expect(isCoreBelowBaseline('0.1.0-rc.7', '0.1.5-rc.2')).toBe(true)
    expect(isCoreBelowBaseline('0.1.2-rc.1', '0.1.5-rc.2')).toBe(true)
    expect(isCoreBelowBaseline('0.1.5-rc.1', '0.1.5-rc.2')).toBe(true)
  })

  it('accepts the baseline itself and newer cores', () => {
    expect(isCoreBelowBaseline('0.1.5-rc.2', '0.1.5-rc.2')).toBe(false)
    expect(isCoreBelowBaseline('0.1.5-rc.3', '0.1.5-rc.2')).toBe(false)
    expect(isCoreBelowBaseline('0.1.6-alpha.2', '0.1.5-rc.2')).toBe(false)
  })

  it('never blocks when a version is missing or unparsable', () => {
    expect(isCoreBelowBaseline('', '0.1.5-rc.2')).toBe(false)
    expect(isCoreBelowBaseline('0.1.0-rc.7', null)).toBe(false)
    expect(isCoreBelowBaseline('0.1.0-rc.7', '')).toBe(false)
    // compareVersions 对不可解析值返回 0 → 视为达标，避免把可用核心判死
    expect(compareVersions('not-a-version', '0.1.5-rc.2')).toBe(0)
    expect(isCoreBelowBaseline('not-a-version', '0.1.5-rc.2')).toBe(false)
  })
})
