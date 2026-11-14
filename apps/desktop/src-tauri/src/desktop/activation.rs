//! 窗口前台形态与前台激活。
//!
//! macOS 侧切应用级 activation policy：窗口隐藏时切 `.accessory` 隐藏 Dock 图标，
//! 恢复时切回 `.regular`。策略是应用级状态而非窗口级，一次切换对全部屏幕的 Dock
//! 一并生效，因此不做窗口级/屏幕级判断。
//!
//! `bring_to_front` 是托盘、`RunEvent::Reopen`、single-instance、通知点击四条
//! 恢复路径的唯一入口，只组合官方窗口 API（unminimize / show / set_focus）。

use crate::{AppHandle, Window};
pub use crate::config::{CLOSE_ACTION_QUIT, CLOSE_ACTION_TRAY};

#[cfg(target_os = "macos")]
use std::sync::{Mutex, OnceLock};

use tauri::Runtime;

#[cfg(target_os = "macos")]
use tauri::Manager;

#[cfg(target_os = "macos")]
use tauri::ActivationPolicy;

/// 置前前要做的原生动作。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ForegroundAction {
    /// 已在前台且未最小化：重复激活只会让任务栏闪一下。
    Skip,
    /// 最小化态：`SetForegroundWindow` 对图标化窗口无效，必须先还原。
    Restore,
    /// 可见但不在前台。
    Raise,
}

pub fn foreground_action(is_focused: bool, is_minimized: bool) -> ForegroundAction {
    if is_minimized {
        ForegroundAction::Restore
    } else if is_focused {
        ForegroundAction::Skip
    } else {
        ForegroundAction::Raise
    }
}

/// 把窗口带到前台并抢到焦点。
///
/// 宿主只决定「要不要激活」；窗口归 Electron 子进程所有，`set_focus` 里的前台
/// 提升由运行时按平台分流（Windows 见运行时的 activation 模块）。
pub fn bring_to_front<R: Runtime>(window: &Window<R>) {
    if foreground_action(
        window.is_focused().unwrap_or(false),
        window.is_minimized().unwrap_or(false),
    ) == ForegroundAction::Skip
    {
        return;
    }
    let _ = window.unminimize();
    if let Err(error) = window.show() {
        log::warn!("[activation] WINDOW_SHOW_FAILED: {error}");
    }
    if let Err(error) = window.set_focus() {
        log::warn!("[activation] WINDOW_FOCUS_FAILED: {error}");
    }
}


/// 关窗时是否应切到 Accessory（隐藏 Dock）。
///
/// 抽成不依赖 `AppHandle` 的纯函数，才能在非 macOS / CI 上直接断言判定逻辑。
/// 只认精确的 `tray`，未知或大小写不符的值一律返回 false —— 保守降级为「不切」，
/// 宁可留着 Dock 图标，也不要把应用切进用户无法从 Dock 唤回的形态。
///
/// 调用方契约：builder 的 CloseRequested 在 quit 分支已提前 `exit(0)`，不会走
/// 到 `on_window_hidden`，故本函数对 `quit` 的拒绝在生产中属防御深度 —— 未来
/// 调用方无需自行 gate quit，直接传原始动作即可。
#[cfg(any(target_os = "macos", test))]
pub fn should_switch_to_accessory(is_fullscreen: bool, close_action: &str) -> bool {
    // 全屏态切策略会让原生全屏空间闪一下 Dock，故等退出全屏后再补切（D-04）
    !is_fullscreen && close_action == CLOSE_ACTION_TRAY
}

/// 进程内缓存的策略取值。
///
/// `tauri::ActivationPolicy` 是 `#[non_exhaustive]` 且不保证实现 `PartialEq`，
/// 无法直接放进缓存比较，因此用本地枚举承载，只在真正调用前映射一次。
#[cfg(target_os = "macos")]
#[derive(Clone, Copy, PartialEq, Eq)]
enum PolicyState {
    Regular,
    Accessory,
}

/// 当前已生效的策略。`None` 表示尚未切换过（系统默认即 regular）。
///
/// 缓存的目的不是省一次调用，而是防抖动：每次 show/hide 都无条件调
/// `set_activation_policy` 会让 Dock 图标反复增删并抢焦点。
#[cfg(target_os = "macos")]
static CURRENT_POLICY: OnceLock<Mutex<Option<PolicyState>>> = OnceLock::new();

/// 全屏期间被推迟的 Accessory 切换（D-04），退出全屏后由 `Resized` 补做。
#[cfg(target_os = "macos")]
static PENDING_ACCESSORY: Mutex<bool> = Mutex::new(false);

/// 记录/清除「全屏期间推迟的切换」。
#[cfg(target_os = "macos")]
fn set_pending_accessory(pending: bool) {
    *PENDING_ACCESSORY
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = pending;
}

/// 取出并清除推迟标志，保证补做只发生一次（连续 Resized 幂等吸收）。
#[cfg(target_os = "macos")]
fn take_pending_accessory() -> bool {
    let mut pending = PENDING_ACCESSORY
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    std::mem::replace(&mut *pending, false)
}

/// 真正下发策略切换，命中缓存则直接返回。
///
/// 禁止 `.prohibited`：该取值下应用无法创建窗口也无法被拉回前台，会直接破坏
/// 「从托盘恢复主窗口」这条成功标准，因此本模块只使用 regular / accessory 两者。
#[cfg(target_os = "macos")]
fn apply_policy<R: Runtime>(app: &AppHandle<R>, state: PolicyState) {
    let mut cached = CURRENT_POLICY
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if *cached == Some(state) {
        return;
    }
    let policy = match state {
        PolicyState::Regular => ActivationPolicy::Regular,
        PolicyState::Accessory => ActivationPolicy::Accessory,
    };
    match app.set_activation_policy(policy) {
        Ok(()) => *cached = Some(state),
        Err(error) => log::warn!("[activation] ACTIVATION_POLICY_FAILED: {error}"),
    }
}

/// 窗口被隐藏后（CloseRequested 里 prevent_close + hide 之后）按需切 Accessory。
///
/// 全屏态不切，只挂推迟标志：此时切策略会让原生全屏空间里的 Dock 反复增删。
/// 参数类型与 `.on_window_event` 闭包拿到的一致（窗口类型之间无自动转换路径），
/// 因此调用点无需再做任何包装。
///
/// 非 macOS 平台整体编译为空实现，关窗隐藏的既有行为不变。
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
pub fn on_window_hidden<R: Runtime>(window: &Window<R>, close_action: &str) {
    #[cfg(target_os = "macos")]
    {
        let Ok(is_fullscreen) = window.is_fullscreen() else {
            return;
        };
        if should_switch_to_accessory(is_fullscreen, close_action) {
            apply_policy(window.app_handle(), PolicyState::Accessory);
            return;
        }
        if is_fullscreen {
            set_pending_accessory(true);
            log::warn!("[activation] 全屏态关窗，推迟到退出全屏后再切 Accessory");
        }
    }
}

/// 退出全屏后补做被推迟的 Accessory 切换。
///
/// 退出全屏必伴随 `Resized`（`Moved` 不触发），全屏动画期间的连续 `Resized`
/// 由「取出即清零」的 pending 标志幂等吸收。
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
pub fn on_window_resized<R: Runtime>(window: &Window<R>) {
    #[cfg(target_os = "macos")]
    {
        let Ok(false) = window.is_fullscreen() else {
            return;
        };
        if take_pending_accessory() {
            apply_policy(window.app_handle(), PolicyState::Accessory);
        }
    }
}

/// 恢复前台前切回 Regular：由 `utils::show_main_window` 在 `show()` 之前调用，
/// 一次覆盖托盘菜单「打开面板」/ 托盘左键 / `RunEvent::Reopen` / single-instance
/// 四条恢复路径。
///
/// 顺序是硬约束：Accessory 下 `window.show()` 有历史问题（tauri #5122），必须先
/// 切回 regular 再 show。同时清掉全屏推迟标志 —— 恢复路径以「可见」为准，
/// 最坏情况只是 Dock 到下次关窗时才消失，而不是永不隐藏。
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
pub fn set_regular_policy<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "macos")]
    {
        set_pending_accessory(false);
        apply_policy(app, PolicyState::Regular);
    }
}

/// 托盘恢复后窗口仍处于全屏时，重新挂上被 `set_regular_policy`
/// 无条件清掉的推迟标志。
///
/// 恢复路径不改变全屏状态：全屏关窗（pending 置位后隐藏）→ 托盘恢复
/// （pending 被清、窗口依旧全屏）→ 用户退出全屏时若 pending 未挂回，
/// `on_window_resized` 找不到标志，Accessory 永不生效 —— Dock 与
/// ⌘-Tab 将在整个托盘驻留期间保持可见，与 `ui.close_action_hint`
/// 的承诺矛盾。仅当关窗动作是 `tray` 时挂起。
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
pub fn rearm_pending_accessory_if_fullscreen<R: Runtime>(window: &Window<R>) {
    #[cfg(target_os = "macos")]
    {
        let Ok(is_fullscreen) = window.is_fullscreen() else {
            return;
        };
        if !is_fullscreen {
            return;
        }
        let close_action = crate::config::get_store_dat_setting(&window.app_handle()).close_action;
        if should_switch_to_accessory(false, &close_action) {
            set_pending_accessory(true);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        foreground_action, should_switch_to_accessory, ForegroundAction, CLOSE_ACTION_QUIT,
        CLOSE_ACTION_TRAY,
    };

    #[test]
    fn minimized_windows_restore_before_raising() {
        assert_eq!(
            foreground_action(false, true),
            ForegroundAction::Restore,
            "图标化窗口必须还原后再置前，SetForegroundWindow 对最小化窗口无效"
        );
        assert_eq!(
            foreground_action(true, true),
            ForegroundAction::Restore,
            "最小化与前台标记同时存在时应以还原为准"
        );
    }

    #[test]
    fn visible_window_out_of_foreground_is_raised() {
        assert_eq!(
            foreground_action(false, false),
            ForegroundAction::Raise,
            "可见但不在前台必须重新置前"
        );
    }

    #[test]
    fn foreground_window_skips_redundant_activation() {
        assert_eq!(
            foreground_action(true, false),
            ForegroundAction::Skip,
            "已在前台时重复激活只会闪任务栏"
        );
    }

    #[test]
    fn close_action_constants_match_store_values() {
        assert_eq!(CLOSE_ACTION_TRAY, "tray", "托盘驻留动作必须是 tray");
        assert_eq!(CLOSE_ACTION_QUIT, "quit", "退出动作必须是 quit");
    }

    #[test]
    fn closes_to_tray_hides_dock_when_not_fullscreen() {
        assert!(
            should_switch_to_accessory(false, CLOSE_ACTION_TRAY),
            "普通关窗应当切 Accessory 隐藏 Dock"
        );
    }

    #[test]
    fn fullscreen_close_keeps_dock_until_exit_fullscreen() {
        assert!(
            !should_switch_to_accessory(true, CLOSE_ACTION_TRAY),
            "全屏态关窗必须保持 regular，退出全屏后再补切"
        );
    }

    #[test]
    fn quit_action_never_switches_policy() {
        assert!(
            !should_switch_to_accessory(false, CLOSE_ACTION_QUIT),
            "要退出的关窗不需要切 Accessory"
        );
        assert!(
            !should_switch_to_accessory(true, CLOSE_ACTION_QUIT),
            "全屏且要退出时同样不切 Accessory"
        );
    }

    #[test]
    fn unknown_close_action_keeps_dock_visible() {
        assert!(
            !should_switch_to_accessory(false, ""),
            "空动作应保守降级为不切，Dock 保留"
        );
        assert!(
            !should_switch_to_accessory(false, "TRAY"),
            "大小写不一致的动作不识别，Dock 保留"
        );
        assert!(
            !should_switch_to_accessory(false, "bogus"),
            "未知动作应保守降级为不切，Dock 保留"
        );
    }
}
