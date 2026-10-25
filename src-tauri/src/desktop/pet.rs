//! 桌宠外置窗口：独立的透明、置顶、无边框小窗口，用于展示 dsh 会话状态的
//! 动画宠物（桌宠外置化，issue #308）。
//!
//! 设计要点（参考 BongoCat 的多 WebView 桌宠方案）：
//! - 独立窗口 label `pet`，`WebviewUrl::App("pet.html")`，与主窗口（`main`）
//!   并行，由主 webview 监听 dsh-container 的 invoke 桥来操控；
//! - 窗口特性：`transparent + always_on_top + decorations(false) +
//!   skip_taskbar + shadow(false) + accept_first_mouse`，打造覆盖在普通
//!   窗口之上的不抢占焦点的宠物层；
//! - 几何（位置/大小）持久化到独立 store 键 `pet_window_state`，重启恢复，
//!   不与主窗口几何互相污染（主窗口用 `config::window_state`）。
//!
//! 平台说明：
//! - macOS 透明窗口需要 `macOSPrivateApi`（见 tauri.conf.json `app` 段），且
//!   Tauri 的 masking 需 `macos-private-api` Cargo feature，由
//!   `src-tauri/Cargo.toml` 按平台门控开启。这里透明依赖平台原生支持，创建失败
//!   时回退为非透明窗口继续工作。
//! - `always_on_top` 在 Windows 上 Tauri 原生 API 即可保持置顶（BongoCat 为
//!   额外稳定性用 SetWindowPos 循环轮询，本项目暂不做该平台特定加固）。
//! - 原生 Wayland 会话下 `always_on_top` 与 `set_position` 都不生效，桌宠被主窗口
//!   遮挡（issue #649，上游 tauri-apps/tao#1134 已按「Wayland 不支持」补文档结案）。
//!   同一后端下 `outer_position()` 恒为 `{x:0,y:0}`，几何持久化因此一并跳过。
//!   判定见 `crate::pet_overlay_supported`，前端据此提示用户。

use crate::config::{store_dat_file_name, STORE_PET_WINDOW_STATE_KEY};
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Manager, PhysicalPosition, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    Window,
};
use tauri_plugin_store::StoreExt;

/// 桌宠窗口的 label（Tauri 窗口标识，脚本层与能力配置以此引用）。
pub const PET_WINDOW_LABEL: &str = "pet";
/// 内置视频基准尺寸（dsh-pet 呆味预览帧 220x124，透明画布）。
pub const PET_SPRITE_BASE_WIDTH: f64 = 220.0;
/// 窗口留白（逻辑像素）：顶部为 Toast 绘制区，但由 pet WebView 根据
/// 实际 DOM 命中区域动态调用 setIgnoreCursorEvents 控制透明区域穿透。
const PET_WINDOW_PAD_X: f64 = 32.0;
const PET_WINDOW_TOP_PAD: f64 = 72.0;
const PET_WINDOW_BOTTOM_PAD: f64 = 10.0;
/// 顶栏 Toast 区的最小窗口宽度（逻辑像素）：桌宠较小时仍保证气泡可读，
/// 与 pet WebView 的 PET_BUBBLE_MIN_WIDTH 保持一致。
const PET_WINDOW_MIN_WIDTH: f64 = 420.0;
/// 预设宠物默认画布 16:9（高/宽 = 9/16）：与 dsh-pet 协议画布一致
/// （WebM 与 macOS 的 HEVC-with-Alpha MOV 共用同一画布）。
const PET_BUILTIN_ASPECT: f64 = 9.0 / 16.0;
/// Codex 图集（自定义精灵图，或清单条目声明 `kind: "codex"`）的 8x11 / 192x208 比例；
/// 实际比例以前端加载后为准，这里仅作为窗口初始/DPI 尺寸的近似，避免与前端互相打架。
const PET_CUSTOM_ASPECT: f64 = 208.0 / 192.0;
/// 宠物大小百分比合法区间（设置页滑条 50%–200%；bridge/pet.rs 引用同一常量）。
pub const PET_SIZE_MIN_PERCENT: f64 = 50.0;
pub const PET_SIZE_MAX_PERCENT: f64 = 200.0;
/// 未设置 pet_size 时的默认缩放（100% = 精灵图原始尺寸）。
pub const PET_SIZE_DEFAULT_PERCENT: f64 = 100.0;

/// 持久化的桌宠窗口位置（仅记录位置；大小由设置页 pet_size 百分比实时推导）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PetWindowPosition {
    /// 非 None 时恢复物理位置；None 表示用户从未拖动过，走系统默认（居中靠下）。
    pub x: Option<i32>,
    pub y: Option<i32>,
}

/// 读取上次保存的桌宠窗口位置；无记录时返回默认（None，位置未定）。
pub fn get_pet_window_position<R: Runtime>(app: &AppHandle<R>) -> PetWindowPosition {
    let store = app
        .store(store_dat_file_name())
        .expect("Failed to load store for pet window position");
    let raw = store.get(STORE_PET_WINDOW_STATE_KEY);
    raw.as_ref()
        .and_then(|value| {
            serde_json::from_value(crate::config::unwrap_json_value(value).into_owned()).ok()
        })
        .unwrap_or_default()
}

/// 保存桌宠窗口位置（用户拖动后由 Moved 事件调用）。
///
/// 原生 Wayland 下跳过写入：两个调用点的位置都取自 `outer_position()`，而 GDK 的
/// Wayland 后端不向客户端报告窗口在屏幕上的坐标，该调用返回 `{x:0,y:0}` 且不报错。
/// 照写会把上一次在 X11 会话里存下的有效位置覆盖成原点（issue #649）。
pub fn save_pet_window_position<R: Runtime>(app: &AppHandle<R>, position: &PetWindowPosition) {
    if !crate::pet_overlay_supported_env() {
        return;
    }
    let store = app
        .store(store_dat_file_name())
        .expect("Failed to load store for pet window position");
    let serialized =
        serde_json::to_value(position).expect("Failed to serialize pet window position");
    store.set(STORE_PET_WINDOW_STATE_KEY, serialized);
    store.save().expect("Failed to save pet window position");
}

/// 采样当前桌宠窗口位置并保存（窗口 Moved 时由 builder 调用）。
///
/// 接收基础 `Window`（`on_window_event` 回调类型），仅需其外部位与可见性。
pub fn save_pet_window_geometry<R: Runtime>(window: &Window<R>) {
    // 窗口未显示或正在全屏时采样到的可能是瞬态/无意义的位置，跳过。
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    let Some(pos) = window.outer_position().ok() else {
        return;
    };
    let app = window.app_handle().clone();
    save_pet_window_position(
        &app,
        &PetWindowPosition {
            x: Some(pos.x),
            y: Some(pos.y),
        },
    );
}

/// 读取宠物大小百分比（设置持久化值；缺省回落默认，越界收敛进合法区间）。
pub fn get_pet_size_percent<R: Runtime>(app: &AppHandle<R>) -> f64 {
    crate::config::get_store_dat_setting(app)
        .pet_size
        .unwrap_or(PET_SIZE_DEFAULT_PERCENT)
        .clamp(PET_SIZE_MIN_PERCENT, PET_SIZE_MAX_PERCENT)
}

/// 当前激活宠物使用的画布比例（高度/宽度）：预设宠物（未限定 id）默认 dsh-pet 的
/// 16:9 透明视频画布，自定义精灵图（chat:/codex: 来源限定 id）用 208/192。
/// 真正的比例由 pet WebView 拿到清单条目/图集后实时修正，这里只是窗口创建与
/// DPI 变化时的初始近似。
pub fn pet_window_aspect<R: Runtime>(app: &AppHandle<R>) -> f64 {
    let setting = crate::config::get_store_dat_setting(app);
    let active = setting
        .active_pet
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    // 来源限定 id（chat:/codex:）是自定义精灵图；未限定 id（预设宠物）用 WebM 9/16。
    if active.map(|value| !value.contains(':')).unwrap_or(true) {
        PET_BUILTIN_ASPECT
    } else {
        PET_CUSTOM_ASPECT
    }
}

/// 由百分比换算桌宠窗口逻辑尺寸：按当前宠物画布比例缩放，气泡与阴影留白保持可读固定高度。
pub fn pet_window_logical_size(percent: f64, aspect: f64) -> (f64, f64) {
    let scale = percent / 100.0;
    (
        ((PET_SPRITE_BASE_WIDTH * scale) + PET_WINDOW_PAD_X).max(PET_WINDOW_MIN_WIDTH),
        (PET_SPRITE_BASE_WIDTH * aspect * scale) + PET_WINDOW_TOP_PAD + PET_WINDOW_BOTTOM_PAD,
    )
}

/// Linux：WebKitGTK 页面缩放里 GTK 缩放系数之外的部分，千分比存储。
///
/// 实测（WebKitGTK 2.54，KDE）页面 `devicePixelRatio` =
/// GTK 缩放系数 × `gtk-xft-dpi`/96 × `GDK_DPI_SCALE`（XWayland 下）：
/// `Xft.dpi=144` → 1.5；再加 `GDK_DPI_SCALE=0.8333` → 1.25；`GDK_SCALE=2` → 3。
/// 原生 Wayland 下 dpr 只等于 GTK 缩放系数，该部分取 1。
/// `gtk::Settings` 只能在主线程读，而建窗跑在异步任务里，所以在主线程算好缓存在这里。
#[cfg(target_os = "linux")]
static PAGE_EXTRA_SCALE_MILLI: std::sync::atomic::AtomicU32 =
    std::sync::atomic::AtomicU32::new(1000);

/// 由 `gtk-xft-dpi`（1/1024 DPI，未设置为 -1）与 `GDK_DPI_SCALE` 推出页面额外缩放。
#[cfg(target_os = "linux")]
fn linux_page_extra_scale(gdk_x11: bool, xft_dpi_1024: i32, gdk_dpi_scale: Option<&str>) -> f64 {
    if !gdk_x11 {
        return 1.0;
    }
    let dpi = if xft_dpi_1024 > 0 {
        f64::from(xft_dpi_1024) / 1024.0 / 96.0
    } else {
        1.0
    };
    let env = gdk_dpi_scale
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(1.0);
    dpi * env
}

/// 重新读取页面额外缩放并缓存。**必须在主线程调用**（app setup / 窗口事件回调）。
#[cfg(target_os = "linux")]
pub fn refresh_page_extra_scale() {
    use gtk::prelude::GtkSettingsExt;
    // GDK 走 X11（XWayland）时 WebKitGTK 才按 Xft.dpi 放大页面；判定与置顶能力共用。
    let gdk_x11 = crate::pet_overlay_supported_env();
    let xft_dpi = gtk::Settings::default()
        .map(|settings| settings.gtk_xft_dpi())
        .unwrap_or(-1);
    let scale = linux_page_extra_scale(
        gdk_x11,
        xft_dpi,
        std::env::var("GDK_DPI_SCALE").ok().as_deref(),
    );
    PAGE_EXTRA_SCALE_MILLI.store(
        (scale * 1000.0).round().clamp(250.0, 8000.0) as u32,
        std::sync::atomic::Ordering::Relaxed,
    );
}

/// Linux：一个 CSS 像素对应多少物理像素（= 页面 `devicePixelRatio`），与前端
/// `usePetWindowSize` / 输入形状同一口径。
#[cfg(target_os = "linux")]
fn pet_page_scale(gtk_scale: f64) -> f64 {
    let extra =
        f64::from(PAGE_EXTRA_SCALE_MILLI.load(std::sync::atomic::Ordering::Relaxed)) / 1000.0;
    gtk_scale * extra
}

/// Linux：当前设置下桌宠窗口的物理尺寸（CSS 尺寸 × 页面缩放）。
#[cfg(target_os = "linux")]
fn pet_window_physical_size<R: Runtime>(app: &AppHandle<R>, gtk_scale: f64) -> (u32, u32) {
    let (width, height) =
        pet_window_logical_size(get_pet_size_percent(app), pet_window_aspect(app));
    let scale = pet_page_scale(gtk_scale);
    (
        (width * scale).round() as u32,
        (height * scale).round() as u32,
    )
}

/// 实时应用宠物大小：窗口已存在时直接重设尺寸（设置页拖动条拖动中实时调用）。
pub fn apply_pet_size<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(PET_WINDOW_LABEL) else {
        return;
    };
    #[cfg(target_os = "linux")]
    let size: tauri::Size = {
        let (width, height) = pet_window_physical_size(app, window.scale_factor().unwrap_or(1.0));
        tauri::PhysicalSize::new(width, height).into()
    };
    #[cfg(not(target_os = "linux"))]
    let size: tauri::Size = {
        let (width, height) =
            pet_window_logical_size(get_pet_size_percent(app), pet_window_aspect(app));
        tauri::LogicalSize::new(width, height).into()
    };
    if window.set_size(size).is_ok() {
        // 放大后重新夹紧当前位置，避免窗口右侧或底部被推出当前显示器。
        let _ = move_pet_window(app, 0, 0);
    }
}

/// 将窗口左上角限制到单个显示器内；窗口大于显示器时贴齐其左上角。
#[allow(clippy::too_many_arguments)]
fn clamp_window_position(
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    monitor_x: i32,
    monitor_y: i32,
    monitor_width: u32,
    monitor_height: u32,
) -> (i32, i32) {
    let left = i64::from(monitor_x);
    let top = i64::from(monitor_y);
    let right = left + i64::from(monitor_width);
    let bottom = top + i64::from(monitor_height);
    let max_x = (right - i64::from(width)).max(left);
    let max_y = (bottom - i64::from(height)).max(top);
    (
        i64::from(x).clamp(left, max_x) as i32,
        i64::from(y).clamp(top, max_y) as i32,
    )
}

/// 按物理像素增量移动桌宠，收敛到最近可见显示器并持久化最终位置。
pub fn move_pet_window<R: Runtime>(
    app: &AppHandle<R>,
    delta_x: i32,
    delta_y: i32,
) -> Result<(), String> {
    let window = app
        .get_webview_window(PET_WINDOW_LABEL)
        .ok_or_else(|| "PET_WINDOW_NOT_FOUND: pet window has not been created".to_string())?;
    let current = window.outer_position().map_err(|error| {
        format!("PET_WINDOW_POSITION_FAILED: failed to read pet window position: {error}")
    })?;
    let size = window.outer_size().map_err(|error| {
        format!("PET_WINDOW_SIZE_FAILED: failed to read pet window size: {error}")
    })?;
    let desired_x = current.x.saturating_add(delta_x);
    let desired_y = current.y.saturating_add(delta_y);
    let center_x = i64::from(desired_x) + i64::from(size.width) / 2;
    let center_y = i64::from(desired_y) + i64::from(size.height) / 2;
    let monitors = app.available_monitors().map_err(|error| {
        format!("PET_MONITOR_LIST_FAILED: failed to list visible monitors: {error}")
    })?;
    if monitors.is_empty() {
        return Err("PET_MONITOR_NOT_FOUND: no visible monitor is available".to_string());
    }

    // 目标中心已进入某屏时直接选择该屏；跨过屏幕间隙时选距离目标最近的屏幕。
    let monitor = monitors
        .iter()
        .find(|monitor| {
            let pos = monitor.position();
            let area = monitor.size();
            let right = i64::from(pos.x) + i64::from(area.width);
            let bottom = i64::from(pos.y) + i64::from(area.height);
            center_x >= i64::from(pos.x)
                && center_x < right
                && center_y >= i64::from(pos.y)
                && center_y < bottom
        })
        .or_else(|| {
            monitors.iter().min_by_key(|monitor| {
                let pos = monitor.position();
                let area = monitor.size();
                let left = i64::from(pos.x);
                let top = i64::from(pos.y);
                let right = left + i64::from(area.width);
                let bottom = top + i64::from(area.height);
                let dx = if center_x < left {
                    left - center_x
                } else if center_x >= right {
                    center_x - right + 1
                } else {
                    0
                };
                let dy = if center_y < top {
                    top - center_y
                } else if center_y >= bottom {
                    center_y - bottom + 1
                } else {
                    0
                };
                dx.saturating_mul(dx).saturating_add(dy.saturating_mul(dy))
            })
        })
        .expect("非空显示器列表应能选择目标显示器");
    let monitor_pos = monitor.position();
    let monitor_size = monitor.size();
    let (x, y) = clamp_window_position(
        desired_x,
        desired_y,
        size.width,
        size.height,
        monitor_pos.x,
        monitor_pos.y,
        monitor_size.width,
        monitor_size.height,
    );
    window
        .set_position(tauri::Position::Physical(PhysicalPosition::new(x, y)))
        .map_err(|error| format!("PET_WINDOW_MOVE_FAILED: failed to move pet window: {error}"))?;
    save_pet_window_position(
        app,
        &PetWindowPosition {
            x: Some(x),
            y: Some(y),
        },
    );
    Ok(())
}

/// 只把桌宠窗口当前位置落盘，不做任何显示器夹取。
///
/// # 为什么不复用 `move_pet_window(app, 0, 0)`
///
/// `move_pet_window` 夹的是**整个窗口**，而宠物只是窗口底部居中的一小块，四周是
/// 透明留白（`PET_WINDOW_PAD_X` / `PET_WINDOW_TOP_PAD` / 窗口最小宽度
/// `PET_WINDOW_MIN_WIDTH`）。前端跟手时按「宠物本体 / 脚底」边界把窗口夹进显示器
/// 工作区（与飞行共用边界），整窗夹取会把这些留白也算进去，于是贴边松手的瞬间把
/// 宠物从边缘推开一段（100% 大小时左侧约 `(420 - 220) / 2 = 100` 物理像素）。
///
/// 因此拖拽收尾只负责持久化：位置由前端保证在可见工作区内（见
/// `src/pet/hooks/use-pet-window-clamp.ts` 与 `src/hooks/use-window-draggable.ts`）。
pub fn persist_pet_window_position<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let window = app
        .get_webview_window(PET_WINDOW_LABEL)
        .ok_or_else(|| "PET_WINDOW_NOT_FOUND: pet window has not been created".to_string())?;
    let current = window.outer_position().map_err(|error| {
        format!("PET_WINDOW_POSITION_FAILED: failed to read pet window position: {error}")
    })?;
    save_pet_window_position(
        app,
        &PetWindowPosition {
            x: Some(current.x),
            y: Some(current.y),
        },
    );
    Ok(())
}

/// 确保桌宠窗口存在并恢复位置。
///
/// 幂等：已注册时直接复用返回；不存在（首次启用，或上次收起时已被销毁）时
/// 创建 `pet` 窗口并恢复上一次保存的位置（无记录则默认定位在主屏右下角略偏上，
/// 避免遮挡主工作区）。
///
/// 创建窗口只能来自 app setup 或异步运行时的命令任务：`WebviewWindowBuilder::build()`
/// 经 channel 等主线程事件循环回包，主线程调用会死锁；销毁窗口则**绝不能**在主线程
/// 调用（`WindowMessage::Destroy` 在主线程直接 panic）。两条约束都由
/// `bridge::pet::defer_pet_window_op` 统一保证。
pub fn ensure_pet_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<WebviewWindow<R>> {
    if let Some(window) = app.get_webview_window(PET_WINDOW_LABEL) {
        return Ok(window);
    }
    if !crate::pet_overlay_supported_env() {
        log::warn!(
            "PET_OVERLAY_UNSUPPORTED: always-on-top and absolute positioning are unavailable on \
             a native Wayland session; the pet window is covered by other windows and does not \
             stay where it was placed. Enable the XWayland option in pet settings to restore them."
        );
    }
    let app_handle = app.clone();
    let (width, height) =
        pet_window_logical_size(get_pet_size_percent(app), pet_window_aspect(app));
    // 非 Windows 平台在此前加入注入脚本时再赋值，故需要 mut；Windows 下保持只读。
    #[allow(unused_mut)]
    let mut builder =
        WebviewWindowBuilder::new(app, PET_WINDOW_LABEL, WebviewUrl::App("pet.html".into()))
            .title("Deepseek Harness Pet")
            .inner_size(width, height)
            .resizable(false)
            .maximizable(false)
            .transparent(true)
            .always_on_top(true)
            .decorations(false)
            .skip_taskbar(true)
            .shadow(false)
            .accept_first_mouse(true)
            .visible(false);

    // 非 Windows 平台经 initialization script 让 dsh 容器的桥/兼容注入生效，
    // 与主窗口保持一致（桌宠页同样可能加载共享的前端模块）。
    #[cfg(not(windows))]
    {
        builder = builder
            .initialization_script_for_all_frames(crate::desktop::compat::ABORT_SIGNAL_ANY_SHIM_JS)
            .initialization_script_for_all_frames(crate::desktop::compat::ITERATOR_HELPERS_SHIM_JS)
            .initialization_script_for_all_frames(
                crate::desktop::notification::NOTIFICATION_SHIM_JS,
            )
            .initialization_script_for_all_frames(crate::desktop::paste::PASTE_SHIM_JS)
            .initialization_script_for_all_frames(
                crate::desktop::plugin_boot::PLUGIN_BOOT_RELOAD_JS,
            );
    }

    let window = builder.build()?;
    // Linux：`inner_size` 按 GTK 缩放系数解释，与页面缩放不同口径（XWayland + 分数缩放），
    // 建好后立刻按页面缩放改成物理尺寸，后续默认定位也按这个尺寸算。
    #[cfg(target_os = "linux")]
    {
        let (width, height) = pet_window_physical_size(app, window.scale_factor().unwrap_or(1.0));
        let _ = window.set_size(tauri::PhysicalSize::new(width, height));
    }
    let app_for_pos = app_handle.clone();
    let saved = get_pet_window_position(&app_for_pos);
    if let (Some(x), Some(y)) = (saved.x, saved.y) {
        // 恢复的位置必须落在某个可见屏幕内，否则回退默认定位（防止显示器
        // 拓扑变化后窗口被放到屏幕外不可见）。
        if position_on_any_monitor(&window, x, y) {
            let _ = window.set_position(tauri::Position::Physical(PhysicalPosition::new(x, y)));
        } else {
            place_pet_at_default(&window);
        }
    } else {
        place_pet_at_default(&window);
    }
    Ok(window)
}

/// 判断给定物理坐标（窗口左上角）是否落在任一可见屏幕内（含边缘相交）。
///
/// 显示器拓扑可能在保存位置后变化（拔掉外接屏 / 改变排布），恢复到一个不
/// 属于任何屏幕的位置会让桌宠「消失」在屏幕外；这里只在原位置仍有效时恢复。
fn position_on_any_monitor<R: Runtime>(window: &WebviewWindow<R>, x: i32, y: i32) -> bool {
    let app = window.app_handle();
    let Ok(monitors) = app.available_monitors() else {
        return false;
    };
    // 以当前设置的窗口逻辑尺寸 × 缩放系数近似命中矩形，允许窗口底部/右侧
    // 探出一点点也不误判。
    #[cfg(target_os = "linux")]
    let (w, h) = {
        let (w, h) = pet_window_physical_size(app, window.scale_factor().unwrap_or(1.0));
        (w as i32, h as i32)
    };
    #[cfg(not(target_os = "linux"))]
    let (w, h) = {
        let (lw, lh) = pet_window_logical_size(
            get_pet_size_percent(window.app_handle()),
            pet_window_aspect(window.app_handle()),
        );
        (
            (lw * window.scale_factor().unwrap_or(1.0)) as i32,
            (lh * window.scale_factor().unwrap_or(1.0)) as i32,
        )
    };
    let hit_left = x;
    let hit_top = y;
    let hit_right = x + w;
    let hit_bottom = y + h;
    monitors.iter().any(|m| {
        let pos = m.position();
        let size = m.size();
        let (ml, mt) = (pos.x, pos.y);
        let (mr, mb) = (pos.x + size.width as i32, pos.y + size.height as i32);
        // 两个矩形至少有一个点的交集：窗口左上角在屏内，或屏被窗口覆盖。
        hit_left < mr && hit_right > ml && hit_top < mb && hit_bottom > mt
    })
}

/// 把桌宠窗口放到主工作区右下角略偏上（主屏内、避开底部任务栏高度）。
fn place_pet_at_default<R: Runtime>(window: &WebviewWindow<R>) {
    let app = window.app_handle();
    let Some(monitor) = app.primary_monitor().ok().flatten() else {
        return;
    };
    let mon_pos = monitor.position();
    let mon_size = monitor.size();
    // 距屏幕右下角 32px 的物理偏移；尺寸 = 当前设置逻辑尺寸 × 屏幕缩放系数。
    #[cfg(target_os = "linux")]
    let (w, h) = {
        let (w, h) = pet_window_physical_size(app, monitor.scale_factor());
        (w as i32, h as i32)
    };
    #[cfg(not(target_os = "linux"))]
    let (w, h) = {
        let (lw, lh) = pet_window_logical_size(get_pet_size_percent(app), pet_window_aspect(app));
        (
            (lw * monitor.scale_factor()) as i32,
            (lh * monitor.scale_factor()) as i32,
        )
    };
    let x = mon_pos.x + mon_size.width as i32 - w - 32;
    let y = mon_pos.y + mon_size.height as i32 - h - 96;
    let _ = window.set_position(tauri::Position::Physical(PhysicalPosition::new(x, y)));
}

/// 显示或关闭桌宠窗口。
///
/// # 隐藏 = 销毁窗口实例（issue #469）
///
/// 这里**不做 hide**：隐藏只是把窗口从屏幕上撤下，WebView 进程与页面都还在，桌宠的
/// 双 `<video>` 会继续解码播放——Chromium/WebView2 对「播放中（未暂停）的 video」
/// 无条件持有 Video Wake Lock，屏幕因此永远无法息屏，还白占 CPU（用户报告：收起宠物
/// 后仍无法黑屏）。销毁窗口才是真正「收起」：webview 进程随窗口一起消失，视频暂停、
/// 唤醒锁释放、CPU 归零。代价是重新显示要重建 webview（页面前端挂载时用
/// `get_pet_status` 拉取状态，不依赖创建时的事件投递）。
///
/// # 线程约束（务必读完再改）
///
/// `tauri-runtime-wry` 对主线程上的窗口生命周期消息是「创建会死锁、销毁会 panic」：
///
/// - **销毁**走 `WindowMessage::Destroy`，主线程调用直接
///   `panic!("cannot handle \`WindowMessage::Destroy\` on the main thread")`
///   （tauri-runtime-wry 2.11.4 lib.rs:3494）。command handler 在主线程执行，所以
///   收起命令必须经 `bridge::pet::defer_pet_window_op` 丢到异步运行时再调本函数。
/// - **创建**（`ensure_pet_window` → `WebviewWindowBuilder::build()`）经 channel 等
///   主线程事件循环回包，仅允许 app setup 或异步运行时任务调用（app setup 在事件
///   循环初始化前、不与回包竞争，是唯一的主线程例外）。
pub fn set_pet_window_visible<R: Runtime>(app: &AppHandle<R>, visible: bool) -> Result<(), String> {
    if !visible {
        if let Some(window) = app.get_webview_window(PET_WINDOW_LABEL) {
            window
                .destroy()
                .map_err(|error| format!("PET_WINDOW_DESTROY_FAILED: {error}"))?;
        }
        return Ok(());
    }
    let window =
        ensure_pet_window(app).map_err(|error| format!("PET_WINDOW_CREATE_FAILED: {error}"))?;
    window
        .show()
        .map_err(|error| format!("PET_WINDOW_SHOW_FAILED: {error}"))?;
    Ok(())
}

/// setup 阶段按「是否永久启用」决定桌宠窗口的初始状态。
///
/// 启用才创建并显示；未启用**不创建**：窗口是「显示宠物」的唯一目的，没人看时连
/// webview 都不该存在（隐藏窗口同样会加载 pet.html、播放动画）。窗口此后由
/// [`set_pet_window_visible`] 按需创建/销毁。
pub fn init_pet_window<R: Runtime>(app: &AppHandle<R>) {
    // setup 跑在主线程：趁此缓存页面额外缩放，之后异步建窗时也能用。
    #[cfg(target_os = "linux")]
    refresh_page_extra_scale();
    if !crate::config::get_store_dat_setting(app).pet_enabled {
        // 全新安装默认不启用桌宠：不预创建窗口（也顺带不触发 Linux 未 realize
        // 窗口的穿透请求路径）。
        return;
    }
    if let Err(error) = set_pet_window_visible(app, true) {
        log::error!("PET_WINDOW_INIT_FAILED: failed to create pet window: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pet_window_position_serde_roundtrip() {
        let pos = PetWindowPosition {
            x: Some(120),
            y: Some(240),
        };
        let json = serde_json::to_string(&pos).expect("serialize");
        let parsed: PetWindowPosition = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed.x, Some(120));
        assert_eq!(parsed.y, Some(240));
    }

    #[test]
    fn pet_window_position_defaults_to_none() {
        // 缺失字段 / 空对象时应回落默认（未定制位置），不能反序列化失败
        let parsed: PetWindowPosition = serde_json::from_str("{}").expect("deserialize");
        assert!(parsed.x.is_none());
        assert!(parsed.y.is_none());

        let default = PetWindowPosition::default();
        assert!(default.x.is_none() && default.y.is_none());
    }

    #[test]
    fn pet_window_logical_size_scales_with_percent() {
        // 窗口顶部为 Toast 区，宠物资源本身仍按内置 16:9 画布或 8x11 atlas 尺寸绘制。
        for percent in [50.0, 100.0, 200.0] {
            let (width, height) = pet_window_logical_size(percent, PET_CUSTOM_ASPECT);
            let scale = percent / 100.0;
            // 大比例时窗口跟随宠物宽度，小比例时兜底到 Toast 区最小宽度。
            assert_eq!(
                width,
                (PET_SPRITE_BASE_WIDTH * scale + PET_WINDOW_PAD_X).max(PET_WINDOW_MIN_WIDTH)
            );
            assert_eq!(
                height,
                PET_SPRITE_BASE_WIDTH * PET_CUSTOM_ASPECT * scale + 82.0
            );
        }
        // 内置鲸鱼为 16:9 画布，窗口高度远小于 8x11 图集，避免窗口过高产生大片透明区。
        let (_, builtin_height) = pet_window_logical_size(100.0, PET_BUILTIN_ASPECT);
        assert_eq!(
            builtin_height,
            PET_SPRITE_BASE_WIDTH * PET_BUILTIN_ASPECT + 82.0
        );
    }

    #[test]
    fn pet_window_aspect_matches_builtin_and_custom() {
        // 未设置 / 空白 / 未限定 id（预设 WebM）都走内置 16:9 比例；
        // 来源限定 id（chat:/codex:）走自定义图集比例。
        // 使用一个真实 AppHandle 才能读设置，这里仅验证比例常量与归一化分支的纯逻辑。
        assert_eq!(PET_BUILTIN_ASPECT, 9.0 / 16.0);
        assert_eq!(PET_CUSTOM_ASPECT, 208.0 / 192.0);
        let is_builtin = |active: Option<&str>| {
            active
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(|v| !v.contains(':'))
                .unwrap_or(true)
        };
        assert!(is_builtin(None));
        assert!(is_builtin(Some("   ")));
        assert!(is_builtin(Some("maid-deepseek-whale")));
        assert!(is_builtin(Some("another-preset")));
        assert!(!is_builtin(Some("codex:blue_whale")));
        assert!(!is_builtin(Some("chat:cat")));
    }

    #[test]
    fn pet_window_width_crosses_bubble_minimum_at_large_sizes() {
        assert_eq!(
            pet_window_logical_size(50.0, PET_BUILTIN_ASPECT),
            (420.0, 143.875)
        );
        assert_eq!(
            pet_window_logical_size(100.0, PET_BUILTIN_ASPECT),
            (420.0, 205.75)
        );
        assert_eq!(
            pet_window_logical_size(200.0, PET_BUILTIN_ASPECT),
            (472.0, 329.5)
        );
    }

    #[test]
    fn clamp_window_position_handles_extreme_coordinates_and_sizes() {
        assert_eq!(
            clamp_window_position(i32::MAX, i32::MIN, 20, 10, -1920, -1080, 1920, 1080),
            (-20, -1080)
        );
        assert_eq!(
            clamp_window_position(0, 0, u32::MAX, u32::MAX, i32::MIN, i32::MIN, 0, 0),
            (i32::MIN, i32::MIN)
        );
    }

    #[test]
    fn clamp_window_position_keeps_entire_pet_on_monitor() {
        assert_eq!(
            clamp_window_position(1900, 1000, 252, 244, 0, 0, 1920, 1080),
            (1668, 836)
        );
        assert_eq!(
            clamp_window_position(-2000, -500, 252, 244, -1920, 0, 1920, 1080),
            (-1920, 0)
        );
        assert_eq!(
            clamp_window_position(100, 100, 900, 700, 0, 0, 800, 600),
            (0, 0),
            "窗口大于显示器时应贴齐显示器左上角"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_page_extra_scale_matches_measured_webkitgtk_ratios() {
        let dpi = |value: f64| (value * 1024.0) as i32;
        // XWayland + KDE 150%：Xft.dpi=144 → 页面 1.5。
        assert!((linux_page_extra_scale(true, dpi(144.0), None) - 1.5).abs() < 1e-9);
        // 再叠 GDK_DPI_SCALE（实测 0.8333 → 1.25、1.3333 → 2）。
        assert!((linux_page_extra_scale(true, dpi(144.0), Some("0.8333")) - 1.25).abs() < 1e-3);
        assert!((linux_page_extra_scale(true, dpi(144.0), Some("1.3333")) - 2.0).abs() < 1e-3);
        // 120% / 125% 等任意 DPI 按比例。
        assert!((linux_page_extra_scale(true, dpi(120.0), None) - 1.25).abs() < 1e-9);
        // 未设置 / 非法值回落 1。
        assert_eq!(linux_page_extra_scale(true, -1, Some("abc")), 1.0);
        assert_eq!(linux_page_extra_scale(true, dpi(96.0), Some("0")), 1.0);
        // 原生 Wayland：页面缩放只等于 GTK 缩放系数，Xft.dpi 不参与。
        assert_eq!(linux_page_extra_scale(false, dpi(144.0), Some("1.5")), 1.0);
    }
}
