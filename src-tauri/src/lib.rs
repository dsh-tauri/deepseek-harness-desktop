mod bridge;
mod config;
pub mod desktop;
mod logger;
mod service;
mod utils;

/// 对显式给定的核心安装目录施加全套 dsh 补丁（`--patch-core <dir>` 的入口）。
///
/// E2E 的插件 L2 直接起 `dsh web`，不经过桌面端启动路径；没有这一步，被测核心就缺少
/// 桌面端运行时会打上的补丁（鉴权、渲染器、会话、工作区等），断言的前提不成立。
/// 因此把补丁集暴露成一个不带 GUI 的入口，让编排复用同一份 Rust 实现，而不是另抄一份。
pub fn patch_core_dir(core_dir: &std::path::Path) -> Result<(), String> {
    service::patch::apply_all_at(core_dir)
}

/// 应用入口：先做 Wayland 环境兼容（见 `should_apply_wayland_egl_workaround` 与
/// `should_restore_wayland_backend`），再初始化日志、装配桌面端并进入事件循环。
pub fn run() {
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
    // AppImage 的 GTK 钩子把 GDK_BACKEND 强制成 x11（见 `should_restore_wayland_backend`）：
    // 默认丢掉，让 GTK 与 WebKit 一起走原生 Wayland；用户显式要 XWayland 时不动它。
    if should_restore_wayland_backend(
        std::env::var_os("APPIMAGE").is_some(),
        &std::env::var("WAYLAND_DISPLAY").unwrap_or_default(),
        &std::env::var("GDK_BACKEND").unwrap_or_default(),
    ) && !force_xwayland
    {
        std::env::remove_var("GDK_BACKEND");
        // 同上，logger::init() 尚未执行，只能用 eprintln。这里是「原生 Wayland 反而起不来」
        // 时唯一的提示位：那种情况下窗口不会出现，用户在应用内看不到任何日志或设置项。
        eprintln!(
            "[wayland] dropped the AppImage hook's GDK_BACKEND=x11 to use native Wayland (issue #789)"
        );
        eprintln!("[wayland] set DSH_FORCE_XWAYLAND=1 to keep XWayland instead");
    }
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
    // 初始化日志系统
    logger::init();

    desktop::builder()
        .invoke_handler(desktop::handler())
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            #[cfg(target_os = "macos")]
            tauri::RunEvent::MainEventsCleared => {
                desktop::builder::sync_macos_titlebars(app_handle);
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

/// AppImage 的 GTK 启动钩子强制出来的 XWayland 后端是否应被丢弃。
///
/// linuxdeploy-plugin-gtk 为绕开 tauri#8541（Ubuntu 20.04 构建的 AppImage 在 Fedora 39
/// 上以 `GLib-GIO-ERROR … xsettings` 退出）无条件 `export GDK_BACKEND=x11`，于是 Wayland
/// 会话下的 AppImage 永远以 XWayland 客户身份运行 GTK3，并按 AppImage 自带的 immodules
/// 缓存选中 XIM 输入法模块。上游已认定这是缺陷：tauri#15781「钩子覆盖用户显式设置的
/// GDK_BACKEND，静默降级到 XWayland 且不报错」，#11790 记下的结论是「hardcoded，需要时
/// 从 Rust 侧覆盖」，PR #16062 已在 dev 分支删掉该行但尚未发布，linuxdeploy-plugin-gtk
/// 的 master 也仍在使用它（`@tauri-apps/cli` 2.11.4 在 tools 目录缺失时直接下载 master）。
///
/// issue #789 的现场与该降级吻合：Wayland + AppImage 下点击内嵌 iframe 后整个 WebView
/// 不再出帧（顶层 navbar 照常可点，拖窗口边框才刷出几帧，剪贴板为空）。丢掉强制值后
/// GTK 与 WebKit 同样工作在 Wayland 上，不再出现 X11 窗口配 Wayland 加速面的错配。
/// 判定用 `WAYLAND_DISPLAY` 而非 `XDG_SESSION_TYPE`：后者由 pam_systemd 设置，从 TTY
/// 直接起的合成器下为空，而 GDK 照样连上 Wayland（与 [`pet_overlay_supported`] 同一理由）。
///
/// 只认裸 `x11`：`wayland` / `x11,wayland` 这类优先级列表只可能来自用户或启动脚本，不覆盖。
///
/// `force_xwayland` 的解析早于 `migrate_app_data_dir`（见 `config::force_xwayland_setting`）：
/// 旧标识符升级来的用户首次启动读不到设置文件。但该设置 2026-09-23 才引入（38d7f01b），
/// 标识符 2026-09-21 已改短（67f058c9），旧 store 里不可能存在 `force_xwayland`，
/// 因此这条读取盲区不会让本判定丢掉任何已持久化的用户意图。
fn should_restore_wayland_backend(
    appimage_present: bool,
    wayland_display: &str,
    gdk_backend: &str,
) -> bool {
    appimage_present && !wayland_display.is_empty() && gdk_backend == "x11"
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
    fn appimage_hook_forced_x11_backend_is_dropped_on_wayland() {
        // AppImage 自带钩子的强制值 + Wayland 套接字可用：丢弃，改走原生 Wayland。
        assert!(should_restore_wayland_backend(true, "wayland-0", "x11"));
        // 用户或启动脚本显式给的优先级列表不是钩子的裸 x11，保持权威。
        assert!(!should_restore_wayland_backend(
            true,
            "wayland-0",
            "wayland"
        ));
        assert!(!should_restore_wayland_backend(
            true,
            "wayland-0",
            "x11,wayland"
        ));
        // 没有 Wayland 套接字（纯 X11 会话 / macOS / Windows）：GDK 自己挑后端。
        assert!(!should_restore_wayland_backend(true, "", "x11"));
        // 宿主安装包没有该钩子，变量来自用户，不动。
        assert!(!should_restore_wayland_backend(false, "wayland-0", "x11"));
        assert!(!should_restore_wayland_backend(false, "wayland-0", ""));
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
}
