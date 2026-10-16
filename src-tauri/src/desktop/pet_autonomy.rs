use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, WebviewWindow};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

impl Rect {
    fn shifted(self, x: i32, y: i32) -> Self {
        Self {
            left: self.left + x,
            right: self.right + x,
            top: self.top + y,
            bottom: self.bottom + y,
        }
    }

    fn contains(self, other: Self) -> bool {
        other.left >= self.left
            && other.top >= self.top
            && other.right <= self.right
            && other.bottom <= self.bottom
    }
}

#[derive(Clone, Copy, Deserialize)]
pub struct PetBody {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

impl PetBody {
    fn physical(self, scale: f64) -> Result<Rect, String> {
        let values = [self.left, self.top, self.right, self.bottom];
        if !scale.is_finite()
            || !(0.5..=8.0).contains(&scale)
            || values
                .iter()
                .any(|v| !v.is_finite() || !(0.0..=8192.0).contains(v))
            || self.right <= self.left
            || self.bottom <= self.top
        {
            return Err("PET_AUTONOMY_GEOMETRY_INVALID: invalid pet body".into());
        }
        Ok(Rect {
            left: (self.left * scale).round() as i32,
            top: (self.top * scale).round() as i32,
            right: (self.right * scale).round() as i32,
            bottom: (self.bottom * scale).round() as i32,
        })
    }
}

#[derive(Clone, Copy, Debug)]
struct Edge {
    x: i32,
    y: i32,
    dx: i32,
    dy: i32,
    contact_x: i32,
    contact_y: i32,
}

fn edges(body: Rect, target: Rect, area: Rect) -> Vec<Edge> {
    let width = body.right - body.left;
    let height = body.bottom - body.top;
    let x = body
        .left
        .clamp(target.left, (target.right - width).max(target.left));
    let y = body
        .top
        .clamp(target.top, (target.bottom - height).max(target.top));
    [
        Edge {
            x: target.left - width,
            y,
            dx: -1,
            dy: 0,
            contact_x: target.left + 2,
            contact_y: (y + height / 2).min(target.bottom - 3),
        },
        Edge {
            x: target.right,
            y,
            dx: 1,
            dy: 0,
            contact_x: target.right - 3,
            contact_y: (y + height / 2).min(target.bottom - 3),
        },
        Edge {
            x,
            y: target.top - height,
            dx: 0,
            dy: -1,
            contact_x: (x + width / 2).min(target.right - 3),
            contact_y: target.top + 2,
        },
        Edge {
            x,
            y: target.bottom,
            dx: 0,
            dy: 1,
            contact_x: (x + width / 2).min(target.right - 3),
            contact_y: target.bottom - 3,
        },
    ]
    .into_iter()
    .filter(|edge| {
        let pet = Rect {
            left: edge.x,
            top: edge.y,
            right: edge.x + width,
            bottom: edge.y + height,
        };
        area.contains(pet) && area.contains(target)
    })
    .collect()
}

fn distance(body: Rect, edge: Edge) -> i64 {
    let x = i64::from(body.left) - i64::from(edge.x);
    let y = i64::from(body.top) - i64::from(edge.y);
    x * x + y * y
}

#[derive(Clone)]
struct Target {
    handle: usize,
    pid: u32,
    rect: Rect,
    edge: Edge,
    interaction: Option<Interaction>,
    pull_decision: PullDecision,
    area: Rect,
    body: Rect,
    scale: f64,
    pet_position: (i32, i32),
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Action {
    Move,
    Squeeze,
    Stretch,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct ResizeLimits {
    minimum: (i32, i32),
    maximum: (i32, i32),
}

#[derive(Clone, Copy)]
struct InteractionOptions {
    resize: bool,
    movement: bool,
    preferred: Action,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Interaction {
    action: Action,
    remaining: i32,
}

impl Action {
    fn transform(self, rect: Rect, edge: Edge, amount: i32) -> (Rect, i32, i32) {
        let direction = if self == Self::Squeeze { -1 } else { 1 };
        let x = edge.dx * amount * direction;
        let y = edge.dy * amount * direction;
        let mut next = rect;
        match self {
            Self::Move => next = rect.shifted(x, y),
            Self::Squeeze | Self::Stretch => {
                if edge.dx < 0 {
                    next.left += x;
                } else if edge.dx > 0 {
                    next.right += x;
                } else if edge.dy < 0 {
                    next.top += y;
                } else {
                    next.bottom += y;
                }
            }
        }
        (next, x, y)
    }
}

fn plan_interaction(
    rect: Rect,
    edge: Edge,
    body: Rect,
    area: Rect,
    scale: f64,
    limits: Option<ResizeLimits>,
    options: InteractionOptions,
) -> Option<Interaction> {
    let room = match (edge.dx, edge.dy) {
        (-1, 0) => body.left.min(rect.left) - area.left,
        (1, 0) => area.right - body.right.max(rect.right),
        (0, -1) => body.top.min(rect.top) - area.top,
        _ => area.bottom - body.bottom.max(rect.bottom),
    };
    let travel = room.min((80.0 * scale).round() as i32);
    let (squeeze, stretch) = limits.map_or((0, 0), |limits| {
        let (extent, minimum, maximum) = if edge.dx != 0 {
            (rect.right - rect.left, limits.minimum.0, limits.maximum.0)
        } else {
            (rect.bottom - rect.top, limits.minimum.1, limits.maximum.1)
        };
        let cap = (extent / 10).min((48.0 * scale).round() as i32);
        (
            (extent - minimum).min(cap),
            (maximum - extent).min(cap).min(room),
        )
    });
    let candidates = [
        (Action::Move, travel, options.movement),
        (Action::Squeeze, squeeze, options.resize),
        (Action::Stretch, stretch, options.resize),
    ];
    candidates
        .iter()
        .filter(|(_, remaining, enabled)| *enabled && *remaining > 0)
        .min_by_key(|(action, _, _)| *action != options.preferred)
        .map(|&(action, remaining, _)| Interaction { action, remaining })
}

#[derive(Clone, Default)]
struct PullDecision(Option<bool>);

impl PullDecision {
    fn allows(&mut self, probability: u8, roll: impl FnOnce() -> u8) -> bool {
        *self.0.get_or_insert_with(|| roll() < probability)
    }
}

#[derive(Default)]
pub struct PetAutonomy {
    target: Option<Target>,
    last_tick: Option<Instant>,
    next_search: Option<Instant>,
    frame: Option<InteractionFrame>,
}

#[derive(Clone, Serialize)]
pub struct InteractionFrame {
    action: &'static str,
    direction: &'static str,
    edge: &'static str,
    contact: Option<ContactPoint>,
}

#[derive(Clone, Serialize)]
struct ContactPoint {
    x: f64,
    y: f64,
}

fn interaction_frame(target: &Target, walking: bool, delta: (i32, i32)) -> InteractionFrame {
    let edge = match (target.edge.dx, target.edge.dy) {
        (-1, 0) => "left",
        (1, 0) => "right",
        (0, -1) => "top",
        _ => "bottom",
    };
    let (dx, dy) = if walking {
        delta
    } else {
        (-target.edge.dx, -target.edge.dy)
    };
    let direction = if dx.abs() >= dy.abs() && dx != 0 {
        if dx < 0 {
            "left"
        } else {
            "right"
        }
    } else if dy < 0 {
        "up"
    } else {
        "down"
    };
    let action = if walking {
        "walk"
    } else {
        match target.interaction.map(|item| item.action) {
            Some(Action::Squeeze) => "squeeze",
            Some(Action::Stretch) => "stretch",
            _ => "move",
        }
    };
    let contact = (!walking).then(|| {
        let x = match target.edge.dx {
            -1 => target.rect.left,
            1 => target.rect.right,
            _ => target.edge.contact_x,
        };
        let y = match target.edge.dy {
            -1 => target.rect.top,
            1 => target.rect.bottom,
            _ => target.edge.contact_y,
        };
        ContactPoint {
            x: f64::from(x - target.pet_position.0) / target.scale,
            y: f64::from(y - target.pet_position.1) / target.scale,
        }
    });
    InteractionFrame {
        action,
        direction,
        edge,
        contact,
    }
}

impl PetAutonomy {
    pub(crate) fn rest(&mut self, now: Instant, seconds: u64) {
        self.target = None;
        self.frame = None;
        self.last_tick = Some(now);
        self.next_search = Some(now + Duration::from_secs(seconds));
    }
}

#[tauri::command]
pub fn step_pet_autonomy(
    window: WebviewWindow,
    state: tauri::State<'_, Mutex<PetAutonomy>>,
    body: Option<PetBody>,
    paused: bool,
) -> Result<Option<InteractionFrame>, String> {
    if window.label() != super::pet::PET_WINDOW_LABEL {
        return Err("PET_AUTONOMY_CALLER_FORBIDDEN: pet window required".into());
    }
    let mut state = state
        .lock()
        .map_err(|_| "PET_AUTONOMY_LOCK_FAILED".to_string())?;
    let now = Instant::now();
    let settings = crate::config::read_store_dat_setting(window.app_handle());
    if paused
        || !settings.pet_autonomy_enabled
        || !settings.pet_enabled
        || body.is_none()
        || !window.is_visible().unwrap_or(false)
    {
        state.rest(now, 6);
        return Ok(None);
    }
    #[cfg(windows)]
    {
        let result = windows::step(
            &window,
            &mut state,
            body.unwrap(),
            settings.pet_drag_probability,
            InteractionOptions {
                resize: settings.pet_resize_enabled,
                movement: settings.pet_move_enabled,
                preferred: if settings.pet_resize_enabled
                    && (!settings.pet_move_enabled || rand::random())
                {
                    if rand::random() {
                        Action::Squeeze
                    } else {
                        Action::Stretch
                    }
                } else {
                    Action::Move
                },
            },
            now,
        );
        if result.is_err() {
            state.rest(now, 20);
        }
        result.map(|()| state.frame.clone())
    }
    #[cfg(not(windows))]
    {
        state.rest(now, 20);
        Ok(None)
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, POINT, RECT};
    use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    fn rect(handle: HWND) -> Option<Rect> {
        let mut raw = RECT::default();
        if unsafe { GetWindowRect(handle, &mut raw) } == 0 {
            return None;
        }
        Some(Rect {
            left: raw.left,
            top: raw.top,
            right: raw.right,
            bottom: raw.bottom,
        })
    }

    fn eligible(handle: HWND, excluded_pid: u32) -> Option<(u32, Rect)> {
        unsafe {
            let mut pid = 0;
            GetWindowThreadProcessId(handle, &mut pid);
            if pid == 0
                || pid == excluded_pid
                || IsWindowVisible(handle) == 0
                || IsHungAppWindow(handle) != 0
                || IsIconic(handle) != 0
                || IsZoomed(handle) != 0
                || handle == GetShellWindow()
                || handle == GetDesktopWindow()
                || !GetWindow(handle, GW_OWNER).is_null()
            {
                return None;
            }
            let style = GetWindowLongW(handle, GWL_STYLE) as u32;
            let extended = GetWindowLongW(handle, GWL_EXSTYLE) as u32;
            if style & WS_CAPTION != WS_CAPTION
                || extended & (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE) != 0
            {
                return None;
            }
            let mut cloaked: u32 = 0;
            if DwmGetWindowAttribute(
                handle,
                DWMWA_CLOAKED as u32,
                (&mut cloaked as *mut u32).cast(),
                4,
            ) < 0
                || cloaked != 0
            {
                return None;
            }
            let bounds = rect(handle)?;
            if bounds.right - bounds.left < 120 || bounds.bottom - bounds.top < 80 {
                return None;
            }
            Some((pid, bounds))
        }
    }

    fn exposed(handle: HWND, edge: Edge) -> bool {
        unsafe {
            GetAncestor(
                WindowFromPoint(POINT {
                    x: edge.contact_x,
                    y: edge.contact_y,
                }),
                GA_ROOT,
            ) == handle
        }
    }

    struct Search {
        body: Rect,
        area: Rect,
        best: Option<(usize, u32, Rect, Edge)>,
        score: i64,
    }

    unsafe extern "system" fn visit(handle: HWND, data: LPARAM) -> i32 {
        let search = &mut *(data as *mut Search);
        if let Some((pid, bounds)) = eligible(handle, std::process::id()) {
            for edge in edges(search.body, bounds, search.area) {
                let score = distance(search.body, edge);
                if score < search.score && exposed(handle, edge) {
                    search.score = score;
                    search.best = Some((handle as usize, pid, bounds, edge));
                }
            }
        }
        1
    }

    fn resize_limits(handle: HWND, scale: f64) -> Option<ResizeLimits> {
        if unsafe { GetWindowLongW(handle, GWL_STYLE) as u32 } & WS_THICKFRAME == 0 {
            return None;
        }
        let mut limits = MINMAXINFO::default();
        let result = unsafe {
            SendMessageTimeoutW(
                handle,
                WM_GETMINMAXINFO,
                0,
                (&mut limits as *mut MINMAXINFO) as LPARAM,
                SMTO_ABORTIFHUNG | SMTO_BLOCK,
                100,
                std::ptr::null_mut(),
            )
        };
        (result != 0).then_some(ResizeLimits {
            minimum: (
                limits.ptMinTrackSize.x.max((320.0 * scale).ceil() as i32),
                limits.ptMinTrackSize.y.max((200.0 * scale).ceil() as i32),
            ),
            maximum: (
                if limits.ptMaxTrackSize.x > 0 {
                    limits.ptMaxTrackSize.x
                } else {
                    i32::MAX
                },
                if limits.ptMaxTrackSize.y > 0 {
                    limits.ptMaxTrackSize.y
                } else {
                    i32::MAX
                },
            ),
        })
    }

    fn change_target(
        handle: HWND,
        expected: Rect,
        desired: Rect,
        scale: f64,
    ) -> Result<Rect, String> {
        let same_size = expected.right - expected.left == desired.right - desired.left
            && expected.bottom - expected.top == desired.bottom - desired.top;
        if !same_size {
            let limits = resize_limits(handle, scale)
                .ok_or("PET_AUTONOMY_TARGET_NOT_RESIZABLE: target does not support resizing")?;
            let width = desired.right - desired.left;
            let height = desired.bottom - desired.top;
            if width < limits.minimum.0 || height < limits.minimum.1 {
                return Err("PET_AUTONOMY_TARGET_MINIMUM_SIZE: target reached minimum size".into());
            }
            if width > limits.maximum.0 || height > limits.maximum.1 {
                return Err("PET_AUTONOMY_TARGET_MAXIMUM_SIZE: target reached maximum size".into());
            }
        }
        if rect(handle) != Some(expected) {
            return Err("PET_AUTONOMY_TARGET_CHANGED: target changed before interaction".into());
        }
        let result = unsafe {
            SetWindowPos(
                handle,
                std::ptr::null_mut(),
                desired.left,
                desired.top,
                desired.right - desired.left,
                desired.bottom - desired.top,
                SWP_NOACTIVATE
                    | SWP_NOZORDER
                    | SWP_NOOWNERZORDER
                    | if same_size { SWP_NOSIZE } else { 0 },
            )
        };
        if result == 0 || rect(handle) != Some(desired) {
            return Err("PET_AUTONOMY_TARGET_CHANGE_FAILED: target rejected interaction".into());
        }
        Ok(desired)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        struct Fixture(HWND);
        impl Drop for Fixture {
            fn drop(&mut self) {
                unsafe {
                    DestroyWindow(self.0);
                }
            }
        }

        fn fixture(style: u32) -> Fixture {
            let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
            let title: Vec<u16> = "Pet interaction isolated test\0".encode_utf16().collect();
            let handle = unsafe {
                CreateWindowExW(
                    0,
                    class.as_ptr(),
                    title.as_ptr(),
                    style,
                    400,
                    200,
                    640,
                    480,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null(),
                )
            };
            assert!(!handle.is_null());
            Fixture(handle)
        }

        unsafe extern "system" fn minimum_proc(
            handle: HWND,
            message: u32,
            wparam: usize,
            lparam: LPARAM,
        ) -> isize {
            if message == WM_GETMINMAXINFO {
                let limits = &mut *(lparam as *mut MINMAXINFO);
                limits.ptMinTrackSize = POINT { x: 610, y: 450 };
                limits.ptMaxTrackSize = POINT { x: 660, y: 500 };
                return 0;
            }
            DefWindowProcW(handle, message, wparam, lparam)
        }

        #[test]
        fn native_squeeze_changes_only_the_contacted_edge() {
            let fixture = fixture(WS_OVERLAPPEDWINDOW);
            let before = rect(fixture.0).unwrap();
            let area = Rect {
                left: 0,
                top: 0,
                right: 2000,
                bottom: 1200,
            };
            let body = Rect {
                left: 200,
                top: 300,
                right: 280,
                bottom: 380,
            };
            let expected = [
                Rect {
                    left: 440,
                    top: 200,
                    right: 1040,
                    bottom: 680,
                },
                Rect {
                    left: 400,
                    top: 200,
                    right: 1000,
                    bottom: 680,
                },
                Rect {
                    left: 400,
                    top: 240,
                    right: 1040,
                    bottom: 680,
                },
                Rect {
                    left: 400,
                    top: 200,
                    right: 1040,
                    bottom: 640,
                },
            ];
            let candidates = edges(body, before, area);
            assert_eq!(candidates.len(), 4);
            for (edge, expected) in candidates.into_iter().zip(expected) {
                let (desired, _, _) = Action::Squeeze.transform(before, edge, 40);
                let after = change_target(fixture.0, before, desired, 1.0).unwrap();
                assert_eq!(after, expected);
                change_target(fixture.0, after, before, 1.0).unwrap();
            }
        }

        #[test]
        fn native_resize_respects_app_minimum_and_fixed_window_style() {
            let fixture = fixture(WS_OVERLAPPEDWINDOW);
            unsafe {
                SetWindowLongPtrW(fixture.0, GWLP_WNDPROC, minimum_proc as *const () as isize);
            }
            assert_eq!(
                resize_limits(fixture.0, 1.0).map(|limits| limits.minimum),
                Some((610, 450))
            );
            assert_eq!(
                resize_limits(fixture.0, 2.0).map(|limits| limits.minimum),
                Some((640, 450))
            );
            let before = rect(fixture.0).unwrap();
            let too_small = Rect {
                right: before.right - 40,
                ..before
            };
            let error = change_target(fixture.0, before, too_small, 1.0).unwrap_err();
            assert!(error.starts_with("PET_AUTONOMY_TARGET_MINIMUM_SIZE:"));
            assert_eq!(rect(fixture.0), Some(before));
            let stretched = Rect {
                right: before.right + 20,
                ..before
            };
            assert_eq!(
                change_target(fixture.0, before, stretched, 1.0).unwrap(),
                stretched
            );
            let too_large = Rect {
                right: stretched.right + 1,
                ..stretched
            };
            let error = change_target(fixture.0, stretched, too_large, 1.0).unwrap_err();
            assert!(error.starts_with("PET_AUTONOMY_TARGET_MAXIMUM_SIZE:"));
            assert_eq!(rect(fixture.0), Some(stretched));
            change_target(fixture.0, stretched, before, 1.0).unwrap();
            unsafe {
                SetWindowLongW(
                    fixture.0,
                    GWL_STYLE,
                    (WS_OVERLAPPEDWINDOW & !WS_THICKFRAME) as i32,
                );
            }
            assert_eq!(resize_limits(fixture.0, 1.0), None);
            let error = change_target(fixture.0, before, too_small, 1.0).unwrap_err();
            assert!(error.starts_with("PET_AUTONOMY_TARGET_NOT_RESIZABLE:"));
            assert_eq!(rect(fixture.0), Some(before));
        }

        #[test]
        fn native_interaction_stops_if_user_changed_window_geometry() {
            let fixture = fixture(WS_OVERLAPPEDWINDOW);
            let before = rect(fixture.0).unwrap();
            let moved = change_target(fixture.0, before, before.shifted(20, 0), 1.0).unwrap();
            let error = change_target(fixture.0, before, before.shifted(80, 0), 1.0).unwrap_err();
            assert!(error.starts_with("PET_AUTONOMY_TARGET_CHANGED:"));
            assert_eq!(rect(fixture.0), Some(moved));
        }

        #[test]
        fn native_pull_moves_fixture_without_resizing_or_stealing_focus() {
            let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
            let title: Vec<u16> = "Pet autonomy isolated test\0".encode_utf16().collect();
            let handle = unsafe {
                CreateWindowExW(
                    0,
                    class.as_ptr(),
                    title.as_ptr(),
                    WS_OVERLAPPEDWINDOW,
                    200,
                    200,
                    320,
                    240,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null(),
                )
            };
            assert!(!handle.is_null());
            let _fixture = Fixture(handle);
            unsafe {
                ShowWindow(handle, SW_SHOWNOACTIVATE);
            }
            let foreground = unsafe { GetForegroundWindow() };
            let before = rect(handle).unwrap();
            let after = change_target(handle, before, before.shifted(80, 0), 1.0).unwrap();
            assert_eq!(after, before.shifted(80, 0));
            assert_eq!(unsafe { GetForegroundWindow() }, foreground);
            assert_eq!(eligible(handle, std::process::id()), None);
            assert_eq!(eligible(handle, 0), Some((std::process::id(), after)));
            unsafe {
                ShowWindow(handle, SW_MINIMIZE);
            }
            assert_eq!(eligible(handle, 0), None);
            unsafe {
                ShowWindow(handle, SW_MAXIMIZE);
            }
            assert_eq!(eligible(handle, 0), None);
        }
    }

    pub(super) fn step(
        window: &WebviewWindow,
        state: &mut PetAutonomy,
        body: PetBody,
        probability: u8,
        options: InteractionOptions,
        now: Instant,
    ) -> Result<(), String> {
        if [VK_LBUTTON, VK_RBUTTON, VK_MBUTTON]
            .iter()
            .any(|key| unsafe { GetAsyncKeyState(i32::from(*key)) } < 0)
        {
            state.rest(now, 6);
            return Ok(());
        }
        let scale = window
            .scale_factor()
            .map_err(|e| format!("PET_AUTONOMY_SCALE_FAILED: {e}"))?;
        let local = body.physical(scale)?;
        let position = window
            .outer_position()
            .map_err(|e| format!("PET_AUTONOMY_POSITION_FAILED: {e}"))?;
        let body = local.shifted(position.x, position.y);
        let monitor = window
            .current_monitor()
            .map_err(|e| format!("PET_AUTONOMY_MONITOR_FAILED: {e}"))?
            .ok_or("PET_AUTONOMY_MONITOR_MISSING")?;
        let work = monitor.work_area();
        let area = Rect {
            left: work.position.x,
            top: work.position.y,
            right: work.position.x + work.size.width as i32,
            bottom: work.position.y + work.size.height as i32,
        };
        if let Some(foreground) = rect(unsafe { GetForegroundWindow() }) {
            let p = monitor.position();
            let size = monitor.size();
            if foreground.contains(Rect {
                left: p.x,
                top: p.y,
                right: p.x + size.width as i32,
                bottom: p.y + size.height as i32,
            }) {
                state.rest(now, 6);
                return Ok(());
            }
        }
        let elapsed = state
            .last_tick
            .map(|last| now.duration_since(last).as_secs_f64())
            .unwrap_or(0.0);
        state.last_tick = Some(now);
        if state.next_search.is_none() || elapsed > 1.0 {
            state.rest(now, 6);
            return Ok(());
        }
        if state.target.is_none() {
            if now < state.next_search.unwrap() {
                return Ok(());
            }
            let mut search = Search {
                body,
                area,
                best: None,
                score: i64::MAX,
            };
            unsafe {
                EnumWindows(Some(visit), (&mut search as *mut Search) as LPARAM);
            }
            let Some((handle, pid, rect, edge)) = search.best else {
                state.rest(now, 20);
                return Ok(());
            };
            state.target = Some(Target {
                handle,
                pid,
                rect,
                edge,
                interaction: None,
                pull_decision: PullDecision::default(),
                area,
                body: local,
                scale,
                pet_position: (position.x, position.y),
            });
        }
        let mut target = state.target.take().unwrap();
        let handle = target.handle as HWND;
        if eligible(handle, std::process::id()) != Some((target.pid, target.rect))
            || area != target.area
            || local != target.body
            || scale != target.scale
            || target.pet_position != (position.x, position.y)
            || !exposed(handle, target.edge)
        {
            state.rest(now, 6);
            return Ok(());
        }
        let dx = target.edge.x - body.left;
        let dy = target.edge.y - body.top;
        let length = f64::from(dx).hypot(f64::from(dy));
        let walking = length > 1.0;
        let (x, y) = if length > 1.0 {
            let step = (100.0 * scale * elapsed.min(0.1)).max(1.0).min(length);
            (
                (f64::from(dx) / length * step).round() as i32,
                (f64::from(dy) / length * step).round() as i32,
            )
        } else {
            if probability == 0
                || !target
                    .pull_decision
                    .allows(probability, || rand::random_range(0..100))
            {
                state.rest(now, 20);
                return Ok(());
            }
            if target.interaction.is_none() {
                target.interaction = plan_interaction(
                    target.rect,
                    target.edge,
                    body,
                    area,
                    scale,
                    resize_limits(handle, scale),
                    options,
                );
            }
            let Some(interaction) = target.interaction.as_mut() else {
                state.rest(now, 20);
                return Ok(());
            };
            let speed = if interaction.action == Action::Move {
                60.0
            } else {
                30.0
            };
            let amount = ((speed * scale * elapsed.min(0.1)).round() as i32)
                .max(1)
                .min(interaction.remaining);
            let (desired, x, y) = interaction
                .action
                .transform(target.rect, target.edge, amount);
            if !area.contains(body.shifted(x, y)) || !area.contains(desired) {
                state.rest(now, 20);
                return Ok(());
            }
            target.rect = change_target(handle, target.rect, desired, scale)?;
            target.edge.x += x;
            target.edge.y += y;
            target.edge.contact_x += x;
            target.edge.contact_y += y;
            interaction.remaining -= amount;
            (x, y)
        };
        let next = (position.x + x, position.y + y);
        window
            .set_position(tauri::PhysicalPosition::new(next.0, next.1))
            .map_err(|e| format!("PET_AUTONOMY_MOVE_FAILED: {e}"))?;
        target.pet_position = next;
        state.frame = Some(interaction_frame(&target, walking, (dx, dy)));
        if target
            .interaction
            .is_some_and(|action| action.remaining == 0)
        {
            state.rest(now, 20);
        } else {
            state.target = Some(target);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREA: Rect = Rect {
        left: 0,
        top: 0,
        right: 1600,
        bottom: 1000,
    };
    const WINDOW: Rect = Rect {
        left: 400,
        top: 200,
        right: 1040,
        bottom: 680,
    };
    const BODY: Rect = Rect {
        left: 200,
        top: 300,
        right: 280,
        bottom: 380,
    };

    #[test]
    fn animation_frames_distinguish_actions_and_convert_contact_to_logical_coordinates() {
        let mut target = Target {
            handle: 1,
            pid: 1,
            rect: WINDOW,
            edge: edges(BODY, WINDOW, AREA)[0],
            interaction: None,
            pull_decision: PullDecision::default(),
            area: AREA,
            body: BODY,
            scale: 2.0,
            pet_position: (200, 260),
        };
        for (delta, direction) in [
            ((-10, 1), "left"),
            ((10, 1), "right"),
            ((1, -10), "up"),
            ((1, 10), "down"),
        ] {
            let frame = interaction_frame(&target, true, delta);
            assert_eq!(
                serde_json::to_value(frame).unwrap(),
                serde_json::json!({"action":"walk", "direction":direction, "edge":"left", "contact":null})
            );
        }
        for (action, name) in [
            (Action::Squeeze, "squeeze"),
            (Action::Stretch, "stretch"),
            (Action::Move, "move"),
        ] {
            target.interaction = Some(Interaction {
                action,
                remaining: 10,
            });
            let frame = interaction_frame(&target, false, (0, 0));
            assert_eq!(
                serde_json::to_value(frame).unwrap(),
                serde_json::json!({"action":name, "direction":"right", "edge":"left", "contact":{"x":100.0,"y":40.0}})
            );
        }
        for (edge, direction, x, y) in [
            (1, "left", 420.0, 40.0),
            (2, "down", 120.0, -30.0),
            (3, "up", 120.0, 210.0),
        ] {
            target.edge = edges(BODY, WINDOW, AREA)[edge];
            let frame = interaction_frame(&target, false, (0, 0));
            assert_eq!(frame.direction, direction);
            let contact = frame.contact.unwrap();
            assert_eq!((contact.x, contact.y), (x, y));
        }
        let mut state = PetAutonomy {
            frame: Some(interaction_frame(&target, false, (0, 0))),
            ..Default::default()
        };
        state.rest(Instant::now(), 6);
        assert!(state.frame.is_none());
    }

    #[test]
    fn movement_preserves_size_in_all_four_directions() {
        let expected = [
            Rect {
                left: 320,
                top: 200,
                right: 960,
                bottom: 680,
            },
            Rect {
                left: 480,
                top: 200,
                right: 1120,
                bottom: 680,
            },
            Rect {
                left: 400,
                top: 120,
                right: 1040,
                bottom: 600,
            },
            Rect {
                left: 400,
                top: 280,
                right: 1040,
                bottom: 760,
            },
        ];
        let candidates = edges(BODY, WINDOW, AREA);
        assert_eq!(candidates.len(), 4);
        for (edge, expected) in candidates.into_iter().zip(expected) {
            assert_eq!(Action::Move.transform(WINDOW, edge, 80).0, expected);
        }
    }

    #[test]
    fn squeeze_follows_contact_edge_and_keeps_opposite_edge_fixed() {
        let expected = [
            (
                Rect {
                    left: 440,
                    top: 200,
                    right: 1040,
                    bottom: 680,
                },
                40,
                0,
            ),
            (
                Rect {
                    left: 400,
                    top: 200,
                    right: 1000,
                    bottom: 680,
                },
                -40,
                0,
            ),
            (
                Rect {
                    left: 400,
                    top: 240,
                    right: 1040,
                    bottom: 680,
                },
                0,
                40,
            ),
            (
                Rect {
                    left: 400,
                    top: 200,
                    right: 1040,
                    bottom: 640,
                },
                0,
                -40,
            ),
        ];
        let candidates = edges(BODY, WINDOW, AREA);
        assert_eq!(candidates.len(), 4);
        for (edge, expected) in candidates.into_iter().zip(expected) {
            assert_eq!(Action::Squeeze.transform(WINDOW, edge, 40), expected);
        }
    }

    fn limits(minimum: (i32, i32)) -> ResizeLimits {
        ResizeLimits {
            minimum,
            maximum: (2000, 1200),
        }
    }

    fn options(preferred: Action) -> InteractionOptions {
        InteractionOptions {
            resize: true,
            movement: true,
            preferred,
        }
    }

    #[test]
    fn selected_interactions_never_fall_back_to_disabled_actions() {
        let edge = edges(BODY, WINDOW, AREA)[0];
        let body = BODY.shifted(edge.x - BODY.left, edge.y - BODY.top);
        for preferred in [Action::Move, Action::Squeeze, Action::Stretch] {
            for resize in [false, true] {
                for movement in [false, true] {
                    let selected = InteractionOptions {
                        resize,
                        movement,
                        preferred,
                    };
                    let result = plan_interaction(
                        WINDOW,
                        edge,
                        body,
                        AREA,
                        1.0,
                        Some(limits((320, 200))),
                        selected,
                    );
                    match (resize, movement) {
                        (false, false) => assert_eq!(result, None),
                        (false, true) => assert_eq!(
                            result,
                            Some(Interaction {
                                action: Action::Move,
                                remaining: 80
                            })
                        ),
                        (true, false) => assert_eq!(
                            result,
                            Some(Interaction {
                                action: if preferred == Action::Stretch {
                                    Action::Stretch
                                } else {
                                    Action::Squeeze
                                },
                                remaining: 48,
                            })
                        ),
                        (true, true) => assert_eq!(
                            result,
                            Some(Interaction {
                                action: preferred,
                                remaining: if preferred == Action::Move { 80 } else { 48 },
                            })
                        ),
                    }
                    if !movement {
                        assert_eq!(
                            plan_interaction(WINDOW, edge, body, AREA, 1.0, None, selected),
                            None
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn stretch_follows_each_edge_and_respects_screen_and_maximum_size() {
        let expected = [
            Rect {
                left: 360,
                top: 200,
                right: 1040,
                bottom: 680,
            },
            Rect {
                left: 400,
                top: 200,
                right: 1080,
                bottom: 680,
            },
            Rect {
                left: 400,
                top: 160,
                right: 1040,
                bottom: 680,
            },
            Rect {
                left: 400,
                top: 200,
                right: 1040,
                bottom: 720,
            },
        ];
        for (edge, expected) in edges(BODY, WINDOW, AREA).into_iter().zip(expected) {
            assert_eq!(Action::Stretch.transform(WINDOW, edge, 40).0, expected);
        }
        let edge = edges(BODY, WINDOW, AREA)[0];
        let body = BODY.shifted(edge.x - BODY.left, edge.y - BODY.top);
        let limits = ResizeLimits {
            minimum: (640, 480),
            maximum: (650, 490),
        };
        let selected = InteractionOptions {
            resize: true,
            movement: false,
            preferred: Action::Stretch,
        };
        assert_eq!(
            plan_interaction(WINDOW, edge, body, AREA, 1.0, Some(limits), selected),
            Some(Interaction {
                action: Action::Stretch,
                remaining: 10
            })
        );
        let area = Rect {
            left: body.left + 5,
            ..AREA
        };
        assert_eq!(
            plan_interaction(WINDOW, edge, body, area, 1.0, Some(limits), selected),
            None
        );
        let area = Rect {
            left: body.left - 5,
            ..AREA
        };
        assert_eq!(
            plan_interaction(WINDOW, edge, body, area, 1.0, Some(limits), selected),
            Some(Interaction {
                action: Action::Stretch,
                remaining: 5
            })
        );
    }

    #[test]
    fn interaction_selection_falls_back_for_fixed_or_minimum_sized_windows() {
        let edge = edges(BODY, WINDOW, AREA)[0];
        let body = BODY.shifted(edge.x - BODY.left, edge.y - BODY.top);
        for minimum in [None, Some((640, 480))] {
            assert_eq!(
                plan_interaction(
                    WINDOW,
                    edge,
                    body,
                    AREA,
                    1.0,
                    minimum.map(limits),
                    options(Action::Squeeze)
                ),
                Some(Interaction {
                    action: Action::Move,
                    remaining: 80
                })
            );
        }
        assert_eq!(
            plan_interaction(
                WINDOW,
                edge,
                body,
                AREA,
                1.0,
                Some(limits((320, 200))),
                options(Action::Squeeze)
            ),
            Some(Interaction {
                action: Action::Squeeze,
                remaining: 48
            })
        );
        assert_eq!(
            plan_interaction(
                WINDOW,
                edge,
                body,
                AREA,
                1.0,
                Some(limits((630, 200))),
                options(Action::Squeeze)
            ),
            Some(Interaction {
                action: Action::Squeeze,
                remaining: 10
            })
        );
    }

    #[test]
    fn screen_boundary_allows_squeeze_without_offscreen_movement() {
        let edge = edges(BODY, WINDOW, AREA)[0];
        let body = BODY.shifted(edge.x - BODY.left, edge.y - BODY.top);
        let area = Rect {
            left: body.left,
            ..AREA
        };
        assert_eq!(
            plan_interaction(WINDOW, edge, body, area, 1.0, None, options(Action::Move)),
            None
        );
        assert_eq!(
            plan_interaction(
                WINDOW,
                edge,
                body,
                area,
                1.0,
                Some(limits((320, 200))),
                options(Action::Move)
            ),
            Some(Interaction {
                action: Action::Squeeze,
                remaining: 48
            })
        );
    }

    #[test]
    fn interaction_distances_scale_once_and_squeeze_is_capped_at_ten_percent() {
        let edge = edges(BODY, WINDOW, AREA)[0];
        let body = BODY.shifted(edge.x - BODY.left, edge.y - BODY.top);
        assert_eq!(
            plan_interaction(WINDOW, edge, body, AREA, 1.5, None, options(Action::Move)),
            Some(Interaction {
                action: Action::Move,
                remaining: 120
            })
        );
        assert_eq!(
            plan_interaction(
                WINDOW,
                edge,
                body,
                AREA,
                1.5,
                Some(limits((480, 300))),
                options(Action::Squeeze)
            ),
            Some(Interaction {
                action: Action::Squeeze,
                remaining: 64
            })
        );
    }

    #[test]
    fn drag_probability_boundaries_and_threshold_are_exact() {
        for roll in 0..100 {
            assert!(!PullDecision::default().allows(0, || roll));
            assert!(PullDecision::default().allows(100, || roll));
            assert_eq!(PullDecision::default().allows(25, || roll), roll < 25);
        }
    }

    #[test]
    fn drag_probability_is_decided_once_for_each_approach() {
        let mut skipped = PullDecision::default();
        assert!(!skipped.allows(25, || 25));
        assert!(!skipped.allows(25, || panic!("must not reroll a skipped approach")));
        let mut pulling = PullDecision::default();
        assert!(pulling.allows(25, || 24));
        assert!(pulling.allows(25, || panic!("must not reroll during a pull")));
    }

    #[test]
    fn nearest_edge_uses_pet_body_and_stays_in_work_area() {
        let body = Rect {
            left: 100,
            top: 200,
            right: 180,
            bottom: 280,
        };
        let target = Rect {
            left: 400,
            top: 150,
            right: 800,
            bottom: 650,
        };
        let area = Rect {
            left: 0,
            top: 0,
            right: 1200,
            bottom: 900,
        };
        let edge = edges(body, target, area)
            .into_iter()
            .min_by_key(|e| distance(body, *e))
            .unwrap();
        assert_eq!((edge.x, edge.y, edge.dx, edge.dy), (320, 200, -1, 0));
    }

    #[test]
    fn movement_is_shortened_at_screen_boundary_on_negative_monitor() {
        let body = Rect {
            left: -1900,
            top: 200,
            right: -1820,
            bottom: 280,
        };
        let target = Rect {
            left: -1830,
            top: 150,
            right: -1200,
            bottom: 650,
        };
        let area = Rect {
            left: -1920,
            top: 0,
            right: 0,
            bottom: 1080,
        };
        let candidates = edges(body, target, area);
        let edge = *candidates.iter().find(|edge| edge.dx == -1).unwrap();
        let at_edge = Rect {
            left: -1910,
            top: 200,
            right: -1830,
            bottom: 280,
        };
        assert_eq!(
            plan_interaction(
                target,
                edge,
                at_edge,
                area,
                1.0,
                None,
                options(Action::Move)
            ),
            Some(Interaction {
                action: Action::Move,
                remaining: 10
            })
        );
    }

    #[test]
    fn oversized_windows_have_no_pullable_edges() {
        let area = Rect {
            left: 0,
            top: 0,
            right: 800,
            bottom: 600,
        };
        assert!(edges(
            Rect {
                left: 20,
                top: 20,
                right: 100,
                bottom: 100
            },
            area,
            area,
        )
        .is_empty());
    }

    #[test]
    fn body_scales_once_and_rejects_nonfinite_or_inverted_bounds() {
        let body = PetBody {
            left: 100.0,
            top: 50.0,
            right: 200.0,
            bottom: 150.0,
        };
        assert_eq!(
            body.physical(1.5).unwrap(),
            Rect {
                left: 150,
                top: 75,
                right: 300,
                bottom: 225
            }
        );
        assert!(PetBody {
            right: f64::NAN,
            ..body
        }
        .physical(1.0)
        .is_err());
        assert!(PetBody {
            right: 99.0,
            ..body
        }
        .physical(1.0)
        .is_err());
        assert!(body.physical(0.0).is_err());
    }
}
