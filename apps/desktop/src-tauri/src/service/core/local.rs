use crate::AppHandle;
use crate::service::cli;
use std::path::{Path, PathBuf};
#[cfg(unix)]
use tauri::Manager;
use tauri::Runtime;

pub(super) struct LocalCore {
    pub(super) package_dir: PathBuf,
    pub(super) version: String,
    pub(super) bin: PathBuf,
}

/// 与本应用 shim 目录相同），若整目录跳过会误判为"无本地 dsh"（issue #54）。
pub(super) fn find_user_dsh_bin<R: Runtime>(app_handle: &AppHandle<R>) -> Option<PathBuf> {
    let candidates: &[&str] = if cfg!(windows) {
        &["dsh.cmd", "dsh.exe", "dsh.bat"]
    } else {
        &["dsh"]
    };

    if let Some(cli_path) = std::env::var_os("DSH_CLI_PATH") {
        let p = PathBuf::from(cli_path);
        let matches = p
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| candidates.contains(&n))
            .unwrap_or(false);
        if matches && p.is_file() {
            return Some(p);
        }
    }

    let path_dirs: Vec<PathBuf> =
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .filter(|dir| !dir.as_os_str().is_empty())
            .collect();

    #[cfg(unix)]
    let dirs: Vec<PathBuf> = {
        let mut dirs = path_dirs;
        if let Ok(home) = app_handle.path().home_dir() {
            dirs.push(home.join(".local").join("bin"));
            append_unix_dsh_dirs(&mut dirs, &home);
        }
        #[cfg(target_os = "macos")]
        dirs.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ]);
        dirs
    };

    // 补不到这份环境，导致 fnm 全局安装的 `dsh` 漏检（issue #229）。因此在
    #[cfg(windows)]
    let dirs = {
        let _ = &app_handle;
        let mut dirs = path_dirs;
        append_windows_dsh_dirs(&mut dirs);
        dirs
    };

    scan_dirs_for_user_dsh(&dirs, candidates)
}

fn scan_dirs_for_user_dsh(dirs: &[PathBuf], candidates: &[&str]) -> Option<PathBuf> {
    for dir in dirs {
        for name in candidates {
            let candidate = dir.join(name);
            if candidate.is_file() && !cli::is_generated_shim(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

/// 覆盖的布局（issue #302 只修了 Windows，Unix 侧漏检，见 issue #229 / #443）：
#[cfg(unix)]
fn append_unix_dsh_dirs(dirs: &mut Vec<PathBuf>, home: &Path) {
    let mut append = |dir: PathBuf| {
        if dir.is_absolute() && dir.is_dir() && !dirs.contains(&dir) {
            dirs.push(dir);
        }
    };

    append(home.join(".volta").join("bin"));
    append(home.join(".asdf").join("shims"));

    append_version_dirs(
        &mut append,
        &home.join(".nvm").join("versions").join("node"),
    );

    let xdg = std::env::var_os("XDG_DATA_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from);
    for root in fnm_version_roots(home, xdg.as_deref()) {
        append_version_dirs(&mut append, &root);
    }
}

#[cfg(unix)]
fn fnm_version_roots(home: &Path, xdg_data_home: Option<&Path>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(xdg) = xdg_data_home {
        roots.push(xdg.join("fnm").join("node-versions"));
    }
    roots.push(
        home.join(".local")
            .join("share")
            .join("fnm")
            .join("node-versions"),
    );
    roots.push(
        home.join("Library")
            .join("Application Support")
            .join("fnm")
            .join("node-versions"),
    );
    roots
}

#[cfg(unix)]
fn append_version_dirs(append: &mut impl FnMut(PathBuf), root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let mut versions: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    versions.sort_by_key(|dir| std::cmp::Reverse(version_key(dir)));
    for version in versions {
        append(version.join("bin"));
        append(version.join("installation").join("bin"));
    }
}

#[cfg(unix)]
fn version_key(dir: &Path) -> (Option<semver::Version>, String) {
    let name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();
    let parsed = semver::Version::parse(name.trim_start_matches('v')).ok();
    (parsed, name)
}

///   见 issue #229；`~/.fnm` 在 Windows 上极少使用，本函数只在 LOCALAPPDATA 下探测）。
#[cfg(windows)]
fn append_windows_dsh_dirs(dirs: &mut Vec<PathBuf>) {
    let mut append = |dir: PathBuf| {
        if dir.is_absolute() && dir.is_dir() && !dirs.contains(&dir) {
            dirs.push(dir);
        }
    };

    if let Some(appdata) = std::env::var_os("APPDATA") {
        append(PathBuf::from(appdata).join("npm"));
    }
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        let fnm_versions = PathBuf::from(&local_app_data)
            .join("fnm")
            .join("node-versions");
        if let Ok(entries) = std::fs::read_dir(&fnm_versions) {
            for entry in entries.flatten() {
                let installation = entry.path().join("installation");
                if installation.is_dir() {
                    append(installation.join("node_modules").join(".bin"));
                    append(installation.join("bin"));
                    append(installation);
                }
            }
        }
    }
}

fn probe_package_dir(prefix: &Path) -> Option<PathBuf> {
    let p = prefix.join("node_modules").join("@deepseek-ai").join("dsh");
    p.join("package.json").is_file().then_some(p)
}

fn prefix_candidates(bin: &Path) -> Vec<PathBuf> {
    let Some(bin_dir) = bin.parent() else {
        return Vec::new();
    };
    let mut prefixes = vec![bin_dir.to_path_buf()];
    let dir_name = bin_dir.file_name().and_then(|n| n.to_str());
    if dir_name == Some("bin") {
        if let Some(parent) = bin_dir.parent() {
            prefixes.push(parent.to_path_buf());
        }
    }
    if dir_name == Some(".bin")
        && bin_dir
            .parent()
            .and_then(|n| n.file_name())
            .and_then(|n| n.to_str())
            == Some("node_modules")
    {
        if let Some(prefix) = bin_dir.parent().and_then(Path::parent) {
            prefixes.push(prefix.to_path_buf());
        }
    }
    prefixes
}

fn user_dsh_package_dir<R: Runtime>(app_handle: &AppHandle<R>) -> Option<PathBuf> {
    let bin = find_user_dsh_bin(app_handle)?;
    package_dir_from_bin(&bin)
}

fn package_dir_from_bin(bin: &Path) -> Option<PathBuf> {
    let prefixes = prefix_candidates(bin);
    for prefix in &prefixes {
        if let Some(dir) = probe_package_dir(prefix) {
            return Some(dir);
        }
        if let Some(dir) = probe_package_dir(&prefix.join("lib")) {
            return Some(dir);
        }
    }
    for prefix in &prefixes {
        if let Ok(entries) = std::fs::read_dir(prefix.join("global")) {
            for entry in entries.flatten() {
                if let Some(dir) = probe_package_dir(&entry.path()) {
                    return Some(dir);
                }
            }
        }
    }
    None
}

fn read_package_version(dir: &Path) -> Option<String> {
    let content = std::fs::read_to_string(dir.join("package.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&content).ok()?;
    v.get("version")
        .and_then(|v| v.as_str())
        .map(|s| s.trim_start_matches('v').to_string())
}

fn has_link_in_path(path: &Path, base: &Path) -> bool {
    path.ancestors().take_while(|ancestor| *ancestor != base).any(|path| {
        std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink())
    })
}

fn managed_folder_core(slot: &Path) -> Option<PathBuf> {
    let package = slot.join("node_modules/@deepseek-ai/dsh");
    if has_link_in_path(&package, slot) {
        return None;
    }
    let manifest = package.join("package.json");
    let bin = package.join("lib/bin.js");
    let Ok(metadata) = std::fs::symlink_metadata(&manifest) else {
        return None;
    };
    if metadata.file_type().is_symlink() || !bin.is_file() {
        return None;
    }
    let name = std::fs::read_to_string(manifest)
        .ok()
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .and_then(|value| {
            value
                .get("name")
                .and_then(|name| name.as_str())
                .map(str::to_owned)
        });
    (name.as_deref() == Some("@deepseek-ai/dsh")).then_some(package)
}

fn protected_slot(slot: &Path, protected: &[PathBuf]) -> bool {
    protected.iter().any(|root| {
        dunce::canonicalize(root)
            .ok()
            .zip(dunce::canonicalize(slot).ok())
            .is_some_and(|(root, slot)| slot.starts_with(&root) || root.starts_with(&slot))
    })
}

pub(crate) async fn cleanup_active_folder_core(
    slot: &Path,
    allowed_root: &Path,
    protected: &[PathBuf],
) -> Result<(), String> {
    let Some(package) = managed_folder_core(slot) else {
        return Ok(());
    };
    if slot.join(crate::config::DSH_ASAR_FILE).is_file() {
        return Ok(());
    }
    let safe = crate::service::fs_guard::ensure_within(&package, allowed_root)?;
    if protected_slot(&safe, protected) {
        return Err(format!("CORE_CLEANUP_PROTECTED: {}", safe.display()));
    }
    if !crate::service::download::remove_dir_with_retry(&safe).await {
        return Err(format!("CORE_CLEANUP_FAILED: {}", safe.display()));
    }
    Ok(())
}

pub(crate) async fn cleanup_other_folder_cores(
    deps_root: &Path,
    active_slot: &Path,
    protected: &[PathBuf],
) {
    let Ok(entries) = std::fs::read_dir(deps_root) else {
        return;
    };
    for entry in entries.flatten() {
        let slot = entry.path();
        if slot == active_slot
            || std::fs::symlink_metadata(&slot)
                .is_ok_and(|metadata| metadata.file_type().is_symlink())
            || slot.join(crate::config::DSH_ASAR_FILE).is_file()
            || protected_slot(&slot, protected)
        {
            continue;
        }
        let Some(package) = managed_folder_core(&slot) else {
            continue;
        };
        let safe = match crate::service::fs_guard::ensure_within(&package, deps_root) {
            Ok(path) if !protected_slot(&path, protected) => path,
            _ => continue,
        };
        if !crate::service::download::remove_dir_with_retry(&safe).await {
            log::warn!("CORE_CLEANUP_SLOT_FAILED: {}", safe.display());
        }
    }
}

pub(super) fn local_core<R: Runtime>(app_handle: &AppHandle<R>) -> Option<LocalCore> {
    let package_dir = user_dsh_package_dir(app_handle)?;
    let version = read_package_version(&package_dir)?;
    let bin = package_dir.join("lib").join("bin.js");
    if !bin.is_file() {
        return None;
    }
    Some(LocalCore {
        package_dir,
        version,
        bin,
    })
}

pub fn local_core_package_dir(app_handle: &AppHandle) -> Option<PathBuf> {
    local_core(app_handle).map(|c| c.package_dir)
}

fn local_core_uses_pnpm<R: Runtime>(app_handle: &AppHandle<R>) -> bool {
    let Some(bin) = find_user_dsh_bin(app_handle) else {
        return false;
    };
    let prefixes = prefix_candidates(&bin);
    let npm_layout = prefixes
        .iter()
        .any(|p| probe_package_dir(p).is_some() || probe_package_dir(&p.join("lib")).is_some());
    let pnpm_layout = prefixes.iter().any(|p| {
        std::fs::read_dir(p.join("global"))
            .map(|entries| {
                entries
                    .flatten()
                    .any(|e| probe_package_dir(&e.path()).is_some())
            })
            .unwrap_or(false)
    });
    !npm_layout && pnpm_layout
}

pub async fn update_local_core<R: Runtime>(app_handle: AppHandle<R>) -> Result<String, String> {
    let _transition_guard = crate::service::workflow::acquire_core_transition().await?;
    crate::service::workflow::instances::require_exclusive_profile()?;
    let Some(core) = local_core(&app_handle) else {
        return Err("CORE_LOCAL_NOT_FOUND: no local core to update".to_string());
    };
    if super::source::active_source(&app_handle) != super::source::CoreSource::App {
        return Err(
            "CORE_LOCAL_UPDATE_REQUIRES_APP: switch to a supported managed core before updating the local core"
                .to_string(),
        );
    }
    let managed_version = crate::config::get_dsh_version(&app_handle)
        .as_deref()
        .and_then(|version| semver::Version::parse(version).ok());
    let minimum = crate::config::manifest::minimum_dsh_version(&app_handle)
        .as_deref()
        .and_then(|version| semver::Version::parse(version).ok());
    if !crate::config::dependencies::binary_present(
        &app_handle,
        crate::config::dependencies::DEP_DSH,
    ) || !managed_version
        .zip(minimum)
        .is_some_and(|(version, minimum)| version >= minimum)
    {
        return Err(
            "CORE_LOCAL_UPDATE_REQUIRES_APP: a supported managed core must be installed before updating the local core"
                .to_string(),
        );
    }
    crate::config::update_store_dat_setting(&app_handle, |setting| {
        setting.active_core = Some(super::source::CoreSource::App.as_str().to_string());
    });
    log::info!("Updating local dsh core at {}", core.package_dir.display());

    let uses_pnpm = local_core_uses_pnpm(&app_handle);
    let (pm, action) = if uses_pnpm {
        ("pnpm", "add")
    } else {
        ("npm", "install")
    };

    let program = if cfg!(windows) {
        format!("{pm}.cmd")
    } else {
        pm.to_string()
    };
    let (target_version, status, stdout, stderr) =
        tauri::async_runtime::spawn_blocking(move || {
            let mut query = std::process::Command::new(&program);
            query.args([
                "view",
                "@deepseek-ai/dsh@latest",
                "version",
                "--json",
                "--prefer-online",
            ]);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                query.creation_flags(0x0800_0000);
            }
            let output = query
                .output()
                .map_err(|e| format!("CORE_UPDATE_TARGET_FAILED: {e}"))?;
            if !output.status.success() {
                return Err(format!(
                    "CORE_UPDATE_TARGET_FAILED: {}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
            let metadata: serde_json::Value = serde_json::from_slice(&output.stdout)
                .map_err(|e| format!("CORE_UPDATE_TARGET_INVALID: {e}"))?;
            let target_version = match &metadata {
                serde_json::Value::String(version) => Some(version.as_str()),
                serde_json::Value::Array(versions) if versions.len() == 1 => versions[0].as_str(),
                _ => None,
            }
            .ok_or_else(|| "CORE_UPDATE_TARGET_INVALID: expected one version".to_string())?
            .to_string();
            semver::Version::parse(&target_version)
                .map_err(|e| format!("CORE_UPDATE_TARGET_INVALID: {e}"))?;
            let package = format!("@deepseek-ai/dsh@{target_version}");
            log::info!("Updating local dsh core via `{pm} {action} -g {package}`");
            let mut cmd = std::process::Command::new(&program);
            cmd.args([action, "-g", &package]);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            }
            match cmd.output() {
                Ok(out) => Ok((target_version, out.status.success(), out.stdout, out.stderr)),
                Err(e) => Err(format!("CORE_UPDATE_FAILED: spawn failed: {e}")),
            }
        })
        .await
        .map_err(|e| format!("CORE_UPDATE_JOIN: {e}"))??;

    let tail = |bytes: Vec<u8>| -> String {
        String::from_utf8_lossy(&bytes)
            .lines()
            .filter(|l| !l.trim().is_empty())
            .rev()
            .take(12)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n")
    };

    if !status {
        let output = tail(stdout.into_iter().chain(stderr).collect());
        return Err(format!("CORE_UPDATE_FAILED: {output}"));
    }

    let version = local_core(&app_handle).map(|c| c.version);
    if version.as_deref() != Some(target_version.as_str()) {
        return Err(format!(
            "CORE_UPDATE_VERSION_MISMATCH: expected {target_version}, detected {} at {}",
            version.as_deref().unwrap_or("unknown"),
            core.package_dir.display(),
        ));
    }
    Ok(target_version)
}

#[cfg(test)]
#[path = "local_update_tests.rs"]
mod local_update_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn write_managed_core(slot: &Path) -> PathBuf {
        let package = slot.join("node_modules/@deepseek-ai/dsh");
        std::fs::create_dir_all(package.join("lib")).unwrap();
        std::fs::write(
            package.join("package.json"),
            r#"{"name":"@deepseek-ai/dsh","version":"legacy-folder"}"#,
        )
        .unwrap();
        std::fs::write(package.join("lib/bin.js"), "").unwrap();
        package
    }

    #[tokio::test]
    async fn managed_folder_cleanup_uses_identity_and_preserves_asar_and_symlink_targets() {
        let temp = tempfile::tempdir().unwrap();
        let deps = temp.path().join("dependencies");
        let active = deps.join("dsh");
        let old_slot = deps.join("release-slot-without-semver");
        let asar_slot = deps.join("release-slot-with-asar");
        let outside = temp.path().join("outside");
        std::fs::create_dir_all(&active).unwrap();
        std::fs::create_dir_all(&asar_slot).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let active_package = write_managed_core(&active);
        let old_package = write_managed_core(&old_slot);
        let asar_package = write_managed_core(&asar_slot);
        std::fs::write(active.join(crate::config::DSH_ASAR_FILE), "archive").unwrap();
        std::fs::write(asar_slot.join(crate::config::DSH_ASAR_FILE), "archive").unwrap();
        std::fs::write(outside.join("sentinel"), "keep").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            symlink(&outside, deps.join("linked-slot")).unwrap();
        }
        std::fs::create_dir_all(&deps).unwrap();
        cleanup_active_folder_core(&active, &deps, &[])
            .await
            .unwrap();
        assert!(active_package.exists());
        assert!(active.join(crate::config::DSH_ASAR_FILE).is_file());
        cleanup_other_folder_cores(&deps, &active, &[]).await;
        assert!(!old_package.exists());
        assert!(asar_package.exists());
        assert_eq!(
            std::fs::read_to_string(outside.join("sentinel")).unwrap(),
            "keep"
        );
    }

    #[test]
    fn read_package_version_parses_manifest() {
        let dir = std::env::temp_dir().join(format!("dsh-core-ver-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("package.json"),
            r#"{"name":"@deepseek-ai/dsh","version":"0.1.0-rc.8"}"#,
        )
        .unwrap();
        assert_eq!(read_package_version(&dir).as_deref(), Some("0.1.0-rc.8"));
        std::fs::remove_dir_all(&dir).ok();
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dsh-core-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn write_foreign_dsh(dir: &std::path::Path) -> std::path::PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let p = dir.join("dsh");
        std::fs::write(&p, "#!/bin/sh\necho user dsh\n").unwrap();
        p
    }

    fn write_our_shim(dir: &std::path::Path) -> std::path::PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let p = dir.join("dsh");
        std::fs::write(
            &p,
            "# DeepSeek Harness Desktop - dsh command shim (generated)\n",
        )
        .unwrap();
        p
    }

    /// issue #54：本应用 shim 目录（Unix `~/.local/bin`）下用户自行安装的 dsh
    #[test]
    fn scan_dir_finds_foreign_dsh_inside_shim_dir() {
        let dir = temp_dir("foreign-in-shim");
        let dsh = write_foreign_dsh(&dir);
        assert_eq!(
            scan_dirs_for_user_dsh(std::slice::from_ref(&dir), &["dsh"]),
            Some(dsh)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_dir_skips_our_own_shim() {
        let shim_dir = temp_dir("our-shim");
        let bin_dir = temp_dir("foreign-bin");
        let ours = write_our_shim(&shim_dir);
        let theirs = write_foreign_dsh(&bin_dir);
        assert_eq!(
            scan_dirs_for_user_dsh(std::slice::from_ref(&shim_dir), &["dsh"]),
            None
        );
        assert_eq!(
            scan_dirs_for_user_dsh(&[shim_dir.clone(), bin_dir.clone()], &["dsh"]),
            Some(theirs)
        );
        let _ = ours;
        let _ = std::fs::remove_dir_all(&shim_dir);
        let _ = std::fs::remove_dir_all(&bin_dir);
    }

    #[test]
    fn is_generated_shim_detects_marker() {
        let dir = temp_dir("marker");
        let ours = write_our_shim(&dir.join("ours"));
        let theirs = write_foreign_dsh(&dir.join("theirs"));
        assert!(cli::is_generated_shim(&ours));
        assert!(!cli::is_generated_shim(&theirs));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prefix_candidates_include_bin_parent() {
        let root = temp_dir("prefix-candidates");
        let bin = root.join("bin").join("dsh");
        let candidates = prefix_candidates(&bin);
        assert_eq!(candidates, vec![root.join("bin"), root.clone()]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn package_dir_from_bin_resolves_npm_lib_layout() {
        let root = temp_dir("npm-lib");
        let pkg = root
            .join("lib")
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(
            pkg.join("package.json"),
            r#"{"name":"@deepseek-ai/dsh","version":"0.1.0-rc.8"}"#,
        )
        .unwrap();
        std::fs::write(pkg.join("bin.js"), "").unwrap();
        let bin = root.join("bin").join("dsh");
        assert_eq!(
            package_dir_from_bin(&bin),
            Some(
                root.join("lib")
                    .join("node_modules")
                    .join("@deepseek-ai")
                    .join("dsh")
            )
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn package_dir_from_bin_resolves_npm_flat_layout() {
        let root = temp_dir("npm-flat");
        let pkg = root.join("node_modules").join("@deepseek-ai").join("dsh");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(
            pkg.join("package.json"),
            r#"{"name":"@deepseek-ai/dsh","version":"0.1.0-rc.8"}"#,
        )
        .unwrap();
        let bin = root.join("dsh.cmd");
        assert_eq!(
            package_dir_from_bin(&bin),
            Some(root.join("node_modules").join("@deepseek-ai").join("dsh"))
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// `<prefix>/node_modules/@deepseek-ai/dsh`（issue #229）。包目录解析必须能从
    #[test]
    fn package_dir_from_bin_resolves_fnm_node_modules_bin_layout() {
        let root = temp_dir("fnm-bin-layout");
        let pkg = root.join("node_modules").join("@deepseek-ai").join("dsh");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(
            pkg.join("package.json"),
            r#"{"name":"@deepseek-ai/dsh","version":"0.1.0-rc.8"}"#,
        )
        .unwrap();
        let bin = root.join("node_modules").join(".bin").join("dsh.cmd");
        assert_eq!(
            package_dir_from_bin(&bin),
            Some(root.join("node_modules").join("@deepseek-ai").join("dsh"))
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn prefix_candidates_include_grandparent_of_node_modules_bin() {
        let root = temp_dir("fnm-prefix-candidates");
        let bin = root.join("node_modules").join(".bin").join("dsh.cmd");
        let candidates = prefix_candidates(&bin);
        assert!(candidates.contains(&root));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// issue #229 / #443：nvm 全局安装的 `dsh` 必须被发现——GUI 进程拿不到
    #[cfg(unix)]
    #[test]
    fn append_unix_dirs_finds_nvm_version_bins_newest_first() {
        let home = temp_dir("unix-nvm");
        let older = home.join(".nvm/versions/node/v22.19.0/bin");
        let newer = home.join(".nvm/versions/node/v24.19.0/bin");
        std::fs::create_dir_all(&older).unwrap();
        std::fs::create_dir_all(&newer).unwrap();

        let mut dirs: Vec<PathBuf> = Vec::new();
        append_unix_dsh_dirs(&mut dirs, &home);

        let newer_pos = dirs.iter().position(|d| d == &newer);
        let older_pos = dirs.iter().position(|d| d == &older);
        assert!(newer_pos.is_some(), "较新版本 bin 未纳入: {dirs:?}");
        assert!(older_pos.is_some(), "较旧版本 bin 未纳入: {dirs:?}");
        assert!(newer_pos < older_pos, "较新版本应先于较旧版本: {dirs:?}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[cfg(unix)]
    #[test]
    fn append_unix_dirs_covers_volta_asdf_and_skips_missing() {
        let home = temp_dir("unix-managers");
        let volta = home.join(".volta/bin");
        let asdf = home.join(".asdf/shims");
        std::fs::create_dir_all(&volta).unwrap();
        std::fs::create_dir_all(&asdf).unwrap();

        let mut dirs: Vec<PathBuf> = Vec::new();
        append_unix_dsh_dirs(&mut dirs, &home);

        assert!(dirs.contains(&volta), "volta bin 未纳入: {dirs:?}");
        assert!(dirs.contains(&asdf), "asdf shims 未纳入: {dirs:?}");
        assert!(
            !dirs.iter().any(|d| d.ends_with("node-versions")),
            "不应追加不存在的根目录"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[cfg(unix)]
    #[test]
    fn append_unix_dirs_finds_fnm_installation_bin() {
        let home = temp_dir("unix-fnm");
        let installation = home.join(".local/share/fnm/node-versions/v24.19.0/installation/bin");
        std::fs::create_dir_all(&installation).unwrap();

        let mut dirs: Vec<PathBuf> = Vec::new();
        append_unix_dsh_dirs(&mut dirs, &home);

        assert!(
            dirs.contains(&installation),
            "fnm installation bin 未纳入: {dirs:?}"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[cfg(unix)]
    #[test]
    fn append_unix_dirs_finds_fnm_macos_installation_bin() {
        let home = temp_dir("unix-fnm-macos");
        let installation =
            home.join("Library/Application Support/fnm/node-versions/v24.19.0/installation/bin");
        std::fs::create_dir_all(&installation).unwrap();

        let mut dirs: Vec<PathBuf> = Vec::new();
        append_unix_dsh_dirs(&mut dirs, &home);

        assert!(
            dirs.contains(&installation),
            "macOS fnm installation bin 未纳入: {dirs:?}"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[cfg(unix)]
    #[test]
    fn fnm_version_roots_includes_xdg_data_home() {
        let home = temp_dir("unix-fnm-xdg");
        let xdg = temp_dir("unix-fnm-xdg-root");
        let roots = fnm_version_roots(&home, Some(&xdg));
        assert!(
            roots.contains(&xdg.join("fnm").join("node-versions")),
            "XDG 根未纳入候选: {roots:?}"
        );
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&xdg);
    }

    #[cfg(unix)]
    #[test]
    fn append_version_dirs_orders_semantically_not_lexically() {
        let home = temp_dir("unix-semver-order");
        let newer = home.join(".nvm/versions/node/v24.0.0/bin");
        let older = home.join(".nvm/versions/node/v9.0.0/bin");
        std::fs::create_dir_all(&newer).unwrap();
        std::fs::create_dir_all(&older).unwrap();

        let mut dirs: Vec<PathBuf> = Vec::new();
        append_unix_dsh_dirs(&mut dirs, &home);

        let newer_pos = dirs.iter().position(|d| d == &newer).unwrap();
        let older_pos = dirs.iter().position(|d| d == &older).unwrap();
        assert!(newer_pos < older_pos, "v24 应排在 v9 之前: {dirs:?}");
        let _ = std::fs::remove_dir_all(&home);
    }
}
