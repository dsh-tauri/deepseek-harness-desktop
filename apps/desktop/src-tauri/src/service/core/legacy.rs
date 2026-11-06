use crate::service::fs_guard;
use crate::{AppHandle, config};
use std::path::Path;

pub(crate) fn is_directory_core(root: &Path) -> bool {
    root.is_dir()
        && config::core_archive_in(root).is_none()
        && (root.join("node_modules").is_dir()
            || root.join(config::DSH_MANIFEST_RELATIVE).is_file()
            || root.join("lib/bin.js").is_file())
}

fn legacy_identity(root: &Path, recorded_tag: Option<&str>) -> String {
    if let Some(tag) = recorded_tag.filter(|tag| {
        (tag.starts_with("dsh-") || tag.starts_with("src-")) && fs_guard::validate_id(tag).is_ok()
    }) {
        return tag.to_string();
    }
    let version = config::dsh_version_at(&config::manifest_in(root))
        .filter(|version| semver::Version::parse(version).is_ok())
        .unwrap_or_else(|| "unknown".to_string());
    format!("dsh-{version}")
}

pub(super) fn preserve_directory_core(root: &Path, deps: &Path, tag: &str) -> Result<(), String> {
    fs_guard::validate_id(tag)?;
    let slot = deps.join(tag);
    if root == slot || !is_directory_core(root) {
        return Ok(());
    }
    let mut target = slot;
    let mut suffix = 0;
    while target.exists() {
        target = deps.join(if suffix == 0 {
            format!(".retired-{tag}")
        } else {
            format!(".retired-{tag}-{suffix}")
        });
        suffix += 1;
    }
    std::fs::rename(root, &target).map_err(|error| {
        format!(
            "CORE_LEGACY_RENAME_FAILED: {} -> {}: {error}",
            root.display(),
            target.display()
        )
    })?;
    log::warn!(
        "CORE_LEGACY_DIRECTORY_CORE: preserved {} at {}",
        root.display(),
        target.display()
    );
    Ok(())
}

pub fn retire_directory_core<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let deps = config::get_base_dir(app).join("dependencies");
    let default = deps.join("dsh");
    let active = config::dependencies::active_root(app, config::dependencies::DEP_DSH);
    let active_legacy = is_directory_core(&active);
    if !active_legacy && !is_directory_core(&default) {
        return Ok(());
    }
    let resources = config::manifest::resource_root(app);
    let local = super::local::local_core(app).map(|core| core.package_dir);
    let recorded_tag = config::get_store_dat_setting(app).dsh_pkg_tag;
    for root in [&active, &default] {
        if !is_directory_core(root) {
            continue;
        }
        let real = dunce::canonicalize(root)
            .map_err(|error| format!("CORE_LEGACY_PATH_FAILED: {error}"))?;
        let owned =
            dunce::canonicalize(&deps).is_ok_and(|deps| real.parent() == Some(deps.as_path()));
        let protected = resources.as_ref().is_some_and(|resources| {
            dunce::canonicalize(resources).is_ok_and(|resources| real.starts_with(resources))
        }) || local.as_ref().is_some_and(|local| {
            dunce::canonicalize(local)
                .is_ok_and(|local| real.starts_with(&local) || local.starts_with(&real))
        });
        if owned && !protected {
            let tag = legacy_identity(
                root,
                (root == &active)
                    .then_some(recorded_tag.as_deref())
                    .flatten(),
            );
            preserve_directory_core(root, &deps, &tag)?;
        }
    }
    if active_legacy {
        std::fs::create_dir_all(&default)
            .map_err(|error| format!("CORE_LEGACY_PATH_FAILED: {error}"))?;
        config::dependencies::record(app, config::dependencies::DEP_DSH, Some(default));
        config::update_store_dat_setting(app, |setting| {
            if setting.active_core.as_deref() != Some("local") {
                setting.active_core = None;
            }
            setting.dsh_pkg_tag = None;
            setting.dsh_pkg_commit = None;
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preservation_keeps_conflicting_slots_and_is_idempotent() {
        let temp = tempfile::tempdir().unwrap();
        let deps = temp.path();
        let root = deps.join("dsh");
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::write(root.join("marker"), "selected").unwrap();
        let tag = "dsh-0.2.2-rc.1-123";
        for name in [tag.to_string(), format!(".retired-{tag}")] {
            std::fs::create_dir_all(deps.join(&name)).unwrap();
            std::fs::write(deps.join(name).join("marker"), "existing").unwrap();
        }
        preserve_directory_core(&root, deps, tag).unwrap();
        preserve_directory_core(&root, deps, tag).unwrap();
        assert_eq!(
            std::fs::read_to_string(deps.join(tag).join("marker")).unwrap(),
            "existing"
        );
        assert_eq!(
            std::fs::read_to_string(deps.join(format!(".retired-{tag}")).join("marker")).unwrap(),
            "existing"
        );
        assert_eq!(
            std::fs::read_to_string(deps.join(format!(".retired-{tag}-1")).join("marker")).unwrap(),
            "selected"
        );
        assert!(!root.exists());
    }
}
