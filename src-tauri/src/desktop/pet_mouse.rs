//! 桌宠全局鼠标位置与左键状态流，用于透明窗口的命中判定和拖拽结束。
//! macOS 使用 CGEvent 全局逻辑点；Windows 与 Linux 使用物理像素。
//! 监听线程只更新共享槽，16ms 节流线程去重投递，窗口重建时补发最新状态。
//! macOS 仅订阅鼠标事件，避免后台线程调用 HIToolbox 导致崩溃（issue #397）；
//! Windows 使用 GetCursorPos，避免 rdev 键盘钩子干扰前台应用的 IME 状态。

use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{Emitter, State, WebviewWindow};

/// 全局鼠标事件名（与前端 `@tauri-apps/api/event` 的 listen 保持一致）。
pub const PET_MOUSE_MOVE_EVENT: &str = "device-mouse-move";
/// 全局鼠标左键状态事件名（载荷 `MouseButtonState`）：原生拖拽期间 webview
/// 收不到 pointerup，松手时刻只能由设备流告诉前端。
pub const PET_MOUSE_BUTTON_EVENT: &str = "device-mouse-button";
/// 节流间隔（16ms ≈ 60FPS）：光标自身刷新率远超此频率，超出部分无意义。
const THROTTLE_INTERVAL: Duration = Duration::from_millis(16);
/// Windows `GetCursorPos` 轮询间隔（8ms ≈ 125Hz，与常见鼠标报告率一致）：
/// 轮询只写共享槽，最终 emit 仍由节流线程按 16ms 收敛。
#[cfg(target_os = "windows")]
const CURSOR_POLL_INTERVAL: Duration = Duration::from_millis(8);

/// macOS CGEventTap 只订阅的鼠标事件类型。**显式排除** KeyDown / KeyUp /
/// FlagsChanged，彻底切断 rdev 0.5.3 触发 `TSMGetInputSourceProperty`
/// （HIToolbox，必须 main queue）导致的 `dispatch_assert_queue` SIGTRAP
/// 崩溃链（issue #397）。
///
/// `LeftMouseDown` / `LeftMouseUp` 是左键状态的来源（见 `PET_MOUSE_BUTTON_EVENT`）：
/// HID 位置的 tap 在任何窗口拖拽会话之上都能看到物理按键，而 webview 看不到。
#[cfg(target_os = "macos")]
const MACOS_MOUSE_EVENTS: &[core_graphics::event::CGEventType] = &[
    core_graphics::event::CGEventType::MouseMoved,
    core_graphics::event::CGEventType::LeftMouseDragged,
    core_graphics::event::CGEventType::RightMouseDragged,
    core_graphics::event::CGEventType::ScrollWheel,
    core_graphics::event::CGEventType::OtherMouseDragged,
    core_graphics::event::CGEventType::LeftMouseDown,
    core_graphics::event::CGEventType::LeftMouseUp,
];

/// 全局鼠标流的进程级状态：幂等启动标记 + 当前事件的接收窗口。
///
/// 接收窗口必须是**可变**的：收起桌宠会销毁窗口（issue #469），重新显示时创建的是
/// 新窗口（旧 handle 已失效，向它 emit 不会有任何效果）。若把 `start_pet_mouse_stream`
/// 收到的窗口句柄直接搬进节流线程，重建后的桌宠就再也收不到鼠标位置，穿透永远无法
/// 按命中区恢复——宠物会整窗吞掉输入。这里改由前端每次挂载时刷新共享句柄。
///
/// `revision` 同时是节流线程的去重复位信号：换窗口后必须**强制**补发一次位置，否则
/// 光标静止时新页面收不到任何 `device-mouse-move`，穿透态停在「整窗接收事件」，
/// 透明区域会吞掉点击（CodeRabbit review：force one cursor-state update after rebinding）。
#[derive(Default)]
pub struct PetMouseStreamState {
    started: Arc<AtomicBool>,
    emitter: Arc<Mutex<Option<WebviewWindow>>>,
    revision: Arc<AtomicUsize>,
}

/// 虚拟桌面全局坐标，macOS 为逻辑点，其余平台为物理像素。
#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
struct MouseCursorPos {
    x: f64,
    y: f64,
}

/// 全局鼠标左键状态（`device-mouse-button` 事件载荷）。
///
/// 原生拖拽结束时 webview 收不到 pointerup，前端靠「窗口 Moved 停歇 1.5s」兜底
/// 会把拖拽态多挂一拍；这条事件给的是 OS 看到的真实松开时刻。
#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
struct MouseButtonState {
    pressed: bool,
}

/// 监听线程与节流线程之间的共享槽：两个字段都只保留**最新值**（覆盖不积压，
/// 回调不阻塞钩子），`None` 表示尚未收到该项状态。读取保留最新值供窗口重建时补发。
///
/// 坐标与按键分开存放：各平台能观测到的东西不同（macOS 按事件类型分别给坐标或
/// 按键），分开后每个平台只写自己知道的那一项，不必先把另一项读出来再回写。
#[derive(Default)]
struct MouseStateStore {
    position: Mutex<Option<MouseCursorPos>>,
    pressed: Mutex<Option<bool>>,
}

impl MouseStateStore {
    fn write_position(&self, position: MouseCursorPos) {
        *self.position.lock().expect("pet mouse store poisoned") = Some(position);
    }

    fn write_pressed(&self, pressed: bool) {
        *self.pressed.lock().expect("pet mouse store poisoned") = Some(pressed);
    }

    fn read_position(&self) -> Option<MouseCursorPos> {
        *self.position.lock().expect("pet mouse store poisoned")
    }

    fn read_pressed(&self) -> Option<bool> {
        *self.pressed.lock().expect("pet mouse store poisoned")
    }
}

/// 是否把当前值发给前端：接收窗口换代（`rebound`）时必须**强制**补发一次，
/// 否则新页面收不到任何状态（光标静止 = 事件流静止）。
fn should_emit<T: PartialEq>(last: Option<&T>, current: &T, rebound: bool) -> bool {
    rebound || last != Some(current)
}

/// 启动全局鼠标位置流（幂等：已启动时只刷新接收窗口，不重复起线程）。
///
/// 命令参数带 `WebviewWindow`，Tauri 保证在主线程执行；`bind_pet_mouse_emitter`
/// 只做一次短临界区的句柄替换与一次原子自增，不阻塞事件循环。
#[tauri::command]
pub fn start_pet_mouse_stream(window: WebviewWindow, state: State<'_, PetMouseStreamState>) {
    bind_pet_mouse_emitter(&state.emitter, &state.revision, window);
    if state.started.swap(true, Ordering::SeqCst) {
        return;
    }
    // 监听线程失败时复位标记，允许前端重试（如钩子安装被系统拒绝）。
    let started_on_error = state.started.clone();
    let shared: Arc<MouseStateStore> = Arc::default();

    // 监听线程：只把最新坐标与按键状态写入共享槽，不做任何 IO。
    let store = shared.clone();
    thread::spawn(move || {
        if let Err(error) = listen_mouse(store.clone()) {
            log::error!("[pet-mouse] mouse listen failed: {error:?}");
            started_on_error.store(false, Ordering::SeqCst);
        }
    });

    // 节流线程：16ms 轮询最新状态，值有变化才 emit（鼠标静止、按键不变时零事件）；
    // 每轮重新读取接收窗口，保证窗口重建后事件仍然投递到桌宠。接收窗口换代
    // （revision 变化）时忽略去重，强制补发一次当前位置与按键——新页面需要一次
    // 事件才能算出穿透态，也需要知道按键此刻按着没有。
    let emitter = state.emitter.clone();
    let revision = state.revision.clone();
    thread::spawn(move || {
        let mut last_sent: Option<MouseCursorPos> = None;
        let mut last_button: Option<bool> = None;
        let mut bound_revision = revision.load(Ordering::SeqCst);
        loop {
            let current_revision = revision.load(Ordering::SeqCst);
            let rebound = current_revision != bound_revision;
            bound_revision = current_revision;
            let position = shared
                .read_position()
                .filter(|pos| should_emit(last_sent.as_ref(), pos, rebound));
            let button = shared
                .read_pressed()
                .filter(|pressed| should_emit(last_button.as_ref(), pressed, rebound));
            if let Some(pos) = position {
                last_sent = Some(pos);
            }
            if let Some(pressed) = button {
                last_button = Some(pressed);
            }
            if position.is_some() || button.is_some() {
                let target = emitter
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .clone();
                if let Some(target) = target {
                    if let Some(pos) = position {
                        let _ = target.emit(PET_MOUSE_MOVE_EVENT, pos);
                    }
                    if let Some(pressed) = button {
                        let _ = target.emit(PET_MOUSE_BUTTON_EVENT, MouseButtonState { pressed });
                    }
                }
            }
            thread::sleep(THROTTLE_INTERVAL);
        }
    });
}

/// 把鼠标事件接收窗口指向最新挂载的桌宠窗口（窗口重建后必须调用）。
///
/// 自增 `revision` 让节流线程知道「换了接收方」：即使光标没动、去重判定会跳过发送，
/// 也必须补发一次位置，否则重建后的桌宠收不到任何鼠标事件、穿透态无法按命中区计算。
fn bind_pet_mouse_emitter(
    slot: &Arc<Mutex<Option<WebviewWindow>>>,
    revision: &Arc<AtomicUsize>,
    window: WebviewWindow,
) {
    let mut current = slot.lock().unwrap_or_else(|error| error.into_inner());
    *current = Some(window);
    revision.fetch_add(1, Ordering::SeqCst);
}

/// 平台分发：macOS 走 CGEventTap，Windows 走 GetCursorPos 轮询，Linux 走 rdev。
fn listen_mouse(store: Arc<MouseStateStore>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        listen_mouse_macos(store)
    }
    #[cfg(target_os = "windows")]
    {
        listen_mouse_windows(store)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        listen_mouse_rdev(store)
    }
}

/// Windows 光标位置轮询（`GetCursorPos`，不装任何全局钩子）。
///
/// 穿透恢复只需要光标坐标，不需要事件流：单次 `GetCursorPos` 是一次廉价系统
/// 调用，8ms 轮询与 rdev 事件流的实际收敛效果相当（最终 emit 都经 16ms 节流），
/// 却完全避开 rdev 键盘钩子对前台应用 IME 状态的干扰（见模块文档「平台差异」）。
/// 调用失败（UAC/锁屏切换瞬间）时保留上一次坐标，下一轮重试。
///
/// 同一轮询里顺带用 `GetAsyncKeyState` 读左键**当前是否按下**：拖拽跑在系统模态
/// 循环里，webview 收不到 pointerup，只有这里能看到松手时刻（`PET_MOUSE_BUTTON_EVENT`）。
/// 用最高位（`0x8000`，此刻按着）而不是最低位（"自上次查询以来按过"，与查询频率
/// 耦合且冷启动时残留），松手后下一轮（8ms）就会翻转。
#[cfg(target_os = "windows")]
fn listen_mouse_windows(store: Arc<MouseStateStore>) -> Result<(), String> {
    loop {
        if let Some(pos) = read_cursor_pos() {
            store.write_position(pos);
        }
        store.write_pressed(read_left_button_pressed());
        thread::sleep(CURSOR_POLL_INTERVAL);
    }
}

/// 单次读取物理光标坐标（`GetCursorPos` 失败返回 `None`，如 UAC 桌面切换瞬间）。
#[cfg(target_os = "windows")]
fn read_cursor_pos() -> Option<MouseCursorPos> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let mut point = POINT { x: 0, y: 0 };
    if unsafe { GetCursorPos(&mut point) } != 0 {
        Some(MouseCursorPos {
            x: point.x as f64,
            y: point.y as f64,
        })
    } else {
        None
    }
}

/// 单次读取左键是否按下（`GetAsyncKeyState` 的 `0x8000` 位）。
#[cfg(target_os = "windows")]
fn read_left_button_pressed() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};

    unsafe { GetAsyncKeyState(VK_LBUTTON as i32) as u16 & 0x8000 != 0 }
}

/// rdev 监听（Linux；X11 XRecord 只捕获不注入，见模块文档「平台差异」）。
///
/// 除鼠标移动外还上报左键按下/松开：拖拽期间 webview 收不到 pointerup，前端需要
/// 一个 OS 侧的松开时刻来立刻结束拖拽态（`PET_MOUSE_BUTTON_EVENT`）。只认左键，
/// 与前端 `handlePointerDown` 的 `event.button !== 0` 判定一致。
#[cfg(all(unix, not(target_os = "macos")))]
fn listen_mouse_rdev(store: Arc<MouseStateStore>) -> Result<(), String> {
    use rdev::{Button, EventType};

    let callback = move |event: rdev::Event| match event.event_type {
        EventType::MouseMove { x, y } => store.write_position(MouseCursorPos { x, y }),
        EventType::ButtonPress(Button::Left) => store.write_pressed(true),
        EventType::ButtonRelease(Button::Left) => store.write_pressed(false),
        _ => {}
    };
    rdev::listen(callback).map_err(|e| format!("rdev::listen: {e:?}"))
}

/// 系统单方面禁用事件 tap 时投递的带外事件类型（issue #559）。
///
/// Apple 用这两个值通知回调「tap 已被禁用」，调用方必须自行重新启用；它们不属于
/// `MACOS_MOUSE_EVENTS`，只在回调里出现。
#[cfg(target_os = "macos")]
fn tap_disabled_notice(event_type: core_graphics::event::CGEventType) -> bool {
    use core_graphics::event::CGEventType;
    matches!(
        event_type,
        CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput
    )
}

/// macOS CGEventTap 监听 mouse 事件（绕过 rdev 的 keyboard/TSM 路径，issue #397）。
///
/// CGEvent 全局逻辑点不随窗口所在屏幕的缩放变化，跨屏拖拽不会发生坐标跳变。
///
/// `LeftMouseDown` / `LeftMouseUp` 另外上报左键状态：窗口拖拽期间 webview 收不到
/// pointerup，前端只有靠这条路径才能立刻结束拖拽态。
///
/// # 为什么自己持有 tap（issue #559）
///
/// `CGEventTap::with_enabled` 只在创建时 `enable` 一次，回调收到
/// `TapDisabledByTimeout` / `TapDisabledByUserInput` 时不重新启用。系统一旦禁用事件
/// tap（回调超时、休眠唤醒、系统级用户输入禁用），鼠标流就**静默死亡**：前端再也收
/// 不到 `device-mouse-move`，命中判定停在最后一次结果，桌宠窗口保持整窗穿透——点宠物
/// 会触发下层应用的界面事件，或点击完全没有反应。这里改为自己创建 tap、把句柄留在本
/// 线程的槽里，收到禁用通知立即重新启用并留一行日志（此前这条路径完全无声）。
#[cfg(target_os = "macos")]
fn listen_mouse_macos(store: Arc<MouseStateStore>) -> Result<(), String> {
    use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
    use core_graphics::event::{
        CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType,
        CallbackResult,
    };
    use std::cell::RefCell;
    use std::rc::Rc;

    // 槽先于回调存在，回调只在 run loop 启动后被调用，读到时必然已写入。
    let tap_slot: Rc<RefCell<Option<CGEventTap<'static>>>> = Rc::new(RefCell::new(None));
    let rearm = tap_slot.clone();
    // SAFETY: 回调只会在当前线程的 run loop 上被调用（下面把 source 挂在
    // `CFRunLoop::get_current()` 上再 `run_current`），捕获的 `Rc` 也只在同一线程
    // 使用——与 `CGEventTap::with_enabled` 内部的约定一致。
    let event_tap: CGEventTap<'static> = unsafe {
        CGEventTap::new_unchecked(
            CGEventTapLocation::HID,
            CGEventTapPlacement::HeadInsertEventTap,
            CGEventTapOptions::ListenOnly,
            MACOS_MOUSE_EVENTS.to_vec(),
            move |_proxy, event_type, event| {
                // 被系统禁用：立刻恢复，否则鼠标流永久停摆（issue #559）。
                if tap_disabled_notice(event_type) {
                    log::warn!(
                        "[pet-mouse] event tap disabled by system ({event_type:?}); re-enabling"
                    );
                    if let Some(tap) = rearm.borrow().as_ref() {
                        tap.enable();
                    }
                    return CallbackResult::Keep;
                }
                // 左键按下/松开：拖拽期间 webview 收不到 pointerup，前端靠这条
                // 事件立刻结束拖拽态（`PET_MOUSE_BUTTON_EVENT`）。
                match event_type {
                    CGEventType::LeftMouseDown => store.write_pressed(true),
                    CGEventType::LeftMouseUp => store.write_pressed(false),
                    _ => {}
                }
                // 所有 MACOS_MOUSE_EVENTS 中带位置语义的类型都要更新光标位置。
                // ScrollWheel 是滚轮 delta 没有位置，跳过。
                if matches!(
                    event_type,
                    CGEventType::MouseMoved
                        | CGEventType::LeftMouseDragged
                        | CGEventType::RightMouseDragged
                        | CGEventType::OtherMouseDragged
                        | CGEventType::LeftMouseDown
                        | CGEventType::LeftMouseUp
                ) {
                    let point = event.location();
                    store.write_position(MouseCursorPos {
                        x: point.x,
                        y: point.y,
                    });
                }
                // ListenOnly 模式：返回值会被忽略；用 Keep 表达"原样放行"语义。
                CallbackResult::Keep
            },
        )
    }
    .map_err(|()| {
        "CGEventTap creation failed (accessibility permission denied or HID unavailable)"
            .to_string()
    })?;

    let loop_source = event_tap
        .mach_port()
        .create_runloop_source(0)
        .map_err(|()| "CGEventTap run loop source creation failed".to_string())?;
    CFRunLoop::get_current().add_source(&loop_source, unsafe { kCFRunLoopCommonModes });
    event_tap.enable();
    *tap_slot.borrow_mut() = Some(event_tap);
    CFRunLoop::run_current();
    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use core_graphics::event::CGEventType;

    /// CGEventType 不实现 PartialEq，借助 `#[repr(u32)]` 转整数比较。
    fn mask_codes() -> Vec<u32> {
        MACOS_MOUSE_EVENTS.iter().map(|e| *e as u32).collect()
    }

    /// 防止有人将来误把 keyboard / FlagsChanged 加进 `MACOS_MOUSE_EVENTS`，
    /// 重新触发 rdev 触发的 `TSMGetInputSourceProperty` → `dispatch_assert_queue`
    /// SIGTRAP（issue #397）。
    #[test]
    fn macos_mouse_events_exclude_keyboard() {
        let codes = mask_codes();
        for forbidden in [
            CGEventType::KeyDown,
            CGEventType::KeyUp,
            CGEventType::FlagsChanged,
        ] {
            assert!(
                !codes.contains(&(forbidden as u32)),
                "MACOS_MOUSE_EVENTS must not include {forbidden:?} (issue #397)"
            );
        }
    }

    /// 确认 mouse 事件主路径（`MouseMoved`）仍然在 mask 里——只测排除容易漏删。
    #[test]
    fn macos_mouse_events_include_mouse_moved() {
        assert!(mask_codes().contains(&(CGEventType::MouseMoved as u32)));
    }

    /// 系统禁用事件 tap 时投递的是带外类型，必须能识别出来并重新启用（issue #559）：
    /// 漏掉这两种通知，鼠标流会静默死亡、命中判定永久停在最后一次结果。
    #[test]
    fn tap_disabled_notices_are_recognized() {
        assert_eq!(CGEventType::TapDisabledByTimeout as u32, 0xFFFF_FFFE);
        assert_eq!(CGEventType::TapDisabledByUserInput as u32, 0xFFFF_FFFF);
        assert!(tap_disabled_notice(CGEventType::TapDisabledByTimeout));
        assert!(tap_disabled_notice(CGEventType::TapDisabledByUserInput));
        assert!(!tap_disabled_notice(CGEventType::MouseMoved));
        assert!(!tap_disabled_notice(CGEventType::ScrollWheel));
    }
}

#[cfg(all(test, target_os = "windows"))]
mod windows_tests {
    use super::*;

    /// 冒烟测试：交互桌面会话里 `GetCursorPos` 应可用；CI 的 session 0 等受限
    /// 环境会拿不到坐标，按规范优雅跳过而非断言失败。
    #[test]
    fn get_cursor_pos_available_in_interactive_session() {
        if let Some(pos) = read_cursor_pos() {
            assert!(pos.x.is_finite() && pos.y.is_finite());
        } else {
            eprintln!("GetCursorPos unavailable (headless session); skipping");
        }
    }
}

/// 左键状态事件（`device-mouse-button`）与共享槽的回归测试。
///
/// 原生窗口拖拽跑在系统模态循环里，webview 在拖拽期间与松手瞬间都收不到
/// pointerup；这条事件是前端立刻结束拖拽态的唯一依据，因此「松开必须发出去」
/// 和「值没变不重发」都要有据可查。
#[cfg(test)]
mod button_tests {
    use super::*;

    #[test]
    fn stationary_cursor_is_replayed_after_window_rebind() {
        let store = MouseStateStore::default();
        let position = MouseCursorPos {
            x: -320.0,
            y: 240.0,
        };
        store.write_position(position);
        let sent = store.read_position();
        assert_eq!(sent, Some(position));
        assert_eq!(
            store
                .read_position()
                .filter(|pos| should_emit(sent.as_ref(), pos, false)),
            None
        );
        assert_eq!(
            store
                .read_position()
                .filter(|pos| should_emit(sent.as_ref(), pos, true)),
            Some(position)
        );
    }

    #[test]
    fn unchanged_button_is_replayed_after_window_rebind() {
        for pressed in [false, true] {
            let store = MouseStateStore::default();
            store.write_pressed(pressed);
            let sent = store.read_pressed();
            assert_eq!(sent, Some(pressed));
            assert_eq!(
                store
                    .read_pressed()
                    .filter(|value| should_emit(sent.as_ref(), value, false)),
                None
            );
            assert_eq!(
                store
                    .read_pressed()
                    .filter(|value| should_emit(sent.as_ref(), value, true)),
                Some(pressed)
            );
        }
    }

    /// 值没变就不重发（节流线程 16ms 轮询的基础，鼠标静止时零事件）；接收窗口
    /// 换代（`rebound`）时必须强制补发一次，否则重建后的桌宠不知道按键当前状态。
    #[test]
    fn should_emit_only_on_change_or_rebound() {
        let pressed = MouseButtonState { pressed: true };
        let released = MouseButtonState { pressed: false };
        assert!(should_emit(None, &pressed, false));
        assert!(!should_emit(Some(&pressed), &pressed, false));
        assert!(should_emit(Some(&pressed), &released, false));
        assert!(should_emit(Some(&pressed), &pressed, true));

        let pos = MouseCursorPos { x: 1.0, y: 2.0 };
        assert!(should_emit(None, &pos, false));
        assert!(!should_emit(Some(&pos), &pos, false));
        assert!(should_emit(
            Some(&pos),
            &MouseCursorPos { x: 1.0, y: 3.0 },
            false
        ));
    }

    /// 坐标与按键分开存放：各平台能观测到的项不同，只写其中一项不能抹掉另一项，
    /// 读取必须保留最新状态供窗口重建后补发。
    #[test]
    fn store_keeps_position_and_button_independent() {
        let store = MouseStateStore::default();
        let pos = MouseCursorPos { x: 3.0, y: 4.0 };
        assert_eq!(store.read_position(), None);
        assert_eq!(store.read_pressed(), None);

        store.write_position(pos);
        assert_eq!(store.read_pressed(), None);
        assert_eq!(store.read_position(), Some(pos));
        assert_eq!(store.read_position(), Some(pos));

        store.write_pressed(false);
        assert_eq!(store.read_position(), Some(pos));
        assert_eq!(store.read_pressed(), Some(false));
        assert_eq!(store.read_pressed(), Some(false));

        store.write_pressed(true);
        store.write_position(pos);
        assert_eq!(store.read_position(), Some(pos));
        assert_eq!(store.read_pressed(), Some(true));
    }
}
