//! 核心来源判定与「当前活动核心」入口选择。
//!
//! 承载 [`CoreSource`] / [`HarnessCore`] 两个公开类型，以及
//! [`active_source`] / [`active_dsh_binary`] / [`active_core_dir`] / [`active_version`]
//! 四个供服务启动与插件操作统一取用的入口。本地核心探测见 [`super::local`]。

use crate::AppHandle;
use crate::config;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::OnceLock;

use super::local::{local_core, local_core_package_dir};
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
    /// 能否卸载：只有磁盘上存在独立槽位目录（`dependencies/<tag>`）的行才有卸载落点。
    /// 就地安装的激活副本只有 `dependencies/dsh` 一份目录，按 tag 找不到槽位，卸载必然
    /// 失败（issue #790）。
    pub removable: bool,
    /// 是否预览版（GitHub Release 标记 Pre-release，或 tag 命名含预览标记，见
    /// `download::is_preview_tag`）：预览版不参与自动更新提示，但可在核心列表
    /// 手动下载安装，并以「预览版」标签展示。
    pub preview: bool,
    /// 本地存在但远程 pkg 仓库已不再提供的历史槽位。
    pub orphaned: bool,
    /// 是否随安装包分发（离线包把内核托管到 `$Resources/dsh`）：核心面板把它置顶并
    /// 标记「本地」，且不提供卸载——它是内网/离线环境唯一的兜底内核。
    pub bundled: bool,
    pub error: Option<String>,
}

/// 基线告警只发一次：`active_source` 在启动、核心列表与插件操作中反复调用。
static UNSUPPORTED_LOCAL_WARNED: OnceLock<()> = OnceLock::new();

pub(crate) fn core_supports_bundled_plugins(version: &str, baseline: Option<&str>) -> bool {
    let Ok(actual) = semver::Version::parse(version) else {
        return false;
    };
    actual.major == 0
        && actual.minor == 2
        && actual.patch == 2
        && semver::Version::parse("0.2.2-rc.1").is_ok_and(|minimum| actual >= minimum)
        && baseline
            .and_then(|baseline| semver::Version::parse(baseline).ok())
            .is_none_or(|baseline| actual >= baseline)
}

/// 预打包核心目录里**实际安装**的引擎版本（不含 `v` 前缀）。
///
/// 先读磁盘清单，再回落到安装记录的 tag：tag 只说明「上次下载了哪个发布」，
/// 磁盘上那份文件才是真正会被启动的（issue #1374）。
pub(crate) fn app_core_version(core_dir: &std::path::Path, tag: Option<&str>) -> Option<String> {
    config::dsh_version_at(&config::manifest_in(core_dir))
        .filter(|version| semver::Version::parse(version).is_ok())
        .or_else(|| tag.and_then(parse_version_from_tag))
}

pub(crate) fn ensure_app_core_supported(
    core_dir: &std::path::Path,
    tag: Option<&str>,
    baseline: Option<&str>,
) -> Result<(), String> {
    if super::legacy::is_directory_core(core_dir) {
        return Err("CORE_VERSION_LEGACY_DIRECTORY: managed directory cores are retired; download an asar core".to_string());
    }
    let version = app_core_version(core_dir, tag);
    if !core_supports_bundled_plugins(version.as_deref().unwrap_or_default(), baseline) {
        return Err(format!(
            "CORE_APP_UNSUPPORTED: app dsh {} is outside the supported 0.2.2 core series (minimum {}); {}",
            version.as_deref().unwrap_or_default(),
            baseline.unwrap_or_default(),
            repair_hint(core_dir, version.as_deref(), baseline),
        ));
    }
    Ok(())
}

/// 低于基线时的可操作提示：点名磁盘路径与两个版本，而不是让人猜「重试」为什么无效。
fn repair_hint(
    core_dir: &std::path::Path,
    version: Option<&str>,
    baseline: Option<&str>,
) -> String {
    format!(
        "the core installed at {} is {} but this app requires at least {}; restart the app to reinstall it automatically, or delete that directory and restart, or download a newer core in Settings > Core",
        core_dir.display(),
        version.unwrap_or("<unknown>"),
        baseline.unwrap_or("<unset>"),
    )
}

fn warn_unsupported_local_core(version: &str, baseline: Option<&str>) {
    if UNSUPPORTED_LOCAL_WARNED.set(()).is_err() {
        return;
    }
    log::warn!(
        "CORE_LOCAL_UNSUPPORTED: local dsh {} is outside the supported 0.2.2 core series (minimum {}); using the bundled core instead (issue #596)",
        version,
        baseline.unwrap_or("<unset>"),
    );
}

/// 当前活动核心来源（需求 3：本地核心存在时优先，除非用户显式选择预打包）。
///
/// 本地核心低于最低支持版本时不参与优先，一律回退预打包核心：内置插件是桌面壳的
/// 组成部分，装上也无法加载，只会把启动卡在插件阶段（issue #596）。持久化的
/// `active_core` 设置不改写——用户升级本地核心后自动恢复「本地优先」。
pub fn active_source<R: tauri::Runtime>(app_handle: &AppHandle<R>) -> CoreSource {
    let setting = config::get_store_dat_setting(app_handle);
    let local = local_core(app_handle);
    let baseline = config::manifest::minimum_dsh_version(app_handle);
    let local_usable = local
        .as_ref()
        .is_some_and(|core| core_supports_bundled_plugins(&core.version, baseline.as_deref()));
    if local.is_some() && !local_usable {
        warn_unsupported_local_core(
            local
                .as_ref()
                .map(|core| core.version.as_str())
                .unwrap_or_default(),
            baseline.as_deref(),
        );
    }
    match setting.active_core.as_deref().and_then(CoreSource::parse) {
        Some(CoreSource::App) => CoreSource::App,
        // 显式选择本地但本地已失效/低于基线 → 回退预打包
        Some(CoreSource::Local) if local_usable => CoreSource::Local,
        // 未设置（自动）或显式本地不可用：本地可用时优先
        _ => {
            if local_usable {
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
pub fn active_dsh_binary<R: tauri::Runtime>(app_handle: &AppHandle<R>) -> PathBuf {
    match active_source(app_handle) {
        CoreSource::Local => local_core(app_handle)
            .map(|c| c.bin)
            .unwrap_or_else(|| config::get_dsh_binary_path(app_handle)),
        CoreSource::App => config::get_dsh_binary_path(app_handle),
    }
}

/// 当前活动核心的安装目录：本地核心用其包目录（全局安装路径），预打包用桌面端目录。
///
/// 该目录同时是核心与 `dsh plugin` 子进程的 cwd（`CreateProcessW` 的 lpCurrentDirectory
/// 必须真实存在），也是本地 spec 绝对化的基准。本地核心生效时桌面端依赖根不会被创建
/// （`runtime::prepare_active_runtime` 跳过），误用依赖根会让核心启动卡在插件安装阶段：
/// `PREINSTALL_SPAWN: 目录名称无效。 (os error 267)`。
///
/// 与 [`active_dsh_binary`] 的取舍一致——本地核心解析在调用瞬间失效时回退预打包目录。
pub fn active_core_dir(app_handle: &AppHandle) -> PathBuf {
    match active_source(app_handle) {
        CoreSource::Local => local_core_package_dir(app_handle)
            .unwrap_or_else(|| config::get_dsh_install_path(app_handle)),
        CoreSource::App => config::get_dsh_install_path(app_handle),
    }
}

/// 当前生效的核心是否就是随安装包分发的那份（离线包把内核托管到 `$Resources/dsh`）。
///
/// 判定「来源是 App **且** 生效根就是随包内核目录」：切到本地核心时映射被记为系统环境、
/// 生效根回落到随包目录，此时不能再算作随包内核。
pub fn active_is_bundled<R: tauri::Runtime>(app_handle: &AppHandle<R>) -> bool {
    active_source(app_handle) == CoreSource::App
        && config::dependencies::bundled_core_dir(app_handle).is_some_and(|dir| {
            config::dependencies::active_root(app_handle, config::dependencies::DEP_DSH) == dir
        })
}

/// 当前活动核心的版本号（`--no-open` 等按版本判定的能力以它为准）。
pub fn active_version(app_handle: &AppHandle) -> Option<String> {
    match active_source(app_handle) {
        CoreSource::Local => local_core(app_handle).map(|c| c.version),
        CoreSource::App => {
            // 随包内核没有对应的 pkg tag：store 里的 tag 属于上一次下载的版本，直接采用
            // 会把随包内核当成那个版本（能力判定、补丁与插件兼容性都会走错分支）。
            if active_is_bundled(app_handle) {
                return config::get_dsh_version(app_handle);
            }
            // 磁盘上的实际文件优先：store 里的 tag 只记录「上次下载的是哪个发布」，
            // 应用自动更新后它与目录里的旧文件可能不一致（issue #1374 的「自报版本与
            // 实际校验版本不一致」）。
            app_core_version(
                &config::get_dsh_install_path(app_handle),
                config::get_dsh_pkg_tag(app_handle).as_deref(),
            )
            .or_else(|| config::get_dsh_version(app_handle))
        }
    }
}

pub fn app_core_meets_baseline(app_handle: &AppHandle) -> bool {
    if active_source(app_handle) != CoreSource::App {
        return true;
    }
    let baseline = config::manifest::minimum_dsh_version(app_handle);
    core_supports_bundled_plugins(
        app_core_version(
            &config::get_dsh_install_path(app_handle),
            config::get_dsh_pkg_tag(app_handle).as_deref(),
        )
        .as_deref()
        .unwrap_or_default(),
        baseline.as_deref(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supported_core_series_starts_at_022_rc1() {
        for version in ["0.2.2-rc.1", "0.2.2-rc.2", "0.2.2", "0.2.2+build.1"] {
            assert!(core_supports_bundled_plugins(version, None), "{version}");
        }
        for version in [
            "",
            "unknown",
            "0.2.1",
            "0.2.2-beta.1",
            "0.2.2-rc.0",
            "0.2.3-rc.1",
            "0.3.0",
            "1.0.0",
        ] {
            assert!(!core_supports_bundled_plugins(version, None), "{version}");
        }
        assert!(!core_supports_bundled_plugins(
            "0.2.2-rc.1",
            Some("0.2.2-rc.2")
        ));
    }

    #[test]
    fn managed_directory_is_rejected_even_with_a_supported_version() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join(config::DSH_MANIFEST_RELATIVE),
            r#"{"name":"@deepseek-ai/dsh","version":"0.2.2-rc.1"}"#,
        )
        .unwrap();
        assert!(
            ensure_app_core_supported(root.path(), None, None)
                .unwrap_err()
                .starts_with("CORE_VERSION_LEGACY_DIRECTORY:")
        );
    }

    #[test]
    fn app_core_version_prefers_disk_over_the_recorded_tag() {
        let root = tempfile::tempdir().unwrap();
        let manifest = root.path().join(config::DSH_MANIFEST_RELATIVE);
        std::fs::write(
            &manifest,
            r#"{"name":"@deepseek-ai/dsh","version":"0.2.2-rc.1"}"#,
        )
        .unwrap();
        assert_eq!(
            app_core_version(root.path(), Some("dsh-0.2.2-rc.2-123")).as_deref(),
            Some("0.2.2-rc.1")
        );
        std::fs::remove_file(manifest).unwrap();
        assert_eq!(
            app_core_version(root.path(), Some("dsh-0.2.2-rc.2-123")).as_deref(),
            Some("0.2.2-rc.2")
        );
    }
}
