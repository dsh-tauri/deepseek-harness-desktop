//! 数据目录（`DSH_HOME`）迁移 / 回滚的 Tauri 命令（issue #871）。
//!
//! 薄封装：把 IPC 参数转成 `service::data_dir` 的调用，遵循 `bridge/backup.rs`
//! 的分层模式。迁移属于长任务（实测约 900 MiB / 25800 个文件），因此：
//! - 命令先取核心切换锁、停 Harness、持插件操作锁，再进 `spawn_blocking`；
//! - 进度通过 `data-dir://progress` 事件推送，前端订阅渲染。

use std::path::{Path, PathBuf};

use tauri::AppHandle;

use crate::service::data_dir;

/// 标记文件名（错误信息与 `data_dir::harness_marker` 指向同一个文件）。
const MARKER_NAME: &str = ".harness.pid";

/// `stop()` 之前：标记读不出来就先拒绝，别给 `stop()` 删标记的机会。
///
/// `stop()` 成功后会删掉 `.harness.pid`（`workflow::process::stop`），删掉之后
/// 「这个目录当时有没有别的 Harness 在写」就再也查不出来了。标记读不出来
/// （占用、权限、写到一半）恰恰说明有人正动这个文件，此时既拿不到 PID、也就无法
/// 排除「有个不在 owned 注册表里的 Harness 还在写这个目录」，只能 fail closed。
///
/// 标记里写着一个存活 PID 时**不**在这里拒绝：那通常就是本应用自己拉起的 Harness
/// （`launch.rs` 启动后立刻写下标记），`stop()` 会正常把它停掉；提前拒绝会让
/// 正常迁移永远走不下去。这类判断留给 `stop()` 之后的 `confirm_harness_stopped`。
fn reject_unreadable_marker(recorded: data_dir::HarnessMarker) -> Result<(), String> {
    use data_dir::HarnessMarker;
    match recorded {
        HarnessMarker::Invalid => Err(format!(
            "DATA_DIR_HARNESS_MARKER_INVALID: {} 读不出来，无法确认 Harness 是否已退出，请先退出所有实例再重试",
            MARKER_NAME
        )),
        // 标记里写着一个存活 PID：那通常就是本应用自己拉起的 Harness，放行让
        // `stop()` 去停它；真正「停不掉」的情况由停服后的复核负责。
        HarnessMarker::Missing | HarnessMarker::Pid(_) => Ok(()),
    }
}

/// `stop()` 之后：确认「记录在案的那个 Harness 真的已经退出」。
///
/// `stop()` 只处理本进程持有的那个 Harness。于是「崩溃残留、不在 owned 注册表里
/// 的 Harness」既拦不住 `stop()`，也会因为标记被删而在 `data_dir::harness_stopped`
/// 眼里变成「已退出」。所以调用方在停之前先把标记读下来，停完再复核一次它是否真的
/// 没了——「stop 返回 Ok」与「标记没了」都不是它退出的证据。
///
/// 判据刻意只取标记文件里的 PID，不做命令行 / 端口推断：标记路径由数据目录推出，
/// 天然限定在「同一个数据目录」；而命令行里的 `--profile` 与 `--port` 都不含目录
/// 信息（用户自己的另一个实例同样是 `--profile tauri --port 3080`），端口还可能被
/// 无关程序占用。照命令行去清扫会杀掉用户正在用的那个实例，代价远大于让用户
/// 手动关掉它再重试，因此这里只报告、不动手。
fn confirm_harness_stopped(recorded: data_dir::HarnessMarker) -> Result<(), String> {
    use data_dir::HarnessMarker;
    match recorded {
        // 正常路径上到不了这里（`reject_unreadable_marker` 已经先拦下），留着是
        // 为了万一将来有人调换两步顺序时仍然 fail closed。
        HarnessMarker::Invalid => Err(format!(
            "DATA_DIR_HARNESS_MARKER_INVALID: {} 读不出来，无法确认 Harness 是否已退出，请先退出所有实例再重试",
            MARKER_NAME
        )),
        // 从未启动过、或上次已正常清理：没有别的实例可担心
        HarnessMarker::Missing => Ok(()),
        HarnessMarker::Pid(pid) => {
            if data_dir::process_alive(pid) {
                return Err(format!(
                    "DATA_DIR_HARNESS_RUNNING: {pid} 仍在使用数据目录，请先退出那个实例再重试"
                ));
            }
            Ok(())
        }
    }
}

/// 当前数据目录状态（同步命令：只读注册表与目录名，不做遍历）。
#[tauri::command]
pub fn get_data_dir_status(app_handle: AppHandle) -> data_dir::DataDirStatus {
    data_dir::status(&app_handle)
}

/// 弹出系统选目录对话框，返回用户选中的目录（取消返回 `None`）。
///
/// 选目录走 `rfd`：仓库未引入 `tauri-plugin-dialog`，`AsyncFileDialog` 自己起线程
/// （macOS 后端会把对话框派发到主线程），因此可以直接在异步命令里 `.await`。
/// Linux 上用 xdg-desktop-portal 后端；没有 portal 的会话（纯 X11、无 DBus）会
/// 失败，前端据此提示用户手填路径。
#[tauri::command]
pub async fn pick_data_dir(app_handle: AppHandle) -> Result<Option<String>, String> {
    let start = crate::config::get_dsh_data_path(&app_handle);
    let picked = rfd::AsyncFileDialog::new()
        .set_title("选择数据存放目录")
        .set_directory(start.parent().unwrap_or(&start))
        .pick_folder()
        .await;
    Ok(picked.map(|handle| handle.path().to_string_lossy().into_owned()))
}

/// 数据目录下的顶层条目及占用空间（遍历目录树，脱离异步运行时）。
#[tauri::command]
pub async fn list_data_dir_entries(
    app_handle: AppHandle,
) -> Result<Vec<data_dir::DataDirEntry>, String> {
    let app = app_handle.clone();
    tauri::async_runtime::spawn_blocking(move || data_dir::entries(&app))
        .await
        .map_err(|e| format!("DATA_DIR_TASK: {e}"))?
}

/// 迁移预检：目标合法性、体积、磁盘空间（遍历目录树，脱离异步运行时）。
#[tauri::command]
pub async fn preview_data_dir_migration(
    app_handle: AppHandle,
    parent: String,
    leaf: String,
) -> Result<data_dir::MigrationPlan, String> {
    let app = app_handle.clone();
    tauri::async_runtime::spawn_blocking(move || data_dir::preview(&app, Path::new(&parent), &leaf))
        .await
        .map_err(|e| format!("DATA_DIR_TASK: {e}"))?
}

/// 把数据目录迁到 `<parent>\<leaf>`。
///
/// 顺序与 `export_recovery_backup` 一致：先停 Harness 再动文件，锁守卫活到
/// 任务结束，期间任何安装 / 备份 / 核心切换请求都会排队等待。
#[tauri::command]
pub async fn migrate_data_dir(
    app_handle: AppHandle,
    parent: String,
    leaf: String,
) -> Result<data_dir::MigrationOutcome, String> {
    let transition = crate::service::workflow::acquire_core_transition().await?;
    let operation = crate::service::plugin::acquire_operation_lock().await;
    // 标记要在 `stop()` 之前读：停成功时它会顺手删掉标记，删掉之后就再也查不出
    // 「崩溃残留、不在 owned 注册表里的 Harness」是否还在写这个目录。
    let recorded = data_dir::harness_marker(&app_handle);
    reject_unreadable_marker(recorded)?;
    crate::service::workflow::stop(app_handle.clone()).await?;
    confirm_harness_stopped(recorded)?;
    let app = app_handle.clone();
    let result = data_dir::migrate(app, PathBuf::from(parent), leaf).await;
    drop(transition);
    drop(operation);
    result
}

/// 回滚到旧目录备份（`backup` 为空时按「会话数优先、时间戳其次」自动挑选）。
#[tauri::command]
pub async fn rollback_data_dir(
    app_handle: AppHandle,
    backup: Option<String>,
) -> Result<data_dir::MigrationOutcome, String> {
    let transition = crate::service::workflow::acquire_core_transition().await?;
    let operation = crate::service::plugin::acquire_operation_lock().await;
    let recorded = data_dir::harness_marker(&app_handle);
    reject_unreadable_marker(recorded)?;
    crate::service::workflow::stop(app_handle.clone()).await?;
    confirm_harness_stopped(recorded)?;
    let app = app_handle.clone();
    let result = data_dir::rollback(app, backup.map(PathBuf::from)).await;
    drop(transition);
    drop(operation);
    result
}
