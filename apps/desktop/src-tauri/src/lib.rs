pub type AppHandle<R = tauri_runtime_electron::ElectronRuntime> = tauri::AppHandle<R>;
pub type WebviewWindow<R = tauri_runtime_electron::ElectronRuntime> = tauri::WebviewWindow<R>;
pub type Webview<R = tauri_runtime_electron::ElectronRuntime> = tauri::Webview<R>;
pub type Window<R = tauri_runtime_electron::ElectronRuntime> = tauri::Window<R>;

mod bridge;
mod config;
pub mod desktop;
mod logger;
mod service;
mod utils;

fn application_context() -> tauri::Context<tauri_runtime_electron::ElectronRuntime> {
    tauri::generate_context!()
}

/// 对显式给定的核心安装目录施加全套 dsh 补丁（`--patch-core <dir>` 的入口）。
///
/// E2E 的插件 L2 直接起 `dsh web`，不经过桌面端启动路径；没有这一步，被测核心就缺少
/// 桌面端运行时会打上的补丁（鉴权、渲染器、会话、工作区等），断言的前提不成立。
/// 因此把补丁集暴露成一个不带 GUI 的入口，让编排复用同一份 Rust 实现，而不是另抄一份。
pub fn patch_core_dir(core_dir: &std::path::Path) -> Result<(), String> {
    service::patch::apply_all_at(core_dir)
}

/// 声明 Windows 任务栏身份，让固定项重启本应用而不是内嵌的 Electron 运行时。
///
/// 图钉由 Windows 按窗口所属进程创建：壳窗口的属主是内嵌运行时进程，缺 relaunch
/// 命令时只能「裸 exe + 空参数」重启，于是打开 Electron 自带的默认欢迎页（用户
/// 看到的 `path-to-app`）。这里补上安装器写进快捷方式的同一 AUMID，并把重启命令
/// 指回主程序，图钉与开始菜单因此指向同一个入口。
#[cfg(windows)]
fn declare_taskbar_identity(context: &tauri::Context<tauri_runtime_electron::ElectronRuntime>) {
    let identifier = context.config().identifier.clone();
    let display_name = context
        .config()
        .product_name
        .clone()
        .unwrap_or_else(|| identifier.clone());
    let Ok(executable) = std::env::current_exe() else {
        log::warn!("TASKBAR_IDENTITY_FAILED: current executable unavailable");
        return;
    };
    let executable = executable.to_string_lossy();
    tauri_runtime_electron::set_app_details(
        identifier,
        format!("\"{executable}\""),
        display_name,
    );
}

pub fn run() -> Result<(), String> {
    let started = std::time::Instant::now();
    #[cfg(unix)]
    if let Err(error) = std::env::current_exe()
        .map_err(|error| error.to_string())
        .and_then(|executable| desktop::login_path::restore(&executable))
    {
        eprintln!("STARTUP_PATH_RESTORE_FAILED: {error}");
    }
    desktop::startup::verify()?;
    #[cfg(target_os = "linux")]
    desktop::startup::prepare_force_xwayland();
    #[cfg(target_os = "linux")]
    config::proxy::prepare_inherited_proxy();
    // 初始化日志系统
    logger::init();
    log::info!(
        "STARTUP_BOOT: name=logger_ready elapsed_ms={}",
        started.elapsed().as_millis()
    );
    // 把持久化的 DSH_HOME 补回进程环境（issue #871、#1195）。必须在桌面端装配之前，
    // 否则首次 get_dsh_data_path 会落到默认目录，日志、store 与 shim 全部写错位置。
    service::data_dir::restore_process_env();

    let mut context = application_context();
    if let Some(directory) = config::e2e_app_data_dir()? {
        context.config_mut().app.app_directories_override = Some(
            tauri::utils::config::AppDirectoriesOverride::Root(directory),
        );
    }
    log::info!(
        "STARTUP_BOOT: name=context_ready elapsed_ms={}",
        started.elapsed().as_millis()
    );
    #[cfg(all(windows, not(debug_assertions)))]
    let single_instance = match desktop::single_instance::claim(&context.config().identifier)? {
        Some(instance) => std::sync::Arc::new(instance),
        None => return Ok(()),
    };
    // 任务栏固定项按窗口所属进程创建：壳窗口跑在内嵌 Electron 运行时进程里，
    // 没有 relaunch 命令时 Windows 只能裸启动该 exe，落到 Electron 默认页而不是
    // 本应用（0.30 用户的「升级后打不开」即此）。显式声明与安装器一致的 AUMID，
    // 并让重启目标回到主程序。
    #[cfg(windows)]
    declare_taskbar_identity(&context);
    desktop::builder()
        .invoke_handler(desktop::handler())
        .build(context)
        .map_err(|error| format!("STARTUP_FAILED: {error}"))?
        .run(move |app_handle, event| match event {
            tauri::RunEvent::Ready => {
                #[cfg(all(windows, not(debug_assertions)))]
                if let Err(error) = single_instance.attach(app_handle) {
                    log::error!("SINGLE_INSTANCE_ATTACH_FAILED: {error}");
                    app_handle.exit(1);
                }
            }
            // macOS：关闭按钮只是隐藏窗口（见 builder 的 on_window_event），
            // 点击 Dock 图标时系统回调 applicationShouldHandleReopen 触发
            // RunEvent::Reopen，这里重新显示主窗口，否则窗口会一直隐藏在托盘。
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                crate::utils::show_main_window(&app_handle);
            }
            // 正常退出请求发生在窗口销毁之前；此时主动保存一次主窗口几何，
            // 避免 Windows 最后一个移动/缩放事件尚未写入就退出而丢失尺寸。
            tauri::RunEvent::ExitRequested { .. } => {
                config::save_main_window_geometry(app_handle);
                // 桌宠位置同一策略：事件里只暂存，退出时写一次（见 desktop::pet）。
                desktop::pet::flush_pet_window_position(app_handle);
            }
            // 退出时回收 Harness 进程：不回收的话，node 进程会在应用退出后
            // 残留并把原生模块 DLL（如 sharp 的 libvips-42.dll）锁在内存，
            // 下次启动重新解压时会失败（Windows os error 32）
            tauri::RunEvent::Exit => {
                // 进行中的插件安装子进程是独立进程组，父进程退出不会连带回收；
                // 不显式结束就会留下占着档案 / pnpm store 的孤儿，让下一次启动
                // 永久卡在安装阶段（且日志无任何输出）。必须先于其它收尾动作。
                service::plugin::terminate_active_installs_blocking();
                let setting = config::get_store_dat_setting(app_handle);
                if setting.installed {
                    service::workflow::stop_on_exit(app_handle);
                }
                // 已下载但用户没在应用内安装过更新 → 退出后自动打开安装器：
                // 静默下载不打扰用户，代价是用户可能一直不主动升级，这里补上
                // 「关闭应用即升级」这一步（安装器由系统默认处理器启动）。
                // 必须在回收 Harness 之后：安装器交付前要先释放配置端口
                //（见 workflow::stop_for_installer）。
                service::update::launch_pending_installer(app_handle);
            }
            _ => {}
        });
    Ok(())
}


#[cfg(target_os = "linux")]
pub(crate) fn shell_window_opaque() -> bool {
    std::env::var_os("DSH_OPAQUE_WINDOW").is_some()
}

pub(crate) fn pet_overlay_supported_env() -> bool {
    #[cfg(target_os = "linux")]
    {
        return desktop::startup::pet_overlay_supported(
            std::env::var_os("WAYLAND_DISPLAY").is_some(),
            &std::env::var("TAURI_RUNTIME_ELECTRON_ARGS").unwrap_or_default(),
        );
    }
    #[cfg(not(target_os = "linux"))]
    true
}
