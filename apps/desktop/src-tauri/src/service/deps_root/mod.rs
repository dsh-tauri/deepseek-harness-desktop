//! 依赖（核心运行时）安装根的查看与迁移（issue #1285）。
//!
//! 桌面端把 dsh / pnpm / git 运行时装在 `<AppData>[/dev]/dependencies` 下，约 1GB。
//! 对系统盘吃紧的用户，这里提供「把整个依赖根搬到别的盘」的能力：
//!
//! - 真值是 store 的 `dependencies_root`（经 [`crate::config::dependencies::deps_root`]
//!   解析），槽位布局 `<根>/dsh`、`<根>/<tag>` 与出口相对路径都不变；
//! - 迁移 = 扫描 → 复制 → 校验 → 记录新根 → 旧根改名保底，任一步失败都回到原状态；
//! - 进度走 `deps-root://progress`，与 `data-dir://progress` 同款「后端推、前端渲染」。
//!
//! 与数据目录迁移的关键差异：这里不碰用户级环境变量，切换只发生在应用自己的 store
//! 里，因此回滚就是「把记录改回旧值」——旧根此时还没动过。

use crate::AppHandle;
use std::path::{Component, Path, PathBuf};
use tauri::Emitter as _;

use super::data_dir::{CopyProgress, ProgressPayload, ProgressSink, TreeStats};
use super::workflow;

/// 迁移进度事件（前端进度条订阅）。
pub const PROGRESS_EVENT: &str = "deps-root://progress";

/// 预留的磁盘空间余量（百分比）：把目标卷填到 0 字节会让系统与其它程序一起失灵。
const SPACE_MARGIN_PERCENT: u64 = 5;

/// 依赖根状态。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependenciesRootStatus {
    /// 当前生效的依赖根
    pub root: String,
    /// 未自定义时使用的位置（`<AppData>[/dev]/dependencies`）
    pub default_root: String,
    /// 是否已被用户自定义
    pub custom: bool,
    /// 是否可迁移：随包资源根与本地核心都不是桌面端下载产物，搬走只会让升级覆盖与
    /// CLI 安装失效
    pub movable: bool,
}

/// 迁移预检结果。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependenciesRootPreview {
    pub source: String,
    pub target: String,
    pub total_files: u64,
    pub total_bytes: u64,
    pub target_free_bytes: u64,
    pub enough_space: bool,
}

/// 迁移结果。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependenciesMigrationOutcome {
    pub source: String,
    pub target: String,
    /// 旧根改名后的备份目录（空串 = 旧根本就是空的、已直接删掉）
    pub moved_to: String,
    pub files: u64,
    pub bytes: u64,
}

/// 依赖根状态（不遍历目录：1GB 的树不该为了一次面板渲染扫一遍，体积由预检给出）。
pub fn status(app_handle: &AppHandle) -> DependenciesRootStatus {
    let root = crate::config::dependencies::deps_root(app_handle);
    let default = crate::config::dependencies::default_deps_root(app_handle);
    DependenciesRootStatus {
        movable: is_movable(app_handle, &root),
        custom: !same_path(&root, &default),
        root: root.to_string_lossy().into_owned(),
        default_root: default.to_string_lossy().into_owned(),
    }
}

/// 该根能否被迁移。
///
/// 随包资源根（离线包 `$Resources/dsh`）与用户 CLI 安装的本地核心都不归桌面端所有：
/// 前者随应用升级被覆盖，后者由包管理器管理，搬走等于把它们从原位置偷走。
fn is_movable(app_handle: &AppHandle, root: &Path) -> bool {
    if crate::config::manifest::resource_root(app_handle)
        .is_some_and(|resources| is_within(root, &resources))
    {
        return false;
    }
    crate::service::core::local_core_package_dir(app_handle)
        .is_none_or(|local| !is_within(root, &local) && !is_within(&local, root))
}

/// 迁移预检：目标合法性、体积、磁盘空间（只读，面板据此展示代价）。
pub fn preview(app_handle: &AppHandle, target: &Path) -> Result<DependenciesRootPreview, String> {
    let source = crate::config::dependencies::deps_root(app_handle);
    validate_target(&source, target)?;
    let mut stats = TreeStats::default();
    if source.is_dir() {
        super::data_dir::scan_tree(&source, &mut stats)?;
    }
    let free = super::data_dir::free_bytes(target);
    let needed = stats.bytes + stats.bytes / 100 * SPACE_MARGIN_PERCENT;
    Ok(DependenciesRootPreview {
        source: source.to_string_lossy().into_owned(),
        target: target.to_string_lossy().into_owned(),
        total_files: stats.files,
        total_bytes: stats.bytes,
        target_free_bytes: free.unwrap_or(0),
        enough_space: free.is_none_or(|available| available >= needed),
    })
}

/// 迁移依赖根。
///
/// 调用方（`bridge::deps_root`）已取得核心切换锁、停掉 Harness 并持有插件操作锁：
/// 迁移会搬走正在运行的运行时所在目录，任何仍在跑的 Harness 都会把文件句柄钉在
/// 旧根上（Windows 上就是 `os error 32`），复制出来的也会是一份撕裂的树。
pub(crate) async fn migrate(
    app_handle: AppHandle,
    target: PathBuf,
    mutation: crate::service::profile::mutation::MutationGuard,
) -> Result<DependenciesMigrationOutcome, String> {
    let source = crate::config::dependencies::deps_root(&app_handle);
    validate_target(&source, &target)?;
    if !source.is_dir() {
        return Err(format!(
            "DEPS_ROOT_MISSING: {} 不存在，没有可迁移的依赖",
            source.display()
        ));
    }
    let handle = app_handle.clone();
    let emit = move |payload: ProgressPayload| {
        let _ = handle.emit(PROGRESS_EVENT, payload);
    };
    let app = app_handle.clone();
    let profile = crate::service::profile::active_profile(&app_handle);
    mutation
        .spawn_blocking(profile, move || run(&app, &source, &target, &emit))
        .await
        .map_err(|error| format!("DEPS_ROOT_TASK: {error}"))?
}

/// 迁移编排：扫描 → 空间预检 → 复制 → 校验 → 记录新根 → 旧根改名。
///
/// 顺序刻意如此：改名与记录写在最后，前面任何一步失败都不会让用户失去原目录。
/// 记录已写而改名失败时把记录改回旧值——否则下次启动会指向一个半搬空的新根。
pub(super) fn run(
    app_handle: &AppHandle,
    source: &Path,
    target: &Path,
    emit: ProgressSink<'_>,
) -> Result<DependenciesMigrationOutcome, String> {
    validate_target(source, target)?;
    emit(step("scan", 0, 0, 0, 0));
    let mut expected = TreeStats::default();
    super::data_dir::scan_tree(source, &mut expected)?;

    let free = super::data_dir::free_bytes(target);
    let needed = expected.bytes + expected.bytes / 100 * SPACE_MARGIN_PERCENT;
    if free.is_some_and(|available| available < needed) {
        return Err(format!(
            "DEPS_ROOT_NO_SPACE: {} 可用 {} 字节，至少需要 {} 字节",
            target.display(),
            free.unwrap_or(0),
            needed
        ));
    }

    let tick = |files: u64, bytes: u64| {
        emit(step("copy", files, bytes, expected.files, expected.bytes));
    };
    let progress = CopyProgress::new(&tick);
    super::data_dir::copy_tree(source, target, &progress)?;
    let copied = progress.stats();

    emit(step(
        "verify",
        copied.files,
        copied.bytes,
        expected.files,
        expected.bytes,
    ));
    let mut actual = TreeStats::default();
    super::data_dir::scan_tree(target, &mut actual)?;
    if !actual.covers(&expected) {
        // 目标少于源：绝不继续改名，也绝不删目标（可能只是磁盘满，用户能腾出空间重试）
        return Err(format!(
            "DEPS_ROOT_COPY_INCOMPLETE: {} -> {}: {} files/{} bytes, expected {} files/{} bytes",
            source.display(),
            target.display(),
            actual.files,
            actual.bytes,
            expected.files,
            expected.bytes
        ));
    }

    emit(step(
        "finalize",
        copied.files,
        copied.bytes,
        expected.files,
        expected.bytes,
    ));
    let previous = crate::config::get_store_dat_setting(app_handle).dependencies_root;
    crate::config::update_store_dat_setting(app_handle, |setting| {
        setting.dependencies_root = Some(target.to_string_lossy().into_owned());
    });
    let moved = match retire_old_root(source) {
        Ok(moved) => moved,
        Err(error) => {
            crate::config::update_store_dat_setting(app_handle, |setting| {
                setting.dependencies_root = previous.clone();
            });
            return Err(error);
        }
    };

    emit(step(
        "done",
        copied.files,
        copied.bytes,
        expected.files,
        expected.bytes,
    ));
    Ok(DependenciesMigrationOutcome {
        source: source.to_string_lossy().into_owned(),
        target: target.to_string_lossy().into_owned(),
        moved_to: moved
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default(),
        files: copied.files,
        bytes: copied.bytes,
    })
}

/// 旧根退役：空根直接删，非空改名为 `<原名>.moved-<时间戳>`，永远不删内容。
///
/// 改名而不是删除：新根的复制虽已按「文件数 + 字节数」校验，但 pnpm 的
/// `node_modules` 链接与 asar 归档都可能因权限而重建失败，旧根是用户唯一的兜底。
fn retire_old_root(source: &Path) -> Result<Option<PathBuf>, String> {
    if super::data_dir::is_dir_empty(source) {
        std::fs::remove_dir(source)
            .map_err(|error| format!("DEPS_ROOT_RETIRE_REMOVE: {}: {error}", source.display()))?;
        return Ok(None);
    }
    let moved = retired_path(source)?;
    std::fs::rename(source, &moved).map_err(|error| {
        format!(
            "DEPS_ROOT_RETIRE_RENAME: {} -> {}: {error}",
            source.display(),
            moved.display()
        )
    })?;
    log::info!(
        "dependencies root retired: {} -> {}",
        source.display(),
        moved.display()
    );
    Ok(Some(moved))
}

/// 旧根改名后的目标（同名备份已存在时在时间戳后追加序号，不覆盖上一份）。
fn retired_path(source: &Path) -> Result<PathBuf, String> {
    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("DEPS_ROOT_RETIRE_NAME: {}", source.display()))?;
    if source.parent().is_none() {
        return Err(format!("DEPS_ROOT_RETIRE_NAME: {}", source.display()));
    }
    let stamp = super::data_dir::now_stamp();
    let mut candidate = source.with_file_name(format!("{name}.moved-{stamp}"));
    let mut attempt = 2;
    while candidate.exists() {
        candidate = source.with_file_name(format!("{name}.moved-{stamp}-{attempt}"));
        attempt += 1;
    }
    Ok(candidate)
}

/// 迁移后重建 CLI shim（shim 里烘焙着 dsh / pnpm 入口的绝对路径）。
pub(crate) fn refresh_shims(app_handle: &AppHandle) {
    if let Err(error) = crate::service::cli::ensure_shims(app_handle) {
        log::warn!("DEPS_ROOT_SHIM_REWRITE: {error}");
    }
}

/// 迁移后清扫旧 Harness 残留：旧根已改名，从旧路径启动的孤儿实例仍占用着文件。
pub(crate) async fn sweep_stale_harness(app_handle: &AppHandle) {
    let handle = app_handle.clone();
    let profile = crate::service::profile::active_profile(app_handle);
    let result = tauri::async_runtime::spawn_blocking(move || {
        workflow::instances::scope_sync(profile, || {
            workflow::terminate_stale_harness_processes(&handle)
        })
    })
    .await
    .map_err(|error| format!("DEPS_ROOT_SWEEP: {error}"))
    .and_then(|result| result);
    if let Err(error) = result {
        log::warn!("DEPS_ROOT_SWEEP: {error}");
    }
}

/// 迁移目标校验：绝对路径、不与当前根重合/嵌套、不在网络盘、为空或不存在、可写。
pub fn validate_target(source: &Path, target: &Path) -> Result<(), String> {
    if !target.is_absolute() {
        return Err(format!(
            "DEPS_ROOT_TARGET_NOT_ABSOLUTE: {}",
            target.display()
        ));
    }
    // 网络盘判定必须在解析之前：连不上的 UNC 共享在 canonicalize 时是「其它错误」，
    // 先解析只会把「不能放到网络盘」这条可操作的原因盖成一句路径解析失败。
    if is_network_path(target) {
        return Err(format!(
            "DEPS_ROOT_TARGET_NETWORK: {} 位于网络盘，依赖根必须是本地磁盘",
            target.display()
        ));
    }
    let resolved_source = resolved_path(source)?;
    let resolved_target = resolved_path(target)?;
    let source = resolved_source.as_path();
    let target = resolved_target.as_path();
    if same_path(source, target) {
        return Err(format!("DEPS_ROOT_SAME_AS_SOURCE: {}", target.display()));
    }
    if is_within(target, source) {
        return Err(format!(
            "DEPS_ROOT_TARGET_INSIDE_SOURCE: {}",
            target.display()
        ));
    }
    if is_within(source, target) {
        return Err(format!(
            "DEPS_ROOT_SOURCE_INSIDE_TARGET: {}",
            target.display()
        ));
    }
    if target.is_file() {
        return Err(format!("DEPS_ROOT_TARGET_NOT_DIR: {}", target.display()));
    }
    if !super::data_dir::is_dir_empty(target) {
        return Err(format!("DEPS_ROOT_TARGET_NOT_EMPTY: {}", target.display()));
    }
    probe_writable(target)
}

/// 目标可写探测：真的在父目录里建一个临时文件再删掉。
///
/// 权限位在 Windows 上不可靠（ACL、只读盘符、组策略都可能拒绝），只有实际创建一次
/// 才能确定「迁移不会在复制到一半时才失败」。
fn probe_writable(target: &Path) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| format!("DEPS_ROOT_TARGET_NOT_ABSOLUTE: {}", target.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("DEPS_ROOT_TARGET_UNWRITABLE: {}: {error}", parent.display()))?;
    let probe = parent.join(format!(".dsh-deps-root-probe-{}", std::process::id()));
    std::fs::write(&probe, b"probe")
        .map_err(|error| format!("DEPS_ROOT_TARGET_UNWRITABLE: {}: {error}", parent.display()))?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

/// 是否为网络路径（UNC `\\\\server\share` 或映射到远端共享的盘符）。
///
/// 必须先剥掉 Windows 的 `\\?\` verbatim 前缀：`fs::canonicalize` 恒返回带该前缀的
/// 形式，直接判前缀会把**每一个**合法目标都当成 UNC 路径拒掉。
fn is_network_path(path: &Path) -> bool {
    if dunce::simplified(path)
        .to_string_lossy()
        .replace('/', "\\")
        .starts_with("\\\\")
    {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;

        // GetDriveTypeW 的返回值 4 = DRIVE_REMOTE。常量本身在 windows-sys 的
        // Win32_System_WindowsProgramming feature 下，Cargo.toml 没有开这个 feature，
        // 为一个数字去引入整个 feature 不划算（见 Cargo.toml 的 feature 白名单）。
        const DRIVE_REMOTE: u32 = 4;

        let mut probe = path.to_path_buf();
        while !probe.exists() {
            match probe.parent() {
                Some(parent) => probe = parent.to_path_buf(),
                None => return false,
            }
        }
        let mut wide: Vec<u16> = probe.as_os_str().encode_wide().collect();
        wide.push(0);
        return unsafe { GetDriveTypeW(wide.as_ptr()) } == DRIVE_REMOTE;
    }
    #[cfg(not(windows))]
    false
}

/// 进度载荷构造（phase 取值与 `data-dir://progress` 一致，前端可共用渲染逻辑）。
fn step(
    phase: &'static str,
    copied_files: u64,
    copied_bytes: u64,
    total_files: u64,
    total_bytes: u64,
) -> ProgressPayload {
    ProgressPayload {
        operation: "deps-root",
        phase,
        copied_files,
        copied_bytes,
        total_files,
        total_bytes,
    }
}

/// 两个路径是否指向同一处（`\\?\` 前缀与大小写差异不算不同）。
fn same_path(a: &Path, b: &Path) -> bool {
    is_within(a, b) && is_within(b, a)
}

/// `child` 是否位于 `parent` 之内（按路径组件逐段比较，不比字符串前缀）。
fn is_within(child: &Path, parent: &Path) -> bool {
    let parent = dunce::simplified(parent);
    if parent.as_os_str().is_empty() {
        return false;
    }
    let mut remaining = dunce::simplified(child).components();
    for part in parent.components() {
        let Some(found) = remaining.next() else {
            return false;
        };
        if !same_component(&found, &part) {
            return false;
        }
    }
    true
}

/// 两个路径组件是否指向同一层（Windows 文件名不区分大小写）。
fn same_component(a: &Component<'_>, b: &Component<'_>) -> bool {
    if cfg!(windows) {
        a.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&b.as_os_str().to_string_lossy())
    } else {
        a == b
    }
}

/// 解析绝对路径（不存在的尾段按最近的存在祖先解析后拼回）。
fn resolved_path(path: &Path) -> Result<PathBuf, String> {
    let mut existing = path;
    let mut missing = Vec::new();
    loop {
        match std::fs::canonicalize(existing) {
            Ok(mut resolved) => {
                if !missing.is_empty() && !resolved.is_dir() {
                    return Err(format!("DEPS_ROOT_TARGET_NOT_DIR: {}", existing.display()));
                }
                for name in missing.iter().rev() {
                    resolved.push(name);
                }
                return Ok(resolved);
            }
            Err(error) => {
                if error.kind() == std::io::ErrorKind::NotFound
                    && matches!(std::fs::symlink_metadata(existing), Err(ref metadata_error) if metadata_error.kind() == std::io::ErrorKind::NotFound)
                    && let (Some(name), Some(parent)) = (existing.file_name(), existing.parent())
                {
                    missing.push(name);
                    existing = parent;
                    continue;
                }
                return Err(format!(
                    "DEPS_ROOT_PATH_RESOLVE: {}: {error}",
                    path.display()
                ));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dsh-deps-root-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn validate_rejects_relative_same_and_nested_targets() {
        let root = temp_dir("validate");
        let source = root.join("dependencies");
        std::fs::create_dir_all(source.join("dsh")).unwrap();
        assert!(validate_target(&source, &source).is_err());
        assert!(validate_target(&source, &source.join("inner")).is_err());
        assert!(validate_target(&source.join("inner"), &source).is_err());
        assert!(validate_target(&source, Path::new("relative")).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn validate_accepts_a_missing_or_empty_target_and_rejects_a_filled_one() {
        let root = temp_dir("validate-empty");
        let source = root.join("dependencies");
        std::fs::create_dir_all(&source).unwrap();
        assert!(validate_target(&source, &root.join("missing")).is_ok());
        let empty = root.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        assert!(validate_target(&source, &empty).is_ok());

        let filled = root.join("filled");
        std::fs::create_dir_all(&filled).unwrap();
        std::fs::write(filled.join("a.txt"), "1").unwrap();
        assert!(
            matches!(validate_target(&source, &filled), Err(ref error) if error.starts_with("DEPS_ROOT_TARGET_NOT_EMPTY:")),
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn validate_rejects_a_target_below_a_regular_file() {
        let root = temp_dir("file-parent");
        let source = root.join("dependencies");
        std::fs::create_dir_all(&source).unwrap();
        let file = root.join("file");
        std::fs::write(&file, "preserve").unwrap();
        assert!(validate_target(&source, &file.join("copy")).is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "preserve");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn validate_rejects_targets_on_a_network_path() {
        let root = temp_dir("network");
        let source = root.join("dependencies");
        std::fs::create_dir_all(&source).unwrap();
        assert!(
            matches!(validate_target(&source, Path::new(r"\\server\share\deps")), Err(ref error) if error.starts_with("DEPS_ROOT_TARGET_NETWORK:")),
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn is_network_path_detects_unc_prefixes() {
        assert!(is_network_path(Path::new(r"\\server\share\deps")));
        assert!(is_network_path(Path::new("//server/share/deps")));
        assert!(!is_network_path(&std::env::temp_dir()));
    }

    #[test]
    fn retired_path_never_collides_with_an_existing_backup() {
        let root = temp_dir("retired");
        let source = root.join("dependencies");
        std::fs::create_dir_all(&source).unwrap();
        let first = retired_path(&source).unwrap();
        assert_eq!(
            first
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("dependencies.moved-"),
            true
        );
        std::fs::create_dir_all(&first).unwrap();
        let second = retired_path(&source).unwrap();
        assert_ne!(second, first);
        assert!(
            second
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("dependencies.moved-")
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn retire_removes_an_empty_root_and_renames_a_filled_one() {
        let root = temp_dir("retire");
        let empty = root.join("empty-deps");
        std::fs::create_dir_all(&empty).unwrap();
        assert_eq!(retire_old_root(&empty).unwrap(), None);
        assert!(!empty.exists());

        let filled = root.join("filled-deps");
        std::fs::create_dir_all(filled.join("dsh")).unwrap();
        std::fs::write(filled.join("dsh/bin.js"), "entry").unwrap();
        let moved = retire_old_root(&filled)
            .unwrap()
            .expect("filled root keeps a backup");
        assert!(!filled.exists());
        assert_eq!(
            std::fs::read_to_string(moved.join("dsh/bin.js")).unwrap(),
            "entry"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn is_within_compares_path_components_not_prefixes() {
        if cfg!(windows) {
            let data = Path::new("D:\\Data");
            assert!(is_within(Path::new("D:\\Data\\sub"), data));
            assert!(is_within(data, data));
            assert!(!is_within(Path::new("D:\\Database"), data));
        } else {
            let data = Path::new("/data");
            assert!(is_within(Path::new("/data/sub"), data));
            assert!(is_within(data, data));
            assert!(!is_within(Path::new("/database"), data));
        }
        assert!(!is_within(Path::new("/data"), Path::new("")));
    }
}
