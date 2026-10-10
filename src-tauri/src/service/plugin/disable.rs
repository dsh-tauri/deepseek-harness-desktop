//! 插件禁用/启用：从 profile 的 `dsh.profile.bundles` 移除（代码完全不加载），
//! 并写入 profile 的独立禁用清单。与卸载不同，禁用保留 node_modules 内的包体，
//! 启用时无需重新下载。
//!
//! 机制遵循 ADR-0001：禁用 = 从加载列表移除 + 记入独立禁用清单；启用 = 精确逆操作。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::service::fs_guard;
use crate::service::plugin::installed::profile_dir;
use crate::service::plugin::recovery::{is_core_package, patch_entry_targets, remove_bundle};
use crate::service::plugin::{process, watch};

/// 单条禁用记录（序列化为 camelCase 给前端/磁盘）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DisabledEntry {
    /// 禁用时间（unix 秒级时间戳字符串）。
    pub disabled_at: String,
    /// 禁用来源：当前均为 "user"（用户主动操作）。
    pub reason: String,
}

/// 禁用清单在 profile 目录下的路径。
fn disabled_path(profile: &Path) -> PathBuf {
    profile.join("disabled-plugins.json")
}

/// 读取禁用清单（缺失/损坏按空处理）。
pub(crate) fn load_disabled(profile: &Path) -> HashMap<String, DisabledEntry> {
    let Ok(content) = fs::read_to_string(disabled_path(profile)) else {
        return HashMap::new();
    };
    serde_json::from_str(&content).unwrap_or_default()
}

/// 持久化禁用清单（pretty JSON + 尾部换行）。
pub(crate) fn save_disabled(
    profile: &Path,
    map: &HashMap<String, DisabledEntry>,
) -> Result<(), String> {
    let path = disabled_path(profile);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("DISABLED_DIR_CREATE_FAILED: {e}"))?;
    }
    let json =
        serde_json::to_string_pretty(map).map_err(|e| format!("DISABLED_RENDER_FAILED: {e}"))?;
    fs::write(&path, format!("{json}\n")).map_err(|e| format!("DISABLED_WRITE_FAILED: {e}"))
}

/// 读取 profile 的 `cordis.patch.yml`，返回「配置层显式禁用」条目的目标集合。
///
/// 配置覆盖禁用 = 顶层数组条目带真值 `disabled` 字段（`disabled: true` 等）。
/// 与桌面禁用清单（`disabled-plugins.json`）独立：patch 覆盖优先级更高，
/// 运行期同样不加载该插件。匹配口径与 `recovery::uninstall::patch_entry_targets`
/// 一致——把条目的 `id` 与任意字符串键/值都收进集合，由调用方按「包名或
/// package.json name 命中」判断，兼容 loader 入口 id 与 npm 包名不一致的别名场景。
///
/// 文件缺失/无法解析为顶层数组时按空集处理（与 `load_disabled` 一致，
/// 不阻断插件列表解析）。
pub(crate) fn load_patch_disabled(profile: &Path) -> HashSet<String> {
    let Ok(content) = fs::read_to_string(profile.join("cordis.patch.yml")) else {
        return HashSet::new();
    };
    let Ok(doc) = serde_yaml::from_str::<serde_yaml::Value>(&content) else {
        return HashSet::new();
    };
    let Some(entries) = doc.as_sequence() else {
        return HashSet::new();
    };
    let mut targets = HashSet::new();
    for entry in entries {
        let Some(map) = entry.as_mapping() else {
            continue;
        };
        if !patch_entry_disabled(map) {
            continue;
        }
        for (key, value) in map {
            if let Some(s) = key.as_str() {
                targets.insert(s.to_string());
            }
            if let Some(s) = value.as_str() {
                targets.insert(s.to_string());
            }
        }
    }
    targets
}

/// patch 顶层条目是否带「启用」语义（`disabled` 字段显式为假值）。
///
/// 官方 Plugins 页与 dshmarket 的「启用」只写 `cordis.patch.yml` 的
/// `disabled: false`，从不碰桌面禁用清单；该显式声明是上游唯一的启用凭证，
/// 启动自愈必须据此清理台账，否则台账会在每次启动时把刚启用的插件重新删出
/// `dsh.profile.bundles`（见 `preserve_disabled_bundles`）。
fn patch_entry_enabled(map: &serde_yaml::Mapping) -> bool {
    let Some(value) = map.get(serde_yaml::Value::String("disabled".to_string())) else {
        return false;
    };
    match value {
        serde_yaml::Value::Bool(b) => !*b,
        serde_yaml::Value::Number(n) => n.as_i64() == Some(0),
        serde_yaml::Value::String(s) => {
            s.eq_ignore_ascii_case("false") || s == "0" || s.eq_ignore_ascii_case("off")
        }
        _ => false,
    }
}

/// 被 `cordis.patch.yml` 显式声明为启用（`disabled: false`）的插件名集合。
///
/// 匹配口径与 [`load_patch_disabled`] 一致：顶层条目的 `id` 与任意字符串键/值。
/// 文件缺失/无法解析为顶层数组时按空集处理。
fn load_patch_enabled(profile: &Path) -> HashSet<String> {
    let Ok(content) = fs::read_to_string(profile.join("cordis.patch.yml")) else {
        return HashSet::new();
    };
    let Ok(doc) = serde_yaml::from_str::<serde_yaml::Value>(&content) else {
        return HashSet::new();
    };
    let Some(entries) = doc.as_sequence() else {
        return HashSet::new();
    };
    let mut targets = HashSet::new();
    for entry in entries {
        let Some(map) = entry.as_mapping() else {
            continue;
        };
        if !patch_entry_enabled(map) {
            continue;
        }
        for (key, value) in map {
            if let Some(s) = key.as_str() {
                targets.insert(s.to_string());
            }
            if let Some(s) = value.as_str() {
                targets.insert(s.to_string());
            }
        }
    }
    targets
}

/// patch 顶层条目是否带「禁用」语义（`disabled` 字段为真值）。
///
/// 兼容 YAML 常见真值写法：布尔 `true`、非零数字、字符串 true/1/yes/on。
fn patch_entry_disabled(map: &serde_yaml::Mapping) -> bool {
    let Some(value) = map.get(serde_yaml::Value::String("disabled".to_string())) else {
        return false;
    };
    match value {
        serde_yaml::Value::Bool(b) => *b,
        serde_yaml::Value::Number(n) => n.as_i64() != Some(0),
        serde_yaml::Value::String(s) => {
            s.eq_ignore_ascii_case("true")
                || s == "1"
                || s.eq_ignore_ascii_case("yes")
                || s.eq_ignore_ascii_case("on")
        }
        _ => false,
    }
}

/// 目标插件的匹配候选名：npm 包名（依赖键）+ 包内 package.json 的 `name` 字段。
///
/// 覆盖「依赖键即展示名」与「loader 入口 id 用包内 name」两种形态。
fn plugin_target_names(profile: &Path, id: &str) -> Vec<String> {
    let mut names = vec![id.to_string()];
    if let Ok(content) =
        fs::read_to_string(profile.join("node_modules").join(id).join("package.json"))
    {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(name) = json.get("name").and_then(|n| n.as_str()) {
                names.push(name.to_string());
            }
        }
    }
    names
}

/// 插件是否被 profile 的 `cordis.patch.yml` 配置覆盖禁用。
pub(crate) fn has_patch_disable(profile: &Path, id: &str) -> bool {
    let names = plugin_target_names(profile, id);
    load_patch_disabled(profile)
        .iter()
        .any(|target| names.iter().any(|n| n == target))
}

/// 从 `cordis.patch.yml` 移除目标插件的显式禁用覆盖，其余配置原样保留。
///
/// 精确语义（对应 issue #399「不删除无关配置」）：
/// - 纯禁用条目（仅 `id` + `disabled`）→ 整条移除；
/// - 带其它配置的条目 → 仅摘除 `disabled` 键，其余键原样保留；
/// - 其它插件的条目一律不动。
///
/// 幂等：无 patch 文件 / 无法解析 / 无目标禁用条目时返回 `Ok(false)` 且不写盘；
/// 实际修改时返回 `Ok(true)`。
pub(crate) fn strip_patch_disable(profile: &Path, id: &str) -> Result<bool, String> {
    let path = profile.join("cordis.patch.yml");
    let Ok(content) = fs::read_to_string(&path) else {
        return Ok(false);
    };
    let mut doc: serde_yaml::Value =
        serde_yaml::from_str(&content).map_err(|e| format!("ENABLE_PATCH_PARSE_FAILED: {e}"))?;
    let Some(entries) = doc.as_sequence_mut() else {
        return Ok(false);
    };
    let names = plugin_target_names(profile, id);
    let mut changed = false;
    let mut kept: Vec<serde_yaml::Value> = Vec::with_capacity(entries.len());
    for entry in entries.drain(..) {
        let Some(mut map) = entry.as_mapping().cloned() else {
            kept.push(entry);
            continue;
        };
        let targeted = names.iter().any(|name| patch_entry_targets(&entry, name));
        if !targeted || !patch_entry_disabled(&map) {
            kept.push(entry);
            continue;
        }
        changed = true;
        map.remove(serde_yaml::Value::String("disabled".to_string()));
        // 摘除 disabled 后仅剩 id（或为空）→ 纯禁用条目，整条丢弃；
        // 还有其它键 → 保留该条目的其余配置。
        let keeps_other_config = map.iter().any(|(k, _)| k.as_str() != Some("id"));
        if keeps_other_config {
            kept.push(serde_yaml::Value::Mapping(map));
        }
    }
    if !changed {
        return Ok(false);
    }
    let rendered = serde_yaml::to_string(&serde_yaml::Value::Sequence(kept))
        .map_err(|e| format!("ENABLE_PATCH_RENDER_FAILED: {e}"))?;
    fs::write(&path, rendered).map_err(|e| format!("ENABLE_PATCH_WRITE_FAILED: {e}"))?;
    log::info!("Stripped cordis.patch.yml disable override for plugin {id}");
    Ok(true)
}

/// 把插件加回 `dsh.profile.bundles`（若已存在则不重复添加）。
/// 返回是否实际新增了条目。
fn add_to_bundles(manifest: &mut serde_json::Value, id: &str) -> bool {
    let Some(bundles) = manifest
        .get_mut("dsh")
        .and_then(|d| d.get_mut("profile"))
        .and_then(|p| p.get_mut("bundles"))
        .and_then(|b| b.as_array_mut())
    else {
        return false;
    };
    if bundles.iter().any(|b| b.as_str() == Some(id)) {
        return false;
    }
    bundles.push(serde_json::Value::String(id.to_string()));
    true
}

/// 检查插件是否已安装（dependencies 中存在）。
fn is_in_dependencies(manifest: &serde_json::Value, id: &str) -> bool {
    manifest
        .get("dependencies")
        .and_then(|d| d.as_object())
        .map(|d| d.contains_key(id))
        .unwrap_or(false)
}

fn now_seconds_string() -> String {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_default()
}

pub(crate) fn preserve_disabled_bundles(profile: &Path) -> Result<(), String> {
    let mut disabled = load_disabled(profile);
    // 上游（官方 Plugins 页 / dshmarket）的「启用」只把 `cordis.patch.yml` 的
    // `disabled` 改成 `false`，从不写桌面禁用清单。台账若仍留着旧条目，启动
    // 自愈就会把用户刚启用的插件重新删出 `dsh.profile.bundles`，下次启动又被
    // 界面读成关闭（issue：两份台账无同步机制）。这里以补丁层的显式启用声明
    // 为准清理台账——只有「明确写了 false」才清，绝不因缺条目而推断。
    let enabled = load_patch_enabled(profile);
    if !enabled.is_empty() {
        let dropped: Vec<String> = disabled
            .keys()
            .filter(|id| {
                plugin_target_names(profile, id)
                    .iter()
                    .any(|name| enabled.contains(name))
            })
            .cloned()
            .collect();
        for id in &dropped {
            disabled.remove(id);
            log::info!("Cleared desktop disable ledger for patch-enabled plugin {id}");
        }
        if !dropped.is_empty() {
            save_disabled(profile, &disabled)?;
        }
    }
    if disabled.is_empty() {
        return Ok(());
    }
    let path = profile.join("package.json");
    let raw = fs::read_to_string(&path).map_err(|e| format!("DISABLE_READ_MANIFEST: {e}"))?;
    let mut manifest: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("DISABLE_PARSE_MANIFEST: {e}"))?;
    let before = manifest.clone();
    for id in disabled.keys() {
        remove_bundle(&mut manifest, id);
    }
    if manifest != before {
        let rendered = serde_json::to_string_pretty(&manifest)
            .map_err(|e| format!("DISABLE_RENDER_MANIFEST: {e}"))?;
        fs::write(&path, format!("{rendered}\n"))
            .map_err(|e| format!("DISABLE_WRITE_MANIFEST: {e}"))?;
    }
    Ok(())
}

/// 回滚禁用清单到操作前的状态。
///
/// 当 manifest 写入失败时，把已加入禁用清单的条目移除，使两个持久化文件
/// 恢复一致（插件仍在 bundles 中，禁用清单无记录），避免留下
/// 「已从 bundles 移除但未记入禁用清单」的不可恢复状态。
fn rollback_disable(profile: &Path, id: &str) {
    let mut map = load_disabled(profile);
    map.remove(id);
    // 回滚写入也失败时，只能静默——此时清单多一条目但插件仍在 bundles，
    // 下次禁用会覆盖该条目，不会阻塞用户操作。
    let _ = save_disabled(profile, &map);
}

/// 禁用插件的纯逻辑（不依赖 AppHandle，便于单元测试）。
///
/// 1. `fs_guard::validate_id(id)`（路径穿越防护）
/// 2. 拒绝官方/核心包
/// 3. 读取 profile package.json
/// 4. 校验插件已安装（dependencies 中存在）
/// 5. 先写入禁用清单（加入条目）
/// 6. 仅从 bundles 移除（不动 dependencies）并写回 manifest
///
/// 写入顺序保证：若步骤 6 失败，通过回滚步骤 5 使两文件恢复一致，
/// 避免插件从 bundles 移除却未记入禁用清单（否则启用会返回
/// `ENABLE_NOT_DISABLED`，用户无法通过正常流程恢复）。
pub(crate) fn disable_plugin_at(profile: &Path, id: &str) -> Result<(), String> {
    // 先做官方/核心包语义校验（优先级高于字符集校验）：官方包 id 含 `/`，
    // 必须先于 validate_id 拦截，否则会被字符集校验误判为 INVALID_ID。
    if is_core_package(id) {
        return Err(format!(
            "DISABLE_INTERNAL_PLUGIN: refusing to disable internal/official plugin {id}"
        ));
    }
    fs_guard::validate_id(id)?;
    let manifest_path = profile.join("package.json");
    let content =
        fs::read_to_string(&manifest_path).map_err(|e| format!("DISABLE_READ_MANIFEST: {e}"))?;
    let mut manifest: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("DISABLE_PARSE_MANIFEST: {e}"))?;
    if !is_in_dependencies(&manifest, id) {
        return Err(format!(
            "DISABLE_NOT_INSTALLED: plugin {id} is not installed"
        ));
    }
    // 先写禁用清单，确保 manifest 写入失败时可回滚该条目。
    let mut map = load_disabled(profile);
    map.insert(
        id.to_string(),
        DisabledEntry {
            disabled_at: now_seconds_string(),
            reason: "user".to_string(),
        },
    );
    save_disabled(profile, &map)?;
    remove_bundle(&mut manifest, id);
    let rendered = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("DISABLE_RENDER_MANIFEST: {e}"))?;
    if let Err(e) = fs::write(&manifest_path, format!("{rendered}\n")) {
        rollback_disable(profile, id);
        return Err(format!("DISABLE_WRITE_MANIFEST: {e}"));
    }
    Ok(())
}

/// 回滚启用前的禁用清单状态。
///
/// 当 manifest 写入失败时，把已移除的禁用条目加回，使两个持久化文件
/// 恢复一致（插件仍在禁用清单中，bundles 未记录），避免留下
/// 「已加回 bundles 但禁用清单仍缺条目」的不可恢复状态。
fn rollback_enable(profile: &Path, id: &str) {
    let mut map = load_disabled(profile);
    map.entry(id.to_string()).or_insert_with(|| DisabledEntry {
        disabled_at: now_seconds_string(),
        reason: "user".to_string(),
    });
    let _ = save_disabled(profile, &map);
}

/// 启用插件的纯逻辑（不依赖 AppHandle，便于单元测试）。
///
/// 1. `fs_guard::validate_id(id)`
/// 2. 读取 manifest
/// 3. 校验插件仍安装
/// 4. 校验插件处于禁用态：桌面禁用清单或 `cordis.patch.yml` 配置覆盖（二选一）
/// 5. 配置覆盖禁用时，**必须**显式传 `clear_config_override=true`（前端已确认）
///    才会移除该覆盖；否则返回 `ENABLE_CONFIG_OVERRIDE`——避免「声称启用成功、
///    运行期却仍被更高优先级配置覆盖禁用」的虚假成功（issue #399）
/// 6. 从桌面禁用清单移除条目
/// 7. 加回 bundles 并写回 manifest
///
/// 写入顺序保证：若最后一步失败，通过回滚使持久化文件恢复一致，
/// 避免插件加回 bundles 后禁用清单缺条目（否则再次启用会返回
/// `ENABLE_NOT_DISABLED`，用户无法通过正常流程恢复）。
pub(crate) fn enable_plugin_at(
    profile: &Path,
    id: &str,
    clear_config_override: bool,
) -> Result<(), String> {
    fs_guard::validate_id(id)?;
    let manifest_path = profile.join("package.json");
    let content =
        fs::read_to_string(&manifest_path).map_err(|e| format!("ENABLE_READ_MANIFEST: {e}"))?;
    let mut manifest: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("ENABLE_PARSE_MANIFEST: {e}"))?;
    if !is_in_dependencies(&manifest, id) {
        return Err(format!(
            "ENABLE_NOT_INSTALLED: plugin {id} is not installed"
        ));
    }
    let mut map = load_disabled(profile);
    let desktop_disabled = map.contains_key(id);
    let config_disabled = has_patch_disable(profile, id);
    if !desktop_disabled && !config_disabled {
        return Err(format!(
            "ENABLE_NOT_DISABLED: plugin {id} is not in the disabled list"
        ));
    }
    // 存在配置覆盖但未显式确认：拒绝并给出来源指引，让前端提示用户查看
    // `cordis.patch.yml`；绝不静默绕过高优先级覆盖。
    if config_disabled && !clear_config_override {
        return Err(format!(
            "ENABLE_CONFIG_OVERRIDE: plugin {id} is disabled by the cordis.patch.yml config override; confirm removing the override to enable"
        ));
    }
    // 确认后先移除配置覆盖（幂等，只摘该插件的禁用条目，其余配置保留），
    // 再清理桌面禁用清单，最后写回 manifest——任一步失败都保持可恢复状态。
    if config_disabled {
        strip_patch_disable(profile, id)?;
    }
    if desktop_disabled {
        map.remove(id);
        save_disabled(profile, &map)?;
    }
    add_to_bundles(&mut manifest, id);
    let rendered = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("ENABLE_RENDER_MANIFEST: {e}"))?;
    if let Err(e) = fs::write(&manifest_path, format!("{rendered}\n")) {
        rollback_enable(profile, id);
        return Err(format!("ENABLE_WRITE_MANIFEST: {e}"));
    }
    Ok(())
}

/// 禁用插件（AppHandle 入口）：获取 profile 目录 → 持有操作锁 → 执行纯逻辑 → 推送变更。
pub fn disable(app_handle: &AppHandle, id: &str) -> Result<(), String> {
    let profile = profile_dir(app_handle);
    let _guard = tauri::async_runtime::block_on(process::acquire_operation_lock());
    let result = disable_plugin_at(&profile, id);
    drop(_guard);
    watch::force_emit(app_handle);
    result
}

/// 启用插件（AppHandle 入口）：获取 profile 目录 → 持有操作锁 → 执行纯逻辑 → 推送变更。
///
/// `clear_config_override`：插件被 `cordis.patch.yml` 配置覆盖禁用时，是否
/// 移除该覆盖（需用户在前端明确确认后才为 true）。
pub fn enable(app_handle: &AppHandle, id: &str, clear_config_override: bool) -> Result<(), String> {
    let profile = profile_dir(app_handle);
    let _guard = tauri::async_runtime::block_on(process::acquire_operation_lock());
    let result = enable_plugin_at(&profile, id, clear_config_override);
    drop(_guard);
    watch::force_emit(app_handle);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造临时 profile 目录并写入 package.json 清单。
    fn build_profile(test_name: &str, id: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dsh-disable-test-{}-{}-{}",
            test_name,
            std::process::id(),
            id
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let manifest = serde_json::json!({
            "name": "dsh-profile-web",
            "private": true,
            "dependencies": {
                "dsh-better-sidebar": "1.0.0",
                "dshmarket": "2.0.0",
                "@deepseek-ai/dsh-base": "1.0.0"
            },
            "dsh": { "profile": { "bundles": ["dsh-better-sidebar", "dshmarket", "@deepseek-ai/dsh-base"] } }
        });
        fs::write(
            dir.join("package.json"),
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();
        dir
    }

    fn read_manifest(profile: &Path) -> serde_json::Value {
        let content = fs::read_to_string(profile.join("package.json")).unwrap();
        serde_json::from_str(&content).unwrap()
    }

    #[test]
    fn preserve_disabled_bundles_keeps_builtin_disabled_after_install() {
        let profile = build_profile("preserve-builtin", "builtin");
        let mut manifest = read_manifest(&profile);
        manifest["dependencies"]["dsh-tauri-pet"] = serde_json::json!("link:/bundled/pet");
        manifest["dsh"]["profile"]["bundles"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!("dsh-tauri-pet"));
        fs::write(
            profile.join("package.json"),
            serde_json::to_string(&manifest).unwrap(),
        )
        .unwrap();
        disable_plugin_at(&profile, "dsh-tauri-pet").unwrap();
        fs::write(
            profile.join("package.json"),
            serde_json::to_string(&manifest).unwrap(),
        )
        .unwrap();
        preserve_disabled_bundles(&profile).unwrap();
        let preserved = read_manifest(&profile);
        assert_eq!(preserved["dependencies"], manifest["dependencies"]);
        assert_eq!(
            preserved["dsh"]["profile"]["bundles"],
            serde_json::json!(["dsh-better-sidebar", "dshmarket", "@deepseek-ai/dsh-base"])
        );
        assert!(load_disabled(&profile).contains_key("dsh-tauri-pet"));
        enable_plugin_at(&profile, "dsh-tauri-pet", false).unwrap();
        assert!(!load_disabled(&profile).contains_key("dsh-tauri-pet"));
        assert!(read_manifest(&profile)["dsh"]["profile"]["bundles"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("dsh-tauri-pet")));
        fs::remove_dir_all(profile).unwrap();
    }

    #[test]
    fn disable_removes_from_bundles_only() {
        let profile = build_profile("bundles-only", "a");
        disable_plugin_at(&profile, "dsh-better-sidebar").unwrap();

        let manifest = read_manifest(&profile);
        // dependencies 不变
        assert!(manifest["dependencies"]["dsh-better-sidebar"].is_string());
        assert!(manifest["dependencies"]["dshmarket"].is_string());
        // bundles 中已移除
        let bundles = manifest["dsh"]["profile"]["bundles"].as_array().unwrap();
        assert!(!bundles
            .iter()
            .any(|b| b.as_str() == Some("dsh-better-sidebar")));
        assert!(bundles.iter().any(|b| b.as_str() == Some("dshmarket")));

        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn disable_writes_disabled_json() {
        let profile = build_profile("disabled-json", "b");
        disable_plugin_at(&profile, "dsh-better-sidebar").unwrap();

        let map = load_disabled(&profile);
        let entry = map
            .get("dsh-better-sidebar")
            .expect("disabled entry exists");
        assert_eq!(entry.reason, "user");
        assert!(!entry.disabled_at.is_empty());
        // 时间戳是纯数字字符串
        assert!(entry.disabled_at.parse::<u64>().is_ok());

        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn enable_restores_to_bundles() {
        let profile = build_profile("enable-restore", "c");
        disable_plugin_at(&profile, "dsh-better-sidebar").unwrap();
        enable_plugin_at(&profile, "dsh-better-sidebar", false).unwrap();

        let manifest = read_manifest(&profile);
        let bundles = manifest["dsh"]["profile"]["bundles"].as_array().unwrap();
        assert!(bundles
            .iter()
            .any(|b| b.as_str() == Some("dsh-better-sidebar")));

        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn enable_removes_from_disabled_json() {
        let profile = build_profile("enable-rm-json", "d");
        disable_plugin_at(&profile, "dsh-better-sidebar").unwrap();
        enable_plugin_at(&profile, "dsh-better-sidebar", false).unwrap();

        let map = load_disabled(&profile);
        assert!(!map.contains_key("dsh-better-sidebar"));

        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn disable_internal_plugin_is_rejected() {
        let profile = build_profile("internal-reject", "e");
        let err = disable_plugin_at(&profile, "@deepseek-ai/dsh-base").unwrap_err();
        assert!(err.contains("DISABLE_INTERNAL_PLUGIN"));

        // manifest 未被修改
        let manifest = read_manifest(&profile);
        let bundles = manifest["dsh"]["profile"]["bundles"].as_array().unwrap();
        assert_eq!(bundles.len(), 3);

        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn disable_not_installed_is_rejected() {
        let profile = build_profile("not-installed", "f");
        let err = disable_plugin_at(&profile, "dsh-not-exist").unwrap_err();
        assert!(err.contains("DISABLE_NOT_INSTALLED"));

        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn enable_not_disabled_is_rejected() {
        let profile = build_profile("not-disabled", "g");
        // 未禁用就启用 → 拒绝
        let err = enable_plugin_at(&profile, "dsh-better-sidebar", false).unwrap_err();
        assert!(err.contains("ENABLE_NOT_DISABLED"));

        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn round_trip_preserves_other_bundles() {
        let profile = build_profile("round-trip", "h");
        disable_plugin_at(&profile, "dsh-better-sidebar").unwrap();
        enable_plugin_at(&profile, "dsh-better-sidebar", false).unwrap();

        let manifest = read_manifest(&profile);
        let bundles = manifest["dsh"]["profile"]["bundles"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|b| b.as_str())
            .collect::<Vec<_>>();
        // 恢复原始顺序可能不同，但内容一致
        assert_eq!(bundles.len(), 3);
        assert!(bundles.contains(&"dsh-better-sidebar"));
        assert!(bundles.contains(&"dshmarket"));
        assert!(bundles.contains(&"@deepseek-ai/dsh-base"));
        // dependencies 完全不变
        assert!(manifest["dependencies"]["dsh-better-sidebar"].is_string());
        assert!(manifest["dependencies"]["dshmarket"].is_string());
        assert!(manifest["dependencies"]["@deepseek-ai/dsh-base"].is_string());

        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn disabled_list_persists_to_disk() {
        let profile = build_profile("persist", "i");
        disable_plugin_at(&profile, "dsh-better-sidebar").unwrap();

        // 重新从磁盘读取（不依赖内存）
        let map = load_disabled(&profile);
        assert!(map.contains_key("dsh-better-sidebar"));

        // 文件确实存在且可解析
        let path = disabled_path(&profile);
        assert!(path.exists());
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("dsh-better-sidebar"));
        assert!(content.contains("\"disabledAt\""));
        assert!(content.contains("\"reason\""));

        let _ = fs::remove_dir_all(&profile);
    }

    /// 写入配置覆盖禁用条目的测试用 patch 文件。
    fn write_patch(profile: &Path, content: &str) {
        fs::write(profile.join("cordis.patch.yml"), content).unwrap();
    }

    /// `load_patch_disabled` 只收集带真值 `disabled` 字段的条目目标；
    /// `disabled: false`、无 disabled 字段、非映射条目都不算禁用。
    #[test]
    fn load_patch_disabled_collects_only_true_disables() {
        let profile = build_profile("patch-collect", "j");
        write_patch(
            &profile,
            "- id: dshmarket\n  disabled: true\n- id: dsh-better-sidebar\n  disabled: false\n- id: dsh-tauri-pet\n  config: 1\n- plain-string\n",
        );
        let targets = load_patch_disabled(&profile);
        assert!(targets.contains("dshmarket"));
        assert!(!targets.contains("dsh-better-sidebar"));
        assert!(!targets.contains("dsh-tauri-pet"));

        // 缺文件/非法 YAML/非数组 → 空集
        assert!(load_patch_disabled(&std::env::temp_dir()).is_empty());
        let broken = build_profile("patch-broken", "k");
        write_patch(&broken, "not: [valid");
        assert!(load_patch_disabled(&broken).is_empty());
        fs::remove_dir_all(&broken).ok();

        fs::remove_dir_all(&profile).ok();
    }

    /// 配置覆盖禁用但未显式确认 → ENABLE_CONFIG_OVERRIDE（绝不静默绕过）。
    #[test]
    fn enable_without_override_confirmation_is_rejected() {
        let profile = build_profile("patch-reject", "l");
        write_patch(&profile, "- id: dsh-better-sidebar\n  disabled: true\n");
        let err = enable_plugin_at(&profile, "dsh-better-sidebar", false).unwrap_err();
        assert!(err.contains("ENABLE_CONFIG_OVERRIDE"));

        // 覆盖条目原样保留
        let content = fs::read_to_string(profile.join("cordis.patch.yml")).unwrap();
        assert!(content.contains("disabled: true"));

        fs::remove_dir_all(&profile).ok();
    }

    /// 确认后启用：仅移除目标插件的禁用覆盖、清桌面记录、加回 bundles，
    /// 其它插件的 patch 条目原样保留。
    #[test]
    fn enable_with_override_confirmation_strips_only_target() {
        let profile = build_profile("patch-strip", "m");
        write_patch(
            &profile,
            "- id: dsh-better-sidebar\n  disabled: true\n- id: dshmarket\n  disabled: true\n- id: dsh-tauri-pet\n  foo: bar\n",
        );
        enable_plugin_at(&profile, "dsh-better-sidebar", true).unwrap();

        let content = fs::read_to_string(profile.join("cordis.patch.yml")).unwrap();
        assert!(!content.contains("dsh-better-sidebar"));
        assert!(content.contains("dshmarket"));
        assert!(content.contains("dsh-tauri-pet"));
        assert!(content.contains("foo: bar"));
        // 其余禁用条目仍是禁用态
        let targets = load_patch_disabled(&profile);
        assert!(targets.contains("dshmarket"));
        assert!(!targets.contains("dsh-better-sidebar"));

        // bundles 已加回
        let manifest = read_manifest(&profile);
        let bundles = manifest["dsh"]["profile"]["bundles"].as_array().unwrap();
        assert!(bundles
            .iter()
            .any(|b| b.as_str() == Some("dsh-better-sidebar")));

        fs::remove_dir_all(&profile).ok();
    }

    #[test]
    fn strip_patch_disable_preserves_non_mapping_and_false_or_nested_targets() {
        let profile = build_profile("patch-boundaries", "p");
        write_patch(
            &profile,
            "- dsh-better-sidebar\n- [dsh-better-sidebar]\n- id: other\n  config: {id: dsh-better-sidebar}\n  disabled: true\n- id: dsh-better-sidebar\n  disabled: false\n- dsh-better-sidebar: alias\n  disabled: true\n",
        );
        assert!(strip_patch_disable(&profile, "dsh-better-sidebar").unwrap());
        let patch = profile.join("cordis.patch.yml");
        let content = fs::read_to_string(&patch).unwrap();
        let doc: serde_yaml::Value = serde_yaml::from_str(&content).unwrap();
        let expected: serde_yaml::Value = serde_yaml::from_str(
            "- dsh-better-sidebar\n- [dsh-better-sidebar]\n- id: other\n  config: {id: dsh-better-sidebar}\n  disabled: true\n- id: dsh-better-sidebar\n  disabled: false\n- dsh-better-sidebar: alias\n",
        )
        .unwrap();
        assert_eq!(doc, expected);
        assert!(!strip_patch_disable(&profile, "dsh-better-sidebar").unwrap());
        assert_eq!(fs::read_to_string(&patch).unwrap(), content);
        fs::remove_dir_all(&profile).unwrap();
    }

    /// 带其它配置的禁用条目：只摘 `disabled` 键，其余配置保留（不删除无关配置）。
    #[test]
    fn strip_patch_disable_keeps_other_config_keys() {
        let profile = build_profile("patch-keep", "n");
        write_patch(
            &profile,
            "- id: dsh-better-sidebar\n  disabled: true\n  logLevel: debug\n",
        );
        enable_plugin_at(&profile, "dsh-better-sidebar", true).unwrap();

        let content = fs::read_to_string(profile.join("cordis.patch.yml")).unwrap();
        assert!(!content.contains("disabled"));
        assert!(content.contains("logLevel: debug"));
        assert!(content.contains("dsh-better-sidebar"));

        fs::remove_dir_all(&profile).ok();
    }

    /// 别名匹配：patch 条目的 id 用包内 `name`（非依赖键）时同样命中。
    #[test]
    fn patch_disable_matches_package_json_name_alias() {
        let profile = build_profile("patch-alias", "o");
        // 依赖键 dsh-better-sidebar，但包内 name 为 better-sidebar（loader 别名形态）
        let pkg_dir = profile.join("node_modules").join("dsh-better-sidebar");
        fs::create_dir_all(&pkg_dir).unwrap();
        fs::write(
            pkg_dir.join("package.json"),
            r#"{"name":"better-sidebar","version":"1.0.0"}"#,
        )
        .unwrap();
        write_patch(&profile, "- id: better-sidebar\n  disabled: true\n");

        assert!(has_patch_disable(&profile, "dsh-better-sidebar"));

        // 确认后启用：别名条目被移除
        enable_plugin_at(&profile, "dsh-better-sidebar", true).unwrap();
        let content = fs::read_to_string(profile.join("cordis.patch.yml")).unwrap();
        assert!(!content.contains("better-sidebar"));

        fs::remove_dir_all(&profile).ok();
    }

    /// 官方页面写入 `disabled: false` 后，台账条目必须在启动自愈时被清理，
    /// 否则刚启用的插件会被重新删出 bundles、下次启动又读成关闭。
    #[test]
    fn preserve_clears_ledger_when_patch_declares_enabled() {
        let profile = build_profile("patch-enabled", "clears");
        disable_plugin_at(&profile, "dsh-better-sidebar").unwrap();
        assert!(load_disabled(&profile).contains_key("dsh-better-sidebar"));
        write_patch(&profile, "- id: dsh-better-sidebar\n  disabled: false\n");
        preserve_disabled_bundles(&profile).unwrap();
        assert!(
            !load_disabled(&profile).contains_key("dsh-better-sidebar"),
            "patch 的显式启用必须清掉桌面台账"
        );

        fs::remove_dir_all(&profile).ok();
    }

    /// 台账仍在、bundles 已被上游加回时，启用声明要让它留在 bundles 里。
    #[test]
    fn preserve_keeps_bundle_when_patch_declares_enabled() {
        let profile = build_profile("patch-enabled-bundle", "keeps");
        disable_plugin_at(&profile, "dsh-better-sidebar").unwrap();
        let mut manifest = read_manifest(&profile);
        manifest["dsh"]["profile"]["bundles"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!("dsh-better-sidebar"));
        fs::write(
            profile.join("package.json"),
            serde_json::to_string(&manifest).unwrap(),
        )
        .unwrap();
        write_patch(&profile, "- id: dsh-better-sidebar\n  disabled: false\n");
        preserve_disabled_bundles(&profile).unwrap();
        assert!(read_manifest(&profile)["dsh"]["profile"]["bundles"]
            .as_array()
            .unwrap()
            .iter()
            .any(|b| b.as_str() == Some("dsh-better-sidebar")));

        fs::remove_dir_all(&profile).ok();
    }

    /// 只写了 `disabled: true`（或压根没写）时，台账是唯一凭证，必须照旧生效。
    #[test]
    fn preserve_respects_ledger_when_patch_stays_silent_or_disabled() {
        for yaml in [
            "- id: dsh-better-sidebar\n  disabled: true\n",
            "- id: dsh-better-sidebar\n  name: dsh-better-sidebar\n",
            "- insert:\n    - id: mcp-other\n",
        ] {
            let profile = build_profile("patch-silent", "respects");
            disable_plugin_at(&profile, "dsh-better-sidebar").unwrap();
            write_patch(&profile, yaml);
            preserve_disabled_bundles(&profile).unwrap();
            assert!(
                load_disabled(&profile).contains_key("dsh-better-sidebar"),
                "{yaml} 不得被当成启用声明"
            );

            fs::remove_dir_all(&profile).ok();
        }
    }

    /// 包名与 loader 入口 id 不同时，启用声明按包内 name 命中。
    #[test]
    fn preserve_matches_enabled_by_package_json_name_alias() {
        let profile = build_profile("patch-enabled-alias", "alias");
        let pkg_dir = profile.join("node_modules").join("dsh-better-sidebar");
        fs::create_dir_all(&pkg_dir).unwrap();
        fs::write(
            pkg_dir.join("package.json"),
            r#"{"name":"better-sidebar","version":"1.0.0"}"#,
        )
        .unwrap();
        disable_plugin_at(&profile, "dsh-better-sidebar").unwrap();
        write_patch(&profile, "- id: better-sidebar\n  disabled: false\n");
        preserve_disabled_bundles(&profile).unwrap();
        assert!(
            !load_disabled(&profile).contains_key("dsh-better-sidebar"),
            "别名 id 的启用声明同样要清台账"
        );

        fs::remove_dir_all(&profile).ok();
    }

    /// 反向：显式启用的是别的插件，不得误清。
    #[test]
    fn preserve_does_not_clear_ledger_for_other_plugins() {
        let profile = build_profile("patch-enabled-other", "other");
        disable_plugin_at(&profile, "dshmarket").unwrap();
        disable_plugin_at(&profile, "dsh-better-sidebar").unwrap();
        write_patch(&profile, "- id: dsh-better-sidebar\n  disabled: false\n");
        preserve_disabled_bundles(&profile).unwrap();
        let map = load_disabled(&profile);
        assert!(!map.contains_key("dsh-better-sidebar"));
        assert!(map.contains_key("dshmarket"), "别的插件台账条目不得被误清");

        fs::remove_dir_all(&profile).ok();
    }
}
