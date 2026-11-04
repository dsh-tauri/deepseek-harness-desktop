//! 插件异常修复（recovery）：启动失败 / 运行期异常时定位问题插件，并提供
//! 「卸除此插件并继续检测」的一键离线修复。
//!
//! 参考 dataelement/dsh-desktop 的插件异常修复模式（PR #94/#96）：
//! - **定位**：从启动日志按错误特征提取插件引用（duplicate route / loader entry /
//!   cannot resolve bundle / no dsh.bundle / slot conflict / failed to import），再
//!   按 profile `package.json` + `node_modules` 归属回配置的根插件——只有拿到确凿
//!   证据才动手，绝不瞎猜（提取见 [`extract`]，归属见 [`ownership`]）。
//! - **卸载**：直接改 profile 清单（`dependencies` + `dsh.profile.bundles`）、删除
//!   `node_modules/<id>`、剥离 `cordis.patch.yml` 中该插件的补丁层、清掉
//!   `pnpm-lock.yaml`（best-effort），保留其它插件与配置（见 [`uninstall`]）。
//!   与 [`super::install`] 走 `dsh plugin` 子进程不同：本模块离线、精准，不需要网络。
//!
//! 卸载成功后由前端 `restart()` 重启并重新检测；若仍有问题，启动失败再次触发
//! 定位，形成「继续检测」循环。

use regex::Regex;
use serde::{Deserialize, Serialize};
use crate::AppHandle;

use super::errors;

use extract::{
    classify_reason, extract_duplicate_loader_entry, extract_plugin_refs, extract_slot_conflict,
};
use ownership::resolve_recovery_plugins;
pub(crate) use uninstall::patch_entry_targets;
use uninstall::{remove_plugin_dir, remove_plugin_from_manifest, strip_cordis_patch_for};

// plugin 兄弟模块的再导出：子模块经 `super::` 统一从这里取。
pub(crate) use super::installed::profile_dir;

mod extract;
mod ownership;
mod uninstall;

/// 前端监听的事件名：需要弹出插件异常修复界面时推送。
pub(crate) const RECOVERY_REQUIRED_EVENT: &str = "plugin-recovery-required";

/// 真正不可被「修复卸载」删除的核心 bundle / 官方包。
///
/// `dshmarket`（插件市场）虽然列在预设清单里，但它本身是第三方插件（npm 包
/// `dshmarket`，来源 `dsh-market/dsh-market`），不是核心/官方包，必须允许用户
/// 卸载。若把它列入保护名单，用户从插件面板点「卸载」时，`dsh plugin remove`
/// 因 dshmarket 属于 in-box bundle（`pnpm remove` 不动它）会返回成功但插件仍在，
/// 桌面端又因 protection 跳过离线卸载兜底，最终「提示成功但插件仍在」。
///
/// `@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-web-app` 等核心包都被
/// `@deepseek-ai/` 前缀覆盖，无需逐个点名。
pub(crate) fn is_core_package(name: &str) -> bool {
    name.starts_with("@deepseek-ai/")
}

/// 是否为合法的 npm 包名（可带 scope）。用于过滤日志里提取到的候选引用。
pub(crate) fn is_package_name(s: &str) -> bool {
    let s = s.trim();
    if s.is_empty() || s.contains(':') || s.chars().any(|c| c.is_whitespace()) {
        return false;
    }

    let (scope, name) = if let Some((scope, name)) = s.split_once('/') {
        // scoped 包名必须恰好只有一层 scope/name，不能把多个路径片段带入 join。
        if !s.starts_with('@') || name.is_empty() || name.contains('/') {
            return false;
        }
        (Some(scope), name)
    } else {
        if s.starts_with('@') {
            return false;
        }
        (None, s)
    };

    fn valid_component(component: &str, is_scope: bool) -> bool {
        let component = if is_scope {
            component.strip_prefix('@').unwrap_or(component)
        } else {
            component
        };
        !component.is_empty()
            && component != "."
            && component != ".."
            && !component.starts_with('.')
            && !component.ends_with('.')
            && !component.starts_with("..")
            && !component.ends_with("..")
            && component
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
    }

    if scope.is_some_and(|scope| !valid_component(scope, true)) {
        return false;
    }
    valid_component(name, false)
}

/// 是否是可行动的第三方插件引用（排除核心包与 @deepseek-ai 官方包）。
pub(crate) fn is_actionable_plugin_ref(s: &str) -> bool {
    is_package_name(s) && !is_core_package(s.trim())
}

/// 启动失败时前端读到的日志行（已清洗 ANSI），序列化给前端（camelCase）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginRecoveryInfo {
    /// 定位到的插件 id（npm 包名），可能为空（未定位到具体插件）
    pub plugins: Vec<String>,
    /// 失败原因判别键：duplicate_route / duplicate_loader_entry / cannot_resolve_bundle /
    /// no_dsh_bundle / slot_conflict / load_failed / runtime / unknown
    pub reason: String,
    /// 动态详情（如冲突的路由 / 槽位 / 服务组件 id），用于 I18n 插值
    pub detail: String,
    /// 原始错误信息（技术详情查看）
    pub raw_error: String,
}

/// 定位启动失败的问题插件：给定日志行，返回恢复信息（未定位到则 plugins 为空）。
pub fn detect(app_handle: &AppHandle, log_lines: &[String]) -> PluginRecoveryInfo {
    let text = log_lines.join("\n");
    let refs = extract_plugin_refs(&text);
    let duplicate_entry = extract_duplicate_loader_entry(&text);
    let slot_conflict = extract_slot_conflict(&text);
    let (reason, detail) = classify_reason(&text);
    let plugins = resolve_recovery_plugins(
        app_handle,
        &refs,
        duplicate_entry.as_deref(),
        slot_conflict.as_deref(),
    );
    let raw_error = refs_text(&text);
    PluginRecoveryInfo {
        plugins,
        reason,
        detail,
        raw_error,
    }
}

/// 原始错误描述：尽量取关键错误行，供「查看技术详情」。
fn refs_text(text: &str) -> String {
    // 从日志里搜出带错误标记的行（最多 8 行），没有则取尾部。
    let marker_any =
        Regex::new(r"(?i)error|duplicate|fatal|panic|throw|failed|exception|✖").expect("literal");
    let mut err_lines: Vec<&str> = text
        .lines()
        .filter(|l| marker_any.is_match(l))
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();
    if err_lines.is_empty() {
        let tail: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
        let start = tail.len().saturating_sub(8);
        err_lines = tail[start..].to_vec();
    }
    let joined = err_lines.join("\n");
    joined.chars().take(2000).collect()
}

/// 修复模式卸载：精准删除指定插件（离线、不破坏其它插件）。
pub fn uninstall(app_handle: &AppHandle, id: &str) -> Result<(), String> {
    if !is_actionable_plugin_ref(id) {
        return Err(format!(
            "PLUGIN_RECOVERY_REFUSED: refusing to remove core/official package {id}"
        ));
    }
    let profile = profile_dir(app_handle);
    let manifest_path = profile.join("package.json");
    if !manifest_path.exists() {
        return Err("PLUGIN_RECOVERY_NO_MANIFEST: profile package.json missing".to_string());
    }
    let content = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("PLUGIN_RECOVERY_READ: {e}"))?;
    let mut manifest: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("PLUGIN_RECOVERY_PARSE: {e}"))?;

    // 补丁层先清：条目还在而包已被删时，loader 仍会 import 它并让整棵插件树加载
    // 失败，而档案与 node_modules 都已改过，下一次退役扫描也不会再发现这个包。
    // 反过来（补丁清了、清单没写成）只是丢了该插件的补丁配置，插件照常加载。
    strip_cordis_patch_for(&profile, id)?;

    let modified = remove_plugin_from_manifest(&mut manifest, id);
    if modified {
        let rendered = serde_json::to_string_pretty(&manifest)
            .map_err(|e| format!("PLUGIN_RECOVERY_RENDER: {e}"))?;
        std::fs::write(&manifest_path, format!("{rendered}\n"))
            .map_err(|e| format!("PLUGIN_RECOVERY_WRITE: {e}"))?;
        log::info!("Recovery uninstall removed plugin {id} from profile manifest");
    }

    remove_plugin_dir(&profile, id);
    // 清掉 lockfile，让 pnpm 重装时重建干净依赖图（best-effort）。
    if let Err(e) = std::fs::remove_file(profile.join("pnpm-lock.yaml")) {
        if e.kind() != std::io::ErrorKind::NotFound {
            log::warn!("failed to remove pnpm-lock.yaml during recovery: {e}");
        }
    }
    if let Err(e) = errors::clear(app_handle, id) {
        log::warn!("failed to clear plugin error for {id} during recovery: {e}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_package_predicate_preserves_exact_prefix_boundary() {
        for (name, expected) in [
            ("@deepseek-ai/pkg", true),
            ("@deepseek-ai/", true),
            ("@deepseek-ai", false),
            ("@deepseek-ai-extra/pkg", false),
            (" @deepseek-ai/pkg", false),
            ("@Deepseek-ai/pkg", false),
            ("dshmarket", false),
            ("", false),
        ] {
            assert_eq!(is_core_package(name), expected, "{name}");
        }
    }

    #[test]
    fn package_name_validation() {
        assert!(is_package_name("dshmarket"));
        assert!(is_package_name("@scope/pkg"));
        assert!(is_package_name("dsh-better-sidebar"));
        assert!(!is_package_name(""));
        assert!(!is_package_name("has space"));
        assert!(!is_package_name("with:colon"));
        assert!(!is_package_name("@bare"));
        assert!(!is_package_name("foo/../../target"));
        assert!(!is_package_name("@scope/../../target"));
        assert!(!is_package_name("@scope/pkg/extra"));
        assert!(!is_package_name(r"foo\..\target"));
        assert!(!is_package_name(r"@scope\pkg"));
        assert!(!is_package_name("@scope/@pkg"));
        assert!(!is_package_name("@scope/.."));
        assert!(!is_package_name("@scope/."));
        assert!(!is_package_name(".pnpm"));
        assert!(!is_package_name(".hidden"));
        assert!(!is_package_name("foo."));
        assert!(!is_package_name("@.scope/pkg"));
        assert!(!is_package_name("@scope/.hidden"));
        assert!(!is_package_name("@scope/foo."));
        assert!(is_package_name("foo.bar"));
        assert!(is_package_name("@scope/pkg.name"));
        // dshmarket 是第三方市场插件，可卸载（不应被当作核心保护包）
        assert!(is_actionable_plugin_ref("dshmarket"));
        assert!(is_actionable_plugin_ref("dsh-better-sidebar"));
    }

    #[test]
    fn official_packages_remain_non_actionable() {
        assert!(is_package_name("@deepseek-ai/dsh-base"));
        assert!(is_package_name("@deepseek-ai/dsh-client-ui-chat"));
        assert!(!is_actionable_plugin_ref("@deepseek-ai/dsh-base"));
        assert!(!is_actionable_plugin_ref("@deepseek-ai/dsh-client-ui-chat"));
    }

    #[test]
    fn recovery_info_serializes_camel_case_fields() {
        let info = PluginRecoveryInfo {
            plugins: vec!["dsh-tauri".to_string()],
            reason: "load_failed".to_string(),
            detail: String::new(),
            raw_error: "failed to apply loader entry 644301cc (dsh-tauri)".to_string(),
        };
        let json = serde_json::to_value(&info).expect("serialize recovery info");

        assert_eq!(
            json["rawError"],
            "failed to apply loader entry 644301cc (dsh-tauri)"
        );
        assert_eq!(json["plugins"][0], "dsh-tauri");
        assert_eq!(json["reason"], "load_failed");
        // 前端只认 camelCase：snake_case 字段一旦出现，修复界面的原始错误将被静默丢弃
        assert!(json.get("raw_error").is_none());
    }
}
