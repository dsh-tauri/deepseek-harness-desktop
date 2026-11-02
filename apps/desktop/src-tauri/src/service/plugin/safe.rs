//! 安全模式插件卫生：进入安全档案（`safe`）启动前清除该档案里的用户插件。
//!
//! 安全档案的契约是「只加载 web 模板核心 bundles、不带任何用户插件/补丁层」
//! （见 [`crate::service::profile::ensure_safe_profile`]）。但档案目录一旦存在就
//! 绝不重建（用户可能反复进出安全模式，重建会一并丢掉档案内的其它状态），而
//! 内置插件自愈（[`super::internal`]）与首次引导安装都作用于「当时的活动档案」
//! ——于是安全档案里会累积用户插件。它们往往正是启动失败的元凶：不清理的话每次
//! 进入安全模式都带着同一批插件重启，隔离形同虚设（用户看到的仍是同一个启动失败）。
//!
//! 因此桌面端在 spawn dsh 之前把安全档案里的用户插件卸干净，只保留两类：
//! - **内置插件**（`internal: true`，如 dsh-tauri 系列）：随安装包分发、由启动自愈
//!   强制安装，桌面壳的核心功能依赖它们；
//! - **核心/官方包**（`@deepseek-ai/*`）：安全档案的模板本身
//!   （`@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-web-app`）。
//!
//! 卸载走离线精准路径（[`uninstall_recovery`]）：不依赖 node/pnpm/窗口、不触网，
//! 即使插件产物已损坏也能移除。调用时机必须是服务未启动时（改清单、删 node_modules
//! 目录才安全），故由 launch 在 spawn 前调用。普通档案一律不动：用户的插件是用户资产。

use std::collections::HashSet;
use crate::AppHandle;

use super::recovery::is_actionable_plugin_ref;
use super::{installed_name, list_installed, load_presets, uninstall_recovery};
use crate::service::profile::{active_profile, SAFE_PROFILE};

/// 计算安全档案里需要清除的用户插件包名（纯函数，便于单测）。
///
/// 命中条件：条目出现在 profile 清单（`dependencies` 键或 `dsh.profile.bundles`，
/// 由 [`list_installed`] 给出）、可被卸载（[`is_actionable_plugin_ref`] 排除
/// 核心/官方 `@deepseek-ai/*` 与非法包名），且不属于内置插件。其余一律视为用户
/// 插件——安全模式宁可多清（离线卸载对未安装条目是 no-op），也不留下任何可能
/// 触发启动失败的插件。
fn user_plugin_names(installed: &HashSet<String>, builtin: &HashSet<String>) -> Vec<String> {
    let mut names: Vec<String> = installed
        .iter()
        .filter(|name| is_actionable_plugin_ref(name) && !builtin.contains(*name))
        .cloned()
        .collect();
    // 排序只为日志与测试的确定性（卸载顺序与结果无关）。
    names.sort();
    names
}

/// 内置插件包名集合（以实际安装包名为准，见 [`installed_name`]）。
///
/// 清单来自随包分发的 `resources/manifest.jsonc` 的 `plugins.built-in`，debug 下并入仓库根
/// `packages/*` 发现的内置插件；内部属性由清单来源决定（见 `preset::load_presets`），
/// 社区预设与内置插件在此处天然分流。
fn builtin_plugin_names(app_handle: &AppHandle) -> HashSet<String> {
    load_presets(app_handle)
        .iter()
        .filter(|plugin| plugin.internal)
        .map(|plugin| installed_name(plugin).to_string())
        .collect()
}

/// spawn dsh 之前调用：当前档案是安全档案时，清除其中全部用户插件。
///
/// 非安全档案直接返回（普通档案的插件是用户资产，绝不触碰）。单个插件卸载失败不
/// 中断其余插件的清理，失败聚合为 Err 交调用方只记告警：清理不彻底顶多让安全模式
/// 隔离效果打折，而阻断启动会让应用彻底不可用（与启动期其它自愈同一策略）。
pub(crate) fn purge_user_plugins_in_safe_profile(app_handle: &AppHandle) -> Result<(), String> {
    if active_profile(app_handle) != SAFE_PROFILE {
        return Ok(());
    }

    let builtin = builtin_plugin_names(app_handle);
    // 内置插件清单不可用（随包资源缺失/损坏）时无法区分内置插件与用户插件：此时
    // 宁可什么都不清（维持现状），也不能把桌面壳依赖的内置插件当用户插件删掉。
    // 清单缺失本身已由 `preset::load_manifest` 记录错误，插件面板与安装入口同样
    // 已降级，安全模式在这一状态下退回「不清理」是唯一不会造成额外破坏的选择。
    if builtin.is_empty() {
        log::warn!(
            "SAFE_MODE_PLUGIN_PURGE_SKIPPED: built-in plugin manifest unavailable, cannot tell user plugins apart"
        );
        return Ok(());
    }

    let names = user_plugin_names(&list_installed(app_handle), &builtin);
    if names.is_empty() {
        return Ok(());
    }

    log::info!(
        "safe mode: removing {} user plugin(s) from the safe profile: {names:?}",
        names.len()
    );
    let mut failures = Vec::new();
    for name in &names {
        match uninstall_recovery(app_handle, name) {
            Ok(()) => log::info!("SAFE_MODE_PLUGIN_PURGE: removed {name}"),
            Err(e) => {
                log::warn!("SAFE_MODE_PLUGIN_PURGE_FAILED: {name}: {e}");
                failures.push(format!("{name}: {e}"));
            }
        }
    }

    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "SAFE_MODE_PLUGIN_PURGE_FAILED: {}",
            failures.join("; ")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(items: &[&str]) -> HashSet<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn purges_user_plugins_but_keeps_core_and_builtin() {
        let installed = names(&[
            "@deepseek-ai/dsh-base",
            "@deepseek-ai/dsh-web-app",
            "dsh-tauri",
            "dsh-tauri-ui",
            "dshmarket",
            "dsh-notification",
        ]);
        let builtin = names(&["dsh-tauri", "dsh-tauri-ui"]);

        assert_eq!(
            user_plugin_names(&installed, &builtin),
            vec!["dsh-notification".to_string(), "dshmarket".to_string()]
        );
    }

    #[test]
    fn pristine_safe_profile_needs_no_purge() {
        let installed = names(&["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]);
        assert!(user_plugin_names(&installed, &HashSet::new()).is_empty());
    }

    #[test]
    fn invalid_refs_are_never_targeted() {
        // 非法包名（空、路径片段）不进入卸载清单：离线卸载以包名为键拼
        // node_modules 路径，越界引用必须被 `is_actionable_plugin_ref` 挡下。
        let installed = names(&["", "..", "foo/../../target", "with space", "dsh-ok"]);
        assert_eq!(
            user_plugin_names(&installed, &HashSet::new()),
            vec!["dsh-ok".to_string()]
        );
    }

}
