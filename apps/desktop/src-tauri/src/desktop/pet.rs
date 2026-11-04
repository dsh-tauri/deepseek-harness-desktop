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
//! - `always_on_top` 在 Windows 上 Tauri 原生 API 即可保持置顶（BongoCat 为
//!   额外稳定性用 SetWindowPos 循环轮询，本项目暂不做该平台特定加固）。
//! - 原生 Wayland 会话下 `always_on_top` 与 `set_position` 都不生效，桌宠被主窗口
//!   遮挡（issue #649，上游 tauri-apps/tao#1134 已按「Wayland 不支持」补文档结案）。
//!   同一后端下 `outer_position()` 恒为 `{x:0,y:0}`，几何持久化因此一并跳过。
//!   判定见 `crate::pet_overlay_supported`，前端据此提示用户。

use crate::{AppHandle, Window};
use crate::config::{store_dat_file_name, STORE_PET_WINDOW_STATE_KEY};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::PhysicalPosition;
use tauri::{ Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
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
    /// 保存 outer_position；未记录时使用默认落点。
    pub x: Option<i32>,
    pub y: Option<i32>,
    #[cfg(target_os = "macos")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scale_factor: Option<f64>,
}

#[cfg(target_os = "macos")]
impl PetWindowPosition {
    fn logical_position(&self, fallback_scale: f64) -> Option<(f64, f64)> {
        // 旧记录没有原屏幕缩放，只能按新窗口缩放尝试恢复，再校验可见性。
        let scale = self
            .scale_factor
            .filter(|scale| scale.is_finite() && *scale > 0.0)
            .unwrap_or(fallback_scale);
        let scale = if scale.is_finite() && scale > 0.0 {
            scale
        } else {
            1.0
        };
        Some((f64::from(self.x?) / scale, f64::from(self.y?) / scale))
    }
}

/// macOS 各屏物理坐标使用各自缩放，比较前须还原到全局逻辑点。
#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Copy)]
struct PetRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[cfg(target_os = "macos")]
impl PetRect {
    fn from_physical(position: (i32, i32), size: (u32, u32), scale: f64) -> Self {
        Self {
            x: f64::from(position.0) / scale,
            y: f64::from(position.1) / scale,
            width: f64::from(size.0) / scale,
            height: f64::from(size.1) / scale,
        }
    }

    fn intersects(&self, other: &Self) -> bool {
        self.x < other.x + other.width
            && self.x + self.width > other.x
            && self.y < other.y + other.height
            && self.y + self.height > other.y
    }

    fn constrained_position(&self, monitors: &[Self]) -> Option<(f64, f64)> {
        let center_x = self.x + self.width / 2.0;
        let center_y = self.y + self.height / 2.0;
        let distance = |monitor: &Self| {
            let dx = (monitor.x - center_x)
                .max(center_x - monitor.x - monitor.width)
                .max(0.0);
            let dy = (monitor.y - center_y)
                .max(center_y - monitor.y - monitor.height)
                .max(0.0);
            dx * dx + dy * dy
        };
        let monitor = monitors
            .iter()
            .find(|monitor| {
                center_x >= monitor.x
                    && center_x < monitor.x + monitor.width
                    && center_y >= monitor.y
                    && center_y < monitor.y + monitor.height
            })
            .or_else(|| {
                monitors
                    .iter()
                    .min_by(|a, b| distance(a).total_cmp(&distance(b)))
            })?;
        Some((
            self.x.clamp(
                monitor.x,
                (monitor.x + monitor.width - self.width).max(monitor.x),
            ),
            self.y.clamp(
                monitor.y,
                (monitor.y + monitor.height - self.height).max(monitor.y),
            ),
        ))
    }
}

#[cfg(target_os = "macos")]
impl From<&tauri::Monitor> for PetRect {
    fn from(monitor: &tauri::Monitor) -> Self {
        let position = monitor.position();
        let size = monitor.size();
        Self::from_physical(
            (position.x, position.y),
            (size.width, size.height),
            monitor.scale_factor(),
        )
    }
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

/// 内存中待落盘的桌宠位置。与主窗口（`config::GEOMETRY_CACHE`）同一策略：
/// 移动事件只覆盖这里，磁盘在退出或收起宠物时写一次。
///
/// 逐事件 `store.save()` 是同步整文件写盘；即便按 500ms 节流，事件本身仍要
/// `outer_position()` —— 在 Electron 运行时里那是一次同步 IPC 往返，拖动时每秒
/// 数百次往返足以让跟手明显发滞（issue #1380）。
static PET_GEOMETRY_PENDING: Mutex<Option<PetWindowPosition>> = Mutex::new(None);

/// 记一帧桌宠移动（`Moved` 事件自带位置，不再回问 `outer_position()`）。
pub fn record_pet_window_moved<R: Runtime>(window: &Window<R>, position: PhysicalPosition<i32>) {
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    let next = PetWindowPosition {
        x: Some(position.x),
        y: Some(position.y),
        #[cfg(target_os = "macos")]
        scale_factor: window
            .scale_factor()
            .ok()
            .filter(|scale| scale.is_finite() && *scale > 0.0),
    };
    *PET_GEOMETRY_PENDING
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(next);
}

/// 把暂存位置落盘（退出、收起宠物、拖拽收尾时调用）。没有暂存就什么都不做。
pub fn flush_pet_window_position<R: Runtime>(app: &AppHandle<R>) {
    let pending = PET_GEOMETRY_PENDING
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take();
    if let Some(position) = pending {
        save_pet_window_position(app, &position);
    }
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

/// 跨屏 DPI 变化时只恢复页面尺寸，避免整窗夹取把正在拖动的宠物推回原屏。
pub fn apply_pet_size<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_window(PET_WINDOW_LABEL) else {
        return;
    };
    let (width, height) =
        pet_window_logical_size(get_pet_size_percent(app), pet_window_aspect(app));
    let size = tauri::LogicalSize::new(width, height);
    let _ = window.set_size(size);
}

/// 将窗口左上角限制到单个显示器内；窗口大于显示器时贴齐其左上角。
#[allow(clippy::too_many_arguments)]
#[cfg(any(not(target_os = "macos"), test))]
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
        .get_window(PET_WINDOW_LABEL)
        .ok_or_else(|| "PET_WINDOW_NOT_FOUND: pet window has not been created".to_string())?;
    let current = window.outer_position().map_err(|error| {
        format!("PET_WINDOW_POSITION_FAILED: failed to read pet window position: {error}")
    })?;
    let size = window.outer_size().map_err(|error| {
        format!("PET_WINDOW_SIZE_FAILED: failed to read pet window size: {error}")
    })?;
    let monitors = app.available_monitors().map_err(|error| {
        format!("PET_MONITOR_LIST_FAILED: failed to list visible monitors: {error}")
    })?;
    if monitors.is_empty() {
        return Err("PET_MONITOR_NOT_FOUND: no visible monitor is available".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        let scale = window.scale_factor().map_err(|error| {
            format!("PET_WINDOW_SCALE_FAILED: failed to read pet window scale: {error}")
        })?;
        let desired = PetRect::from_physical(
            (
                current.x.saturating_add(delta_x),
                current.y.saturating_add(delta_y),
            ),
            (size.width, size.height),
            scale,
        );
        let monitors: Vec<_> = monitors.iter().map(PetRect::from).collect();
        let (x, y) = desired
            .constrained_position(&monitors)
            .expect("非空显示器列表应能选择目标显示器");
        window
            .set_position(tauri::LogicalPosition::new(x, y))
            .map_err(|error| {
                format!("PET_WINDOW_MOVE_FAILED: failed to move pet window: {error}")
            })?;
        persist_pet_window_position(app)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let desired_x = current.x.saturating_add(delta_x);
        let desired_y = current.y.saturating_add(delta_y);
        let center_x = i64::from(desired_x) + i64::from(size.width) / 2;
        let center_y = i64::from(desired_y) + i64::from(size.height) / 2;
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
            .map_err(|error| {
                format!("PET_WINDOW_MOVE_FAILED: failed to move pet window: {error}")
            })?;
        save_pet_window_position(
            app,
            &PetWindowPosition {
                x: Some(x),
                y: Some(y),
            },
        );
        Ok(())
    }
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
        .get_window(PET_WINDOW_LABEL)
        .ok_or_else(|| "PET_WINDOW_NOT_FOUND: pet window has not been created".to_string())?;
    let current = window.outer_position().map_err(|error| {
        format!("PET_WINDOW_POSITION_FAILED: failed to read pet window position: {error}")
    })?;
    save_pet_window_position(
        app,
        &PetWindowPosition {
            x: Some(current.x),
            y: Some(current.y),
            #[cfg(target_os = "macos")]
            scale_factor: window
                .scale_factor()
                .ok()
                .filter(|scale| scale.is_finite() && *scale > 0.0),
        },
    );
    PET_GEOMETRY_PENDING
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take();
    Ok(())
}

/// 确保桌宠窗口存在并恢复位置。
///
/// 幂等：已注册时直接复用返回；不存在（首次启用，或上次收起时已被销毁）时
/// 创建 `pet` 窗口并恢复上一次保存的位置（无记录则默认定位在主屏右下角略偏上，
/// 避免遮挡主工作区）。
pub fn ensure_pet_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Window<R>> {
    if let Some(window) = app.get_window(PET_WINDOW_LABEL) {
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
    let builder =
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

    let window = builder.build()?.as_ref().window();
    let app_for_pos = app_handle.clone();
    let saved = get_pet_window_position(&app_for_pos);
    #[cfg(target_os = "macos")]
    let saved_position = saved
        .logical_position(window.scale_factor().unwrap_or(1.0))
        .map(|(x, y)| tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));
    #[cfg(not(target_os = "macos"))]
    let saved_position = saved
        .x
        .zip(saved.y)
        .map(|(x, y)| tauri::Position::Physical(PhysicalPosition::new(x, y)));
    if let Some(position) =
        saved_position.filter(|position| position_on_any_monitor(&window, *position))
    {
        let _ = window.set_position(position);
    } else {
        place_pet_at_default(&window);
    }

    Ok(window)
}

fn position_on_any_monitor<R: Runtime>(
    window: &Window<R>,
    position: tauri::Position,
) -> bool {
    let app = window.app_handle();
    let Ok(monitors) = app.available_monitors() else {
        return false;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let (lw, lh) = pet_window_logical_size(get_pet_size_percent(app), pet_window_aspect(app));
    #[cfg(target_os = "macos")]
    {
        let position = position.to_logical::<f64>(scale);
        let rect = PetRect {
            x: position.x,
            y: position.y,
            width: lw,
            height: lh,
        };
        monitors
            .iter()
            .map(PetRect::from)
            .any(|monitor| rect.intersects(&monitor))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let position = position.to_physical::<i32>(scale);
        let (x, y) = (position.x, position.y);
        let (w, h) = ((lw * scale) as i32, (lh * scale) as i32);
        monitors.iter().any(|monitor| {
            let pos = monitor.position();
            let size = monitor.size();
            x < pos.x + size.width as i32
                && x + w > pos.x
                && y < pos.y + size.height as i32
                && y + h > pos.y
        })
    }
}

/// 把桌宠窗口放到主工作区右下角略偏上（主屏内、避开底部任务栏高度）。
fn place_pet_at_default<R: Runtime>(window: &Window<R>) {
    let app = window.app_handle();
    let Some(monitor) = app.primary_monitor().ok().flatten() else {
        return;
    };
    let (lw, lh) = pet_window_logical_size(get_pet_size_percent(app), pet_window_aspect(app));
    #[cfg(target_os = "macos")]
    {
        let rect = PetRect::from(&monitor);
        let scale = monitor.scale_factor();
        let x = rect.x + rect.width - lw - 32.0 / scale;
        let y = rect.y + rect.height - lh - 96.0 / scale;
        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let mon_pos = monitor.position();
        let mon_size = monitor.size();
        let (w, h) = (
            (lw * monitor.scale_factor()) as i32,
            (lh * monitor.scale_factor()) as i32,
        );
        let x = mon_pos.x + mon_size.width as i32 - w - 32;
        let y = mon_pos.y + mon_size.height as i32 - h - 96;
        let _ = window.set_position(tauri::Position::Physical(PhysicalPosition::new(x, y)));
    }
}

/// 显示或关闭桌宠窗口。
pub fn set_pet_window_visible<R: Runtime>(app: &AppHandle<R>, visible: bool) -> Result<(), String> {
    if !visible {
        if let Some(window) = app.get_window(PET_WINDOW_LABEL) {
            if let Err(error) = persist_pet_window_position(app) {
                log::warn!("[pet] PET_POSITION_PERSIST_FAILED: {error}");
            }
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
    if !crate::config::get_store_dat_setting(app).pet_enabled {
        // 全新安装默认不启用桌宠：不预创建窗口.
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
            ..PetWindowPosition::default()
        };
        let json = serde_json::to_string(&pos).expect("serialize");
        let parsed: PetWindowPosition = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed.x, Some(120));
        assert_eq!(parsed.y, Some(240));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn pet_window_position_preserves_scale_for_cross_monitor_restore() {
        let saved: PetWindowPosition =
            serde_json::from_str(r#"{"x":-5760,"y":820,"scale_factor":2.0}"#).expect("deserialize");
        let serialized = serde_json::to_value(saved).expect("serialize");
        assert_eq!(serialized["scale_factor"], serde_json::json!(2.0));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_saved_position_uses_original_scale_after_restart_on_another_monitor() {
        let saved: PetWindowPosition =
            serde_json::from_str(r#"{"x":3600,"y":600,"scale_factor":2.0}"#).expect("deserialize");
        assert_eq!(saved.logical_position(1.0), Some((1800.0, 300.0)));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_legacy_position_uses_current_scale_as_limited_fallback() {
        let saved: PetWindowPosition =
            serde_json::from_str(r#"{"x":3000,"y":600}"#).expect("deserialize");
        assert_eq!(saved.logical_position(2.0), Some((1500.0, 300.0)));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_invalid_saved_scale_uses_valid_fallback() {
        for scale in [0.0, -2.0, f64::NAN, f64::INFINITY] {
            let saved = PetWindowPosition {
                x: Some(-4800),
                y: Some(-400),
                scale_factor: Some(scale),
            };
            assert_eq!(saved.logical_position(2.0), Some((-2400.0, -200.0)));
            assert_eq!(saved.logical_position(0.0), Some((-4800.0, -400.0)));
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_incomplete_saved_position_cannot_be_restored() {
        let saved = PetWindowPosition {
            x: Some(120),
            ..PetWindowPosition::default()
        };
        assert_eq!(saved.logical_position(2.0), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_move_from_retina_to_standard_screen_uses_each_monitor_scale() {
        let desired = PetRect::from_physical((3600, 600), (840, 412), 2.0);
        let monitors = [
            PetRect::from_physical((0, 0), (3420, 2224), 2.0),
            PetRect::from_physical((1710, 0), (2560, 1440), 1.0),
        ];
        assert_eq!(
            desired.constrained_position(&monitors),
            Some((1800.0, 300.0))
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_move_to_negative_retina_screen_clamps_in_logical_points() {
        let desired = PetRect::from_physical((-2540, 1100), (420, 206), 1.0);
        let monitors = [
            PetRect::from_physical((0, 0), (1920, 1080), 1.0),
            PetRect::from_physical((-5120, -400), (5120, 2880), 2.0),
        ];
        assert_eq!(
            desired.constrained_position(&monitors),
            Some((-2540.0, 1034.0))
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_move_reaches_third_screen_above_primary() {
        let desired = PetRect::from_physical((200, -1600), (840, 412), 2.0);
        let monitors = [
            PetRect::from_physical((0, 0), (1920, 1080), 1.0),
            PetRect::from_physical((-2560, 0), (2560, 1440), 1.0),
            PetRect::from_physical((0, -2160), (3840, 2160), 2.0),
        ];
        assert_eq!(
            desired.constrained_position(&monitors),
            Some((100.0, -800.0))
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_window_in_screen_gap_uses_nearest_monitor() {
        let desired = PetRect::from_physical((3800, 600), (840, 412), 2.0);
        let monitors = [
            PetRect::from_physical((0, 0), (3420, 2224), 2.0),
            PetRect::from_physical((2200, 0), (1920, 1080), 1.0),
        ];
        assert_eq!(
            desired.constrained_position(&monitors),
            Some((2200.0, 300.0))
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_visibility_does_not_confuse_retina_primary_with_standard_secondary() {
        let window = PetRect::from_physical((3600, 600), (840, 412), 2.0);
        let primary = PetRect::from_physical((0, 0), (3420, 2224), 2.0);
        let secondary = PetRect::from_physical((1710, 0), (2560, 1440), 1.0);
        assert!(!window.intersects(&primary));
        assert!(window.intersects(&secondary));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_oversized_window_aligns_with_monitor_origin() {
        let window = PetRect::from_physical((100, 100), (900, 700), 1.0);
        let monitor = PetRect::from_physical((-1600, -1200), (1600, 1200), 2.0);
        assert_eq!(
            window.constrained_position(&[monitor]),
            Some((-800.0, -600.0))
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_window_cannot_be_constrained_without_a_monitor() {
        let window = PetRect::from_physical((0, 0), (840, 412), 2.0);
        assert_eq!(window.constrained_position(&[]), None);
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
}
