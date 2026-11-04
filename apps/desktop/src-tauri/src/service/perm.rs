//! `$DSH_HOME` / 档案目录的可写性预检与权限诊断。
//!
//! 背景（issue #466）：`~/.dsh` 可能整棵子树的属主不是当前用户——最常见的原因是
//! 此前用 `sudo` 运行过 dsh（macOS 的 `sudo` 保留 `$HOME`，`~/.dsh` 因此被 root
//! 创建）。此时应用**能读、能遍历**（`profiles/web/package.json` 读得到），但任何
//! 写入都以 `EACCES (os error 13)` 失败：`.npmrc`、`cordis.yml`、内置插件链接、
//! 档案目录全部写不进去。用户最终只看到裸 `os error 13`，重试与切档案都要在同一个
//! 不可写目录下新建 `profiles/<id>`，必然再次失败，于是无路可走。
//!
//! 应用无权 chown（也不应为此引入提权面），唯一正确的做法是**尽早**、且用
//! **可执行**的语言把问题摊开：本模块提供真实写入探测 + 「失败路径 + 目录属主 +
//! 可直接粘贴的 chown 命令」诊断。
//!
//! 返回 `Result<_, String>`，错误一律带调用方传入的大写前缀（AGENTS.md 约定）。

use std::io;
use std::path::{Path, PathBuf};

/// 权限/只读类错误判定：这类失败用户无法在应用内绕过，必须给出修复指引。
///
/// - `EACCES` / `EPERM`：std 归一为 [`io::ErrorKind::PermissionDenied`]（Windows 的
///   `ERROR_ACCESS_DENIED` 同样归一，故不按 raw os error 覆盖 5——unix 下 5 是
///   `EIO`，会被误判）；
/// - `EROFS`（只读文件系统，Linux/macOS 均为 30）：用户同样无法自行写入，需要
///   同一套指引；std 的 `ErrorKind::ReadOnlyFilesystem` 尚未稳定，只能按 raw 判定。
pub fn is_permission_error(error: &io::Error) -> bool {
    if error.kind() == io::ErrorKind::PermissionDenied {
        return true;
    }
    error.raw_os_error() == Some(30) && cfg!(unix)
}

/// 确保目录存在且可写：`create_dir_all` + 真实写入探测。
///
/// 必须真实探测：std 的 `create_dir_all` 对**已存在**目录直接返回 `Ok`（`mkdir`
/// 得到 `EEXIST` 后只做一次 `is_dir()` 判定），因此「目录已存在但属主不是当前
/// 用户」这一 issue #466 的典型形态在建目录这一步完全看不出问题，直到后面写清单
/// 才以裸 `EACCES` 失败。
///
/// 只把「权限类」失败升级为可诊断错误；探测遇到非权限类 IO 错误（杀毒软件、瞬时
/// 锁、网络盘抖动）按「无法判定」放行——绝不能因为一次探测失败就阻断启动。
pub fn ensure_dir_writable(dir: &Path, prefix: &str) -> Result<(), String> {
    if let Err(error) = std::fs::create_dir_all(dir) {
        // 创建失败时 `dir` 往往**根本不存在**（父级不可写，例如 `$DSH_HOME/profiles`
        // 属主是 root 时新建 `profiles/<id>`）：修复指引里的 chown/takeown 目标必须
        // 是真实存在的目录，否则那条命令会以 "No such file or directory" 失败。上溯
        // 到最近的已存在祖先。
        let remedy = nearest_existing_dir(dir).unwrap_or_else(|| dir.to_path_buf());
        return Err(dir_error(prefix, dir, &remedy, &error));
    }
    probe(dir, dir, prefix)
}

/// 写入前预检：`target`（不存在时取最近的已存在祖先）必须可写。
///
/// **绝不创建任何目录**：插件核对阶段抢先建出半初始化档案会落进 issue #452 的
/// 「只有 dsh-base」形态（`dsh plugin add` 对无清单目录只写 `DEFAULT_PROFILE_BUNDLES`），
/// 应把建目录留给 `dsh`/`init_profile_dir` 自己的初始化逻辑。
///
/// `home_root` 仅用于修复指引（`chown` 的目标）：整棵 `$DSH_HOME` 一起改属主才能
/// 同时覆盖档案目录、`profiles` 父级与其它子目录，避免用户按提示只改一层后再次撞上
/// 权限错误。
pub fn ensure_writable_path(target: &Path, home_root: &Path, prefix: &str) -> Result<(), String> {
    match nearest_existing_dir(target) {
        Some(dir) => probe(&dir, home_root, prefix),
        // 上溯不到任何已存在目录（理论上不可能：$DSH_HOME 由调用方保证存在）→ 放行，
        // 由真正执行写入的一方报错。
        None => Ok(()),
    }
}

/// `target` 自身（它是目录时）或最近的已存在祖先目录。
fn nearest_existing_dir(target: &Path) -> Option<PathBuf> {
    let mut current = Some(target);
    while let Some(dir) = current {
        if dir.is_dir() {
            return Some(dir.to_path_buf());
        }
        current = dir.parent();
    }
    None
}

/// 真实写入探测：create + delete 一个带 pid 的临时文件。
///
/// 只做一次瞬时创建/删除，不驻留任何文件；档案目录在运行期本来就会被 pnpm 写入
/// 大量文件，服务侧的文件监视不受影响。
fn probe(dir: &Path, remedy_root: &Path, prefix: &str) -> Result<(), String> {
    let probe_path: PathBuf = dir.join(format!(".dsh-write-probe-{}", std::process::id()));
    match std::fs::write(&probe_path, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe_path);
            Ok(())
        }
        Err(error) if is_permission_error(&error) => {
            // 指引里的修复目标必须是真实存在的目录（调用方给的 hint 理论上存在，
            // 但 `$DSH_HOME` 在全新安装时可能尚未创建）：不存在就退回被探测的那一层。
            let remedy = if remedy_root.is_dir() { remedy_root } else { dir };
            Err(dir_error(prefix, dir, remedy, &error))
        }
        Err(error) => {
            log::warn!(
                "{prefix}: writability probe on {} failed (treated as writable): {error}",
                dir.display()
            );
            Ok(())
        }
    }
}

/// 组装错误串：权限类失败给出属主信息与可执行的修复命令，其余保持原始形态。
///
/// `failing` 是实际失败/探测的路径（可能是 `target` 本身或它的某个祖先），
/// `remedy_root` 是**真实存在**、建议交给用户修复（chown / takeown）的目录——
/// 属主信息也取自它，这样即使 `failing` 尚未创建，用户看到的仍是那个真正需要
/// 改属主的已存在目录。
fn dir_error(prefix: &str, failing: &Path, remedy_root: &Path, error: &io::Error) -> String {
    if !is_permission_error(error) {
        return format!("{prefix}: {}: {error}", failing.display());
    }
    format!(
        "{prefix}: {failing} 不可写（{error}{owner}）。应用无权修改该目录的属主/权限，\
         dsh 在其下写 cordis.yml/settings.yaml 与插件依赖必然失败。{remedy}",
        failing = failing.display(),
        owner = owner_suffix(remedy_root),
        remedy = remedy_hint(remedy_root),
    )
}

/// unix 下补充目录属主与当前用户（uid/gid）：让用户一眼确认是不是 root/sudo
/// 留下的，不用自己去 `ls -ld` 对照。`libc` 已是 unix 目标依赖（见 Cargo.toml）。
#[cfg(unix)]
fn owner_suffix(path: &Path) -> String {
    use std::os::unix::fs::MetadataExt;
    let Ok(metadata) = std::fs::metadata(path) else {
        return String::new();
    };
    // SAFETY: geteuid/getegid 无参数、无副作用，仅读取当前进程凭证，任何时刻调用都安全。
    let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };
    format!(
        "；该目录属主 uid={}, gid={}，当前用户 uid={uid}, gid={gid}",
        metadata.uid(),
        metadata.gid(),
    )
}

/// Windows 的 ACL 诊断不在此层展开（需 `icacls` 语义），保持空后缀。
#[cfg(not(unix))]
fn owner_suffix(_path: &Path) -> String {
    String::new()
}

/// POSIX 单引号包裹，内部单引号转义为 `'\''`——修复命令必须能被原样粘贴执行
/// （用户名/路径可能含空格）。
#[cfg(unix)]
fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

/// 平台专属修复指引：**不能**在 Windows 上给出 `sudo chown`——那里的
/// `PermissionDenied` 来自 ACL/属主（NTFS），POSIX 命令既不可用也修不好。
#[cfg(unix)]
fn remedy_hint(root: &Path) -> String {
    format!(
        "请在终端执行 `sudo chown -R \"$(id -u):$(id -g)\" {}` 后重试——该状态通常由此前\
         用 sudo 运行过 dsh 造成（macOS 的 sudo 保留 $HOME，`~/.dsh` 会被 root 创建）。",
        shell_quote(root)
    )
}

/// Windows：先接管所有权再授予当前用户完全控制（两命令都需管理员身份的终端）。
#[cfg(not(unix))]
fn remedy_hint(root: &Path) -> String {
    format!(
        "请以管理员身份打开终端执行 `takeown /f \"{path}\" /r /d y && \
         icacls \"{path}\" /grant \"%USERNAME%\":(OI)(CI)F /T` 接管所有权并授予当前用户\
         完全控制后重试。",
        path = root.display(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("dsh-perm-{}-{label}", std::process::id()))
    }

    #[test]
    fn permission_error_detection_is_conservative() {
        assert!(is_permission_error(&io::Error::from(
            io::ErrorKind::PermissionDenied
        )));
        assert!(!is_permission_error(&io::Error::from(
            io::ErrorKind::NotFound
        )));
        #[cfg(unix)]
        {
            // EACCES / EPERM → PermissionDenied
            assert!(is_permission_error(&io::Error::from_raw_os_error(13)));
            assert!(is_permission_error(&io::Error::from_raw_os_error(1)));
            // EROFS
            assert!(is_permission_error(&io::Error::from_raw_os_error(30)));
            // EIO(5) 不是权限错误（Windows 的 ACCESS_DENIED(5) 由 kind 覆盖，
            // 不会被这条 raw 判定误伤）
            assert!(!is_permission_error(&io::Error::from_raw_os_error(5)));
        }
        #[cfg(windows)]
        assert!(is_permission_error(&io::Error::from_raw_os_error(5)));
    }

    #[test]
    fn writable_dir_passes_probe_and_creates_missing_path() {
        let root = temp_root("ok");
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("profiles").join("web");

        assert!(ensure_dir_writable(&dir, "PROFILE_MKDIR").is_ok());
        assert!(dir.is_dir());
        // 探测文件必须被清理，不能污染档案目录
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn preflight_never_creates_the_target() {
        let root = temp_root("no-lazy-init");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let target = root.join("profiles").join("new");

        assert!(ensure_writable_path(&target, &root, "PROFILE_NOT_WRITABLE").is_ok());
        // issue #452：预检不得抢先建出半初始化档案目录
        assert!(!target.exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn non_permission_failure_keeps_raw_error() {
        let root = temp_root("not-a-dir");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        // 目标已存在但不是目录：mkdir → EEXIST，is_dir() 为假 → 非权限类错误
        std::fs::write(root.join("web"), b"").unwrap();

        let error = ensure_dir_writable(&root.join("web"), "PROFILE_MKDIR").unwrap_err();
        assert!(error.starts_with("PROFILE_MKDIR:"), "{error}");
        assert!(!error.contains("chown"), "{error}");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn readonly_dir_reports_actionable_permission_error() {
        use std::os::unix::fs::PermissionsExt;

        let root = temp_root("readonly");
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("profiles").join("web");
        std::fs::create_dir_all(&dir).unwrap();

        let mut locked = std::fs::metadata(&dir).unwrap().permissions();
        locked.set_mode(0o555);
        std::fs::set_permissions(&dir, locked).unwrap();

        // 以 root 身份运行时权限位不生效（本地 sudo / 部分容器），此时跳过断言
        let writable_as_root = std::fs::write(dir.join("canary"), b"").is_ok();
        if !writable_as_root {
            let error = ensure_dir_writable(&dir, "PROFILE_MKDIR").unwrap_err();
            assert!(error.starts_with("PROFILE_MKDIR:"), "{error}");
            assert!(error.contains("chown -R"), "{error}");
            assert!(error.contains("uid="), "{error}");

            // 预检失败时给出的修复目标应是可写的祖先根（此处即 root）
            let error = ensure_writable_path(&dir, &root, "PROFILE_NOT_WRITABLE").unwrap_err();
            assert!(error.starts_with("PROFILE_NOT_WRITABLE:"), "{error}");
            assert!(error.contains(&shell_quote(&root)), "{error}");

            // 创建失败（父级不可写）时修复目标必须是**已存在**的目录：新建
            // `dir/new` 会 EACCES，若按不存在的目标给出 chown 命令，用户照抄只会得到
            // "No such file or directory"。
            let missing = dir.join("new");
            let error = ensure_dir_writable(&missing, "PROFILE_MKDIR").unwrap_err();
            assert!(error.starts_with("PROFILE_MKDIR:"), "{error}");
            assert!(error.contains(&shell_quote(&dir)), "{error}");
            assert!(!error.contains(&shell_quote(&missing)), "{error}");
        }

        let mut open = std::fs::metadata(&dir).unwrap().permissions();
        open.set_mode(0o755);
        let _ = std::fs::set_permissions(&dir, open);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 修复指引必须与平台匹配：Windows 的 `PermissionDenied` 来自 NTFS ACL/属主，
    /// 给 POSIX 的 `sudo chown` 既不可用也修不好。
    #[test]
    fn remedy_hint_is_platform_appropriate() {
        let root = Path::new("data-dir");
        #[cfg(unix)]
        assert!(remedy_hint(root).contains("sudo chown -R"));
        #[cfg(not(unix))]
        {
            assert!(remedy_hint(root).contains("icacls"));
            assert!(!remedy_hint(root).contains("chown"));
        }
    }
}
