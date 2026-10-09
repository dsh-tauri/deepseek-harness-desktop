//! Linux 系统托盘（KSNI / StatusNotifierItem）。
//!
//! 背景（issue #386 / #438）：本应用此前在 Linux 上走 `tauri::tray`，而 tauri 2.11.5
//! 固定依赖的 tray-icon 0.24.2 在 Linux 上只有 libappindicator/GTK 后端，该后端**完全
//! 不上报托盘事件**（上游 tauri-apps/tray-icon#104），因此单击/双击托盘都无法唤起主
//! 窗口，只能走托盘菜单里的「打开面板」。
//!
//! 上游 tray-icon 0.25.0 合并了 KSNI 后端：SNI 的 `Activate`（左键单击）会被映射成
//! `TrayIconEvent::Click { button: Left, .. }`，即 Linux 上终于能收到单击事件。但
//! tauri 2.x 的菜单类型来自 muda 0.19，而 tray-icon 0.25 换成了 muda 0.20
//! （`TrayIconBuilder::menu` 的 `ContextMenu` 不是同一个 trait），tauri 2.11.5 的
//! `tray-icon = "^0.24"` 既无法 `cargo update` 也无法 `[patch.crates-io]` 顶到 0.25；
//! tauri 3 目前只有 alpha。
//!
//! 因此 Linux 上绕过 `tauri::tray`，直接用同一份上游 crate（`tray-icon` 0.25 的 `ksni`
//! 后端，见 Cargo.toml 里的 `cfg(target_os = "linux")` 依赖）自建托盘；Windows / macOS
//! 继续走 `tauri::tray`（两边事件上报本就正常，也避免在 macOS 上让 muda 0.19 / 0.20
//! 两套 ObjC 菜单实现并存）。tauri 2.x 跟进 bump tray-icon 后，本文件与那份依赖即可删除。
//!
//! 事件为什么不会被 tauri 抢走：tauri 在 `App::run` 里会给**它自己依赖的** muda 0.19 /
//! tray-icon 0.24 装全局处理器（`muda::MenuEvent::set_event_handler` /
//! `tray_icon::TrayIconEvent::set_event_handler`），而同一 crate 的不同 semver 大版本在
//! 二进制里是两份独立实例、各自带静态通道，所以这里用的 0.20 / 0.25 仍能从 `receiver()`
//! 拿到事件。反过来说，只要还在这条“自建托盘”路径上，就不要混用 tauri 的菜单/托盘类型。

use tauri::{AppHandle, Runtime};

use crate::utils::show_main_window;

/// 构建 Linux 托盘。
///
/// 托盘是可选壳层能力：Linux 桌面没有 SNI watcher（例如未装 AppIndicator 扩展的
/// GNOME）或会话总线不可用时，只记日志，不让应用启动失败——与 `tauri::tray` 在
/// macOS/Windows 上的失败语义差异在此显式收口。
pub fn build<R: Runtime>(app: &AppHandle<R>) {
    if let Err(error) = build_inner(app) {
        log::warn!("[tray] LINUX_TRAY_FAILED: {error}");
    }
}

fn build_inner<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    use tray_icon::menu::{Menu, MenuItem};
    use tray_icon::{Icon, TrayIconBuilder};

    // 菜单文案与 `tauri::tray` 版本保持一致（"打开面板" / "退出"）。
    let menu = Menu::new();
    menu.append_items(&[
        &MenuItem::with_id("open", "打开面板", true, None),
        &MenuItem::with_id("quit", "退出", true, None),
    ])
    .map_err(|error| format!("LINUX_TRAY_MENU_FAILED: {error}"))?;

    let mut builder = TrayIconBuilder::new()
        .with_menu(Box::new(menu))
        .with_tooltip(crate::desktop::product_name(app))
        .with_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        match Icon::from_rgba(icon.rgba().to_vec(), icon.width(), icon.height()) {
            Ok(icon) => builder = builder.with_icon(icon),
            // 图标无效不该连累托盘本身：没有图标仍能收到单击/菜单事件。
            Err(error) => log::warn!("[tray] LINUX_TRAY_ICON_INVALID: {error}"),
        }
    }

    let tray = builder
        .build()
        .map_err(|error| format!("LINUX_TRAY_BUILD_FAILED: {error}"))?;
    // 托盘必须活到进程结束：`TrayIcon` 析构会注销 SNI 项（图标从托盘消失）。它与进程
    // 同寿命，且没有 Send/Sync 约束，直接泄漏一份句柄比引入包装类型更直接。
    let _ = Box::leak(Box::new(tray));

    spawn_event_forwarders(app)
}

/// KSNI 后端在它自己的线程上投递事件，这里各起一个消费线程把事件送回主线程执行。
fn spawn_event_forwarders<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    use tray_icon::menu::MenuEvent;
    use tray_icon::{MouseButton, TrayIconEvent};

    // 左键单击（SNI Activate）→ 打开主窗口，这正是 issue #386 要修的行为。
    // KSNI 后端只在 Activate 时发一次 Click/Up，不区分物理上的单击与双击（双击会
    // 收到两次），因此这里不必额外匹配 DoubleClick。
    let click_app = app.clone();
    std::thread::Builder::new()
        .name("linux-tray-click".into())
        .spawn(move || {
            for event in TrayIconEvent::receiver() {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    ..
                } = event
                {
                    on_main_thread(&click_app, |app| show_main_window(app));
                }
            }
        })
        .map_err(|error| format!("LINUX_TRAY_CLICK_THREAD_FAILED: {error}"))?;

    // 托盘菜单：KSNI 把菜单项的 activate 回调（muda 快照里携带的）直接接到 D-Bus 菜单上，
    // 点击后经 muda 的 MenuEvent 通道出来，语义与 `tauri::tray` 的 "open" / "quit" 对齐。
    let menu_app = app.clone();
    std::thread::Builder::new()
        .name("linux-tray-menu".into())
        .spawn(move || {
            for event in MenuEvent::receiver() {
                match event.id().as_ref() {
                    "open" => on_main_thread(&menu_app, |app| show_main_window(app)),
                    "quit" => on_main_thread(&menu_app, |app| app.exit(0)),
                    _ => {}
                }
            }
        })
        .map_err(|error| format!("LINUX_TRAY_MENU_THREAD_FAILED: {error}"))?;

    Ok(())
}

/// 把动作送回主线程执行。
///
/// `run_on_main_thread` 会借用 `app`，而闭包里还要用同一份句柄，所以先克隆出两份：
/// 一份用于投递，一份交给主线程上的动作。
fn on_main_thread<R: Runtime>(
    app: &AppHandle<R>,
    action: impl FnOnce(&AppHandle<R>) + Send + 'static,
) {
    let task_app = app.clone();
    let main_app = app.clone();
    if let Err(error) = task_app.run_on_main_thread(move || action(&main_app)) {
        log::warn!("[tray] LINUX_TRAY_MAIN_THREAD_FAILED: {error}");
    }
}
