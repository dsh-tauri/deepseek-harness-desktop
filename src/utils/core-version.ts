import semver from 'semver'

/**
 * 核心(dsh)版本判断：以 rc.2 为硬编码基准，高于该基准的版本引入破坏性更改、
 * 可能影响第三方插件。该判断与「推荐版本」逻辑无关，仅作为用户提示的阈值。
 */
export const CORE_BREAKING_BASELINE = '0.1.2-rc.1'

/** 剥掉 release tag 的 `dsh-`/`src-` 前缀（含重复的 `dsh-src-` 链）后再交给 semver */
function stripVersionPrefix(version: string): string {
  let value = version
  while (value.startsWith('dsh-') || value.startsWith('src-'))
    value = value.replace(/^(?:src|dsh)-/, '')
  return value
}

/**
 * Semver comparison using the `semver` package.
 * Handles `dsh-`/`src-` prefixes (including repeated `dsh-src-` chains) by
 * stripping before comparison; unparsable values compare as equal.
 * Returns: negative if a < b, 0 if equal, positive if a > b.
 */
export function compareVersions(a: string, b: string): number {
  const pa = semver.parse(stripVersionPrefix(a))
  const pb = semver.parse(stripVersionPrefix(b))
  if (!pa || !pb)
    return 0
  return semver.compare(pa, pb)
}

/**
 * 版本档案的建议名（`Core-x.y.z`，含 patch、不含预发布标识）；缺失或不可解析时为空串。
 *
 * 必须带上 patch：破坏性更改在 patch 之间同样发生（用户实测 0.1.5-rc.2 → 0.1.7-rc.2），
 * 只取 `x.y` 会让两个核心共用一个档案——经 `normalizeProfileId` 归一化后 `0.1.5` 与
 * `0.1.7` 都落成 `01`，用户在弹窗里照默认名确认，实际切回的就是同一个档案，等于没隔离。
 * 预发布标识（`-rc.2`）不参与取名：同一 patch 的 rc 之间共用档案，避免每次 rc 都新建。
 *
 * 前缀 `Core-` 不是装饰：`create_profile` 只拿归一化后的 id 建目录，而档案在 UI 上的
 * 展示名取自清单 `name` 去掉 `dsh-profile-` 前缀（首字母大写，见
 * `service::profile::display_name`），所以没有前缀时列表里就是一个光秃秃的 `017`，
 * 用户根本看不出它是核心版本档案；带上前缀即 `Core-017`。
 */
export function coreProfileName(version: string): string {
  const parsed = semver.parse(stripVersionPrefix(version))
  return parsed ? `Core-${parsed.major}.${parsed.minor}.${parsed.patch}` : ''
}

/**
 * 目标核心是否相对在用核心做了升级（只认 `x.y.z` 核心号变大）。
 *
 * 核心与档案是配套的：换到任何更新的 dsh 版本都可能破坏当前档案里的插件与设置，切换前
 * 先提示用户换配套档案。判据取「核心号变大」而非「跨主/次版本」——dsh 在 0.1.x 上持续推进
 * 破坏性更改（0.1.5 → 0.1.7 就是一次），只跨主/次版本会漏掉这些升级提示。
 *
 * 预发布标识不参与判定：同一个 `x.y.z` 的 rc/alpha/beta 之间互换（含 `-rc.1` → `-rc.2`、
 * `-rc.2` → 正式版）只换预发布序号，插件与设置的配套关系不变，`coreProfileName` 也给它们
 * 同一个档案名。按 semver 严格比较会把 `0.1.7-rc.2 > 0.1.7-rc.1` 判成升级，让用户每次
 * 追一个 rc 都被弹「含破坏性更改」——这正是要避免的误报。
 *
 * 不可解析（本地核心版本号缺失、首次切换没有在用核心）一律返回 false——漏提示只是少了
 * 一次提醒，误判会把正常切换挡在弹窗后面。
 */
export function isCoreUpgrade(from: string, to: string): boolean {
  const current = semver.parse(stripVersionPrefix(from))
  const target = semver.parse(stripVersionPrefix(to))
  if (!current || !target)
    return false
  const currentCore = [current.major, current.minor, current.patch]
  const targetCore = [target.major, target.minor, target.patch]
  for (let index = 0; index < currentCore.length; index += 1) {
    if (targetCore[index]! !== currentCore[index]!)
      return targetCore[index]! > currentCore[index]!
  }
  return false
}

/** 判断核心版本（版本串或 release tag）是否高于 rc.2 基准（引入破坏性更改） */
export function isCoreBreakingVersion(version: string): boolean {
  return !!version && compareVersions(version, CORE_BREAKING_BASELINE) > 0
}

/**
 * 最低支持的核心版本（与 Rust `MIN_SUPPORTED_CORE_VERSION` 对齐）。低于它的核心缺少
 * 内置插件依赖的平台种子词，随包插件必然加载失败并把应用卡在启动阶段（issue #596）。
 *
 * 这是兼容性的唯一基线：它低于推荐核心版本（`manifest.jsonc` 的 `engines.dsh.recommend`，仅用于更新
 * 提示），两者不可混用——拿推荐版本当基线会把「高于基线、低于推荐版本」的可用核心
 * 误判为不兼容（推荐版本为 0.1.7-alpha.1 时，0.1.5-rc.3 就是这么被挡下的）。
 */
export const MIN_SUPPORTED_CORE_VERSION = '0.1.5-rc.1'

/**
 * 核心版本是否低于最低支持基线（按版本判定，与来源无关）。
 *
 * 版本缺失或不可解析时返回 false（`compareVersions` 对不可解析值返回 0）——漏放行只是
 * 回到修复前的行为，误判会把可用的核心归进「不兼容」分组。
 */
export function isCoreUnsupported(version: string): boolean {
  return compareVersions(version, MIN_SUPPORTED_CORE_VERSION) < 0
}
