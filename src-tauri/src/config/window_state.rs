//! 主窗口几何持久化：记住窗口大小/位置/最大化状态，重启后恢复。
//!
//! 为什么不直接用官方的 tauri-plugin-window-state：本项目主窗口是程序化创建
//! （见 `desktop::builder::build_main_window`）、自定义壳层标题栏（macOS 上保留原生交通灯），
//! 且关闭时是「隐藏到托盘」而非销毁（见 builder 的 on_window_event），并叠加
//! release 的单例复用（二次启动 show/focus 同一窗口）。插件默认把状态写进独立的
//! 配置文件、恢复时机与这套「隐藏 + 单例」流程存在耦合，且与本项目「所有应用数据
//! 落进 store 文件（.store.dat/.store.dev.dat）」的约定不一致。因此这里基于已有的
//! `tauri-plugin-store` 手动读写，几何记录的时机与恢复流程完全可控。

use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Position, Runtime, Size, WebviewWindow,
    Window,
};
use tauri_plugin_store::StoreExt;

use super::constants::STORE_WINDOW_STATE_KEY;
use super::setting::store_dat_file_name;

/// 主窗口默认尺寸（逻辑像素，首次启动/无历史时由 builder 采用）
pub const DEFAULT_WINDOW_WIDTH: f64 = 1280.0;
pub const DEFAULT_WINDOW_HEIGHT: f64 = 840.0;
/// 主窗口最小尺寸（与 build_main_window 的 min_inner_size 对齐）
pub const MIN_WINDOW_WIDTH: f64 = 860.0;
pub const MIN_WINDOW_HEIGHT: f64 = 620.0;

/// 记录一帧主窗口几何。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct WindowState {
    /// 上次是否为最大化状态
    pub maximized: bool,
    /// 非最大化时的物理位置（outer_position，屏幕左上角为原点）
    pub x: Option<i32>,
    pub y: Option<i32>,
    /// 物理尺寸（inner_size，与 Tauri set_size 的语义一致）
    pub width: u32,
    pub height: u32,
    /// 尺寸是否为内容区尺寸；旧记录缺少此字段时按外框尺寸迁移
    #[serde(default)]
    pub size_is_inner: bool,
}

impl Default for WindowState {
    fn default() -> Self {
        Self {
            maximized: false,
            x: None,
            y: None,
            width: DEFAULT_WINDOW_WIDTH as u32,
            height: DEFAULT_WINDOW_HEIGHT as u32,
            size_is_inner: true,
        }
    }
}

/// 启动期「几何恢复窗口」门闩：置位期间的一切几何采样都不落盘。
///
/// 主窗口是程序化创建的（见 `desktop::builder::build_main_window`）：在恢复上次
/// 几何之前，平台已经先按 builder 默认值（1280×840）建窗并派发 Moved/Resized。
/// Windows 靠 `visible(false)` 把窗口藏到恢复之后再 show 来规避，但 macOS/Linux
/// 建窗即可见——这些瞬态几何一旦落盘，就会把用户保存的尺寸/位置覆盖成默认值，
/// 于是「每次启动都要重新拉伸」（issue #464）。这里按恢复窗口期统一门控所有平台，
/// 而不是再依赖平台各自的建窗时序。
static RESTORING_GEOMETRY: AtomicBool = AtomicBool::new(false);

/// 启动几何恢复窗口的 RAII 守卫：`begin()` 进入，drop 退出。
///
/// 用守卫而不是裸 `store(false)`：`build_main_window` 中途 `?` 返回、建窗失败等
/// 异常路径也会正常释放，不会把几何采样永久关掉（那会导致再也不记住窗口大小）。
pub struct GeometryRestoreGuard;

impl GeometryRestoreGuard {
    /// 进入恢复窗口；必须在创建主窗口之前调用。
    pub fn begin() -> Self {
        RESTORING_GEOMETRY.store(true, Ordering::SeqCst);
        Self
    }
}

impl Drop for GeometryRestoreGuard {
    fn drop(&mut self) {
        RESTORING_GEOMETRY.store(false, Ordering::SeqCst);
    }
}

/// 当前是否处于启动几何恢复窗口（采样门控用）。
fn is_restoring_geometry() -> bool {
    RESTORING_GEOMETRY.load(Ordering::SeqCst)
}

/// 读取上次保存的窗口状态；无记录时返回默认值（首次启动）。
pub fn get_window_state<R: Runtime>(app_handle: &AppHandle<R>) -> WindowState {
    let store = app_handle
        .store(store_dat_file_name())
        .expect("Failed to load store for window state");
    let raw = store.get(STORE_WINDOW_STATE_KEY);
    raw.and_then(|v| {
        v.as_str()
            .and_then(|s| serde_json::from_str(s).ok())
            .or_else(|| Some(v.clone()))
    })
    .and_then(|v| serde_json::from_value(v).ok())
    .unwrap_or_default()
}

/// 把窗口状态写回 store 并落盘（store 基于 AppData，不随窗口生命周期丢失）。
fn save_window_state<R: Runtime>(app_handle: &AppHandle<R>, state: &WindowState) {
    let store = app_handle
        .store(store_dat_file_name())
        .expect("Failed to load store for window state");
    let serialized = serde_json::to_value(state).expect("Failed to serialize window state");
    store.set(STORE_WINDOW_STATE_KEY, serialized);
    store.save().expect("Failed to save window state");
}

/// 采样当前窗口并保存（主窗口移动/缩放时由 builder 调用）。
pub fn save_geometry<R: Runtime>(window: &Window<R>) {
    // 启动期几何恢复尚未完成：此刻采到的多半是 builder 默认尺寸/居中位置，
    // 落盘会覆盖用户保存值（见 RESTORING_GEOMETRY）。
    if is_restoring_geometry() {
        return;
    }

    // 原生全屏切换会触发 Resized，但此时的屏幕尺寸不是可恢复的
    // 普通窗口几何；保留进入全屏前的最后一帧，退出全屏后会再次正常采样。
    if window.is_fullscreen().unwrap_or(false) {
        return;
    }

    // 窗口尚未显示（Windows 上 builder 先隐藏创建、恢复几何后再 show）时，
    // build()/restore 阶段触发的 Moved/Resized 事件拿到的可能是瞬态尺寸
    // （常被夹到最小尺寸），一旦落盘就会让窗口永久卡在最小尺寸。
    // 因此未显示前不采样；真正几何在 show 之后的下一次移动/缩放或退出时保存。
    if !window.is_visible().unwrap_or(false) {
        return;
    }

    let pos = window.outer_position().ok();
    let size = window.inner_size().ok();
    let state = WindowState {
        maximized: window.is_maximized().unwrap_or(false),
        x: pos.map(|p| p.x),
        y: pos.map(|p| p.y),
        width: size.map(|s| s.width).unwrap_or(DEFAULT_WINDOW_WIDTH as u32),
        height: size
            .map(|s| s.height)
            .unwrap_or(DEFAULT_WINDOW_HEIGHT as u32),
        size_is_inner: true,
    };
    save_window_state(window.app_handle(), &state);
}

/// 正常退出前主动采样主窗口，兜底最后一次移动/缩放事件尚未落盘的情况。
pub fn save_main_window_geometry<R: Runtime>(app_handle: &AppHandle<R>) {
    if let Some(webview_window) = app_handle.get_webview_window("main") {
        let window = webview_window.as_ref().window();
        save_geometry(&window);
    }
}

/// 把旧版保存的外框尺寸换算成 set_size 所需的内容区尺寸。
fn migrate_legacy_outer_size(
    saved: &WindowState,
    current_outer: PhysicalSize<u32>,
    current_inner: PhysicalSize<u32>,
) -> WindowState {
    if saved.size_is_inner {
        return saved.clone();
    }

    let frame_width = current_outer.width.saturating_sub(current_inner.width);
    let frame_height = current_outer.height.saturating_sub(current_inner.height);
    WindowState {
        width: saved.width.saturating_sub(frame_width),
        height: saved.height.saturating_sub(frame_height),
        size_is_inner: true,
        ..saved.clone()
    }
}

/// 保存的尺寸是否退化到最小尺寸（含以下）。
///
/// 启动过渡、瞬态采样或损坏数据被夹到最小尺寸后，往往会在
/// 下一次移动/缩放时被当作「用户真实尺寸」写回 store，导致窗口永久卡在最小尺寸。
/// 这类记录不该被当作可恢复几何，否则无法自愈；此时应回落到 builder 默认尺寸
/// （唯一一处「连尺寸都不恢复」是刻意的）。
fn is_degenerate_size(saved: &WindowState) -> bool {
    (saved.width as f64) <= MIN_WINDOW_WIDTH && (saved.height as f64) <= MIN_WINDOW_HEIGHT
}

/// 屏幕矩形（物理像素，左上角为原点）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ScreenRect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl ScreenRect {
    /// 右边界（x + width）。
    fn right(&self) -> i32 {
        self.x.saturating_add(self.width as i32)
    }

    /// 下边界（y + height）。
    fn bottom(&self) -> i32 {
        self.y.saturating_add(self.height as i32)
    }

    /// 与另一矩形是否有面积交集。
    fn intersects(&self, other: &ScreenRect) -> bool {
        self.x < other.right()
            && self.right() > other.x
            && self.y < other.bottom()
            && self.bottom() > other.y
    }
}

/// 多个屏幕矩形的并集；无可用屏幕时 `None`。
fn union_rect<I>(rects: I) -> Option<ScreenRect>
where
    I: IntoIterator<Item = ScreenRect>,
{
    let mut iter = rects.into_iter();
    let mut union = iter.next()?;
    for rect in iter {
        let left = union.x.min(rect.x);
        let top = union.y.min(rect.y);
        let right = union.right().max(rect.right());
        let bottom = union.bottom().max(rect.bottom());
        union = ScreenRect {
            x: left,
            y: top,
            width: (right - left) as u32,
            height: (bottom - top) as u32,
        };
    }
    Some(union)
}

/// 解析结果：尺寸始终可用；位置不可用时为 `None`（交给 Tauri 默认居中）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ResolvedGeometry {
    size: PhysicalSize<u32>,
    position: Option<PhysicalPosition<i32>>,
}

/// 按「尺寸与位置解耦」解析保存的几何（纯函数，便于单测）。
///
/// `screens` 是当前枚举到的**每一块**屏幕，而不是它们的包围盒：多屏错位摆放时
/// 包围盒（`union_rect`）会覆盖显示器之间的空隙，拿它当可见区会让「落在空隙里」
/// 的窗口被误判成可见、恢复成屏幕外的窗口。
///
/// - 退化尺寸（见 `is_degenerate_size`）→ `None`，回落 builder 默认并重新采样；
/// - 尺寸：不小于最小尺寸；能拿到屏幕时再夹进屏幕包围盒（防止拔掉外接大屏后
///   窗口过大）。**位置信息不参与尺寸解析**——拿不到位置不等于没有尺寸可恢复，
///   否则用户「拉伸过的尺寸」会被整体丢弃、每次启动回到 1280×840（issue #464）；
/// - 位置：有记录且压在某一（多）块屏幕上 → 夹进屏幕包围盒；有记录但不在任何
///   屏幕上（外接屏被拔出、或落在多屏空隙里）→ 主屏居中；无记录 / 枚举不到屏幕 /
///   无主屏 → `None`，保持系统默认居中。
fn resolve_geometry_in(
    saved: &WindowState,
    screens: &[ScreenRect],
    primary: Option<ScreenRect>,
) -> Option<ResolvedGeometry> {
    if is_degenerate_size(saved) {
        return None;
    }

    let union = union_rect(screens.iter().copied());
    let mut width = saved.width.max(MIN_WINDOW_WIDTH as u32);
    let mut height = saved.height.max(MIN_WINDOW_HEIGHT as u32);
    if let Some(union) = union {
        width = width.min(union.width.max(MIN_WINDOW_WIDTH as u32));
        height = height.min(union.height.max(MIN_WINDOW_HEIGHT as u32));
    }
    let size = PhysicalSize::new(width, height);

    Some(ResolvedGeometry {
        size,
        position: resolve_position(saved, size, screens, union, primary),
    })
}

/// 位置解析（纯函数）：语义见 `resolve_geometry_in`。
fn resolve_position(
    saved: &WindowState,
    size: PhysicalSize<u32>,
    screens: &[ScreenRect],
    union: Option<ScreenRect>,
    primary: Option<ScreenRect>,
) -> Option<PhysicalPosition<i32>> {
    let (Some(sx), Some(sy)) = (saved.x, saved.y) else {
        return None;
    };
    // 拿不到可见区就无从判断位置是否可恢复，交给系统居中。
    let union = union?;

    let window = ScreenRect {
        x: sx,
        y: sy,
        width: size.width,
        height: size.height,
    };
    // 必须真的压在某一块屏幕上：只落在多屏包围盒的空隙里不算可见。
    if screens.iter().any(|screen| window.intersects(screen)) {
        // 夹紧坐标到包围盒内，保证窗口至少部分可见
        let max_x = union.right().saturating_sub(size.width as i32);
        let max_y = union.bottom().saturating_sub(size.height as i32);
        let nx = (sx as i64).clamp(union.x as i64, (max_x as i64).max(union.x as i64));
        let ny = (sy as i64).clamp(union.y as i64, (max_y as i64).max(union.y as i64));
        return Some(PhysicalPosition::new(nx as i32, ny as i32));
    }

    // 保存的位置不在任何屏幕上（例如保存时的外接屏已被拔出，或落在多屏空隙里）：
    // 回落到主屏居中
    let primary = primary?;
    Some(PhysicalPosition::new(
        primary.x + (primary.width as i32 - size.width as i32) / 2,
        primary.y + (primary.height as i32 - size.height as i32) / 2,
    ))
}

/// 当前所有监视器的矩形列表（空列表表示枚举不到显示器）。
fn screens_of<R: Runtime>(app: &AppHandle<R>) -> Vec<ScreenRect> {
    app.available_monitors()
        .map(|monitors| {
            monitors
                .iter()
                .map(|monitor| ScreenRect {
                    x: monitor.position().x,
                    y: monitor.position().y,
                    width: monitor.size().width,
                    height: monitor.size().height,
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 主屏矩形（位置不可见时的居中回退目标）。
fn primary_screen<R: Runtime>(app: &AppHandle<R>) -> Option<ScreenRect> {
    let monitor = app.primary_monitor().ok().flatten()?;
    Some(ScreenRect {
        x: monitor.position().x,
        y: monitor.position().y,
        width: monitor.size().width,
        height: monitor.size().height,
    })
}

/// 把保存的几何解析成「实际可用的尺寸 + 可选位置」。
fn resolve_geometry<R: Runtime>(
    app: &AppHandle<R>,
    saved: &WindowState,
) -> Option<ResolvedGeometry> {
    resolve_geometry_in(saved, &screens_of(app), primary_screen(app))
}

/// 恢复主窗口的大小与位置。在 `build_main_window` 成功 build() 之后调用。
///
/// 内部读取上次保存的 `WindowState`；顺序说明：先设置物理尺寸，再设置位置
/// （位置可能不可用），最后按需 `maximize()`——最大化会覆盖窗口当前尺寸，
/// 因此尺寸/位置要在最大化之前设置。
///
/// 尺寸与位置解耦：只有「无历史 / 尺寸退化」才放弃尺寸与位置，且**最大化状态
/// 独立恢复**（尺寸退化时窗口只是回落默认尺寸，不该连带丢掉最大化）。
/// 位置拿不到时保持系统居中，不再因为位置信息缺失而把用户拉伸过的尺寸一起丢掉
/// （issue #464）。
pub fn restore_main_window<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) {
    let mut saved = get_window_state(app);
    if !saved.size_is_inner {
        if let (Ok(outer), Ok(inner)) = (window.outer_size(), window.inner_size()) {
            saved = migrate_legacy_outer_size(&saved, outer, inner);
        }
    }
    if let Some(geometry) = resolve_geometry(app, &saved) {
        let _ = window.set_size(Size::Physical(geometry.size));
        if let Some(position) = geometry.position {
            let _ = window.set_position(Position::Physical(position));
        }
    }
    if saved.maximized {
        let _ = window.maximize();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_state_default_matches_builder_default() {
        let state = WindowState::default();
        assert!(!state.maximized);
        assert!(state.x.is_none());
        assert!(state.y.is_none());
        assert_eq!(state.width, DEFAULT_WINDOW_WIDTH as u32);
        assert_eq!(state.height, DEFAULT_WINDOW_HEIGHT as u32);
        assert!(state.size_is_inner);
    }

    #[test]
    fn window_state_serde_roundtrip() {
        let state = WindowState {
            maximized: true,
            x: Some(100),
            y: Some(-200),
            width: 1920,
            height: 1080,
            size_is_inner: true,
        };
        let json = serde_json::to_string(&state).expect("serialize");
        let parsed: WindowState = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed.maximized, state.maximized);
        assert_eq!(parsed.x, state.x);
        assert_eq!(parsed.y, state.y);
        assert_eq!(parsed.width, state.width);
        assert_eq!(parsed.height, state.height);
    }

    #[test]
    fn window_state_ignores_missing_fields() {
        // 老版本/缺失字段时也应能反序列化并回落到默认值
        let parsed: WindowState = serde_json::from_str("{}").expect("deserialize");
        assert!(!parsed.maximized);
        assert!(parsed.x.is_none());
        assert!(parsed.y.is_none());
        assert_eq!(parsed.width, DEFAULT_WINDOW_WIDTH as u32);
        assert_eq!(parsed.height, DEFAULT_WINDOW_HEIGHT as u32);
        assert!(!parsed.size_is_inner);
    }

    #[test]
    fn legacy_outer_size_is_converted_for_set_size() {
        let saved = WindowState {
            width: 1137,
            height: 792,
            size_is_inner: false,
            ..WindowState::default()
        };

        let migrated = migrate_legacy_outer_size(
            &saved,
            PhysicalSize::new(1293, 848),
            PhysicalSize::new(1267, 833),
        );

        assert_eq!(migrated.width, 1111);
        assert_eq!(migrated.height, 777);
        assert!(migrated.size_is_inner);
    }

    #[test]
    fn inner_size_is_not_converted_twice() {
        let saved = WindowState {
            width: 1111,
            height: 777,
            size_is_inner: true,
            ..WindowState::default()
        };

        let migrated = migrate_legacy_outer_size(
            &saved,
            PhysicalSize::new(1293, 848),
            PhysicalSize::new(1267, 833),
        );

        assert_eq!(migrated, saved);
    }

    #[test]
    fn degenerate_size_is_detected() {
        // 恰好是最小尺寸或更小 → 视为退化，避免窗口永久卡在最小尺寸
        let at_min = WindowState {
            width: MIN_WINDOW_WIDTH as u32,
            height: MIN_WINDOW_HEIGHT as u32,
            ..WindowState::default()
        };
        assert!(is_degenerate_size(&at_min));

        let below_min = WindowState {
            width: 200,
            height: 200,
            ..WindowState::default()
        };
        assert!(is_degenerate_size(&below_min));

        // 正常尺寸 → 不作为退化处理
        let normal = WindowState {
            width: DEFAULT_WINDOW_WIDTH as u32,
            height: DEFAULT_WINDOW_HEIGHT as u32,
            ..WindowState::default()
        };
        assert!(!is_degenerate_size(&normal));

        // 仅宽度达标、高度尚未达标 → 两个维度都退化才算退化（单个维度可能是用户的真实窗口）
        let half_normal = WindowState {
            width: DEFAULT_WINDOW_WIDTH as u32,
            height: MIN_WINDOW_HEIGHT as u32,
            ..WindowState::default()
        };
        assert!(!is_degenerate_size(&half_normal));
    }

    /// 构造屏幕矩形（测试夹具）。
    fn rect(x: i32, y: i32, width: u32, height: u32) -> ScreenRect {
        ScreenRect {
            x,
            y,
            width,
            height,
        }
    }

    /// 构造带尺寸的保存记录（位置默认给出）。
    fn saved(x: Option<i32>, y: Option<i32>, width: u32, height: u32) -> WindowState {
        WindowState {
            x,
            y,
            width,
            height,
            size_is_inner: true,
            ..WindowState::default()
        }
    }

    #[test]
    fn union_rect_spans_every_screen() {
        // 主屏 + 左上角在 (1920, -200) 的副屏 → 并集覆盖两者
        let union = union_rect([rect(0, 0, 1920, 1080), rect(1920, -200, 1280, 1024)])
            .expect("union of two screens");
        assert_eq!(union, rect(0, -200, 3200, 1280));

        // 单屏 → 自身
        assert_eq!(
            union_rect([rect(0, 0, 1920, 1080)]),
            Some(rect(0, 0, 1920, 1080))
        );

        // 无显示器信息 → None（而不是退化成 (0,0) 的假屏幕）
        assert_eq!(union_rect(Vec::<ScreenRect>::new()), None);
    }

    #[test]
    fn size_is_restored_even_without_saved_position() {
        // issue #464：没有位置记录（或位置不可用）时，用户拉伸过的尺寸必须照常恢复，
        // 不能整体放弃、回退 builder 默认的 1280×840。
        let resolved = resolve_geometry_in(
            &saved(None, None, 1500, 1000),
            &[rect(0, 0, 1920, 1080)],
            Some(rect(0, 0, 1920, 1080)),
        )
        .expect("geometry resolved without position");

        assert_eq!(resolved.size, PhysicalSize::new(1500, 1000));
        assert_eq!(resolved.position, None);
    }

    #[test]
    fn size_is_restored_even_without_monitor_info() {
        // 启动早期枚举不到显示器（available_monitors 返回空列表）时：
        // 跳过夹紧但保留尺寸，位置交给系统居中。
        let resolved = resolve_geometry_in(&saved(Some(100), Some(100), 1500, 1000), &[], None)
            .expect("geometry resolved without monitors");

        assert_eq!(resolved.size, PhysicalSize::new(1500, 1000));
        assert_eq!(resolved.position, None);
    }

    #[test]
    fn restored_size_never_goes_below_the_minimum() {
        // 只有宽度低于最小尺寸（高度正常，不构成退化记录）→ 宽度被抬到最小尺寸
        let resolved = resolve_geometry_in(
            &saved(Some(0), Some(0), 700, 1000),
            &[rect(0, 0, 1920, 1080)],
            Some(rect(0, 0, 1920, 1080)),
        )
        .expect("geometry resolved");

        assert_eq!(
            resolved.size,
            PhysicalSize::new(MIN_WINDOW_WIDTH as u32, 1000)
        );
    }

    #[test]
    fn restored_size_is_clamped_into_the_visible_union() {
        // 拔掉外接大屏后：保存的尺寸不能超过当前可见并集
        let resolved = resolve_geometry_in(
            &saved(Some(0), Some(0), 3840, 2160),
            &[rect(0, 0, 1920, 1080)],
            Some(rect(0, 0, 1920, 1080)),
        )
        .expect("geometry resolved");

        assert_eq!(resolved.size, PhysicalSize::new(1920, 1080));
    }

    #[test]
    fn visible_position_is_clamped_into_the_visible_union() {
        // 位置部分越界（x=1000 时窗口右边缘超出 1920）→ 夹紧到可见区内
        let resolved = resolve_geometry_in(
            &saved(Some(1000), Some(20), 1500, 1000),
            &[rect(0, 0, 1920, 1080)],
            Some(rect(0, 0, 1920, 1080)),
        )
        .expect("geometry resolved");

        assert_eq!(resolved.size, PhysicalSize::new(1500, 1000));
        assert_eq!(resolved.position, Some(PhysicalPosition::new(420, 20)));
    }

    #[test]
    fn offscreen_position_falls_back_to_primary_center() {
        let resolved = resolve_geometry_in(
            &saved(Some(9000), Some(5000), 1500, 1000),
            &[rect(0, 0, 1920, 1080)],
            Some(rect(0, 0, 1920, 1080)),
        )
        .expect("geometry resolved");

        assert_eq!(resolved.size, PhysicalSize::new(1500, 1000));
        assert_eq!(resolved.position, Some(PhysicalPosition::new(210, 40)));
    }

    #[test]
    fn offscreen_position_without_primary_screen_keeps_the_size() {
        // 位置不可见且拿不到主屏 → 只放弃位置，尺寸照常恢复
        let resolved = resolve_geometry_in(
            &saved(Some(9000), Some(5000), 1500, 1000),
            &[rect(0, 0, 1920, 1080)],
            None,
        )
        .expect("geometry resolved");

        assert_eq!(resolved.size, PhysicalSize::new(1500, 1000));
        assert_eq!(resolved.position, None);
    }

    #[test]
    fn position_in_the_gap_between_offset_screens_is_recentered() {
        // 对角摆放的两块屏：A=(0,0,1920,1080)、B=(1920,1080,1280,1024)。
        // 它们的包围盒 (0,0,3200,2104) 覆盖了「左下角没有显示器」的空隙，
        // 若拿包围盒当可见区，落在空隙里的窗口会被误判为可见、恢复成屏幕外窗口。
        let screens = [rect(0, 0, 1920, 1080), rect(1920, 1080, 1280, 1024)];
        let resolved = resolve_geometry_in(
            &saved(Some(600), Some(1300), 1000, 700),
            &screens,
            Some(rect(0, 0, 1920, 1080)),
        )
        .expect("geometry resolved");

        assert_eq!(resolved.size, PhysicalSize::new(1000, 700));
        // 回落主屏居中：(1920-1000)/2, (1080-700)/2
        assert_eq!(resolved.position, Some(PhysicalPosition::new(460, 190)));
    }

    #[test]
    fn position_on_an_offset_secondary_screen_is_kept() {
        // 回归：多屏错位摆放时，真正压在副屏上的位置必须原样保留
        let screens = [rect(0, 0, 1920, 1080), rect(1920, 1080, 1280, 1024)];
        let resolved = resolve_geometry_in(
            &saved(Some(2000), Some(1200), 1000, 700),
            &screens,
            Some(rect(0, 0, 1920, 1080)),
        )
        .expect("geometry resolved");

        assert_eq!(resolved.size, PhysicalSize::new(1000, 700));
        assert_eq!(resolved.position, Some(PhysicalPosition::new(2000, 1200)));
    }

    #[test]
    fn degenerate_size_still_falls_back_to_builder_defaults() {
        // 退化尺寸是刻意的自愈路径：放弃尺寸与位置、回落 builder 默认并重新采样
        // （最大化状态由 restore_main_window 独立恢复，见其文档）
        let resolved = resolve_geometry_in(
            &saved(
                Some(10),
                Some(10),
                MIN_WINDOW_WIDTH as u32,
                MIN_WINDOW_HEIGHT as u32,
            ),
            &[rect(0, 0, 1920, 1080)],
            Some(rect(0, 0, 1920, 1080)),
        );

        assert!(resolved.is_none());
    }

    #[test]
    fn geometry_restore_guard_gates_sampling_until_dropped() {
        assert!(!is_restoring_geometry());
        {
            let _guard = GeometryRestoreGuard::begin();
            assert!(is_restoring_geometry());
        }
        // 守卫 drop（含 build_main_window 中途 `?` 返回的异常路径）后必须恢复采样
        assert!(!is_restoring_geometry());
    }
}
