use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[cfg(windows)]
use std::os::windows::fs::FileTypeExt;

use crate::AppHandle;

use super::source::CoreSource;

const CORE_PACKAGE_SCOPE: &str = "@deepseek-ai";
const CORE_PACKAGE_PREFIX: &str = "dsh";

struct RuntimePreparationPaths<'a> {
    source: CoreSource,
    core_root: &'a Path,
    core_binary: &'a Path,
    profile: &'a Path,
}

fn prepare_active_runtime_at(paths: &RuntimePreparationPaths<'_>) -> Result<(), String> {
    if paths.source != CoreSource::App {
        return Ok(());
    }
    let archive = crate::config::core_archive_in(paths.core_root).ok_or_else(|| {
        format!(
            "CORE_RUNTIME_NOT_FOUND: bundled core asar is missing: {}",
            paths.core_root.display()
        )
    })?;
    if crate::config::asar_ancestor(paths.core_binary) != Some(archive.as_path())
        || !crate::config::core_entry_exists(paths.core_binary)
    {
        return Err(format!(
            "CORE_RUNTIME_ENTRY_NOT_FOUND: bundled core asar entry is unavailable: {}",
            paths.core_binary.display()
        ));
    }
    if let Err(error) = prune_stale_core_packages_at(paths.profile, paths.core_root) {
        log::warn!("{error}");
    }
    Ok(())
}

pub(crate) async fn prepare_active_runtime(app_handle: &AppHandle) -> Result<(), String> {
    if crate::service::core::active_source(app_handle) != CoreSource::App {
        return Ok(());
    }

    let core_root = crate::config::get_dsh_install_path(app_handle);
    let core_binary = crate::config::get_dsh_binary_path(app_handle);
    let profile = crate::service::plugin::profile_dir(app_handle);
    prepare_active_runtime_at(&RuntimePreparationPaths {
        source: CoreSource::App,
        core_root: &core_root,
        core_binary: &core_binary,
        profile: &profile,
    })
}

fn prune_stale_core_packages_at(profile: &Path, core_root: &Path) -> Result<(), String> {
    let declared = std::fs::read_to_string(profile.join("package.json"))
        .ok()
        .and_then(|raw| {
            serde_json::from_str::<crate::service::plugin::ProfilePackageJson>(&raw).ok()
        });
    let Some(manifest) = declared else {
        log::warn!(
            "CORE_PLUGIN_STALE_CORE_DECLARED_UNKNOWN: {} is unreadable, skipping cleanup",
            profile.display()
        );
        return Ok(());
    };
    let mut declared: HashSet<_> = manifest.dependencies.into_keys().collect();
    if let Some(profile) = manifest.dsh.and_then(|dsh| dsh.profile) {
        declared.extend(profile.bundles);
    }
    prune_stale_core_entries(profile, &core_root.join("node_modules"), &declared)
}

fn prune_stale_core_entries(
    profile_root: &Path,
    anchor_node_modules: &Path,
    declared: &HashSet<String>,
) -> Result<(), String> {
    let profile_node_modules = profile_root.join("node_modules");
    let scope = profile_node_modules.join(CORE_PACKAGE_SCOPE);
    if std::fs::symlink_metadata(&scope)
        .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    {
        return Ok(());
    }
    let Some(scope_root) = containment_root(&scope, profile_root) else {
        return Ok(());
    };
    let entries = match std::fs::read_dir(&scope) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => {
            return Err(format!(
                "CORE_PLUGIN_STALE_CORE_SCAN_FAILED: {}: {e}",
                scope.display()
            ));
        }
    };

    for entry in entries {
        let entry = entry.map_err(|e| {
            format!(
                "CORE_PLUGIN_STALE_CORE_SCAN_FAILED: {}: {e}",
                scope.display()
            )
        })?;
        let name = format!(
            "{CORE_PACKAGE_SCOPE}/{}",
            entry.file_name().to_string_lossy()
        );
        if !is_safe_package_name(&name) || declared.contains(&name) {
            continue;
        }
        if !is_core_family_package(&name) {
            continue;
        }
        let path = entry.path();
        if !entry_is_contained(&path, &scope_root) {
            log::warn!(
                "CORE_PLUGIN_STALE_CORE_OUT_OF_SCOPE: {} escapes {}, skipping",
                path.display(),
                scope.display()
            );
            continue;
        }
        let Some(profile_version) = read_package_version(&path.join("package.json")) else {
            continue;
        };
        let Some(anchor_version) = read_anchor_version(anchor_node_modules, &name) else {
            continue;
        };
        if profile_version == anchor_version {
            continue;
        }
        if let Err(e) = remove_core_package_residue(&path) {
            log::warn!("{e}");
            continue;
        }
        log::info!(
            "CORE_PLUGIN_STALE_CORE_PRUNED: {name} {profile_version} (profile) != {anchor_version} (anchor), removed"
        );
    }
    Ok(())
}

fn containment_root(scope: &Path, profile_root: &Path) -> Option<PathBuf> {
    let metadata = std::fs::symlink_metadata(scope).ok()?;
    let file_type = metadata.file_type();
    #[cfg(windows)]
    let is_link = file_type.is_symlink() || file_type.is_symlink_dir();
    #[cfg(not(windows))]
    let is_link = file_type.is_symlink();
    if is_link {
        log::warn!(
            "CORE_PLUGIN_STALE_CORE_SCOPE_REDIRECTED: {} is a link, skipping cleanup",
            scope.display()
        );
        return None;
    }

    let root = std::fs::canonicalize(profile_root).ok()?;
    let real = std::fs::canonicalize(scope).ok()?;
    if !real.starts_with(&root) {
        log::warn!(
            "CORE_PLUGIN_STALE_CORE_SCOPE_ESCAPED: {} resolves to {}, skipping cleanup",
            scope.display(),
            real.display()
        );
        return None;
    }
    Some(real)
}

fn entry_is_contained(path: &Path, scope_root: &Path) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    let file_type = metadata.file_type();
    #[cfg(windows)]
    if file_type.is_symlink() || file_type.is_symlink_dir() {
        return true;
    }
    #[cfg(not(windows))]
    if file_type.is_symlink() {
        return true;
    }
    match std::fs::canonicalize(path) {
        Ok(real) => real.starts_with(scope_root),
        Err(_) => false,
    }
}

fn read_anchor_version(anchor_node_modules: &Path, name: &str) -> Option<String> {
    let direct = anchor_node_modules.join(name).join("package.json");
    if let Some(version) = read_package_version(&direct) {
        return Some(version);
    }
    let core_root = anchor_node_modules.parent()?;
    let archive = crate::config::core_archive_in(core_root)?;
    let inner = archive.join("node_modules").join(name).join("package.json");
    crate::config::asar::read_json(&inner)?
        .get("version")?
        .as_str()
        .map(str::to_string)
}

fn remove_core_package_residue(path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|e| {
        format!(
            "CORE_PLUGIN_STALE_CORE_REMOVE_FAILED: {}: {e}",
            path.display()
        )
    })?;
    let file_type = metadata.file_type();
    #[cfg(windows)]
    let is_link = file_type.is_symlink() || file_type.is_symlink_dir();
    #[cfg(not(windows))]
    let is_link = file_type.is_symlink();
    if is_link {
        return remove_link_only(path);
    }
    let result = if file_type.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    result.map_err(|e| {
        format!(
            "CORE_PLUGIN_STALE_CORE_REMOVE_FAILED: {}: {e}",
            path.display()
        )
    })
}

fn remove_link_only(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    let result = std::fs::remove_dir(path).or_else(|_| std::fs::remove_file(path));
    #[cfg(not(windows))]
    let result = std::fs::remove_file(path);
    result.map_err(|e| format!("CORE_PLUGIN_LINK_REMOVE_FAILED: {}: {e}", path.display()))
}

#[cfg(unix)]
pub(crate) fn create_directory_link(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(source, destination)
}

#[cfg(windows)]
pub(crate) fn create_directory_link(source: &Path, destination: &Path) -> std::io::Result<()> {
    match std::os::windows::fs::symlink_dir(source, destination) {
        Ok(()) => Ok(()),
        Err(e) if is_privilege_error(&e) => {
            log::warn!(
                "CORE_PLUGIN_SYMLINK_FALLBACK: symlink_dir failed ({}), creating junction instead",
                e
            );
            create_directory_junction(source, destination)
        }
        Err(e) => Err(e),
    }
}

#[cfg(windows)]
fn is_privilege_error(e: &std::io::Error) -> bool {
    matches!(e.raw_os_error(), Some(1314 | 5))
}

#[cfg(windows)]
fn create_directory_junction(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, GENERIC_WRITE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::IO::DeviceIoControl;
    use windows_sys::Win32::System::Ioctl::FSCTL_SET_REPARSE_POINT;
    use windows_sys::Win32::System::SystemServices::IO_REPARSE_TAG_MOUNT_POINT;

    let source = source.canonicalize()?;
    let simplified = dunce::simplified(&source);
    let print_name = simplified.to_string_lossy().replace('/', "\\");
    let substitute_name = if print_name.starts_with("\\\\") {
        format!(r"\??\UNC\{}", print_name.trim_start_matches('\\'))
    } else {
        format!(r"\??\{}", print_name)
    };

    // 名字长度不含终止符；gap 与 trailing 各保留一个 UTF-16 空字符。
    let substitute_wide: Vec<u16> = substitute_name.encode_utf16().collect();
    let print_wide: Vec<u16> = print_name.encode_utf16().collect();
    let substitute_bytes = substitute_wide.len() * 2;
    let print_bytes = print_wide.len() * 2;
    const REPARSE_GAP: usize = 2;
    const REPARSE_TRAILING: usize = 2;
    let data_length = 8 + substitute_bytes + REPARSE_GAP + print_bytes + REPARSE_TRAILING;
    let total = 16 + substitute_bytes + REPARSE_GAP + print_bytes + REPARSE_TRAILING;

    let mut buffer = vec![0u8; total];
    buffer[0..4].copy_from_slice(&IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
    buffer[4..6].copy_from_slice(&(data_length as u16).to_le_bytes());
    buffer[8..10].copy_from_slice(&0u16.to_le_bytes());
    buffer[10..12].copy_from_slice(&(substitute_bytes as u16).to_le_bytes());
    buffer[12..14].copy_from_slice(&((substitute_bytes + REPARSE_GAP) as u16).to_le_bytes());
    buffer[14..16].copy_from_slice(&(print_bytes as u16).to_le_bytes());
    let mut cursor = 16usize;
    for unit in substitute_wide.iter().copied() {
        buffer[cursor..cursor + 2].copy_from_slice(&unit.to_le_bytes());
        cursor += 2;
    }
    cursor += REPARSE_GAP;
    for unit in print_wide.iter().copied() {
        buffer[cursor..cursor + 2].copy_from_slice(&unit.to_le_bytes());
        cursor += 2;
    }

    let created_dir = if !destination.is_dir() {
        std::fs::create_dir_all(destination)?;
        true
    } else {
        false
    };
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let handle = unsafe {
        CreateFileW(
            destination_wide.as_ptr(),
            GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        if created_dir {
            let _ = std::fs::remove_dir(destination);
        }
        return Err(std::io::Error::last_os_error());
    }
    let mut bytes_returned: u32 = 0;
    let ok = unsafe {
        DeviceIoControl(
            handle,
            FSCTL_SET_REPARSE_POINT,
            buffer.as_ptr() as *const core::ffi::c_void,
            buffer.len() as u32,
            std::ptr::null_mut(),
            0,
            &mut bytes_returned,
            std::ptr::null_mut(),
        )
    };
    unsafe {
        CloseHandle(handle);
    }
    if ok == 0 {
        if created_dir {
            let _ = std::fs::remove_dir(destination);
        }
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

fn is_safe_package_name(name: &str) -> bool {
    let parts: Vec<_> = name.split('/').collect();
    if parts.len() == 1 {
        return valid_package_component(parts[0]);
    }
    parts.len() == 2
        && parts[0].starts_with('@')
        && valid_package_component(parts[0])
        && valid_package_component(parts[1])
}

fn is_core_family_package(name: &str) -> bool {
    let Some(package) = name
        .strip_prefix(CORE_PACKAGE_SCOPE)
        .and_then(|rest| rest.strip_prefix('/'))
    else {
        return false;
    };
    package == CORE_PACKAGE_PREFIX
        || package
            .strip_prefix(CORE_PACKAGE_PREFIX)
            .is_some_and(|suffix| suffix.starts_with('-'))
}

fn valid_package_component(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value != "@"
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-@".contains(&byte))
}

fn read_package_version(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
    value
        .get("version")
        .and_then(|value| value.as_str())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_core_preparation_does_not_touch_runtime_paths() {
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("missing");
        prepare_active_runtime_at(&RuntimePreparationPaths {
            source: CoreSource::Local,
            core_root: &missing,
            core_binary: &missing,
            profile: &missing,
        })
        .unwrap();
        assert!(!missing.exists());
    }

    #[test]
    fn app_preparation_requires_a_real_asar_entry() {
        let root = tempfile::tempdir().unwrap();
        let core = root.path().join("core");
        std::fs::create_dir_all(&core).unwrap();
        let binary = core.join("node_modules/@deepseek-ai/dsh/lib/bin.js");
        let mut paths = RuntimePreparationPaths {
            source: CoreSource::App,
            core_root: &core,
            core_binary: &binary,
            profile: root.path(),
        };
        std::fs::create_dir_all(binary.parent().unwrap()).unwrap();
        std::fs::write(&binary, "directory core").unwrap();
        assert!(
            prepare_active_runtime_at(&paths)
                .unwrap_err()
                .starts_with("CORE_RUNTIME_NOT_FOUND:")
        );
        let archive = core.join(crate::config::dsh_core_asar_filename().unwrap());
        let archived_binary = archive.join("node_modules/@deepseek-ai/dsh/lib/bin.js");
        paths.core_binary = &archived_binary;
        std::fs::write(&archive, "not an archive").unwrap();
        assert!(
            prepare_active_runtime_at(&paths)
                .unwrap_err()
                .starts_with("CORE_RUNTIME_ENTRY_NOT_FOUND:")
        );
        write_core_archive(&core);
        let missing = archive.join("node_modules/missing.js");
        paths.core_binary = &missing;
        assert!(
            prepare_active_runtime_at(&paths)
                .unwrap_err()
                .starts_with("CORE_RUNTIME_ENTRY_NOT_FOUND:")
        );
        paths.core_binary = &binary;
        assert!(
            prepare_active_runtime_at(&paths)
                .unwrap_err()
                .starts_with("CORE_RUNTIME_ENTRY_NOT_FOUND:")
        );
        assert!(!core.join("node_modules/dsh-tauri").exists());
    }

    #[test]
    fn preparation_does_not_require_writable_core_node_modules() {
        let root = tempfile::tempdir().unwrap();
        let core = root.path().join("core");
        std::fs::create_dir_all(&core).unwrap();
        let core_binary = write_core_archive(&core);
        let modules = core.join("node_modules");
        std::fs::write(&modules, "installation-owned").unwrap();
        let profile = root.path().join("profiles/desktop");
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::write(profile.join("package.json"), "{}").unwrap();
        prepare_active_runtime_at(&RuntimePreparationPaths {
            source: CoreSource::App,
            core_root: &core,
            core_binary: &core_binary,
            profile: &profile,
        })
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(modules).unwrap(),
            "installation-owned"
        );
    }

    #[test]
    fn preparation_prunes_stale_core_packages_using_asar_versions() {
        let root = tempfile::tempdir().unwrap();
        let core = root.path().join("core");
        std::fs::create_dir_all(&core).unwrap();
        let core_binary = write_core_archive(&core);
        let profiles = root.path().join("profiles");
        let profile = profiles.join("tauri");
        write_package_version(&profile.join("node_modules"), "dsh-api", "1.0.0");
        std::fs::write(profile.join("package.json"), "{}").unwrap();
        prepare_active_runtime_at(&RuntimePreparationPaths {
            source: CoreSource::App,
            core_root: &core,
            core_binary: &core_binary,
            profile: &profile,
        })
        .unwrap();
        assert!(!profile.join("node_modules/@deepseek-ai/dsh-api").exists());
        assert!(!core.join("node_modules").exists());
        assert_eq!(
            read_anchor_version(&core.join("node_modules"), "@deepseek-ai/dsh-api").as_deref(),
            Some("2.0.0")
        );
    }

    #[test]
    fn package_names_allow_plain_and_scoped_names_only() {
        assert!(is_safe_package_name("dshmarket"));
        assert!(is_safe_package_name("@scope/plugin-name"));
        assert!(!is_safe_package_name("../escape"));
        assert!(!is_safe_package_name("@scope/../escape"));
        assert!(!is_safe_package_name("C:\\escape"));
        assert!(!is_safe_package_name("/absolute"));
        assert!(!is_safe_package_name("@/missing"));
    }

    #[cfg(windows)]
    #[test]
    fn create_directory_link_falls_back_to_junction_without_privileges() {
        let root = std::env::temp_dir().join(format!("dsh-runtime-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let source = root.join("source-pkg");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("package.json"), r#"{"name":"dsh-tauri"}"#).unwrap();
        let destination = root.join("node_modules").join("dsh-tauri");
        std::fs::create_dir_all(destination.parent().unwrap()).unwrap();

        let canonical_source = source.canonicalize().unwrap();
        create_directory_link(&canonical_source, &destination)
            .unwrap_or_else(|e| panic!("link must be created without privileges: {e}"));

        let metadata = std::fs::symlink_metadata(&destination).unwrap();
        assert!(
            metadata.file_type().is_symlink() || metadata.file_type().is_symlink_dir(),
            "junction must be treated as a link"
        );
        let resolved = std::fs::read_link(&destination).unwrap();
        assert_eq!(resolved.canonicalize().unwrap(), canonical_source);

        let matches = std::fs::read_link(&destination)
            .map(|target| {
                let resolved = if target.is_absolute() {
                    target
                } else {
                    destination.parent().unwrap_or(Path::new(".")).join(target)
                };
                resolved.canonicalize().ok().as_deref() == Some(canonical_source.as_path())
            })
            .unwrap_or(false);
        assert!(matches, "existing junction must match its source");

        remove_link_only(&destination).unwrap();
        assert!(!destination.exists());
        assert!(canonical_source.is_dir());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn create_directory_junction_accepts_mixed_separators_and_is_idempotent() {
        let root = std::env::temp_dir().join(format!("dsh-junction-direct-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src-tauri")).unwrap();
        let source = root.join("src-tauri/../@scope/package");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("package.json"), r#"{"name":"dsh-tauri"}"#).unwrap();
        let destination = root.join("node_modules").join("dsh-tauri");
        std::fs::create_dir_all(destination.parent().unwrap()).unwrap();

        let canonical_source = source.canonicalize().unwrap();
        create_directory_junction(&source, &destination)
            .unwrap_or_else(|e| panic!("junction must be creatable without privileges: {e}"));
        let manifest = std::fs::read_to_string(destination.join("package.json"));
        remove_link_only(&destination).unwrap();
        assert_eq!(manifest.unwrap(), r#"{"name":"dsh-tauri"}"#);
        create_directory_junction(&source, &destination).unwrap();

        let metadata = std::fs::symlink_metadata(&destination).unwrap();
        assert!(
            metadata.file_type().is_symlink() || metadata.file_type().is_symlink_dir(),
            "junction must be treated as a link"
        );
        assert_eq!(
            std::fs::canonicalize(&destination).unwrap(),
            canonical_source,
            "junction must resolve to the source directory"
        );

        remove_link_only(&destination).unwrap();
        create_directory_junction(&canonical_source, &destination)
            .unwrap_or_else(|e| panic!("junction recreation must succeed: {e}"));
        let matches = std::fs::read_link(&destination)
            .ok()
            .map(|target| {
                let resolved = if target.is_absolute() {
                    target
                } else {
                    destination.parent().unwrap_or(Path::new(".")).join(target)
                };
                resolved.canonicalize().ok().as_deref() == Some(canonical_source.as_path())
            })
            .unwrap_or(false);
        assert!(matches, "existing junction must match its source");

        remove_link_only(&destination).unwrap();
        assert!(!destination.exists());
        assert!(canonical_source.is_dir());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn stale_undeclared_core_package_is_pruned() {
        let root = std::env::temp_dir().join(format!("dsh-stale-core-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let profile_modules = root.join("profiles/tauri/node_modules");
        let anchor_modules = root.join("dependencies/dsh/node_modules");

        write_package_version(&profile_modules, "dsh-settings", "0.1.5-rc.2");
        write_package_version(&anchor_modules, "dsh-settings", "0.1.7-rc.2");

        prune_stale_core_entries(
            &root.join("profiles/tauri"),
            &anchor_modules,
            &HashSet::new(),
        )
        .unwrap();

        assert!(
            !profile_modules
                .join("@deepseek-ai/dsh-settings/package.json")
                .exists(),
            "mismatched undeclared core package must be removed from the profile"
        );
        assert!(
            anchor_modules
                .join("@deepseek-ai/dsh-settings/package.json")
                .is_file(),
            "the anchor copy must never be touched"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn matching_or_declared_core_packages_are_kept() {
        let root = std::env::temp_dir().join(format!("dsh-stale-core-keep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let profile_modules = root.join("profiles/tauri/node_modules");
        let anchor_modules = root.join("dependencies/dsh/node_modules");

        write_package_version(&profile_modules, "dsh-settings", "0.1.7-rc.2");
        write_package_version(&anchor_modules, "dsh-settings", "0.1.7-rc.2");
        write_package_version(&profile_modules, "dsh-tools", "0.1.5-rc.2");
        write_package_version(&anchor_modules, "dsh-tools", "0.1.7-rc.2");
        write_package_version(&root.join("other"), "dsh-settings", "0.1.5-rc.2");
        std::fs::create_dir_all(profile_modules.join("@deepseek-ai/dsh-orphan")).unwrap();

        let declared = HashSet::from(["@deepseek-ai/dsh-tools".to_string()]);
        prune_stale_core_entries(&root.join("profiles/tauri"), &anchor_modules, &declared).unwrap();

        assert!(
            profile_modules
                .join("@deepseek-ai/dsh-settings/package.json")
                .is_file(),
            "version-matching core package must be kept"
        );
        assert!(
            profile_modules
                .join("@deepseek-ai/dsh-tools/package.json")
                .is_file(),
            "declared core package must be kept"
        );
        assert!(
            profile_modules.join("@deepseek-ai/dsh-orphan").is_dir(),
            "entry without a readable version must be left alone"
        );
        assert!(
            root.join("other/@deepseek-ai/dsh-settings/package.json")
                .is_file(),
            "only the @deepseek-ai scope is inspected"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn shared_framework_libraries_and_third_party_plugins_are_kept() {
        let root =
            std::env::temp_dir().join(format!("dsh-stale-core-scope-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let profile_modules = root.join("profiles/tauri/node_modules");
        let anchor_modules = root.join("dependencies/dsh/node_modules");

        for name in ["schemastery", "cosmokit", "cordis", "dshmarket"] {
            write_package_version(&profile_modules, name, "0.1.5-rc.2");
            write_package_version(&anchor_modules, name, "0.1.7-rc.2");
        }

        prune_stale_core_entries(
            &root.join("profiles/tauri"),
            &anchor_modules,
            &HashSet::new(),
        )
        .unwrap();

        for name in ["schemastery", "cosmokit", "cordis", "dshmarket"] {
            assert!(
                profile_modules
                    .join(format!("@deepseek-ai/{name}/package.json"))
                    .is_file(),
                "{name} is outside the core family and must be kept"
            );
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn stale_core_package_symlink_is_removed_without_touching_source() {
        let root = std::env::temp_dir().join(format!("dsh-stale-core-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let profile_modules = root.join("profiles/tauri/node_modules");
        let anchor_modules = root.join("dependencies/dsh/node_modules");
        let source = root.join("fallback/@deepseek-ai/dsh-settings");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("package.json"), r#"{"version":"0.1.5-rc.2"}"#).unwrap();
        std::fs::create_dir_all(profile_modules.join("@deepseek-ai")).unwrap();
        std::os::unix::fs::symlink(&source, profile_modules.join("@deepseek-ai/dsh-settings"))
            .unwrap();
        write_package_version(&anchor_modules, "dsh-settings", "0.1.7-rc.2");

        prune_stale_core_entries(
            &root.join("profiles/tauri"),
            &anchor_modules,
            &HashSet::new(),
        )
        .unwrap();

        assert!(
            !profile_modules.join("@deepseek-ai/dsh-settings").exists(),
            "stale link must be removed"
        );
        assert!(
            source.join("package.json").is_file(),
            "the link source must survive"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn redirected_scope_is_skipped_entirely() {
        let root =
            std::env::temp_dir().join(format!("dsh-stale-core-redirect-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let profile_modules = root.join("profiles/tauri/node_modules");
        let anchor_modules = root.join("dependencies/dsh/node_modules");
        let outside = root.join("outside/@deepseek-ai");
        write_package_version(&root.join("outside"), "dsh-settings", "0.1.5-rc.2");
        write_package_version(&anchor_modules, "dsh-settings", "0.1.7-rc.2");
        std::fs::create_dir_all(&profile_modules).unwrap();
        std::os::unix::fs::symlink(&outside, profile_modules.join("@deepseek-ai")).unwrap();

        prune_stale_core_entries(
            &root.join("profiles/tauri"),
            &anchor_modules,
            &HashSet::new(),
        )
        .unwrap();

        assert!(
            outside.join("dsh-settings/package.json").is_file(),
            "a redirected scope must never be pruned through"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn redirected_node_modules_is_skipped_entirely() {
        let root = std::env::temp_dir().join(format!("dsh-stale-core-nm-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let profile = root.join("profiles/tauri");
        let anchor_modules = root.join("dependencies/dsh/node_modules");
        let outside_modules = root.join("outside/node_modules");
        write_package_version(&outside_modules, "dsh-settings", "0.1.5-rc.2");
        write_package_version(&anchor_modules, "dsh-settings", "0.1.7-rc.2");
        std::fs::create_dir_all(&profile).unwrap();
        std::os::unix::fs::symlink(&outside_modules, profile.join("node_modules")).unwrap();

        prune_stale_core_entries(&profile, &anchor_modules, &HashSet::new()).unwrap();

        assert!(
            outside_modules
                .join("@deepseek-ai/dsh-settings/package.json")
                .is_file(),
            "an external node_modules must never be pruned through"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    fn write_package_version(modules: &Path, name: &str, version: &str) {
        let dir = modules.join("@deepseek-ai").join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("package.json"),
            format!(r#"{{"name":"@deepseek-ai/{name}","version":"{version}"}}"#),
        )
        .unwrap();
    }

    fn write_core_archive(core: &Path) -> PathBuf {
        let version = br#"{"version":"2.0.0"}"#;
        let tree = serde_json::json!({"files": {"node_modules": {"files": {"@deepseek-ai": {"files": {
            "dsh": {"files": {"lib": {"files": {"bin.js": {"size": 1, "offset": "0"}}}}},
            "dsh-api": {"files": {"package.json": {"size": version.len(), "offset": "1"}}}
        }}}}}});
        let json = serde_json::to_vec(&tree).unwrap();
        let header_size = 8 + json.len() + (4 - json.len() % 4) % 4;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&4u32.to_le_bytes());
        bytes.extend_from_slice(&(header_size as u32).to_le_bytes());
        bytes.extend_from_slice(&(header_size as u32).to_le_bytes());
        bytes.extend_from_slice(&(json.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&json);
        bytes.resize(8 + header_size, 0);
        bytes.push(b' ');
        bytes.extend_from_slice(version);
        let archive = core.join(crate::config::dsh_core_asar_filename().unwrap());
        std::fs::write(&archive, bytes).unwrap();
        archive.join("node_modules/@deepseek-ai/dsh/lib/bin.js")
    }
}
