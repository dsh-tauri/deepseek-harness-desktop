//! Harness 服务启动编排：`start` / `restart` / `launch`，含端口自愈
//! （避让递增 + 回落、等待释放）、补丁挂点与 Windows 隐藏控制台启动。

use crate::config;
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
#[cfg(not(windows))]
use std::io::Read;
use std::path::Path;
#[cfg(not(windows))]
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;

#[cfg(not(windows))]
use super::process::set_owned_process;
#[cfg(windows)]
use super::process::set_owned_process_with_handle;
#[cfg(unix)]
use super::process::warn_if_inotify_watch_limit_low;
use super::process::{
    has_owned_process, on_owned_process_exit, stop, terminate_stale_harness_processes, LaunchGuard,
    LAUNCH_GUARD,
};
use super::status;
use super::sweep::persist_harness_pid;
#[cfg(windows)]
use super::sweep::{dsh_bin_open_error, relaunch_marker_path, relaunch_via_shell_escape};
use super::utils::{is_port_in_use, rotate_service_log, spawn_output_readers};
use super::win_inspector;

#[cfg(windows)]
type SpawnResult = std::io::Result<(Option<std::fs::File>, Option<std::fs::File>, u32)>;
#[cfg(unix)]
type SpawnResult = Result<
    (
        Option<std::process::ChildStdout>,
        Option<std::process::ChildStderr>,
        u32,
    ),
    String,
>;

/// 端口释放等待上限：刚结束/清扫过上个会话的残留 dsh 进程后，TCP 端口释放
/// 存在短暂滞后（taskkill 返回 ≠ 端口已可复用）。等待窗口内端口回落为空闲则
/// 复用配置端口；到期仍未释放才按“真占用”逐级递增。
const PORT_RELEASE_WAIT: std::time::Duration = std::time::Duration::from_millis(1500);

/// 组装启动 Harness 的参数：`[--max-old-space-size] <dsh> --profile <档案>
/// [--patch <补丁层>] --port <端口> --no-open`。
///
/// `--patch` 必须排在子命令参数之前（`dsh` 的选项收集器把第一个非选项参数之后
/// 的内容整段透传给内层应用，排在后面的 `--patch` 会被判为 `unknown option`）。
fn build_harness_args(
    dsh_binary: &Path,
    profile: &str,
    patch: Option<&Path>,
    port: u16,
    heap_mb: Option<u32>,
) -> Vec<OsString> {
    let mut args = Vec::with_capacity(9);
    args.extend(super::heap::heap_option_arg(heap_mb));
    args.extend([
        dsh_binary.as_os_str().to_os_string(),
        OsString::from("--profile"),
        OsString::from(profile),
    ]);
    if let Some(patch) = patch {
        args.push(OsString::from("--patch"));
        args.push(patch.as_os_str().to_os_string());
    }
    args.extend([
        OsString::from("--port"),
        OsString::from(port.to_string()),
        OsString::from("--no-open"),
    ]);
    args
}

/// 轮询等待配置端口释放为空闲（端口本来就空闲则立即返回）。
///
/// async（tokio）实现，避免长时间阻塞启动线程。与 `stop()` 里“给系统一点时间
/// 释放端口”的目的一致，但以“端口确实空闲”为准而不是固定睡 800ms——因此
/// 端口很快释放时几乎不额外耗时，只有真占用才等到超时。
async fn wait_for_port_release(port: u16) {
    let deadline = tokio::time::Instant::now() + PORT_RELEASE_WAIT;
    while tokio::time::Instant::now() < deadline {
        if !is_port_in_use(port) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    }
}

/// 从起始端口向上查找第一个空闲端口，绝不结束未知的端口占用进程。
fn find_available_port(start: u16) -> Result<u16, String> {
    find_available_port_by(start, is_port_in_use)
}

/// 按调用方提供的占用判定查找第一个空闲端口。
///
/// 将扫描决策与真实套接字状态分离，使单测能确定性验证递增与溢出，不在函数
/// 返回后再次探测系统端口；后者存在不可消除的 TOCTOU，任何端口段都可能被
/// 其他进程在两次探测之间占用。
fn find_available_port_by(
    start: u16,
    mut is_in_use: impl FnMut(u16) -> bool,
) -> Result<u16, String> {
    let mut port = start;
    loop {
        if !is_in_use(port) {
            return Ok(port);
        }
        log::warn!("Port {port} is occupied, trying the next port");
        port = port.checked_add(1).ok_or_else(|| {
            "PORT_EXHAUSTED: no available TCP port after the configured port".to_string()
        })?;
    }
}

/// 启动时端口自愈决策（纯函数，便于单测）。
///
/// 自动避让递增（配置端口被占 → 逐级顶高）遗留的非默认端口只在回落目标
/// （用户手动端口或默认端口）空闲时才回落；回落目标被占则维持当前端口，
/// 留给 `find_available_port` 逐级递增。用户手动设置的端口经 `manual_port`
/// 记录，回落目标即用户值；从未手动设置时回落目标是默认端口（3080/3081）。
/// 返回值与 `configured` 相同表示无需自愈。
fn resolve_heal_port(configured: u16, heal_target: u16, heal_target_free: bool) -> u16 {
    if configured != heal_target && heal_target_free {
        heal_target
    } else {
        configured
    }
}

/// 检测并启动 Harness 服务
pub async fn start(app_handle: tauri::AppHandle) -> Result<(), String> {
    let setting = config::get_store_dat_setting(&app_handle);
    let node_binary_path = config::get_node_binary_path(&app_handle);
    // 活动核心的入口：本地核心存在时优先本地（需求 3），否则预打包
    let dsh_binary_path = crate::service::core::active_dsh_binary(&app_handle);

    if !setting.installed {
        log::debug!("Harness not installed, skipping startup");
        return Ok(());
    }
    if !node_binary_path.exists() || !dsh_binary_path.exists() {
        // Windows RedirectionGuard(448)：安装器继承的强制执行上下文永不自行恢复，
        // 先尝试通过 explorer 逃逸重拉（见 relaunch_via_shell_escape 注释），
        // 成功则本进程退出；未命中（重拉未逃逸/非 448）才走常规缺失处理。
        #[cfg(windows)]
        if dsh_bin_open_error(&app_handle) == Some(448) {
            relaunch_via_shell_escape(&app_handle);
        }
        let mut setting = config::get_store_dat_setting(&app_handle);
        setting.installed = false;
        config::set_store_dat_setting(&app_handle, setting);
        // 状态变更需要 info 级落盘：这是「store 显示未安装」的源头之一
        // （核心文件短暂缺失被复位），自更新后自动重开走进安装分支多由此触发。
        log::info!("Runtime files missing (node/dsh), resetting installed flag");
        return Ok(());
    }

    if has_owned_process() {
        log::info!("Owned Harness process is already running");
        status::set_status(status::Status::Running);
        status::emit_status(&app_handle);
        return Ok(());
    }

    // 清理 RedirectionGuard(448) 逃逸重拉标记：本进程正常走到启动说明处于干净上下文，
    // 移除标记保证下次自更新后仍能触发逃逸重拉。
    #[cfg(windows)]
    let _ = std::fs::remove_file(relaunch_marker_path(&app_handle));

    log::info!("Starting Harness service");
    status::set_status(status::Status::Starting);
    status::emit_status(&app_handle);
    launch(app_handle).await?;
    // 之后由 scheduler/task/tick_check_dsh_process/mod.rs 检测状态

    Ok(())
}

/// 重启 Harness 服务
pub async fn restart(app_handle: tauri::AppHandle) -> Result<(), String> {
    log::info!("Restarting Harness service");

    // 1. 停止现有服务
    stop(app_handle.clone()).await?;

    // 2. 重新启动
    start(app_handle).await?;

    Ok(())
}

/// 把 active profile 的 `cordis.yml` 重置为官方空根。
///
/// dsh 的 Loader 在插件 dispose 时会把组合后的整棵 entry 树回写进
/// `cordis.yml`（dsh-app-boot：plugin self-disposing persists the current
/// tree）。上一轮被杀/崩溃的 dsh 若留下组合行，新 boot 会读到已含 bundle 行的
/// 文件，再叠加同一批 patch → `duplicate loader entry`。spawn 前与「早期退出
/// 重试」各调用一次，把竞态窗口关闭到最小；文件已是空根时静默跳过。
fn reset_active_profile_root(app_handle: &tauri::AppHandle) {
    let profile_root = crate::service::profile::profile_dir_of(
        app_handle,
        &crate::service::profile::active_profile(app_handle),
    );
    if !profile_root.is_dir() {
        return;
    }
    let root_config = profile_root.join("cordis.yml");
    const PROFILE_ROOT_EMPTY: &str = "# dsh profile root — an empty entry list. The tree is composed as patches:\n# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any\n# --patch overlays. Edit cordis.patch.yml, not this file.\n[]\n";
    if std::fs::read_to_string(&root_config).ok().as_deref() != Some(PROFILE_ROOT_EMPTY) {
        if let Err(e) = std::fs::write(&root_config, PROFILE_ROOT_EMPTY) {
            log::warn!("PROFILE_ROOT_RESET_FAILED: {}: {e}", root_config.display());
        } else {
            log::info!(
                "Reset stale profile root before spawn: {}",
                root_config.display()
            );
        }
    }
}

/// 判断 dsh 早期退出是否命中「duplicate loader entry」竞态签名。
///
/// 竞态特征：exit code 1 且 stderr 含 `duplicate loader entry`（dsh-app-boot
/// 的 Include 把重复 bundle 行叠加进根树时抛出的 TypeError 文本，实测
/// `duplicate loader entry id: dsh-tauri-worktree`）。
#[cfg(windows)]
fn is_duplicate_loader_exit(exit_code: u32, stderr: &str) -> bool {
    exit_code == 1 && stderr.contains("duplicate loader entry")
}

/// 启动 Harness 服务进程
pub async fn launch(app_handle: tauri::AppHandle) -> Result<(), String> {
    // 启动分段计时（issue #766）：只写日志，不改控制流。每段一行 `STARTUP_PHASE`，
    // `ms` 是本段耗时、`total` 是本次 launch 的累计耗时。启动慢的归因过去只能靠
    // 时间戳猜测（同一进程内 auto_start 与前端 invoke 并发交错），埋点后可直接
    // 从 desktop.log 读出「哪一段慢、慢多少」。
    let startup_started = std::time::Instant::now();
    let mut phase_started = startup_started;
    // 段末打点：`ms` 为上一段耗时，`total` 为 launch 累计。closure 只服务本函数，
    // 因此就地定义而不抽成独立模块/工具。
    let mark_phase = |name: &str, phase_started: &mut std::time::Instant| {
        let now = std::time::Instant::now();
        log::info!(
            "STARTUP_PHASE: name={name} ms={} total={}",
            now.duration_since(*phase_started).as_millis(),
            now.duration_since(startup_started).as_millis()
        );
        *phase_started = now;
    };
    let mut setting = config::get_store_dat_setting(&app_handle);
    let node_binary_path = config::get_node_binary_path(&app_handle);
    let _transition_guard = super::process::acquire_core_transition().await?;
    let dsh_binary_path = crate::service::core::active_dsh_binary(&app_handle);

    log::debug!("Checking Node.js path: {:?}", node_binary_path);
    if !node_binary_path.exists() {
        log::error!("Node.js not installed");
        return Err("NODE_NOT_FOUND: Node.js not installed".to_string());
    }
    log::debug!("Checking Harness path: {:?}", dsh_binary_path);
    if !dsh_binary_path.exists() {
        log::error!("Harness not installed");
        return Err("HARNESS_NOT_FOUND: Harness not installed".to_string());
    }
    mark_phase("resolve", &mut phase_started);

    // 从这里开始持有与核心切换共用的互斥锁：最终状态检查、启动守卫、残留清扫
    // 及新进程登记必须处于同一临界区，避免切换在检查后插入。

    // 避免重复启动（配合启动守卫，确保并发调用只拉起一个进程）
    if has_owned_process() {
        log::info!("Owned Harness process is already running, skipping launch");
        return Ok(());
    }
    if LAUNCH_GUARD
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        log::info!("Harness launch already in progress, skipping");
        return Ok(());
    }
    let _launch_guard = LaunchGuard;
    // 只有持有启动守卫的这条路径清扫残留：并发启动的其它调用已在守卫处返回，
    // 不会误杀刚拉起的进程。崩溃/强杀残留的孤儿 Harness 实例（不在
    // .harness.pid 标记中）持续占用配置端口与 dependencies/dsh 的文件句柄，
    // 不清扫会导致端口一路漂移（3080→…→3085，issue #91）并让后续目录互换
    // 失败（os error 32）。按命令行路径精确匹配本应用 dsh 服务，不会误杀
    // 用户其它 node 程序（debug 构建为 no-op，见 terminate_stale_harness_processes）。
    {
        let handle = app_handle.clone();
        if let Err(e) = tauri::async_runtime::spawn_blocking(move || {
            terminate_stale_harness_processes(&handle);
        })
        .await
        {
            log::warn!(
                "failed to sweep stale Harness processes before launch at {}: {e}",
                dsh_binary_path.display()
            );
        }
    }

    // 端口自愈：自动避让递增（配置端口被占 → 逐级顶高）遗留的非默认端口，
    // 在回落目标（用户手动端口 manual_port，否则默认端口）空闲时回落，避免
    // 端口只增不减、一路从 3080 漂到 3084+（issue #91）。先于
    // wait_for_port_release 探测：既然放弃旧端口，就无需等它释放。
    let heal_target = setting.manual_port.unwrap_or(config::default_port());
    let healed_port = resolve_heal_port(setting.port, heal_target, !is_port_in_use(heal_target));
    if healed_port != setting.port {
        log::info!(
            "Harness port healed from {} back to {} (no longer occupied)",
            setting.port,
            healed_port
        );
        setting.port = healed_port;
        config::set_store_dat_setting(&app_handle, setting.clone());
    }

    // 端口冲突时从当前值开始逐个递增，并持久化最终选择供所有调用方复用。
    // 注意：上个会话的残留 dsh 进程刚被我们结束/清扫（sweep_orphan、stop、
    // stop_on_exit），TCP 端口释放存在短暂滞后——此刻立刻探测会把“刚释放的
    // 端口”误判为仍占用，从而把配置端口永久顶高（dev 热更新下 3081→3082→…
    // 一路漂移，表现为“端口持续累加 + 首次启动超时、刷新后恢复”）。先留出
    // 窗口等配置端口回落为空闲，再决定是否真的逐级递增。
    wait_for_port_release(setting.port).await;
    let available_port = find_available_port(setting.port)?;
    if available_port != setting.port {
        log::info!(
            "Harness port changed from {} to {} because the configured port is occupied",
            setting.port,
            available_port
        );
        setting.port = available_port;
        config::set_store_dat_setting(&app_handle, setting.clone());
    }
    mark_phase("stale_sweep_and_port", &mut phase_started);

    // 构造环境变量：隔离的 $DSH_HOME + 隐私默认（关闭遥测）
    //
    // 建目录 + 可写性预检（issue #466）：`~/.dsh` 属主不是当前用户时（典型：此前
    // 用 sudo 运行过 dsh，macOS 的 sudo 保留 $HOME），读得到、写不了——dsh 起来后
    // 必然崩在写 cordis.yml/settings.yaml 上，前端只能看到
    // 「Harness exited early: exit status: 1」，完全不可行动。这里提前阻断并给出
    // 可直接粘贴的 chown 指引。
    let dsh_home = config::get_dsh_data_path(&app_handle);
    crate::service::perm::ensure_dir_writable(&dsh_home, "DSH_HOME_MKDIR_FAILED")?;
    // 当前档案目录同样必须在 spawn 前可写：`$DSH_HOME` 可写不代表档案可写——属主
    // 错位可能只落在 `profiles` 或 `profiles/<id>` 上（安全模式要新建 `profiles/safe`，
    // 因此 `profiles` 不可写同样是致命状态）。
    //
    // 先跑一次档案迁移 + 首装引导（幂等）：desktop::setup 的引导若失败（磁盘/权限
    // 抖动）或本进程没进过 setup，这里兜底；改名必须早于可写性预检，否则预检拿到的
    // 还是改名前的档案目录。最佳努力：失败只告警，不阻断启动。
    crate::service::profile::migrate_desktop_profile_name(&app_handle);

    // 预检不创建目录，避免抢先建出半初始化档案（issue #452）。
    crate::service::perm::ensure_writable_path(
        &crate::service::plugin::profile_dir(&app_handle),
        &dsh_home,
        "PROFILE_NOT_WRITABLE",
    )?;

    // 核心 bundle 层自愈（issue #452）：当前档案的 `dsh.profile.bundles` 必须带
    // 桌面端内嵌 web UI 依赖的 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`
    // （顺序即补丁层应用顺序）。档案目录被 CLI/外部初始化过（`dsh plugin add`
    // 对无清单目录只写 dsh-base）、首次初始化中途失败、用户手工编辑清单都会剥掉
    // web 层，此时宿主不提供 webServer/connection/webRuntime，内置插件与市场插件
    // 全部停在 pending，服务启动必然失败——日志只显示「N entries did not
    // activate / waiting for service: webServer」，看不出根因。缺失时按官方 web
    // 模板补齐（只补不删，用户插件条目原样保留），本轮启动即可恢复。必须在
    // 任何插件操作与 spawn 之前做。最佳努力：失败只告警，不阻断启动。
    if let Err(e) = crate::service::profile::ensure_active_profile_core_bundles(&app_handle) {
        log::warn!("ensure active profile core bundles failed: {e}");
    }

    // 安全模式：安全档案的契约是「只加载 web 模板核心 bundles、不带任何用户插件」，
    // 但档案目录一旦存在就绝不重建（用户可能反复进出安全模式），而内置插件自愈与
    // 首次引导安装都作用于「当时的活动档案」，于是安全档案里会累积用户插件——它们
    // 往往正是启动失败的元凶，不清干净的话每次进入安全模式都带着同一批插件重启，
    // 隔离形同虚设。必须在 spawn dsh 之前做（服务未运行时改清单、删 node_modules
    // 目录才安全）。内置插件与核心包由被调方保留；非安全档案直接跳过。最佳努力：
    // 失败只告警，不阻断启动（清理不彻底只是隔离效果打折，启动阻塞则让应用彻底不可用）。
    if let Err(e) = crate::service::plugin::purge_user_plugins_in_safe_profile(&app_handle) {
        log::warn!("safe mode user plugin purge failed: {e}");
    }
    mark_phase("profile_prepare", &mut phase_started);

    // Linux 起步前探测 inotify 监视上限：harness 服务（dsh web）用 chokidar 递归
    // 监视 profile 目录，上限过低会在启动一瞬间抛 ENOSPC 直接退出（issue #116）。
    // 进程无法自我调高该参数，这里只做告警（启动日志 + 读取 run logs 中的环境信息），
    // 前端据服务日志的 ENOSPC 特征给出「调高 fs.inotify.max_user_watches」的针对性提示。
    #[cfg(unix)]
    warn_if_inotify_watch_limit_low();

    // Windows：剥离历史遗留的 `dsh-win-terminal-inspector` 注入行（幂等，官方核心
    // 自 0.1.0-rc.8 起内置 inspector）。最佳努力：失败只告警，不阻断启动。
    if let Err(e) = win_inspector::apply(&app_handle) {
        log::warn!("win32 legacy patch cleanup failed: {e}");
    }
    // renderer 的 SlotOutlet 一行导出补丁（dsh-tauri-ui 设置侧边栏依赖）：只补
    // 活动核心的 dsh-client-ui-renderer lib/client.js，已含导出即跳过（幂等；核心
    // 换版本后自动重打，上游官方导出后自动退休）。最佳努力：失败只告警，不阻断
    // 启动——未打补丁时插件侧降级，官方设置 dialog 照常工作，绝不白屏。
    if let Err(e) = crate::service::patch::renderer::apply(&app_handle) {
        log::warn!("renderer SlotOutlet patch failed: {e}");
    }
    // composer 可用性：官方 ConversationRoot 对「不属于任何工作区的空白会话」把
    // composer 换成「选择工作区」触发器（`inert` 只看 chipTitle，而 chipTitle 只来自
    // 工作区），于是 dsh-tauri-ui 的「未分组」新会话无法输入。补丁放宽该判定（会话已有
    // cwd 即不算 inert）并写入 `data-dsh-composer-cwd` 能力标记；标记缺失时插件侧按
    // 退级策略禁用「未分组」入口并告警。最佳努力且幂等：锚点缺失安全跳过。
    if let Err(e) = crate::service::patch::composer::apply(&app_handle) {
        log::warn!("composer workspace-less patch failed: {e}");
    }
    if let Err(e) = crate::service::patch::mobile_composer::apply(&app_handle) {
        log::warn!("mobile composer patch failed: {e}");
    }
    // Expose an id-based SessionStore.remove facade so plugins can perform a
    // real in-memory teardown instead of leaving deleted sessions ungrouped.
    if let Err(e) = crate::service::patch::session::apply(&app_handle) {
        log::warn!("SessionStore.remove patch failed: {e}");
    }
    // OpenCode Go 需要稳定的会话 ID 头，否则返回 400 MissingSessionID；上游 pi-ai
    // 适配器把 sessionId 只透传给 SDK、不落成请求头，这里补上原生会话头，并限定到
    // OpenCode 路由（provider id 前缀或生效 baseUrl 主机为 opencode.ai），其它 provider
    // 的请求头保持不变。最佳努力且幂等：目标已含标记或锚点缺失时 patch_dsh 安全跳过。
    if let Err(e) = crate::service::patch::llm_session::apply(&app_handle) {
        log::warn!("pi-ai session header patch failed: {e}");
    }
    // Codex 系端点把思维链写在正文里（`<thinking>…</thinking>`），pi-ai 的
    // openai-completions 适配器只认识结构化推理字段，思考便混进回答正文。补丁在
    // 消息开头的围栏处把这段文本改道到 thinking 事件，harness 侧按 reasoning 块落库。
    // 最佳努力且幂等：目标已含标记或锚点缺失时 patch_dsh 安全跳过。
    if let Err(e) = crate::service::patch::pi_ai_thinking::apply(&app_handle) {
        log::warn!("pi-ai thinking-as-text patch failed: {e}");
    }
    // WKWebView 点击 `<button>` 不转移焦点：模型座位的 portal 菜单在 mousedown 阶段收到
    // `relatedTarget` 为 null 的 blur 就直接 close()，菜单在 click 之前卸载，鼠标选择
    // 模型 / 推理等级变成空操作（键盘 Enter 正常、浏览器正常）。补丁放行该 blur，菜单外的
    // 点击仍由组件自身的文档级 mousedown 处理器关闭。最佳努力且幂等：锚点缺失时安全跳过。
    if let Err(e) = crate::service::patch::model_selection::apply(&app_handle) {
        log::warn!("model selection mouse click patch failed: {e}");
    }
    // worktree 会话以隔离 cwd 执行，但产品归属仍是源 Workspace；放宽上游显式
    // attach 的 cwd 相等约束，其他 cwd 有效性校验保持不变。最佳努力且幂等。
    if let Err(e) = crate::service::patch::workspace::apply(&app_handle) {
        log::warn!("workspace worktree membership patch failed: {e}");
    }
    // 0.1.6-alpha.1 起 dsh-client-ui-workspace 的浏览视图 store 去掉了
    // `sessionUpdatedAtByAccount`（persist key 仍是 dsh.workspace.view.v5）：先跑过新核心
    // 再切回 0.1.5-rc.1 / rc.2 时，旧核心的 retainAccountKeys 会
    // Object.entries(undefined) 抛错，sidebar.workspaces 整条槽崩掉且不会自愈。
    // 补丁把该 action 的取值放宽为 `?? {}`，逐条独立判定：0.1.7 起上游第三条改成了
    // `delete`，前两条的放宽仍然生效；只有该 action 被整体改写才安全跳过。
    if let Err(e) = crate::service::patch::workspace_view::apply(&app_handle) {
        log::warn!("workspace view state patch failed: {e}");
    }
    // 内置插件（dsh-tauri-*）只在壳的插件弹窗里可见：官方侧边栏 Plugins 页与插件市场
    // 都按各自的硬编码内置/inbox 名单判断 bundle 归属，上游没有可配置开关，因此对这两个
    // 前端做幂等补丁。最佳努力且幂等：锚点缺失（上游改写布局）时安全跳过。
    if let Err(e) = crate::service::patch::plugin_visibility::apply(&app_handle) {
        log::warn!("plugin visibility patch failed: {e}");
    }
    mark_phase("core_patches", &mut phase_started);
    // 预防性处理：pnpm 在无 TTY 环境（dsh-market 等子进程）下重装/更新插件时，
    // 清理/重建 node_modules 会触发交互确认并因无 TTY 直接中止
    // （ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY），表现为插件更新失败。
    // 启动时确保 profile 的 .npmrc 写入 confirmModulesPurge=false（幂等、保留
    // 已有配置）。最佳努力：失败只告警，不阻断启动。
    if let Err(e) = crate::service::plugin::ensure_profile_npmrc(&app_handle) {
        log::warn!("ensure profile .npmrc failed: {e}");
    }
    // 弃用插件自动卸载：`manifest.jsonc` 的 `plugins.depercated` 登记的社区插件若已安装，启动时
    // 自动移除（避免残留插件继续在 profile 里加载、甚至导致启动失败）。最佳努力：
    // 失败只告警，不阻断启动。
    if let Err(e) = crate::service::plugin::uninstall_deprecated_plugins(&app_handle).await {
        log::warn!("uninstall deprecated plugins failed: {e}");
    }
    mark_phase("deprecated_plugins", &mut phase_started);
    // 内置插件自愈：随包分发的内置插件（dsh-tauri 等）必须在服务进程加载插件
    // 前就绪——核对「已安装 + 安装路径指向当前捆绑目录」，未安装、路径不正确
    // 或用户卸载后重启，一律强制重装（见 service::plugin::internal）。最佳
    // 努力：失败只告警，不阻断启动（核心功能缺失是发布缺陷，由 build:plugins 报错）。
    if let Err(e) = crate::service::plugin::ensure_internal_plugins(&app_handle).await {
        log::warn!("ensure internal plugins failed: {e}");
    }
    mark_phase("ensure_internal_plugins", &mut phase_started);
    // 预装插件完整性自检：清单引用的预装插件若在 node_modules 缺失产物，服务
    // 启动时 loader 会对每个缺失插件抛 ERR_MODULE_NOT_FOUND 而整体失败（issue
    // #90，日志特征 `Cannot find package`）。用 `pnpm install` 以现有 manifest +
    // lockfile 为准重建依赖图修复；修复失败只告警并给缺失插件记录错误标记
    // （启动失败场景由前端 recovery 对话框兜底，见 service::plugin::recovery）。
    if let Err(e) = crate::service::plugin::ensure_preset_plugins(&app_handle).await {
        log::warn!("ensure preset plugins failed: {e}");
    }
    mark_phase("ensure_preset_plugins", &mut phase_started);
    // 插件自愈（内置插件重装 / 预装插件完整性自检）可能刚把插件市场装进档案，而上一轮补丁
    // 执行时它还不存在、已被安全跳过；自愈完成后按需重打一次（逐名字判定，已登记则跳过）。
    if let Err(e) = crate::service::patch::plugin_visibility::apply(&app_handle) {
        log::warn!("plugin visibility patch after plugin self-healing failed: {e}");
    }
    // 预打包核心运行时自愈：把 app 内置插件与 profile 插件入口链接进活动核心的
    // node_modules（dsh 的 loader 以核心根为裸包解析根），并核验/修复 sharp/koffi
    // 原生可选依赖。只作用于 CoreSource::App，本地核心由用户自行管理。dsh 在缺失
    // 这些入口或原生依赖时无法启动，因此失败直接阻断本次 launch（前端展示可恢复
    // 错误），而不是带着必然失败的核心继续 spawn。
    if let Err(e) = crate::service::core::prepare_active_runtime(&app_handle).await {
        log::error!("prepare active core runtime failed: {e}");
        return Err(e);
    }
    mark_phase("prepare_active_runtime", &mut phase_started);
    // prepare 可能因核心原生模块的 ABI 与本地 node 不匹配而改用捆绑运行时
    // （issue #441），此时必须重新解析：下面的 DSH_NODE 注入与 PATH 前置都以
    // 这里的结果为准，否则子进程仍会用那个加载不了原生模块的本地 node。
    let node_binary_path = config::get_node_binary_path(&app_handle);
    if !node_binary_path.exists() {
        log::error!("Node.js runtime resolved for launch is missing");
        return Err(format!(
            "NODE_NOT_FOUND: Node.js runtime is missing: {}",
            node_binary_path.display()
        ));
    }
    let mut envs: HashMap<String, String> = HashMap::new();
    envs.insert(
        "DSH_HOME".to_string(),
        dsh_home.to_string_lossy().into_owned(),
    );
    envs.insert("DSH_TELEMETRY_DISABLED".to_string(), "1".to_string());
    envs.insert("NO_COLOR".to_string(), "1".to_string());
    envs.insert("DSH_WEB_PORT".to_string(), setting.port.to_string());
    // 把服务实际使用的 node 路径显式交给子进程（pnpm/dsh shim 的 DSH_NODE
    // 优先）：市场（dsh-market）等子进程经 PATH 解析 node 可能与桌面端预检
    // 不一致（相对 PATH 条目 / junction / 子进程 PATH 布局差异），导致 pnpm
    // shim 报 "Node.js runtime not found"（issue #121，与 build_plugin_envs
    // 的注入保持一致）。先规范化为绝对路径：相对路径在子进程 CWD 下会解析
    // 到错误位置；已存在（上面校验过）的 node 可安全 canonicalize。用
    // dunce::canonicalize 而不是 std::fs::canonicalize：后者在 Windows 上会
    // 返回 `\\?\` verbatim 前缀，cmd.exe 无法直接启动这种路径，导致 pnpm/dsh
    // shim 报 "The system cannot find the path specified."。
    let node_abs =
        dunce::canonicalize(&node_binary_path).unwrap_or_else(|_| node_binary_path.clone());
    envs.insert(
        "DSH_NODE".to_string(),
        node_abs.to_string_lossy().into_owned(),
    );

    // 扩展 PATH，让 dsh 及其子进程能找到 node 与桌面端自动配置的 Git；Windows
    // 上再注入 Git Bash 的 bin 目录：persistent bash（--noprofile --norc）不执行
    // profile 脚本、PATH
    // 完全继承服务进程，若不含 Git 的 usr/bin，ls/sed/find 等 coreutils 全会
    // `command not found`（MSYS 运行时在部分环境下不会自动补 /usr/bin）。
    // 前置应用自身的 shim 目录，使市场（dsh-market）及其子进程通过名字解析的
    // `pnpm`/`dsh` 都命中桌面端 shim，从而受桌面端 pnpm 选版策略管辖
    // （轻量缓解，issue #69 系列）。
    if let Some(node_dir) = node_binary_path.parent() {
        if let Some(existing_path) = std::env::var_os("PATH") {
            let git_dirs = win_inspector::git_bash_bin_dirs();
            // 只打印注入的前缀目录，完整 PATH 太长会刷屏
            for dir in &git_dirs {
                log::debug!("harness service PATH prepend: {}", dir.to_string_lossy());
            }
            let mut paths = vec![crate::service::cli::get_bin_dir(&app_handle)];
            paths.push(node_dir.to_path_buf());
            if let Some(git_dir) = config::get_git_cmd_dir(&app_handle) {
                log::debug!(
                    "harness service Git PATH prepend: {}",
                    git_dir.to_string_lossy()
                );
                paths.push(git_dir);
            }
            paths.extend(git_dirs);
            paths.extend(std::env::split_paths(&existing_path));
            if let Ok(new_path) = std::env::join_paths(paths) {
                envs.insert("PATH".to_string(), new_path.to_string_lossy().into_owned());
            }
        }
    }

    // GUI 进程可能启动在 pnpm 安装之前，继承的 PATH 因而没有 npm 全局目录。
    // 直接注入探测到的绝对路径，避免 dsh-market 的 pnpm --version 落到自身 shim
    // 后又因 PATH 看不到真正的 pnpm（issue #139）。
    if let Some(user_pnpm) = crate::service::cli::find_user_pnpm(&app_handle) {
        // Unix mise shim 依赖调用路径中的 argv[0]；只做字面绝对化，不能解析
        // `pnpm -> mise` 链接。Windows 仍由同一辅助函数处理连接点与 `\\?\`。
        if let Some(pnpm_value) = crate::service::cli::pnpm_env_value(
            &user_pnpm,
            &crate::service::cli::get_bin_dir(&app_handle),
        ) {
            envs.insert("DSH_PNPM".to_string(), pnpm_value);
        }
    }

    // 让市场子进程的 pnpm 与桌面端同一套受控策略（store 主版本感知、避免落到系统
    // homebrew pnpm）。与插件安装路径的 ensure_pnpm 版本感知一致，但启动阶段绝不
    // 触发下载；捆绑版未安装或与 store 不匹配时不注入（交由用户 pnpm）。
    // 最佳努力：失败只告警，不阻断启动。
    if crate::service::plugin::harness_prefer_bundled_pnpm(&app_handle) {
        envs.insert("DSH_PREFER_BUNDLED_PNPM".to_string(), "1".to_string());
    }

    // 内嵌 WebView 是 `tauri.localhost` 下的跨源沙箱 iframe，`SameSite=Strict` 的
    // browser-session Cookie 不会被携带。载体标记交给 dsh-tauri 插件（载体鉴权适配）：
    // 只有该标记在场时它才覆写 connection 的鉴权闸门，因此同一 profile 下独立运行
    // 的 `dsh web` 不受影响（取代原先对核心 JS 打的 `--skip-auth` 磁盘补丁）。
    envs.insert("DSH_TAURI_EMBEDDED".to_string(), "1".to_string());

    // 日志文件（前端日志面板读取）。
    // 每次真实启动前轮转：只保留最近 3 次启动的日志，旧文件后退为
    // `dsh-web.log.1` / `dsh-web.log.2`，避免单文件随多次启动无限增长。
    let log_path = config::get_service_log_path(&app_handle);
    fs::create_dir_all(log_path.parent().unwrap_or(std::path::Path::new(".")))
        .map_err(|e| format!("LOG_DIR_MKDIR_FAILED: create log dir failed: {e}"))?;
    rotate_service_log(&log_path, 3);

    // `dsh web` 默认在系统浏览器打开 UI；桌面端内嵌 WebView，不需要浏览器，
    // 追加 `--no-open` 关闭。该标志自 0.1.0-rc.8 起提供，全部受支持核心（≥
    // 0.1.5-rc.1）均已具备，无需按版本判定。

    // 补丁层悬空 insert 预检：手写的 `insert` 条目在包被卸载（市场会拒绝卸载
    // 「仍被用户补丁引用」的插件，用户于是改走手工删依赖 / pnpm remove）或本地
    // `link:` 源被删后仍留在补丁层里，loader 会在 import 时抛 ERR_MODULE_NOT_FOUND，
    // 让整棵插件树加载失败——应用彻底起不来，用户只看到一坨 Node 堆栈。上游契约
    // 是「补丁文件存在却应用不了就大声失败」，这里不改变契约，只把同一结果提前成
    // 一条可操作的错误（哪个文件、哪一行、哪个包），错误页据此给出「移除悬空条目」
    // 的一键恢复。必须在所有插件自愈之后：那些步骤会改变安装状态。
    if let Err(e) = crate::service::plugin::preflight_active_patch_entries(&app_handle) {
        log::error!("patch layer entry preflight failed: {e}");
        return Err(e);
    }
    mark_phase("patch_entry_preflight", &mut phase_started);

    let node_options = std::env::var("NODE_OPTIONS").ok();
    let heap_mb = super::heap::resolve_heap_limit_mb(
        setting.harness_max_heap_mb,
        node_options.as_deref(),
        super::heap::physical_memory_mb(),
    );
    match heap_mb {
        Some(mb) => log::info!("Starting Harness process with --max-old-space-size={mb}"),
        None => log::info!("Starting Harness process with Node default or inherited heap options"),
    }

    // dsh 的 Loader 在插件 dispose 时会把组合后的整棵 entry 树回写进
    // `cordis.yml`（dsh-app-boot：plugin self-disposing persists the current
    // tree）。上一轮被杀/崩溃的 dsh 若在「新进程 prepareProfile 重置之后、
    // Include 读取之前」完成回写，新 boot 会读到已含 bundle 组合行的文件，
    // 再叠加同一批 patch → duplicate loader entry（本会话实测特征
    // `duplicate loader entry id: dsh-tauri-worktree`）。spawn 前最后一刻重置
    // profile 根关闭常见窗口；回写恰好落在探测窗口内的残余竞态由下方
    // Windows 分支的「早期退出重试」兜底。
    reset_active_profile_root(&app_handle);

    // 本地插件热重载：把已挂载的本地路径插件源码目录折算成桌面端独占的补丁层，
    // 随启动以 `--patch` 注入核心 HMR（本地插件没有版本号可升级，改源码即时生效）。
    // 该层只在本次进程有效，每次启动都要按当前安装状态重算；没有本地插件时不传
    // `--patch`（指向不存在的文件会让核心在读取补丁层时直接失败）。
    let hmr_patch = crate::service::plugin::local_plugin_hmr_sync(&app_handle);
    if let Some(path) = hmr_patch.as_deref() {
        log::info!("Injecting local plugin HMR layer: {}", path.display());
    }

    // Windows 打包版是 GUI 进程（没有控制台）。直接以 CREATE_NO_WINDOW 启动
    // node 会让 dsh 派生的子进程各自新建可见控制台窗口（频繁闪烁 cmd 黑窗），
    // 因此 Windows 上改用“隐藏控制台”方式启动，见 win_spawn 模块。
    let active_profile = crate::service::profile::active_profile(&app_handle);
    let app_core_dir = config::get_dsh_install_path(&app_handle);
    let core_dir = if dsh_binary_path == config::get_dsh_binary_path(&app_handle) {
        app_core_dir
    } else {
        dsh_binary_path
            .parent()
            .and_then(std::path::Path::parent)
            .map(std::path::Path::to_path_buf)
            .unwrap_or(app_core_dir)
    };
    mark_phase("pre_spawn_setup", &mut phase_started);
    super::startup::note_spawn();
    let spawn_result: SpawnResult = {
        #[cfg(windows)]
        {
            use std::io::{BufReader, Read};
            use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_TIMEOUT};
            use windows_sys::Win32::System::Threading::{
                GetExitCodeProcess, WaitForSingleObject, INFINITE,
            };

            let args = build_harness_args(
                &dsh_binary_path,
                active_profile.as_str(),
                hmr_patch.as_deref(),
                setting.port,
                heap_mb,
            );

            // 只负责 spawn 并返回管道/PID/句柄：探测与重试期间不登记、不挂
            // 监视线程——只有最终采用的那个进程才登记，否则旧监视线程会通过
            // `on_owned_process_exit` 把刚启动的新进程误当作已退出而回落状态。
            let spawn_harness =
                || -> std::io::Result<(std::fs::File, std::fs::File, u32, HANDLE)> {
                    super::win_spawn::spawn_with_hidden_console_owned(
                        &node_binary_path,
                        &args,
                        Some(&core_dir),
                        &envs,
                    )
                };

            // 早期退出重试：崩溃的上一轮 dsh 回写 `cordis.yml` 落在「新进程
            // prepareProfile 重置之后、Include 读取之前」时，新 boot 会把已含
            // bundle 组合行的 root 再叠加同一批 patch → `duplicate loader
            // entry`（实测 exit code 1）。spawn 前重置只覆盖常见窗口，这里在
            // spawn 后探测 ≤2.5s：命中签名则丢弃实例、重置 profile 根并重试
            //（最多 3 次，第二次 boot 基于干净状态必然成功）；仍在运行则视为
            // 健康立即放行登记。探测期间最长阻塞 2.5s，之后才返回给调用方。
            let mut attempt = 0u32;
            let mut outcome = spawn_harness();
            loop {
                attempt += 1;
                let (stdout, stderr, pid, handle) = match outcome {
                    Ok(spawned) => spawned,
                    Err(error) => {
                        // spawn 自身失败（非竞态）：保持 Err 交给下方 map 传播
                        outcome = Err(error);
                        break;
                    }
                };
                let wait = unsafe { WaitForSingleObject(handle, 2500) };
                if wait == WAIT_TIMEOUT {
                    // 健康：进程仍在运行，交给下方登记 + 监视线程。
                    outcome = Ok((stdout, stderr, pid, handle));
                    break;
                }
                // 已提前退出：读 stderr 判断是否命中竞态签名。
                let mut exit_code: u32 = 0;
                let got_exit_code = unsafe { GetExitCodeProcess(handle, &mut exit_code) } != 0;
                let mut stderr_text = String::new();
                let mut stderr_reader = BufReader::new(stderr);
                let _ = Read::read_to_string(&mut stderr_reader, &mut stderr_text);
                let hit_duplicate =
                    got_exit_code && is_duplicate_loader_exit(exit_code, &stderr_text);
                if hit_duplicate && attempt < 3 {
                    // 丢弃首个失败实例：从未登记，句柄由本分支关闭（此时没有
                    // 监视线程，不存在重复 close）。
                    drop(stdout);
                    unsafe { CloseHandle(handle) };
                    log::warn!(
                        "DUPLICATE_LOADER_ENTRY: dsh exited early with duplicate loader entry \
                         (pid={pid}, code={exit_code}); resetting profile root and relaunching \
                         (attempt {attempt}/3)"
                    );
                    reset_active_profile_root(&app_handle);
                    outcome = spawn_harness();
                    continue;
                }
                // 非签名提前退出或重试耗尽：走正常路径——已捕获的 stderr 补写
                // 日志避免失败原因丢失，句柄保持有效交给监视线程等待并关闭。
                for line in stderr_text.lines() {
                    log::warn!(target: "dsh", "{}", line);
                }
                outcome = Ok((stdout, stderr_reader.into_inner(), pid, handle));
                break;
            }

            outcome.map(|(stdout, stderr, pid, handle)| {
                // PID 与句柄作为整体一次登记，与退出清理（take 一并取出）配对
                let handle_value = handle as usize;
                set_owned_process_with_handle(pid, handle_value);
                let exit_app_handle = app_handle.clone();
                std::thread::spawn(move || unsafe {
                    let process_handle = handle_value as HANDLE;
                    WaitForSingleObject(process_handle, INFINITE);
                    // 进程确已退出：清空持有 PID 并把 Status 从 Running 回落为
                    // Stopped（原有实现只清 PID、状态永远停留在 Running）。
                    // 仅当该 PID 仍是当前登记才取出——旧监视线程不会误清新进程。
                    // take 返回值里的句柄由本线程负责关闭（不会与
                    // terminate_owned_process 重复 close——进程已 exit，
                    // 通常是本线程取走）。
                    let owned = on_owned_process_exit(&exit_app_handle, pid, |owned| {
                        let handle = owned.handle as HANDLE;
                        let mut exit_code: u32 = 0;
                        (GetExitCodeProcess(handle, &mut exit_code) != 0)
                            .then_some(i64::from(exit_code))
                    });
                    if let Some(owned) = owned {
                        let h = owned.handle as HANDLE;
                        CloseHandle(h);
                    }
                });
                (Some(stdout), Some(stderr), pid)
            })
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::process::CommandExt;
            let mut cmd = Command::new(&node_binary_path);
            cmd.args(build_harness_args(
                &dsh_binary_path,
                active_profile.as_str(),
                hmr_patch.as_deref(),
                setting.port,
                heap_mb,
            ));
            cmd.envs(&envs)
                .current_dir(&core_dir)
                // 核心修正：提供一个空的 stdin 防止 setRawMode 报错
                .stdin(Stdio::null())
                // 使用管道捕获输出，以便在子线程中读取
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                // 独立进程组让停止操作只影响 Harness 及其后代。
                .process_group(0);
            let mut attempt = 0u32;
            let mut child = 'attempts: loop {
                attempt += 1;
                match cmd.spawn() {
                    Ok(mut child) => {
                        let deadline =
                            std::time::Instant::now() + std::time::Duration::from_millis(2500);
                        loop {
                            match child.try_wait() {
                                Ok(Some(exit)) => {
                                    let mut stderr_text = String::new();
                                    if let Some(mut stderr) = child.stderr.take() {
                                        let _ = stderr.read_to_string(&mut stderr_text);
                                    }
                                    if exit.code() == Some(1)
                                        && stderr_text.contains("duplicate loader entry")
                                        && attempt < 3
                                    {
                                        log::warn!(
                                            "DUPLICATE_LOADER_ENTRY: dsh exited early with duplicate loader entry \
                                             (pid={}, code=1); resetting profile root and relaunching \
                                             (attempt {attempt}/3)",
                                            child.id()
                                        );
                                        reset_active_profile_root(&app_handle);
                                        cmd = Command::new(&node_binary_path);
                                        cmd.args(build_harness_args(
                                            &dsh_binary_path,
                                            active_profile.as_str(),
                                            hmr_patch.as_deref(),
                                            setting.port,
                                            heap_mb,
                                        ));
                                        cmd.envs(&envs)
                                            .current_dir(&core_dir)
                                            .stdin(Stdio::null())
                                            .stdout(Stdio::piped())
                                            .stderr(Stdio::piped())
                                            .process_group(0);
                                        continue 'attempts;
                                    }
                                    for line in stderr_text.lines() {
                                        log::warn!(target: "dsh", "{}", line);
                                    }
                                    return Err(format!("Harness exited early: {exit}"));
                                }
                                Ok(None) if std::time::Instant::now() >= deadline => break,
                                Ok(None) => {
                                    std::thread::sleep(std::time::Duration::from_millis(50))
                                }
                                Err(error) => return Err(error.to_string()),
                            }
                        }
                        break child;
                    }
                    Err(error) => return Err(error.to_string()),
                }
            };
            let pid = child.id();
            let stdout = child.stdout.take();
            let stderr = child.stderr.take();
            set_owned_process(pid);
            let exit_app_handle = app_handle.clone();
            std::thread::spawn(move || {
                let code = child.wait().ok().and_then(|status| status.code());
                let _ = on_owned_process_exit(&exit_app_handle, pid, |_| code.map(i64::from));
            });
            Ok((stdout, stderr, pid))
        }
    };

    // 这一段包含 spawn、2.5s 存活探测与 `set_owned_process` 登记——登记写在 spawn 块
    // 内部，无法单独切分，所以不再为「登记」另打一个只量到一行 log 的点。
    mark_phase("spawn_probe_and_register", &mut phase_started);

    match spawn_result {
        Ok((stdout, stderr, pid)) => {
            log::info!(
                "Harness process started successfully: pid={pid}, port={}",
                setting.port
            );
            // 记录 PID+端口供下次启动清扫崩溃残留的孤儿实例（见 sweep_orphan_harness）
            persist_harness_pid(&app_handle, pid, setting.port);
            spawn_output_readers(stdout, stderr, log_path);
            Ok(())
        }
        Err(e) => {
            log::error!("Failed to start process: {}", e);
            Err(format!("PROCESS_START_FAILED: {e}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn occupied_port_advances_to_a_free_port() {
        let mut checked = Vec::new();
        let selected = find_available_port_by(3080, |port| {
            checked.push(port);
            port < 3082
        })
        .expect("find next free port");

        assert_eq!(selected, 3082);
        assert_eq!(checked, vec![3080, 3081, 3082]);
    }

    #[test]
    fn occupied_port_reports_exhaustion_at_max_port() {
        let error = find_available_port_by(u16::MAX, |_| true).expect_err("port exhaustion");
        assert!(error.starts_with("PORT_EXHAUSTED:"));
    }

    fn text_args(args: &[OsString]) -> Vec<String> {
        args.iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    /// `--patch` 必须排在子命令参数之前：`dsh` 的选项收集器在遇到第一个非选项
    /// 参数（内层应用名）之后会把剩余参数整段透传，排在其后的 `--patch` 会被内层
    /// 应用判为未知选项并立刻退出（实测）。
    #[test]
    fn patch_layer_argument_precedes_the_port_flags() {
        let patch = Path::new("D:/app-data/cordis.hmr.patch.yml");
        let args = build_harness_args(
            Path::new("D:/core/lib/bin.js"),
            "tauri",
            Some(patch),
            3080,
            None,
        );
        assert_eq!(
            text_args(&args),
            vec![
                "D:/core/lib/bin.js".to_string(),
                "--profile".to_string(),
                "tauri".to_string(),
                "--patch".to_string(),
                "D:/app-data/cordis.hmr.patch.yml".to_string(),
                "--port".to_string(),
                "3080".to_string(),
                "--no-open".to_string(),
            ]
        );
    }

    #[test]
    fn heap_option_stays_ahead_of_the_script_path() {
        let args = build_harness_args(
            Path::new("D:/core/lib/bin.js"),
            "tauri",
            None,
            3081,
            Some(4096),
        );
        let text = text_args(&args);
        assert_eq!(text[0], "--max-old-space-size=4096");
        assert_eq!(text[1], "D:/core/lib/bin.js");
        assert!(!text.contains(&"--patch".to_string()));
    }

    /// 模拟“上个会话残留进程刚被杀、端口仍在释放”的场景：先占用端口，随后在
    /// 另一线程释放。验证 `wait_for_port_release` 在端口回落后立即返回，而不是
    /// 等到完整等待窗口——这正是避免端口永久顶高（dev 热更新下 3081→3082→…）
    /// 的关键行为。
    #[tokio::test]
    async fn wait_for_port_release_returns_shortly_after_port_is_released() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind held test port");
        let held = listener.local_addr().expect("read held port").port();

        // 端口此刻确实被占用（模拟残留进程仍在监听）
        assert!(is_port_in_use(held));
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(150));
            drop(listener);
        });

        let started = std::time::Instant::now();
        wait_for_port_release(held).await;
        // 端口 150ms 后释放 + 80ms 轮询间隔，应远小于 1.5s 等待上限
        assert!(
            started.elapsed() < std::time::Duration::from_millis(800),
            "wait_for_port_release should return shortly after the port is released, not wait the full window"
        );
        releaser.join().expect("port releaser thread");
    }

    /// 「duplicate loader entry」竞态签名的判定：只认 exit code 1 + stderr 含
    /// 该文本（实测失败日志：
    /// `Error: dsh: plugin tree failed to load: failed to apply loader entry
    /// include (cordis:include): duplicate loader entry id: dsh-tauri-worktree`）。
    #[cfg(windows)]
    #[test]
    fn duplicate_loader_exit_signature_matches_observed_error() {
        let stderr = "Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): duplicate loader entry id: dsh-tauri-worktree\nTypeError: duplicate loader entry id: dsh-tauri-worktree\n    at EntryGroup.update (...)";
        assert!(is_duplicate_loader_exit(1, stderr));
        // 其他退出码、无关错误或没有该文本的启动失败不命中
        assert!(!is_duplicate_loader_exit(0, stderr));
        assert!(!is_duplicate_loader_exit(2, stderr));
        assert!(!is_duplicate_loader_exit(
            1,
            "Error: EADDRINUSE: address already in use"
        ));
        assert!(!is_duplicate_loader_exit(1, ""));
    }

    /// 端口自愈（issue #91）：自动避让递增遗留的非默认端口，在回落目标空闲时
    /// 回落到目标（默认端口或用户手动端口），回落目标被占时维持当前端口。
    #[test]
    fn heal_port_returns_target_when_free() {
        // 自动递增遗留 3084，默认 3080 空闲 → 回落默认端口
        assert_eq!(resolve_heal_port(3084, 3080, true), 3080);
        // 用户手动 9090 空闲 → 回落用户值
        assert_eq!(resolve_heal_port(9091, 9090, true), 9090);
    }

    #[test]
    fn heal_port_keeps_current_when_target_busy_or_aligned() {
        // 回落目标被占 → 维持当前端口（留给 find_available_port 逐级递增）
        assert_eq!(resolve_heal_port(3084, 3080, false), 3084);
        // 当前端口即回落目标（已是最优）→ 不变
        assert_eq!(resolve_heal_port(3080, 3080, true), 3080);
        assert_eq!(resolve_heal_port(3080, 3080, false), 3080);
    }
}
