use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(windows)]
use std::sync::atomic::AtomicBool;
#[cfg(windows)]
use std::sync::Arc;
#[cfg(target_os = "macos")]
use std::sync::{Mutex, OnceLock};

use tauri::{
    ipc::Invoke,
    Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder, Wry,
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
static MACOS_FULLSCREEN_MENU_ITEM: OnceLock<Mutex<Option<PredefinedMenuItem<Wry>>>> =
    OnceLock::new();

#[cfg(windows)]
use crate::desktop::window::on_page_load;
use crate::desktop::window::{on_download, on_new_window};
// 只在 tauri::tray 路径（Windows / macOS）里按短名使用；Linux 的 KSNI 托盘在
// desktop::linux_tray 内自行引用，且下面单例回调用的是完整路径。
#[cfg(not(target_os = "linux"))]
use crate::utils::show_main_window;

/// 壳层（`Navbar`）导航栏高度，单位 CSS px。
///
/// 这是「前端高度类 ↔ 后端交通灯纵向位置」的唯一真值入口：前端
/// `src/layout/components/navbar.tsx` 根元素的 `h-11` 是它的体现（Tailwind 4
/// 间距刻度 11 × 4px = 44px），macOS 交通灯的纵向位置也由它推导。issue #524
/// 之前两处各写一份数值（`h-11` 与 `24.0`）互不知情，改一处就会错位；现在由
/// `shell_nav_height_matches_navbar_height_class` 测试把这份耦合显式化——
/// 改栏高忘了同步另一边，CI 直接失败。
pub const SHELL_NAV_HEIGHT: u32 = 44;

/// 交通灯距窗口左边缘的内边距（逻辑像素）。
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_INSET_X: f64 = 14.0;

/// Wry 保留了 AppKit 原生按钮的纵向 frame 偏移：实测视觉圆心 = 传入 y − 2
/// （44px 栏高配 y = 24 时圆心为 22px，而非直觉上的 24px）。因此「视觉圆心 =
/// 栏高 / 2」对应 y = 栏高 / 2 + 2（44px 栏高 → 24）。
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_VISUAL_OFFSET: f64 = 2.0;

/// WebView2 原生拖拽区域所需的参数。
///
/// `data-tauri-drag-region` 的兼容脚本只处理鼠标事件；WebView2 的原生
/// `app-region: drag` 才能让触摸输入进入窗口非客户区拖拽。ElasticOverscroll
/// 会抢走触摸手势，因此必须同时禁用。Wry 的默认安全功能保持启用。
#[cfg(windows)]
const WINDOWS_DRAG_BROWSER_ARGS: &str = "--enable-features=msWebView2EnableDraggableRegions --disable-features=ElasticOverscroll,msWebOOUI,msPdfOOUI";

#[cfg(windows)]
fn windows_drag_browser_args() -> &'static str {
    WINDOWS_DRAG_BROWSER_ARGS
}

/// 主窗口 label：壳层状态（几何恢复/落盘、托盘/单例唤起、macOS Reopen）都以它为准。
pub const MAIN_WINDOW_LABEL: &str = "main";

/// 「文件 → 新建窗口」的 label 序号（`window-1`、`window-2`…），保证 label 唯一。
static EXTRA_WINDOW_SEQ: AtomicU64 = AtomicU64::new(0);

/// WebView2 用户数据目录：必须与主窗口一致，否则同一进程内的多个窗口会尝试
/// 使用不同的 User Data Folder 而失败。开发版与 release 分目录的原因见主窗口。
#[cfg(windows)]
fn webview_data_directory(app: &tauri::AppHandle<Wry>) -> std::path::PathBuf {
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

    // 旧版 AppData data/dsh → 官方 $DSH_HOME（~/.dsh）数据迁移。
    // 必须在 sweep 之后（先杀掉占用文件句柄的残留 dsh 进程）、scheduler/
    // auto_start 之前（迁移完成前不启动 dsh）。失败仅告警不阻断：旧数据
    // 原地保留，下次启动重试。
    if let Err(e) = crate::service::migrate::migrate(&app_handle) {
        log::warn!("dsh home migration deferred (old data kept): {e}");
    }

    // 启动自愈：清理指向旧位置的 pnpm `.modules.yaml`。老版本完成迁移后该文件
    // 仍记录旧 $DSH_HOME（AppData）下的绝对路径，导致任何 pnpm 操作抛
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
        .tooltip("Deepseek Harness Desktop")
        .on_menu_event(move |app, event| handle_menu_event(app, &event))
        .on_tray_icon_event(move |tray, event| handle_tray_icon_event(tray, &event))
        .build(app)?;

    #[cfg(not(target_os = "macos"))]
    let _ = TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Deepseek Harness Desktop")
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
    let application_separator = PredefinedMenuItem::separator(app)?;
    let is_fullscreen = app
        .get_webview_window("main")
        .and_then(|window| window.is_fullscreen().ok())
        .unwrap_or(false);
    let fullscreen_label = crate::config::i18n::t(if is_fullscreen {
        "menu.exit_fullscreen"
    } else {
        "menu.enter_fullscreen"
    });
    let fullscreen = PredefinedMenuItem::fullscreen(app, Some(&fullscreen_label))?;
    let application_menu = Submenu::with_id_and_items(
        app,
        "desktop-application-menu",
        crate::config::i18n::t("menu.application"),
        true,
        &[&config, &application_separator, &fullscreen],
    )?;

    let hide = PredefinedMenuItem::hide(app, None)?;
    let hide_others = PredefinedMenuItem::hide_others(app, None)?;
    let show_all = PredefinedMenuItem::show_all(app, None)?;
    let quit_separator = PredefinedMenuItem::separator(app)?;
    let quit = PredefinedMenuItem::quit(app, None)?;
    // macOS 会把首个菜单标题强制显示为应用名称；这里只承载必要的系统动作，
    // 真正可见的“应用”功能菜单放在其后，避免再次被系统改名。
    let system_application_menu = Submenu::with_id_and_items(
        app,
        "desktop-system-application-menu",
        app.package_info().name.clone(),
        true,
        &[&hide, &hide_others, &show_all, &quit_separator, &quit],
    )?;

    let run_logs = MenuItem::with_id(
        app,
        "desktop-copy-run-logs",
        crate::config::i18n::t("menu.run_logs"),
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
    let check_update = MenuItem::with_id(
        app,
        "desktop-check-update",
        crate::config::i18n::t("menu.check_update"),
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
    let about = MenuItem::with_id(
        app,
        "desktop-about",
        crate::config::i18n::t("menu.about"),
        true,
        None::<&str>,
    )?;
    let help_menu = Submenu::with_id_and_items(
        app,
        "desktop-help-menu",
        crate::config::i18n::t("menu.help"),
        true,
        &[
            &run_logs,
            &restart,
            &check_update,
            &help_separator,
            &documentation,
            &about,
        ],
    )?;

    // 文件菜单：非 macOS 上同一组项渲染在壳层导航栏（`layout/components/navbar.tsx`）。
    // 图标化的系统动作（新建窗口/新聊天/打开文件夹/关闭/退出）本身只发动作 id，
    // 由前端复用壳层实现——新建窗口更必须在异步运行时里建窗（见 desktop::window）。
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
    // 关闭：走系统 close_window（⌘W）。主窗口的 CloseRequested 由壳层接管为
    // 「隐藏到托盘」（setting.close_action=tray），语义与导航栏「关闭」一致。
    let close = PredefinedMenuItem::close_window(app, Some(&crate::config::i18n::t("menu.close")))?;
    let file_separator_quit = PredefinedMenuItem::separator(app)?;
    let file_quit = PredefinedMenuItem::quit(app, Some(&crate::config::i18n::t("menu.quit")))?;
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
            &file_separator_quit,
            &file_quit,
        ],
    )?;

    // 编辑菜单：macOS 设置了主菜单后，⌘X/⌘C/⌘V/⌘A 等组合键会先经菜单的
    // key-equivalent 路由，若不挂载标准编辑项，WebView 的编辑快捷键会被吞掉，
    // 输入框内无法剪切/复制/粘贴（#85）。这些预定义项绑定标准 NSMenu 选择器
    // （cut:/copy:/paste:/selectAll:/undo:/redo:），由 AppKit 把命令转发给聚焦视图
    // （WebView），同时保持菜单条上的撤销/重做/剪切/复制/粘贴/全选。
    let undo = PredefinedMenuItem::undo(app, Some(&crate::config::i18n::t("menu.undo")))?;
    let redo = PredefinedMenuItem::redo(app, Some(&crate::config::i18n::t("menu.redo")))?;
    let cut = PredefinedMenuItem::cut(app, Some(&crate::config::i18n::t("menu.cut")))?;
    let copy = PredefinedMenuItem::copy(app, Some(&crate::config::i18n::t("menu.copy")))?;
    let paste = PredefinedMenuItem::paste(app, Some(&crate::config::i18n::t("menu.paste")))?;
    let select_all =
        PredefinedMenuItem::select_all(app, Some(&crate::config::i18n::t("menu.select_all")))?;
    let edit_separator_after_redo = PredefinedMenuItem::separator(app)?;
    let edit_separator_before_select_all = PredefinedMenuItem::separator(app)?;
    let edit_menu = Submenu::with_id_and_items(
        app,
        "desktop-edit-menu",
        crate::config::i18n::t("menu.edit"),
        true,
        &[
            &undo,
            &redo,
            &edit_separator_after_redo,
            &cut,
            &copy,
            &paste,
            &edit_separator_before_select_all,
            &select_all,
        ],
    )?;

    let menu = Menu::with_items(
        app,
        &[
            &system_application_menu,
            &application_menu,
            &file_menu,
            &edit_menu,
            &help_menu,
        ],
    )?;
    let _ = app.set_menu(menu)?;
    *MACOS_FULLSCREEN_MENU_ITEM
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(fullscreen);
    Ok(())
}

/// 原生全屏动画会连续触发 Resize；只在状态真正变化时刷新菜单文案。
#[cfg(target_os = "macos")]
fn sync_macos_fullscreen_menu(window: &tauri::Window<Wry>) {
    let Ok(is_fullscreen) = window.is_fullscreen() else {
        return;
    };
    let label = crate::config::i18n::t(if is_fullscreen {
        "menu.exit_fullscreen"
    } else {
        "menu.enter_fullscreen"
    });
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
            .title("Deepseek Harness Desktop")
            .inner_size(1280.0, 840.0)
            .min_inner_size(860.0, 620.0)
            .resizable(true);

    // Windows/WebView2 在 build() 尚未返回时就可能绘制窗口。先隐藏创建，
    // 等保存的几何恢复完成再显示，避免启动时先闪出默认尺寸再跳到历史尺寸。
    #[cfg(windows)]
    let webview_builder = webview_builder
        .visible(false)
        // 开发版使用独立 WebView2 数据目录，避免已有 release 实例、热重启残留
        // 或其他同标识实例占用同一 User Data 管道，触发 HRESULT 0x8007139F。
        .data_directory(webview_data_directory(app))
        // WebView2 原生非客户区可直接接收触摸输入；同时禁用会抢占手势的弹性滚动。
        .additional_browser_args(windows_drag_browser_args())
        // Windows 任务栏图标来源：窗口 .icon() > 可执行文件嵌入资源 > 系统默认。
        // 未调用 .icon() 时任务栏显示系统默认图标；显式设置 default_window_icon
        // 以在任务栏呈现与应用品牌一致的图标（macOS 用 TitleBar 无需此设置）。
        .icon(app.default_window_icon().unwrap().clone())?;

    // macOS 保留原生交通灯：绿色按钮由 AppKit 进入独立 Space 的原生全屏，
    // 同时用 Overlay 让壳层导航栏继续与窗口 chrome 融合。其他平台
    // 仍由 ShellNavBar 的右侧按钮提供窗口控制。
    #[cfg(target_os = "macos")]
    let webview_builder = webview_builder
        .decorations(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        // 交通灯纵向位置由 SHELL_NAV_HEIGHT 推导（见常量注释），使视觉圆心落在
        // 栏高一半，与随栏高 flex 居中的折叠/展开按钮同一水平线（issue #524）。
        // 位置只在窗口创建时生效：Tauri 2.11.5 没有运行期交通灯 API，而 wry
        // 0.55.1 会在自身重绘时按创建时的值回放（`WryWebViewParent::drawRect:`），
        // 所以运行期改 NSWindow 会被随时覆盖——改栏高必须同步上面的常量。
        .traffic_light_position(tauri::LogicalPosition::new(
            TRAFFIC_LIGHT_INSET_X,
            f64::from(SHELL_NAV_HEIGHT) / 2.0 + TRAFFIC_LIGHT_VISUAL_OFFSET,
        ))
        // 在创建时就把原生标题栏外观设为 dsh 主题偏好，避免启动瞬间出现
        // 「内容已亮、顶栏仍暗」的闪变（issue #93）。system → None 即跟随系统。
        // 后续偏好变化由 `config::check_and_emit_theme` 调用 `apply_window_theme` 同步。
        .theme(match crate::config::get_dsh_theme(app) {
            crate::config::DshTheme::System => None,
            crate::config::DshTheme::Light => Some(tauri::Theme::Light),
            crate::config::DshTheme::Dark => Some(tauri::Theme::Dark),
        });

    #[cfg(not(target_os = "macos"))]
    let webview_builder = webview_builder.decorations(false);

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
        .on_download(|webview, event| on_download(webview, event));

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
    // 剪贴板图片桥与 boot 探测桥注入所有 frame（脚本均带幂等守卫，重复注入安全）。
    // 导航桥（侧边栏）、缩放快捷键与 iframe 全局样式已分别由 dsh-tauri /
    // dsh-tauri-ui 插件在 iframe 内实现，不再注入对应脚本。
    #[cfg(not(windows))]
    let webview_builder = webview_builder
        .initialization_script_for_all_frames(crate::desktop::compat::ABORT_SIGNAL_ANY_SHIM_JS)
        .initialization_script_for_all_frames(crate::desktop::compat::ITERATOR_HELPERS_SHIM_JS)
        .initialization_script_for_all_frames(crate::desktop::notification::NOTIFICATION_SHIM_JS)
        .initialization_script_for_all_frames(crate::desktop::paste::PASTE_SHIM_JS)
        .initialization_script_for_all_frames(crate::desktop::plugin_boot::PLUGIN_BOOT_RELOAD_JS);

    let webview_window = webview_builder.build()?;
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

/// 「文件 → 新建窗口」：以同一 `index.html` 再开一个独立 webview 窗口。
///
/// 与主窗口共用同一份平台 chrome、外链/下载接管与（Windows）WebView2 用户数据
/// 目录，但**不**参与主窗口几何恢复与落盘：`on_window_event` 只对
/// `MAIN_WINDOW_LABEL` 采样，否则第二个窗口的移动/缩放会覆盖用户保存的主窗口尺寸。
///
/// 只能在异步运行时的命令任务里调用（与 `pet::ensure_pet_window` 同样的约束：
/// `WebviewWindowBuilder::build()` 需要主线程事件循环回包，主线程调用会死锁）。
pub fn build_extra_window(app: &tauri::AppHandle<Wry>) -> tauri::Result<tauri::WebviewWindow<Wry>> {
    let sequence = EXTRA_WINDOW_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let label = format!("window-{sequence}");
    let app_handle = app.clone();

    let webview_builder =
        WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
            .title("Deepseek Harness Desktop")
            .inner_size(1280.0, 840.0)
            .min_inner_size(860.0, 620.0)
            .resizable(true);

    #[cfg(windows)]
    let webview_builder = webview_builder
        // 与主窗口共用同一 User Data Folder：同一进程内多个窗口各自指定不同
        // 目录会直接建窗失败。
        .data_directory(webview_data_directory(app))
        .additional_browser_args(windows_drag_browser_args())
        .icon(app.default_window_icon().unwrap().clone())?;

    // 非 Windows 平台没有 WebView2 的 FrameCreated/ContentLoading 流程，兼容桥、
    // 通知桥、剪贴板图片桥与 boot 探测桥必须按窗口重新注入（与主窗口一致）。
    #[cfg(not(windows))]
    let webview_builder = webview_builder
        .initialization_script_for_all_frames(crate::desktop::compat::ABORT_SIGNAL_ANY_SHIM_JS)
        .initialization_script_for_all_frames(crate::desktop::compat::ITERATOR_HELPERS_SHIM_JS)
        .initialization_script_for_all_frames(crate::desktop::notification::NOTIFICATION_SHIM_JS)
        .initialization_script_for_all_frames(crate::desktop::paste::PASTE_SHIM_JS)
        .initialization_script_for_all_frames(crate::desktop::plugin_boot::PLUGIN_BOOT_RELOAD_JS);

    #[cfg(target_os = "macos")]
    let webview_builder = webview_builder
        .decorations(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        // 与主窗口同一真值：附加窗口用的是同一个壳层导航栏（h-11 = 44px），
        // 交通灯必须落在同一水平线上（写死 24.0 会随 #524 的栏高改动错位 4px）。
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
    let webview_builder = webview_builder.decorations(false);

    let webview_builder = webview_builder
        .disable_drag_drop_handler()
        .on_new_window(move |url, features| on_new_window(app_handle.clone(), url, features))
        .on_download(|webview, event| on_download(webview, event));

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

#[cfg(all(test, windows))]
mod tests {
    use super::windows_drag_browser_args;

    #[test]
    fn windows_drag_args_enable_touch_drag_and_disable_overscroll() {
        let args = windows_drag_browser_args();
        assert!(args.contains("--enable-features=msWebView2EnableDraggableRegions"));
        assert!(args.contains("--disable-features=ElasticOverscroll"));
        assert!(args.contains("msWebOOUI,msPdfOOUI"));
        let smart_screen = ["ms", "SmartScreen", "Protection"].concat();
        assert!(!args.contains(smart_screen.as_str()));
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
        crate::bridge::get_preinstall_plugins,
        crate::bridge::get_preinstall_pending,
        crate::bridge::install_preinstall_plugins,
        crate::bridge::cancel_preinstall_plugins,
        crate::bridge::skip_preinstall_plugins,
        crate::bridge::ensure_internal_plugins,
        crate::bridge::cancel_internal_plugins,
        crate::bridge::open_preinstall_repo,
        crate::bridge::get_dsh_plugins,
        crate::bridge::refresh_plugin_updates,
        crate::bridge::update_dsh_plugin,
        crate::bridge::remove_dsh_plugin,
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
        crate::bridge::clone_profile,
        crate::bridge::backup_profile,
        crate::bridge::restore_profile,
        crate::bridge::list_backups,
        crate::bridge::delete_backup,
        crate::bridge::get_cores,
        crate::bridge::set_active_core,
        crate::bridge::download_core,
        crate::bridge::remove_core,
        crate::bridge::update_local_core,
        crate::bridge::proxy_health_check,
        crate::bridge::get_runtime_info,
        crate::bridge::runtime_ready,
        crate::bridge::get_app_config,
        crate::bridge::update_app_config,
        crate::bridge::get_launch_on_login,
        crate::bridge::set_launch_on_login,
        crate::bridge::get_cli_link_status,
        crate::bridge::open_in_browser,
        crate::bridge::copy_service_url,
        crate::bridge::reveal_data_dir,
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
        crate::bridge::write_clipboard_text,
        crate::desktop::notification::show_native_notification,
        crate::desktop::window::create_app_window,
        crate::desktop::window::quit_app,
        crate::bridge::log_frontend,
        crate::bridge::get_pet_status,
        crate::bridge::set_pet_enabled,
        crate::bridge::set_active_pet,
        crate::bridge::set_pet_size,
        crate::bridge::push_pet_session,
        crate::bridge::move_pet_window,
        crate::bridge::set_pet_ignore_cursor_events,
        crate::bridge::list_pets,
        crate::bridge::import_pet,
        crate::bridge::get_pet_asset,
        crate::bridge::list_preset_pets,
        crate::desktop::pet_mouse::start_pet_mouse_stream,
    ]
}

// configure tauri builder
pub fn builder() -> tauri::Builder<tauri::Wry> {
    let builder = tauri::Builder::default()
        // E2E：内嵌 WebDriver server（仅在 TAURI_WEBDRIVER_PORT 存在时监听）。
        .plugin(tauri_plugin_wdio_webdriver::init())
        .manage(crate::desktop::pet_mouse::PetMouseStreamState::default())
        .setup(|app| {
            let app_handle = app.handle().clone();
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
            "desktop-config"
            | "desktop-about"
            | "desktop-copy-run-logs"
            | "desktop-check-update"
            | "desktop-restart"
            | "desktop-documentation"
            | "desktop-new-window"
            | "desktop-new-chat"
            | "desktop-open-folder" => {
                if let Err(error) = app.emit("macos-menu-action", event.id().as_ref()) {
                    log::warn!("[menu] failed to emit macOS menu action: {error}");
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
                    crate::config::get_store_dat_setting(&window.app_handle()).close_action;
                if close_action == crate::desktop::activation::CLOSE_ACTION_QUIT {
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
            // 移动/缩放主窗口时记录几何，重启后据此恢复（见 config::window_state）。
            // 只认主窗口 label：附加窗口的几何与主窗口共用同一份记录，采样会污染它。
            tauri::WindowEvent::Moved(_) => match window.label() {
                label if label == crate::desktop::pet::PET_WINDOW_LABEL => {
                    crate::desktop::pet::save_pet_window_geometry(window);
                }
                label if label == MAIN_WINDOW_LABEL => crate::config::save_geometry(window),
                _ => {}
            },
            tauri::WindowEvent::ScaleFactorChanged { .. } => {
                if window.label() == crate::desktop::pet::PET_WINDOW_LABEL {
                    crate::desktop::pet::apply_pet_size(&window.app_handle());
                }
            }
            tauri::WindowEvent::Resized(_) => {
                match window.label() {
                    label if label == crate::desktop::pet::PET_WINDOW_LABEL => {
                        crate::desktop::pet::save_pet_window_geometry(window);
                    }
                    label if label == MAIN_WINDOW_LABEL => crate::config::save_geometry(window),
                    _ => {}
                }
                // 全屏菜单文案与 Accessory 切换都只针对主窗口：附加窗口没有
                // 独立的全屏菜单项，也不参与「关闭主窗口即后台化」的激活策略。
                #[cfg(target_os = "macos")]
                {
                    if window.label() == MAIN_WINDOW_LABEL {
                        // 退出全屏后补做全屏期间被推迟的 Accessory 切换
                        sync_macos_fullscreen_menu(window);
                        crate::desktop::activation::on_window_resized(window);
                    }
                }
            }
            _ => {}
        });

    // 单例模式：多次双击图标（或重复启动）时不会新开窗口，而是把
    // 已存在的（可能已隐藏到托盘）主窗口调到前台，实现“单例 + 复用后台窗口”。
    // 该回调在首次启动时也会以当前进程的参数触发一次（幂等，仅 show/focus），
    // 之后每次二次启动都会派发到这里，重新展示后台运行的主窗口。
    // 仅在生产环境（release）启用：debug 开发调试时若启用单例，
    // 二次启动的调试进程会被吞掉（例如 tauri dev 多实例调试），
    // 因此开发环境跳过该插件。
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

    builder
        // 官方跨平台登录启动实现：Windows HKCU Run、macOS LaunchAgent、Linux XDG。
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name(crate::desktop::autostart::app_name())
                .build(),
        )
        // Opener plugin
        .plugin(tauri_plugin_opener::init())
        // Notification plugin（Windows 上以 tauri-winrt-notification 实现点击回调，
        // 注册官方插件保留跨平台回退能力）
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
        .plugin(tauri_plugin_os::init())
}
