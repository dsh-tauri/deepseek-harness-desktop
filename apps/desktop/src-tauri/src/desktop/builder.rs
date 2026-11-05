#[cfg(target_os = "macos")]
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(any(windows, target_os = "macos"))]
use std::sync::OnceLock;
use tauri::{Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder, ipc::Invoke};
use tauri_runtime_electron::ElectronRuntime;

#[cfg(windows)]
use windows_sys::Win32::UI::{
    Shell::ExtractIconExW,
    WindowsAndMessaging::{HICON, ICON_BIG, ICON_SMALL, SendMessageW, WM_GETICON, WM_SETICON},
};

use tauri::menu::{Menu, MenuEvent, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

#[cfg(target_os = "macos")]
use tauri::menu::{PredefinedMenuItem, Submenu};

#[cfg(target_os = "macos")]
static MACOS_FULLSCREEN_MENU_ITEM: OnceLock<Mutex<Option<MenuItem<ElectronRuntime>>>> =
    OnceLock::new();

#[cfg(target_os = "macos")]
const MACOS_VIEW_COMMANDS: [(&str, &str); 4] = [
    ("desktop-toggle-sidebar", "menu.toggle_sidebar"),
    ("desktop-toggle-right-panel", "menu.toggle_right_panel"),
    ("desktop-open-terminal", "menu.open_terminal"),
    ("desktop-search-chats", "menu.search_chats"),
];

use crate::utils::show_main_window;

pub const SHELL_NAV_HEIGHT: u32 = 44;

#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_INSET_X: f64 = 18.0;

#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_VISUAL_OFFSET: f64 = 2.0;

pub const MAIN_WINDOW_LABEL: &str = "main";

static EXTRA_WINDOW_SEQ: AtomicU64 = AtomicU64::new(0);

pub fn setup(app_handle: crate::AppHandle) {
    if let Err(e) = crate::service::plugin::remove_legacy_bundled_plugins(&app_handle) {
        log::warn!("legacy bundled plugins cleanup skipped: {e}");
    }

    crate::service::workflow::sweep_orphan_harness(&app_handle);

    // 独立 Node 运行时已废弃：清掉历史安装留下的 `$AppData/runtime`，避免它以
    // 陈旧文件继续被诊断信息或用户误认为有效运行时。
    if let Err(e) = crate::service::migrate::remove_legacy_node_runtime(&app_handle) {
        log::warn!("legacy node runtime cleanup skipped: {e}");
    }

    let dsh_home = crate::config::get_dsh_data_path(&app_handle);
    if let Err(e) = crate::service::migrate::heal_stale_pnpm_metadata(&dsh_home) {
        log::warn!("pnpm modules metadata self-heal skipped: {e}");
    }

    crate::service::profile::ensure_desktop_profile(&app_handle);

    crate::service::workflow::instances::window_profile(&app_handle, MAIN_WINDOW_LABEL);
    crate::service::scheduler::start(&app_handle);

    #[cfg(not(debug_assertions))]
    crate::desktop::deep_link::init(&app_handle);

    let app_for_start = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        let setting = crate::config::get_store_dat_setting(&app_for_start);
        if !setting.auto_start {
            log::debug!("auto_start disabled, skipping startup");
            return;
        }
        let profile = crate::service::workflow::instances::window_profile(
            &app_for_start,
            MAIN_WINDOW_LABEL,
        );
        if let Err(e) = crate::service::workflow::instances::scope(
            profile,
            crate::service::workflow::start(app_for_start),
        )
        .await
        {
            log::error!("start failed: {}", e);
        }
    });

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

pub fn tray<R: Runtime>(app: &crate::AppHandle<R>) -> tauri::Result<()> {
    #[cfg(target_os = "linux")]
    if let Err(error) = build_tray(app) {
        log::warn!("[tray] LINUX_TRAY_FAILED: {error}");
    }
    #[cfg(not(target_os = "linux"))]
    build_tray(app)?;
    Ok(())
}

fn build_tray<R: Runtime>(app: &crate::AppHandle<R>) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    let icon = tauri::image::Image::from_bytes(include_bytes!("../../icons/macos-tray.png"))?;
    #[cfg(not(target_os = "macos"))]
    let icon = app.default_window_icon().unwrap().clone();

    let open_label = crate::config::i18n::t("menu.open_panel");
    let quit_label = crate::config::i18n::t("menu.quit");
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "open", open_label, true, None::<&str>)?,
            &MenuItem::with_id(app, "quit", quit_label, true, None::<&str>)?,
        ],
    )?;

    fn handle_menu_event<R: Runtime>(app: &crate::AppHandle<R>, event: &MenuEvent) {
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
            button_state: MouseButtonState::Up,
            ..
        } = event
        {
            show_main_window(tray.app_handle());
        }
    }

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

#[cfg(target_os = "macos")]
pub fn install_macos_menu(app: &crate::AppHandle<ElectronRuntime>) -> tauri::Result<()> {
    let setting = crate::config::get_store_dat_setting(app);
    crate::config::i18n::set_language(crate::config::i18n::lang_from_setting(&setting.language));

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
        .get_window("main")
        .and_then(|window| window.is_fullscreen().ok())
        .unwrap_or(false);
    let fullscreen_label = crate::config::i18n::t(fullscreen_menu_label_key(is_fullscreen));
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
    window: crate::Window<ElectronRuntime>,
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
    {
        let _ = window;
        for entry in entries {
            let _ = (entry.id, entry.enabled, entry.shortcut);
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn sync_macos_fullscreen_menu(window: &crate::Window<ElectronRuntime>) {
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

#[cfg(windows)]
fn shared_exe_icons() -> Option<(HICON, HICON)> {
    struct Icons(HICON, HICON);
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

#[cfg(windows)]
fn apply_windows_window_icon(window: &crate::WebviewWindow<ElectronRuntime>) {
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

fn shell_window_transparent(appearance: &crate::config::Appearance) -> bool {
    #[cfg(target_os = "linux")]
    {
        let _ = appearance;
        !crate::shell_window_opaque()
    }
    #[cfg(not(target_os = "linux"))]
    {
        appearance.transparency
    }
}

fn shell_frame_for(transparent: bool) -> bool {
    transparent && (cfg!(target_os = "linux") || cfg!(windows))
}

fn with_shell_chrome<'a>(
    app: &'a crate::AppHandle<ElectronRuntime>,
    builder: WebviewWindowBuilder<'a, ElectronRuntime, crate::AppHandle<ElectronRuntime>>,
) -> tauri::Result<WebviewWindowBuilder<'a, ElectronRuntime, crate::AppHandle<ElectronRuntime>>> {
    let appearance = crate::config::get_store_dat_setting(app).appearance;
    let transparent = shell_window_transparent(&appearance);
    let frame = shell_frame_for(transparent);
    // Linux 的窗口恒为透明窗，透明度只是前端渲染参数，改设置无需重开；
    // Windows / macOS 的透明窗在创建时定型，改动必须重启才生效。
    let live_transparency = cfg!(target_os = "linux");
    let builder = builder
        .transparent(transparent)
        .initialization_script(format!(
            "window.__DSH_TRANSPARENT__ = {transparent}; window.__DSH_FRAME__ = {frame}; \
             window.__DSH_LIVE_TRANSPARENCY__ = {live_transparency}; window.__DSH_STORE_FILE__ = {};",
            serde_json::json!(crate::config::store_dat_file_name())
        ))
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
    let builder = builder.icon(app.default_window_icon().unwrap().clone())?;

    #[cfg(target_os = "linux")]
    let builder = match app.default_window_icon() {
        Some(icon) => builder.icon(icon.clone())?,
        None => builder,
    };

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

pub fn build_main_window(
    app: &crate::AppHandle<ElectronRuntime>,
) -> tauri::Result<crate::WebviewWindow<ElectronRuntime>> {
    let app_handle = app.clone();

    let _geometry_restore = crate::config::GeometryRestoreGuard::begin();

    let webview_builder =
        WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, WebviewUrl::App("index.html".into()))
            .title(crate::desktop::product_name(app));

    #[cfg(windows)]
    let webview_builder = webview_builder.visible(false);

    let webview_builder = with_shell_chrome(app, webview_builder)?;

    let webview_window = webview_builder
        .on_download(crate::desktop::window::on_download)
        .on_permission_request(|_, kind| match kind {
            tauri::webview::PermissionKind::Microphone => tauri::webview::PermissionResponse::Allow,
            _ => tauri::webview::PermissionResponse::Default,
        })
        .build()?;
    tauri_runtime_electron::on_new_window(webview_window.as_ref(), move |url, features| {
        crate::desktop::window::on_new_window(app_handle.clone(), url, features)
    })?;
    #[cfg(windows)]
    apply_windows_window_icon(&webview_window);
    apply_window_background(app, &webview_window);
    let zoom_factor = crate::config::get_store_dat_setting(app).zoom_factor;
    if zoom_factor != crate::config::default_zoom_factor() {
        if let Err(error) = crate::desktop::zoom::apply_native_zoom(&webview_window, zoom_factor) {
            log::warn!("[zoom] startup zoom was not applied: {error}");
        }
    }

    crate::config::restore_main_window(app, &webview_window);
    #[cfg(windows)]
    webview_window.show()?;

    Ok(webview_window)
}

fn apply_window_background(
    app: &crate::AppHandle<ElectronRuntime>,
    window: &crate::WebviewWindow<ElectronRuntime>,
) {
    let appearance = crate::config::get_store_dat_setting(app).appearance;
    let background = if shell_window_transparent(&appearance) {
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

pub fn build_shell_window(
    app: &crate::AppHandle<ElectronRuntime>,
    label: String,
    title: &str,
    path: std::path::PathBuf,
    navigation_script: Option<&str>,
) -> tauri::Result<crate::WebviewWindow<ElectronRuntime>> {
    let app_handle = app.clone();

    let webview_builder = with_shell_chrome(
        app,
        WebviewWindowBuilder::new(app, label, WebviewUrl::App(path)).title(title),
    )?;
    let webview_builder = match navigation_script {
        Some(script) => webview_builder.initialization_script_for_all_frames(script),
        None => webview_builder,
    };

    let window = webview_builder
        .on_download(crate::desktop::window::on_download)
        .on_permission_request(|_, kind| match kind {
            tauri::webview::PermissionKind::Microphone => tauri::webview::PermissionResponse::Allow,
            _ => tauri::webview::PermissionResponse::Default,
        })
        .build()?;
    tauri_runtime_electron::on_new_window(window.as_ref(), move |url, features| {
        crate::desktop::window::on_new_window(app_handle.clone(), url, features)
    })?;
    #[cfg(windows)]
    apply_windows_window_icon(&window);
    apply_window_background(app, &window);

    let zoom_factor = crate::config::get_store_dat_setting(app).zoom_factor;
    if zoom_factor != crate::config::default_zoom_factor() {
        if let Err(error) = crate::desktop::zoom::apply_native_zoom(&window, zoom_factor) {
            log::warn!("[zoom] extra window zoom was not applied: {error}");
        }
    }
    let _ = window.set_focus();

    Ok(window)
}

pub fn build_extra_window(
    app: &crate::AppHandle<ElectronRuntime>,
    path: std::path::PathBuf,
    profile: &str,
    navigation_script: Option<&str>,
) -> tauri::Result<crate::WebviewWindow<ElectronRuntime>> {
    let sequence = EXTRA_WINDOW_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let label = format!("window-{sequence}");
    crate::service::workflow::instances::bind_window(&label, profile);
    let result = build_shell_window(
        app,
        label.clone(),
        crate::desktop::product_name(app),
        path,
        navigation_script,
    );
    if result.is_err() {
        crate::service::workflow::instances::release_window(&label);
    }
    result
}

#[cfg(all(test, windows))]
mod tests {
    use super::load_exe_icons;
    use windows_sys::Win32::UI::WindowsAndMessaging::DestroyIcon;

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

#[cfg(test)]
mod shell_nav_tests {
    use super::SHELL_NAV_HEIGHT;
    use std::path::PathBuf;

    const TAILWIND_SPACING_PX: u32 = 4;

    #[test]
    fn shell_nav_height_matches_navbar_height_class() {
        let path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/layout/components/navbar.tsx");
        let source = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("read {} failed: {error}", path.display()));

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
mod shell_frame_tests {
    use super::shell_frame_for;

    #[test]
    fn transparent_shells_draw_their_own_frame_where_the_os_stops_rounding() {
        assert!(!shell_frame_for(false), "不透明窗沿用系统外框");
        assert_eq!(
            shell_frame_for(true),
            cfg!(target_os = "linux") || cfg!(windows),
            "Windows 透明窗拿不到 DWM 圆角，Linux 没有装饰边框，两边都要壳层自绘"
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
    fn shell_capability_excludes_remote_origins() {
        let capability = capability();
        assert!(capability.get("remote").is_none());
        assert_eq!(capability["local"], true);
    }

    #[test]
    fn native_appearance_effects_are_local_shell_only() {
        let appearance: Value =
            serde_json::from_str(include_str!("../../capabilities/appearance-effects.json"))
                .unwrap();
        assert!(appearance.get("remote").is_none());

        let default_permissions = capability()["permissions"]
            .as_array()
            .expect("permissions must be an array")
            .clone();
        assert!(
            !default_permissions
                .iter()
                .any(|permission| { permission.as_str() == Some("core:window:allow-set-effects") })
        );
    }

    #[test]
    fn pet_http_scope_is_limited_to_remote_asset_hosts() {
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
    fn shell_windows_are_scoped_by_label() {
        let capability = include_str!("../../capabilities/default.json");
        assert!(capability.contains("\"remote-*\""));
        assert!(!capability.contains("\"*\""));
        assert!(capability.contains("\"window-*\""));
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

    #[test]
    fn macos_media_capture_permissions_are_declared() {
        let config: Value = serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        let macos = &config["bundle"]["macOS"];
        assert_eq!(
            macos["hardenedRuntime"].as_bool(),
            Some(true),
            "entitlements 只在开启 Hardened Runtime 的签名上生效"
        );
        assert_eq!(macos["infoPlist"].as_str(), Some("Info.plist"));
        assert_eq!(macos["entitlements"].as_str(), Some("Entitlements.plist"));

        let info_plist = include_str!("../../Info.plist");
        assert!(info_plist.contains("<key>NSMicrophoneUsageDescription</key>"));
        assert!(info_plist.contains("<key>NSCameraUsageDescription</key>"));
        assert!(
            info_plist.contains("<key>LSUIElement</key>") && info_plist.contains("<true/>"),
            "supervisor bundle 只做宿主，Dock 身份必须留给嵌套的 Electron runtime"
        );

        let entitlements = include_str!("../../Entitlements.plist");
        assert!(entitlements.contains("<key>com.apple.security.device.audio-input</key>"));
        assert!(entitlements.contains("<key>com.apple.security.device.camera</key>"));
    }

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

pub fn handler() -> impl Fn(Invoke<ElectronRuntime>) -> bool + Send + Sync + 'static {
    let handler: fn(Invoke<ElectronRuntime>) -> bool = tauri::generate_handler![
        crate::desktop::window::prepare_harness_webview,
        crate::desktop::window::release_harness_webview,
        crate::desktop::window::update_harness_webview,
        crate::desktop::window::capture_harness_webview,
        crate::desktop::window::acquire_browser_guest,
        crate::desktop::window::release_browser_guest,
        crate::bridge::install_dependencies,
        crate::bridge::check_dsh_update,
        crate::bridge::launch_harness,
        crate::bridge::shutdown_harness,
        crate::bridge::restart_harness,
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
        crate::bridge::is_desktop_distro_managed,
        crate::bridge::download_desktop_update,
        crate::bridge::open_desktop_installer,
        crate::bridge::get_desktop_about,
        crate::bridge::open_external_url,
        crate::bridge::open_in_app,
        crate::bridge::read_clipboard_text,
        crate::bridge::write_clipboard_text,
        crate::desktop::window::create_app_window,
        crate::desktop::builder::sync_view_menu,
        crate::desktop::window::quit_app,
        crate::desktop::window::toggle_devtools,
        crate::bridge::log_frontend,
        crate::bridge::get_pet_status,
        crate::bridge::pet_show_main_window,
        crate::bridge::pet_show_context_menu,
        crate::bridge::get_pet_overlay_supported,
        crate::bridge::get_pet_accessibility,
        crate::bridge::request_pet_accessibility,
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
        crate::bridge::set_pet_input_region,
        crate::bridge::list_pets,
        crate::bridge::import_pet,
        crate::bridge::delete_pet,
        crate::bridge::import_pet_repository,
        crate::bridge::check_pet_updates,
        crate::bridge::update_pet_repository,
        crate::bridge::get_pet_asset,
        crate::bridge::list_preset_pets,
        crate::desktop::pet_mouse::start_pet_mouse_stream,
        crate::bridge::remote::remote,
        crate::bridge::remote_bridge_ping,
        crate::bridge::remote_open_window,
    ];
    move |invoke| {
        let webview = invoke.message.webview_ref();
        let allowed = if webview.label() == webview.window().label() {
            crate::desktop::window::require_shell(webview).is_ok()
        } else {
            webview.label().starts_with("harness-")
                && guest_command_allowed(invoke.message.command())
        };
        if !allowed {
            invoke.resolver.reject("HARNESS_WEBVIEW_COMMAND_DENIED");
            return true;
        }
        handler(invoke)
    }
}

fn guest_command_allowed(command: &str) -> bool {
    matches!(
        command,
        "is_dev_build"
            | "acquire_browser_guest"
            | "release_browser_guest"
            | "open_external_url"
            | "open_in_app"
            | "get_pet_status"
            | "get_pet_overlay_supported"
            | "get_force_xwayland"
            | "set_force_xwayland"
            | "set_pet_enabled"
            | "set_active_pet"
            | "set_pet_size"
            | "set_pet_throw_enabled"
            | "push_pet_session"
            | "list_pets"
            | "import_pet"
            | "delete_pet"
            | "import_pet_repository"
            | "check_pet_updates"
            | "update_pet_repository"
            | "get_pet_asset"
            | "list_preset_pets"
            | "remote_bridge_ping"
            | "remote_open_window"
            | "create_app_window"
            | "read_clipboard_text"
            | "write_clipboard_text"
            | "report_plugin_error"
    )
}

#[cfg(test)]
#[test]
fn guest_command_scope_preserves_plugin_actions_and_blocks_shell_control() {
    assert!(guest_command_allowed("create_app_window"));
    assert!(guest_command_allowed("acquire_browser_guest"));
    assert!(guest_command_allowed("release_browser_guest"));
    assert!(guest_command_allowed("open_in_app"));
    assert!(guest_command_allowed("read_clipboard_text"));
    assert!(guest_command_allowed("write_clipboard_text"));
    assert!(guest_command_allowed("report_plugin_error"));
    for command in [
        "prepare_harness_webview",
        "release_harness_webview",
        "update_harness_webview",
        "install_dependencies",
        "quit_app",
        "set_local_plugin_hmr",
    ] {
        assert!(!guest_command_allowed(command));
    }
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

pub fn builder() -> tauri::Builder<ElectronRuntime> {
    let builder = tauri::Builder::<tauri_runtime_electron::ElectronRuntime>::new()
        .plugin(tauri_runtime_electron::init())
        .plugin(tauri_runtime_electron::window::init());

    let builder = builder
        .manage(crate::desktop::pet_mouse::PetMouseStreamState::default())
        .setup(|app| {
            let app_handle = app.handle().clone();
            crate::desktop::autostart::init(&app_handle)?;
            crate::config::detect_first_install(&app_handle);
            build_main_window(&app_handle)?;
            let language = crate::config::get_store_dat_setting(&app_handle).language;
            crate::config::i18n::set_language(crate::config::i18n::lang_from_setting(&language));
            #[cfg(target_os = "macos")]
            install_macos_menu(&app_handle)?;
            tray(&app_handle)?;
            crate::desktop::pet::init_pet_window(&app_handle);
            setup(app_handle.clone());
            crate::bridge::pet::sync_pet_session_stream(
                &app_handle,
                crate::bridge::pet::pet_stream_wanted(&app_handle),
            );
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "pet-show-main-window" => show_main_window(app),
            "pet-close" => {
                if let Err(error) = crate::bridge::set_pet_enabled(app.clone(), false) {
                    log::error!("PET_CLOSE_FAILED: {error}");
                }
            }
            "desktop-toggle-sidebar"
            | "desktop-toggle-right-panel"
            | "desktop-open-terminal"
            | "desktop-search-chats"
            | "desktop-zoom-in"
            | "desktop-zoom-out"
            | "desktop-zoom-reset"
            | "desktop-task-manager" => {
                if let Some(window) = app.windows().into_values().find(|window| {
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
                let windows = app.windows();
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
                if let Some(window) = app.windows().into_values().find(|window| {
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
                let windows = app.windows();
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
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                if window.label() == crate::desktop::pet::PET_WINDOW_LABEL {
                    api.prevent_close();
                    let handle = window.app_handle().clone();
                    if let Err(error) = crate::bridge::pet::set_pet_enabled(handle, false) {
                        log::warn!("[pet] PET_WINDOW_DESTROY_FAILED: {error}");
                    }
                    return;
                }
                if window.label() != MAIN_WINDOW_LABEL {
                    return;
                }
                let close_action =
                    crate::config::get_store_dat_setting(window.app_handle()).close_action;
                if close_action == crate::config::CLOSE_ACTION_QUIT {
                    window.app_handle().exit(0);
                    return;
                }
                api.prevent_close();
                #[cfg(target_os = "macos")]
                {
                    crate::desktop::activation::on_window_hidden(window, &close_action);
                    if let Err(error) = window.app_handle().hide() {
                        crate::desktop::activation::set_regular_policy(window.app_handle());
                        log::error!("[activation] APP_HIDE_FAILED: {error}");
                    }
                }
                #[cfg(not(target_os = "macos"))]
                let _ = window.hide();
            }
            tauri::WindowEvent::Destroyed => {
                crate::desktop::window::forget_harness_documents(window.app_handle(), window.label());
                if let Some(profile) =
                    crate::service::workflow::instances::release_window(window.label())
                {
                    let app = window.app_handle().clone();
                    tauri::async_runtime::spawn(async move {
                        if let Ok(_transition) =
                            crate::service::workflow::acquire_core_transition().await
                        {
                            if !crate::service::workflow::instances::is_attached(&profile) {
                                let _ = crate::service::workflow::instances::scope(
                                    profile,
                                    crate::service::workflow::stop(app),
                                )
                                .await;
                            }
                        }
                    });
                }
            }
            tauri::WindowEvent::ScaleFactorChanged { .. } => {
                if window.label() == crate::desktop::pet::PET_WINDOW_LABEL {
                    crate::desktop::pet::apply_pet_size(window.app_handle());
                }
            }
            // 只用事件自带的坐标/尺寸：在 Electron 运行时里，任何
            // outer_position()/inner_size() 都是一次同步 IPC 往返，而拖动时每秒有
            // 数百个 move —— 逐事件再问一次会把主线程和 RPC 队列一起拖住
            // （桌宠跟手发滞、主窗口拖动卡顿都源于此）。
            tauri::WindowEvent::Moved(position) => match window.label() {
                label if label == crate::desktop::pet::PET_WINDOW_LABEL => {
                    crate::desktop::pet::record_pet_window_moved(window, *position);
                }
                label if label == MAIN_WINDOW_LABEL => crate::config::record_moved(*position),
                _ => {}
            },
            tauri::WindowEvent::Resized(size) => {
                // 桌宠尺寸由前端按宠物比例设定，与位置记录无关；只记主窗口。
                if window.label() == MAIN_WINDOW_LABEL {
                    crate::config::record_resized(window, *size);
                }
                #[cfg(target_os = "macos")]
                {
                    sync_macos_fullscreen_menu(window);
                    if window.label() == MAIN_WINDOW_LABEL {
                        crate::desktop::activation::on_window_resized(window);
                    }
                }
            }
            #[cfg(target_os = "macos")]
            tauri::WindowEvent::Focused(true) => sync_macos_fullscreen_menu(window),
            _ => {}
        });

    #[cfg(all(not(windows), not(debug_assertions)))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        crate::utils::show_main_window(app);
    }));

    let builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_os::init());

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

    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_deep_link::init());

    builder
}
