#[cfg(any(windows, target_os = "macos"))]
use std::sync::atomic::AtomicBool;
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(windows)]
use std::sync::Arc;
#[cfg(windows)]
use std::sync::OnceLock;
#[cfg(target_os = "macos")]
use std::sync::{Mutex, OnceLock};

#[cfg(target_os = "macos")]
use objc2_app_kit::{NSWindow, NSWindowButton, NSWindowStyleMask};
#[cfg(target_os = "macos")]
use objc2_foundation::NSPoint;
use tauri::{ipc::Invoke, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder, Wry};

#[cfg(windows)]
use windows_sys::Win32::UI::{
    Shell::ExtractIconExW,
    WindowsAndMessaging::{SendMessageW, HICON, ICON_BIG, ICON_SMALL, WM_GETICON, WM_SETICON},
};

// 托盘相关的 tauri 类型只在非 Linux 路径使用：Linux 走 desktop::linux_tray 的
// KSNI 托盘（见该文件的背景说明），届时这些导入会变成未使用。
#[cfg(not(target_os = "linux"))]
use tauri::menu::{Menu, MenuEvent, MenuItem};
#[cfg(not(target_os = "linux"))]
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};

#[cfg(target_os = "macos")]
use tauri::menu::{PredefinedMenuItem, Submenu};

#[cfg(target_os = "macos")]
static MACOS_FULLSCREEN_MENU_ITEM: OnceLock<Mutex<Option<MenuItem<Wry>>>> = OnceLock::new();

// MainEventsCleared 每轮都触发，但只有窗口布局变化后红绿灯才可能被 AppKit 重置。
// 无脑每轮校准会克隆窗口句柄，而该克隆会 CFRunLoopWakeUp 主 RunLoop，令
// MainEventsCleared 立刻再次触发，把主线程烧成 100% CPU（issue #880）。
#[cfg(target_os = "macos")]
static MACOS_TITLEBAR_SYNC_PENDING: AtomicBool = AtomicBool::new(true);

#[cfg(target_os = "macos")]
const MACOS_VIEW_COMMANDS: [(&str, &str); 4] = [
    ("desktop-toggle-sidebar", "menu.toggle_sidebar"),
    ("desktop-toggle-right-panel", "menu.toggle_right_panel"),
    ("desktop-open-terminal", "menu.open_terminal"),
    ("desktop-search-chats", "menu.search_chats"),
];

#[cfg(windows)]
use crate::desktop::window::on_page_load;
use crate::desktop::window::{on_download, on_new_window};
// 只在 tauri::tray 路径（Windows / macOS）里按短名使用；Linux 的 KSNI 托盘在
// desktop::linux_tray 内自行引用，且下面单例回调用的是完整路径。
#[cfg(not(target_os = "linux"))]
use crate::utils::show_main_window;

pub const SHELL_NAV_HEIGHT: u32 = 44;

#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_INSET_X: f64 = 18.0;

#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_VISUAL_OFFSET: f64 = 2.0;

/// WebView2 原生拖拽区域所需的参数。
///
/// `data-tauri-drag-region` 的兼容脚本只处理鼠标事件；WebView2 的原生
/// `app-region: drag` 才能让触摸输入进入窗口非客户区拖拽。ElasticOverscroll
/// 会抢走触摸手势，因此必须同时禁用。Wry 的默认安全功能保持启用。
#[cfg(windows)]
const WINDOWS_DRAG_BROWSER_ARGS: &str = "--enable-features=msWebView2EnableDraggableRegions --disable-features=ElasticOverscroll,msWebOOUI,msPdfOOUI";

/// 主窗口 label：壳层状态（几何恢复/落盘、托盘/单例唤起、macOS Reopen）都以它为准。
pub const MAIN_WINDOW_LABEL: &str = "main";

/// 「文件 → 新建窗口」的 label 序号（`window-1`、`window-2`…），保证 label 唯一。
static EXTRA_WINDOW_SEQ: AtomicU64 = AtomicU64::new(0);

/// WebView2 用户数据目录：壳层窗口必须共用；开发版与 release 分目录，避免已有
/// 实例或热重启残留占用同一 User Data 管道，触发 HRESULT 0x8007139F。
#[cfg(windows)]
fn webview_data_directory(app: &tauri::AppHandle<Wry>) -> std::path::PathBuf {
    // E2E 独占 profile：`app_local_data_dir()` 走 `SHGetKnownFolderPath`，重定向
    // `LOCALAPPDATA` 无效，不覆盖就会与用户正在使用的开发版共用 `EBWebView-dev`
    // （localStorage 等前端状态互相污染）。
    if crate::config::is_e2e_run() {
        if let Some(dir) = std::env::var_os(crate::config::E2E_WEBVIEW_DATA_DIR_ENV_VAR) {
            if !dir.is_empty() {
                return std::path::PathBuf::from(dir);
            }
        }
    }

    let mut directory = app
        .path()
        .app_local_data_dir()
        .expect("Failed to resolve app local data directory");
    directory.push(if cfg!(debug_assertions) {
        "EBWebView-dev"
    } else {
        "EBWebView"
    });
    directory
}

/// setup app
pub fn setup(app_handle: tauri::AppHandle) {
    // 升级清理：内置插件已迁至 resources/node_modules（pnpm deploy 产物）；旧安装
    // 可能残留 resources/preset-plugins 与 resources/internal-plugins 目录。仅删除
    // 旧目录，失败告警并继续启动（查找回退见 preset::find_bundled_in_root）。
    if let Err(e) = crate::service::plugin::remove_legacy_bundled_plugins(&app_handle) {
        log::warn!("legacy bundled plugins cleanup skipped: {e}");
    }

    // 启动前清扫上次崩溃残留的孤儿 Harness（端口/PID 双重确认，见
    // workflow::sweep_orphan_harness），避免新实例一路漂移端口
    crate::service::workflow::sweep_orphan_harness(&app_handle);

    // 启动自愈：清理指向旧位置的 pnpm `.modules.yaml`。老版本完成数据搬迁后该
    // 文件仍记录旧 $DSH_HOME（AppData）下的绝对路径，导致任何 pnpm 操作抛
    // `ERR_PNPM_UNEXPECTED_VIRTUAL_STORE`（插件安装/更新失败，issue #103）。
    // 幂等、best-effort：仅在检测到失效路径时删除，下次 pnpm 操作自动重建。
    let dsh_home = crate::config::get_dsh_data_path(&app_handle);
    if let Err(e) = crate::service::migrate::heal_stale_pnpm_metadata(&dsh_home) {
        log::warn!("pnpm modules metadata self-heal skipped: {e}");
    }

    // 档案迁移 + 首装引导：官方核心 0.1.5 起 `desktop` 档案名被保留给 Electron
    // 应用（`--profile desktop` 直接报错），先把老用户的 `profiles/desktop` 改名到
    // `tauri` 并改指 `active_profile`，再在桌面端首次安装时新建独立档案并切换
    // （与 CLI 用户既有插件/补丁隔离，见 service::profile）。必须先于 scheduler/
    // auto_start：它们启动服务/装插件时会带上 active_profile，迁移完成前 dsh
    // spawn 必然失败。
    crate::service::profile::migrate_desktop_profile_name(&app_handle);

    // 启动进程监控（tick 检测 dsh 服务状态）
    crate::service::scheduler::start(&app_handle);

    // `dsh://` 深链（成功页「打开应用」按钮）：仅打包态注册协议并接管 open-url
    // （debug 注册会把系统 `dsh:` 指向调试产物）。
    #[cfg(not(debug_assertions))]
    crate::desktop::deep_link::init(&app_handle);

    // 开机自启动：已安装且开启 auto_start 时拉起服务
    let app_for_start = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        let setting = crate::config::get_store_dat_setting(&app_for_start);
        if !setting.auto_start {
            log::debug!("auto_start disabled, skipping startup");
            return;
        }
        if let Err(e) = crate::service::workflow::start(app_for_start).await {
            log::error!("start failed: {}", e);
        }
    });

    // 命令行集成自愈：已安装且开启时，确保 shim 与 PATH 注册完整
    // （shim 被删除、PATH 条目丢失等情况下自动重建）
    tauri::async_runtime::spawn(async move {
        let setting = crate::config::get_store_dat_setting(&app_handle);
        if !setting.installed || !setting.cli_link_enabled {
            return;
        }
        if let Err(e) = crate::service::cli::ensure(&app_handle) {
            log::warn!("cli link self-heal failed: {e}");
        }
    });
}

/// 构建系统托盘。
///
/// Linux 用上游 tray-icon 的 KSNI 后端自建（`tauri::tray` 固定依赖的 tray-icon 0.24
/// 在 Linux 上不上报任何托盘事件，见 `desktop::linux_tray` 的平台说明与 issue #386）；
/// Windows / macOS 沿用 `tauri::tray`。
#[cfg(target_os = "linux")]
pub fn tray<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    crate::desktop::linux_tray::build(app);
    Ok(())
}

/// 构建系统托盘（Windows / macOS：`tauri::tray`）。
#[cfg(not(target_os = "linux"))]
pub fn tray<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    // 平台差异的托盘图标策略：
    // - macOS：使用 scoped template 透明图标（NSImage template），由系统按菜单栏
    //   深浅/半透明材质自动着色，呈现与系统一致的半透明玻璃观感，而非彩色方块。
    // - 其他平台：沿用默认窗口图标。
    #[cfg(target_os = "macos")]
    let icon = tauri::image::Image::from_bytes(include_bytes!("../../icons/macos-tray.png"))?;
    #[cfg(not(target_os = "macos"))]
    let icon = app.default_window_icon().unwrap().clone();

    // 构建菜单
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "open", "打开面板", true, None::<&str>)?,
            &MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?,
        ],
    )?;

    fn handle_menu_event<R: Runtime>(app: &tauri::AppHandle<R>, event: &MenuEvent) {
        match event.id().as_ref() {
            "open" => show_main_window(app),
            "quit" => {
                app.exit(0);
            }
            _ => {}
        }
    }

    fn handle_tray_icon_event<R: Runtime>(tray: &tauri::tray::TrayIcon<R>, event: &TrayIconEvent) {
        if let TrayIconEvent::Click {
            button: MouseButton::Left,
            ..
        } = event
        {
            show_main_window(tray.app_handle());
        }
    }

    // 构建托盘图标。macOS 上把模板图标记为 NSImage template，由系统按菜单栏
    // 深浅/半透明材质自动着色，呈现与系统一致的半透明玻璃观感。
    #[cfg(target_os = "macos")]
    let _ = TrayIconBuilder::new()
        .icon(icon)
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip(crate::desktop::product_name(app))
        .on_menu_event(move |app, event| handle_menu_event(app, &event))
        .on_tray_icon_event(move |tray, event| handle_tray_icon_event(tray, &event))
        .build(app)?;

    #[cfg(not(target_os = "macos"))]
    let _ = TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip(crate::desktop::product_name(app))
        .on_menu_event(move |app, event| handle_menu_event(app, &event))
        .on_tray_icon_event(move |tray, event| handle_tray_icon_event(tray, &event))
        .build(app)?;

    Ok(())
}

/// 安装 macOS 全局菜单栏操作。
///
/// 菜单由原生层在窗口启动前后始终持有，避免 WebView 重载或进入独立全屏 Space
/// 时丢失；点击后只发送动作 id，由前端复用现有对话框和更新流程。
#[cfg(target_os = "macos")]
pub fn install_macos_menu(app: &tauri::AppHandle<Wry>) -> tauri::Result<()> {
    let setting = crate::config::get_store_dat_setting(app);
    crate::config::i18n::set_language(match setting.language.as_str() {
        "en" | "en-US" => crate::config::i18n::Lang::En,
        _ => crate::config::i18n::Lang::Zh,
    });

    let config = MenuItem::with_id(
        app,
        "desktop-config",
        crate::config::i18n::t("menu.settings"),
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let profiles = MenuItem::with_id(
        app,
        "desktop-profiles",
        crate::config::i18n::t("menu.profiles"),
        true,
        None::<&str>,
    )?;
    let plugins = MenuItem::with_id(
        app,
        "desktop-plugins",
        crate::config::i18n::t("menu.plugins"),
        true,
        None::<&str>,
    )?;
    let harness = MenuItem::with_id(
        app,
        "desktop-harness",
        crate::config::i18n::t("menu.harness"),
        true,
        None::<&str>,
    )?;
    let restart = MenuItem::with_id(
        app,
        "desktop-restart",
        crate::config::i18n::t("menu.restart"),
        true,
        None::<&str>,
    )?;
    let run_separator = PredefinedMenuItem::separator(app)?;
    let is_fullscreen = app
        .get_webview_window("main")
        .and_then(|window| window.is_fullscreen().ok())
        .unwrap_or(false);
    let fullscreen_label = crate::config::i18n::t(fullscreen_menu_label_key(is_fullscreen));
    // AppKit 会因标准 toggleFullScreen: 菜单项省略“窗口”中的自动全屏入口。
    let fullscreen = MenuItem::with_id(
        app,
        "desktop-fullscreen",
        &fullscreen_label,
        true,
        Some("Ctrl+Super+F"),
    )?;
    let run_menu = Submenu::with_id_and_items(
        app,
        "desktop-run-menu",
        crate::config::i18n::t("menu.run"),
        true,
        &[&profiles, &plugins, &harness, &run_separator, &restart],
    )?;
    let view_commands = MACOS_VIEW_COMMANDS
        .iter()
        .map(|(id, key)| {
            MenuItem::with_id(app, *id, crate::config::i18n::t(key), false, None::<&str>)
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    let view_separator = PredefinedMenuItem::separator(app)?;
    let zoom_in = MenuItem::with_id(
        app,
        "desktop-zoom-in",
        crate::config::i18n::t("menu.zoom_in"),
        true,
        Some("CmdOrCtrl+Equal"),
    )?;
    let zoom_out = MenuItem::with_id(
        app,
        "desktop-zoom-out",
        crate::config::i18n::t("menu.zoom_out"),
        true,
        Some("CmdOrCtrl+-"),
    )?;
    let zoom_reset = MenuItem::with_id(
        app,
        "desktop-zoom-reset",
        crate::config::i18n::t("menu.actual_size"),
        true,
        Some("CmdOrCtrl+0"),
    )?;
    let fullscreen_separator = PredefinedMenuItem::separator(app)?;
    let view_menu = Submenu::with_id_and_items(
        app,
        "desktop-view-menu",
        crate::config::i18n::t("menu.view"),
        true,
        &[
            &view_commands[0],
            &view_commands[1],
            &view_commands[2],
            &view_commands[3],
            &view_separator,
            &zoom_in,
            &zoom_out,
            &zoom_reset,
            &fullscreen_separator,
            &fullscreen,
        ],
    )?;

    let about = MenuItem::with_id(
        app,
        "desktop-about",
        crate::config::i18n::t("menu.about"),
        true,
        None::<&str>,
    )?;
    let about_separator = PredefinedMenuItem::separator(app)?;
    let check_update = MenuItem::with_id(
        app,
        "desktop-check-update",
        crate::config::i18n::t("menu.check_update"),
        true,
        None::<&str>,
    )?;
    let settings_separator = PredefinedMenuItem::separator(app)?;
    let services =
        PredefinedMenuItem::services(app, Some(&crate::config::i18n::t("menu.services")))?;
    let services_separator = PredefinedMenuItem::separator(app)?;
    let app_name = crate::desktop::product_name(app);
    let hide_label = format!("{} {}", crate::config::i18n::t("menu.hide"), app_name);
    let hide = PredefinedMenuItem::hide(app, Some(&hide_label))?;
    let hide_others =
        PredefinedMenuItem::hide_others(app, Some(&crate::config::i18n::t("menu.hide_others")))?;
    let show_all =
        PredefinedMenuItem::show_all(app, Some(&crate::config::i18n::t("menu.show_all")))?;
    let quit_separator = PredefinedMenuItem::separator(app)?;
    let quit_label = format!("{} {}", crate::config::i18n::t("menu.quit"), app_name);
    let quit = PredefinedMenuItem::quit(app, Some(&quit_label))?;
    let system_application_menu = Submenu::with_id_and_items(
        app,
        "desktop-system-application-menu",
        app_name,
        true,
        &[
            &about,
            &about_separator,
            &config,
            &check_update,
            &settings_separator,
            &services,
            &services_separator,
            &hide,
            &hide_others,
            &show_all,
            &quit_separator,
            &quit,
        ],
    )?;

    let run_logs = MenuItem::with_id(
        app,
        "desktop-copy-run-logs",
        crate::config::i18n::t("menu.run_logs"),
        true,
        None::<&str>,
    )?;
    let toggle_devtools = MenuItem::with_id(
        app,
        "desktop-toggle-devtools",
        crate::config::i18n::t("menu.toggle_devtools"),
        true,
        None::<&str>,
    )?;
    let task_manager = MenuItem::with_id(
        app,
        "desktop-task-manager",
        crate::config::i18n::t("menu.task_manager"),
        true,
        None::<&str>,
    )?;
    let help_separator = PredefinedMenuItem::separator(app)?;
    let documentation = MenuItem::with_id(
        app,
        "desktop-documentation",
        crate::config::i18n::t("menu.documentation"),
        true,
        None::<&str>,
    )?;
    let keyboard_shortcuts = MenuItem::with_id(
        app,
        "desktop-keyboard-shortcuts",
        crate::config::i18n::t("menu.keyboard_shortcuts"),
        true,
        None::<&str>,
    )?;
    let desktop_feedback = MenuItem::with_id(
        app,
        "desktop-feedback",
        crate::config::i18n::t("menu.desktop_feedback"),
        true,
        None::<&str>,
    )?;
    let harness_feedback = MenuItem::with_id(
        app,
        "desktop-harness-feedback",
        crate::config::i18n::t("menu.harness_feedback"),
        true,
        None::<&str>,
    )?;
    let feedback_separator = PredefinedMenuItem::separator(app)?;
    let help_menu = Submenu::with_id_and_items(
        app,
        "desktop-help-menu",
        crate::config::i18n::t("menu.help"),
        true,
        &[
            &documentation,
            &keyboard_shortcuts,
            &help_separator,
            &desktop_feedback,
            &harness_feedback,
            &feedback_separator,
            &run_logs,
            &toggle_devtools,
            &task_manager,
        ],
    )?;

    let new_window = MenuItem::with_id(
        app,
        "desktop-new-window",
        crate::config::i18n::t("menu.new_window"),
        true,
        Some("CmdOrCtrl+N"),
    )?;
    let new_chat = MenuItem::with_id(
        app,
        "desktop-new-chat",
        crate::config::i18n::t("menu.new_chat"),
        true,
        Some("CmdOrCtrl+Shift+N"),
    )?;
    let open_folder = MenuItem::with_id(
        app,
        "desktop-open-folder",
        crate::config::i18n::t("menu.open_folder"),
        true,
        Some("CmdOrCtrl+O"),
    )?;
    let file_separator_close = PredefinedMenuItem::separator(app)?;
    let close = PredefinedMenuItem::close_window(app, Some(&crate::config::i18n::t("menu.close")))?;
    let file_menu = Submenu::with_id_and_items(
        app,
        "desktop-file-menu",
        crate::config::i18n::t("menu.file"),
        true,
        &[
            &new_window,
            &new_chat,
            &open_folder,
            &file_separator_close,
            &close,
        ],
    )?;

    let undo = PredefinedMenuItem::undo(app, Some(&crate::config::i18n::t("menu.undo")))?;
    let redo = PredefinedMenuItem::redo(app, Some(&crate::config::i18n::t("menu.redo")))?;
    let edit_separator = PredefinedMenuItem::separator(app)?;
    let cut = PredefinedMenuItem::cut(app, Some(&crate::config::i18n::t("menu.cut")))?;
    let copy = PredefinedMenuItem::copy(app, Some(&crate::config::i18n::t("menu.copy")))?;
    let paste = PredefinedMenuItem::paste(app, Some(&crate::config::i18n::t("menu.paste")))?;
    let select_all =
        PredefinedMenuItem::select_all(app, Some(&crate::config::i18n::t("menu.select_all")))?;
    let edit_menu = Submenu::with_id_and_items(
        app,
        "desktop-edit-menu",
        crate::config::i18n::t("menu.edit"),
        true,
        &[
            &undo,
            &redo,
            &edit_separator,
            &cut,
            &copy,
            &paste,
            &select_all,
        ],
    )?;

    let minimize =
        PredefinedMenuItem::minimize(app, Some(&crate::config::i18n::t("menu.minimize")))?;
    let zoom = PredefinedMenuItem::maximize(app, Some(&crate::config::i18n::t("menu.zoom")))?;
    let window_separator = PredefinedMenuItem::separator(app)?;
    let bring_all_to_front = PredefinedMenuItem::bring_all_to_front(
        app,
        Some(&crate::config::i18n::t("menu.bring_all_to_front")),
    )?;
    let window_menu = Submenu::with_id_and_items(
        app,
        "desktop-window-menu",
        crate::config::i18n::t("menu.window"),
        true,
        &[&minimize, &zoom, &window_separator, &bring_all_to_front],
    )?;

    let menu = Menu::with_items(
        app,
        &[
            &system_application_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &run_menu,
            &window_menu,
            &help_menu,
        ],
    )?;
    let _ = app.set_menu(menu)?;
    window_menu.set_as_windows_menu_for_nsapp()?;
    help_menu.set_as_help_menu_for_nsapp()?;
    *MACOS_FULLSCREEN_MENU_ITEM
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(fullscreen);
    app.emit("macos-menu-rebuilt", ())?;
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
fn fullscreen_menu_label_key(is_fullscreen: bool) -> &'static str {
    if is_fullscreen {
        "menu.exit_fullscreen"
    } else {
        "menu.enter_fullscreen"
    }
}

fn help_menu_window_label<'a>(
    windows: impl IntoIterator<Item = (&'a str, bool)>,
) -> Option<&'a str> {
    let mut main_window = None;
    for (label, focused) in windows {
        if label == crate::desktop::pet::PET_WINDOW_LABEL {
            continue;
        }
        if focused {
            return Some(label);
        }
        if label == MAIN_WINDOW_LABEL {
            main_window = Some(label);
        }
    }
    main_window
}

#[cfg(test)]
mod help_menu_tests {
    use super::help_menu_window_label;

    #[test]
    fn help_links_prefer_the_focused_shell_window() {
        for windows in [
            [("main", false), ("window-1", true), ("pet", false)],
            [("window-1", true), ("main", false), ("pet", false)],
        ] {
            assert_eq!(help_menu_window_label(windows), Some("window-1"));
        }
        assert_eq!(
            help_menu_window_label([("window-1", false), ("main", true)]),
            Some("main")
        );
    }

    #[test]
    fn help_links_fall_back_to_main_when_only_the_pet_is_focused() {
        assert_eq!(
            help_menu_window_label([("main", false), ("window-1", false), ("pet", true)]),
            Some("main")
        );
    }

    #[test]
    fn help_links_fall_back_to_main_when_all_windows_are_unfocused() {
        for windows in [
            [("main", false), ("window-1", false), ("pet", false)],
            [("window-1", false), ("pet", false), ("main", false)],
        ] {
            assert_eq!(help_menu_window_label(windows), Some("main"));
        }
    }

    #[test]
    fn help_links_never_fall_back_to_a_pet_or_an_arbitrary_extra_window() {
        assert_eq!(
            help_menu_window_label([("window-1", false), ("pet", true)]),
            None
        );
        assert_eq!(help_menu_window_label([]), None);
    }
}

#[derive(serde::Deserialize)]
pub struct ViewMenuEntry {
    id: String,
    enabled: bool,
    shortcut: Option<String>,
}

#[tauri::command]
pub fn sync_view_menu(
    window: tauri::WebviewWindow<Wry>,
    entries: Vec<ViewMenuEntry>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if window.label() == crate::desktop::pet::PET_WINDOW_LABEL
            || !window.is_focused().unwrap_or(false)
        {
            return Ok(());
        }
        let Some(menu) = window.app_handle().menu() else {
            return Ok(());
        };
        let Some(view) = menu.get("desktop-view-menu") else {
            return Ok(());
        };
        let Some(view) = view.as_submenu() else {
            return Ok(());
        };
        for (id, key) in MACOS_VIEW_COMMANDS {
            let Some(item) = view.get(id) else {
                continue;
            };
            let Some(item) = item.as_menuitem() else {
                continue;
            };
            let entry = entries.iter().find(|entry| entry.id == id);
            let enabled = entry.is_some_and(|entry| entry.enabled);
            let mut label = crate::config::i18n::t(key);
            if enabled {
                if let Some(shortcut) = entry
                    .and_then(|entry| entry.shortcut.as_deref())
                    .filter(|shortcut| shortcut.len() <= 80)
                {
                    label.push_str("    ");
                    label.push_str(shortcut);
                }
            }
            item.set_text(label)
                .and_then(|_| item.set_enabled(enabled))
                .map_err(|error| format!("VIEW_MENU_SYNC_FAILED: {error}"))?;
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (window, entries);
    Ok(())
}

/// 原生全屏动画会连续触发 Resize；只在状态真正变化时刷新菜单文案。
#[cfg(target_os = "macos")]
fn sync_macos_fullscreen_menu(window: &tauri::Window<Wry>) {
    if window.label() == crate::desktop::pet::PET_WINDOW_LABEL
        || !window.is_focused().unwrap_or(false)
    {
        return;
    }
    let Ok(is_fullscreen) = window.is_fullscreen() else {
        return;
    };
    let label = crate::config::i18n::t(fullscreen_menu_label_key(is_fullscreen));
    let item = MACOS_FULLSCREEN_MENU_ITEM
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    let Some(item) = item else {
        return;
    };
    if item.text().ok().as_deref() == Some(label.as_str()) {
        return;
    }
    if let Err(error) = item.set_text(label) {
        log::warn!("[menu] failed to update macOS fullscreen label: {error}");
    }
}

/// 从 PE 文件的内嵌图标资源里取「大 + 小」两枚 HICON（`ExtractIconExW` 按系统 DPI
/// 选帧，且保留 32 位 alpha）。
///
/// 句柄所有权随返回值交给调用方；提取失败时（包括只取到一半）本函数负责把已经拿到
/// 的句柄销毁，不把半份结果漏出去。
#[cfg(windows)]
fn load_exe_icons(exe: &std::path::Path) -> Option<(HICON, HICON)> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::WindowsAndMessaging::DestroyIcon;

    let wide: Vec<u16> = exe
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let (mut large, mut small): (HICON, HICON) = (std::ptr::null_mut(), std::ptr::null_mut());
    let extracted = unsafe { ExtractIconExW(wide.as_ptr(), 0, &mut large, &mut small, 1) };
    if extracted > 0 && !large.is_null() && !small.is_null() {
        return Some((large, small));
    }
    unsafe {
        if !large.is_null() {
            DestroyIcon(large);
        }
        if !small.is_null() {
            DestroyIcon(small);
        }
    }
    None
}

/// 进程级共享的 exe 图标句柄（大 + 小）。
///
/// `ExtractIconExW` 出来的 HICON 所有权在调用方，但「有主」不等于「用完就销毁」：
/// 只要还有窗口或任务栏缓存引用它，它就必须活着。这里缓存成进程级单例，所有窗口共用
/// 同一对句柄——总数恒为 2，既不随窗口开关累积（review：原实现每个壳层窗口各留两枚），
/// 也不存在「窗口销毁时把还在用的句柄删掉」的悬垂窗口。
#[cfg(windows)]
fn shared_exe_icons() -> Option<(HICON, HICON)> {
    struct Icons(HICON, HICON);
    // SAFETY: HICON 是 GDI 句柄，只读共享；进程存活期间永不销毁，因此跨线程安全。
    unsafe impl Send for Icons {}
    unsafe impl Sync for Icons {}

    static ICONS: OnceLock<Option<Icons>> = OnceLock::new();
    ICONS
        .get_or_init(|| {
            std::env::current_exe()
                .ok()
                .as_deref()
                .and_then(load_exe_icons)
                .map(|(large, small)| Icons(large, small))
        })
        .as_ref()
        .map(|icons| (icons.0, icons.1))
}

/// 填上 Windows 任务栏 / Alt+Tab 用的**大图标**槽位（issue #744）。
///
/// 任务栏与 Alt+Tab 取的是 ICON_BIG，而 tao 的 `set_window_icon` 只写 ICON_SMALL
/// （`IconType::Small`），大图标槽位始终为 0；`.icon()` 递下去的那份也救不了场：
/// tauri-codegen 只取 icon.ico 的第一帧（32×32）转 RGBA（`CachedIcon::new_ico` 的
/// `entries()[0]`），tao 再用 `CreateIcon` 重建 HICON——`CreateIcon` 的色位图是 DDB，
/// 不带 alpha，只能得到 1 位掩码的硬边剪影。任务栏于是画出一块拉伸过的模糊色块。
///
/// 绕开 RGBA 通道：直接从 exe 内嵌的图标资源取多帧 HICON（资源由 tauri-build 在
/// 打包时嵌入），大小两个槽位一并覆盖。
///
/// 图标按系统 DPI 尺寸取一次（96 DPI 下 32/16），非 100% 缩放下由系统等比拉伸；
/// 要做到逐 DPI 锐利，需要改用 `PrivateExtractIconsW` + `GetSystemMetricsForDpi`
/// 按窗口 DPI 取帧，并在 `ScaleFactorChanged` 时重设。
#[cfg(windows)]
fn apply_windows_window_icon(window: &tauri::WebviewWindow<Wry>) {
    let Some((large, small)) = shared_exe_icons() else {
        log::warn!("[icon] exe icon resource unavailable, taskbar keeps the degraded small icon");
        return;
    };
    let hwnd = match window.hwnd() {
        Ok(hwnd) => hwnd.0,
        Err(error) => {
            log::warn!("[icon] window handle unavailable: {error}");
            return;
        }
    };
    unsafe {
        SendMessageW(hwnd, WM_SETICON, ICON_BIG as usize, large as isize);
        SendMessageW(hwnd, WM_SETICON, ICON_SMALL as usize, small as isize);
        if SendMessageW(hwnd, WM_GETICON, ICON_BIG as usize, 0) == 0 {
            log::warn!("[icon] ICON_BIG still unset after registration");
        }
    }
}

fn with_shell_chrome<'a>(
    app: &'a tauri::AppHandle<Wry>,
    builder: WebviewWindowBuilder<'a, Wry, tauri::AppHandle<Wry>>,
) -> tauri::Result<WebviewWindowBuilder<'a, Wry, tauri::AppHandle<Wry>>> {
    let appearance = crate::config::get_store_dat_setting(app).appearance;
    let transparent = appearance.transparency;
    let builder = builder
        .transparent(transparent)
        .initialization_script(format!(
            "window.__DSH_TRANSPARENT__ = {transparent}; window.__DSH_STORE_FILE__ = {};",
            serde_json::json!(crate::config::store_dat_file_name())
        ))
        // 启动期外观引导必须落在 document-start 且覆盖所有 frame：内嵌 dsh 的 boot 页
        // （HARNESS + Loading plugins…）由内核在插件加载之前绘出，晚于首绘的帧桥改不动它。
        .initialization_script_for_all_frames(crate::desktop::appearance::APPEARANCE_BOOTSTRAP_JS)
        .inner_size(1280.0, 840.0)
        .min_inner_size(860.0, 620.0)
        .resizable(true);

    #[cfg(any(windows, target_os = "macos"))]
    let builder = if appearance.native_blur_enabled() {
        builder.effects(
            tauri::window::EffectsBuilder::new()
                .effects([
                    tauri::window::Effect::Acrylic,
                    tauri::window::Effect::Mica,
                    tauri::window::Effect::UnderWindowBackground,
                ])
                .state(tauri::window::EffectState::FollowsWindowActiveState)
                .build(),
        )
    } else {
        builder
    };

    #[cfg(windows)]
    let builder = builder
        .data_directory(webview_data_directory(app))
        .additional_browser_args(WINDOWS_DRAG_BROWSER_ARGS)
        .icon(app.default_window_icon().unwrap().clone())?;

    #[cfg(target_os = "macos")]
    let builder = builder
        .decorations(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(
            TRAFFIC_LIGHT_INSET_X,
            f64::from(SHELL_NAV_HEIGHT) / 2.0 + TRAFFIC_LIGHT_VISUAL_OFFSET,
        ))
        .theme(match crate::config::get_dsh_theme(app) {
            crate::config::DshTheme::System => None,
            crate::config::DshTheme::Light => Some(tauri::Theme::Light),
            crate::config::DshTheme::Dark => Some(tauri::Theme::Dark),
        });

    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false);

    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = app;

    Ok(builder)
}

#[cfg(target_os = "macos")]
pub(crate) fn on_macos_titlebar_event(event: &tauri::WindowEvent) {
    if matches!(
        event,
        tauri::WindowEvent::Resized(_)
            | tauri::WindowEvent::ScaleFactorChanged { .. }
            | tauri::WindowEvent::ThemeChanged(_)
            | tauri::WindowEvent::Focused(_)
    ) {
        MACOS_TITLEBAR_SYNC_PENDING.store(true, Ordering::Relaxed);
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn sync_macos_titlebars<I>(windows: impl FnOnce() -> I)
where
    I: IntoIterator<Item = tauri::WebviewWindow<Wry>>,
{
    if !MACOS_TITLEBAR_SYNC_PENDING.swap(false, Ordering::Relaxed) {
        return;
    }
    for webview in windows() {
        let Ok(handle) = webview.ns_window() else {
            continue;
        };
        let window = unsafe { &*handle.cast::<NSWindow>() };
        if window.styleMask().contains(NSWindowStyleMask::FullScreen) {
            continue;
        }
        let Some(button) = window.standardWindowButton(NSWindowButton::CloseButton) else {
            continue;
        };
        let bounds = button.bounds();
        let center = button.convertPoint_toView(
            NSPoint::new(bounds.size.width / 2.0, bounds.size.height / 2.0),
            None,
        );
        let expected_x = TRAFFIC_LIGHT_INSET_X + bounds.size.width / 2.0;
        let expected_y = f64::from(SHELL_NAV_HEIGHT) / 2.0;
        let actual_y = window.frame().size.height - center.y;
        // AppKit 在布局完成后重置按钮；仅在偏移时重绘 Wry（tauri#15451）。
        if (center.x - expected_x).abs() > 0.5 || (actual_y - expected_y).abs() > 0.5 {
            if let Some(content) = window.contentView() {
                content.display();
            }
        }
    }
}

#[cfg(all(test, target_os = "macos"))]
mod macos_titlebar_tests {
    use super::{on_macos_titlebar_event, sync_macos_titlebars, MACOS_TITLEBAR_SYNC_PENDING};
    use std::cell::Cell;
    use std::sync::atomic::Ordering;
    use tauri::{PhysicalPosition, PhysicalSize, Theme, WindowEvent};

    #[test]
    fn only_layout_events_arm_a_single_titlebar_sync() {
        let scans = Cell::new(0);
        let windows = || {
            scans.set(scans.get() + 1);
            std::iter::empty::<tauri::WebviewWindow<tauri::Wry>>()
        };
        for event in [
            WindowEvent::Moved(PhysicalPosition::new(10, 10)),
            WindowEvent::Destroyed,
        ] {
            MACOS_TITLEBAR_SYNC_PENDING.store(false, Ordering::Relaxed);
            on_macos_titlebar_event(&event);
            assert!(
                !MACOS_TITLEBAR_SYNC_PENDING.load(Ordering::Relaxed),
                "{event:?} 不该触发校准：拖动窗口时 Moved 会持续高频触发，\
                 逐帧校准会克隆窗口句柄并唤醒主 RunLoop，把主线程烧满（issue #880）"
            );
            sync_macos_titlebars(&windows);
            assert_eq!(scans.get(), 0, "{event:?} 不得枚举窗口（issue #880）");
        }

        for event in [
            WindowEvent::Resized(PhysicalSize::new(800, 600)),
            WindowEvent::ThemeChanged(Theme::Dark),
            WindowEvent::Focused(true),
            WindowEvent::Focused(false),
        ] {
            let scans_before = scans.get();
            MACOS_TITLEBAR_SYNC_PENDING.store(false, Ordering::Relaxed);
            on_macos_titlebar_event(&event);
            on_macos_titlebar_event(&event);
            assert!(
                MACOS_TITLEBAR_SYNC_PENDING.load(Ordering::Relaxed),
                "{event:?} 会改变标题栏布局，必须触发一次校准"
            );
            sync_macos_titlebars(&windows);
            assert_eq!(
                scans.get(),
                scans_before + 1,
                "同一轮重复的 {event:?} 只能枚举一次窗口（issue #880）"
            );
            assert!(
                !MACOS_TITLEBAR_SYNC_PENDING.load(Ordering::Relaxed),
                "{event:?} 校准后必须消费标记，否则会重新唤醒主 RunLoop（issue #880）"
            );
            for _ in 0..1000 {
                sync_macos_titlebars(&windows);
            }
            assert_eq!(
                scans.get(),
                scans_before + 1,
                "连续空闲同步不得再次枚举窗口（issue #880）"
            );
            assert!(
                !MACOS_TITLEBAR_SYNC_PENDING.load(Ordering::Relaxed),
                "空闲同步不得重新设置校准标记（issue #880）"
            );
        }
    }
}

#[cfg(not(windows))]
fn with_shell_scripts<'a>(
    builder: WebviewWindowBuilder<'a, Wry, tauri::AppHandle<Wry>>,
) -> WebviewWindowBuilder<'a, Wry, tauri::AppHandle<Wry>> {
    builder
        .initialization_script_for_all_frames(crate::desktop::compat::ABORT_SIGNAL_ANY_SHIM_JS)
        .initialization_script_for_all_frames(crate::desktop::compat::ITERATOR_HELPERS_SHIM_JS)
        .initialization_script_for_all_frames(crate::desktop::notification::NOTIFICATION_SHIM_JS)
        .initialization_script_for_all_frames(crate::desktop::paste::PASTE_SHIM_JS)
        .initialization_script_for_all_frames(crate::desktop::frame_log::FRAME_LOG_BRIDGE_JS)
        .initialization_script_for_all_frames(crate::desktop::plugin_boot::PLUGIN_BOOT_RELOAD_JS)
}

/// 构建主窗口。
///
/// 主窗口在这里手动创建（不再从 tauri.conf.json 声明）：
/// config 声明的窗口无法挂载 on_download，而内嵌 iframe 的 dsh 页面
/// 触发下载时 WebView2 静默保存、用户零感知，需要接管下载以给出反馈。
pub fn build_main_window(app: &tauri::AppHandle<Wry>) -> tauri::Result<tauri::WebviewWindow<Wry>> {
    let app_handle = app.clone();

    // 启动期几何恢复窗口（issue #464）：必须在创建主窗口之前置位。恢复完成前
    // 平台会先按 builder 默认值（1280×840）建窗并派发 Moved/Resized，这些瞬态
    // 几何一旦落盘就会覆盖用户保存的尺寸/位置，使窗口「每次启动都要重新拉伸」。
    // 守卫在本函数返回（几何已恢复、Windows 上窗口已 show）时释放；中途 `?`
    // 返回也照常释放，不会把采样永久关掉。
    let _geometry_restore = crate::config::GeometryRestoreGuard::begin();

    #[cfg(windows)]
    let _notification_handlers_registered = Arc::new(AtomicBool::new(false));
    #[cfg(windows)]
    let notification_handlers_registered_for_page = _notification_handlers_registered.clone();

    let webview_builder =
        WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, WebviewUrl::App("index.html".into()))
            .title(crate::desktop::product_name(app));

    // Windows/WebView2 在 build() 尚未返回时就可能绘制窗口。先隐藏创建，
    // 等保存的几何恢复完成再显示，避免启动时先闪出默认尺寸再跳到历史尺寸。
    #[cfg(windows)]
    let webview_builder = webview_builder.visible(false);

    let webview_builder = with_shell_chrome(app, webview_builder)?;

    let webview_builder = webview_builder
        // 恢复 iframe 内 HTML5 拖拽（拖入图片/拖动元素）：
        // Tauri 默认注册 wry drag_drop_handler → WebView2 SetAllowExternalDrop(false)
        // 并注入 IDropTarget 接管拖放，iframe 内拖拽被禁用。
        // 注意不能用 .drag_and_drop(false)：它只设置 tao 窗口层的拖放开关
        // （tauri issue #13761），不影响 webview 层，拖拽依旧失效；
        // disable_drag_drop_handler 才能关掉 wry 的接管（等价于旧配置 dragDropEnabled: false）。
        // 代价：wry 随接管一起关掉的 AllowExternalDrop 防护也没了，必须由
        // desktop::window::disable_external_drop 在页面加载时补回，否则页面内拖放
        // 文本会让 WebView2 卡在失效的鼠标捕获上（issue #591）。
        .disable_drag_drop_handler()
        // 接管内嵌 iframe 的 window.open() / target=_blank 新窗口请求：
        // WebView2 里这类请求走 NewWindowRequested，wry 在没有 handler 时
        // 直接 SetHandled(true) 吞掉（点了没反应）——dshmarket 等预设插件的
        // “源码”按钮在桌面端因此无法跳转（浏览器里正常）。
        // 这里把 http(s) 链接交给系统浏览器打开，其余协议一律拒绝。
        .on_new_window(move |url, features| on_new_window(app_handle.clone(), url, features))
        .on_download(on_download);

    #[cfg(windows)]
    let webview_builder = webview_builder.on_page_load(move |webview_window, payload| {
        on_page_load(
            webview_window,
            payload,
            notification_handlers_registered_for_page.clone(),
        )
    });

    // 非 Windows（macOS/Linux）没有 WebView2 的 FrameCreated/ContentLoading 流程，
    // 直接用 Tauri 的 initialization_script_for_all_frames 把兼容桥、通知桥、
    // 剪贴板图片桥、帧内日志桥、启动期外观引导与 boot 探测桥注入所有 frame
    // （脚本均带幂等守卫，重复注入安全）。
    // 导航桥（侧边栏）、缩放快捷键与 iframe 全局样式已分别由 dsh-tauri /
    // dsh-tauri-ui 插件在 iframe 内实现，不再注入对应脚本。
    #[cfg(not(windows))]
    let webview_builder = with_shell_scripts(webview_builder);

    let webview_window = webview_builder.build()?;
    #[cfg(windows)]
    apply_windows_window_icon(&webview_window);
    // 首帧前把窗口底色设成主题画布色（见 `config::window_background`），否则
    // 「窗口可见 → 前端取回偏好」之间会闪一次错色。
    apply_window_background(app, &webview_window);
    let zoom_factor = crate::config::get_store_dat_setting(app).zoom_factor;
    if zoom_factor != crate::config::default_zoom_factor() {
        if let Err(error) = crate::desktop::zoom::apply_native_zoom(&webview_window, zoom_factor) {
            log::warn!("[zoom] startup zoom was not applied: {error}");
        }
    }

    // 恢复上次的窗口大小/位置/最大化状态（无历史时保持 builder 默认的 1280×840，
    // 由 Tauri 自动居中；见 config::window_state）。
    crate::config::restore_main_window(app, &webview_window);
    #[cfg(windows)]
    webview_window.show()?;

    #[cfg(windows)]
    {
        if !_notification_handlers_registered.swap(true, Ordering::SeqCst) {
            log::info!("[notification] scheduling handler registration from setup");
            let webview_for_dialog = webview_window.clone();
            if let Err(e) = webview_window.with_webview(move |webview| {
                if let Err(e) = crate::desktop::notification::enable_notification_permissions(
                    webview,
                    webview_for_dialog,
                ) {
                    log::warn!("[webview] failed to enable notification permission: {e}");
                }
            }) {
                log::warn!("[webview] failed to schedule notification permission setup: {e}");
            }
        }
    }

    Ok(webview_window)
}

/// 把窗口底色设成主题画布色；`system` 按窗口当前外观折算。
///
/// macOS 未实现窗口底色接口，`set_background_color` 会返回错误并被忽略——那里由
/// `config::apply_window_theme` 同步原生外观。
fn apply_window_background(app: &tauri::AppHandle<Wry>, window: &tauri::WebviewWindow<Wry>) {
    let background = if crate::config::get_store_dat_setting(app).appearance.transparency {
        Some(tauri::webview::Color(0, 0, 0, 0))
    } else {
        crate::config::window_background(crate::config::get_dsh_theme(app), window.theme().ok())
    };
    let Some(color) = background else {
        return;
    };
    if let Err(error) = window.as_ref().set_background_color(Some(color)) {
        log::debug!("[theme] window background color not applied: {error}");
    }
}

/// 以壳层 `index.html` 再开一个独立 webview 窗口（`文件 → 新建窗口` 与 SSH 远端
/// 弹窗共用的建窗真值）：与主窗口共用同一份平台 chrome、外链/下载接管、
/// （Windows）WebView2 用户数据目录与按窗口注入的桥脚本，但**不**参与主窗口
/// 几何恢复与落盘（`on_window_event` 只对 `MAIN_WINDOW_LABEL` 采样）。
///
/// 只能在异步运行时的命令任务里调用（与 `pet::ensure_pet_window` 同样的约束：
/// `WebviewWindowBuilder::build()` 需要主线程事件循环回包，主线程调用会死锁）。
pub fn build_shell_window(
    app: &tauri::AppHandle<Wry>,
    label: String,
    title: &str,
) -> tauri::Result<tauri::WebviewWindow<Wry>> {
    let app_handle = app.clone();

    let webview_builder = with_shell_chrome(
        app,
        WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into())).title(title),
    )?;

    // 非 Windows 平台没有 WebView2 的 FrameCreated/ContentLoading 流程，兼容桥、
    // 通知桥、剪贴板图片桥、帧内日志桥与 boot 探测桥必须按窗口重新注入（与主窗口一致）。
    #[cfg(not(windows))]
    let webview_builder = with_shell_scripts(webview_builder);

    let webview_builder = webview_builder
        .disable_drag_drop_handler()
        .on_new_window(move |url, features| on_new_window(app_handle.clone(), url, features))
        .on_download(on_download);

    #[cfg(windows)]
    let webview_builder = {
        // 每个窗口各自持有登记标志：通知权限处理器按 webview 注册。
        let notification_handlers_registered = Arc::new(AtomicBool::new(false));
        webview_builder.on_page_load(move |webview_window, payload| {
            on_page_load(
                webview_window,
                payload,
                notification_handlers_registered.clone(),
            )
        })
    };

    let window = webview_builder.build()?;
    #[cfg(windows)]
    apply_windows_window_icon(&window);
    apply_window_background(app, &window);

    // 启动/真值变化时由主窗口应用缩放；新窗口需要自己应用一次当前真值。
    let zoom_factor = crate::config::get_store_dat_setting(app).zoom_factor;
    if zoom_factor != crate::config::default_zoom_factor() {
        if let Err(error) = crate::desktop::zoom::apply_native_zoom(&window, zoom_factor) {
            log::warn!("[zoom] extra window zoom was not applied: {error}");
        }
    }
    let _ = window.set_focus();

    Ok(window)
}

/// 「文件 → 新建窗口」：`window-<N>` 序号 label，chrome 全部取 `build_shell_window`。
pub fn build_extra_window(app: &tauri::AppHandle<Wry>) -> tauri::Result<tauri::WebviewWindow<Wry>> {
    let sequence = EXTRA_WINDOW_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    build_shell_window(
        app,
        format!("window-{sequence}"),
        crate::desktop::product_name(app),
    )
}

#[cfg(all(test, windows))]
mod tests {
    use super::{load_exe_icons, WINDOWS_DRAG_BROWSER_ARGS};
    use windows_sys::Win32::UI::WindowsAndMessaging::DestroyIcon;

    #[test]
    fn windows_drag_args_enable_touch_drag_and_disable_overscroll() {
        let args = WINDOWS_DRAG_BROWSER_ARGS;
        assert!(args.contains("--enable-features=msWebView2EnableDraggableRegions"));
        assert!(args.contains("--disable-features=ElasticOverscroll"));
        assert!(args.contains("msWebOOUI,msPdfOOUI"));
        let smart_screen = ["ms", "SmartScreen", "Protection"].concat();
        assert!(!args.contains(smart_screen.as_str()));
    }

    /// 任务栏大图标依赖 `ExtractIconExW`（issue #744）。测试二进制自己带不带图标资源
    /// 不确定，换一个必然有图标组的系统 DLL 验证提取路径，并确认大/小两枚句柄都在。
    #[test]
    fn exe_icon_group_yields_large_and_small_handles() {
        let root = std::env::var("SystemRoot").expect("SystemRoot must be set on Windows");
        let shell32 = std::path::Path::new(&root)
            .join("System32")
            .join("shell32.dll");
        let (large, small) =
            load_exe_icons(&shell32).unwrap_or_else(|| panic!("no icon group in shell32.dll"));
        assert!(!large.is_null() && !small.is_null());
        assert_ne!(large, small, "大/小图标不应是同一个句柄");
        unsafe {
            DestroyIcon(large);
            DestroyIcon(small);
        }

        assert!(load_exe_icons(std::path::Path::new("C:/dsh-missing-icon.exe")).is_none());
    }
}

/// 壳层导航栏高度是「前端高度类 ↔ 后端交通灯位置」的隐式耦合点（issue #524）。
/// 这里把它变成显式契约：改一边忘了另一边，三个平台的 CI 都会直接失败。
#[cfg(test)]
mod shell_nav_tests {
    use super::SHELL_NAV_HEIGHT;
    use std::path::PathBuf;

    /// Tailwind 4 的间距刻度步长：`h-N` = N × 0.25rem = N × 4px
    /// （本仓库未覆盖 `--spacing`，见 `src/styles/main.css`）。
    const TAILWIND_SPACING_PX: u32 = 4;

    #[test]
    fn shell_nav_height_matches_navbar_height_class() {
        let path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/layout/components/navbar.tsx");
        let source = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("read {} failed: {error}", path.display()));

        // 只匹配导航栏根元素那串 class（`relative flex h-N w-full flex-none …`），
        // 免得命中窗口按钮的 `h-6` 等其他高度类。
        let pattern = regex::Regex::new(r"relative flex h-(\d+) w-full flex-none").unwrap();
        let captures = pattern.captures(&source).unwrap_or_else(|| {
            panic!(
                "{} 里找不到导航栏根元素的 `relative flex h-N w-full flex-none` class；\
                 若换了高度类的写法，请同步本测试",
                path.display()
            )
        });
        let steps: u32 = captures[1].parse().expect("h-N 的 N 必须是整数");

        assert_eq!(
            steps * TAILWIND_SPACING_PX,
            SHELL_NAV_HEIGHT,
            "navbar.tsx 的 h-{steps}（{}px）与 SHELL_NAV_HEIGHT（{SHELL_NAV_HEIGHT}px）不一致：\
             macOS 交通灯纵向位置由 SHELL_NAV_HEIGHT 推导，改栏高必须两处同步（issue #524）",
            steps * TAILWIND_SPACING_PX,
        );
    }
}

#[cfg(test)]
mod menu_tests {
    use super::{fullscreen_menu_label_key, menu_action_window_label};
    use crate::desktop::pet::PET_WINDOW_LABEL;

    #[test]
    fn menu_actions_prefer_the_focused_shell_window_in_any_iteration_order() {
        let windows = [
            ("main", false),
            ("window-1", true),
            (PET_WINDOW_LABEL, false),
        ];
        assert_eq!(menu_action_window_label(windows), Some("window-1"));
        assert_eq!(
            menu_action_window_label(windows.into_iter().rev()),
            Some("window-1")
        );
    }

    #[test]
    fn menu_actions_target_main_when_it_is_focused() {
        assert_eq!(
            menu_action_window_label([("main", true), ("window-1", false)]),
            Some("main")
        );
    }

    #[test]
    fn menu_actions_fall_back_to_main_when_only_the_pet_is_focused() {
        assert_eq!(
            menu_action_window_label([
                (PET_WINDOW_LABEL, true),
                ("window-1", false),
                ("main", false)
            ]),
            Some("main")
        );
    }

    #[test]
    fn menu_actions_fall_back_to_main_when_all_windows_are_unfocused() {
        assert_eq!(
            menu_action_window_label([("window-1", false), ("main", false)]),
            Some("main")
        );
    }

    #[test]
    fn menu_actions_target_a_focused_secondary_window_without_main() {
        assert_eq!(
            menu_action_window_label([("window-1", true)]),
            Some("window-1")
        );
    }

    #[test]
    fn menu_actions_have_no_target_without_a_focused_shell_or_main() {
        assert_eq!(
            menu_action_window_label([(PET_WINDOW_LABEL, true), ("window-1", false)]),
            None
        );
        assert_eq!(menu_action_window_label([]), None);
    }

    #[test]
    fn fullscreen_menu_label_tracks_native_fullscreen_state() {
        assert_eq!(fullscreen_menu_label_key(false), "menu.enter_fullscreen");
        assert_eq!(fullscreen_menu_label_key(true), "menu.exit_fullscreen");
    }
}

#[cfg(test)]
mod security_tests {
    use serde_json::Value;

    fn capability() -> Value {
        serde_json::from_str(include_str!("../../capabilities/default.json")).unwrap()
    }

    #[test]
    fn remote_capability_allows_only_loopback_harness() {
        let capability = capability();
        // 允许被远程页承载的 origin 只有本机回环：远程页面不得驱动任意 Tauri command。
        let urls = capability["remote"]["urls"]
            .as_array()
            .expect("remote.urls must be an array");
        assert!(!urls.is_empty(), "remote.urls must not be empty");
        for url in urls {
            let url = url.as_str().expect("remote urls must be strings");
            assert!(
                url.starts_with("http://127.0.0.1:"),
                "unexpected remote origin: {url}"
            );
        }
    }

    #[test]
    fn native_appearance_effects_are_local_shell_only() {
        let appearance: Value =
            serde_json::from_str(include_str!("../../capabilities/appearance-effects.json")).unwrap();
        // 这个能力一旦带上 remote，就会把窗口级 setEffects 暴露给回环承载的 Harness 页面。
        assert!(appearance.get("remote").is_none());

        let default_permissions = capability()["permissions"]
            .as_array()
            .expect("permissions must be an array")
            .clone();
        assert!(!default_permissions.iter().any(|permission| {
            permission.as_str() == Some("core:window:allow-set-effects")
        }));
    }

    #[test]
    fn pet_http_scope_is_limited_to_remote_asset_hosts() {
        // 桌宠窗口经插件版 fetch 直连远端素材（绕开 githubusercontent 的 CORS），
        // 但 scope 必须收口到素材主机：出现任意 https 通配等于把插件 fetch 面
        // 整个开放给桌宠窗口。
        let capability = capability();
        let permissions = capability["permissions"]
            .as_array()
            .expect("permissions must be an array");
        let mut scoped: Vec<String> = Vec::new();
        for permission in permissions {
            let Some(allow) = permission.get("allow").and_then(Value::as_array) else {
                continue;
            };
            for entry in allow {
                if let Some(url) = entry.get("url").and_then(Value::as_str) {
                    scoped.push(url.to_string());
                }
            }
        }
        assert_eq!(
            scoped,
            vec!["https://*.githubusercontent.com/*".to_string()]
        );
    }

    #[test]
    fn remote_popup_windows_are_scoped_by_glob_and_stay_loopback() {
        let capability = include_str!("../../capabilities/default.json");
        // 弹窗窗口 label 为 remote-<machineId>（machineId 是 uuid），只能以
        // glob 覆盖；不接受裸 "remote-" 或 "*" 之类的过度放宽。
        assert!(capability.contains("\"remote-*\""));
        assert!(!capability.contains("\"*\""));
        // remote URL 面仍然只有 loopback 通配（弹窗与主窗口同一约束）。
        let wildcard_loopback = ["http://127.0.0.1:", "*"].concat();
        assert!(capability.contains(wildcard_loopback.as_str()));
    }

    #[test]
    fn webview_security_features_are_not_disabled() {
        let source = include_str!("builder.rs");
        let smart_screen = ["ms", "SmartScreen", "Protection"].concat();
        assert!(!source.contains(smart_screen.as_str()));
    }
}

#[cfg(test)]
mod macos_bundle_tests {
    use serde_json::Value;

    /// issue #214：macOS 的麦克风授权完全落在打包配置上——iframe `allow`
    /// 与 WebView2 侧权限已由 PR #216 修复，macOS 还缺「用途说明 + 签名授权」，
    /// 两者缺任何一个，内嵌 WKWebView 里的 `getUserMedia` 都拿不到流
    /// （缺用途说明时 TCC 直接终止进程，连授权框都不弹）。
    #[test]
    fn macos_media_capture_permissions_are_declared() {
        let config: Value = serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        let macos = &config["bundle"]["macOS"];
        assert_eq!(
            macos["hardenedRuntime"].as_bool(),
            Some(true),
            "entitlements 只在开启 Hardened Runtime 的签名上生效"
        );
        // 相对路径按 bundle 时的 CWD（src-tauri）解析。
        assert_eq!(macos["infoPlist"].as_str(), Some("Info.plist"));
        assert_eq!(macos["entitlements"].as_str(), Some("Entitlements.plist"));

        // 用带 <key> 的完整标签匹配，避免注释里出现的键名让断言蒙混过关。
        let info_plist = include_str!("../../Info.plist");
        assert!(info_plist.contains("<key>NSMicrophoneUsageDescription</key>"));
        assert!(info_plist.contains("<key>NSCameraUsageDescription</key>"));

        let entitlements = include_str!("../../Entitlements.plist");
        assert!(entitlements.contains("<key>com.apple.security.device.audio-input</key>"));
        assert!(entitlements.contains("<key>com.apple.security.device.camera</key>"));
    }

    /// plist 语法只有 macOS 的 `plutil` 能权威校验（Rust 侧没有 plist 依赖），
    /// 放在现有 macOS CI 上跑，免得打包/公证阶段才发现坏文件。
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_bundle_plists_are_valid() {
        for file in ["Info.plist", "Entitlements.plist"] {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(file);
            let output = std::process::Command::new("plutil")
                .arg("-lint")
                .arg(&path)
                .output()
                .expect("plutil must be available on macOS");
            assert!(
                output.status.success(),
                "plutil -lint {} failed: {}{}",
                path.display(),
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }
}

// configure invoke handler
pub fn handler() -> impl Fn(Invoke<Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        crate::bridge::install_dependencies,
        crate::bridge::check_dsh_update,
        crate::bridge::launch_harness,
        crate::bridge::shutdown_harness,
        crate::bridge::restart_harness,
        crate::bridge::enter_safe_mode,
        crate::bridge::quarantine_broken_patch_layers,
        crate::bridge::strip_unresolved_patch_entries,
        crate::bridge::get_dsh_status,
        crate::bridge::get_task_manager_processes,
        crate::bridge::end_task_manager_process,
        crate::bridge::is_dev_build,
        crate::bridge::get_preinstall_plugins,
        crate::bridge::get_preinstall_pending,
        crate::bridge::install_preinstall_plugins,
        crate::bridge::install_plugin_specs,
        crate::bridge::inspect_plugin_specs,
        crate::bridge::get_local_plugin_hmr,
        crate::bridge::set_local_plugin_hmr,
        crate::bridge::pick_local_plugin_dir,
        crate::bridge::cancel_plugin_processes,
        crate::bridge::allow_plugin_versions,
        crate::bridge::allow_plugin_policy_versions,
        crate::bridge::skip_preinstall_plugins,
        crate::bridge::ensure_internal_plugins,
        crate::bridge::cancel_internal_plugins,
        crate::bridge::open_preinstall_repo,
        crate::bridge::get_dsh_plugins,
        crate::bridge::refresh_plugin_updates,
        crate::bridge::update_dsh_plugins,
        crate::bridge::remove_dsh_plugins,
        crate::bridge::disable_dsh_plugin,
        crate::bridge::enable_dsh_plugin,
        crate::bridge::snapshot_plugin,
        crate::bridge::snapshot_plugins,
        crate::bridge::get_plugin_backup,
        crate::bridge::restore_plugin,
        crate::bridge::delete_plugin_backup,
        crate::bridge::report_plugin_error,
        crate::bridge::detect_plugin_recovery,
        crate::bridge::recover_plugin,
        crate::bridge::get_profiles,
        crate::bridge::create_profile,
        crate::bridge::set_active_profile,
        crate::bridge::remove_profile,
        crate::bridge::reset_profile,
        crate::bridge::clone_profile,
        crate::bridge::analyze_profile_migration,
        crate::bridge::migrate_profile_data,
        crate::bridge::backup_profile,
        crate::bridge::export_recovery_backup,
        crate::bridge::restore_profile,
        crate::bridge::list_backups,
        crate::bridge::delete_backup,
        crate::bridge::get_cores,
        crate::bridge::set_active_core,
        crate::bridge::download_core,
        crate::bridge::remove_core,
        crate::bridge::update_local_core,
        crate::bridge::proxy_health_check,
        crate::bridge::harness_ownership,
        crate::bridge::get_runtime_info,
        crate::bridge::runtime_ready,
        crate::bridge::get_app_config,
        crate::bridge::update_app_config,
        crate::bridge::get_effective_heap_limit_mb,
        crate::bridge::test_proxy,
        crate::bridge::get_launch_on_login,
        crate::bridge::set_launch_on_login,
        crate::bridge::get_cli_link_status,
        crate::bridge::open_in_browser,
        crate::bridge::copy_service_url,
        crate::bridge::reveal_data_dir,
        crate::bridge::get_data_dir_status,
        crate::bridge::pick_data_dir,
        crate::bridge::list_data_dir_entries,
        crate::bridge::preview_data_dir_migration,
        crate::bridge::migrate_data_dir,
        crate::bridge::rollback_data_dir,
        crate::bridge::reveal_in_folder,
        crate::bridge::open_dir,
        crate::bridge::read_service_logs,
        crate::bridge::read_run_logs,
        crate::bridge::clear_service_logs,
        crate::bridge::set_language,
        crate::bridge::toggle_sidebar,
        crate::bridge::get_dsh_theme,
        crate::bridge::check_desktop_update,
        crate::bridge::download_desktop_update,
        crate::bridge::open_desktop_installer,
        crate::bridge::get_desktop_about,
        crate::bridge::open_external_url,
        crate::bridge::read_clipboard_image,
        crate::bridge::read_clipboard_text,
        crate::bridge::write_clipboard_text,
        crate::desktop::window::create_app_window,
        crate::desktop::builder::sync_view_menu,
        crate::desktop::window::quit_app,
        crate::desktop::window::toggle_devtools,
        crate::bridge::log_frontend,
        crate::bridge::get_pet_status,
        crate::bridge::get_pet_overlay_supported,
        crate::bridge::get_force_xwayland,
        crate::bridge::set_force_xwayland,
        crate::bridge::set_pet_enabled,
        crate::bridge::set_active_pet,
        crate::bridge::set_pet_size,
        crate::bridge::set_pet_throw_enabled,
        crate::bridge::push_pet_session,
        crate::bridge::move_pet_window,
        crate::bridge::persist_pet_window_position,
        crate::bridge::set_pet_ignore_cursor_events,
        crate::bridge::list_pets,
        crate::bridge::import_pet,
        crate::bridge::get_pet_asset,
        crate::bridge::list_preset_pets,
        crate::desktop::pet_mouse::start_pet_mouse_stream,
        crate::bridge::remote::remote,
        crate::bridge::remote_bridge_ping,
        crate::bridge::remote_open_window,
    ]
}

fn menu_action_window_label<'a>(
    windows: impl IntoIterator<Item = (&'a str, bool)>,
) -> Option<&'a str> {
    let mut main = None;
    for (label, focused) in windows {
        if label == crate::desktop::pet::PET_WINDOW_LABEL {
            continue;
        }
        if focused {
            return Some(label);
        }
        if label == MAIN_WINDOW_LABEL {
            main = Some(label);
        }
    }
    main
}

pub fn builder() -> tauri::Builder<tauri::Wry> {
    let mut builder = tauri::Builder::default();

    // E2E：内嵌 WebDriver server 只在 E2E 进程装配（`@wdio/tauri-service` 拉起应用时注入
    // TAURI_WEBDRIVER_PORT）。插件一旦注册就会无条件监听 127.0.0.1:4445，并接管每个 webview
    // 的 script dialog（默认弹窗被禁用，转成等 WebDriver 应答、最长 30s 的 pending alert）；
    // 正常 dev/release 会话既不该开这个端口，也不该动用户的弹窗与文件选择。
    if crate::config::is_e2e_run() {
        builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    }

    let builder = builder
        .manage(crate::desktop::pet_mouse::PetMouseStreamState::default())
        .setup(|app| {
            let app_handle = app.handle().clone();
            crate::desktop::autostart::init(&app_handle)?;
            // 首装检测必须最先执行：窗口几何恢复/退出保存等任何 store 写入都会
            // 创建 store 文件，判定晚于它们会把首装误判为升级（见
            // config::detect_first_install 的时序说明）。
            crate::config::detect_first_install(&app_handle);
            build_main_window(&app_handle)?;
            #[cfg(target_os = "macos")]
            install_macos_menu(&app_handle)?;
            tray(&app_handle)?;
            // 桌宠窗口：按「是否启用」设置惰性创建/显示（幂等）。
            crate::desktop::pet::init_pet_window(&app_handle);
            setup(app_handle.clone());
            // 方案 1（host → rust → pet）：Rust 作为宿主会话增量 SSE 流的消费者，
            // 不再依赖 iframe 的 invoke 桥转发（#396 根因）。断连自动重连；
            // 仅当桌宠已启用且可见才订阅——关闭桌宠则宿主不做任何转发。
            crate::bridge::pet::sync_pet_session_stream(
                &app_handle,
                crate::bridge::pet::pet_stream_wanted(&app_handle),
            );
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "desktop-toggle-sidebar"
            | "desktop-toggle-right-panel"
            | "desktop-open-terminal"
            | "desktop-search-chats"
            | "desktop-zoom-in"
            | "desktop-zoom-out"
            | "desktop-zoom-reset"
            | "desktop-task-manager" => {
                if let Some(window) = app.webview_windows().into_values().find(|window| {
                    window.label() != crate::desktop::pet::PET_WINDOW_LABEL
                        && window.is_focused().unwrap_or(false)
                }) {
                    if let Err(error) =
                        app.emit_to(window.label(), "macos-menu-action", event.id().as_ref())
                    {
                        log::warn!("[menu] failed to emit View action: {error}");
                    }
                }
            }
            "desktop-documentation" | "desktop-feedback" | "desktop-harness-feedback" => {
                let windows = app.webview_windows();
                let target = help_menu_window_label(
                    windows
                        .values()
                        .map(|window| (window.label(), window.is_focused().unwrap_or(false))),
                );
                if let Some(label) = target {
                    if let Err(error) = app.emit_to(label, "macos-menu-action", event.id().as_ref())
                    {
                        log::warn!("[menu] failed to emit Help action: {error}");
                    }
                } else {
                    log::warn!("[menu] HELP_WINDOW_NOT_FOUND");
                }
            }
            #[cfg(target_os = "macos")]
            "desktop-fullscreen" => {
                if let Some(window) = app.webview_windows().into_values().find(|window| {
                    window.label() != crate::desktop::pet::PET_WINDOW_LABEL
                        && window.is_focused().unwrap_or(false)
                }) {
                    if let Err(error) = window
                        .is_fullscreen()
                        .and_then(|is_fullscreen| window.set_fullscreen(!is_fullscreen))
                    {
                        log::warn!("[menu] FULLSCREEN_TOGGLE_FAILED: {error}");
                    }
                }
            }
            "desktop-config"
            | "desktop-profiles"
            | "desktop-plugins"
            | "desktop-harness"
            | "desktop-about"
            | "desktop-copy-run-logs"
            | "desktop-toggle-devtools"
            | "desktop-check-update"
            | "desktop-restart"
            | "desktop-keyboard-shortcuts"
            | "desktop-new-window"
            | "desktop-new-chat"
            | "desktop-open-folder" => {
                let windows = app.webview_windows();
                let target = menu_action_window_label(
                    windows
                        .values()
                        .map(|window| (window.label(), window.is_focused().unwrap_or(false))),
                );
                if let Some(label) = target {
                    if let Err(error) = app.emit_to(label, "macos-menu-action", event.id().as_ref())
                    {
                        log::warn!("[menu] failed to emit macOS menu action: {error}");
                    }
                } else {
                    log::warn!("[menu] MENU_WINDOW_NOT_FOUND: {}", event.id().as_ref());
                }
            }
            _ => {}
        })
        // 关闭行为由设置项 `setting.close_action` 控制（D-08 / D-09）：
        // - quit：关窗即完整退出进程，不驻留托盘、不切 Accessory；
        // - tray（默认）：阻止关闭，应用级 hide（Cmd+H 语义）并切 Accessory 隐藏 Dock。
        // 退出分支**故意不加** `#[cfg(target_os = "macos")]` 门控 —— 「关闭窗口＝
        // 退出应用」是用户可选项，语义上应当三平台一致，不是 macOS 专属；而
        // `activation::on_window_hidden` 仅在 macOS 上有实现，故它保留 macOS 门控。
        // 点击关闭按钮时按设置决定：隐藏到托盘驻留，还是完整退出程序
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                if window.label() == crate::desktop::pet::PET_WINDOW_LABEL {
                    // 桌宠窗口没有装饰按钮，但 Alt+F4 / 系统关闭仍会走到这里：语义等同
                    // 「关闭宠物」——持久化 enabled=false 并销毁窗口（与会话流一起收口）。
                    // 走命令本身而不是内部函数：关闭是持久动作，重启后不该再自己起来。
                    api.prevent_close();
                    let handle = window.app_handle().clone();
                    if let Err(error) = crate::bridge::pet::set_pet_enabled(handle, false) {
                        log::warn!("[pet] PET_WINDOW_DESTROY_FAILED: {error}");
                    }
                    return;
                }
                // 主窗口以外的附加窗口（「文件 → 新建窗口」）不驻留托盘：直接关闭
                // 销毁。隐藏它们既没有恢复入口，也不符合「关掉这个窗口」的直觉。
                if window.label() != MAIN_WINDOW_LABEL {
                    return;
                }
                // get_store_dat_setting 内部已归一化，取值只可能是 tray 或 quit
                let close_action =
                    crate::config::get_store_dat_setting(window.app_handle()).close_action;
                if close_action == crate::config::CLOSE_ACTION_QUIT {
                    // 不 prevent_close、不 hide：直接退出。app.exit(0) 会走
                    // RunEvent::ExitRequested，既有的几何保存逻辑照常触发
                    window.app_handle().exit(0);
                    return;
                }
                api.prevent_close();
                // macOS 上隐藏不能用窗口级 orderOut（window.hide()）：应用隐藏
                // 最后一个窗口后会被系统在 ~1.5s 后发 quit Apple Event 终止
                // （macOS 26/27 对「无可见窗口」应用的回收行为）。正确顺序：
                // 先切 Accessory（此时窗口仍可见，避免 Accessory 下 show 的
                // tauri #5122 问题），再用应用级 hide（Cmd+H 语义）—— 系统不会
                // 回收 hide: 隐藏的应用。恢复路径见 utils::show_main_window 的
                // app.show()（unhide）配对。
                #[cfg(target_os = "macos")]
                {
                    crate::desktop::activation::on_window_hidden(window, &close_action);
                    if let Err(error) = window.app_handle().hide() {
                        // 应用级 hide 失败（理论不发生）时**保持窗口可见**：
                        // 窗口级 hide() 是 orderOut，会落入 macOS 26/27 对
                        // 「无可见窗口」应用的 ~1.5s quit 回收 —— 比可见窗口
                        // 更糟。可见窗口是严格更安全的降级态。
                        // 同时回退到 Regular 策略：on_window_hidden 已切到 Accessory，
                        // hide 失败意味着应用实际未隐藏，若不恢复 Regular 会丢失 Dock
                        // 与 Cmd-Tab 入口。
                        // hide 失败意味着应用仍停留在 Accessory（on_window_hidden
                        // 已提前切过去），可见窗口配合消失的 Dock/⌘-Tab 会让用户
                        // 无法将应用拉回前台，故这里必须切回 regular 恢复 Dock。
                        crate::desktop::activation::set_regular_policy(window.app_handle());
                        log::error!("[activation] APP_HIDE_FAILED: {error}");
                    }
                }
                #[cfg(not(target_os = "macos"))]
                let _ = window.hide();
            }
            tauri::WindowEvent::ScaleFactorChanged { .. } => {
                if window.label() == crate::desktop::pet::PET_WINDOW_LABEL {
                    crate::desktop::pet::apply_pet_size(window.app_handle());
                }
            }
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                match window.label() {
                    label if label == crate::desktop::pet::PET_WINDOW_LABEL => {
                        crate::desktop::pet::save_pet_window_geometry(window);
                    }
                    label if label == MAIN_WINDOW_LABEL => crate::config::save_geometry(window),
                    _ => {}
                }
                #[cfg(target_os = "macos")]
                {
                    if matches!(event, tauri::WindowEvent::Resized(_)) {
                        // 全屏文案跟随聚焦的壳层窗口，Accessory 切换仍只处理主窗口。
                        sync_macos_fullscreen_menu(window);
                        if window.label() == MAIN_WINDOW_LABEL {
                            // 退出全屏后补做全屏期间被推迟的 Accessory 切换。
                            crate::desktop::activation::on_window_resized(window);
                        }
                    }
                }
            }
            #[cfg(target_os = "macos")]
            tauri::WindowEvent::Focused(true) => sync_macos_fullscreen_menu(window),
            _ => {}
        });

    // 单例模式：多次双击图标（或重复启动）时不会新开窗口，而是把
    // 已存在的（可能已隐藏到托盘）主窗口调到前台，实现“单例 + 复用后台窗口”。
    // 该回调在首次启动时也会以当前进程的参数触发一次（幂等，仅 show/focus），
    // 之后每次二次启动都会派发到这里，重新展示后台运行的主窗口。
    // 仅在生产环境（release）启用：debug 开发调试时若启用单例，
    // 二次启动的调试进程会被吞掉（例如 tauri dev 多实例调试），
    // 因此开发环境跳过该插件。
    // `deep-link` feature 只在单例在场时起作用：把二次启动携带的 `dsh://` URL
    // （成功页「打开应用」按钮）转发给主实例派发 open-url。
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        crate::utils::show_main_window(app);
    }));

    // Windows/WebView2 上 wry 忽略 `for_main_frame_only`、把每个初始化脚本注入所有子 frame，
    // 而 Tauri 只在 main frame 定义 `window.__TAURI_INTERNALS__`；dsh GUI 所在的跨源 iframe
    // 因此每次加载都抛 `path` 插件脚本的 "reading 'plugins'"。垫片注册在最前面，保证排在
    // core 插件（path 在其中）之前执行，只补骨架、不碰 isTauri（见 desktop::tauri_internals）。
    #[cfg(windows)]
    let builder = builder.plugin(crate::desktop::tauri_internals::shim());

    let builder = builder
        // Opener plugin
        .plugin(tauri_plugin_opener::init())
        // Notification plugin（官方插件）：权限查询等通用通知能力。
        .plugin(tauri_plugin_notification::init())
        // FS plugin
        .plugin(tauri_plugin_fs::init())
        // HTTP plugin：桌宠窗口拉取远端宠物素材时把 fetch 交给 Rust 发起，
        // 绕开 raw.githubusercontent.com 不返回 CORS 头导致的浏览器拦截。
        .plugin(tauri_plugin_http::init())
        // Simple Store plugin
        .plugin(tauri_plugin_store::Builder::new().build())
        // OS plugin：前端据此判断系统版本（macOS 10.15 没有 `WKWebView.pageZoom`，
        // 不能把缩放应用到 WebView），见 `hooks/use-zoom-factor.ts`。
        .plugin(tauri_plugin_os::init());

    // Notifications plugin（Choochmeque fork）：壳层发带交互按钮的通知，并通过
    // `onNotificationClicked` / `onAction` 收点击与按钮动作——官方插件在桌面端 `show()`
    // 之后即丢弃 handle，拿不到这两类事件。macOS 上它需要 Xcode 16+（Swift 6 typed throws），
    // CI 见 .github/workflows/ci.yml 的 `Select Xcode 16`。
    //
    // macOS 上它还要求进程跑在 `.app` 包内（`UNUserNotificationCenter` 的前置条件，见 vendor 的
    // `macos::validation::require_bundle`）：`tauri dev` 跑的是裸二进制，注册它会让插件初始化
    // 直接报错、整个应用起不来，所以未打包时跳过这条通路（打包后自动生效）。
    #[cfg(target_os = "macos")]
    let in_app_bundle = std::env::current_exe()
        .map(|exe| exe.to_string_lossy().contains(".app/Contents/MacOS/"))
        .unwrap_or(false);
    #[cfg(not(target_os = "macos"))]
    let in_app_bundle = true;
    let builder = if in_app_bundle {
        builder.plugin(tauri_plugin_notifications::init())
    } else {
        log::warn!(
            "未运行在 .app 包内，跳过 tauri-plugin-notifications：macOS 的系统通知需要 .app 包，\
             打包后自动生效"
        );
        builder
    };

    // `dsh://` 深链（成功页「打开应用」按钮）只在打包态启用：debug 注册会把系统
    // `dsh:` 指向调试产物，与官方 Electron 的 `app.isPackaged` 门禁一致。
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_deep_link::init());

    builder
}
