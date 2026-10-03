//! 迁移与回滚的编排：校验、复制、改名、改写环境变量。
//!
//! 每一步的失败处理都必须能回答「现在数据在哪、用户还能不能找回来」，因此：
//! - 校验失败：什么都没动；
//! - 复制/校验失败：目标留着（可能只是磁盘满），源目录原样不动；
//! - 改名之后失败：把源目录改回来，环境变量与记录文件同步复原。

use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::AppHandle;

use super::env;
use super::fs_ops::{self, CopyProgress, TreeStats};
use super::state;
use super::{
    harness_stopped, platform_unsupported, MigrationBackup, MigrationOutcome, MigrationPlan,
    ProgressPayload, ProgressSink,
};

/// 预留的磁盘空间余量（百分比）：把目标卷填到 0 字节会让系统与其它程序一起失灵。
const SPACE_MARGIN_PERCENT: u64 = 5;

/// 发现可回滚的旧目录备份。
///
/// 搜索三处（issue E）：当前数据目录旁边、默认目录旁边、上次迁移记录的原位置旁边。
/// 跨盘搬家时旧目录留在原盘，既不在当前目录旁边也不在默认目录旁边，只有第三处能找到。
/// 排序用「会话数优先、时间戳其次」（issue G）：会话是用户唯一无法重建的数据，
/// 一个没有会话的新备份不该盖过旧备份被自动选中。
pub(super) fn find_backups(app_handle: &AppHandle, current: &Path) -> Vec<MigrationBackup> {
    let default = env::default_home();
    let recorded = state::read_last_migration(app_handle).map(PathBuf::from);
    let mut backups: Vec<MigrationBackup> =
        collect_backups(&search_places(current, &default, recorded.as_deref()))
            .into_iter()
            .map(|path| MigrationBackup {
                sessions: fs_ops::count_sessions(&path),
                stamp: stamp_of(&path),
                path: path.to_string_lossy().into_owned(),
            })
            .collect();
    backups.sort_by(|a, b| {
        b.sessions
            .cmp(&a.sessions)
            .then_with(|| b.stamp.cmp(&a.stamp))
    });
    backups
}

/// 三个搜索位置：当前数据目录、默认目录、上次迁移记录的原位置（去重且保持顺序）。
fn search_places(current: &Path, default: &Path, recorded: Option<&Path>) -> Vec<PathBuf> {
    let mut places: Vec<PathBuf> = Vec::new();
    for path in [Some(current), Some(default), recorded].into_iter().flatten() {
        if !places.iter().any(|seen| same_path(seen, path)) {
            places.push(path.to_path_buf());
        }
    }
    places
}

/// 逐个位置找**该位置自己的**同名备份目录。
///
/// 备份名里带的是「被搬走的那个目录」的名字（`~/.dsh` → `~/.dsh.moved-<时间戳>`），
/// 所以每个位置必须用各自的目录名去匹配。统一用当前位置的名字去找，会把「从默认目录
/// 搬走」这类最常见的备份全部漏掉——面板上连回滚入口都不会出现（issue E）。
fn collect_backups(places: &[PathBuf]) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = Vec::new();
    for place in places {
        let Some(leaf) = place.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some(dir) = place.parent() else {
            continue;
        };
        for (candidate, _) in state::find_moved_dirs(dir, leaf) {
            if !found.contains(&candidate) {
                found.push(candidate);
            }
        }
    }
    found
}

/// 迁移预检：目标合法性、体积与磁盘空间。
///
/// 这里**不**检查 Harness 是否已退出：预检是只读的（`preview_data_dir_migration` 不停服），
/// 而用户点「预检」时 Harness 通常正在运行。停服由迁移命令本身完成，真正的安全网在
/// [`run`] 开头——那里一定已经停服，且是动手改盘前的最后一道检查。
pub(super) fn plan(
    app_handle: &AppHandle,
    source: &Path,
    target: &Path,
) -> Result<MigrationPlan, String> {
    if !cfg!(windows) {
        return Err(platform_unsupported());
    }
    validate_target(source, target)?;
    let mut stats = TreeStats::default();
    fs_ops::scan_tree(source, &mut stats)?;
    let free = env::free_bytes(target);
    let needed = stats.bytes + stats.bytes / 100 * SPACE_MARGIN_PERCENT;
    let remembered = state::read_last_migration(app_handle)
        .map(PathBuf::from)
        .is_some_and(|recorded| same_path(&recorded, target));
    Ok(MigrationPlan {
        source: source.to_string_lossy().into_owned(),
        target: target.to_string_lossy().into_owned(),
        total_files: stats.files,
        total_bytes: stats.bytes,
        links: stats.links,
        target_free_bytes: free.unwrap_or(0),
        enough_space: free.is_none_or(|available| available >= needed),
        parent_exists: target.parent().is_some_and(Path::exists),
        remembered,
    })
}

/// 执行迁移：复制 → 校验 → 旧目录改名 → 记录原位置 → 改写用户级 `DSH_HOME`。
///
/// 顺序刻意如此：改名与环境变量写在最后，前面任何一步失败都不会让用户失去原目录。
pub(super) fn run(
    app_handle: &AppHandle,
    source: &Path,
    target: &Path,
    emit: ProgressSink<'_>,
) -> Result<MigrationOutcome, String> {
    // 动手前的最后一道安全网：调用方（`data_dir::migrate`）已经停过服，这里再确认一次，
    // 避免 Harness 在停服与迁移之间被重新拉起。
    if !harness_stopped(app_handle) {
        return Err(format!(
            "DATA_DIR_HARNESS_RUNNING: {} 仍在使用数据目录",
            source.display()
        ));
    }
    emit(step("migrate", "scan", 0, 0, 0, 0));
    let mut expected = TreeStats::default();
    fs_ops::scan_tree(source, &mut expected)?;

    let tick = |files: u64, bytes: u64| {
        emit(step("migrate", "copy", files, bytes, expected.files, expected.bytes));
    };
    let progress = CopyProgress::new(&tick);
    fs_ops::copy_tree(source, target, &progress)?;
    let copied = progress.stats();

    emit(step("migrate", "verify", copied.files, copied.bytes, expected.files, expected.bytes));
    let mut actual = TreeStats::default();
    fs_ops::scan_tree(target, &mut actual)?;
    if !actual.covers(&expected) {
        // 目标少于源：绝不继续改名，也绝不删目标（可能只是磁盘满，用户能腾出空间重试）
        return Err(format!(
            "DATA_DIR_COPY_INCOMPLETE: {} -> {}: {} files/{} bytes, expected {} files/{} bytes",
            source.display(),
            target.display(),
            actual.files,
            actual.bytes,
            expected.files,
            expected.bytes
        ));
    }

    emit(step("migrate", "finalize", copied.files, copied.bytes, expected.files, expected.bytes));
    let stamp = env::now_stamp();
    let moved = state::with_moved_suffix(source, &stamp)?;
    // 记录先写：跨盘搬家后旧目录留在原盘，只有这条记录能把它找回来（issue E）
    state::write_last_migration(app_handle, &source.to_string_lossy())?;
    fs::rename(source, &moved)
        .map_err(|e| format!("DATA_DIR_RENAME: {} -> {}: {e}", source.display(), moved.display()))?;

    let text = target.to_string_lossy().into_owned();
    if let Err(error) = env::write_user_home(&text) {
        // 环境变量写不进去：把旧目录改回原名，用户至少还能从原来的位置启动
        if let Err(restore) = fs::rename(&moved, source) {
            log::error!("DATA_DIR_RENAME_BACK: {}: {restore}", moved.display());
        }
        return Err(error);
    }
    // 本进程立刻生效：后续 get_dsh_data_path / shim 生成 / 拉起的 Harness 都读新值
    std::env::set_var(env::DATA_DIR_ENV, &text);
    refresh_shims(app_handle, target);

    emit(step("migrate", "done", copied.files, copied.bytes, expected.files, expected.bytes));
    Ok(MigrationOutcome {
        source: source.to_string_lossy().into_owned(),
        target: text,
        moved_to: moved.to_string_lossy().into_owned(),
        files: copied.files,
        bytes: copied.bytes,
        links: copied.links,
        sessions: fs_ops::count_sessions(target),
    })
}

/// 回滚到旧目录备份。
///
/// `backup` 为空时按 `find_backups` 的顺序取第一个（会话数优先、时间戳其次，与恢复
/// 脚本同一规则）。当前数据目录不会被删除——脚本同样只提示、不删除，两份数据同时
/// 存在才是「一键回滚」敢按下去的前提。
pub(super) fn rollback(
    app_handle: &AppHandle,
    current: &Path,
    backup: Option<&Path>,
    emit: ProgressSink<'_>,
) -> Result<MigrationOutcome, String> {
    if !cfg!(windows) {
        return Err(platform_unsupported());
    }
    if !harness_stopped(app_handle) {
        return Err(format!(
            "DATA_DIR_HARNESS_RUNNING: {} 仍在使用数据目录",
            current.display()
        ));
    }
    emit(step("rollback", "scan", 0, 0, 0, 0));

    let chosen = match backup {
        Some(explicit) => explicit.to_path_buf(),
        None => find_backups(app_handle, current)
            .first()
            .map(|item| PathBuf::from(&item.path))
            .ok_or_else(|| format!("DATA_DIR_NO_BACKUP: {}", current.display()))?,
    };
    if !chosen.is_dir() {
        return Err(format!("DATA_DIR_BACKUP_MISSING: {}", chosen.display()));
    }
    let restore_to = state::original_of(&chosen)
        .ok_or_else(|| format!("DATA_DIR_BACKUP_NAME_INVALID: {}", chosen.display()))?;

    // 目标非空时先挪到一边（issue F）：直接覆盖会把用户当前的数据删掉
    let stamp = env::now_stamp();
    let aside = if fs_ops::is_dir_empty(&restore_to) {
        if restore_to.exists() {
            fs::remove_dir(&restore_to).map_err(|e| {
                format!("DATA_DIR_ROLLBACK_CLEAR: {}: {e}", restore_to.display())
            })?;
        }
        String::new()
    } else {
        let target = state::with_current_suffix(&restore_to, &stamp)?;
        fs::rename(&restore_to, &target).map_err(|e| {
            format!("DATA_DIR_ROLLBACK_ASIDE: {}: {e}", restore_to.display())
        })?;
        target.to_string_lossy().into_owned()
    };

    emit(step("rollback", "finalize", 0, 0, 0, 0));
    if let Some(parent) = restore_to.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("DATA_DIR_ROLLBACK_MKDIR: {e}"))?;
    }
    if let Err(error) = fs::rename(&chosen, &restore_to) {
        if !aside.is_empty() {
            let _ = fs::rename(&aside, &restore_to);
        }
        return Err(format!(
            "DATA_DIR_ROLLBACK_MOVE: {} -> {}: {error}",
            chosen.display(),
            restore_to.display()
        ));
    }

    // 回到默认目录就清掉变量：默认目录不该在注册表里留一条冗余记录
    if same_path(&restore_to, &env::default_home()) {
        env::clear_user_home()?;
        std::env::remove_var(env::DATA_DIR_ENV);
    } else {
        let text = restore_to.to_string_lossy().into_owned();
        env::write_user_home(&text)?;
        std::env::set_var(env::DATA_DIR_ENV, &text);
    }
    if let Err(error) = state::write_last_migration(app_handle, "") {
        log::warn!("DATA_DIR_STATE_CLEAR: {error}");
    }
    refresh_shims(app_handle, &restore_to);

    let mut stats = TreeStats::default();
    if let Err(error) = fs_ops::scan_tree(&restore_to, &mut stats) {
        log::warn!("DATA_DIR_ROLLBACK_SCAN: {error}");
    }
    emit(step("rollback", "done", stats.files, stats.bytes, stats.files, stats.bytes));
    Ok(MigrationOutcome {
        source: current.to_string_lossy().into_owned(),
        target: restore_to.to_string_lossy().into_owned(),
        moved_to: aside,
        files: stats.files,
        bytes: stats.bytes,
        links: stats.links,
        sessions: fs_ops::count_sessions(&restore_to),
    })
}

/// 目标合法性：不能是源自己、不能互相嵌套、必须为空或不存在。
///
/// 嵌套会让「复制 + 校验」在源目录里凭空多出一份自己（递归放大），也让改名后的
/// 备份目录落在源目录内部——两边都无法收拾。
fn validate_target(source: &Path, target: &Path) -> Result<(), String> {
    if !target.is_absolute() {
        return Err(format!("DATA_DIR_TARGET_NOT_ABSOLUTE: {}", target.display()));
    }
    if same_path(source, target) {
        return Err(format!("DATA_DIR_SAME_AS_SOURCE: {}", target.display()));
    }
    if is_within(target, source) {
        return Err(format!(
            "DATA_DIR_TARGET_INSIDE_SOURCE: {}",
            target.display()
        ));
    }
    if is_within(source, target) {
        return Err(format!("DATA_DIR_SOURCE_INSIDE_TARGET: {}", target.display()));
    }
    if target.is_file() {
        return Err(format!("DATA_DIR_TARGET_NOT_DIR: {}", target.display()));
    }
    if !fs_ops::is_dir_empty(target) {
        return Err(format!("DATA_DIR_TARGET_NOT_EMPTY: {}", target.display()));
    }
    Ok(())
}

/// 重写 CLI shim 与 pnpm 元数据（best-effort）。
///
/// shim 内容里烘焙着 `DSH_HOME`，不改写的话终端里的 `dsh` 仍指向旧目录；pnpm 的
/// `node_modules` 元数据带绝对路径，不修正会在下一次插件安装时被当成损坏的 store。
/// 两者都只是「改了更好」，失败不能把已经成功的迁移判成失败。
fn refresh_shims(app_handle: &AppHandle, home: &Path) {
    if let Err(error) = crate::service::cli::ensure_shims(app_handle) {
        log::warn!("DATA_DIR_SHIM_REWRITE: {error}");
    }
    if let Err(error) = crate::service::migrate::heal_stale_pnpm_metadata(home) {
        log::warn!("DATA_DIR_PNPM_HEAL: {error}");
    }
}

/// 备份目录名里的时间戳部分（名字不合规时返回空串）。
fn stamp_of(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .and_then(state::moved_stamp)
        .map(str::to_string)
        .unwrap_or_default()
}

/// 两个路径是否指向同一处（`\\?\` 前缀与大小写差异不算不同）。
fn same_path(a: &Path, b: &Path) -> bool {
    is_within(a, b) && is_within(b, a)
}

/// `child` 是否位于 `parent` 之内（按路径组件逐段比较）。
///
/// 必须逐段比较而不是比字符串前缀：`D:\Data` 与 `D:\Database` 只差一个字符，
/// 前缀比较会把后者误判成前者的子目录，从而拒绝一个完全合法的目标。
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

/// 两个路径组件是否指向同一层。
///
/// Windows 的文件名不区分大小写，得用 `eq_ignore_ascii_case`；其它平台按 `PartialEq` 比较。
/// 这里用 `cfg!` 而不是 `#[cfg]` 门控函数：`cfg!` 只把条件替换成 `true`/`false`，两个分支在
/// **所有**平台都要参与编译；一旦改成 `#[cfg(windows)]` 门控，非 Windows 平台就会在调用点
/// 报 `E0425`（`cfg!` 的条件分支永远会被编译，哪怕运行时走不到）。
fn same_component(a: &Component, b: &Component) -> bool {
    if cfg!(windows) {
        a.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&b.as_os_str().to_string_lossy())
    } else {
        a == b
    }
}

/// 进度载荷构造。
fn step(
    operation: &'static str,
    phase: &'static str,
    copied_files: u64,
    copied_bytes: u64,
    total_files: u64,
    total_bytes: u64,
) -> ProgressPayload {
    ProgressPayload {
        operation,
        phase,
        copied_files,
        copied_bytes,
        total_files,
        total_bytes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dsh-data-dir-migrate-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn validate_rejects_same_nested_and_non_empty_targets() {
        let root = temp_dir("validate");
        let source = root.join("home");
        fs::create_dir_all(source.join("sessions")).unwrap();
        assert!(validate_target(&source, &source).is_err());
        assert!(validate_target(&source, &source.join("inner")).is_err());
        assert!(validate_target(&source.join("inner"), &source).is_err());
        assert!(validate_target(&source, Path::new("relative")).is_err());

        let filled = root.join("filled");
        fs::create_dir_all(&filled).unwrap();
        fs::write(filled.join("a.txt"), "1").unwrap();
        assert!(validate_target(&source, &filled).is_err());

        let empty = root.join("empty");
        fs::create_dir_all(&empty).unwrap();
        assert!(validate_target(&source, &empty).is_ok());
        assert!(validate_target(&source, &root.join("missing")).is_ok());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn is_within_compares_path_components_not_prefixes() {
        let data = Path::new("D:\\Data");
        assert!(is_within(Path::new("D:\\Data\\sub"), data));
        assert!(is_within(data, data));
        assert!(!is_within(Path::new("D:\\Database"), data));
        assert!(!is_within(Path::new("D:\\Other"), data));
        assert!(!is_within(data, Path::new("")));
    }

    #[cfg(windows)]
    #[test]
    fn is_within_ignores_case_and_the_verbatim_prefix() {
        assert!(is_within(Path::new("d:\\data\\sub"), Path::new("D:\\Data")));
        assert!(is_within(Path::new("\\\\?\\D:\\Data\\sub"), Path::new("D:\\Data")));
    }

    #[test]
    fn same_path_matches_only_the_same_directory() {
        assert!(same_path(Path::new("D:\\Data"), Path::new("D:\\Data\\")));
        assert!(!same_path(Path::new("D:\\Data"), Path::new("D:\\Data2")));
    }

    #[test]
    fn search_places_dedupes_without_losing_order() {
        let current = Path::new("D:\\Data\\DSHHome");
        let default = Path::new("C:\\Users\\me\\.dsh");
        let places = search_places(current, default, Some(Path::new("E:\\Old\\DSHHome")));
        assert_eq!(places.len(), 3);
        assert_eq!(places[0], current);
        assert_eq!(places[1], default);
        assert_eq!(places[2], Path::new("E:\\Old\\DSHHome"));
        // 当前目录恰好就是默认目录时只留一个（同一个目录不该被查两遍）
        assert_eq!(search_places(default, default, None).len(), 1);
        // 记录为空：只有当前与默认两处
        assert_eq!(search_places(current, default, None).len(), 2);
    }

    /// 每个位置必须用**自己的**目录名去匹配备份。
    ///
    /// 从默认目录（`~/.dsh`）搬走时备份叫 `.dsh.moved-*`，而当前位置叫 `DSHHome`：
    /// 统一用当前位置的名字去找会一条都找不到，面板上连回滚入口都不出现。
    #[test]
    fn collect_backups_matches_each_place_own_name() {
        let root = temp_dir("backups");
        let moved_from = root.join("moved");
        let moved_to = root.join("moved-to");
        fs::create_dir_all(&moved_from).unwrap();
        fs::create_dir_all(&moved_to).unwrap();
        let from = moved_from.join("DSHHome");
        let to = moved_to.join(".dsh");
        fs::create_dir_all(from.join("profiles")).unwrap();
        fs::create_dir_all(to.join("profiles")).unwrap();
        let backup_from = moved_from.join("DSHHome.moved-2026-01-01T00-00-00");
        let backup_to = moved_to.join(".dsh.moved-2026-01-02T00-00-00");
        fs::create_dir_all(&backup_from).unwrap();
        fs::create_dir_all(&backup_to).unwrap();

        let found = collect_backups(&[from.clone(), to.clone()]);
        assert!(found.contains(&backup_from), "当前位置的备份未被找到：{found:?}");
        assert!(found.contains(&backup_to), "默认位置的备份未被找到：{found:?}");
        // 反向核对：用当前位置的名字去找默认位置旁边的备份必须一无所获
        assert!(state::find_moved_dirs(&moved_to, "DSHHome").is_empty());
        let _ = fs::remove_dir_all(&root);
    }
}
