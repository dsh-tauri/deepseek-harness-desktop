//! 备份归档：tar.zst 创建与解压。
//!
//! 归档格式：`tar::Builder` + `zstd::stream::Encoder` 创建 `.tar.zst` 单文件，
//! `zstd::stream::Decoder` + `tar::Archive` 解压。zstd 多线程压缩比 gzip 快
//! 3-5 倍、压缩率更优。解压前逐条目校验路径不跳出目标目录（防路径穿越）。
//!
//! 除 zstd 外，也提供 `extract_archive_gzip`（复用同一条目安全校验逻辑）供
//! 插件快照等使用 gzip 压缩的 tar.tgz 解码（见 `service::plugin::snapshot`）。

use std::fs;
use std::io::{Read, Write};
use std::path::Path;

/// 创建符号链接（平台差异处理）。
#[cfg(unix)]
fn create_symlink(target: &Path, dst: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, dst)
}

/// 创建符号链接（Windows：需要管理员权限，best-effort）。
#[cfg(windows)]
fn create_symlink(target: &Path, dst: &Path) -> std::io::Result<()> {
    // Windows 符号链接需要管理员权限；目录联接不需要但仅限目录。
    // best-effort：失败返回 AlreadyExists 让上层跳过。
    std::os::windows::fs::symlink_dir(target, dst)
        .or_else(|_| std::os::windows::fs::symlink_file(target, dst))
}

const EXCLUDED_NAMES: &[&str] = &[".backups", ".plugin-backups", "node_modules"];

/// 凭据文件名。
const CREDENTIALS_FILE: &str = ".credentials.yaml";

/// 判断一条相对路径是否应被排除。
///
/// - `.backups/` 自身必须排除（防递归包含）。
/// - `.harness.pid` 等运行时产物必须排除。
/// - `node_modules/` 是可重建的运行时依赖，始终排除。
/// - `.credentials.yaml` 按 `include_credentials` 决定。
fn is_excluded(rel: &Path, include_credentials: bool) -> bool {
    if let Some(name) = rel.file_name().and_then(|n| n.to_str()) {
        if EXCLUDED_NAMES.contains(&name) || crate::config::HARNESS_PID_MARKER_NAMES.contains(&name)
        {
            return true;
        }
        if name == CREDENTIALS_FILE && !include_credentials {
            return true;
        }
    }
    false
}

/// 递归地把 `dir` 下所有文件追加到 tar 构建器，跳过排除项。
///
/// `rel` 为当前目录到归档根（`source`）的相对路径前缀，`source` 为原始归档根
///（用于计算根相对路径以做排除判断）。
fn append_dir_filtered(
    builder: &mut tar::Builder<impl Write>,
    dir: &Path,
    source: &Path,
    rel: &Path,
    include_credentials: bool,
    reject_links: bool,
) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| format!("BACKUP_ARCHIVE_READDIR: {e}"))? {
        let entry = entry.map_err(|e| format!("BACKUP_ARCHIVE_ENTRY: {e}"))?;
        let path = entry.path();
        let name = path
            .file_name()
            .ok_or_else(|| format!("BACKUP_ARCHIVE_NO_NAME: {}", path.display()))?;
        let archived = rel.join(name);
        // 根相对路径（用于排除判断）
        let root_rel = path
            .strip_prefix(source)
            .map_err(|e| format!("BACKUP_ARCHIVE_STRIP: {e}"))?;
        if is_excluded(root_rel, include_credentials) {
            continue;
        }
        let ty = entry
            .file_type()
            .map_err(|e| format!("BACKUP_ARCHIVE_TYPE: {e}"))?;
        #[cfg(windows)]
        if reject_links {
            use std::os::windows::fs::MetadataExt;
            let meta = fs::symlink_metadata(&path).map_err(|e| format!("BACKUP_ARCHIVE_TYPE: {e}"))?;
            if meta.file_attributes() & 0x400 != 0 {
                return Err(format!("RECOVERY_LINK_UNSUPPORTED: {}", path.display()));
            }
        }
        if ty.is_dir() {
            builder
                .append_dir(&archived, &path)
                .map_err(|e| format!("BACKUP_ARCHIVE_APPEND_DIR: {e}"))?;
            append_dir_filtered(builder, &path, source, &archived, include_credentials, reject_links)?;
        } else if ty.is_file() {
            builder
                .append_file(
                    &archived,
                    &mut fs::File::open(&path).map_err(|e| format!("BACKUP_ARCHIVE_OPEN: {e}"))?,
                )
                .map_err(|e| format!("BACKUP_ARCHIVE_APPEND_FILE: {e}"))?;
        } else if ty.is_symlink() {
            if reject_links {
                return Err(format!("RECOVERY_LINK_UNSUPPORTED: {}", path.display()));
            }
            // 符号链接：读取 target，tar Symlink 存储（GNU header 链接名上限 100 字节）
            let target =
                std::fs::read_link(&path).map_err(|e| format!("BACKUP_ARCHIVE_READLINK: {e}"))?;
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_size(0);
            match header.set_link_name(&target) {
                Ok(()) => {
                    builder
                        .append_link(&mut header, &archived, &target)
                        .map_err(|e| format!("BACKUP_ARCHIVE_APPEND_LINK: {e}"))?;
                }
                // 单个链接放不进 tar header 不能拖垮整份备份：跳过并继续
                Err(e) => {
                    eprintln!(
                        "[backup] 跳过无法归档的符号链接: {} -> {} ({e})",
                        path.display(),
                        target.display()
                    );
                }
            }
        } else {
            // socket/FIFO/设备：runtime 资源，跳过
            eprintln!("[backup] 跳过特殊文件: {} ({:?})", path.display(), ty);
        }
    }
    Ok(())
}

/// 创建 tar.zst 归档。
///
/// 把 `source` 目录打包到 `dest` 文件。`include_credentials` 控制是否包含
/// `.credentials.yaml`。始终排除 `.backups/`、`.plugin-backups/`、`.harness.pid`、
/// `node_modules/`。使用 zstd 多线程压缩（级别 0 = 默认 3，
/// 启用 multithread 加速）。
pub fn create_archive(source: &Path, dest: &Path, include_credentials: bool) -> Result<(), String> {
    create_archive_impl(source, dest, include_credentials, false)
}

pub(super) fn create_recovery_archive(source: &Path, dest: &Path, include_credentials: bool) -> Result<(), String> {
    create_archive_impl(source, dest, include_credentials, true)
}

fn create_archive_impl(source: &Path, dest: &Path, include_credentials: bool, reject_links: bool) -> Result<(), String> {
    let file = fs::File::create(dest).map_err(|e| format!("BACKUP_ARCHIVE_CREATE: {e}"))?;
    // 级别 0 使用 zstd 默认压缩级别（3），在速度与压缩率间取得平衡。
    // 多线程压缩：利用多核 CPU 并行压缩块，速度比单线程快 3-5 倍。
    let workers = std::thread::available_parallelism()
        .map(|n| if reject_links { n.get().min(2) } else { n.get() } as u32)
        .unwrap_or(1);
    let mut enc =
        zstd::stream::Encoder::new(file, 0).map_err(|e| format!("BACKUP_ARCHIVE_ENCODER: {e}"))?;
    enc.multithread(workers)
        .map_err(|e| format!("BACKUP_ARCHIVE_MULTITHREAD: {e}"))?;
    let mut archive = tar::Builder::new(enc);
    append_dir_filtered(
        &mut archive,
        source,
        source,
        Path::new("."),
        include_credentials,
        reject_links,
    )?;
    archive
        .finish()
        .map_err(|e| format!("BACKUP_ARCHIVE_FINISH: {e}"))?;
    // 必须显式 finish 编码器，否则尾部帧丢失导致文件截断
    archive
        .into_inner()
        .map_err(|e| format!("BACKUP_ARCHIVE_INNER: {e}"))?
        .finish()
        .map_err(|e| format!("BACKUP_ARCHIVE_FLUSH: {e}"))?;
    Ok(())
}

/// 解压 tar.zst 归档到 `dest` 目录。
///
/// 自动兼容两种归档格式：
/// 1. 旧格式：条目以 `profiles/<id>/...` 开头（备份整个 `$DSH_HOME`）
/// 2. 新格式：条目直接以文件名开头（只备份激活 profile 内容）
///
/// 检测首条目前缀，剥离 `profiles/<id>/` 后解压到 `dest`。
pub fn extract_archive(archive: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("BACKUP_EXTRACT_MKDIR: {e}"))?;
    let file = fs::File::open(archive).map_err(|e| format!("BACKUP_EXTRACT_OPEN: {e}"))?;
    // 注意：zstd 解码不支持多线程（每帧必须顺序解码），保持单线程
    let dec =
        zstd::stream::Decoder::new(file).map_err(|e| format!("BACKUP_EXTRACT_DECODER: {e}"))?;
    let mut archive = tar::Archive::new(dec);
    extract_tar_entries(&mut archive, dest)
}

/// 解压 gzip 压缩的 tar.tgz 归档到 `dest` 目录（复用与 `extract_archive` 相同的
/// 逐条目路径逃逸防护与符号链接拒绝逻辑）。
///
/// 供插件快照（`service::plugin::snapshot`，快照归档使用 gzip）暂存/还原时解压。
pub fn extract_archive_gzip(archive: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("BACKUP_EXTRACT_MKDIR: {e}"))?;
    let file = fs::File::open(archive).map_err(|e| format!("BACKUP_EXTRACT_OPEN: {e}"))?;
    let dec = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(dec);
    extract_tar_entries(&mut archive, dest)
}

/// 判断条目的中间目录里是否存在链接（symlink / junction）。
///
/// 只检查 `relative` 的父级组件，不含 `dest` 自身：目标目录本身就是链接是
/// 调用方的选择（例如用户把 `$DSH_HOME/sessions` 软链到别处），不属于越界。
fn has_link_parent(dest: &Path, relative: &Path) -> bool {
    let Some(parent) = relative.parent() else {
        return false;
    };
    let mut current = dest.to_path_buf();
    for component in parent.components() {
        current.push(component);
        let Ok(metadata) = current.symlink_metadata() else {
            continue;
        };
        let file_type = metadata.file_type();
        #[cfg(windows)]
        let is_link = {
            use std::os::windows::fs::FileTypeExt;
            file_type.is_symlink() || file_type.is_symlink_dir()
        };
        #[cfg(not(windows))]
        let is_link = file_type.is_symlink();
        if is_link {
            return true;
        }
    }
    false
}

/// 从 tar 归档安全解压所有条目到 `dest`（压缩格式无关）。
///
/// 逐个条目：拒绝绝对路径/`..`/盘符前缀（防逃逸）、拒绝中间目录为链接的
/// 条目、拒绝硬链接、目录直接创建、符号链接按 target 创建、普通文件先写
/// 临时文件再原子 rename。自定义解压（替代 `entry.unpack`）是为了规避
/// macOS 上的 tar bug。
fn extract_tar_entries<R: Read>(archive: &mut tar::Archive<R>, dest: &Path) -> Result<(), String> {
    // 禁用 ownership 保留：归档里 uid/gid 可能是 root（uid=0），非 root 用户无法 chown
    archive.set_preserve_ownerships(false);

    // 单次遍历：避免重复调用 archive.entries() 导致 decoder 状态错乱
    for entry in archive
        .entries()
        .map_err(|e| format!("BACKUP_EXTRACT_ENTRIES: {e}"))?
    {
        let mut entry = entry.map_err(|e| format!("BACKUP_EXTRACT_ENTRY: {e}"))?;
        let path = entry
            .path()
            .map_err(|e| format!("BACKUP_EXTRACT_PATH: {e}"))?
            .into_owned();

        // 拒绝绝对路径与含 `..` / 盘符前缀的条目（防路径穿越）
        if path.has_root()
            || path.components().any(|c| {
                matches!(
                    c,
                    std::path::Component::ParentDir | std::path::Component::Prefix(_)
                )
            })
        {
            return Err(format!(
                "BACKUP_EXTRACT_PATH_ESCAPE: entry {:?} escapes the restore directory",
                path
            ));
        }

        // 不剥离 profiles/<id>/ 前缀——新格式备份不再含此前缀
        // 旧格式备份需用户手动处理（先在 /tmp 解压再 rsync）
        let stripped: std::path::PathBuf = path.clone();

        let dest_path = dest.join(&stripped);

        // 中间目录是链接时，create_dir_all + 写入会顺着链接落到 dest 之外，直接拒绝
        if has_link_parent(dest, &stripped) {
            return Err(format!(
                "BACKUP_EXTRACT_LINK_PARENT: entry {:?} is under a linked directory",
                path
            ));
        }

        // 拒绝硬链接
        let entry_type = entry.header().entry_type();
        if entry_type.is_hard_link() {
            return Err(format!(
                "BACKUP_EXTRACT_UNSUPPORTED_HARDLINK: entry {:?} is a hard link",
                path
            ));
        }

        // 创建父目录
        if let Some(parent) = dest_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("BACKUP_EXTRACT_MKDIR_PARENT: {e}"))?;
        }

        // 根据 entry type 分支处理（替代 entry.unpack 避免 macOS tar bug）
        let entry_type = entry.header().entry_type();
        if entry_type.is_dir() {
            // 目录：直接创建
            fs::create_dir_all(&dest_path)
                .map_err(|e| format!("BACKUP_EXTRACT_MKDIR: {e} (path={})", path.display()))?;
        } else if entry_type.is_symlink() {
            // 符号链接：读取 target 并创建链接
            let target = entry
                .link_name()
                .map_err(|e| format!("BACKUP_EXTRACT_LINK_NAME: {e} (path={})", path.display()))?
                .ok_or_else(|| format!("BACKUP_EXTRACT_NO_LINK_NAME: {path:?}"))?;
            if let Some(parent) = dest_path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            // 创建符号链接（平台差异：Unix 直接用 symlink，Windows 需要权限）
            if let Err(e) = create_symlink(&target, &dest_path) {
                // 链接已存在则跳过（与原文件冲突）
                if e.kind() != std::io::ErrorKind::AlreadyExists {
                    return Err(format!(
                        "BACKUP_EXTRACT_SYMLINK: {e} (target={}, dest={})",
                        target.display(),
                        dest_path.display()
                    ));
                }
            }
        } else {
            // 普通文件：先写临时文件，再原子 rename（macOS 上 unlink + write 会被
            // 读锁干扰成 0 字节；temp + rename 是原子的，原文件在成功前保持完好）
            let mut content = Vec::new();
            std::io::Read::read_to_end(&mut entry, &mut content)
                .map_err(|e| format!("BACKUP_EXTRACT_READ: {e} (path={})", path.display()))?;
            // 临时文件路径：<dest>.tmp.<pid>.<nanos>
            let tmp_name = format!(
                "{}.tmp.{}.{}",
                dest_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("restore"),
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            );
            let tmp_path = dest_path.with_file_name(tmp_name);
            fs::write(&tmp_path, &content).map_err(|e| {
                format!("BACKUP_EXTRACT_WRITE_TMP: {e} (tmp={})", tmp_path.display())
            })?;
            // 原子 rename 替换目标文件（macOS 上 rename 不要求目标文件关闭）
            fs::rename(&tmp_path, &dest_path).map_err(|e| {
                format!(
                    "BACKUP_EXTRACT_RENAME: {e} (tmp={}, dest={})",
                    tmp_path.display(),
                    dest_path.display()
                )
            })?;
        }
    }
    Ok(())
}

/// 列出归档中所有条目的相对路径（用于测试校验排除项）。
#[cfg(test)]
fn list_archive_entries(archive: &Path) -> Result<Vec<String>, String> {
    let file = fs::File::open(archive).map_err(|e| format!("BACKUP_LIST_OPEN: {e}"))?;
    let dec = zstd::stream::Decoder::new(file).map_err(|e| format!("BACKUP_LIST_DECODER: {e}"))?;
    let mut archive = tar::Archive::new(dec);
    let mut entries = Vec::new();
    for entry in archive
        .entries()
        .map_err(|e| format!("BACKUP_LIST_ENTRIES: {e}"))?
    {
        let entry = entry.map_err(|e| format!("BACKUP_LIST_ENTRY: {e}"))?;
        let path = entry.path().map_err(|e| format!("BACKUP_LIST_PATH: {e}"))?;
        entries.push(path.to_string_lossy().replace('\\', "/"));
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// 全局递增计数器，保证并行测试使用互不冲突的临时目录。
    fn unique_suffix() -> String {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        format!(
            "{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        )
    }

    /// 计算与 source 同级的归档目标路径。
    fn archive_dest(source: &Path) -> PathBuf {
        source.parent().unwrap().join(format!(
            "{}.tar.zst",
            source.file_name().unwrap().to_str().unwrap()
        ))
    }

    /// 创建临时目录并写入若干文件作为测试夹具。
    fn setup_source_dir(files: &[(&str, &str)]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dsh-backup-archive-{}", unique_suffix()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for (rel, content) in files {
            let path = dir.join(rel);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            let mut f = fs::File::create(&path).unwrap();
            f.write_all(content.as_bytes()).unwrap();
        }
        dir
    }

    #[test]
    fn creates_tar_zst_archive() {
        let source = setup_source_dir(&[("hello.txt", "world")]);
        let dest = archive_dest(&source);
        create_archive(&source, &dest, false).unwrap();
        assert!(dest.exists(), "归档文件应存在");
        assert!(fs::metadata(&dest).unwrap().len() > 0, "归档文件应非空");
        let _ = fs::remove_dir_all(&source);
        let _ = fs::remove_file(&dest);
    }

    #[test]
    fn excludes_backup_dir_from_archive() {
        let source = setup_source_dir(&[
            ("hello.txt", "world"),
            (".backups/old.tar.zst", "junk"),
            (".backups/.manifest.json", "{}"),
            (".plugin-backups/dsh-market.tgz", "snapshot"),
        ]);
        let dest = archive_dest(&source);
        create_archive(&source, &dest, false).unwrap();
        let entries = list_archive_entries(&dest).unwrap();
        assert!(
            entries.iter().all(|e| !e.contains(".backups")),
            ".backups 应被排除，实际条目: {entries:?}"
        );
        assert!(
            entries.iter().all(|e| !e.contains(".plugin-backups")),
            ".plugin-backups 应被排除（防单插件快照被整库备份递归包含），实际条目: {entries:?}"
        );
        assert!(
            entries.iter().any(|e| e.contains("hello.txt")),
            "hello.txt 应存在"
        );
        let _ = fs::remove_dir_all(&source);
        let _ = fs::remove_file(&dest);
    }

    #[test]
    fn credentials_excluded_by_default() {
        let source = setup_source_dir(&[(".credentials.yaml", "key: secret"), ("data.txt", "ok")]);
        let dest = archive_dest(&source);
        create_archive(&source, &dest, false).unwrap();
        let entries = list_archive_entries(&dest).unwrap();
        assert!(
            entries.iter().all(|e| !e.contains(".credentials.yaml")),
            "凭据默认应被排除，实际条目: {entries:?}"
        );
        let _ = fs::remove_dir_all(&source);
        let _ = fs::remove_file(&dest);
    }

    #[test]
    fn credentials_included_when_opted_in() {
        let source = setup_source_dir(&[(".credentials.yaml", "key: secret"), ("data.txt", "ok")]);
        let dest = archive_dest(&source);
        create_archive(&source, &dest, true).unwrap();
        let entries = list_archive_entries(&dest).unwrap();
        assert!(
            entries.iter().any(|e| e.contains(".credentials.yaml")),
            "勾选时凭据应被包含，实际条目: {entries:?}"
        );
        let _ = fs::remove_dir_all(&source);
        let _ = fs::remove_file(&dest);
    }

    #[test]
    fn restore_overwrites_existing_data() {
        let source = setup_source_dir(&[("config.yaml", "version: 1")]);
        let dest_zst = archive_dest(&source);
        create_archive(&source, &dest_zst, false).unwrap();

        // 还原到新目录
        let restore_dir =
            std::env::temp_dir().join(format!("dsh-backup-restore-{}", unique_suffix()));
        extract_archive(&dest_zst, &restore_dir).unwrap();

        let restored_path = restore_dir.join("config.yaml");
        if restored_path.exists() {
            let restored = fs::read_to_string(&restored_path).unwrap();
            assert_eq!(restored, "version: 1", "还原后应回到原始内容");
        }
        let _ = fs::remove_dir_all(&source);
        let _ = fs::remove_file(&dest_zst);
        let _ = fs::remove_dir_all(&restore_dir);
    }

    /// 手工构造含路径穿越条目的 tar 头部（绕过 `tar::Header::set_path` 对 `..` 的校验）。
    fn write_raw_tar_entry<W: std::io::Write>(
        writer: &mut W,
        path: &str,
        data: &[u8],
    ) -> Result<(), String> {
        let mut header = [0u8; 512];
        // name (0..100)
        let path_bytes = path.as_bytes();
        if path_bytes.len() > 100 {
            return Err("path too long".to_string());
        }
        header[0..path_bytes.len()].copy_from_slice(path_bytes);
        // mode 0644 (octal, 100..108)
        let mode = b"0000644\0";
        header[100..108].copy_from_slice(mode);
        // uid/gid 0 (108..124)
        header[108..116].copy_from_slice(b"0000000\0");
        header[116..124].copy_from_slice(b"0000000\0");
        // size (octal, 124..136)
        let size_str = format!("{:011o}\0", data.len());
        header[124..124 + size_str.len()].copy_from_slice(size_str.as_bytes());
        // mtime 0 (136..148)
        header[136..148].copy_from_slice(b"00000000000\0");
        // typeflag Regular (156)
        header[156] = b'0';
        // magic + version (257..265)
        header[257..263].copy_from_slice(b"ustar\0");
        header[263..265].copy_from_slice(b"00");
        // checksum (148..156): 先填空格，再算字节和
        header[148..156].copy_from_slice(b"        ");
        let checksum: u32 = header.iter().map(|&b| b as u32).sum();
        let ck_str = format!("{:06o}\0 ", checksum);
        header[148..148 + ck_str.len()].copy_from_slice(ck_str.as_bytes());

        writer.write_all(&header).map_err(|e| e.to_string())?;
        writer.write_all(data).map_err(|e| e.to_string())?;
        // pad to 512 boundary
        let pad = (512 - (data.len() % 512)) % 512;
        if pad > 0 {
            writer
                .write_all(&vec![0u8; pad])
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    #[test]
    fn rejects_path_traversal_on_restore() {
        let dir = std::env::temp_dir().join(format!("dsh-backup-traversal-{}", unique_suffix()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let archive_path = dir.join("evil.tar.zst");
        // 以裸字节写 zstd（tar crate 的 set_path 会拒绝 ..，故绕开）
        let file = fs::File::create(&archive_path).unwrap();
        let mut enc = zstd::stream::Encoder::new(file, 0).unwrap();
        write_raw_tar_entry(&mut enc, "../../../tmp/dsh-evil-passwd", b"evil").unwrap();
        // tar 文件尾：两个空块
        enc.write_all(&[0u8; 1024]).unwrap();
        enc.finish().unwrap();

        let dest = dir.join("dest");
        let result = extract_archive(&archive_path, &dest);
        assert!(result.is_err(), "路径穿越应被拒绝: {result:?}");
        assert!(
            !std::path::Path::new("/tmp/dsh-evil-passwd").exists(),
            "恶意文件不应被写入系统目录"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_absolute_path_on_restore() {
        let dir = std::env::temp_dir().join(format!("dsh-backup-absolute-{}", unique_suffix()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let archive_path = dir.join("evil.tar.zst");
        // 以裸字节写 zstd（tar crate 的 set_path 会拒绝绝对路径，故绕开）
        let file = fs::File::create(&archive_path).unwrap();
        let mut enc = zstd::stream::Encoder::new(file, 0).unwrap();
        write_raw_tar_entry(&mut enc, "/tmp/dsh-evil-absolute", b"evil").unwrap();
        enc.write_all(&[0u8; 1024]).unwrap();
        enc.finish().unwrap();

        let dest = dir.join("dest");
        let result = extract_archive(&archive_path, &dest);
        assert!(result.is_err(), "绝对路径条目应被拒绝: {result:?}");
        assert!(
            !dest.join("tmp").join("dsh-evil-absolute").exists(),
            "绝对路径条目不应被解压"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn excludes_runtime_dependencies_and_restores_configuration() {
        let config = [
            ("package.json", "{\"dependencies\":{\"example\":\"1.0.0\"}}"),
            ("pnpm-lock.yaml", "lockfileVersion: '9.0'"),
            ("pnpm-workspace.yaml", "packages: ['plugins/*']"),
            (".npmrc", "confirmModulesPurge=false"),
            ("cordis.patch.yml", "plugins: {}"),
            ("plugins/local/package.json", "{\"name\":\"local\"}"),
            ("plugins/local/index.js", "export default {}"),
            ("node_modules-config.json", "{}"),
        ];
        let mut files = config.to_vec();
        files.extend([
            (".harness.pid", "12345"),
            (".harness-nightly.pid", "23456"),
            ("node_modules/.modules.yaml", "modules: {}"),
            (
                "node_modules/.pnpm/example@1.0.0/node_modules/example/index.js",
                "runtime",
            ),
            (
                "plugins/local/node_modules/example/index.js",
                "nested runtime",
            ),
        ]);
        let source = setup_source_dir(&files);
        let dest = archive_dest(&source);
        create_archive(&source, &dest, false).unwrap();
        let entries = list_archive_entries(&dest).unwrap();
        assert!(
            entries
                .iter()
                .all(|entry| !Path::new(entry).components().any(|component| {
                    component.as_os_str() == "node_modules"
                        || component.as_os_str() == ".harness.pid"
                        || component.as_os_str() == ".harness-nightly.pid"
                })),
            "运行时依赖和 PID 应被排除，实际条目: {entries:?}"
        );
        let restore_dir = source.join("restored");
        extract_archive(&dest, &restore_dir).unwrap();
        for (path, content) in config {
            assert_eq!(
                fs::read_to_string(restore_dir.join(path)).unwrap(),
                content,
                "{path}"
            );
        }
        assert!(!restore_dir.join("node_modules").exists());
        assert!(!restore_dir.join("plugins/local/node_modules").exists());
        let _ = fs::remove_dir_all(&source);
        let _ = fs::remove_file(&dest);
    }

    #[test]
    fn excludes_linked_node_modules_before_reading_target() {
        let source = setup_source_dir(&[("config.yaml", "keep")]);
        let target = setup_source_dir(&[("example/index.js", "runtime")]);
        let link = source.join("node_modules");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).unwrap();
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let created = std::process::Command::new("cmd")
                .arg("/C")
                .raw_arg(format!(
                    "mklink /J \"{}\" \"{}\"",
                    link.display(),
                    target.display()
                ))
                .creation_flags(0x08000000)
                .status()
                .unwrap();
            assert!(created.success(), "目录联接创建应成功");
        }
        let dest = archive_dest(&source);
        create_archive(&source, &dest, false).unwrap();
        assert_eq!(list_archive_entries(&dest).unwrap(), ["config.yaml"]);
        fs::remove_dir_all(&source).unwrap();
        assert_eq!(
            fs::read_to_string(target.join("example/index.js")).unwrap(),
            "runtime"
        );
        fs::remove_dir_all(&target).unwrap();
        fs::remove_file(&dest).unwrap();
    }

    /// 多线程压缩回归：archive 创建后能用 extract_archive 完整还原内容。
    #[test]
    fn multithread_archive_roundtrip() {
        // 构造足够多的文件确保多线程有意义
        let files: Vec<(String, String)> = (0..50)
            .map(|i| {
                let name = format!("file_{i}.txt");
                let content = format!("content_{i}_{content}", content = "x".repeat(100));
                (name, content)
            })
            .collect();
        let refs: Vec<(&str, &str)> = files
            .iter()
            .map(|(p, c)| (p.as_str(), c.as_str()))
            .collect();
        let source = setup_source_dir(&refs);
        let dest = archive_dest(&source);

        create_archive(&source, &dest, false).unwrap();
        assert!(dest.exists(), "归档文件应存在");

        // 解压到新目录并验证内容
        let restore_dir =
            std::env::temp_dir().join(format!("dsh-backup-mt-restore-{}", unique_suffix()));
        extract_archive(&dest, &restore_dir).unwrap();

        for (rel, expected) in &files {
            let restored = fs::read_to_string(restore_dir.join(rel)).unwrap();
            assert_eq!(&restored, expected, "文件 {rel} 内容应一致");
        }

        let _ = fs::remove_dir_all(&source);
        let _ = fs::remove_file(&dest);
        let _ = fs::remove_dir_all(&restore_dir);
    }

    /// 多线程压缩应产生合法 zstd 帧（magic number 验证）。
    #[test]
    fn multithread_archive_has_valid_zstd_magic() {
        let source = setup_source_dir(&[("hello.txt", "world")]);
        let dest = archive_dest(&source);
        create_archive(&source, &dest, false).unwrap();

        // zstd 文件头 magic: 0xFD2FB528（小端序）
        let header = fs::read(&dest).unwrap();
        assert!(header.len() >= 4, "归档文件应至少 4 字节");
        assert_eq!(
            &header[0..4],
            &[0x28, 0xB5, 0x2F, 0xFD],
            "归档文件头应为 zstd magic 0xFD2FB528"
        );

        let _ = fs::remove_dir_all(&source);
        let _ = fs::remove_file(&dest);
    }

    /// socket 文件应被跳过，不阻塞备份（regression test for os error 102）
    #[cfg(unix)]
    #[test]
    fn skips_socket_files_in_source() {
        let source = setup_source_dir(&[("hello.txt", "world")]);
        // 在 source 下创建一个 Unix domain socket
        let sock_path = source.join("test.sock");
        let _ = std::os::unix::net::UnixListener::bind(&sock_path).unwrap();

        let dest = archive_dest(&source);
        // 之前会因为 socket 文件导致 BACKUP_ARCHIVE_OPEN 失败
        create_archive(&source, &dest, false).expect("应跳过 socket 不阻塞");

        let _ = fs::remove_dir_all(&source);
        let _ = fs::remove_file(&dest);
    }

    /// 符号链接应被完整备份并在还原时重建
    #[cfg(unix)]
    #[test]
    fn symlinks_are_backed_up_and_restored() {
        let source = setup_source_dir(&[("target.txt", "real content")]);
        // 在 source 下创建一个指向 target.txt 的符号链接
        std::os::unix::fs::symlink("target.txt", source.join("link.txt")).unwrap();

        let dest = archive_dest(&source);
        create_archive(&source, &dest, false).unwrap();

        // 验证归档中包含 link 条目
        let entries = list_archive_entries(&dest).unwrap();
        assert!(
            entries.iter().any(|e| e.ends_with("link.txt")),
            "归档应包含 link.txt"
        );

        // 还原并验证符号链接
        let restore_dir =
            std::env::temp_dir().join(format!("dsh-backup-symlink-{}", unique_suffix()));
        extract_archive(&dest, &restore_dir).unwrap();

        let link_path = restore_dir.join("link.txt");
        assert!(link_path.is_symlink(), "link.txt 应为符号链接");
        let target = std::fs::read_link(&link_path).unwrap();
        assert_eq!(
            target,
            std::path::PathBuf::from("target.txt"),
            "链接目标应一致"
        );

        let _ = fs::remove_dir_all(&source);
        let _ = fs::remove_file(&dest);
        let _ = fs::remove_dir_all(&restore_dir);
    }

    /// 超长符号链接（target > 100 字节）应被跳过，不阻塞备份
    #[cfg(unix)]
    #[test]
    fn skips_overlong_symlinks() {
        let source = setup_source_dir(&[("target.txt", "content")]);
        // 构造一个超过 100 字节的 target
        let long_target = "a".repeat(150);
        std::os::unix::fs::symlink(&long_target, source.join("long_link")).unwrap();

        let dest = archive_dest(&source);
        // 之前会因为 set_link_name 太长失败；现在应跳过
        create_archive(&source, &dest, false).expect("超长符号链接应被跳过");

        // 验证普通文件已备份
        let entries = list_archive_entries(&dest).unwrap();
        assert!(entries.iter().any(|e| e.contains("target.txt")));

        let _ = fs::remove_dir_all(&source);
        let _ = fs::remove_file(&dest);
    }

    /// FIFO 文件应被跳过（runtime 资源）
    #[cfg(unix)]
    #[test]
    fn skips_fifo_files() {
        let source = setup_source_dir(&[("hello.txt", "world")]);
        let fifo_path = source.join("test.pipe");
        // 创建 FIFO（named pipe）：mkfifo 需要 C string
        unsafe {
            libc::mkfifo(
                std::ffi::CString::new(fifo_path.to_str().unwrap())
                    .unwrap()
                    .as_ptr(),
                0o644,
            );
        }

        let dest = archive_dest(&source);
        create_archive(&source, &dest, false).expect("FIFO 应被跳过");

        // 普通文件应已备份
        let entries = list_archive_entries(&dest).unwrap();
        assert!(entries.iter().any(|e| e.contains("hello.txt")));

        let _ = fs::remove_dir_all(&source);
        let _ = fs::remove_file(&dest);
    }

    /// 混合文件类型（目录/文件/链接/socket）应正确处理
    #[cfg(unix)]
    #[test]
    fn handles_mixed_file_types() {
        let source =
            setup_source_dir(&[("normal.txt", "content"), ("subdir/nested.txt", "nested")]);
        // 添加符号链接
        std::os::unix::fs::symlink("normal.txt", source.join("link_to_normal")).unwrap();
        // 添加 socket
        let sock_path = source.join("ipc.sock");
        let _ = std::os::unix::net::UnixListener::bind(&sock_path).unwrap();
        // 添加空目录
        fs::create_dir_all(source.join("empty_dir")).unwrap();

        let dest = archive_dest(&source);
        create_archive(&source, &dest, false).expect("混合类型应正常处理");

        let entries = list_archive_entries(&dest).unwrap();
        // 普通文件
        assert!(entries.iter().any(|e| e.contains("normal.txt")));
        assert!(entries.iter().any(|e| e.contains("nested.txt")));
        // 符号链接
        assert!(entries.iter().any(|e| e.contains("link_to_normal")));
        // 空目录
        assert!(entries.iter().any(|e| e.contains("empty_dir")));
        // socket 不应包含
        assert!(entries.iter().all(|e| !e.contains("ipc.sock")));

        let _ = fs::remove_dir_all(&source);
        let _ = fs::remove_file(&dest);
    }

    /// 嵌套符号链接（link → subdir/link2 → target）应正确处理
    #[cfg(unix)]
    #[test]
    fn nested_symlinks_work() {
        let source = setup_source_dir(&[("real.txt", "data")]);
        let subdir = source.join("sub");
        fs::create_dir_all(&subdir).unwrap();
        std::os::unix::fs::symlink("../real.txt", subdir.join("up_link")).unwrap();

        let dest = archive_dest(&source);
        create_archive(&source, &dest, false).unwrap();

        let restore_dir =
            std::env::temp_dir().join(format!("dsh-backup-nested-{}", unique_suffix()));
        extract_archive(&dest, &restore_dir).unwrap();

        let link = restore_dir.join("sub").join("up_link");
        assert!(link.is_symlink());
        let target = std::fs::read_link(&link).unwrap();
        assert_eq!(target, std::path::PathBuf::from("../real.txt"));

        let _ = fs::remove_dir_all(&source);
        let _ = fs::remove_file(&dest);
        let _ = fs::remove_dir_all(&restore_dir);
    }

    /// 建立目录链接：Unix 用符号链接，Windows 用无需特权的 junction。
    fn create_dir_link(target: &Path, link: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let created = std::process::Command::new("cmd")
                .arg("/C")
                .raw_arg(format!(
                    "mklink /J \"{}\" \"{}\"",
                    link.display(),
                    target.display()
                ))
                .creation_flags(0x08000000)
                .status()
                .unwrap();
            assert!(created.success(), "目录联接创建应成功");
        }
    }

    /// Windows：junction 同样被识别为符号链接，其 target 超过 tar 链接名上限时应跳过，
    /// 而不是让整份备份失败（回归用户报告的 BACKUP_ARCHIVE_LINK_NAME 备份失败）。
    #[cfg(windows)]
    #[test]
    fn skips_overlong_junction_targets() {
        let root = std::env::temp_dir().join(format!("dsh-backup-junction-{}", unique_suffix()));
        let _ = fs::remove_dir_all(&root);
        let mut deep = root.join("real");
        for i in 0..6 {
            deep = deep.join(format!("segment_{i}_padding_padding"));
        }
        fs::create_dir_all(&deep).unwrap();
        let source = root.join("source");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("target.txt"), "content").unwrap();
        create_dir_link(&deep, &source.join("link"));
        assert!(
            fs::read_link(source.join("link")).unwrap().as_os_str().len() > 100,
            "夹具链接名应超过 tar 链接名上限"
        );

        let dest = root.join("out.tar.zst");
        create_archive(&source, &dest, false).expect("超长 junction 应被跳过，备份仍应成功");

        let entries = list_archive_entries(&dest).unwrap();
        assert!(
            entries.iter().any(|e| e.contains("target.txt")),
            "普通文件应已备份"
        );
        assert!(
            !entries.iter().any(|e| e.ends_with("link")),
            "超长 junction 不应写入归档"
        );

        let restore = root.join("restore");
        extract_archive(&dest, &restore).unwrap();
        assert_eq!(
            fs::read_to_string(restore.join("target.txt")).unwrap(),
            "content"
        );

        let _ = fs::remove_dir_all(&root);
    }

    /// 回归 CodeRabbit：解压遇到既有链接父级必须拒绝，不能顺着链接把文件写到 dest 之外。
    #[test]
    fn extract_rejects_entries_under_a_linked_parent() {
        let root =
            std::env::temp_dir().join(format!("dsh-backup-link-extract-{}", unique_suffix()));
        let _ = fs::remove_dir_all(&root);
        let source = root.join("source");
        fs::create_dir_all(source.join("sub")).unwrap();
        fs::write(source.join("sub").join("child.txt"), b"escaped").unwrap();

        let dest = root.join("out.tar.zst");
        create_archive(&source, &dest, false).unwrap();

        // 目标处预先存在指向外部目录的链接（Unix 符号链接 / Windows junction）
        let target = root.join("target");
        let outside = root.join("outside");
        fs::create_dir_all(&target).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let link = target.join("sub");
        create_dir_link(&outside, &link);

        let err = extract_archive(&dest, &target).unwrap_err();
        assert!(
            err.contains("BACKUP_EXTRACT_LINK_PARENT"),
            "父级是链接的条目必须被拒绝，实际错误: {err}"
        );
        assert!(
            !outside.join("child.txt").exists(),
            "不得跟随链接把文件写到解压目录之外"
        );

        let _ = fs::remove_dir(&link);
        let _ = fs::remove_dir_all(&root);
    }
}
