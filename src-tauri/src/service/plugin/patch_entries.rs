//! 补丁层悬空 `insert` 条目的预检与显式清理。
//!
//! `cordis.patch.yml` 是用户自有层，手写的 `insert` 条目会在启动时被 loader
//! 当成真实插件行 import。包被卸载后条目还留在补丁层里（市场会拒绝卸载「仍被
//! 用户补丁引用」的插件，用户于是改走手工删依赖 / `pnpm remove`），或者本地
//! `link:` 源目录被删掉，loader 就在 import 时抛 `ERR_MODULE_NOT_FOUND`，让
//! **整棵插件树**加载失败——应用彻底起不来，用户只看到一坨 Node 堆栈。
//!
//! 上游契约是「补丁文件存在却应用不了就大声失败」，这里不改变该契约，只把它
//! 提前成一条可操作的错误：哪个文件、哪一行、哪个包；错误页据此给出「移除悬空
//! 条目」的一键恢复（[`strip_unresolved_entries_in`]），原文件先备份为
//! `<原名>.bak-<时间戳>`，绝不静默改写用户补丁。
//!
//! 只判定「必然被挂载」的一类：顶层没有 `id` 的 `insert` 会无条件追加到根树，
//! 条目一定会被 import。顶层带 `id` 的 insert 只在目标 group 存在时才生效
//! （上游 `applyEntryPatches` 找不到目标只 warn 后跳过），是否需要该 group 取决于
//! 组合后的树，桌面端不做猜测——这类只记 debug 日志，绝不阻断启动。
//!
//! 解析规则与 loader 一致：条目 `name` 是裸包名时按 Node 的 `node_modules` 查找
//! 顺序从档案目录逐级向上解析；`dsh` 安装树自身的依赖由 dsh 启动时的
//! `$DSH_HOME/profiles/node_modules` 回退镜像提供，同样算可解析（宁可漏报，绝不
//! 因为猜错而拦下一个本来能起来的启动）。路径 / `file:` URL 形式的 `name` 由
//! 上游改写，不做判定。

use std::collections::HashMap;
use std::path::Path;

use serde_yaml::{Mapping, Value};
use tauri::AppHandle;

use super::installed::ProfilePackageJson;
use super::patch_guard::{backup_path, now_stamp, patch_layer_paths};

/// 启动失败错误串的前缀；前端据此识别并渲染「移除悬空条目」入口。
pub(crate) const PATCH_ENTRY_UNRESOLVED: &str = "PATCH_LAYER_ENTRY_UNRESOLVED";

/// 档案本地模块回退目录（与 dsh-app-boot 的 `PROFILE_MODULE_FALLBACK_DIR` 同名）。
const PROFILE_MODULE_FALLBACK_DIR: &str = ".dsh-module-fallback";

/// 补丁层里一个解析不到对应包的 `insert` 条目。
#[derive(Debug, Clone, serde::Serialize)]
pub struct UnresolvedPatchEntry {
    /// 补丁层文件路径（档案层或 home 层）。
    pub layer: String,
    /// `name` 所在的 1-based 行号（定位不到条目起始行时回落）。
    pub line: usize,
    /// 条目的 loader id（展示用）。
    pub id: Option<String>,
    /// 引用的包名。
    pub name: String,
    /// 该包是否仍写在档案 `dependencies` 里（是则「重装插件」比「删条目」更对症）。
    pub declared: bool,
}

/// 一个被清理过的补丁层。
#[derive(Debug, Clone, serde::Serialize)]
pub struct StrippedPatchLayer {
    /// 原始补丁文件路径。
    pub original: String,
    /// 清理前的备份路径（`<原名>.bak-<UTC 时间戳>`）。
    pub backup: String,
    /// 移除的条目数。
    pub removed: usize,
}

/// 一次清理动作的结果：逐层列出备份路径与移除数量。
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct PatchEntryStripReport {
    pub layers: Vec<StrippedPatchLayer>,
}

/// 把悬空条目拼成给前端的错误串：`PREFIX: {"entries":[...]}`。
///
/// 用 JSON 承载结构化明细（文件 / 行号 / 包名 / 是否已声明），前端只做解析与
/// 展示，避免在这里拼人类可读文本再回头解析。
pub(crate) fn unresolved_entries_message(entries: &[UnresolvedPatchEntry]) -> String {
    let payload = serde_json::json!({ "entries": entries });
    format!("{PATCH_ENTRY_UNRESOLVED}: {payload}")
}

/// 从「当前档案层 + home 层」移除解析不到的 `insert` 条目并返回备份路径。
pub(crate) fn strip_active_unresolved_entries(
    app_handle: &AppHandle,
) -> Result<PatchEntryStripReport, String> {
    let profile = super::installed::profile_dir(app_handle);
    let dsh_home = crate::config::get_dsh_data_path(app_handle);
    let install_anchor = crate::service::core::active_dsh_binary(app_handle);
    strip_unresolved_entries_in(&profile, &dsh_home, Some(&install_anchor))
}

/// 扫描指定档案层与 home 层；`install_anchor` 是活动核心入口（用于判定 dsh 安装树
/// 自带的包，测试传 `None`）。
pub(crate) fn scan_unresolved_entries_in(
    profile_dir: &Path,
    dsh_home: &Path,
    install_anchor: Option<&Path>,
) -> Vec<UnresolvedPatchEntry> {
    let declared = declared_dependencies(profile_dir);
    let mut unresolved = Vec::new();
    for layer in patch_layer_paths(profile_dir, dsh_home) {
        unresolved.extend(scan_layer(&layer, profile_dir, install_anchor, &declared));
    }
    unresolved
}

/// 移除指定档案层与 home 层里解析不到的 `insert` 条目。
///
/// 只动被判定为悬空的 insert 项：同一条目里的其它 insert 与其它配置原样保留；
/// `insert` 被清空且条目再无其它字段时整个条目一并移除。改写前先把原文件复制成
/// `<原名>.bak-<时间戳>`——用户手写的补丁层绝不无声丢失。
pub(crate) fn strip_unresolved_entries_in(
    profile_dir: &Path,
    dsh_home: &Path,
    install_anchor: Option<&Path>,
) -> Result<PatchEntryStripReport, String> {
    let mut report = PatchEntryStripReport::default();
    for layer in patch_layer_paths(profile_dir, dsh_home) {
        let Ok(raw) = std::fs::read_to_string(&layer) else {
            continue;
        };
        let Ok(doc) = serde_yaml::from_str::<Value>(&raw) else {
            continue;
        };
        let Some(entries) = doc.as_sequence() else {
            continue;
        };
        let (kept, removed) = strip_entries(entries, profile_dir, install_anchor);
        if removed == 0 {
            continue;
        }
        let stamp = now_stamp();
        let backup = backup_path(&layer, "bak", &stamp);
        std::fs::copy(&layer, &backup)
            .map_err(|e| format!("PATCH_LAYER_STRIP_BACKUP_FAILED: {}: {e}", backup.display()))?;
        let rendered = serde_yaml::to_string(&Value::Sequence(kept))
            .map_err(|e| format!("PATCH_LAYER_STRIP_RENDER_FAILED: {e}"))?;
        write_patch_layer_atomically(&layer, &rendered, &stamp)?;
        log::warn!(
            "PATCH_LAYER_ENTRIES_STRIPPED: {} -> {} (removed {removed})",
            layer.display(),
            backup.display()
        );
        report.layers.push(StrippedPatchLayer {
            original: layer.display().to_string(),
            backup: backup.display().to_string(),
            removed,
        });
    }
    Ok(report)
}

/// 扫描单个补丁层：返回「必然被挂载且解析不到包」的条目。
fn scan_layer(
    layer: &Path,
    profile_dir: &Path,
    install_anchor: Option<&Path>,
    declared: &HashMap<String, String>,
) -> Vec<UnresolvedPatchEntry> {
    let Ok(raw) = std::fs::read_to_string(layer) else {
        return Vec::new();
    };
    // 解析不了的补丁层交给 patch_guard 的语法错误路径，不在这里重复报错。
    let Ok(doc) = serde_yaml::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    let Some(entries) = doc.as_sequence() else {
        return Vec::new();
    };
    let starts = top_level_item_lines(&raw);
    let mut blocking = Vec::new();
    let mut group_scoped = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        let Some(map) = entry.as_mapping() else {
            continue;
        };
        let Some(items) = map_get(map, "insert").and_then(Value::as_sequence) else {
            continue;
        };
        // 顶层带 id 的 insert 只在目标 group 存在时挂载：是否需要该 group 取决于
        // 组合后的树，桌面端不猜，只记日志。
        let target = if has_effective_id(map) {
            &mut group_scoped
        } else {
            &mut blocking
        };
        for item in items {
            let Some(name) = dangling_package(profile_dir, install_anchor, item) else {
                continue;
            };
            target.push(UnresolvedPatchEntry {
                layer: layer.display().to_string(),
                line: item_line(&raw, &starts, index, name),
                id: item
                    .as_mapping()
                    .and_then(|item| map_get(item, "id"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                name: name.to_owned(),
                declared: declared.contains_key(name),
            });
        }
    }
    if !group_scoped.is_empty() {
        log::debug!(
            "PATCH_LAYER_GROUP_INSERT_UNRESOLVED: {}: {}",
            layer.display(),
            group_scoped
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    blocking
}

fn dangling_package<'a>(
    profile_dir: &Path,
    install_anchor: Option<&Path>,
    item: &'a Value,
) -> Option<&'a str> {
    item.as_mapping()
        .and_then(|item| map_get(item, "name"))
        .and_then(Value::as_str)
        .filter(|name| {
            is_bare_package_name(name) && !package_resolvable(profile_dir, install_anchor, name)
        })
}

fn strip_entries(
    entries: &[Value],
    profile_dir: &Path,
    install_anchor: Option<&Path>,
) -> (Vec<Value>, usize) {
    let mut kept = Vec::with_capacity(entries.len());
    let mut removed = 0usize;
    for entry in entries {
        let Some(map) = entry.as_mapping() else {
            kept.push(entry.clone());
            continue;
        };
        if has_effective_id(map) {
            kept.push(entry.clone());
            continue;
        }
        let Some(items) = map_get(map, "insert").and_then(Value::as_sequence) else {
            kept.push(entry.clone());
            continue;
        };
        let mut kept_items = Vec::with_capacity(items.len());
        for item in items {
            if dangling_package(profile_dir, install_anchor, item).is_some() {
                removed += 1;
            } else {
                kept_items.push(item.clone());
            }
        }
        if kept_items.is_empty() {
            let stripped = without_key(map, "insert");
            if !stripped.is_empty() {
                kept.push(Value::Mapping(stripped));
            }
        } else {
            kept.push(Value::Mapping(with_key(
                map,
                "insert",
                Value::Sequence(kept_items),
            )));
        }
    }
    (kept, removed)
}

/// 档案 `dependencies` 的键集合；清单缺失/损坏时返回空表（只影响提示措辞）。
fn declared_dependencies(profile_dir: &Path) -> HashMap<String, String> {
    std::fs::read_to_string(profile_dir.join("package.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<ProfilePackageJson>(&raw).ok())
        .map(|manifest| manifest.dependencies)
        .unwrap_or_default()
}

/// 裸包名（可被 Node 解析的 specifier）；路径、`file:` URL、`!!js` 表达式都不判定。
fn is_bare_package_name(name: &str) -> bool {
    if name.is_empty() || name.contains(char::is_whitespace) {
        return false;
    }
    if name.contains(':') || name.contains('\\') || name.starts_with('.') || name.starts_with('/') {
        return false;
    }
    match name.strip_prefix('@') {
        Some(rest) => {
            let mut parts = rest.split('/');
            let scope = parts.next().unwrap_or_default();
            let package = parts.next().unwrap_or_default();
            parts.next().is_none() && !scope.is_empty() && !package.is_empty()
        }
        None => !name.contains('/'),
    }
}

/// 包是否能被 loader 解析：档案目录的 Node 查找顺序、档案本地回退目录、
/// dsh 安装树（安装依赖由 dsh 启动时的 `profiles/node_modules` 回退镜像提供）。
fn package_resolvable(profile_dir: &Path, install_anchor: Option<&Path>, name: &str) -> bool {
    if resolvable_from(profile_dir, name) {
        return true;
    }
    if install_anchor.is_some_and(|anchor| resolvable_from(anchor, name)) {
        return true;
    }
    profile_dir
        .join(PROFILE_MODULE_FALLBACK_DIR)
        .join("node_modules")
        .join(name)
        .join("package.json")
        .is_file()
}

/// 按 Node 的 `node_modules` 查找顺序（逐级向上的父目录）判定包是否存在。
///
/// 与 dsh-app-boot 的 `packageDirFromAnchor` 同一判定（探测目录里的 `package.json`，
/// 不要求包导出 `./package.json`），因此结果与 loader 的 import 一致。
fn resolvable_from(anchor: &Path, name: &str) -> bool {
    anchor.ancestors().any(|dir| {
        dir.join("node_modules")
            .join(name)
            .join("package.json")
            .is_file()
    })
}

/// 顶层序列项的起始行号（1-based）；补丁层是顶层数组，`- ` 必须顶格。
fn top_level_item_lines(raw: &str) -> Vec<usize> {
    raw.lines()
        .enumerate()
        .filter(|(_, line)| {
            let trimmed = line.trim_end();
            trimmed == "-" || trimmed.starts_with("- ")
        })
        .map(|(index, _)| index + 1)
        .collect()
}

/// 条目内 `name` 所在行；定位不到时回落该条目的起始行。
fn item_line(raw: &str, starts: &[usize], index: usize, name: &str) -> usize {
    let lines: Vec<&str> = raw.lines().collect();
    let start = starts.get(index).copied().unwrap_or(1);
    let end = starts
        .get(index + 1)
        .map(|next| next.saturating_sub(1))
        .unwrap_or(lines.len());
    (start..=end.min(lines.len()))
        .find(|number| {
            lines
                .get(number - 1)
                .is_some_and(|line| line.contains("name:") && line.contains(name))
        })
        .unwrap_or(start)
}

/// 补丁条目是否带「生效的」顶层 id（与上游 `if (id)` 的真值判定一致）。
///
/// 上游是 JS 真值：`id: ''`、`id: null`、`id: false`、`id: 0` 都走「无 id」分支
/// （insert 追加到顶层、必然被挂载），只有这些才需要预检；写成 `Some(_) => true`
/// 会把 `id: false` / `id: 0` 误当成 group 作用域而漏检。
fn has_effective_id(map: &Mapping) -> bool {
    match map_get(map, "id") {
        Some(Value::String(id)) => !id.is_empty(),
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(number)) => number
            .as_f64()
            .is_some_and(|value| value != 0.0 && !value.is_nan()),
        Some(Value::Null) | None => false,
        Some(_) => true,
    }
}

/// 原子改写补丁层：先写同目录临时文件再改名替换。
///
/// `fs::write` 会先截断原文件，写到一半失败（磁盘满 / 被中断）会把用户手写的补丁层
/// 截成半截 YAML——虽然 `.bak-<时间戳>` 备份还在，但半截文件会让下次启动多报一个
/// 语法错误。同目录 `rename` 在 Windows（`MOVEFILE_REPLACE_EXISTING`）与 Unix 上
/// 都是原子替换，失败时原文件保持不动。
fn write_patch_layer_atomically(layer: &Path, rendered: &str, stamp: &str) -> Result<(), String> {
    let name = layer
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let temp = layer.with_file_name(format!("{name}.tmp-{stamp}"));
    std::fs::write(&temp, rendered).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("PATCH_LAYER_STRIP_WRITE_FAILED: {}: {e}", temp.display())
    })?;
    std::fs::rename(&temp, layer).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("PATCH_LAYER_STRIP_WRITE_FAILED: {}: {e}", layer.display())
    })
}

/// 取映射字段；用迭代而不是 `Mapping::get`，避开 serde_yaml 的索引泛型差异。
fn map_get<'a>(map: &'a Mapping, key: &str) -> Option<&'a Value> {
    map.iter()
        .find(|(field, _)| field.as_str() == Some(key))
        .map(|(_, value)| value)
}

/// 复制映射并去掉一个字段。
fn without_key(map: &Mapping, key: &str) -> Mapping {
    let mut out = Mapping::new();
    for (field, value) in map {
        if field.as_str() != Some(key) {
            out.insert(field.clone(), value.clone());
        }
    }
    out
}

/// 复制映射并就地替换一个字段的值（保持原有字段顺序）。
fn with_key(map: &Mapping, key: &str, value: Value) -> Mapping {
    let mut out = Mapping::new();
    for (field, existing) in map {
        if field.as_str() == Some(key) {
            out.insert(field.clone(), value.clone());
        } else {
            out.insert(field.clone(), existing.clone());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dsh-patch-entries-{name}-{}-{}",
            std::process::id(),
            now_stamp()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 在档案目录里造一个已安装的包（loader 只看 `package.json` 是否存在）。
    fn install_package(profile: &Path, name: &str) {
        let dir = profile.join("node_modules").join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("package.json"), "{}\n").unwrap();
    }

    #[test]
    fn dangling_package_preserves_item_shape_and_resolution_boundaries() {
        let profile = tmp_dir("dangling-boundaries");
        let anchor = tmp_dir("dangling-anchor");
        install_package(&profile, "local-plugin");
        install_package(&anchor, "anchor-plugin");
        for (yaml, expected) in [
            ("name: missing-plugin", Some("missing-plugin")),
            ("name: '@scope/missing'", Some("@scope/missing")),
            ("name: local-plugin", None),
            ("name: anchor-plugin", None),
            ("name: ./relative", None),
            ("name: file:///plugin.js", None),
            ("name: 7", None),
            ("id: missing-plugin", None),
            ("missing-plugin", None),
            ("[missing-plugin]", None),
            ("null", None),
        ] {
            let item = serde_yaml::from_str(yaml).unwrap();
            assert_eq!(
                dangling_package(&profile, Some(&anchor), &item),
                expected,
                "{yaml}"
            );
        }
        std::fs::remove_dir_all(profile).unwrap();
        std::fs::remove_dir_all(anchor).unwrap();
    }

    /// 事故形态：包已卸载、手写的 insert 还在补丁层里。
    const DANGLING_LAYER: &str = "- insert:\n    - id: file-edit\n      name: dsh-file-edit\n";

    #[test]
    fn dangling_insert_is_reported_with_line() {
        let profile = tmp_dir("dangling-profile");
        let home = tmp_dir("dangling-home");
        std::fs::write(profile.join("cordis.patch.yml"), DANGLING_LAYER).unwrap();

        let entries = scan_unresolved_entries_in(&profile, &home, None);

        assert_eq!(entries.len(), 1, "{entries:?}");
        let entry = &entries[0];
        assert_eq!(entry.name, "dsh-file-edit");
        assert_eq!(entry.id.as_deref(), Some("file-edit"));
        assert_eq!(entry.line, 3);
        assert!(!entry.declared);
        let _ = std::fs::remove_dir_all(&profile);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn installed_package_is_not_reported() {
        let profile = tmp_dir("installed-profile");
        let home = tmp_dir("installed-home");
        std::fs::write(profile.join("cordis.patch.yml"), DANGLING_LAYER).unwrap();
        install_package(&profile, "dsh-file-edit");

        assert!(scan_unresolved_entries_in(&profile, &home, None).is_empty());
        let _ = std::fs::remove_dir_all(&profile);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 父目录里的 `node_modules` 同样算可解析（`$DSH_HOME/profiles/node_modules`
    /// 回退镜像就是这一层），否则会把核心包误判成悬空。
    #[test]
    fn ancestor_node_modules_counts_as_resolvable() {
        let root = tmp_dir("ancestor-root");
        let profile = root.join("profiles").join("web");
        let home = root.join("home");
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        install_package(&root.join("profiles"), "@deepseek-ai/dsh-base");
        std::fs::write(
            profile.join("cordis.patch.yml"),
            "- insert:\n    - id: dsh-base\n      name: '@deepseek-ai/dsh-base'\n",
        )
        .unwrap();

        assert!(scan_unresolved_entries_in(&profile, &home, None).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 顶层带 id 的 insert 只在目标 group 存在时才挂载，不猜测、不阻断。
    #[test]
    fn group_scoped_insert_is_not_blocking() {
        let profile = tmp_dir("group-profile");
        let home = tmp_dir("group-home");
        std::fs::write(
            profile.join("cordis.patch.yml"),
            "- id: some-group\n  insert:\n    - id: child\n      name: dsh-missing-child\n",
        )
        .unwrap();

        assert!(scan_unresolved_entries_in(&profile, &home, None).is_empty());
        let _ = std::fs::remove_dir_all(&profile);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 路径 / `file:` URL / `!!js` 形式的 name 由上游改写，不做判定。
    #[test]
    fn non_bare_names_are_skipped() {
        let profile = tmp_dir("non-bare-profile");
        let home = tmp_dir("non-bare-home");
        std::fs::write(
            profile.join("cordis.patch.yml"),
            "- insert:\n    - id: local\n      name: ./plugins/local\n    - id: abs\n      name: file:///tmp/plugin.js\n",
        )
        .unwrap();

        assert!(scan_unresolved_entries_in(&profile, &home, None).is_empty());
        let _ = std::fs::remove_dir_all(&profile);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 语法错误的补丁层交给 patch_guard，不在这里重复报错。
    #[test]
    fn unparsable_layer_is_left_to_patch_guard() {
        let profile = tmp_dir("unparsable-profile");
        let home = tmp_dir("unparsable-home");
        std::fs::write(
            profile.join("cordis.patch.yml"),
            "- insert:\n    - id: x\n      name: !!js process.env.X ? a : b\n",
        )
        .unwrap();

        assert!(scan_unresolved_entries_in(&profile, &home, None).is_empty());
        let _ = std::fs::remove_dir_all(&profile);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn declared_dependency_is_flagged() {
        let profile = tmp_dir("declared-profile");
        let home = tmp_dir("declared-home");
        std::fs::write(profile.join("cordis.patch.yml"), DANGLING_LAYER).unwrap();
        std::fs::write(
            profile.join("package.json"),
            r#"{"dependencies":{"dsh-file-edit":"link:D:/plugins/file-edit"}}"#,
        )
        .unwrap();

        let entries = scan_unresolved_entries_in(&profile, &home, None);

        assert_eq!(entries.len(), 1);
        assert!(entries[0].declared);
        let _ = std::fs::remove_dir_all(&profile);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 安装树自带的包（由 dsh 的 `profiles/node_modules` 回退镜像提供）不阻断启动。
    #[test]
    fn installation_anchor_makes_a_package_resolvable() {
        let install = tmp_dir("install-anchor");
        let profile = tmp_dir("anchor-profile");
        let home = tmp_dir("anchor-home");
        let bin = install
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join("lib")
            .join("bin.js");
        std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
        std::fs::write(&bin, "// bin\n").unwrap();
        install_package(&install, "@deepseek-ai/dsh-base");
        std::fs::write(
            profile.join("cordis.patch.yml"),
            "- insert:\n    - id: dsh-base\n      name: '@deepseek-ai/dsh-base'\n",
        )
        .unwrap();

        assert!(scan_unresolved_entries_in(&profile, &home, Some(&bin)).is_empty());
        // 没有安装锚点时同一份补丁层会被判定为悬空，证明锚点确实参与了判定。
        assert_eq!(scan_unresolved_entries_in(&profile, &home, None).len(), 1);
        let _ = std::fs::remove_dir_all(&install);
        let _ = std::fs::remove_dir_all(&profile);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 只剥离悬空的 insert 项：同一条目里的其它 insert、其它条目与其它字段都保留。
    #[test]
    fn strip_removes_only_dangling_inserts() {
        let profile = tmp_dir("strip-profile");
        let home = tmp_dir("strip-home");
        install_package(&profile, "dsh-keep");
        std::fs::write(
            profile.join("cordis.patch.yml"),
            "- insert:\n    - id: keep\n      name: dsh-keep\n    - id: gone\n      name: dsh-gone\n- id: untouched\n  disabled: true\n",
        )
        .unwrap();

        let report = strip_unresolved_entries_in(&profile, &home, None).unwrap();

        assert_eq!(report.layers.len(), 1);
        assert_eq!(report.layers[0].removed, 1);
        let backup = PathBuf::from(&report.layers[0].backup);
        assert!(backup.is_file());
        assert!(std::fs::read_to_string(&backup)
            .unwrap()
            .contains("dsh-gone"));
        let stripped = std::fs::read_to_string(profile.join("cordis.patch.yml")).unwrap();
        assert!(stripped.contains("dsh-keep"), "{stripped}");
        assert!(stripped.contains("untouched"), "{stripped}");
        assert!(!stripped.contains("dsh-gone"), "{stripped}");
        assert!(scan_unresolved_entries_in(&profile, &home, None).is_empty());
        let _ = std::fs::remove_dir_all(&profile);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// insert 被清空且条目再无其它字段时整个条目移除，补丁层回落成空数组。
    #[test]
    fn strip_drops_an_entry_left_empty() {
        let profile = tmp_dir("empty-profile");
        let home = tmp_dir("empty-home");
        std::fs::write(profile.join("cordis.patch.yml"), DANGLING_LAYER).unwrap();

        let report = strip_unresolved_entries_in(&profile, &home, None).unwrap();

        assert_eq!(report.layers[0].removed, 1);
        let stripped = std::fs::read_to_string(profile.join("cordis.patch.yml")).unwrap();
        assert_eq!(stripped.trim(), "[]");
        let _ = std::fs::remove_dir_all(&profile);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn strip_is_idempotent_and_backs_up_once() {
        let profile = tmp_dir("idempotent-strip-profile");
        let home = tmp_dir("idempotent-strip-home");
        std::fs::write(profile.join("cordis.patch.yml"), DANGLING_LAYER).unwrap();

        assert_eq!(
            strip_unresolved_entries_in(&profile, &home, None)
                .unwrap()
                .layers
                .len(),
            1
        );
        // 第二次点击：已无可剥离条目，不再产生备份。
        let second = strip_unresolved_entries_in(&profile, &home, None).unwrap();
        assert!(second.layers.is_empty());
        assert_eq!(std::fs::read_dir(&profile).unwrap().count(), 2);
        let _ = std::fs::remove_dir_all(&profile);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// home 层的悬空条目同样被预检与清理（它作用于所有档案）。
    #[test]
    fn home_layer_is_scanned_and_stripped() {
        let profile = tmp_dir("home-strip-profile");
        let home = tmp_dir("home-strip-home");
        std::fs::write(home.join("cordis.patch.yml"), DANGLING_LAYER).unwrap();

        assert_eq!(scan_unresolved_entries_in(&profile, &home, None).len(), 1);
        let report = strip_unresolved_entries_in(&profile, &home, None).unwrap();

        assert_eq!(report.layers.len(), 1);
        assert_eq!(report.layers[0].removed, 1);
        assert!(scan_unresolved_entries_in(&profile, &home, None).is_empty());
        let _ = std::fs::remove_dir_all(&profile);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn message_carries_structured_detail() {
        let entries = vec![UnresolvedPatchEntry {
            layer: "C:/dsh/profiles/web/cordis.patch.yml".to_string(),
            line: 3,
            id: Some("file-edit".to_string()),
            name: "dsh-file-edit".to_string(),
            declared: true,
        }];

        let message = unresolved_entries_message(&entries);

        assert!(message.starts_with(&format!("{PATCH_ENTRY_UNRESOLVED}: ")));
        let payload: serde_json::Value = serde_json::from_str(
            message.trim_start_matches(&format!("{PATCH_ENTRY_UNRESOLVED}: ")),
        )
        .unwrap();
        assert_eq!(payload["entries"][0]["name"], "dsh-file-edit");
        assert_eq!(payload["entries"][0]["line"], 3);
        assert_eq!(payload["entries"][0]["declared"], true);
    }

    #[test]
    fn bare_package_name_rules() {
        assert!(is_bare_package_name("dsh-file-edit"));
        assert!(is_bare_package_name("@scope/plugin"));
        assert!(!is_bare_package_name("./local"));
        assert!(!is_bare_package_name("../local"));
        assert!(!is_bare_package_name("file:///tmp/plugin.js"));
        assert!(!is_bare_package_name("/abs/plugin.js"));
        assert!(!is_bare_package_name("@scope"));
        assert!(!is_bare_package_name("@scope/a/b"));
        assert!(!is_bare_package_name("a/b"));
        assert!(!is_bare_package_name(""));
    }

    #[test]
    fn effective_id_matches_upstream_truthiness() {
        let with_id = |yaml: &str| {
            let doc: Value = serde_yaml::from_str(yaml).unwrap();
            has_effective_id(doc.as_mapping().unwrap())
        };
        assert!(with_id("id: group"));
        assert!(!with_id("id: ''"));
        assert!(!with_id("id: null"));
        assert!(!with_id("name: x"));
        // 上游是 JS 真值判定：false 与 0 同样走「无 id」分支（insert 追加到顶层），
        // 漏判这两个会让本该预检的条目被当成 group 作用域而漏检。
        assert!(!with_id("id: false"));
        assert!(!with_id("id: 0"));
        assert!(with_id("id: true"));
        assert!(with_id("id: 7"));
    }

    /// 原子改写：成功路径不留临时文件，且内容与备份都在。
    #[test]
    fn strip_leaves_no_temp_file_behind() {
        let profile = tmp_dir("atomic-profile");
        let home = tmp_dir("atomic-home");
        std::fs::write(profile.join("cordis.patch.yml"), DANGLING_LAYER).unwrap();

        strip_unresolved_entries_in(&profile, &home, None).unwrap();

        let leftovers: Vec<String> = std::fs::read_dir(&profile)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        let _ = std::fs::remove_dir_all(&profile);
        let _ = std::fs::remove_dir_all(&home);
    }
}
