//! 桌宠全局鼠标位置流（点击穿透恢复）。
//!
//! 桌宠窗口默认整窗点击穿透（`set_ignore_cursor_events(true)`，Windows 上等效
//! `WS_EX_TRANSPARENT | WS_EX_LAYERED`，命中测试完全透明），穿透态下 WebView
//! 收不到任何鼠标事件（mouseenter/mousemove 均不触发），前端无法感知光标
//! 移回命中区来关闭穿透——这就是社区常说的「穿透后无法恢复交互」死锁
//! （tauri issue #6164：官方 forward 选项一直未实现）。
//!
//! 解决方案（参考 Xinyu-Li-123/tauri-clickthrough-demo 与
//! codecnmc/tauri2-transparent-through）：在独立线程监听光标位置，把物理像素
//! 光标坐标限频通过 `device-mouse-move` 事件发给前端；前端用
//! 命中区（窗口尺寸固定百分比）判定光标是否落在可交互区域，据此翻转
//! `setIgnoreCursorEvents`，穿透态下同样能感知光标位置，死锁解除。
//!
//! 性能：坐标刷新频率取决于各平台的监听方式（Windows 轮询 8ms、macOS 鼠标
//! 报告率 125Hz–1000Hz），这里做两级收敛——监听线程只把最新坐标写入共享槽
//! （覆盖不积压，回调不阻塞钩子）；节流线程每 16ms 读取一次，坐标有变化才
//! emit（鼠标静止时零事件）。
//!
//! 同一路监听顺带上报**左键按下/松开**（`device-mouse-button`）：原生窗口拖拽
//! （`startDragging`）跑在系统模态循环里，按钮事件被它吞掉，webview 在拖拽期间
//! 与松手瞬间都收不到 pointerup，前端只能靠「`Moved` 事件停歇」的超时兜底判结束
//! ——松手后拖拽态要多挂 1.5s，宠物动画慢半拍。设备流是纯 OS 侧观察者，能看到
//! 真正的松开时刻，前端据此立刻收尾（见 `src/hooks/use-window-draggable.ts`）。
//!
//! 生命周期：鼠标流由前端 `start_pet_mouse_stream` 命令幂等启动，线程随进程
//! 常驻（各平台监听线程都是常驻阻塞循环，无停止 API）；桌宠隐藏时前端不再
//! 检查命中，线程开销可忽略。
//!
//! # 平台差异
//!
//! - **macOS**：用 `core-graphics` 的 `CGEventTap` 直接监听 mouse 事件。**不能**
//!   使用 `rdev`，因为 rdev 0.5.3 的 macOS 后端在 `CGEvent` 回调里对**所有**
//!   `KeyPress` 事件无条件调 `TSMGetInputSourceProperty`（HIToolbox API，必须
//!   在 main queue 上调用），而 rdev 在自己的后台线程上跑 `CFRunLoopRun`，触发
//!   `_dispatch_assert_queue_fail` → SIGTRAP。按单独 Cmd / Option / Control 键
//!   会发出 `FlagsChanged` 事件并经 rdev 转为 `KeyPress`，导致 100% 崩溃（issue
//!   #397）。只订阅 mouse 事件彻底绕开 TSM 路径。此外 `CGEventGetLocation` 返回的是
//!   全局显示坐标（**逻辑点**，如 M4 Retina 上为 1710×1112 pt），必须乘桌宠窗口的
//!   `scale_factor()` 换算成前端判定所用的物理像素，否则 Retina（scale=2）上判定区
//!   相对宠物整体被放大一倍、位置也随之偏移，宠物永远判否、窗口一直穿透（issue #523）。
//! - **Windows**：用 `GetCursorPos` 每 8ms 轮询。**不能**用 `rdev::listen`：
//!   rdev 的 `listen()` 在 Windows 上无条件同时安装 `WH_KEYBOARD_LL` +
//!   `WH_MOUSE_LL` 两个低级钩子（`set_key_hook` + `set_mouse_hook`，没有按
//!   事件类型过滤的选项），即使调用方只消费 mouse 事件，系统上每一次按键都会
//!   同步进入本进程的键盘钩子回调。rdev 对 KeyPress 会调 `Keyboard::get_name`
//!   取键名，其 `set_global_state()` 对每次按键执行
//!   `AttachThreadInput(钩子线程, 前台线程, TRUE)` → `GetKeyboardState` →
//!   detach，再用前台线程的键盘布局调 `ToUnicodeEx`。微软拼音等 IME 激活时
//!   （即使切在英文模式，IME TIP 仍挂载），TSF/IME 的组合状态是前台线程本地
//!   的，反复 Attach/Detach + ToUnicodeEx 会打断/污染 IME 对该按键的合成处理，
//!   状态机错乱后向前台应用重放/注入幽灵按键——全屏游戏（如以撒的结合）里
//!   表现为「没按的键自己生效」。`GetCursorPos` 轮询不装任何钩子、完全不触碰
//!   输入管线，穿透恢复只需要光标坐标，足够。
//! - **Linux**：维持 `rdev::listen`（X11 后端走 XRecord 只捕获不注入；
//!   `AttachThreadInput` / `ToUnicodeEx` 是 Windows 专有 API，Linux 后端不触碰
//!   输入状态，无此问题）。

use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
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
/// 缩放系数刷新周期（16ms × 32 ≈ 500ms）：桌宠被拖到另一块缩放不同的显示器后，
/// 命中换算用的系数必须跟着变，否则判定区又会跑偏（issue #523）。
const SCALE_REFRESH_TICKS: u64 = 32;
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
    /// 桌宠窗口当前所在显示器的缩放系数（见 `SharedScaleFactor`）。
    scale_factor: SharedScaleFactor,
}

/// 桌宠窗口缩放系数的共享槽：`f64` 以位模式存进 `AtomicU64`（原子类型没有 f64），
/// `0` 表示尚未初始化。
///
/// 命中判定要求光标与窗口几何处于**同一坐标空间**：前端用 `innerPosition()`
/// （tao 已按窗口缩放换算好的物理像素）+ `DOMRect × devicePixelRatio` 求命中箱，
/// 所以后端发出的光标也必须是同一套物理像素。macOS 的 `CGEventGetLocation` 给的是
/// 全局显示**逻辑点**，只有乘上该系数才能对齐；Windows 的 `GetCursorPos` 与 Linux
/// 的 rdev 本身已是物理像素，不需要换算（issue #523）。
type SharedScaleFactor = Arc<AtomicU64>;

/// 读共享缩放系数；未初始化（`0`）或非法（负数 / `NaN` / 无穷）回退 `1.0`
/// （等价于不换算，好过让整块命中区塌缩或爆炸）。
///
/// 只有 macOS 的 `listen_mouse_macos` 会调用，其它平台仅测试引用。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn load_scale_factor(scale_factor: &AtomicU64) -> f64 {
    let raw = f64::from_bits(scale_factor.load(Ordering::Relaxed));
    if raw.is_finite() && raw > 0.0 {
        raw
    } else {
        1.0
    }
}

/// 写共享缩放系数（非法值由 `load_scale_factor` 回退成 `1.0`）。
fn store_scale_factor(scale_factor: &AtomicU64, value: f64) {
    scale_factor.store(value.to_bits(), Ordering::Relaxed);
}

/// 按当前接收窗口刷新共享缩放系数（桌宠跨显示器移动后必须更新）。
///
/// 只有 macOS 需要这份系数（Windows 的 `GetCursorPos`、Linux 的 rdev 本身已是物理
/// 像素），其它平台直接返回，省掉每周期一次无用的主线程往返。
///
/// macOS 分支必须先克隆出窗口句柄、释放 `slot` 锁，再调用 `scale_factor()`：该方法
/// 会把请求投递给主线程并阻塞等待结果，而主线程也可能正在 `bind_pet_mouse_emitter`
/// 里等同一把锁——持锁调用会与主线程互相死锁。
fn refresh_scale_factor(slot: &Mutex<Option<WebviewWindow>>, scale_factor: &AtomicU64) {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (slot, scale_factor);
    }

    #[cfg(target_os = "macos")]
    {
        let target = slot
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        if let Some(target) = target {
            if let Ok(scale) = target.scale_factor() {
                store_scale_factor(scale_factor, scale);
            }
        }
    }
}

/// 物理像素的光标位置（虚拟屏幕全局坐标系，副屏可含负值）。
///
/// macOS 的 `CGEvent` 原始坐标是逻辑点，由 `listen_mouse_macos` 乘缩放系数后再写入，
/// 与前端命中判定的口径一致（issue #523）。
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
    // 命中判定要求光标与窗口几何同处一个坐标空间：先记下当前窗口的缩放系数，
    // 交给 macOS 监听线程把 CGEvent 的逻辑点换算成物理像素（issue #523）。
    store_scale_factor(&state.scale_factor, window.scale_factor().unwrap_or(1.0));
    bind_pet_mouse_emitter(&state.emitter, &state.revision, window);
    if state.started.swap(true, Ordering::SeqCst) {
        return;
    }
    // 监听线程失败时复位标记，允许前端重试（如钩子安装被系统拒绝）。
    let started_on_error = state.started.clone();
    let shared: Arc<MouseStateStore> = Arc::default();

    // 监听线程：只把最新坐标与按键状态写入共享槽，不做任何 IO。
    let store = shared.clone();
    let listener_scale = state.scale_factor.clone();
    thread::spawn(move || {
        if let Err(error) = listen_mouse(store.clone(), listener_scale) {
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
    let throttle_scale = state.scale_factor.clone();
    thread::spawn(move || {
        let mut last_sent: Option<MouseCursorPos> = None;
        let mut last_button: Option<bool> = None;
        let mut bound_revision = revision.load(Ordering::SeqCst);
        let mut ticks: u64 = 0;
        loop {
            // 每约 500ms 跟随当前接收窗口刷新一次缩放系数：桌宠被拖到另一块缩放
            // 不同的显示器后，命中换算的系数必须同步（issue #523）。
            if ticks.is_multiple_of(SCALE_REFRESH_TICKS) {
                refresh_scale_factor(&emitter, &throttle_scale);
            }
            ticks = ticks.wrapping_add(1);
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
///
/// `scale_factor` 只有 macOS 需要（`CGEvent` 给的是逻辑点，必须换算成物理像素）；
/// Windows 的 `GetCursorPos` 与 Linux 的 rdev 本身就是物理像素。
fn listen_mouse(
    store: Arc<MouseStateStore>,
    scale_factor: SharedScaleFactor,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        listen_mouse_macos(store, scale_factor)
    }
    #[cfg(target_os = "windows")]
    {
        let _ = &scale_factor;
        listen_mouse_windows(store)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = &scale_factor;
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
/// `CGEventGetLocation` 返回全局显示坐标（**逻辑点**），而前端命中判定用的是物理
/// 像素，因此这里必须乘桌宠窗口的缩放系数后再写共享槽（issue #523）。
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
fn listen_mouse_macos(
    store: Arc<MouseStateStore>,
    scale_factor: SharedScaleFactor,
) -> Result<(), String> {
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
                    // CGEvent 是逻辑点，前端命中箱是物理像素（innerPosition + DOMRect×dpr）：
                    // 不换算会让判定区整体偏移 scale 倍，Retina 上宠物永远判否、窗口一直
                    // 点击穿透，pointerdown 到不了 WebView，startDragging 永不执行（issue #523）。
                    let scale = load_scale_factor(&scale_factor);
                    store.write_position(MouseCursorPos {
                        x: point.x * scale,
                        y: point.y * scale,
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

/// 坐标空间换算的回归测试（issue #523）。
///
/// 这里的命中箱完全复刻前端 `src/hooks/use-omit-ignore-cursor-events.ts` 的算法：
/// `innerPosition()` 已是物理像素，`DOMRect` 是 CSS 像素，须乘 `devicePixelRatio`。
/// 后端发出的光标必须落在同一空间，否则判定永远为否。
#[cfg(test)]
mod scale_tests {
    use super::*;

    /// 命中箱（物理像素）：`window_origin` 取 `innerPosition()`，`rect` 为
    /// `(left, top, width, height)` 的 `getBoundingClientRect()`，`dpr` 为 `devicePixelRatio`。
    fn hit_box(
        window_origin: (f64, f64),
        rect: (f64, f64, f64, f64),
        dpr: f64,
    ) -> (f64, f64, f64, f64) {
        let left = window_origin.0 + rect.0 * dpr;
        let top = window_origin.1 + rect.1 * dpr;
        (left, top, left + rect.2 * dpr, top + rect.3 * dpr)
    }

    /// 与前端 `isCursorInElement` 相同的包含判定。
    fn in_box(pos: MouseCursorPos, (left, top, right, bottom): (f64, f64, f64, f64)) -> bool {
        pos.x >= left && pos.x <= right && pos.y >= top && pos.y <= bottom
    }

    /// issue #523 实测数据（macOS M4 Retina：逻辑 1710×1112 pt / scale = dpr = 2）：
    /// 桌宠窗口物理原点 `(1468, 780)`（正好是点坐标 `(734, 390)` 的 2 倍），
    /// 宠物本体相对窗口 `(89, 82)`、尺寸 `(242, 136)`。
    ///
    /// 光标停在宠物脸上时 `CGEventGetLocation` 给逻辑点 `(940, 545)`：
    /// 不换算 —— 判定为否，窗口一直穿透，`pointerdown` 到不了 WebView，
    /// `startDragging()` 永不执行（Bug 现象）；换算后必须命中。
    #[test]
    fn retina_logical_cursor_hits_pet_only_after_scaling() {
        let shared = AtomicU64::new(0);
        store_scale_factor(&shared, 2.0);
        let scale = load_scale_factor(&shared);

        let box_ = hit_box((1468.0, 780.0), (89.0, 82.0, 242.0, 136.0), 2.0);
        let raw = MouseCursorPos { x: 940.0, y: 545.0 };
        let physical = MouseCursorPos {
            x: raw.x * scale,
            y: raw.y * scale,
        };

        assert!(
            !in_box(raw, box_),
            "逻辑点不该落在物理像素命中箱内（这正是 Bug 的成因）"
        );
        assert!(
            in_box(physical, box_),
            "乘缩放系数后必须命中：physical={physical:?} box={box_:?}"
        );

        // 光标远在屏幕角落（逻辑点 (10, 10)）时换算后仍应判否，保持整窗穿透。
        let far = MouseCursorPos { x: 10.0, y: 10.0 };
        assert!(!in_box(
            MouseCursorPos {
                x: far.x * scale,
                y: far.y * scale
            },
            box_
        ));
    }

    /// 未初始化或非法值必须回退 `1.0`：`0` 会让命中区塌缩到原点，`NaN` / 负数 /
    /// 无穷会让比较恒为 false 或恒为 true，两者都会让穿透态卡死。
    #[test]
    fn scale_factor_falls_back_to_one_when_unset_or_invalid() {
        let shared = AtomicU64::new(0);
        assert_eq!(load_scale_factor(&shared), 1.0);

        store_scale_factor(&shared, 3.0);
        assert_eq!(load_scale_factor(&shared), 3.0);

        for invalid in [f64::NAN, -2.0, f64::INFINITY, -0.0] {
            store_scale_factor(&shared, invalid);
            assert_eq!(
                load_scale_factor(&shared),
                1.0,
                "非法缩放系数 {invalid} 必须回退到 1.0"
            );
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
