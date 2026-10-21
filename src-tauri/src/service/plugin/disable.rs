//! 插件禁用/启用：改写 profile 的 `cordis.patch.yml` 顶层覆盖项的 `disabled` 字段。
//!
//! 与官方 Plugins 页 / dshmarket 共用同一处状态（patch 层），桌面壳不再维护第二份
//! 记录。禁用只写 patch 覆盖（保留 node_modules 包体与 bundles 选择）；启用撤掉覆盖，
//! 并在插件是被官方包级开关移出 `dsh.profile.bundles` 的 bundle 包时补回 bundles。
//! 覆盖项必须用 loader 的 entry id（官方 `patchId`），而不是 npm 包名：两者经常
//! 不同（`dshmarket` → `dsh-market`），按包名写的覆盖命中不了任何条目，禁用看起来
//! 成功、运行时却照旧加载。

use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

use tauri::AppHandle;

use crate::service::plugin::installed::profile_dir;
use crate::service::plugin::recovery::{is_core_package, is_package_name, patch_entry_targets};
use crate::service::plugin::{parse_patch_layer, process, render_patch_layer, watch};

/// profile 层的 patch 覆盖文件。
const PATCH_FILE: &str = "cordis.patch.yml";
/// 插件开关在覆盖项里的字段名（官方插件页/dshmarket 同款）。
const DISABLED_KEY: &str = "disabled";

/// 返回 patch 中「显式禁用」条目的目标名集合。
///
/// 匹配口径与 `recovery::patch_entry_targets` 一致：把条目的 `id` 与任意字符串键/值
/// 都收进集合，兼容 loader 入口 id 与 npm 包名不一致的别名场景。文件缺失或无法解析
/// 为顶层数组时按空集处理。
pub(crate) fn load_patch_disabled(profile: &Path) -> HashSet<String> {
    let Ok(content) = fs::read_to_string(profile.join(PATCH_FILE)) else {
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

/// 覆盖项是否带「禁用」语义：兼容布尔 `true`、非零数字、字符串 true/1/yes/on。
fn patch_entry_disabled(map: &serde_yaml::Mapping) -> bool {
    let Some(value) = map.get(serde_yaml::Value::String(DISABLED_KEY.to_string())) else {
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

/// 条目模块名是否属于该插件（同时覆盖 `dsh-ops/shell` 这类子路径导出）。
fn module_targets(module: &str, names: &[String]) -> bool {
    names.iter().any(|name| {
        module == name
            || module
                .strip_prefix(name.as_str())
                .is_some_and(|rest| rest.starts_with('/'))
    })
}

/// 插件包声明的 bundle patch 文件（`dsh.bundle.patch`），限定在包目录内。
fn bundle_patch_file(profile: &Path, id: &str) -> Option<PathBuf> {
    let package_dir = profile.join("node_modules").join(id);
    let meta: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(package_dir.join("package.json")).ok()?).ok()?;
    let relative = Path::new(meta.get("dsh")?.get("bundle")?.get("patch")?.as_str()?);
    let escapes = relative.is_absolute()
        || relative.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        });
    (!escapes).then(|| package_dir.join(relative))
}

fn push_entry_id(map: &serde_yaml::Mapping, names: &[String], ids: &mut Vec<String>) {
    let Some(id) = map.get("id").and_then(|value| value.as_str()) else {
        return;
    };
    let Some(module) = map.get("name").and_then(|value| value.as_str()) else {
        return;
    };
    if module_targets(module, names) && !ids.iter().any(|existing| existing == id) {
        ids.push(id.to_string());
    }
}

/// 从一层补丁文档里收集目标插件的 loader entry id：顶层覆盖项与 `insert` 列表。
fn collect_entry_ids(doc: &serde_yaml::Value, names: &[String], ids: &mut Vec<String>) {
    let Some(entries) = doc.as_sequence() else {
        return;
    };
    for entry in entries {
        let Some(map) = entry.as_mapping() else {
            continue;
        };
        push_entry_id(map, names, ids);
        let Some(serde_yaml::Value::Sequence(inserted)) = map.get("insert") else {
            continue;
        };
        for item in inserted {
            if let Some(map) = item.as_mapping() {
                push_entry_id(map, names, ids);
            }
        }
    }
}

/// 插件在 loader 组合树里的条目 id（官方 `PluginInfo.patchId`）。
///
/// 来源是插件自带的 bundle patch 与 profile patch 里手工插入的同模块条目；只收
/// `name` 等于包名或以 `包名/` 开头的条目，避免把顺带插入的其它模块算进来
/// （`dsh-tauri-pet` 还会插入 skill-filesystem）。
fn plugin_entry_ids(profile: &Path, id: &str) -> Vec<String> {
    let names = plugin_target_names(profile, id);
    let mut ids = Vec::new();
    for path in [
        bundle_patch_file(profile, id),
        Some(profile.join(PATCH_FILE)),
    ]
    .into_iter()
    .flatten()
    {
        let Some(content) = fs::read_to_string(path).ok() else {
            continue;
        };
        let Ok(doc) = serde_yaml::from_str::<serde_yaml::Value>(&content) else {
            continue;
        };
        collect_entry_ids(&doc, &names, &mut ids);
    }
    ids
}

/// 插件是否被 profile 的 patch 覆盖完全禁用。
///
/// 一个包可能对应多个 loader 条目（`dsh-ops/*`）：只有全部条目都被禁用才算
/// 「已禁用」，否则面板会给出启用入口，把仍然在跑的条目误当成整体已关闭。
pub(crate) fn has_patch_disable(profile: &Path, id: &str) -> bool {
    let disabled = load_patch_disabled(profile);
    if disabled.is_empty() {
        return false;
    }
    let entry_ids = plugin_entry_ids(profile, id);
    if !entry_ids.is_empty() {
        return entry_ids.iter().all(|entry_id| disabled.contains(entry_id));
    }
    plugin_target_names(profile, id)
        .iter()
        .any(|name| disabled.contains(name))
}

/// 在 patch 里为目标插件写入 `disabled: true`。
///
/// 与官方插件开关同款语义：逐个 loader entry id 命中最后一条覆盖项就改它的
/// `disabled`（条目里其它配置原样保留），没有覆盖项则追加 `{id, disabled: true}`。
/// 已知条目 id 时不再按 npm 包名追加：官方 loader 只按 entry id 命中，包名覆盖
/// 等于空写。已是禁用态时返回 `Ok(false)` 且不写盘。
pub(crate) fn add_patch_disable(profile: &Path, id: &str) -> Result<bool, String> {
    let path = profile.join(PATCH_FILE);
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("DISABLE_PATCH_READ_FAILED: {e}")),
    };
    let mut entries = match content.trim() {
        "" => Vec::new(),
        raw => {
            match parse_patch_layer(raw).map_err(|e| format!("DISABLE_PATCH_PARSE_FAILED: {e}"))? {
                serde_yaml::Value::Sequence(seq) => seq,
                serde_yaml::Value::Null => Vec::new(),
                _ => {
                    return Err(
                        "DISABLE_PATCH_UNSUPPORTED_SHAPE: cordis.patch.yml top level is not a list"
                            .to_string(),
                    )
                }
            }
        }
    };
    let names = plugin_target_names(profile, id);
    let disabled_key = || serde_yaml::Value::String(DISABLED_KEY.to_string());
    let disable_entry = |entry_id: &str| {
        let mut map = serde_yaml::Mapping::new();
        map.insert(
            serde_yaml::Value::String("id".to_string()),
            serde_yaml::Value::String(entry_id.to_string()),
        );
        map.insert(disabled_key(), serde_yaml::Value::Bool(true));
        serde_yaml::Value::Mapping(map)
    };
    let mut changed = false;
    let entry_ids = plugin_entry_ids(profile, id);
    if entry_ids.is_empty() {
        let mut hit: Option<&mut serde_yaml::Mapping> = None;
        for entry in entries.iter_mut().rev() {
            if !names.iter().any(|name| patch_entry_targets(entry, name)) {
                continue;
            }
            if let serde_yaml::Value::Mapping(map) = entry {
                hit = Some(map);
                break;
            }
        }
        match hit {
            Some(map) => {
                if !patch_entry_disabled(map) {
                    map.insert(disabled_key(), serde_yaml::Value::Bool(true));
                    changed = true;
                }
            }
            None => {
                entries.push(disable_entry(id));
                changed = true;
            }
        }
    } else {
        for entry_id in entry_ids {
            let hit = entries.iter_mut().rev().find_map(|entry| {
                let map = entry.as_mapping_mut()?;
                let same_id = map.get("id").and_then(|value| value.as_str()) == Some(&entry_id);
                let same_module = map
                    .get("name")
                    .and_then(|value| value.as_str())
                    .is_none_or(|name| module_targets(name, &names));
                (same_id && same_module && !map.contains_key("insert")).then_some(map)
            });
            match hit {
                Some(map) => {
                    if !patch_entry_disabled(map) {
                        map.insert(disabled_key(), serde_yaml::Value::Bool(true));
                        changed = true;
                    }
                }
                None => {
                    entries.push(disable_entry(&entry_id));
                    changed = true;
                }
            }
        }
    }
    if !changed {
        return Ok(false);
    }
    let rendered = render_patch_layer(&serde_yaml::Value::Sequence(entries))
        .map_err(|e| format!("DISABLE_PATCH_RENDER_FAILED: {e}"))?;
    super::atomic_write::write_patch_layer_atomically(&path, &rendered)
        .map_err(|e| format!("DISABLE_PATCH_WRITE_FAILED: {e}"))?;
    log::info!("Disabled plugin {id} via cordis.patch.yml override");
    Ok(true)
}

/// 从 patch 移除目标插件的显式禁用覆盖，其余配置原样保留（issue #399）：
/// 纯禁用条目（仅 `id` + `disabled`）整条移除，带其它配置的条目只摘 `disabled` 键。
///
/// 命中口径同时包含 loader entry id 与包名别名，顺带清掉旧版按包名写下的无效覆盖。
/// 幂等：无 patch 文件 / 无法解析 / 无目标禁用条目时返回 `Ok(false)` 且不写盘。
pub(crate) fn strip_patch_disable(profile: &Path, id: &str) -> Result<bool, String> {
    let path = profile.join(PATCH_FILE);
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("ENABLE_PATCH_READ_FAILED: {error}")),
    };
    let mut doc =
        parse_patch_layer(&content).map_err(|e| format!("ENABLE_PATCH_PARSE_FAILED: {e}"))?;
    let Some(entries) = doc.as_sequence_mut() else {
        return Ok(false);
    };
    let names = plugin_target_names(profile, id);
    let entry_ids = plugin_entry_ids(profile, id);
    let mut changed = false;
    let mut kept: Vec<serde_yaml::Value> = Vec::with_capacity(entries.len());
    for entry in entries.drain(..) {
        let Some(mut map) = entry.as_mapping().cloned() else {
            kept.push(entry);
            continue;
        };
        let targeted = entry_ids
            .iter()
            .any(|entry_id| map.get("id").and_then(|value| value.as_str()) == Some(entry_id))
            || names.iter().any(|name| patch_entry_targets(&entry, name));
        if !targeted || !patch_entry_disabled(&map) {
            kept.push(entry);
            continue;
        }
        changed = true;
        map.remove(serde_yaml::Value::String(DISABLED_KEY.to_string()));
        let keeps_other_config = map.iter().any(|(k, _)| k.as_str() != Some("id"));
        if keeps_other_config {
            kept.push(serde_yaml::Value::Mapping(map));
        }
    }
    if !changed {
        return Ok(false);
    }
    let rendered = render_patch_layer(&serde_yaml::Value::Sequence(kept))
        .map_err(|e| format!("ENABLE_PATCH_RENDER_FAILED: {e}"))?;
    super::atomic_write::write_patch_layer_atomically(&path, &rendered)
        .map_err(|e| format!("ENABLE_PATCH_WRITE_FAILED: {e}"))?;
    log::info!("Stripped cordis.patch.yml disable override for plugin {id}");
    Ok(true)
}

/// 检查插件是否已安装（dependencies 中存在）。
fn is_in_dependencies(manifest: &serde_json::Value, id: &str) -> bool {
    manifest
        .get("dependencies")
        .and_then(|d| d.as_object())
        .map(|d| d.contains_key(id))
        .unwrap_or(false)
}

/// 读取并解析 profile 的 package.json。
fn read_manifest(profile: &Path, prefix: &str) -> Result<serde_json::Value, String> {
    let content = fs::read_to_string(profile.join("package.json"))
        .map_err(|e| format!("{prefix}_READ_MANIFEST: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("{prefix}_PARSE_MANIFEST: {e}"))
}

/// 插件 id 校验：允许 scoped 包名（`@scope/pkg`），同时挡住路径分隔符与穿越。
///
/// `fs_guard::validate_id` 会拒绝 `/`，scoped 插件（如 `@wenaixi/dsh-ponytail`）
/// 按它校验会永远无法禁用/启用。
fn validate_plugin_id(id: &str) -> Result<(), String> {
    is_package_name(id)
        .then_some(())
        .ok_or_else(|| format!("INVALID_ID: plugin id is not a package name: {id}"))
}

/// 禁用插件的纯逻辑（不依赖 AppHandle，便于单元测试）。
///
/// 只写 patch 覆盖：不再改 `dsh.profile.bundles`（组合包开关归官方插件页），也不写任何
/// 桌面侧清单。
pub(crate) fn disable_plugin_at(profile: &Path, id: &str) -> Result<(), String> {
    if is_core_package(id) {
        return Err(format!(
            "DISABLE_INTERNAL_PLUGIN: refusing to disable internal/official plugin {id}"
        ));
    }
    validate_plugin_id(id)?;
    let manifest = read_manifest(profile, "DISABLE")?;
    if !is_in_dependencies(&manifest, id) {
        return Err(format!(
            "DISABLE_NOT_INSTALLED: plugin {id} is not installed"
        ));
    }
    add_patch_disable(profile, id)?;
    Ok(())
}

/// 插件包是否声明了 `dsh.bundle`（只有 bundle 包才会被官方包级开关移出 bundles）。
fn declares_bundle(profile: &Path, id: &str) -> bool {
    let Ok(content) =
        fs::read_to_string(profile.join("node_modules").join(id).join("package.json"))
    else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(&content)
        .ok()
        .and_then(|meta| meta.get("dsh").and_then(|dsh| dsh.get("bundle")).cloned())
        .is_some()
}

/// 把插件补回 profile 的 `dsh.profile.bundles`（官方包级禁用的反向操作）。
fn add_bundle(profile: &Path, id: &str, manifest: &mut serde_json::Value) -> Result<bool, String> {
    let Some(bundles) = manifest
        .pointer_mut("/dsh/profile/bundles")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return Err("ENABLE_BUNDLES_UNSUPPORTED: dsh.profile.bundles is not a list".to_string());
    };
    if bundles.iter().any(|bundle| bundle.as_str() == Some(id)) {
        return Ok(false);
    }
    bundles.push(serde_json::Value::String(id.to_string()));
    let rendered = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("ENABLE_MANIFEST_RENDER_FAILED: {e}"))?;
    super::atomic_write::write_file_atomically(
        &profile.join("package.json"),
        &format!("{rendered}\n"),
    )
    .map_err(|e| format!("ENABLE_MANIFEST_WRITE_FAILED: {e}"))?;
    Ok(true)
}

/// 插件是否在 `dsh.profile.bundles` 里；bundle 列表缺失/非数组时返回 `None`。
fn bundles_include(manifest: &serde_json::Value, id: &str) -> Option<bool> {
    manifest
        .pointer("/dsh/profile/bundles")
        .and_then(serde_json::Value::as_array)
        .map(|bundles| bundles.iter().any(|bundle| bundle.as_str() == Some(id)))
}

/// 启用插件的纯逻辑（不依赖 AppHandle，便于单元测试）：撤掉 patch 禁用覆盖；
/// 若插件是被官方包级开关移出 `dsh.profile.bundles` 的 bundle 包，补回 bundles。
///
/// 清单读-改-写持 `dsh-atomic-write` 的跨进程写锁（官方插件管理器同款），并在锁内
/// 重新读取，避免把并发切换的结果覆盖回旧快照。先补 bundles 再撤 patch：任一步失败
/// 都停在「仍禁用」状态，用户可原样重试。
pub(crate) fn enable_plugin_at(profile: &Path, id: &str) -> Result<(), String> {
    validate_plugin_id(id)?;
    let manifest = read_manifest(profile, "ENABLE")?;
    if !is_in_dependencies(&manifest, id) {
        return Err(format!(
            "ENABLE_NOT_INSTALLED: plugin {id} is not installed"
        ));
    }
    let restored = match bundles_include(&manifest, id) {
        Some(false) if declares_bundle(profile, id) => {
            let _lock = process::acquire_plugin_writer_lock(profile)?;
            let mut locked = read_manifest(profile, "ENABLE")?;
            if is_in_dependencies(&locked, id) && bundles_include(&locked, id) == Some(false) {
                add_bundle(profile, id, &mut locked)?
            } else {
                false
            }
        }
        _ => false,
    };
    let stripped = strip_patch_disable(profile, id)?;
    if !restored && !stripped {
        return Err(format!(
            "ENABLE_NOT_DISABLED: plugin {id} has no disable override in cordis.patch.yml"
        ));
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
pub fn enable(app_handle: &AppHandle, id: &str) -> Result<(), String> {
    let profile = profile_dir(app_handle);
    let _guard = tauri::async_runtime::block_on(process::acquire_operation_lock());
    let result = enable_plugin_at(&profile, id);
    drop(_guard);
    watch::force_emit(app_handle);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// 构造临时 profile 目录并写入 package.json 清单（不含 patch 文件）。
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

    fn read_patch(profile: &Path) -> String {
        fs::read_to_string(profile.join(PATCH_FILE)).unwrap_or_default()
    }

    fn write_patch(profile: &Path, content: &str) {
        fs::write(profile.join(PATCH_FILE), content).unwrap();
    }

    /// 构造带真实 bundle patch 的 profile：`(依赖键, 包内 name, bundle patch)`。
    fn build_bundle_profile(test_name: &str, packages: &[(&str, &str, &str)]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dsh-disable-bundle-{}-{}",
            test_name,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        let mut dependencies = serde_json::Map::new();
        let mut bundles = Vec::new();
        for (id, name, patch) in packages {
            dependencies.insert((*id).to_string(), serde_json::json!("1.0.0"));
            bundles.push(serde_json::json!(id));
            let package_dir = dir.join("node_modules").join(id);
            fs::create_dir_all(&package_dir).unwrap();
            fs::write(
                package_dir.join("package.json"),
                serde_json::json!({
                    "name": name,
                    "version": "1.0.0",
                    "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
                })
                .to_string(),
            )
            .unwrap();
            fs::write(package_dir.join("cordis.patch.yml"), patch).unwrap();
        }
        let manifest = serde_json::json!({
            "name": "dsh-profile-web",
            "private": true,
            "dependencies": dependencies,
            "dsh": { "profile": { "bundles": bundles } }
        });
        fs::write(
            dir.join("package.json"),
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();
        dir
    }

    fn patch_ids(profile: &Path) -> Vec<String> {
        read_patch(profile)
            .lines()
            .filter_map(|line| line.trim().strip_prefix("- id: "))
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn disable_writes_patch_override_and_keeps_bundles() {
        let profile = build_profile("write-patch", "a");
        let before = fs::read_to_string(profile.join("package.json")).unwrap();
        disable_plugin_at(&profile, "dsh-better-sidebar").unwrap();

        assert!(has_patch_disable(&profile, "dsh-better-sidebar"));
        assert!(read_patch(&profile).contains("disabled: true"));
        // 组合包选择与依赖一律不动
        assert_eq!(
            fs::read_to_string(profile.join("package.json")).unwrap(),
            before
        );

        // 重复禁用：幂等，第二次不再写盘
        assert!(!add_patch_disable(&profile, "dsh-better-sidebar").unwrap());

        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn disable_rejects_non_sequence_patch_without_overwriting() {
        let profile = build_profile("unsupported-shape", "m");
        for original in [
            "logLevel: debug\n",
            "{}\n",
            "existing patch content\n",
            "true\n",
            "42\n",
            "!custom {config: keep}\n",
        ] {
            write_patch(&profile, original);
            let result = disable_plugin_at(&profile, "dsh-better-sidebar");
            assert_eq!(
                fs::read(profile.join(PATCH_FILE)).unwrap(),
                original.as_bytes(),
                "patch was overwritten for {original:?}"
            );
            assert_eq!(
                result.unwrap_err(),
                "DISABLE_PATCH_UNSUPPORTED_SHAPE: cordis.patch.yml top level is not a list"
            );
        }
        fs::remove_dir_all(&profile).unwrap();
    }

    #[test]
    fn disable_rejects_unreadable_patch_without_overwriting() {
        let profile = build_profile("unreadable-patch", "o");
        let original = [0xff, 0xfe];
        fs::write(profile.join(PATCH_FILE), original).unwrap();
        let result = disable_plugin_at(&profile, "dsh-better-sidebar");
        assert_eq!(fs::read(profile.join(PATCH_FILE)).unwrap(), original);
        assert!(result
            .unwrap_err()
            .starts_with("DISABLE_PATCH_READ_FAILED:"));
        fs::remove_dir_all(&profile).unwrap();
    }

    #[test]
    fn disable_initializes_empty_patch_documents() {
        let profile = build_profile("empty-documents", "n");
        let expected: serde_yaml::Value =
            serde_yaml::from_str("- id: dsh-better-sidebar\n  disabled: true\n").unwrap();
        for original in [
            "",
            " \n",
            "# empty patch\n",
            "null\n",
            "~\n",
            "---\n",
            "[]\n",
        ] {
            write_patch(&profile, original);
            disable_plugin_at(&profile, "dsh-better-sidebar").unwrap();
            let actual: serde_yaml::Value = serde_yaml::from_str(&read_patch(&profile)).unwrap();
            assert_eq!(actual, expected, "unexpected patch for {original:?}");
        }
        fs::remove_dir_all(&profile).unwrap();
    }

    #[test]
    fn disable_keeps_other_config_of_matching_entry() {
        let profile = build_profile("patch-update", "b");
        write_patch(
            &profile,
            "- id: dsh-better-sidebar\n  disabled: false\n  logLevel: debug\n",
        );
        assert!(add_patch_disable(&profile, "dsh-better-sidebar").unwrap());

        let content = read_patch(&profile);
        assert!(content.contains("logLevel: debug"));
        assert!(has_patch_disable(&profile, "dsh-better-sidebar"));
        // 命中条目而不是追加新条目
        assert_eq!(content.matches("dsh-better-sidebar").count(), 1);
        assert!(!content.contains("disabled: false"));

        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn disable_appends_entry_after_unrelated_ones() {
        let profile = build_profile("patch-append", "c");
        write_patch(&profile, "- id: dshmarket\n  foo: bar\n");
        disable_plugin_at(&profile, "dsh-better-sidebar").unwrap();

        let content = read_patch(&profile);
        assert!(content.contains("dshmarket"));
        assert!(content.contains("foo: bar"));
        let targets = load_patch_disabled(&profile);
        assert!(targets.contains("dsh-better-sidebar"));
        assert!(!targets.contains("dshmarket"));

        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn enable_strips_disable_and_keeps_other_config() {
        let profile = build_profile("patch-strip", "d");
        write_patch(
            &profile,
            "- id: dsh-better-sidebar\n  disabled: true\n- id: dshmarket\n  disabled: true\n- id: dsh-tauri-pet\n  foo: bar\n",
        );
        enable_plugin_at(&profile, "dsh-better-sidebar").unwrap();

        let content = read_patch(&profile);
        assert!(!content.contains("dsh-better-sidebar"));
        assert!(content.contains("foo: bar"));
        let targets = load_patch_disabled(&profile);
        assert!(targets.contains("dshmarket"));
        assert!(!targets.contains("dsh-better-sidebar"));
        // 幂等
        let err = enable_plugin_at(&profile, "dsh-better-sidebar").unwrap_err();
        assert!(err.contains("ENABLE_NOT_DISABLED"));

        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn disable_enable_round_trip_restores_original_patch() {
        let profile = build_profile("round-trip", "e");
        write_patch(&profile, "- id: dshmarket\n  foo: bar\n");
        let before = read_patch(&profile);
        disable_plugin_at(&profile, "dsh-better-sidebar").unwrap();
        assert!(has_patch_disable(&profile, "dsh-better-sidebar"));
        enable_plugin_at(&profile, "dsh-better-sidebar").unwrap();

        let doc: serde_yaml::Value = serde_yaml::from_str(&read_patch(&profile)).unwrap();
        let expected: serde_yaml::Value = serde_yaml::from_str(&before).unwrap();
        assert_eq!(doc, expected);

        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn disable_keeps_js_expressions_of_other_entries() {
        let profile = build_profile("js-disable", "p");
        write_patch(
            &profile,
            "- id: dshmarket\n  config:\n    token: !!js process.env.TOKEN\n",
        );
        disable_plugin_at(&profile, "dsh-better-sidebar").unwrap();

        assert_eq!(
            read_patch(&profile),
            "- id: dshmarket\n  config:\n    token: !!js process.env.TOKEN\n- id: dsh-better-sidebar\n  disabled: true\n"
        );
        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn enable_keeps_js_expressions_of_other_entries() {
        let profile = build_profile("js-enable", "q");
        write_patch(
            &profile,
            "- id: dsh-better-sidebar\n  disabled: true\n- id: dshmarket\n  config:\n    token: !!js process.env.TOKEN\n",
        );
        enable_plugin_at(&profile, "dsh-better-sidebar").unwrap();

        assert_eq!(
            read_patch(&profile),
            "- id: dshmarket\n  config:\n    token: !!js process.env.TOKEN\n"
        );
        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn disable_internal_plugin_is_rejected() {
        let profile = build_profile("internal-reject", "f");
        let err = disable_plugin_at(&profile, "@deepseek-ai/dsh-base").unwrap_err();
        assert!(err.contains("DISABLE_INTERNAL_PLUGIN"));
        assert!(!profile.join(PATCH_FILE).exists());

        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn disable_not_installed_is_rejected() {
        let profile = build_profile("not-installed", "g");
        let err = disable_plugin_at(&profile, "dsh-not-exist").unwrap_err();
        assert!(err.contains("DISABLE_NOT_INSTALLED"));
        assert!(!profile.join(PATCH_FILE).exists());

        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn enable_not_disabled_is_rejected() {
        let profile = build_profile("not-disabled", "h");
        let err = enable_plugin_at(&profile, "dsh-better-sidebar").unwrap_err();
        assert!(err.contains("ENABLE_NOT_DISABLED"));

        let _ = fs::remove_dir_all(&profile);
    }

    /// `load_patch_disabled` 只收集带真值 `disabled` 字段的条目目标；
    /// `disabled: false`、无 disabled 字段、非映射条目都不算禁用。
    #[test]
    fn load_patch_disabled_collects_only_true_disables() {
        let profile = build_profile("patch-collect", "i");
        write_patch(
            &profile,
            "- id: dshmarket\n  disabled: true\n- id: dsh-better-sidebar\n  disabled: false\n- id: dsh-tauri-pet\n  config: 1\n- plain-string\n",
        );
        let targets = load_patch_disabled(&profile);
        assert!(targets.contains("dshmarket"));
        assert!(!targets.contains("dsh-better-sidebar"));
        assert!(!targets.contains("dsh-tauri-pet"));

        assert!(load_patch_disabled(&std::env::temp_dir()).is_empty());
        let broken = build_profile("patch-broken", "j");
        write_patch(&broken, "not: [valid");
        assert!(load_patch_disabled(&broken).is_empty());
        fs::remove_dir_all(&broken).ok();

        fs::remove_dir_all(&profile).ok();
    }

    #[test]
    fn strip_patch_disable_preserves_non_mapping_and_false_or_nested_targets() {
        let profile = build_profile("patch-boundaries", "k");
        write_patch(
            &profile,
            "- dsh-better-sidebar\n- [dsh-better-sidebar]\n- id: other\n  config: {id: dsh-better-sidebar}\n  disabled: true\n- id: dsh-better-sidebar\n  disabled: false\n- dsh-better-sidebar: alias\n  disabled: true\n",
        );
        assert!(strip_patch_disable(&profile, "dsh-better-sidebar").unwrap());
        let patch = profile.join(PATCH_FILE);
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

    /// 别名匹配：patch 条目的 id 用包内 `name`（非依赖键）时同样命中。
    #[test]
    fn patch_disable_matches_package_json_name_alias() {
        let profile = build_profile("patch-alias", "l");
        let pkg_dir = profile.join("node_modules").join("dsh-better-sidebar");
        fs::create_dir_all(&pkg_dir).unwrap();
        fs::write(
            pkg_dir.join("package.json"),
            r#"{"name":"better-sidebar","version":"1.0.0"}"#,
        )
        .unwrap();
        write_patch(&profile, "- id: better-sidebar\n  disabled: true\n");

        assert!(has_patch_disable(&profile, "dsh-better-sidebar"));
        enable_plugin_at(&profile, "dsh-better-sidebar").unwrap();
        assert!(!read_patch(&profile).contains("better-sidebar"));

        fs::remove_dir_all(&profile).ok();
    }

    /// 核心回归：覆盖项必须写 loader entry id（官方 `patchId`）；写 npm 包名
    /// 命中不了任何条目，禁用会「成功」但运行时照旧加载。
    #[test]
    fn disable_writes_loader_entry_id_from_bundle_patch() {
        let profile = build_bundle_profile(
            "entry-id",
            &[(
                "dshmarket",
                "dshmarket",
                "- insert:\n    - id: dsh-market\n      name: dshmarket\n",
            )],
        );
        disable_plugin_at(&profile, "dshmarket").unwrap();

        assert_eq!(patch_ids(&profile), vec!["dsh-market".to_string()]);
        assert!(has_patch_disable(&profile, "dshmarket"));
        assert!(!add_patch_disable(&profile, "dshmarket").unwrap());

        enable_plugin_at(&profile, "dshmarket").unwrap();
        let doc: serde_yaml::Value = serde_yaml::from_str(&read_patch(&profile)).unwrap();
        assert!(doc.as_sequence().unwrap().is_empty());
        assert!(!has_patch_disable(&profile, "dshmarket"));

        fs::remove_dir_all(&profile).ok();
    }

    /// 一个包可能插入多个条目（`dsh-ops/*`）：禁用要覆盖全部，且不误伤同包顺带
    /// 插入的其它模块（`dsh-tauri-pet` 的 skill-filesystem）。
    #[test]
    fn disable_covers_every_package_entry_and_ignores_foreign_inserts() {
        let profile = build_bundle_profile(
            "entries",
            &[
                (
                    "dsh-ops",
                    "dsh-ops",
                    "- insert:\n    - id: dsh-ops-shell\n      name: dsh-ops/shell\n    - id: dsh-ops-file\n      name: dsh-ops/file\n",
                ),
                (
                    "dsh-tauri-pet",
                    "dsh-tauri-pet",
                    "- insert:\n    - id: dsh-tauri-pet-skills\n      name: '@deepseek-ai/dsh-skill-filesystem'\n    - id: dsh-tauri-pet\n      name: dsh-tauri-pet\n",
                ),
            ],
        );
        disable_plugin_at(&profile, "dsh-ops").unwrap();

        let ids = patch_ids(&profile);
        assert!(ids.contains(&"dsh-ops-shell".to_string()));
        assert!(ids.contains(&"dsh-ops-file".to_string()));
        assert!(has_patch_disable(&profile, "dsh-ops"));
        assert!(!has_patch_disable(&profile, "dsh-tauri-pet"));

        enable_plugin_at(&profile, "dsh-ops").unwrap();
        assert!(!read_patch(&profile).contains("dsh-ops-shell"));

        fs::remove_dir_all(&profile).ok();
    }

    /// 旧版按包名写下的无效覆盖不再算「已禁用」，启用时顺带清掉。
    #[test]
    fn has_patch_disable_ignores_legacy_package_name_override() {
        let profile = build_bundle_profile(
            "legacy",
            &[(
                "dshmarket",
                "dshmarket",
                "- insert:\n    - id: dsh-market\n      name: dshmarket\n",
            )],
        );
        write_patch(&profile, "- id: dshmarket\n  disabled: true\n");
        assert!(!has_patch_disable(&profile, "dshmarket"));

        disable_plugin_at(&profile, "dshmarket").unwrap();
        assert!(read_patch(&profile).contains("id: dsh-market"));
        enable_plugin_at(&profile, "dshmarket").unwrap();
        assert!(patch_ids(&profile).is_empty());

        fs::remove_dir_all(&profile).ok();
    }

    #[test]
    fn disable_updates_existing_entry_override_in_place() {
        let profile = build_bundle_profile(
            "existing",
            &[(
                "dshmarket",
                "dshmarket",
                "- insert:\n    - id: dsh-market\n      name: dshmarket\n",
            )],
        );
        write_patch(&profile, "- id: dsh-market\n  config:\n    theme: dark\n");
        disable_plugin_at(&profile, "dshmarket").unwrap();

        let content = read_patch(&profile);
        assert_eq!(content.matches("id: dsh-market").count(), 1);
        assert!(content.contains("theme: dark"));
        assert!(content.contains("disabled: true"));

        fs::remove_dir_all(&profile).ok();
    }

    /// 手写 insert 的插件（没有 bundle patch）同样按插入条目的 id 禁用。
    #[test]
    fn disable_targets_entries_inserted_by_profile_patch() {
        let profile = build_profile("profile-insert", "r");
        let pkg_dir = profile.join("node_modules").join("dsh-better-sidebar");
        fs::create_dir_all(&pkg_dir).unwrap();
        fs::write(
            pkg_dir.join("package.json"),
            r#"{"name":"better-sidebar","version":"1.0.0"}"#,
        )
        .unwrap();
        write_patch(
            &profile,
            "- insert:\n    - id: sidebar-dev\n      name: better-sidebar\n",
        );
        disable_plugin_at(&profile, "dsh-better-sidebar").unwrap();

        let content = read_patch(&profile);
        assert!(content.contains("id: sidebar-dev"));
        assert!(has_patch_disable(&profile, "dsh-better-sidebar"));

        enable_plugin_at(&profile, "dsh-better-sidebar").unwrap();
        assert!(read_patch(&profile).contains("sidebar-dev"));
        assert!(!has_patch_disable(&profile, "dsh-better-sidebar"));

        fs::remove_dir_all(&profile).ok();
    }

    /// 官方包级开关的禁用是把 bundle 移出 `dsh.profile.bundles`；启用要补回。
    #[test]
    fn enable_restores_bundle_deselected_by_official_switch() {
        let profile = build_bundle_profile(
            "bundle-restored",
            &[(
                "dshmarket",
                "dshmarket",
                "- insert:\n    - id: dsh-market\n      name: dshmarket\n",
            )],
        );
        let manifest_path = profile.join("package.json");
        let mut manifest: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        manifest["dsh"]["profile"]["bundles"] = serde_json::json!([]);
        fs::write(
            &manifest_path,
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();

        enable_plugin_at(&profile, "dshmarket").unwrap();

        let manifest: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        assert_eq!(
            manifest["dsh"]["profile"]["bundles"],
            serde_json::json!(["dshmarket"])
        );

        fs::remove_dir_all(&profile).ok();
    }

    /// scoped 包名（含 `/`）同样能禁用/启用：`fs_guard::validate_id` 会拒绝 `/`。
    #[test]
    fn disable_and_enable_scoped_plugin() {
        let profile = build_bundle_profile(
            "scoped",
            &[(
                "@wenaixi/dsh-ponytail",
                "@wenaixi/dsh-ponytail",
                "- insert:\n    - id: ponytail\n      name: '@wenaixi/dsh-ponytail'\n",
            )],
        );
        disable_plugin_at(&profile, "@wenaixi/dsh-ponytail").unwrap();
        assert_eq!(patch_ids(&profile), vec!["ponytail".to_string()]);

        enable_plugin_at(&profile, "@wenaixi/dsh-ponytail").unwrap();
        assert!(patch_ids(&profile).is_empty());

        fs::remove_dir_all(&profile).ok();
    }

    /// 多条目包只有部分条目被禁用时，包整体仍算启用。
    #[test]
    fn has_patch_disable_requires_every_package_entry() {
        let profile = build_bundle_profile(
            "partial",
            &[(
                "dsh-ops",
                "dsh-ops",
                "- insert:\n    - id: dsh-ops-shell\n      name: dsh-ops/shell\n    - id: dsh-ops-file\n      name: dsh-ops/file\n",
            )],
        );
        write_patch(&profile, "- id: dsh-ops-shell\n  disabled: true\n");
        assert!(!has_patch_disable(&profile, "dsh-ops"));

        disable_plugin_at(&profile, "dsh-ops").unwrap();
        assert!(has_patch_disable(&profile, "dsh-ops"));

        fs::remove_dir_all(&profile).ok();
    }

    /// 档案没有 `dsh.profile.bundles` 时跳过补 bundle，但 patch 覆盖照常撤除。
    #[test]
    fn enable_without_bundles_list_still_strips_patch_disable() {
        let profile = build_bundle_profile(
            "no-bundles",
            &[(
                "dshmarket",
                "dshmarket",
                "- insert:\n    - id: dsh-market\n      name: dshmarket\n",
            )],
        );
        let manifest_path = profile.join("package.json");
        let mut manifest: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        manifest["dsh"] = serde_json::json!({});
        fs::write(
            &manifest_path,
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();
        write_patch(&profile, "- id: dsh-market\n  disabled: true\n");

        enable_plugin_at(&profile, "dshmarket").unwrap();
        assert!(patch_ids(&profile).is_empty());

        fs::remove_dir_all(&profile).ok();
    }

    /// patch 不可读时启用必须报错，不能把「补回 bundle」当成功而留下未知禁用态。
    #[test]
    fn enable_reports_unreadable_patch_instead_of_success() {
        let profile = build_bundle_profile(
            "unreadable-enable",
            &[(
                "dshmarket",
                "dshmarket",
                "- insert:\n    - id: dsh-market\n      name: dshmarket\n",
            )],
        );
        let manifest_path = profile.join("package.json");
        let mut manifest: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        manifest["dsh"]["profile"]["bundles"] = serde_json::json!([]);
        fs::write(
            &manifest_path,
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();
        fs::write(profile.join(PATCH_FILE), [0xff, 0xfe]).unwrap();

        let error = enable_plugin_at(&profile, "dshmarket").unwrap_err();
        assert!(error.starts_with("ENABLE_PATCH_READ_FAILED:"), "{error}");
        assert!(!profile.join("package.json.lock").exists());

        fs::remove_dir_all(&profile).ok();
    }
}
