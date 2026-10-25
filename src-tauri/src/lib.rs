mod bridge;
mod config;
pub mod desktop;
mod logger;
mod service;
mod utils;

#[cfg(target_os = "macos")]
use tauri::Manager;

/// 对显式给定的核心安装目录施加全套 dsh 补丁（`--patch-core <dir>` 的入口）。
///
/// E2E 的插件 L2 直接起 `dsh web`，不经过桌面端启动路径；没有这一步，被测核心就缺少
/// 桌面端运行时会打上的补丁（鉴权、渲染器、会话、工作区等），断言的前提不成立。
/// 因此把补丁集暴露成一个不带 GUI 的入口，让编排复用同一份 Rust 实现，而不是另抄一份。
pub fn patch_core_dir(core_dir: &std::path::Path) -> Result<(), String> {
    service::patch::apply_all_at(core_dir)
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
    config::proxy::prepare_inherited_proxy();
    // Wayland EGL workaround：仅 AppImage 需要（见 `should_apply_wayland_egl_workaround`）。
    if should_apply_wayland_egl_workaround(
        &std::env::var("XDG_SESSION_TYPE").unwrap_or_default(),
        std::env::var_os("APPIMAGE").is_some(),
    ) {
        // 与 README 文档一致地同时关闭 compositing 与 DMABUF renderer：只关前者在部分
        // 发行版/驱动上仍会 SIGSEGV（issue #116 的 WebKitGTK 崩溃）。两个参数互相独立，
        // 用户已手动设置其中一个时只补齐另一个。
        let mut applied = Vec::new();
        if std::env::var("WEBKIT_DISABLE_COMPOSITING_MODE").is_err() {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
            applied.push("WEBKIT_DISABLE_COMPOSITING_MODE");
        }
        if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            applied.push("WEBKIT_DISABLE_DMABUF_RENDERER");
        }
        if !applied.is_empty() {
            // 此处在 logger::init() 之前执行，log 宏尚无 subscriber，用 eprintln 输出
            eprintln!("[wayland] set {} for WebKitGTK EGL", applied.join(" "));
        }
    }
    // 强制 XWayland（默认关闭的设置项，见 `should_force_xwayland`）。必须在此处执行：
    // GDK 只在初始化时读一次 GDK_BACKEND，建窗之后再改无效。
    let force_xwayland =
        config::force_xwayland_setting() || std::env::var_os("DSH_FORCE_XWAYLAND").is_some();
    if should_force_xwayland(
        force_xwayland,
        &std::env::var("WAYLAND_DISPLAY").unwrap_or_default(),
        &std::env::var("GDK_BACKEND").unwrap_or_default(),
        &std::env::var("DISPLAY").unwrap_or_default(),
    ) {
        std::env::set_var("GDK_BACKEND", "x11");
        // 同上，logger::init() 尚未执行，只能用 eprintln
        eprintln!("[wayland] set GDK_BACKEND=x11 so the pet window can stay on top (issue #649)");
    }
    // NVIDIA 驱动 + Wayland：只关 DMABUF renderer（见 `should_disable_dmabuf_renderer`）。
    // 必须在上面强制 XWayland 之后判定，否则会把已经切到 x11 的用户也算进来。
    if should_disable_dmabuf_renderer(
        &std::env::var("WAYLAND_DISPLAY").unwrap_or_default(),
        &std::env::var("WAYLAND_SOCKET").unwrap_or_default(),
        &std::env::var("GDK_BACKEND").unwrap_or_default(),
        nvidia_driver_loaded(),
    ) && std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err()
    {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        // 同上，logger::init() 尚未执行，只能用 eprintln
        eprintln!("[wayland] set WEBKIT_DISABLE_DMABUF_RENDERER for NVIDIA on Wayland (issue #1234)");
    }
    // 初始化日志系统
    logger::init();
    log::info!(
        "STARTUP_BOOT: name=logger_ready elapsed_ms={}",
        started.elapsed().as_millis()
    );
    // 把持久化的 DSH_HOME 补回进程环境（issue #871、#1195）。必须在桌面端装配之前，
    // 否则首次 get_dsh_data_path 会落到默认目录，日志、store 与 shim 全部写错位置。
    service::data_dir::restore_process_env();

    let mut context = tauri::generate_context!();
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
    let startup = service::workflow::early::Startup::begin(
        &context,
        #[cfg(all(windows, not(debug_assertions)))]
        single_instance.clone(),
    );
    desktop::builder()
        .invoke_handler(desktop::handler())
        .build(context)
        .map_err(|error| format!("STARTUP_FAILED: {error}"))?
        .run(move |app_handle, event| match event {
            tauri::RunEvent::Ready => {
                startup.attach(app_handle);
                #[cfg(all(windows, not(debug_assertions)))]
                if let Err(error) = single_instance.attach(app_handle) {
                    log::error!("SINGLE_INSTANCE_ATTACH_FAILED: {error}");
                    app_handle.exit(1);
                }
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::WindowEvent { event, .. } => {
                desktop::builder::on_macos_titlebar_event(&event);
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::MainEventsCleared => {
                desktop::builder::sync_macos_titlebars(|| {
                    app_handle.webview_windows().into_values()
                });
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
            }
            // 退出时回收 Harness 进程：不回收的话，node 进程会在应用退出后
            // 残留并把原生模块 DLL（如 sharp 的 libvips-42.dll）锁在内存，
            // 下次启动重新解压时会失败（Windows os error 32）
            tauri::RunEvent::Exit => {
                startup.shutdown();
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

/// Wayland EGL workaround 是否生效：仅 AppImage 需要。
///
/// AppImage 自带旧 WebKitGTK，打包库与宿主 Wayland 合成器 EGL 不兼容
/// （"Could not create default EGL display: EGL_BAD_PARAMETER"，PikaOS/GNOME
/// Wayland、Ubuntu 22.04+），必须关闭合成与 DMABUF renderer 才能建窗。
/// 宿主安装包（deb/rpm/…）用系统 WebKit，可正常创建 EGL 显示；且强制关闭合成
/// 会破坏透明窗口（桌宠）与视频渲染，因此非 AppImage 运行时不再强制。
/// AppImage 运行时必带 `APPIMAGE` 环境变量（runtime 规范），以此判定打包形态。
fn should_apply_wayland_egl_workaround(session_type: &str, appimage_present: bool) -> bool {
    session_type == "wayland" && appimage_present
}

/// NVIDIA 驱动在 Wayland 下是否要关掉 WebKitGTK 的 DMABUF renderer。
///
/// WebKitGTK 2.52 的 DMABUF 渲染通路在 NVIDIA 驱动 + 原生 Wayland 上会整窗停绘，
/// 随后进程 SIGSEGV（issue #1234：关掉设置浮层时崩溃，且栈已不可回溯）。这里只关
/// DMABUF、保留合成：与 AppImage 那条兜底不同，连合成一起关会打掉透明桌宠窗口与
/// 视频渲染。
///
/// 判定偏「宁可多关」：只有确认跑不到 Wayland 时才放过——没有 `WAYLAND_DISPLAY`
/// 也没有继承来的 `WAYLAND_SOCKET`（沙箱/portal 交接时只有后者），或 `GDK_BACKEND`
/// 恰好只写 `x11`（无回落后备）。`x11,wayland` 这类列表不算，X11 打不开时 GTK 会
/// 顺延到 Wayland，否则就会漏掉真正会崩的那种组合。代价是显式写列表的用户白关一次
/// DMABUF，丢一点渲染性能，不会崩。
///
/// 纯函数、不读环境，三条 CI 腿都能跑单测；驱动探测在 `nvidia_driver_loaded`。
pub(crate) fn should_disable_dmabuf_renderer(
    wayland_display: &str,
    wayland_socket: &str,
    gdk_backend: &str,
    nvidia_driver: bool,
) -> bool {
    nvidia_driver
        && (!wayland_display.is_empty() || !wayland_socket.is_empty())
        && gdk_backend != "x11"
}

/// NVIDIA 驱动是否在跑：`/proc/driver/nvidia/version` 由 nvidia 内核模块暴露，
/// nouveau 与无独显的主机没有这个节点。开源内核模块（nvidia-open）也带这个节点，
/// 这里不区分——两者的用户态渲染栈相同，DMABUF 崩溃风险也一样，多关一次只是掉点性能。
fn nvidia_driver_loaded() -> bool {
    cfg!(target_os = "linux") && std::path::Path::new("/proc/driver/nvidia/version").exists()
}

/// 桌宠窗口的置顶与绝对定位能力是否可用。
///
/// xdg-shell 不提供这两项能力。tao 的 Linux 后端基于 GTK3，`always_on_top` 与
/// `set_position` 最终落到 `gtk_window_set_keep_above` 与 `gtk_window_move`，
/// 二者在 GDK 的 Wayland 后端上是 no-op：不生效，也不返回错误。桌宠因此成为
/// 层级由合成器决定的普通 toplevel，被主窗口覆盖。X11 / XWayland 下窗口管理器
/// 识别 `_NET_WM_STATE_ABOVE` 并接受绝对放置，两项能力都可用。
///
/// 判定读 `WAYLAND_DISPLAY` 而非 `XDG_SESSION_TYPE`：后者由 pam_systemd 设置，
/// 从 TTY 直接起的合成器（sway / weston / cage）下为空，而 GDK 照样连上 Wayland，
/// 正是本提示要覆盖的场景。`WAYLAND_DISPLAY` 缺席时 `wl_display_connect` 失败，
/// GDK 不会选中 Wayland 后端。macOS / Windows 上该变量为空，判定为可用。
///
/// `GDK_BACKEND` 是逗号分隔的优先级列表，首项为 `x11` 即强制走 XWayland。GDK 在
/// 首项打开失败时会顺延到后续项，因此 `x11,wayland` 在没有 XWayland 的环境下会被
/// 判为可用而实际不可用；该写法需显式配置，这里不为它牺牲判定的简单性。
pub(crate) fn pet_overlay_supported(wayland_display: &str, gdk_backend: &str) -> bool {
    wayland_display.is_empty() || gdk_backend.split(',').next() == Some("x11")
}

/// 本次启动是否应把应用拉到 XWayland 上（`force_xwayland` 设置项的判定）。
///
/// 值取 `x11` 而不是 `x11,wayland`：后者在 XWayland 缺席时会回落到 Wayland，看似
/// 更安全，但 [`pet_overlay_supported`] 只看列表首项，回落之后提示反而消失，用户
/// 拿到「桌宠仍被遮挡且没有解释」这个最差结果。GDK 是否发生了回落无法从环境变量
/// 观测，判定侧补不回来。改为要求 `DISPLAY` 非空能买到同样的启动安全性——合成器
/// 运行 XWayland 时才导出该变量——同时让判定保持诚实：`DISPLAY` 为空时什么都不设，
/// 提示照常显示。
///
/// 已显式设过 `GDK_BACKEND` 的用户不被覆盖，与上方 EGL workaround 的约定一致：
/// 启动脚本或 `.desktop` 里的 `Exec=env GDK_BACKEND=…` 保持权威，显式设了
/// `wayland` 的用户是在主动接受该限制。
///
/// macOS / Windows 上 `WAYLAND_DISPLAY` 为空，[`pet_overlay_supported`] 返回 true，
/// 判定短路为 false，变量不会被设置。因此不加 `#[cfg(target_os)]`，单测在三条 CI
/// 腿上都跑得到。
pub(crate) fn should_force_xwayland(
    enabled: bool,
    wayland_display: &str,
    gdk_backend: &str,
    display: &str,
) -> bool {
    enabled
        && !pet_overlay_supported(wayland_display, gdk_backend)
        && gdk_backend.is_empty()
        && !display.is_empty()
}

/// [`pet_overlay_supported`] 的环境变量读取版本，供查询命令与建窗路径共用。
pub(crate) fn pet_overlay_supported_env() -> bool {
    pet_overlay_supported(
        &std::env::var("WAYLAND_DISPLAY").unwrap_or_default(),
        &std::env::var("GDK_BACKEND").unwrap_or_default(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wayland_workaround_only_inside_appimage() {
        // AppImage + Wayland：保留旧行为，窗口能建起来。
        assert!(should_apply_wayland_egl_workaround("wayland", true));
        // 宿主安装包 + Wayland：系统 WebKit 可建 EGL 显示，不再强制关闭合成
        //（否则透明桌宠窗口全黑、视频无法渲染）。
        assert!(!should_apply_wayland_egl_workaround("wayland", false));
        // 非 Wayland 会话：两种形态都不需要。
        assert!(!should_apply_wayland_egl_workaround("x11", true));
        assert!(!should_apply_wayland_egl_workaround("", true));
        assert!(!should_apply_wayland_egl_workaround("", false));
    }

    #[test]
    fn pet_overlay_unsupported_only_on_native_wayland() {
        // 原生 Wayland：GTK 的置顶与定位调用是 no-op，桌宠被主窗口遮挡。
        assert!(!pet_overlay_supported("wayland-0", ""));
        assert!(!pet_overlay_supported("wayland-0", "wayland"));
        // 首项决定 GDK 实际后端；wayland 排在前面时仍走 Wayland。
        assert!(!pet_overlay_supported("wayland-0", "wayland,x11"));
        // 强制 XWayland：窗口管理器接受 _NET_WM_STATE_ABOVE 与绝对放置。
        assert!(pet_overlay_supported("wayland-0", "x11"));
        assert!(pet_overlay_supported("wayland-0", "x11,wayland"));
        // 冒号不是 GDK 的分隔符，整串匹配不上 `x11`，仍判为 Wayland。
        assert!(!pet_overlay_supported("wayland-0", "x11:wayland"));
        // X11 会话与 macOS / Windows：没有 Wayland 套接字。
        assert!(pet_overlay_supported("", ""));
        assert!(pet_overlay_supported("", "wayland"));
    }

    #[test]
    fn force_xwayland_only_on_native_wayland_with_xserver() {
        // 设置项默认关闭：其余条件全部满足也不改环境。
        assert!(!should_force_xwayland(false, "wayland-0", "", ":0"));
        // 开启 + 原生 Wayland + XWayland 在跑：唯一生效的组合。
        assert!(should_force_xwayland(true, "wayland-0", "", ":0"));
        // DISPLAY 为空说明合成器没起 XWayland，设了 x11 会让应用起不来。
        assert!(!should_force_xwayland(true, "wayland-0", "", ""));
        // 用户已显式指定后端，不覆盖（无论指定的是哪一个）。
        assert!(!should_force_xwayland(true, "wayland-0", "wayland", ":0"));
        assert!(!should_force_xwayland(true, "wayland-0", "x11", ":0"));
        // X11 会话：置顶与定位本来就能用。
        assert!(!should_force_xwayland(true, "", "", ":0"));
        // macOS / Windows：三个变量都为空，GDK_BACKEND 在那里也无意义。
        assert!(!should_force_xwayland(true, "", "", ""));
    }

    #[test]
    fn dmabuf_disabled_only_for_nvidia_on_native_wayland() {
        // 命中的组合：NVIDIA 驱动 + 有 Wayland 套接字。
        assert!(should_disable_dmabuf_renderer("wayland-0", "", "", true));
        assert!(should_disable_dmabuf_renderer("wayland-0", "", "wayland", true));
        assert!(should_disable_dmabuf_renderer("wayland-0", "", "wayland,x11", true));
        // 带回落后备的列表不算 X11：X11 打不开时 GTK 会顺延到 Wayland，宁可多关。
        assert!(should_disable_dmabuf_renderer("wayland-0", "", "x11,wayland", true));
        // 只有继承来的套接字（沙箱/portal 交接，WAYLAND_DISPLAY 为空）同样是原生 Wayland。
        assert!(should_disable_dmabuf_renderer("", "4", "", true));
        // 只写 x11 且无后备：确定跑在 XWayland 上，不碰渲染参数。
        assert!(!should_disable_dmabuf_renderer("wayland-0", "", "x11", true));
        // 无 NVIDIA / nouveau：系统 WebKit 的 DMABUF 通路正常。
        assert!(!should_disable_dmabuf_renderer("wayland-0", "", "", false));
        assert!(!should_disable_dmabuf_renderer("wayland-0", "", "x11,wayland", false));
        // 两个 Wayland 变量都为空（X11 会话、macOS / Windows）：判定恒为 false。
        assert!(!should_disable_dmabuf_renderer("", "", "", true));
        assert!(!should_disable_dmabuf_renderer("", "", "wayland", true));
    }
}
