//! 核心来源判定与「当前活动核心」入口选择。
//!
//! 承载 [`CoreSource`] / [`HarnessCore`] 两个公开类型，以及
//! [`active_source`] / [`active_dsh_binary`] / [`active_version`] 三个供服务启动
//! 与插件操作统一取用的入口。本地核心探测见 [`super::local`]。

use crate::config;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::AppHandle;

use super::local::local_core;
use crate::service::download::parse_version_from_tag;

/// 核心来源
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CoreSource {
    /// 用户通过 CLI 安装的本地核心
    Local,
    /// 桌面端预打包核心
    App,
}

impl CoreSource {
    pub fn as_str(self) -> &'static str {
        match self {
            CoreSource::Local => "local",
            CoreSource::App => "app",
        }
    }

    pub fn parse(source: &str) -> Option<CoreSource> {
        match source {
            "local" => Some(CoreSource::Local),
            "app" => Some(CoreSource::App),
            _ => None,
        }
    }
}

/// 核心列表项（序列化 camelCase 给前端）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessCore {
    /// `local` | `app`（无 tag 记录的旧激活行）| `app-<tag>`
    pub id: String,
    pub source: CoreSource,
    /// 版本号（不含 `v` 前缀；缺失为空串）
    pub version: String,
    /// 完整 release tag（如 `dsh-0.1.0-rc.8-32331963388`；local 行为空串）
    pub tag: String,
    /// 核心入口（cli path）：本地核心为 bin.js 绝对路径，预打包为安装目录
    pub path: String,
    /// 「打开目录」入口：本地核心为包目录，预打包为安装/槽位目录；未下载为空
    pub dir: String,
    /// 本地是否可用（文件在盘/可解析）
    pub present: bool,
    /// 当前是否使用中的核心
    pub active: bool,
    /// 是否预览版（GitHub Release 标记 Pre-release，或 tag 命名含预览标记，见
    /// `download::is_preview_tag`）：预览版不参与自动更新提示，但可在核心列表
    /// 手动下载安装，并以「预览版」标签展示。
    pub preview: bool,
    /// 当前版本是否高于资源清单中的推荐版本。
    pub above_recommended: bool,
    /// 本地存在但远程 pkg 仓库已不再提供的历史槽位。
    pub orphaned: bool,
    /// 是否为离线安装包随包分发的内置核心（`resources/dsh`，版本取自
    /// `resources/bundle.json`）：核心面板把它固定置顶、标注「内置核心」，
    /// 且不允许卸载（见 `service::bundle`）。
    pub bundled: bool,
    /// 资源清单中的推荐版本，用于切换前风险提示。
    pub recommended_version: Option<String>,
    pub error: Option<String>,
}

/// 基线告警只发一次：`active_source` 在启动、核心列表与插件操作中反复调用。
static UNSUPPORTED_LOCAL_WARNED: OnceLock<()> = OnceLock::new();

/// 版本是否达到内置插件基线；任一版本无法解析时按「达标」处理，宁可放行也不误判。
fn meets_baseline(version: &str, baseline: &str) -> bool {
    match (
        semver::Version::parse(version),
        semver::Version::parse(baseline),
    ) {
        (Ok(actual), Ok(baseline)) => actual >= baseline,
        _ => true,
    }
}

/// 本地核心能否承载随包内置插件。
///
/// `resources/node_modules` 的内置插件在构建期按 catalog 的 dsh 版本编译，client
/// bundle 把 `@deepseek-ai/*` 全部留给运行时模块表解析（`scripts/build-plugins.ts`
/// 会把整个 scope 从产物里删掉）。核心低于该基线时这些模块在模块表里根本不存在
/// （`@deepseek-ai/dsh-client-store` 首版为 dsh 0.1.2-alpha.2，0.1.5 起才成为平台
/// 种子词），内置插件必然加载失败并把应用卡在启动阶段（issue #596）。基线取应用
/// 资源里的推荐核心版本（`version-recommend.json`，与 catalog 的 dsh 版本同源）。
pub(super) fn core_supports_bundled_plugins(app_handle: &AppHandle, version: &str) -> bool {
    config::recommended_dsh_version(app_handle)
        .is_none_or(|baseline| meets_baseline(version, &baseline))
}

fn warn_unsupported_local_core(app_handle: &AppHandle, version: &str) {
    if UNSUPPORTED_LOCAL_WARNED.set(()).is_err() {
        return;
    }
    log::warn!(
        "CORE_LOCAL_UNSUPPORTED: local dsh {} is below the bundled-plugin baseline {}; using the bundled core instead (issue #596)",
        version,
        config::recommended_dsh_version(app_handle).unwrap_or_default(),
    );
}

/// 当前活动核心来源（需求 3：本地核心存在时优先，除非用户显式选择预打包）。
///
/// 本地核心低于内置插件基线时不参与优先，一律回退预打包核心：内置插件是桌面壳的
/// 组成部分，装上也无法加载，只会把启动卡在插件阶段（issue #596）。持久化的
/// `active_core` 设置不改写——用户升级本地核心后自动恢复「本地优先」。
///
/// 离线安装包（`resources/bundle.json`）在自动模式下改为**内置核心优先**：随包
/// 内核与随包 Node 由同一次构建产出、版本匹配有保证，而内网机器上的本地 dsh 往往
/// 是任意版本，没有理由让它盖过随包内核。用户显式选择的来源仍然照旧生效。
pub fn active_source(app_handle: &AppHandle) -> CoreSource {
    let setting = config::get_store_dat_setting(app_handle);
    let local = local_core(app_handle);
    let local_usable = local
        .as_ref()
        .is_some_and(|core| core_supports_bundled_plugins(app_handle, &core.version));
    if local.is_some() && !local_usable {
        warn_unsupported_local_core(
            app_handle,
            local
                .as_ref()
                .map(|core| core.version.as_str())
                .unwrap_or_default(),
        );
    }
    match setting.active_core.as_deref().and_then(CoreSource::parse) {
        Some(CoreSource::App) => CoreSource::App,
        // 显式选择本地但本地已失效/低于基线 → 回退预打包
        Some(CoreSource::Local) if local_usable => CoreSource::Local,
        // 未设置（自动）或显式本地不可用：离线包用内置核心，否则本地可用时优先
        _ => {
            if config::is_offline_bundle(app_handle) {
                CoreSource::App
            } else if local_usable {
                CoreSource::Local
            } else {
                CoreSource::App
            }
        }
    }
}

/// 当前活动核心的 dsh 入口（bin.js 绝对路径）。
///
/// 供服务启动（workflow::launch）与插件操作（plugin::install 等）统一取用，
/// 本地核心解析在调用瞬间失效时回退预打包入口。
pub fn active_dsh_binary(app_handle: &AppHandle) -> PathBuf {
    match active_source(app_handle) {
        CoreSource::Local => local_core(app_handle)
            .map(|c| c.bin)
            .unwrap_or_else(|| config::get_dsh_binary_path(app_handle)),
        CoreSource::App => config::get_dsh_binary_path(app_handle),
    }
}

/// 当前活动核心的版本号（`--no-open` 等按版本判定的能力以它为准）。
pub fn active_version(app_handle: &AppHandle) -> Option<String> {
    match active_source(app_handle) {
        CoreSource::Local => local_core(app_handle).map(|c| c.version),
        CoreSource::App => config::get_dsh_pkg_tag(app_handle)
            .as_deref()
            .and_then(parse_version_from_tag)
            .or_else(|| config::get_dsh_version(app_handle)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_source_round_trips() {
        assert_eq!(CoreSource::parse("local"), Some(CoreSource::Local));
        assert_eq!(CoreSource::parse("app"), Some(CoreSource::App));
        assert_eq!(CoreSource::parse("other"), None);
        assert_eq!(CoreSource::Local.as_str(), "local");
        assert_eq!(CoreSource::App.as_str(), "app");
    }

    #[test]
    fn baseline_gate_accepts_equal_or_newer_versions() {
        assert!(meets_baseline("0.1.5-rc.2", "0.1.5-rc.2"));
        assert!(meets_baseline("0.1.5-rc.3", "0.1.5-rc.2"));
        assert!(meets_baseline("0.1.6-alpha.2", "0.1.5-rc.2"));
    }

    /// issue #596：本地核心 0.1.0-rc.7 早于 `@deepseek-ai/dsh-client-store` 首版
    /// （0.1.2-alpha.2），更早于它成为平台种子词的 0.1.5，内置插件必然加载失败。
    #[test]
    fn baseline_gate_rejects_older_versions() {
        assert!(!meets_baseline("0.1.0-rc.7", "0.1.5-rc.2"));
        assert!(!meets_baseline("0.1.2-rc.1", "0.1.5-rc.2"));
        assert!(!meets_baseline("0.1.5-rc.1", "0.1.5-rc.2"));
    }

    /// 版本不可解析（旧安装记录/异常清单）时不阻断：漏放行只是回到修复前的行为，
    /// 误拦截会把可用的本地核心判死。
    #[test]
    fn baseline_gate_passes_unparsable_versions() {
        assert!(meets_baseline("", "0.1.5-rc.2"));
        assert!(meets_baseline("not-a-version", "0.1.5-rc.2"));
        assert!(meets_baseline("0.1.0-rc.7", ""));
    }
}
