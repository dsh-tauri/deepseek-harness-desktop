//! issue #848：独立于 DSH_HOME 的恢复导出，包含会话与共享存储，不参与档案还原或自动裁剪。

use std::fs;
use std::path::{Path, PathBuf};

use super::{archive, BackupInfo};

const RECOVERY_README: &str = "DSH recovery export\n\n\
data.tar.zst contains DSH_HOME data, including sessions, storages and all profiles.\n\
Excluded: node_modules, .backups and .harness.pid.\n\
.credentials.yaml is included only when requested. Other files are not redacted\n\
and may contain secrets. Keep this directory private.\n\n\
Recovery: stop every desktop, CLI and web client using this DSH_HOME.\n\
Extract data.tar.zst into a NEW EMPTY directory with a tar.zst-capable tool.\n\
Inspect the extracted sessions, storages and profiles before copying anything.\n\
Keep a separate copy of your current DSH_HOME before replacing any files.\n\
Reinstall profile dependencies using the matching DSH core version.\n\
Do not use the desktop's profile Restore button for this archive.\n\n\
This is a manual export, not an automatic backup. It is not automatically pruned.\n\
Copy it to another device to protect against disk failure.\n";

pub fn export(source: &Path, app_data: &Path, include_credentials: bool) -> Result<BackupInfo, String> {
    let source = dunce::canonicalize(source).map_err(|e| format!("RECOVERY_SOURCE: {e}"))?;
    if !source.is_dir() {
        return Err("RECOVERY_SOURCE: DSH_HOME is not a directory".into());
    }
    let app_data = dunce::canonicalize(app_data).map_err(|e| format!("RECOVERY_DESTINATION: {e}"))?;
    if app_data.starts_with(&source) {
        return Err("RECOVERY_DESTINATION_INSIDE_SOURCE: application data is inside DSH_HOME".into());
    }
    let root = app_data.join("recovery-backups");
    create_private_dir(&root).or_else(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists { Ok(()) } else { Err(e) }
    }).map_err(|e| format!("RECOVERY_MKDIR: {e}"))?;
    let root = dunce::canonicalize(root).map_err(|e| format!("RECOVERY_DESTINATION: {e}"))?;
    if root.starts_with(&source) || !root.starts_with(&app_data) {
        return Err("RECOVERY_DESTINATION_UNSAFE: recovery directory resolves outside application data or inside DSH_HOME".into());
    }

    let timestamp = super::now_timestamp();
    let directory = reserve_directory(&root, &timestamp)?;
    let partial = directory.join("data.tar.zst.partial");
    let path = directory.join("data.tar.zst");
    let result = (|| {
        archive::create_recovery_archive(&source, &partial, include_credentials)?;
        fs::OpenOptions::new().write(true).open(&partial).and_then(|file| file.sync_all())
            .map_err(|e| format!("RECOVERY_SYNC: {e}"))?;
        let readme = directory.join("README.txt");
        fs::write(&readme, RECOVERY_README)
            .map_err(|e| format!("RECOVERY_README: {e}"))?;
        fs::OpenOptions::new().write(true).open(&readme).and_then(|file| file.sync_all())
            .map_err(|e| format!("RECOVERY_SYNC_README: {e}"))?;
        let size = fs::metadata(&partial).map_err(|e| format!("RECOVERY_METADATA: {e}"))?.len();
        fs::rename(&partial, &path).map_err(|e| format!("RECOVERY_PUBLISH: {e}"))?;
        // Unix 还需同步目录项，避免断电后已返回的归档路径或新建目录丢失。
        #[cfg(unix)]
        for parent in [&directory, &root, &app_data] {
            fs::File::open(parent).and_then(|file| file.sync_all())
                .map_err(|e| format!("RECOVERY_SYNC_DIRECTORY: {e}"))?;
        }
        Ok(BackupInfo {
            timestamp,
            path: path.to_string_lossy().into_owned(),
            size,
            include_credentials,
        })
    })();
    if result.is_err() {
        // 只删除本次 create_dir 独占创建的导出目录，不触碰既有备份或源数据。
        if let Err(e) = fs::remove_dir_all(&directory) {
            log::warn!("RECOVERY_CLEANUP: {}: {e}", directory.display());
        }
    }
    result
}

fn create_private_dir(path: &Path) -> std::io::Result<()> {
    let builder = fs::DirBuilder::new();
    #[cfg(unix)]
    let builder = {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = builder;
        builder.mode(0o700);
        builder
    };
    builder.create(path)
}

fn reserve_directory(root: &Path, timestamp: &str) -> Result<PathBuf, String> {
    for suffix in 0..1000 {
        let directory = root.join(format!("{timestamp}-{suffix}"));
        match create_private_dir(&directory) {
            Ok(()) => return Ok(directory),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("RECOVERY_MKDIR: {e}")),
        }
    }
    Err("RECOVERY_COLLISION: too many exports in the same second".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        root: PathBuf,
        home: PathBuf,
        app: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "dsh-recovery-{}-{}",
                std::process::id(),
                super::super::timestamp_nanos()
            ));
            fs::create_dir(&root).unwrap();
            let fixture = Self { home: root.join("dsh-home"), app: root.join("app-data"), root };
            fs::create_dir(&fixture.app).unwrap();
            for (name, value) in [
                ("sessions/project/session/session.v4.jsonl.zstd", "saved conversation"),
                ("storages/workspace.json", "workspace data"),
                ("profiles/web/cordis.patch.yml", "user patch"),
                ("profiles/other/package.json", "other profile"),
                ("dsh-config-manager/snapshots/saved.json", "plugin data"),
                (".credentials.yaml", "secret"),
                ("profiles/web/.credentials.yaml", "profile secret"),
                ("profiles/web/node_modules/plugin/index.js", "dependency"),
                (".backups/old.tar.zst", "existing backup"),
                (".harness.pid", "123"),
            ] {
                let path = fixture.home.join(name);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, value).unwrap();
            }
            fixture
        }

        fn restore(&self, info: &BackupInfo, name: &str) -> PathBuf {
            let target = self.root.join(name);
            archive::extract_archive(Path::new(&info.path), &target).unwrap();
            target
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).unwrap();
        }
    }

    #[test]
    fn export_preserves_sessions_shared_storage_and_every_profile_after_source_loss() {
        let fixture = Fixture::new();
        let info = export(&fixture.home, &fixture.app, false).unwrap();
        assert!(Path::new(&info.path).starts_with(dunce::canonicalize(&fixture.app).unwrap().join("recovery-backups")));
        assert!(info.size > 0);
        assert!(!info.include_credentials);
        assert_eq!(fs::read_to_string(fixture.home.join(".credentials.yaml")).unwrap(), "secret");
        fs::remove_dir_all(&fixture.home).unwrap();
        let restored = fixture.restore(&info, "recovered");
        for (name, expected) in [
            ("sessions/project/session/session.v4.jsonl.zstd", "saved conversation"),
            ("storages/workspace.json", "workspace data"),
            ("profiles/web/cordis.patch.yml", "user patch"),
            ("profiles/other/package.json", "other profile"),
            ("dsh-config-manager/snapshots/saved.json", "plugin data"),
        ] {
            assert_eq!(fs::read_to_string(restored.join(name)).unwrap(), expected);
        }
        for excluded in [".credentials.yaml", "profiles/web/.credentials.yaml", "profiles/web/node_modules", ".backups", ".harness.pid"] {
            assert!(!restored.join(excluded).exists(), "should exclude {excluded}");
        }
        let directory = Path::new(&info.path).parent().unwrap();
        assert!(fs::read_to_string(directory.join("README.txt")).unwrap().contains("NEW EMPTY directory"));
        assert!(!directory.join("data.tar.zst.partial").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(directory).unwrap().permissions().mode() & 0o777, 0o700);
        }
    }

    #[test]
    fn export_includes_credentials_only_when_requested_and_keeps_previous_exports() {
        let fixture = Fixture::new();
        let first = export(&fixture.home, &fixture.app, false).unwrap();
        let bytes = fs::read(&first.path).unwrap();
        let second = export(&fixture.home, &fixture.app, true).unwrap();
        assert_ne!(first.path, second.path);
        assert_eq!(fs::read(&first.path).unwrap(), bytes);
        let restored = fixture.restore(&second, "with-credentials");
        assert!(second.include_credentials);
        assert_eq!(fs::read_to_string(restored.join(".credentials.yaml")).unwrap(), "secret");
        assert_eq!(fs::read_to_string(restored.join("profiles/web/.credentials.yaml")).unwrap(), "profile secret");
    }

    #[test]
    fn export_rejects_missing_source_without_creating_an_empty_backup() {
        let fixture = Fixture::new();
        let error = export(&fixture.root.join("missing"), &fixture.app, false).unwrap_err();
        assert!(error.starts_with("RECOVERY_SOURCE:"), "{error}");
        assert!(!fixture.app.join("recovery-backups").exists());
    }

    #[test]
    fn export_rejects_app_data_inside_source_before_writing() {
        let fixture = Fixture::new();
        let nested = fixture.home.join("app-data");
        fs::create_dir(&nested).unwrap();
        for target in [&fixture.home, &nested] {
            let error = export(&fixture.home, target, false).unwrap_err();
            assert!(error.starts_with("RECOVERY_DESTINATION_INSIDE_SOURCE:"), "{error}");
            assert!(!target.join("recovery-backups").exists());
        }
    }

    #[test]
    fn reserve_directory_preserves_existing_files_and_directories() {
        let fixture = Fixture::new();
        fs::write(fixture.app.join("stamp-0"), "keep file").unwrap();
        fs::create_dir(fixture.app.join("stamp-1")).unwrap();
        let path = reserve_directory(&fixture.app, "stamp").unwrap();
        assert_eq!(path, fixture.app.join("stamp-2"));
        assert_eq!(fs::read_to_string(fixture.app.join("stamp-0")).unwrap(), "keep file");
        assert!(fixture.app.join("stamp-1").is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn export_rejects_destination_symlinks_into_source_or_outside_app_data() {
        let fixture = Fixture::new();
        let link = fixture.app.join("recovery-backups");
        for target in [&fixture.home, &fixture.root] {
            std::os::unix::fs::symlink(target, &link).unwrap();
            let error = export(&fixture.home, &fixture.app, false).unwrap_err();
            assert!(error.starts_with("RECOVERY_DESTINATION_UNSAFE:"), "{error}");
            assert_eq!(fs::read_to_string(fixture.home.join(".credentials.yaml")).unwrap(), "secret");
            fs::remove_file(&link).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn failed_export_removes_only_its_partial_output_and_preserves_previous_backup() {
        let fixture = Fixture::new();
        let saved = export(&fixture.home, &fixture.app, false).unwrap();
        let bytes = fs::read(&saved.path).unwrap();
        std::os::unix::fs::symlink("missing", fixture.home.join("linked-data")).unwrap();
        let error = export(&fixture.home, &fixture.app, false).unwrap_err();
        assert!(error.starts_with("RECOVERY_LINK_UNSUPPORTED:"), "{error}");
        assert_eq!(fs::read(&saved.path).unwrap(), bytes);
        assert_eq!(fs::read_dir(fixture.app.join("recovery-backups")).unwrap().count(), 1);
        assert_eq!(fs::read_to_string(fixture.home.join(".credentials.yaml")).unwrap(), "secret");
        assert!(fs::symlink_metadata(fixture.home.join("linked-data")).unwrap().file_type().is_symlink());
    }

    #[cfg(windows)]
    #[test]
    fn export_rejects_junctions_without_traversing_them() {
        use std::os::windows::process::CommandExt;
        let fixture = Fixture::new();
        let link = fixture.home.join("linked-data");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link).arg(&fixture.app)
            .creation_flags(0x08000000)
            .status().unwrap();
        assert!(status.success());
        let error = export(&fixture.home, &fixture.app, false).unwrap_err();
        assert!(error.starts_with("RECOVERY_LINK_UNSUPPORTED:"), "{error}");
        assert_eq!(fs::read_dir(fixture.app.join("recovery-backups")).unwrap().count(), 0);
        fs::remove_dir(link).unwrap();
    }
}
