//! 弃用插件退役：`resources/manifest.jsonc` 的 `plugins.depercated` 登记项不再
//! 提供安装入口，档案里已安装的副本在服务启动前移除。
//!
//! 弃用即「与新核心不兼容」：留在档案里会被 loader 继续展开，表现为启动白屏
//! （`Failed to load plugins` / `web boot: N entries did not activate`），而用户
//! 从界面上找不到卸载入口——这些 id 已不在预设清单里，插件面板也不列它们。
//!
//! 内置插件（`internal: true`）不在此列：它们归桌面壳所有，去留只由清单
//! `plugins.built-in` 决定，否则会与启动自愈互相拉扯（卸掉又装回）。

use std::collections::HashSet;
use std::path::Path;

use crate::AppHandle;

use super::installed::{declared_packages_at, installed_name, profile_dir};
use super::preset::{load_deprecated_ids, load_presets, PreinstallPluginInfo};
use super::recovery::is_actionable_plugin_ref;
use super::uninstall_recovery;

/// 档案里仍需清除的弃用插件包名（排序去重）。
///
/// `referenced` 判定「该包名在档案里真实存在」（清单声明或 `node_modules` 入口）。
/// 命中范围不受 `plugins.preset` 约束：登记在弃用名单、但早已从预设清单删除的 id
/// （如 `dsh-tauri-kernel`）同样要清，否则老用户档案里的残留永远无人处理。
fn deprecated_installed_names(
    presets: &[PreinstallPluginInfo],
    deprecated: &HashSet<String>,
    mut referenced: impl FnMut(&str) -> bool,
) -> Vec<String> {
    let mut names: Vec<String> = presets
        .iter()
        .filter(|preset| !preset.internal && deprecated.contains(&preset.id))
        .map(installed_name)
        .filter(|name| referenced(name))
        .map(str::to_string)
        .collect();
    for id in deprecated {
        if presets.iter().any(|preset| preset.id == *id) || !referenced(id) {
            continue;
        }
        names.push(id.clone());
    }
    names.retain(|name| is_actionable_plugin_ref(name));
    names.sort();
    names.dedup();
    names
}

/// 给定档案目录下的待退役插件（纯路径版，启动快路径与常规启动共用）。
pub(crate) fn installed_names_at(
    profile: &Path,
    presets: &[PreinstallPluginInfo],
    deprecated: &HashSet<String>,
) -> Vec<String> {
    if deprecated.is_empty() {
        return Vec::new();
    }
    let declared = declared_packages_at(profile).unwrap_or_default();
    let node_modules = profile.join("node_modules");
    deprecated_installed_names(presets, deprecated, |name| {
        declared.contains(name) || node_modules.join(name).symlink_metadata().is_ok()
    })
}

/// 启动前移除档案里的弃用插件。
///
/// 走离线精准卸载（[`uninstall_recovery`]）：不依赖 node/pnpm/窗口、不触网，
/// 插件产物已损坏时同样能移除。最佳努力：单个失败只记告警并汇总上抛，调用方
/// 不得因此阻断启动——残留插件顶多让本次启动失败，而拦住启动会让应用彻底不可用。
pub(crate) fn uninstall(app_handle: &AppHandle) -> Result<(), String> {
    let names = installed_names_at(
        &profile_dir(app_handle),
        &load_presets(app_handle),
        &load_deprecated_ids(app_handle),
    );
    if names.is_empty() {
        return Ok(());
    }
    log::info!("Retiring deprecated preset plugins: {names:?}");
    let mut failures = Vec::new();
    for name in &names {
        match uninstall_recovery(app_handle, name) {
            Ok(()) => log::info!("DEPRECATED_PLUGIN_UNINSTALL: removed {name}"),
            Err(e) => {
                log::warn!("DEPRECATED_PLUGIN_UNINSTALL_FAILED: {name}: {e}");
                failures.push(format!("{name}: {e}"));
            }
        }
    }
    if failures.is_empty() {
        return Ok(());
    }
    Err(format!(
        "DEPRECATED_PLUGIN_UNINSTALL_FAILED: {}",
        failures.join("; ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn preset(id: &str, package: Option<&str>, internal: bool) -> PreinstallPluginInfo {
        PreinstallPluginInfo {
            id: id.into(),
            spec: id.into(),
            package: package.map(String::from),
            name: id.into(),
            description: String::new(),
            repo_url: String::new(),
            recommended: false,
            fix: false,
            default_checked: false,
            default_unchecked: false,
            version: None,
            win_only: false,
            internal,
        }
    }

    fn ids(items: &[&str]) -> HashSet<String> {
        items.iter().map(|item| (*item).to_string()).collect()
    }

    #[test]
    fn deprecation_covers_renamed_packages_and_ids_dropped_from_presets() {
        let presets = vec![preset("dsh-old-name", Some("@scope/dsh-old-name"), false)];
        let deprecated = ids(&["dsh-old-name", "dsh-tauri-kernel"]);
        let names = deprecated_installed_names(&presets, &deprecated, |_| true);
        assert_eq!(names, vec!["@scope/dsh-old-name", "dsh-tauri-kernel"]);
    }

    #[test]
    fn deprecation_removes_listed_preset_but_skips_absent_builtin_and_protected_packages() {
        let presets = vec![
            preset("dsh-listed-and-deprecated", None, false),
            preset("dsh-builtin-old", None, true),
        ];
        let deprecated = ids(&[
            "dsh-listed-and-deprecated",
            "dsh-builtin-old",
            "dsh-absent",
            "@deepseek-ai/dsh-base",
        ]);
        let names = deprecated_installed_names(&presets, &deprecated, |name| name != "dsh-absent");
        // 弃用名单优先于预设清单：两个清单同时登记时仍要退役；内置插件归桌面壳，
        // 未安装的与核心包（`@deepseek-ai/*`）一律不碰。
        assert_eq!(names, vec!["dsh-listed-and-deprecated"]);
    }

    #[test]
    fn deprecation_reports_each_package_once() {
        let presets = vec![
            preset("dsh-alias-a", Some("dsh-shared"), false),
            preset("dsh-alias-b", Some("dsh-shared"), false),
        ];
        let deprecated = ids(&["dsh-alias-a", "dsh-alias-b", "dsh-shared"]);
        let names = deprecated_installed_names(&presets, &deprecated, |_| true);
        assert_eq!(names, vec!["dsh-shared"]);
    }

    #[test]
    fn installed_names_read_declared_dependencies_and_orphan_entries() {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        std::fs::create_dir_all(profile.join("node_modules/dsh-tauri-kernel")).unwrap();
        std::fs::write(
            profile.join("package.json"),
            serde_json::json!({
                "dependencies": {"dsh-legacy-session": "1.0.0"},
                "dsh": {"profile": {"bundles": ["dsh-legacy-panel"]}}
            })
            .to_string(),
        )
        .unwrap();

        let presets = vec![
            preset("dsh-legacy-session", None, false),
            preset("dsh-legacy-panel", None, false),
        ];
        let deprecated = ids(&[
            "dsh-legacy-session",
            "dsh-legacy-panel",
            "dsh-tauri-kernel",
            "dsh-never-installed",
        ]);
        assert_eq!(
            installed_names_at(&profile, &presets, &deprecated),
            vec![
                "dsh-legacy-panel".to_string(),
                "dsh-legacy-session".to_string(),
                "dsh-tauri-kernel".to_string()
            ]
        );
    }
}
