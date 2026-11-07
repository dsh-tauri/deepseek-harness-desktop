//! 档案备份与还原。
//!
//! 档案备份仅打包当前 profile，存放在 `$DSH_HOME/.backups/`，支持还原与保留份数裁剪。
//! [`recovery`] 另行导出含会话的完整数据到应用数据目录，不参与档案还原或裁剪。

pub mod archive;
pub mod recovery;
pub mod retention;

use std::fs;
use std::path::{Path, PathBuf};
use crate::AppHandle;

use crate::config;

/// 备份选项。
#[derive(Debug, Clone)]
pub struct BackupOptions {
    /// 是否包含凭据文件（`.credentials.yaml`）。默认 false。
    pub include_credentials: bool,
}

/// 备份信息（序列化 camelCase 给前端）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    /// 快照时间戳（文件名主体，如 `2026-08-30T12-00-00`）。
    pub timestamp: String,
    /// 归档文件完整路径。
    pub path: String,
    /// 归档文件大小（字节）。
    pub size: u64,
    /// 是否包含凭据。
    pub include_credentials: bool,
}

/// 还原模式。
#[derive(Debug, Clone, Copy)]
pub enum RestoreMode {
    /// 覆盖当前激活的 profile。
    Overwrite,
    /// 创建新档案目录并解压到其中。
    AsNew,
}

/// 备份清单（索引文件 `.manifest.json` 的内容）。
#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct BackupManifest {
    backups: Vec<ManifestEntry>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestEntry {
    timestamp: String,
    profile: String,
    path: String,
    size: u64,
    include_credentials: bool,
}

/// 获取备份目录（`$DSH_HOME/.backups/`），不存在时自动创建。
pub fn get_backup_dir<R: tauri::Runtime>(app_handle: &AppHandle<R>) -> PathBuf {
    let dir = config::get_dsh_data_path(app_handle).join(".backups");
    fs::create_dir_all(&dir).ok();
    dir
}

/// 从时间戳推导归档文件名（带 profile 前缀）：`{profile}-{yyyymmddhhmmss}.tar.zst`。
fn archive_filename(profile: &str, timestamp: &str) -> String {
    format!("{profile}-{timestamp}.tar.zst")
}

/// 清单读取错误。
#[derive(Debug)]
enum ManifestError {
    ReadError(std::io::Error),
    ParseError(String),
}

impl std::fmt::Display for ManifestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ManifestError::ReadError(e) => write!(f, "manifest read error: {e}"),
            ManifestError::ParseError(e) => write!(f, "manifest parse error: {e}"),
        }
    }
}

impl std::error::Error for ManifestError {}

fn read_manifest(backup_dir: &Path) -> Result<BackupManifest, ManifestError> {
    let path = backup_dir.join(".manifest.json");
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(BackupManifest { backups: vec![] });
        }
        Err(e) => return Err(ManifestError::ReadError(e)),
    };
    if content.trim().is_empty() {
        return Err(ManifestError::ParseError("empty manifest".into()));
    }
    match serde_json::from_str(&content) {
        Ok(manifest) => Ok(manifest),
        Err(e) => {
            log::error!("BACKUP_MANIFEST_PARSE: {} {e}", path.display());
            Err(ManifestError::ParseError(e.to_string()))
        }
    }
}

/// 原子写入备份清单（唯一临时文件名，避免并发写入覆盖）。
fn write_manifest(backup_dir: &Path, manifest: &BackupManifest) -> Result<(), String> {
    let path = backup_dir.join(".manifest.json");
    // 唯一临时文件名：PID + 纳秒时间戳，并发写入互不覆盖
    let tmp_name = format!(".manifest.{}.{}.tmp", std::process::id(), timestamp_nanos());
    let tmp = backup_dir.join(tmp_name);
    let content = serde_json::to_string_pretty(manifest)
        .map_err(|e| format!("BACKUP_MANIFEST_SERIALIZE: {e}"))?;
    fs::write(&tmp, content).map_err(|e| format!("BACKUP_MANIFEST_WRITE: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("BACKUP_MANIFEST_RENAME: {e}"))?;
    Ok(())
}

/// 当前纳秒时间戳（用于生成唯一临时文件名）。
fn timestamp_nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

/// 生成紧凑时间戳（UTC，格式 `yyyymmddhhmmss`）。
fn now_timestamp() -> String {
    use time::OffsetDateTime;
    let now = OffsetDateTime::now_utc();
    let date = now.date();
    let time = now.time();
    format!(
        "{:04}{:02}{:02}{:02}{:02}{:02}",
        date.year(),
        date.month() as u8,
        date.day(),
        time.hour(),
        time.minute(),
        time.second()
    )
}

fn timestamp_order(timestamp: &str) -> (&str, u64) {
    match timestamp.rsplit_once('-') {
        Some((base, suffix)) if base.len() == 14 && base.bytes().all(|b| b.is_ascii_digit()) => {
            match suffix.parse() {
                Ok(sequence) => (base, sequence),
                Err(_) => (timestamp, 1),
            }
        }
        _ => (timestamp, 1),
    }
}

fn collision_safe_timestamp(backup_dir: &Path, timestamp: &str) -> Result<String, String> {
    let marker = format!("-{timestamp}");
    let mut latest = 0_u64;
    for entry in fs::read_dir(backup_dir).map_err(|e| format!("BACKUP_READDIR: {e}"))? {
        let name = entry.map_err(|e| format!("BACKUP_ENTRY: {e}"))?.file_name();
        let Some(stem) = name.to_str().and_then(|name| name.strip_suffix(".tar.zst")) else {
            continue;
        };
        let Some((_, suffix)) = stem.rsplit_once(&marker) else {
            continue;
        };
        let sequence = if suffix.is_empty() {
            1
        } else if let Some(sequence) = suffix
            .strip_prefix('-')
            .and_then(|value| value.parse::<u64>().ok())
        {
            sequence
        } else {
            continue;
        };
        latest = latest.max(sequence);
    }
    if latest == 0 {
        return Ok(timestamp.to_string());
    }
    let next = latest.checked_add(1).ok_or("BACKUP_SEQUENCE_EXHAUSTED")?;
    Ok(format!("{timestamp}-{next}"))
}

// 同一进程的创建、裁剪、删除和还原共用清单与归档，必须串行完成。
static BACKUP_OPERATION: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 创建备份。
///
/// 只备份当前激活的 profile（不是整个 $DSH_HOME），
/// 输出到 `$DSH_HOME/.backups/{profile}-{yyyymmddhhmmss}.tar.zst`，更新清单，并按保留份数裁剪。
pub fn create_backup(app_handle: &AppHandle, options: BackupOptions) -> Result<BackupInfo, String> {
    let _operation = BACKUP_OPERATION
        .lock()
        .map_err(|e| format!("BACKUP_LOCK: {e}"))?;
    let backup_dir = get_backup_dir(app_handle);
    let mut manifest =
        read_manifest(&backup_dir).map_err(|e| format!("BACKUP_MANIFEST_CORRUPT: {e}"))?;
    // 只备份当前激活的 profile 目录（其他 profile 不参与备份）
    let active = crate::service::profile::active_profile(app_handle);
    let source = crate::service::profile::profile_dir_of(app_handle, &active);
    // 碰撞安全：同名文件已存在时追加 -2、-3…
    let timestamp = collision_safe_timestamp(&backup_dir, &now_timestamp())?;
    let dest = backup_dir.join(archive_filename(&active, &timestamp));

    if let Err(e) = archive::create_archive(&source, &dest, options.include_credentials) {
        // 失败时删除半成品归档，避免留下无法还原的孤儿备份文件
        let _ = fs::remove_file(&dest);
        return Err(e);
    }

    let size = fs::metadata(&dest)
        .map(|m| m.len())
        .unwrap_or(0);

    let info = BackupInfo {
        timestamp: timestamp.clone(),
        path: dest.to_string_lossy().into_owned(),
        size,
        include_credentials: options.include_credentials,
    };

    manifest.backups.push(ManifestEntry {
        timestamp: info.timestamp.clone(),
        profile: active.clone(),
        path: info.path.clone(),
        size: info.size,
        include_credentials: info.include_credentials,
    });
    write_manifest(&backup_dir, &manifest)?;

    // 裁剪
    prune_if_needed(app_handle)?;

    Ok(info)
}

/// 列出当前激活 profile 的备份（按时间戳升序）。
pub fn list_backups(app_handle: &AppHandle) -> Result<Vec<BackupInfo>, String> {
    let backup_dir = get_backup_dir(app_handle);
    let manifest =
        read_manifest(&backup_dir).map_err(|e| format!("BACKUP_MANIFEST_CORRUPT: {e}"))?;
    let active = crate::service::profile::active_profile(app_handle);
    Ok(manifest
        .backups
        .into_iter()
        .filter(|e| e.profile == active)
        .map(|e| BackupInfo {
            timestamp: e.timestamp,
            path: e.path,
            size: e.size,
            include_credentials: e.include_credentials,
        })
        .collect())
}

/// 删除指定备份（文件 + 清单条目）。
///
/// `timestamp` 会经过 `fs_guard::validate_id` 校验，防路径穿越。
pub fn delete_backup<R: tauri::Runtime>(
    app_handle: &AppHandle<R>,
    timestamp: &str,
) -> Result<(), String> {
    crate::service::fs_guard::validate_id(timestamp)?;
    let _operation = BACKUP_OPERATION
        .lock()
        .map_err(|e| format!("BACKUP_LOCK: {e}"))?;
    let backup_dir = get_backup_dir(app_handle);
    let mut manifest =
        read_manifest(&backup_dir).map_err(|e| format!("BACKUP_MANIFEST_CORRUPT: {e}"))?;
    let active = crate::service::profile::active_profile(app_handle);
    let filename = archive_filename(&active, timestamp);
    let file = backup_dir.join(&filename);
    if file.exists() {
        fs::remove_file(&file).map_err(|e| format!("BACKUP_DELETE_FILE: {e}"))?;
    }
    // 同时匹配 profile 和 timestamp，避免误删其他 profile 的同时间戳备份
    manifest
        .backups
        .retain(|e| !(e.profile == active && e.timestamp == timestamp));
    write_manifest(&backup_dir, &manifest)?;
    Ok(())
}

/// 还原备份。
///
/// `mode` 为 `Overwrite` 时覆盖当前激活 profile 目录（调用方应先停止服务）；
/// `AsNew` 时创建新档案目录并解压到其中。
///
/// 备份现在只包含单个 profile 的内容（无 profile 目录前缀），
/// 所以还原目标就是 profile 目录本身，不是 `$DSH_HOME`。
///
/// `timestamp` 经过 `fs_guard::validate_id` 校验。
pub fn restore_backup(
    app_handle: &AppHandle,
    timestamp: &str,
    mode: RestoreMode,
) -> Result<(), String> {
    crate::service::fs_guard::validate_id(timestamp)?;
    let _operation = BACKUP_OPERATION
        .lock()
        .map_err(|e| format!("BACKUP_LOCK: {e}"))?;
    let backup_dir = get_backup_dir(app_handle);
    let active = crate::service::profile::active_profile(app_handle);
    let filename = archive_filename(&active, timestamp);
    let archive_path = backup_dir.join(&filename);
    if !archive_path.exists() {
        return Err(format!(
            "BACKUP_NOT_FOUND: backup {filename} does not exist"
        ));
    }

    match mode {
        RestoreMode::Overwrite => {
            // 重命名旧 profile → 备份目录（避开文件锁），解压到新目录，
            // 成功后删除旧备份；失败则回滚（rename 旧目录回来）
            let dest = crate::service::profile::profile_dir_of(app_handle, &active);
            let backup_old = std::path::PathBuf::from(format!(
                "{}-{}.restore-bak",
                dest.display(),
                timestamp
            ));
            // 清理可能残留的旧备份目录
            let _ = fs::remove_dir_all(&backup_old);
            // 重命名旧 profile（即使有子进程在读，rename 也能成功）
            fs::rename(&dest, &backup_old).map_err(|e| {
                format!("BACKUP_RESTORE_RENAME_OLD: {e} (old={}, new={})",
                    dest.display(), backup_old.display())
            })?;
            // 创建空的新目录
            fs::create_dir_all(&dest).map_err(|e| {
                format!("BACKUP_RESTORE_MKDIR_NEW: {e} (dest={})", dest.display())
            })?;
            // 解压到新目录
            let extract_result = archive::extract_archive(&archive_path, &dest);
            match extract_result {
                Ok(()) => {
                    // 成功：删除旧备份
                    let _ = fs::remove_dir_all(&backup_old);
                }
                Err(e) => {
                    // 失败：回滚（删除半成品新目录，把旧目录 rename 回来）
                    let _ = fs::remove_dir_all(&dest);
                    let _ = fs::rename(&backup_old, &dest);
                    return Err(format!("BACKUP_RESTORE_EXTRACT_FAILED: {e}。已自动回滚到原状态。"));
                }
            }
        }
        RestoreMode::AsNew => {
            // 创建新档案目录：$DSH_HOME/profiles/<profile>-<timestamp>
            let profiles_root = config::get_dsh_data_path(app_handle).join("profiles");
            fs::create_dir_all(&profiles_root).map_err(|e| {
                format!("BACKUP_RESTORE_MKDIR_PROFILES: {e}")
            })?;
            let new_dir = profiles_root.join(format!("{active}-{timestamp}"));
            // 目标已存在时不合并解压：解压会把旧备份的内容混进既有档案，而调用方
            // 会以为得到的是一个全新的档案目录。独占创建而不是先查后建：解压内部是
            // `create_dir_all`，若只做存在性检查，别的组件在此刻建出的目录会被当成
            // 我们的新档案，失败清理时 `remove_dir_all` 会连同它的内容一起删掉。
            match fs::create_dir(&new_dir) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    return Err(format!(
                        "BACKUP_RESTORE_TARGET_EXISTS: {}",
                        new_dir.display()
                    ));
                }
                Err(e) => return Err(format!("BACKUP_RESTORE_MKDIR_NEW: {e}")),
            }
            if let Err(e) = archive::extract_archive(&archive_path, &new_dir) {
                // 失败时删掉本次创建的半成品目录，避免同名时间戳重试被上面的检查挡住
                let _ = fs::remove_dir_all(&new_dir);
                return Err(format!("BACKUP_RESTORE_EXTRACT_FAILED: {e}"));
            }
        }
    }
    Ok(())
}

/// 按保留份数裁剪旧备份（超出时删除最旧的）。
fn prune_if_needed(app_handle: &AppHandle) -> Result<(), String> {
    let setting = config::get_store_dat_setting(app_handle);
    retention::prune_old_backups(app_handle, setting.backup_retention_count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn malformed_manifest_remains_an_error_across_repeated_reads() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(".manifest.json");
        let contents = b"{\"backups\":[";
        fs::write(&path, contents).unwrap();
        assert!(read_manifest(root.path()).is_err());
        assert!(read_manifest(root.path()).is_err());
        assert_eq!(fs::read(&path).unwrap(), contents);
        assert!(!root.path().join(".manifest.corrupt").exists());
    }

    #[test]
    fn manifest_read_errors_are_not_treated_as_an_empty_backup_list() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(".manifest.json");
        fs::write(&path, [0xff, 0xfe]).unwrap();
        assert!(read_manifest(root.path()).is_err());
        assert_eq!(fs::read(&path).unwrap(), [0xff, 0xfe]);
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(read_manifest(root.path()).is_err());
    }

    #[test]
    fn timestamp_format_is_valid() {
        let ts = now_timestamp();
        // 格式：yyyymmddhhmmss（紧凑 14 位）
        assert_eq!(ts.len(), 14, "时间戳长度应为 14: {ts}");
        assert!(ts.chars().all(|c| c.is_ascii_digit()), "时间戳应全为数字: {ts}");
    }

    /// 碰撞安全的时间戳必须同时是文件名主体：还原 / 删除按时间戳拼文件名，
    /// 若信息里的时间戳与文件名不一致就会指向另一份备份。
    #[test]
    fn collision_safe_timestamp_matches_archive_filename() {
        let dir = std::env::temp_dir().join(format!("dsh-backup-collision-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let base = "2026-10-02T15-24-08";
        let first = collision_safe_timestamp(&dir, base).unwrap();
        assert_eq!(first, base, "无同名文件时应保持原时间戳");
        fs::write(dir.join(archive_filename("web", &first)), b"first").unwrap();

        let second = collision_safe_timestamp(&dir, base).unwrap();
        assert_ne!(second, first, "同名归档已存在时必须换一个时间戳");
        assert_eq!(second, format!("{base}-2"));
        assert!(
            !dir.join(archive_filename("web", &second)).exists(),
            "换出的时间戳必须是一个空闲文件名"
        );
        fs::write(dir.join(archive_filename("web", &second)), b"second").unwrap();
        assert_eq!(
            collision_safe_timestamp(&dir, base).unwrap(),
            format!("{base}-3"),
            "再次碰撞应继续递增"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn collision_timestamp_does_not_reuse_pruned_lower_suffixes() {
        let dir = std::env::temp_dir().join(format!(
            "dsh-backup-pruned-collision-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let base = "20261011093345";
        for suffix in ["-9", "-10", "-12"] {
            fs::write(
                dir.join(archive_filename("web", &format!("{base}{suffix}"))),
                b"retained",
            )
            .unwrap();
        }
        fs::write(
            dir.join(archive_filename("other", &format!("{base}-99"))),
            b"other",
        )
        .unwrap();
        assert_eq!(
            collision_safe_timestamp(&dir, base).unwrap(),
            format!("{base}-100")
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn repeated_creation_and_retention_preserve_the_last_two_archives() {
        let dir =
            std::env::temp_dir().join(format!("dsh-backup-retention-loop-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        for index in 1..=20 {
            let timestamp = collision_safe_timestamp(&dir, "20261011093345").unwrap();
            let profile = if index % 2 == 0 { "web" } else { "tauri" };
            let path = dir.join(archive_filename(profile, &timestamp));
            fs::write(&path, index.to_string()).unwrap();
            let mut manifest = read_manifest(&dir).unwrap();
            manifest.backups.push(ManifestEntry {
                timestamp,
                profile: profile.into(),
                path: path.to_string_lossy().into_owned(),
                size: 0,
                include_credentials: false,
            });
            write_manifest(&dir, &manifest).unwrap();
            retention::prune_backups_in_dir(&dir, 2).unwrap();
            assert!(path.exists(), "latest archive {index} was pruned");
        }
        let manifest = read_manifest(&dir).unwrap();
        assert_eq!(
            manifest
                .backups
                .iter()
                .map(|entry| entry.timestamp.as_str())
                .collect::<Vec<_>>(),
            ["20261011093345-19", "20261011093345-20"]
        );
        assert_eq!(fs::read_to_string(&manifest.backups[0].path).unwrap(), "19");
        assert_eq!(fs::read_to_string(&manifest.backups[1].path).unwrap(), "20");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn collision_timestamp_rejects_directory_errors_and_sequence_overflow() {
        let dir = std::env::temp_dir().join(format!(
            "dsh-backup-collision-errors-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        assert!(collision_safe_timestamp(&dir, "20261011093345")
            .unwrap_err()
            .starts_with("BACKUP_READDIR:"));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("web-20261011093345-18446744073709551615.tar.zst"),
            b"keep",
        )
        .unwrap();
        assert_eq!(
            collision_safe_timestamp(&dir, "20261011093345").unwrap_err(),
            "BACKUP_SEQUENCE_EXHAUSTED"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    /// 集成测试：create_archive 真实文件系统往返（验证 zstd 多线程在 CI/release 下可用）
    #[test]
    fn create_archive_real_filesystem_roundtrip() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let suffix = COUNTER.fetch_add(1, Ordering::SeqCst);

        let tmp_root = std::env::temp_dir().join(format!("dsh-backup-int-{}-{}", std::process::id(), suffix));
        let _ = fs::remove_dir_all(&tmp_root);
        fs::create_dir_all(&tmp_root).unwrap();

        // 写入多个文件模拟 $DSH_HOME
        let source = tmp_root.join("source");
        fs::create_dir_all(&source).unwrap();
        for i in 0..20 {
            let mut f = fs::File::create(source.join(format!("file_{i}.txt"))).unwrap();
            f.write_all(format!("hello {i}").as_bytes()).unwrap();
        }

        // 备份到独立目录
        let backup_dir = tmp_root.join(".backups");
        fs::create_dir_all(&backup_dir).unwrap();
        let dest = backup_dir.join(format!("test_{suffix}.tar.zst"));

        archive::create_archive(&source, &dest, false).unwrap();
        assert!(dest.exists(), "备份文件应已创建");
        let size = fs::metadata(&dest).unwrap().len();
        assert!(size > 0, "备份文件应非空");

        // 还原并验证
        let restore_dir = tmp_root.join("restored");
        archive::extract_archive(&dest, &restore_dir).unwrap();

        for i in 0..20 {
            let content = fs::read_to_string(restore_dir.join(format!("file_{i}.txt"))).unwrap();
            assert_eq!(content, format!("hello {i}"), "文件 {i} 内容应一致");
        }

        let _ = fs::remove_dir_all(&tmp_root);
    }

    #[test]
    fn manifest_round_trip() {
        let dir = std::env::temp_dir().join(format!("dsh-backup-manifest-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let manifest = BackupManifest {
            backups: vec![ManifestEntry {
                timestamp: "2026-08-30T12-00-00".to_string(),
                profile: "web".to_string(),
                path: "/tmp/x.tar.gz".to_string(),
                size: 100,
                include_credentials: false,
            }],
        };
        write_manifest(&dir, &manifest).unwrap();
        let read = read_manifest(&dir).unwrap();
        assert_eq!(read.backups.len(), 1);
        assert_eq!(read.backups[0].timestamp, "2026-08-30T12-00-00");
        assert_eq!(read.backups[0].size, 100);

        let _ = fs::remove_dir_all(&dir);
    }

    /// 直接测试用户实际备份文件的完整还原（绕过 GUI）
    #[test]
    fn restore_real_backup_to_temp() {
        let backup = std::path::Path::new(
            "/Users/coderstory/.dsh/.backups/2026-08-31T15-04-18.tar.zst"
        );
        if !backup.exists() {
            eprintln!("[skip] 备份文件不存在: {}", backup.display());
            return;
        }

        // 还原到临时目录
        let dest = std::env::temp_dir().join("dsh-restore-real-test");
        let _ = fs::remove_dir_all(&dest);
        fs::create_dir_all(&dest).unwrap();

        let backup_size = fs::metadata(backup).unwrap().len();

        // 调用实际的 extract_archive
        archive::extract_archive(backup, &dest).expect("extract_archive 失败");

        // 递归统计还原后的文件数和大小
        fn walk(p: &std::path::Path, files: &mut u64, dirs: &mut u64, links: &mut u64, size: &mut u64) {
            let Ok(rd) = fs::read_dir(p) else { return };
            for e in rd.flatten() {
                let Ok(meta) = fs::symlink_metadata(e.path()) else { continue };
                if meta.is_dir() {
                    *dirs += 1;
                    walk(&e.path(), files, dirs, links, size);
                }
                else if meta.file_type().is_symlink() {
                    *links += 1;
                }
                else if meta.is_file() {
                    *files += 1;
                    *size += meta.len();
                }
            }
        }
        let mut files = 0u64;
        let mut dirs = 0u64;
        let mut links = 0u64;
        let mut total_size = 0u64;
        walk(&dest, &mut files, &mut dirs, &mut links, &mut total_size);

        println!("\n========== 完整还原报告 ==========");
        println!("备份文件: {} ({} bytes)", backup.display(), backup_size);
        println!("还原目标: {}", dest.display());
        println!("还原统计:");
        println!("  文件:     {}", files);
        println!("  目录:     {}", dirs);
        println!("  符号链接: {}", links);
        println!("  总大小:   {} bytes ({:.2} MB)", total_size, total_size as f64 / 1_048_576.0);

        // 抽样验证关键文件
        for name in ["cordis.patch.yml", "package.json", "pnpm-workspace.yaml", ".npmrc"] {
            let path = dest.join(name);
            if path.exists() {
                println!("  ✓ {} ({} bytes)", name, fs::metadata(&path).unwrap().len());
            }
            else {
                println!("  ✗ {} 缺失", name);
            }
        }

        let nm = dest.join("node_modules");
        if nm.is_dir() {
            let mut nm_n = 0u64;
            walk(&nm, &mut nm_n, &mut 0, &mut 0, &mut 0);
            println!("  ✓ node_modules ({} 文件/目录)", nm_n);
        }

        println!("\n压缩比: {:.2}x ({} → {} bytes)",
            total_size as f64 / backup_size as f64,
            total_size, backup_size);

        let _ = fs::remove_dir_all(&dest);
    }
}
