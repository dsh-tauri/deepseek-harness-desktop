//! 预装与已安装插件的增删改查、管理。
//!
//! 包括首次启动的预装插件引导（安装/取消/跳过/待办检测/打开仓库）、已安装
//! 插件的列表/升级/卸载，以及运行期异常的记录与「卸除此插件并继续检测」修复。

use crate::config;
use crate::service::plugin;
use tauri::AppHandle;
use tauri::Emitter;
#[cfg(windows)]
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

fn mark_preinstall_done(app_handle: &AppHandle) {
    let mut setting = config::get_store_dat_setting(app_handle);
    setting.preinstall_done = true;
    if let Some(hash) = plugin::current_preset_hash(app_handle) {
        setting.preset_hash = Some(hash);
    }
    config::set_store_dat_setting(app_handle, setting);
}

/// 获取预装插件列表（含已安装检测结果），首次启动引导界面渲染用
#[tauri::command]
pub async fn get_preinstall_plugins(
    app_handle: AppHandle,
) -> Result<Vec<plugin::PreinstallPlugin>, String> {
    Ok(plugin::list(&app_handle))
}

/// 安装选中的预装插件（`dsh plugin --profile web add <ids...>`），
/// 进程输出实时通过 `preinstall-log` 事件推送；成功后标记引导完成并记录预设指纹。
///
/// 同时支持卸载用户取消勾选的已安装插件（`uninstall_ids`）：走
/// `dsh plugin remove`（与安装对称的命令行卸载），失败时自动回退离线精准卸载
/// （`plugin::uninstall_recovery`，直接改 profile 清单），不依赖网络兜底。
#[tauri::command]
pub async fn install_preinstall_plugins(
    app_handle: AppHandle,
    install_ids: Vec<String>,
    uninstall_ids: Vec<String>,
) -> Result<(), String> {
    // 安装与卸载均为空：无需操作，直接标记完成
    if install_ids.is_empty() && uninstall_ids.is_empty() {
        mark_preinstall_done(&app_handle);
        return Ok(());
    }

    // 先卸载取消勾选的已安装插件（走 dsh plugin remove，与安装对称）
    // 卸载在前：避免新装插件与待卸载插件冲突；remove 内部会先停服务再执行
    log::info!("[preinstall] uninstall_ids={uninstall_ids:?}, install_ids={install_ids:?}");
    if !uninstall_ids.is_empty() {
        log::info!("[preinstall] removing plugins {uninstall_ids:?} via dsh plugin remove");
        plugin::remove_many(&app_handle, &uninstall_ids)
            .await
            .map_err(|e| {
                log::error!("[preinstall] failed to remove plugins {uninstall_ids:?}: {e}");
                e
            })?;
        log::info!("[preinstall] successfully removed plugins {uninstall_ids:?}");
    }

    // 再安装新勾选的插件（会走 dsh plugin add）
    if !install_ids.is_empty() {
        log::info!("[preinstall] installing plugins {install_ids:?}");
        plugin::install(&app_handle, &install_ids).await?;
    }

    mark_preinstall_done(&app_handle);
    Ok(())
}

/// 取消正在进行的插件进程（安装/升级/卸载，网络抖动/限流卡住时用户点“取消”）。
#[tauri::command]
pub async fn cancel_plugin_processes(app_handle: AppHandle) {
    plugin::cancel(&app_handle).await;
}

/// 按原始 spec 安装插件（插件市场 / 手动输入 entry）：支持一次传入多个 spec，
/// 合并为单次 `dsh plugin add` 执行，输出同样经 `preinstall-log` 事件推送。
///
/// 与 `install_preinstall_plugins` 的区别只在 spec 来源：此处不走预设清单，
/// 因而没有捆绑目录与版本矩阵，spec 原样交给 pnpm 解析。
#[tauri::command]
pub async fn install_plugin_specs(app_handle: AppHandle, specs: Vec<String>) -> Result<(), String> {
    plugin::install_specs(&app_handle, &specs).await?;
    plugin::watch::force_emit(&app_handle);
    Ok(())
}

/// 本地插件热重载的当前状态：生效开关、补丁层路径与被监听的源码目录。
#[tauri::command]
pub async fn get_local_plugin_hmr(app_handle: AppHandle) -> Result<plugin::LocalHmrStatus, String> {
    Ok(plugin::local_plugin_hmr_status(&app_handle))
}

/// 开关本地插件热重载：开关变化会立即复算补丁层，下次启动服务时生效。
#[tauri::command]
pub async fn set_local_plugin_hmr(
    app_handle: AppHandle,
    enabled: bool,
) -> Result<plugin::LocalHmrStatus, String> {
    config::update_store_dat_setting(&app_handle, |setting| {
        setting.local_plugin_hmr = enabled;
    });
    let patch = plugin::local_plugin_hmr_sync(&app_handle);
    log::info!(
        "[hmr] local plugin hot reload set to {enabled}, layer: {:?}",
        patch.as_ref().map(|path| path.display().to_string())
    );
    Ok(plugin::local_plugin_hmr_status(&app_handle))
}

/// 只读检查一组 spec 的兼容性（registry `latest` 上的 DSH 家族 peer 依赖），
/// 不改动本地 profile；失败项收敛为结果里的 `problem`，不整体报错。
#[tauri::command]
pub async fn inspect_plugin_specs(
    app_handle: AppHandle,
    specs: Vec<String>,
    dsh: Option<String>,
) -> Result<Vec<plugin::compat::PluginInspect>, String> {
    plugin::inspect_specs(&app_handle, &specs, dsh).await
}

/// 授予「插件版本豁免」：为被核心版本兼容性拒绝的精确 `包名@版本` 组合写授权。
///
/// 前端在风险提示中让用户逐项确认后调用（授权项来自 `install_preinstall_plugins`
/// 返回的 `PLUGIN_VERSION_INCOMPATIBLE:` 载荷），随后重跑安装；豁免不随插件或
/// 核心升级继承，且只对列出的精确版本 + 运行时版本生效。
#[tauri::command]
pub async fn allow_plugin_versions(
    app_handle: AppHandle,
    versions: Vec<plugin::IncompatibleVersion>,
) -> Result<(), String> {
    plugin::allow_version_exemptions(&app_handle, &versions).await
}

/// 记录发布时长策略豁免：用户确认接受「刚发布、还在 24 小时窗口内」的精确版本后调用。
///
/// 授权项来自 `PLUGIN_POLICY_BLOCKED:` 载荷（pnpm 的 `minimumReleaseAge` 门禁——档案
/// 已声明这样的版本时，每次插件操作都会失败）。写的是精确 `包名@版本`，只让列出的条目
/// 过闸，其余解析照旧受窗口约束；随后由界面重跑原操作。与 `allow_plugin_versions`
/// （dsh 的版本兼容性豁免，写 `compatibility.json`）是两套互不相干的授权。
#[tauri::command]
pub async fn allow_plugin_policy_versions(
    app_handle: AppHandle,
    versions: Vec<plugin::PolicyBlockedVersion>,
) -> Result<(), String> {
    plugin::allow_policy_versions(&app_handle, &versions)
}

/// 跳过预装插件引导：记录状态与预设指纹，之后不再弹出（除非清单内容变更）
#[tauri::command]
pub async fn skip_preinstall_plugins(app_handle: AppHandle) -> Result<(), String> {
    mark_preinstall_done(&app_handle);
    Ok(())
}

/// 内置插件启动自愈（供前端 boot 流程调用，独立于预装引导「继续/跳过」）。
///
/// 与 service 启动路径（`workflow::launch` 内）共用 `plugin::ensure_internal_plugins`
/// 同一实现：内部有并发锁、幂等，此后启动/重启路径会再核对但均为 no-op。
/// 错误返回前端，由启动状态机按 plugin-install 阶段展示精确错误与重试入口；
/// workflow 自启动路径仍保留最佳努力语义。
#[tauri::command]
pub async fn ensure_internal_plugins(app_handle: AppHandle) -> Result<(), String> {
    plugin::ensure_internal_plugins(&app_handle).await
}

/// 取消共享的内置插件自愈并等待子进程树退出，供启动阶段超时后清理。
#[tauri::command]
pub async fn cancel_internal_plugins() -> Result<(), String> {
    plugin::cancel_internal_plugins().await
}

/// 是否有新的预装插件需要引导：预设清单内容与上次记录不一致（或老用户无基线）。
/// 资源文件每次安装都被强制覆盖不可比对，只能比对 app-data 里记录的内容指纹。
#[tauri::command]
pub fn get_preinstall_pending(app_handle: AppHandle) -> Result<bool, String> {
    Ok(plugin::preinstall_pending(&app_handle))
}

/// 在系统浏览器中打开预装插件的仓库地址（仅允许预装清单内的 id）
#[tauri::command]
pub async fn open_preinstall_repo(app_handle: AppHandle, id: String) -> Result<(), String> {
    let url = plugin::repo_url_of(&app_handle, &id)
        .ok_or_else(|| format!("PREINSTALL_INVALID_ID: {id}"))?;
    app_handle
        .opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// 当前 profile 已安装插件列表（含解析后的元信息），插件面板首次加载用；
/// 之后 Rust 侧监控插件文件，变化时通过 `dsh-plugins-updated` 事件实时推送。
/// 这里会并入 `updates` 模块的已知更新判定缓存（未判定时 `update_available=false`）。
#[tauri::command]
pub fn get_dsh_plugins(app_handle: AppHandle) -> Vec<plugin::DshPlugin> {
    let mut plugins = plugin::watch::list(&app_handle);
    plugin::update::apply_cache(&app_handle, &mut plugins);
    plugins
}

/// 重新探测已安装插件的更新可用性（网络 + 30min 缓存），返回带最新判定结果的列表。
///
/// 与 `get_dsh_plugins` 不同，此处会发起 registry / GitHub 请求（并行、失败静默按
/// 「无更新」处理）。前端在插件面板挂载后调用一次以补齐 `updateAvailable`，使升级
/// 按钮只在确有更新（或异常修复）时出现，而不是常驻。
#[tauri::command]
pub async fn refresh_plugin_updates(
    app_handle: AppHandle,
) -> Result<Vec<plugin::DshPlugin>, String> {
    plugin::update::refresh(&app_handle).await
}

/// 批量升级已安装插件：`dsh plugin --profile <当前档案> update <id...> --latest`，
/// 合并为单次子进程执行，输出通过 `preinstall-log` 事件实时推送；升级前逐项
/// 记录依赖指纹，命令返回后核验是否真实落盘（防 pnpm 假成功）。
///
/// `ids` 的每一项是 `<id>` 或 `<id>@<版本>`（保留参数名以免改动前端载荷键）：面板显示着
/// 目标版本，带上它核验与显式安装兜底才有据可依（见 `plugin::update_many`）。
#[tauri::command]
pub async fn update_dsh_plugins(app_handle: AppHandle, ids: Vec<String>) -> Result<(), String> {
    plugin::update_many(&app_handle, &ids).await?;
    plugin::watch::force_emit(&app_handle);
    Ok(())
}

/// 批量卸载已安装插件：`dsh plugin --profile <当前档案> remove <ids...>`，
/// 合并为单次子进程执行，输出通过 `preinstall-log` 事件实时推送；命令后逐项核验，
/// 仍残留且可行动的插件回退离线精准卸载（不依赖网络）。
#[tauri::command]
pub async fn remove_dsh_plugins(app_handle: AppHandle, ids: Vec<String>) -> Result<(), String> {
    plugin::remove_many(&app_handle, &ids).await?;
    plugin::watch::force_emit(&app_handle);
    Ok(())
}

/// 上报插件运行期异常（内嵌页面 / dsh-tauri 桥调用），记录后立即推送新列表，
/// 并推送 `plugin-recovery-required` 让前端弹出「卸除此插件并继续检测」修复界面。
#[tauri::command]
pub fn report_plugin_error(
    app_handle: AppHandle,
    id: String,
    error: String,
    action: Option<String>,
) -> Result<(), String> {
    plugin::errors::record(
        &app_handle,
        &id,
        action.as_deref().unwrap_or("runtime"),
        &error,
    )?;
    plugin::watch::force_emit(&app_handle);
    // 运行期异常：直接推送修复界面（应用仍在运行，前端以醒目对话框呈现）。
    let info = plugin::PluginRecoveryInfo {
        plugins: vec![id],
        reason: "runtime".to_string(),
        detail: String::new(),
        raw_error: error,
    };
    let _ = app_handle.emit(plugin::recovery::RECOVERY_REQUIRED_EVENT, &info);
    Ok(())
}

/// 从启动日志定位导致启动失败的问题插件（含归属到配置根插件）。
///
/// 前端在启动失败时已读过服务日志（`read_service_logs`），这里直接传入日志行，
/// 由 Rust 侧按错误特征提取引用并做证据式归属；未定位到具体插件时 `plugins` 为空。
#[tauri::command]
pub fn detect_plugin_recovery(
    app_handle: AppHandle,
    logs: Vec<String>,
) -> plugin::PluginRecoveryInfo {
    plugin::detect_recovery(&app_handle, &logs)
}

/// 修复模式卸载单个插件：直接改 profile 清单（离线、精准），成功后推送新插件列表。
///
/// 与 `remove_dsh_plugins`（走 `dsh plugin remove`）不同，此命令不依赖网络，专用于
/// 「插件异常修复」场景；前端随后 `restart()` 重启并重新检测。
#[tauri::command]
pub fn recover_plugin(app_handle: AppHandle, id: String) -> Result<(), String> {
    plugin::uninstall_recovery(&app_handle, &id)?;
    plugin::watch::force_emit(&app_handle);
    Ok(())
}

/// 禁用单个已安装插件：从 profile 的 `dsh.profile.bundles` 移除（代码完全不加载），
/// 并写入 profile 的独立禁用清单。与卸载不同，禁用保留 node_modules 内的包体，
/// 启用时无需重新下载。
#[tauri::command]
pub fn disable_dsh_plugin(app_handle: AppHandle, id: String) -> Result<(), String> {
    plugin::disable(&app_handle, &id)?;
    plugin::watch::force_emit(&app_handle);
    Ok(())
}

/// 启用单个已禁用的插件：加回 `dsh.profile.bundles` 并从独立禁用清单移除。
///
/// 若插件同时被 profile 的 `cordis.patch.yml` 配置覆盖禁用（`disabled: true`，
/// 优先级高于桌面禁用清单），必须显式传 `clear_config_override=true`（前端
/// 弹窗确认后）才会移除该覆盖；否则返回 `ENABLE_CONFIG_OVERRIDE`，避免
/// 「声称启用成功、运行期却仍被配置禁用」的虚假成功（issue #399）。
#[tauri::command]
pub fn enable_dsh_plugin(
    app_handle: AppHandle,
    id: String,
    clear_config_override: Option<bool>,
) -> Result<(), String> {
    plugin::enable(&app_handle, &id, clear_config_override.unwrap_or(false))?;
    plugin::watch::force_emit(&app_handle);
    Ok(())
}

/// 创建单个插件的快照（覆盖式：已存在则整体替换），存档于
/// `$DSH_HOME/.plugin-backups/<id>.tgz`。
#[tauri::command]
pub fn snapshot_plugin(
    app_handle: AppHandle,
    id: String,
) -> Result<plugin::snapshot::SnapshotInfo, String> {
    plugin::snapshot::create(&app_handle, &id)
}

/// 批量创建插件快照（升级前置自动快照）：单项失败只记录在结果里，不阻断其它项。
#[tauri::command]
pub fn snapshot_plugins(
    app_handle: AppHandle,
    ids: Vec<String>,
) -> Result<Vec<plugin::snapshot::SnapshotResult>, String> {
    Ok(plugin::snapshot::create_many(&app_handle, &ids))
}

/// 查询单个插件的快照信息（存在性 + 时间 + 大小 + 是否含配置段）。
#[tauri::command]
pub fn get_plugin_backup(app_handle: AppHandle, id: String) -> plugin::snapshot::PluginBackupInfo {
    plugin::snapshot::get(&app_handle, &id)
}

/// 还原单个插件的快照（覆盖式，内部停服务；仅第三方可行动插件允许）。
#[tauri::command]
pub async fn restore_plugin(app_handle: AppHandle, id: String) -> Result<(), String> {
    plugin::snapshot::restore(&app_handle, &id).await?;
    plugin::watch::force_emit(&app_handle);
    Ok(())
}

/// 弹出系统文件夹选择器，返回可直接安装的本地插件 `link:` spec（取消时为 `None`）。
///
/// Windows 的文件夹选择器是 COM 组件（`CoInitializeEx` 要求 STA 单元），而异步命令体跑在
/// 线程池上、线程的 COM 单元不确定；因此把对话框搬到主线程（tao 建窗时已初始化 STA），
/// 再同步等它关闭：阻塞的是原生对话框自身，异步运行时不阻塞。
/// 其余平台走 `rfd` 的异步对话框（与 `pick_data_dir` 同一条路）：macOS 后端自己把面板
/// 派发到主线程、不设父窗也会挂到主窗，Linux 用 xdg-desktop-portal，没有 portal 的会话会
/// 回退 zenity。这两条路都拿不到用户选择时同样返回 `None`，与「用户取消」无法区分，
/// 前端按取消处理（不弹错）。
#[tauri::command]
pub async fn pick_local_plugin_dir(app_handle: AppHandle) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let app = app_handle.clone();
        app_handle
            .run_on_main_thread(move || {
                let mut dialog = rfd::FileDialog::new().set_title("选择本地插件目录");
                if let Some(window) =
                    app.get_webview_window(crate::desktop::builder::MAIN_WINDOW_LABEL)
                {
                    dialog = dialog.set_parent(&window);
                }
                let picked = dialog
                    .pick_folder()
                    .map(|dir| plugin::local_spec_from_path(&dir));
                let _ = sender.send(picked);
            })
            .map_err(|error| format!("PLUGIN_PICK_FOLDER_FAILED: {error}"))?;
        receiver
            .await
            .map_err(|error| format!("PLUGIN_PICK_FOLDER_FAILED: {error}"))
    }
    #[cfg(not(windows))]
    {
        let _ = app_handle;
        let picked = rfd::AsyncFileDialog::new()
            .set_title("选择本地插件目录")
            .pick_folder()
            .await;
        Ok(picked.map(|handle| plugin::local_spec_from_path(handle.path())))
    }
}

/// 删除单个插件的快照（卸载级联清理 / 手动删除）：幂等，无快照视为成功。
#[tauri::command]
pub fn delete_plugin_backup(app_handle: AppHandle, id: String) -> Result<(), String> {
    plugin::snapshot::delete(&app_handle, &id)
}
