//! 几何解析：缩放换算、最小尺寸、屏幕夹紧与离屏回中。
//!
//! 全是纯函数，便于脱离窗口与显示器单测；lib.rs 负责把窗口状态与显示器信息注入进来。

use tauri::{PhysicalPosition, PhysicalSize};

use crate::WindowState;

/// 窗口最小内容区尺寸（与桌面端 min_inner_size 860x620 对齐）
pub(crate) const MIN_WINDOW_WIDTH: u32 = 860;
pub(crate) const MIN_WINDOW_HEIGHT: u32 = 620;

/// 屏幕矩形（物理像素，左上角为原点）及其缩放。
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct ScreenRect {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) scale_factor: f64,
}

impl ScreenRect {
    fn right(&self) -> i32 {
        self.x.saturating_add(self.width as i32)
    }

    fn bottom(&self) -> i32 {
        self.y.saturating_add(self.height as i32)
    }

    fn contains_point(&self, x: i32, y: i32) -> bool {
        x >= self.x && x < self.right() && y >= self.y && y < self.bottom()
    }
}

/// 解析结果：尺寸始终可用；位置不可用时为 None（交给系统默认居中）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct ResolvedGeometry {
    pub(crate) size: PhysicalSize<u32>,
    pub(crate) position: Option<PhysicalPosition<i32>>,
}

/// 保存记录对应的位置；最大化记录改用最大化之前的位置。
///
/// 最大化会把 x/y 改写成显示器角落，prev_x/prev_y 才是用户真正摆放过的地方。
pub(crate) fn saved_position(saved: &WindowState) -> Option<PhysicalPosition<i32>> {
    match (saved.maximized, saved.prev_x, saved.prev_y) {
        (true, Some(x), Some(y)) => Some(PhysicalPosition::new(x, y)),
        _ => {
            let (x, y) = (saved.x?, saved.y?);
            Some(PhysicalPosition::new(x, y))
        }
    }
}

/// 把旧版保存的外框尺寸换算成 set_size 所需的内容区尺寸。
pub(crate) fn migrate_legacy_outer_size(
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

/// 保存的尺寸是否退化：两个维度都不超过最小尺寸。
///
/// 启动过渡或损坏数据被夹到最小尺寸后会被当成用户真实尺寸写回，窗口就永久卡在最小
/// 尺寸；这类记录不能再当作可恢复几何，必须回落建窗默认尺寸。
pub(crate) fn is_degenerate_size(saved: &WindowState) -> bool {
    saved.width <= MIN_WINDOW_WIDTH && saved.height <= MIN_WINDOW_HEIGHT
}

/// 窗口将要落在的那块屏幕的缩放；拿不到记录位置时取主屏。
///
/// 不能用 window.scale_factor()：恢复发生时窗口还在系统的默认位置，它的缩放来自
/// 主屏而不是目标屏。
pub(crate) fn target_scale(
    saved: &WindowState,
    screens: &[ScreenRect],
    primary: Option<ScreenRect>,
) -> f64 {
    if let Some(position) = saved_position(saved)
        && let Some(screen) = screens
            .iter()
            .find(|screen| screen.contains_point(position.x, position.y))
    {
        return screen.scale_factor;
    }
    primary.map(|screen| screen.scale_factor).unwrap_or(0.0)
}

/// 把保存的物理尺寸换算到目标显示器缩放，保持用户看到的逻辑尺寸不变。
///
/// 物理像素跨缩放显示器时不等价：1.5 缩放屏上保存的 3072px 宽，搬到 1.25 缩放屏后
/// 必须还原成 2560 逻辑宽乘 1.25，否则窗口会比用户设定的大 20%。
/// 旧记录没有缩放字段（0）时无从换算，按原样使用。
pub(crate) fn rescale_to_current(saved: &WindowState, current_scale: f64) -> WindowState {
    if saved.scale_factor <= 0.0 || current_scale <= 0.0 || saved.scale_factor == current_scale {
        return saved.clone();
    }
    let factor = current_scale / saved.scale_factor;
    let width = (saved.width as f64 * factor).round();
    let height = (saved.height as f64 * factor).round();
    WindowState {
        width: width.clamp(0.0, u32::MAX as f64) as u32,
        height: height.clamp(0.0, u32::MAX as f64) as u32,
        scale_factor: current_scale,
        ..saved.clone()
    }
}

/// 多个屏幕矩形的并集；无可用屏幕时返回 None。
pub(crate) fn union_rect<I>(rects: I) -> Option<ScreenRect>
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
            scale_factor: 0.0,
        };
    }
    Some(union)
}

/// 按「尺寸与位置解耦」解析保存的几何。
///
/// screens 是当前枚举到的每一块屏幕，而不是它们的包围盒：多屏错位摆放时包围盒会覆盖
/// 显示器之间的空隙，拿它当可见区会让「落在空隙里」的窗口被误判成可见、恢复成屏幕外的
/// 窗口。
///
/// - 退化尺寸（见 is_degenerate_size）返回 None，回落建窗默认尺寸；
/// - 尺寸不小于最小尺寸，能拿到屏幕时再夹进屏幕包围盒（防止拔掉外接大屏后窗口过大）；
///   位置信息不参与尺寸解析，拿不到位置不等于没有尺寸可恢复；
/// - 位置压在某块屏幕上时夹进包围盒；不在任何屏幕上（外接屏被拔出、落在多屏空隙里）时
///   主屏居中；无记录、枚举不到屏幕或无主屏时为 None，保持系统默认居中。
pub(crate) fn resolve_geometry_in(
    saved: &WindowState,
    screens: &[ScreenRect],
    primary: Option<ScreenRect>,
) -> Option<ResolvedGeometry> {
    if is_degenerate_size(saved) {
        return None;
    }

    let union = union_rect(screens.iter().copied());
    let mut width = saved.width.max(MIN_WINDOW_WIDTH);
    let mut height = saved.height.max(MIN_WINDOW_HEIGHT);
    if let Some(union) = union {
        width = width.min(union.width.max(MIN_WINDOW_WIDTH));
        height = height.min(union.height.max(MIN_WINDOW_HEIGHT));
    }
    let size = PhysicalSize::new(width, height);

    Some(ResolvedGeometry {
        size,
        position: resolve_position(saved, size, screens, union, primary),
    })
}

/// 位置解析（纯函数）：语义见 resolve_geometry_in。
fn resolve_position(
    saved: &WindowState,
    size: PhysicalSize<u32>,
    screens: &[ScreenRect],
    union: Option<ScreenRect>,
    primary: Option<ScreenRect>,
) -> Option<PhysicalPosition<i32>> {
    let saved_position = saved_position(saved)?;
    let (sx, sy) = (saved_position.x, saved_position.y);
    let union = union?;

    let right = sx.saturating_add(size.width as i32);
    let bottom = sy.saturating_add(size.height as i32);
    if screens.iter().any(|screen| {
        sx < screen.right() && right > screen.x && sy < screen.bottom() && bottom > screen.y
    }) {
        let max_x = union.right().saturating_sub(size.width as i32);
        let max_y = union.bottom().saturating_sub(size.height as i32);
        let nx = (sx as i64).clamp(union.x as i64, (max_x as i64).max(union.x as i64));
        let ny = (sy as i64).clamp(union.y as i64, (max_y as i64).max(union.y as i64));
        return Some(PhysicalPosition::new(nx as i32, ny as i32));
    }

    let primary = primary?;
    Some(PhysicalPosition::new(
        primary.x + (primary.width as i32 - size.width as i32) / 2,
        primary.y + (primary.height as i32 - size.height as i32) / 2,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: i32, y: i32, width: u32, height: u32) -> ScreenRect {
        scaled_rect(x, y, width, height, 0.0)
    }

    fn scaled_rect(x: i32, y: i32, width: u32, height: u32, scale_factor: f64) -> ScreenRect {
        ScreenRect {
            x,
            y,
            width,
            height,
            scale_factor,
        }
    }

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
    fn saved_scale_rescales_physical_size_to_the_new_display() {
        let state = WindowState {
            width: 3072,
            height: 1862,
            scale_factor: 1.5,
            ..WindowState::default()
        };
        let rescaled = rescale_to_current(&state, 1.25);
        assert_eq!(rescaled.width, 2560);
        assert_eq!(rescaled.height, 1552);
        assert_eq!(rescaled.scale_factor, 1.25);
    }

    #[test]
    fn saved_scale_is_ignored_when_either_side_is_unknown() {
        let legacy = WindowState {
            width: 1500,
            height: 1000,
            scale_factor: 0.0,
            ..WindowState::default()
        };
        assert_eq!(rescale_to_current(&legacy, 2.0), legacy);
        assert_eq!(rescale_to_current(&legacy, 0.0), legacy);

        let known = WindowState {
            width: 1500,
            height: 1000,
            scale_factor: 2.0,
            ..WindowState::default()
        };
        assert_eq!(rescale_to_current(&known, 2.0), known);
        assert_eq!(rescale_to_current(&known, 0.0), known);
    }

    #[test]
    fn target_scale_comes_from_the_screen_holding_the_saved_position() {
        let screens = [
            scaled_rect(0, 0, 1920, 1080, 1.0),
            scaled_rect(1920, 0, 2560, 1600, 1.25),
        ];
        let primary = Some(screens[0]);
        let state = WindowState {
            x: Some(2100),
            y: Some(120),
            ..WindowState::default()
        };
        assert_eq!(target_scale(&state, &screens, primary), 1.25);
    }

    #[test]
    fn target_scale_falls_back_to_the_primary_screen() {
        let screens = [
            scaled_rect(0, 0, 1920, 1080, 1.0),
            scaled_rect(1920, 0, 2560, 1600, 1.25),
        ];
        let primary = Some(screens[0]);
        assert_eq!(
            target_scale(&WindowState::default(), &screens, primary),
            1.0
        );
        let unplugged = WindowState {
            x: Some(9000),
            y: Some(5000),
            ..WindowState::default()
        };
        assert_eq!(target_scale(&unplugged, &screens, primary), 1.0);
        assert_eq!(target_scale(&unplugged, &[], None), 0.0);
    }

    #[test]
    fn maximized_records_use_the_pre_maximize_position() {
        let screens = [
            scaled_rect(0, 0, 1920, 1080, 1.0),
            scaled_rect(1920, 0, 2560, 1600, 1.25),
        ];
        let primary = Some(screens[0]);
        let state = WindowState {
            maximized: true,
            x: Some(0),
            y: Some(0),
            prev_x: Some(2100),
            prev_y: Some(120),
            width: 2560,
            height: 1552,
            size_is_inner: true,
            scale_factor: 1.25,
            ..WindowState::default()
        };
        assert_eq!(
            saved_position(&state),
            Some(PhysicalPosition::new(2100, 120))
        );
        assert_eq!(target_scale(&state, &screens, primary), 1.25);
    }

    #[test]
    fn saved_geometry_rescales_to_the_target_screen_scale() {
        let screens = [
            scaled_rect(0, 0, 1920, 1080, 1.0),
            scaled_rect(1920, 0, 2560, 1600, 1.25),
        ];
        let primary = Some(screens[0]);
        let state = WindowState {
            x: Some(2100),
            y: Some(120),
            width: 3072,
            height: 1862,
            size_is_inner: true,
            scale_factor: 1.5,
            ..WindowState::default()
        };
        let rescaled = rescale_to_current(&state, target_scale(&state, &screens, primary));
        assert_eq!((rescaled.width, rescaled.height), (2560, 1552));
        let resolved = resolve_geometry_in(&rescaled, &screens, primary).expect("geometry");
        assert_eq!(resolved.size, PhysicalSize::new(2560, 1552));
    }

    #[test]
    fn legacy_outer_size_is_converted_for_set_size() {
        let state = WindowState {
            width: 1137,
            height: 792,
            size_is_inner: false,
            ..WindowState::default()
        };

        let migrated = migrate_legacy_outer_size(
            &state,
            PhysicalSize::new(1293, 848),
            PhysicalSize::new(1267, 833),
        );

        assert_eq!(migrated.width, 1111);
        assert_eq!(migrated.height, 777);
        assert!(migrated.size_is_inner);
    }

    #[test]
    fn inner_size_is_not_converted_twice() {
        let state = WindowState {
            width: 1111,
            height: 777,
            size_is_inner: true,
            ..WindowState::default()
        };

        let migrated = migrate_legacy_outer_size(
            &state,
            PhysicalSize::new(1293, 848),
            PhysicalSize::new(1267, 833),
        );

        assert_eq!(migrated, state);
    }

    #[test]
    fn degenerate_size_is_detected() {
        let at_min = WindowState {
            width: MIN_WINDOW_WIDTH,
            height: MIN_WINDOW_HEIGHT,
            ..WindowState::default()
        };
        assert!(is_degenerate_size(&at_min));

        let below_min = WindowState {
            width: 200,
            height: 200,
            ..WindowState::default()
        };
        assert!(is_degenerate_size(&below_min));

        let normal = WindowState {
            width: 1280,
            height: 840,
            ..WindowState::default()
        };
        assert!(!is_degenerate_size(&normal));

        let half_normal = WindowState {
            width: 1280,
            height: MIN_WINDOW_HEIGHT,
            ..WindowState::default()
        };
        assert!(!is_degenerate_size(&half_normal));
    }

    #[test]
    fn union_rect_spans_every_screen() {
        let union =
            union_rect([rect(0, 0, 1920, 1080), rect(1920, -200, 1280, 1024)]).expect("union");
        assert_eq!(union, rect(0, -200, 3200, 1280));

        assert_eq!(
            union_rect([rect(0, 0, 1920, 1080)]),
            Some(rect(0, 0, 1920, 1080))
        );

        assert_eq!(union_rect(Vec::<ScreenRect>::new()), None);
    }

    #[test]
    fn size_is_restored_even_without_saved_position() {
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
        let resolved = resolve_geometry_in(&saved(Some(100), Some(100), 1500, 1000), &[], None)
            .expect("geometry resolved without monitors");

        assert_eq!(resolved.size, PhysicalSize::new(1500, 1000));
        assert_eq!(resolved.position, None);
    }

    #[test]
    fn restored_size_never_goes_below_the_minimum() {
        let resolved = resolve_geometry_in(
            &saved(Some(0), Some(0), 700, 1000),
            &[rect(0, 0, 1920, 1080)],
            Some(rect(0, 0, 1920, 1080)),
        )
        .expect("geometry resolved");

        assert_eq!(resolved.size, PhysicalSize::new(MIN_WINDOW_WIDTH, 1000));
    }

    #[test]
    fn restored_size_is_clamped_into_the_visible_union() {
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
        let screens = [rect(0, 0, 1920, 1080), rect(1920, 1080, 1280, 1024)];
        let resolved = resolve_geometry_in(
            &saved(Some(600), Some(1300), 1000, 700),
            &screens,
            Some(rect(0, 0, 1920, 1080)),
        )
        .expect("geometry resolved");

        assert_eq!(resolved.size, PhysicalSize::new(1000, 700));
        assert_eq!(resolved.position, Some(PhysicalPosition::new(460, 190)));
    }

    #[test]
    fn position_on_an_offset_secondary_screen_is_kept() {
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
    fn degenerate_size_still_falls_back_to_defaults() {
        let resolved = resolve_geometry_in(
            &saved(Some(10), Some(10), MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT),
            &[rect(0, 0, 1920, 1080)],
            Some(rect(0, 0, 1920, 1080)),
        );

        assert!(resolved.is_none());
    }
}
