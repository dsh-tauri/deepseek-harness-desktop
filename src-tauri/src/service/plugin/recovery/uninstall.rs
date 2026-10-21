//! 离线卸载（直接改 profile 清单）：从 manifest 移除依赖与 bundle 引用、
//! 删除 `node_modules/<id>` 入口（含 scoped 空目录清理与路径逃逸防护）、
//! 剥离 `cordis.patch.yml` 中目标插件的 patch 条目。

use std::fs;
#[cfg(windows)]
use std::os::windows::fs::FileTypeExt;
use std::path::Path;

use crate::service::fs_guard;
use crate::service::plugin::{parse_patch_layer, render_patch_layer};

/// 从 manifest 中移除指定插件（`dependencies` + `dsh.profile.bundles`），返回是否有改动。
pub(super) fn remove_plugin_from_manifest(manifest: &mut serde_json::Value, id: &str) -> bool {
    let mut modified = false;
    if let Some(deps) = manifest
        .get_mut("dependencies")
        .and_then(|d| d.as_object_mut())
    {
        if deps.remove(id).is_some() {
            modified = true;
        }
    }
    remove_bundle(manifest, id) || modified
}

pub(crate) fn remove_bundle(manifest: &mut serde_json::Value, id: &str) -> bool {
    let Some(bundles) = manifest
        .get_mut("dsh")
        .and_then(|d| d.get_mut("profile"))
        .and_then(|p| p.get_mut("bundles"))
        .and_then(|b| b.as_array_mut())
    else {
        return false;
    };
    let before = bundles.len();
    bundles.retain(|b| b.as_str() != Some(id));
    bundles.len() != before
}

/// 删除插件入口：符号链接或 junction 只删除入口本身；普通目录递归删除，
/// 普通文件用 `remove_file`（`remove_dir_all` 对文件会报 ENOTDIR）。
fn remove_plugin_entry(entry: &Path) -> std::io::Result<()> {
    let file_type = fs::symlink_metadata(entry)?.file_type();
    #[cfg(windows)]
    if file_type.is_symlink_dir() {
        return fs::remove_dir(entry);
    }
    if file_type.is_symlink() {
        return fs::remove_file(entry);
    }
    if file_type.is_dir() {
        return fs::remove_dir_all(entry);
    }
    fs::remove_file(entry)
}

/// 删除 `node_modules/<id>`；scoped 目录删除后若 scope 空则一并清理。
///
/// 链接入口（符号链接 / Windows junction）只校验父目录、只解链本身：内置插件以
/// `link:` 指向应用资源目录（在 profile 之外），`canonicalize` 会解析到 profile
/// 外并被误判为路径逃逸，导致入口永远删不掉（弃用/孤儿/失效链接卸载的残留根因）。
/// 链接的删除动作不触碰目标，父目录校验已足以保证删除范围仍在 `node_modules` 内。
pub(super) fn remove_plugin_dir(profile: &Path, id: &str) {
    let node_modules = profile.join("node_modules");
    let Ok(node_modules_root) = fs_guard::ensure_within(&node_modules, profile) else {
        log::warn!(
            "refusing to remove plugin from node_modules outside profile: {}",
            node_modules.display()
        );
        return;
    };
    let entry = node_modules.join(id);
    let Ok(entry_metadata) = fs::symlink_metadata(&entry) else {
        return;
    };
    let file_type = entry_metadata.file_type();
    // junction 在 Rust 中同样满足 `is_symlink()`；两个判定都保留，避免行为差异
    // 下把重解析点当成普通目录而递归删进应用资源目录。
    #[cfg(windows)]
    let entry_is_link = file_type.is_symlink() || file_type.is_symlink_dir();
    #[cfg(not(windows))]
    let entry_is_link = file_type.is_symlink();
    if entry_is_link {
        let Some(parent) = entry.parent() else {
            return;
        };
        if let Err(e) = fs_guard::ensure_within(parent, &node_modules_root) {
            log::warn!(
                "refusing to remove plugin link outside node_modules: {} ({e})",
                entry.display()
            );
            return;
        }
    } else if let Err(e) = fs_guard::ensure_within(&entry, &node_modules_root) {
        log::warn!(
            "refusing to remove plugin outside node_modules: {} ({e})",
            entry.display()
        );
        return;
    }
    if let Err(e) = remove_plugin_entry(&entry) {
        if e.kind() != std::io::ErrorKind::NotFound {
            log::warn!("failed to remove plugin dir {}: {e}", entry.display());
        }
    }
    if let Some(scope) = id
        .starts_with('@')
        .then(|| id.split('/').next().unwrap_or_default())
    {
        if !scope.is_empty() && scope != id {
            let scope_entry = node_modules.join(scope);
            if scope_entry.is_dir()
                && scope_entry
                    .read_dir()
                    .map(|mut d| d.next().is_none())
                    .unwrap_or(false)
                && fs_guard::ensure_within(&scope_entry, &node_modules_root).is_ok()
            {
                let _ = remove_plugin_entry(&scope_entry);
            }
        }
    }
}

/// 从 `cordis.patch.yml` 中剥离目标插件的 patch 条目（保留其它插件的 patch）。
///
/// 与 dsh-desktop「直接重置为 []」不同：这里只移除与目标插件相关的条目，不破坏
/// 其它插件的配置层，符合「其它插件不会被删除」的承诺。解析失败则原样保留。
pub(super) fn strip_cordis_patch_for(profile: &Path, id: &str) {
    let path = profile.join("cordis.patch.yml");
    let Ok(content) = fs::read_to_string(&path) else {
        return;
    };
    let Ok(doc) = parse_patch_layer(&content) else {
        return;
    };
    let Some(entries) = doc.as_sequence() else {
        return;
    };
    let kept: Vec<serde_yaml::Value> = entries
        .iter()
        .filter(|e| !patch_entry_targets(e, id))
        .cloned()
        .collect();
    if kept.len() == entries.len() {
        return;
    }
    if let Ok(rendered) = render_patch_layer(&serde_yaml::Value::Sequence(kept)) {
        let _ = fs::write(&path, rendered);
        log::info!("Stripped cordis.patch.yml entries for plugin {id}");
    }
}

/// 一个 patch 条目是否「针对」目标插件：顶层 id 字段或任意字段值等于该包名。
pub(crate) fn patch_entry_targets(entry: &serde_yaml::Value, id: &str) -> bool {
    match entry {
        serde_yaml::Value::Mapping(map) => map
            .iter()
            .any(|(k, v)| k.as_str() == Some(id) || v.as_str() == Some(id)),
        serde_yaml::Value::String(s) => s == id,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remove_bundle_preserves_non_targets_and_reports_only_removal() {
        let mut manifest = serde_json::json!({
            "dependencies": {"target": "1"},
            "dsh": {"profile": {"bundles": ["target", 7, null, {"id": "target"}, "target-extra", "target"]}}
        });
        assert!(remove_bundle(&mut manifest, "target"));
        assert_eq!(manifest["dependencies"], serde_json::json!({"target": "1"}));
        assert_eq!(
            manifest["dsh"]["profile"]["bundles"],
            serde_json::json!([7, null, {"id": "target"}, "target-extra"])
        );
        assert!(!remove_bundle(&mut manifest, "target"));
        for mut malformed in [
            serde_json::json!({}),
            serde_json::json!({"dsh": null}),
            serde_json::json!({"dsh": {"profile": {"bundles": "target"}}}),
            serde_json::json!({"dsh": {"profile": {"bundles": []}}}),
        ] {
            let original = malformed.clone();
            assert!(!remove_bundle(&mut malformed, "target"));
            assert_eq!(malformed, original);
        }
    }

    #[test]
    fn manifest_removal_reports_dependency_only_and_bundle_only_changes() {
        for (mut manifest, expected) in [
            (serde_json::json!({"dependencies": {"target": "1"}}), true),
            (
                serde_json::json!({"dependencies": {"target": "1"}, "dsh": {"profile": {"bundles": ["target"]}}}),
                true,
            ),
            (
                serde_json::json!({"dependencies": null, "dsh": {"profile": {"bundles": ["target"]}}}),
                true,
            ),
            (
                serde_json::json!({"dsh": {"profile": {"bundles": ["target"]}}}),
                true,
            ),
            (
                serde_json::json!({"dependencies": {}, "dsh": {"profile": {"bundles": []}}}),
                false,
            ),
        ] {
            assert_eq!(
                remove_plugin_from_manifest(&mut manifest, "target"),
                expected
            );
            assert!(!remove_plugin_from_manifest(&mut manifest, "target"));
        }
    }

    #[test]
    fn patch_targets_match_only_exact_top_level_strings() {
        for (yaml, expected) in [
            ("target", true),
            ("id: target", true),
            ("target: null", true),
            ("alias: target", true),
            ("id: target-extra", false),
            ("config: {id: target}", false),
            ("- target", false),
            ("null", false),
            ("42", false),
        ] {
            let entry = serde_yaml::from_str(yaml).unwrap();
            assert_eq!(patch_entry_targets(&entry, "target"), expected, "{yaml}");
        }
    }

    #[test]
    fn remove_plugin_dir_rejects_path_escape() {
        let root = std::env::temp_dir().join(format!("dsh-plugin-recovery-{}", std::process::id()));
        let profile = root.join("profile");
        std::fs::create_dir_all(profile.join("node_modules/foo")).unwrap();
        let outside = profile.join("target");
        std::fs::create_dir_all(&outside).unwrap();

        remove_plugin_dir(&profile, "foo/../../target");

        assert!(outside.exists(), "path traversal target must remain");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn remove_plugin_dir_removes_valid_plugin() {
        let root =
            std::env::temp_dir().join(format!("dsh-plugin-recovery-valid-{}", std::process::id()));
        let profile = root.join("profile");
        let plugin = profile.join("node_modules/dsh-example");
        std::fs::create_dir_all(&plugin).unwrap();
        std::fs::write(plugin.join("index.js"), "module.exports = {};").unwrap();

        remove_plugin_dir(&profile, "dsh-example");

        assert!(!plugin.exists(), "valid plugin directory should be removed");
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn remove_plugin_dir_removes_symlink_without_target() {
        let root = std::env::temp_dir().join(format!(
            "dsh-plugin-recovery-pnpm-symlink-{}",
            std::process::id()
        ));
        let profile = root.join("profile");
        let link = profile.join("node_modules/dsh-example");
        let target = profile.join("node_modules/.pnpm/dsh-example@1/node_modules/dsh-example");
        std::fs::create_dir_all(&target).unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();

        remove_plugin_dir(&profile, "dsh-example");

        assert!(target.exists(), "pnpm canonical target must remain");
        assert!(
            std::fs::symlink_metadata(&link).is_err(),
            "only the package symlink entry should be removed"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn remove_plugin_dir_removes_dangling_symlink() {
        let root = std::env::temp_dir().join(format!(
            "dsh-plugin-recovery-dangling-symlink-{}",
            std::process::id()
        ));
        let profile = root.join("profile");
        let link = profile.join("node_modules/dsh-example");
        let missing_target = profile.join("node_modules/.pnpm/missing/dsh-example");
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&missing_target, &link).unwrap();

        remove_plugin_dir(&profile, "dsh-example");

        assert!(
            std::fs::symlink_metadata(&link).is_err(),
            "dangling plugin symlink entry should be removed"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn remove_plugin_dir_unlinks_junction_pointing_outside_profile() {
        // 内置插件以 link: 指向应用资源目录（在 profile 之外，如 dsh-tauri-panel）：
        // junction 的 canonicalize 落在 profile 外，仍必须只解链入口、绝不动目标。
        let root = std::env::temp_dir().join(format!(
            "dsh-plugin-recovery-junction-{}",
            std::process::id()
        ));
        let profile = root.join("profile");
        let target = root.join("app-resources/dsh-tauri-panel");
        let entry = profile.join("node_modules/dsh-tauri-panel");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&target).unwrap();
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::fs::write(target.join("package.json"), "{}").unwrap();

        use std::os::windows::process::CommandExt;
        let created = std::process::Command::new("cmd")
            .arg("/C")
            .raw_arg(format!(
                "mklink /J \"{}\" \"{}\"",
                entry.display(),
                target.display()
            ))
            .status()
            .expect("mklink should run");
        assert!(created.success(), "junction creation should succeed");

        remove_plugin_dir(&profile, "dsh-tauri-panel");

        assert!(
            std::fs::symlink_metadata(&entry).is_err(),
            "junction entry should be unlinked"
        );
        assert!(
            target.join("package.json").is_file(),
            "junction target must remain"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn remove_plugin_dir_rejects_node_modules_symlink_escape() {
        let root =
            std::env::temp_dir().join(format!("dsh-plugin-recovery-link-{}", std::process::id()));
        let profile = root.join("profile");
        let outside = root.join("outside-node-modules");
        let plugin = outside.join("dsh-example");
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::create_dir_all(&plugin).unwrap();
        std::os::unix::fs::symlink(&outside, profile.join("node_modules")).unwrap();

        remove_plugin_dir(&profile, "dsh-example");

        assert!(plugin.exists(), "plugin outside profile must remain");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn remove_plugin_from_manifest_edits_deps_and_bundles() {
        let mut manifest = serde_json::json!({
            "name": "dsh-profile-web",
            "private": true,
            "dependencies": { "dshmarker": "1.0.0", "dsh-better-sidebar": "1.0.0" },
            "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-better-sidebar"] } }
        });
        let modified = remove_plugin_from_manifest(&mut manifest, "dsh-better-sidebar");
        assert!(modified);
        assert!(manifest["dependencies"].get("dsh-better-sidebar").is_none());
        assert!(manifest["dependencies"].get("dshmarker").is_some());
        assert_eq!(
            manifest["dsh"]["profile"]["bundles"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn patch_strip_targets_plugin_only() {
        let patch = serde_yaml::to_string(&serde_yaml::Value::Sequence(vec![
            serde_yaml::from_str::<serde_yaml::Value>("id: dsh-better-sidebar\nfoo: 1").unwrap(),
            serde_yaml::from_str::<serde_yaml::Value>("id: dsh-web-ui-all\nbar: 2").unwrap(),
        ]))
        .unwrap();
        let doc: serde_yaml::Value = serde_yaml::from_str(&patch).unwrap();
        let kept: Vec<serde_yaml::Value> = doc
            .as_sequence()
            .unwrap()
            .iter()
            .filter(|e| !patch_entry_targets(e, "dsh-better-sidebar"))
            .cloned()
            .collect();
        assert_eq!(kept.len(), 1);
        let kept_doc = serde_yaml::to_string(&serde_yaml::Value::Sequence(kept)).unwrap();
        assert!(kept_doc.contains("dsh-web-ui-all"));
        assert!(!kept_doc.contains("dsh-better-sidebar"));
    }

    #[test]
    fn patch_strip_keeps_js_expressions_of_other_entries() {
        let profile = tempfile::tempdir().unwrap();
        let patch = profile.path().join("cordis.patch.yml");
        std::fs::write(
            &patch,
            "- id: dsh-better-sidebar\n  foo: 1\n- id: dshmarket\n  config:\n    token: !!js process.env.TOKEN\n",
        )
        .unwrap();

        strip_cordis_patch_for(profile.path(), "dsh-better-sidebar");

        assert_eq!(
            std::fs::read_to_string(&patch).unwrap(),
            "- id: dshmarket\n  config:\n    token: !!js process.env.TOKEN\n"
        );
    }
}
