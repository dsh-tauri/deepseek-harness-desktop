import { describe, expect, it } from 'vitest'
import { coreProfileName, isCoreUnsupported, isCoreUpgrade, MIN_SUPPORTED_CORE_VERSION } from '@/utils/core-version'
import { normalizeProfileId } from '@/utils/profile-id'

/**
 * issue #596：随包内置插件依赖的平台种子词自 dsh 0.1.5 起才存在，核心低于最低支持
 * 基线（0.1.5-rc.1）时 `@deepseek-ai/*` 模块在运行时模块表里不存在，插件必然加载失败
 * 并把应用卡在启动阶段。
 *
 * 后端据此回退预打包核心，前端核心面板据此标注「不兼容」并拒绝激活；这里锁住两侧
 * 共用的版本判定：低于基线为 true，等于/高于为 false，不可解析不误判。
 *
 * 兼容性只看最低支持基线，与推荐核心版本（`manifest.jsonc` 的 `engines.dsh.recommend`）无关——推荐版本
 * 高于基线、仅用于更新提示。
 */
describe('isCoreUnsupported', () => {
  it('把低于 0.1.5-rc.1 的旧版本判为不兼容', () => {
    expect(isCoreUnsupported('0.1.0-rc.7')).toBe(true)
    expect(isCoreUnsupported('0.1.2-rc.1')).toBe(true)
    expect(isCoreUnsupported('0.1.5-alpha.2')).toBe(true)
  })

  it('基线本身与更新的版本都算兼容', () => {
    expect(isCoreUnsupported(MIN_SUPPORTED_CORE_VERSION)).toBe(false)
    expect(isCoreUnsupported('0.1.5-rc.2')).toBe(false)
    expect(isCoreUnsupported('0.1.6-alpha.2')).toBe(false)
    expect(isCoreUnsupported('0.1.7-alpha.1')).toBe(false)
  })

  it('版本缺失或不可解析时不误判为不兼容', () => {
    expect(isCoreUnsupported('')).toBe(false)
    expect(isCoreUnsupported('not-a-version')).toBe(false)
  })

  it('带 dsh-/src- 前缀的 release tag 按同一基线判定', () => {
    expect(isCoreUnsupported('dsh-0.1.2-rc.1')).toBe(true)
    expect(isCoreUnsupported('src-0.1.5-rc.1')).toBe(false)
  })
})

/**
 * 版本档案建议名必须带 patch、且带 `Core-` 前缀：
 * - patch 升级同样可能带破坏性更改（用户实测 0.1.5-rc.2 → 0.1.7-rc.2）。只取 `x.y` 时
 *   两个核心经 `normalizeProfileId` 归一化后都会落成 `01`，用户照默认名确认其实切回
 *   同一个档案，隔离等于没做（见最后一条 id 断言）；
 * - 档案在 UI 上的展示名 = 清单名去 `dsh-profile-` 前缀后首字母大写，也就是 id 本身，
 *   所以没有前缀时列表里只有 `017` 这种看不懂的名字（见 `Core-` 断言）；
 * - 同一 patch 的 rc 不参与取名，避免每次 rc 都新建档案。
 */
describe('coreProfileName', () => {
  it('取主/次/补丁版本号并加 Core- 前缀，丢掉预发布标识', () => {
    expect(coreProfileName('0.1.7-rc.2')).toBe('Core-0.1.7')
    expect(coreProfileName('0.17.1')).toBe('Core-0.17.1')
    expect(coreProfileName('0.18.0-rc.1')).toBe('Core-0.18.0')
    expect(coreProfileName('1.2.3')).toBe('Core-1.2.3')
  })

  it('同一个 patch 的 rc 共用档案名', () => {
    expect(coreProfileName('0.1.7-rc.1')).toBe(coreProfileName('0.1.7-rc.2'))
    expect(coreProfileName('0.1.7-rc.2')).toBe('Core-0.1.7')
  })

  it('剥掉 dsh-/src- 前缀后再取名', () => {
    expect(coreProfileName('dsh-0.1.0-rc.8-32331963388')).toBe('Core-0.1.0')
    expect(coreProfileName('src-2.0.0')).toBe('Core-2.0.0')
  })

  it('版本缺失或不可解析时为空串', () => {
    expect(coreProfileName('')).toBe('')
    expect(coreProfileName('local')).toBe('')
    expect(coreProfileName('app-0.1.0-rc.8')).toBe('')
  })

  it('patch 不同的两个核心归一化后仍是两个不同档案 id，且名字可读', () => {
    expect(normalizeProfileId(coreProfileName('0.1.5-rc.2'))).toBe('core-015')
    expect(normalizeProfileId(coreProfileName('0.1.7-rc.2'))).toBe('core-017')
  })
})

/**
 * 只有核心号（`x.y.z`）变大才算「升级 → 请切换档案」：
 * patch 升级同样可能带破坏性更改（用户实测 0.1.5 → 0.1.7 未提示是漏报，见反馈）；
 * 同一个核心号的预发布标识互换（rc.1 → rc.2、rc.2 → 正式版）共用同一个配套档案，
 * 不算升级——按 semver 严格比较会把它误报成破坏性更改。
 * 降级、平级与不可解析版本一律放行：误报会把正常切换挡在弹窗后面。
 */
describe('isCoreUpgrade', () => {
  it('核心号变大（含 patch）都算升级', () => {
    expect(isCoreUpgrade('0.1.5', '0.1.7')).toBe(true)
    expect(isCoreUpgrade('0.17.1', '0.18.0')).toBe(true)
    expect(isCoreUpgrade('0.17.1', '1.0.0')).toBe(true)
    expect(isCoreUpgrade('0.17.1', '2.0.0')).toBe(true)
    expect(isCoreUpgrade('0.1.5-rc.1', '0.1.6-alpha.2')).toBe(true)
  })

  it('同一核心号的预发布标识互换不算升级', () => {
    expect(isCoreUpgrade('0.1.7-rc.1', '0.1.7-rc.2')).toBe(false)
    expect(isCoreUpgrade('0.1.7-rc.2', '0.1.7-rc.1')).toBe(false)
    expect(isCoreUpgrade('0.1.7-rc.2', '0.1.7-alpha.1')).toBe(false)
    expect(isCoreUpgrade('0.1.5-rc.1', '0.1.5')).toBe(false)
    expect(isCoreUpgrade('0.1.5', '0.1.5-rc.1')).toBe(false)
  })

  it('平级不算升级', () => {
    expect(isCoreUpgrade('0.1.5', '0.1.5')).toBe(false)
    expect(isCoreUpgrade('0.1.5-rc.1', '0.1.5-rc.1')).toBe(false)
  })

  it('降级不算升级', () => {
    expect(isCoreUpgrade('0.1.7', '0.1.5')).toBe(false)
    expect(isCoreUpgrade('0.1.7-rc.2', '0.1.5-rc.1')).toBe(false)
    expect(isCoreUpgrade('0.18.0', '0.17.1')).toBe(false)
    expect(isCoreUpgrade('1.0.0', '0.9.9')).toBe(false)
  })

  it('任一侧版本缺失或不可解析时不误报', () => {
    expect(isCoreUpgrade('', '0.18.0')).toBe(false)
    expect(isCoreUpgrade('local', '0.18.0')).toBe(false)
    expect(isCoreUpgrade('0.17.1', '')).toBe(false)
    expect(isCoreUpgrade('0.17.1', 'app')).toBe(false)
  })

  it('带 dsh-/src- 前缀的 release tag 按同一版本判定', () => {
    expect(isCoreUpgrade('dsh-0.1.5-rc.8-1', 'src-0.1.7')).toBe(true)
    expect(isCoreUpgrade('dsh-0.1.7-rc.1-1', 'src-0.1.7-rc.2-2')).toBe(false)
  })
})
