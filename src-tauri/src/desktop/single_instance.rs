#![cfg(windows)]

use std::{
    ffi::c_void,
    os::windows::io::{FromRawHandle, OwnedHandle},
    ptr::{null, null_mut},
    sync::{mpsc, Arc, Mutex},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_deep_link::DeepLink;
use windows_sys::Win32::{
    Foundation::{
        GetLastError, SetLastError, ERROR_ALREADY_EXISTS, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM,
    },
    System::{LibraryLoader::GetModuleHandleW, Threading::CreateMutexW},
    UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, FindWindowExW,
        GetClassLongW, GetMessageW, GetWindowLongPtrW, GetWindowLongW, GetWindowThreadProcessId,
        PostQuitMessage, SendMessageTimeoutW, SendMessageW, SetWindowLongPtrW, SetWindowLongW,
        UnregisterClassW, CREATESTRUCTW, GCL_CBWNDEXTRA, GWLP_USERDATA, MSG, SMTO_ABORTIFHUNG,
        SMTO_BLOCK, SMTO_ERRORONEXIT, WM_APP, WM_CLOSE, WM_COPYDATA, WM_NCCREATE, WM_NCDESTROY,
        WNDPROC, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_OVERLAPPED,
    },
};

const MESSAGE_TAG: usize = 1542;
const MAX_MESSAGE_BYTES: usize = 256 * 1024;
const SEND_TIMEOUT_MS: u32 = 5000;
const STOP_TARGET: u32 = WM_APP + 1;

// 直依赖未启用 Gdi/DataExchange；这里只声明协议所需的原生 ABI，不扩大 Cargo 特性。
#[repr(C)]
struct WindowClass {
    style: u32,
    procedure: WNDPROC,
    class_extra: i32,
    window_extra: i32,
    instance: HINSTANCE,
    icon: *mut c_void,
    cursor: *mut c_void,
    brush: *mut c_void,
    menu: *const u16,
    name: *const u16,
}

#[link(name = "user32")]
extern "system" {
    fn RegisterClassW(class: *const WindowClass) -> u16;
}

#[repr(C)]
struct CopyData {
    tag: usize,
    length: u32,
    data: *const c_void,
}

#[derive(Debug, PartialEq, Eq)]
struct Request {
    cwd: String,
    args: Vec<String>,
}

impl Request {
    fn parse(bytes: &[u8]) -> Option<Self> {
        let data = std::str::from_utf8(bytes.strip_suffix(&[0])?).ok()?;
        if data.contains('\0') {
            return None;
        }
        let (cwd, args) = data.split_once('|')?;
        Some(Self {
            cwd: cwd.into(),
            args: args.split('|').map(str::to_owned).collect(),
        })
    }

    fn send(&self, target: HWND) -> Result<(), String> {
        let data = format!("{}|{}\0", self.cwd, self.args.join("|"));
        if data.len() > MAX_MESSAGE_BYTES {
            return Err("SINGLE_INSTANCE_PAYLOAD_TOO_LARGE".into());
        }
        let copy = CopyData {
            tag: MESSAGE_TAG,
            length: data.len() as u32,
            data: data.as_ptr().cast(),
        };
        let mut accepted = 0;
        let sent = unsafe {
            SetLastError(0);
            SendMessageTimeoutW(
                target,
                WM_COPYDATA,
                0,
                &copy as *const _ as _,
                SMTO_ABORTIFHUNG | SMTO_BLOCK | SMTO_ERRORONEXIT,
                SEND_TIMEOUT_MS,
                &mut accepted,
            )
        };
        if sent == 0 {
            return Err(win_error("SEND"));
        }
        if accepted == 0 {
            return Err("SINGLE_INSTANCE_REJECTED: target did not accept launch arguments".into());
        }
        Ok(())
    }
}

#[derive(Default)]
struct Inbox {
    app: Option<AppHandle>,
    pending: Vec<Request>,
}

fn dispatch(inbox: &Arc<Mutex<Inbox>>, app: &AppHandle) -> Result<(), String> {
    let inbox = Arc::clone(inbox);
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let pending = std::mem::take(&mut inbox.lock().unwrap_or_else(|e| e.into_inner()).pending);
        for request in pending {
            if let Some(deep_link) = handle.try_state::<DeepLink<tauri::Wry>>() {
                deep_link.handle_cli_arguments(request.args.iter());
            }
            crate::utils::show_main_window(&handle);
        }
    })
    .map_err(|error| format!("SINGLE_INSTANCE_DISPATCH_FAILED: {error}"))
}

struct NativeWindow {
    hwnd: HWND,
    class: Vec<u16>,
    module: HINSTANCE,
    inbox: Option<Box<Arc<Mutex<Inbox>>>>,
}

impl NativeWindow {
    fn create(identifier: &str, inbox: &Arc<Mutex<Inbox>>) -> Result<Self, String> {
        let class = wide(&format!("{identifier}-sic"));
        let name = wide(&format!("{identifier}-siw"));
        let module = unsafe { GetModuleHandleW(null()) };
        if module.is_null() {
            return Err(win_error("MODULE"));
        }
        let definition = WindowClass {
            style: 0,
            procedure: Some(window_proc),
            class_extra: 0,
            window_extra: 4,
            instance: module,
            icon: null_mut(),
            cursor: null_mut(),
            brush: null_mut(),
            menu: null(),
            name: class.as_ptr(),
        };
        if unsafe { RegisterClassW(&definition) } == 0 {
            return Err(win_error("REGISTER_CLASS"));
        }
        let data = Box::new(Arc::clone(inbox));
        let userdata = (&*data as *const Arc<Mutex<Inbox>>).cast();
        let mut window = Self {
            hwnd: null_mut(),
            class,
            module,
            inbox: Some(data),
        };
        window.hwnd = unsafe {
            CreateWindowExW(
                WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
                window.class.as_ptr(),
                name.as_ptr(),
                WS_OVERLAPPED,
                0,
                0,
                0,
                0,
                null_mut(),
                null_mut(),
                module,
                userdata,
            )
        };
        if window.hwnd.is_null() {
            return Err(win_error("CREATE_WINDOW"));
        }
        Ok(window)
    }
}

impl Drop for NativeWindow {
    fn drop(&mut self) {
        unsafe {
            if !self.hwnd.is_null() && DestroyWindow(self.hwnd) == 0 {
                log::error!("{}", win_error("DESTROY_WINDOW"));
                // 销毁失败时窗口仍可能回调，不能提前释放它的 userdata。
                if let Some(data) = self.inbox.take() {
                    let _ = Box::into_raw(data);
                }
            }
            if UnregisterClassW(self.class.as_ptr(), self.module) == 0 {
                log::error!("{}", win_error("UNREGISTER_CLASS"));
            }
        }
    }
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_NCCREATE => {
            let create = &*(lparam as *const CREATESTRUCTW);
            SetLastError(0);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as _);
            if GetLastError() != 0 {
                return 0;
            }
            // 默认处理初始化窗口标题，旧协议依赖它按 class/title 查找。
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        WM_COPYDATA => {
            if lparam == 0 {
                return 0;
            }
            let copy = &*(lparam as *const CopyData);
            let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const Arc<Mutex<Inbox>>;
            if state.is_null()
                || copy.tag != MESSAGE_TAG
                || copy.data.is_null()
                || copy.length == 0
                || copy.length as usize > MAX_MESSAGE_BYTES
            {
                return 0;
            }
            let bytes = std::slice::from_raw_parts(copy.data.cast(), copy.length as usize);
            let Some(request) = Request::parse(bytes) else {
                return 0;
            };
            let inbox = &*state;
            let app = {
                let mut state = inbox.lock().unwrap_or_else(|e| e.into_inner());
                state.pending.push(request);
                state.app.clone()
            };
            if let Some(app) = app {
                if let Err(error) = dispatch(inbox, &app) {
                    log::error!("{error}");
                    return 0;
                }
            }
            1
        }
        STOP_TARGET => {
            PostQuitMessage(0);
            1
        }
        WM_CLOSE => 0,
        WM_NCDESTROY => {
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

struct Target {
    hwnd: isize,
    thread: Option<JoinHandle<Result<(), String>>>,
    inbox: Arc<Mutex<Inbox>>,
}

impl Target {
    fn start(identifier: &str) -> Result<Self, String> {
        let inbox = Arc::new(Mutex::new(Inbox::default()));
        let receiver = Arc::clone(&inbox);
        let identifier = identifier.to_owned();
        let (ready, started) = mpsc::sync_channel(1);
        let thread = thread::Builder::new()
            .name("single-instance".into())
            .spawn(move || {
                let window = match NativeWindow::create(&identifier, &receiver) {
                    Ok(window) => window,
                    Err(error) => {
                        let _ = ready.send(Err(error));
                        return Ok(());
                    }
                };
                if ready.send(Ok(window.hwnd as isize)).is_err() {
                    return Ok(());
                }
                let mut message = MSG::default();
                loop {
                    match unsafe { GetMessageW(&mut message, null_mut(), 0, 0) } {
                        -1 => return Err(win_error("GET_MESSAGE")),
                        0 => return Ok(()),
                        _ => unsafe {
                            DispatchMessageW(&message);
                        },
                    }
                }
            })
            .map_err(|error| format!("SINGLE_INSTANCE_THREAD_FAILED: {error}"))?;
        let initialized = started
            .recv()
            .map_err(|error| format!("SINGLE_INSTANCE_START_FAILED: {error}"));
        match initialized {
            Ok(Ok(hwnd)) => Ok(Self {
                hwnd,
                thread: Some(thread),
                inbox,
            }),
            error => {
                let _ = thread.join();
                Err(match error {
                    Ok(Err(error)) | Err(error) => error,
                    _ => unreachable!(),
                })
            }
        }
    }

    fn stop(&mut self) -> Result<(), String> {
        if let Some(thread) = self.thread.take() {
            if !thread.is_finished() {
                unsafe { SendMessageW(self.hwnd as _, STOP_TARGET, 0, 0) };
            }
            thread
                .join()
                .map_err(|_| "SINGLE_INSTANCE_THREAD_PANICKED".to_owned())??;
        }
        Ok(())
    }
}

impl Drop for Target {
    fn drop(&mut self) {
        if let Err(error) = self.stop() {
            log::error!("{error}");
        }
    }
}

pub struct SingleInstance {
    target: Target,
    _mutex: OwnedHandle,
}

impl SingleInstance {
    pub fn attach(&self, app: &AppHandle) -> Result<(), String> {
        if crate::utils::shell_window(app).is_none()
            || app.try_state::<DeepLink<tauri::Wry>>().is_none()
        {
            return Err("SINGLE_INSTANCE_NOT_READY: attach after the main window and deep-link plugin are ready".into());
        }
        if self
            .target
            .thread
            .as_ref()
            .is_none_or(JoinHandle::is_finished)
        {
            return Err("SINGLE_INSTANCE_TARGET_STOPPED".into());
        }
        self.target
            .inbox
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .app = Some(app.clone());
        dispatch(&self.target.inbox, app)
    }
}

pub fn claim(identifier: &str) -> Result<Option<SingleInstance>, String> {
    if identifier.is_empty() || identifier.contains('\0') {
        return Err("SINGLE_INSTANCE_INVALID_IDENTIFIER".into());
    }
    // 先发布 target，旧插件在 CreateMutex 之后立即 FindWindow，反序会放过第二个 owner。
    let mut target = Target::start(identifier)?;
    let name = wide(&format!("{identifier}-sim"));
    // 旧协议只检查命名对象是否已存在，不等待 mutex；无需持有线程所有权。
    let mutex = unsafe { CreateMutexW(null(), 0, name.as_ptr()) };
    let existed = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
    if mutex.is_null() {
        return Err(win_error("CREATE_MUTEX"));
    }
    let mutex = unsafe { OwnedHandle::from_raw_handle(mutex) };
    if !existed {
        unsafe {
            SetLastError(0);
            SetWindowLongW(target.hwnd as _, 0, 1);
            if GetLastError() != 0 {
                return Err(win_error("MARK_OWNER"));
            }
        }
        return Ok(Some(SingleInstance {
            target,
            _mutex: mutex,
        }));
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    let owner = loop {
        if let Some(owner) = find_owner(identifier, std::process::id())? {
            break owner;
        }
        if Instant::now() >= deadline {
            return Err(
                "SINGLE_INSTANCE_TARGET_MISSING: existing mutex has no ready target".into(),
            );
        }
        thread::sleep(Duration::from_millis(10));
    };
    target.stop()?;
    let cwd =
        std::env::current_dir().map_err(|error| format!("SINGLE_INSTANCE_CWD_FAILED: {error}"))?;
    let cwd = cwd
        .into_os_string()
        .into_string()
        .map_err(|_| "SINGLE_INSTANCE_INVALID_CWD".to_owned())?;
    let args = std::env::args_os()
        .map(|arg| {
            arg.into_string()
                .map_err(|_| "SINGLE_INSTANCE_INVALID_ARGUMENT".to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;
    Request { cwd, args }.send(owner)?;
    for request in std::mem::take(
        &mut target
            .inbox
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pending,
    ) {
        request.send(owner)?;
    }
    Ok(None)
}

fn find_owner(identifier: &str, excluded_pid: u32) -> Result<Option<HWND>, String> {
    let class = wide(&format!("{identifier}-sic"));
    let name = wide(&format!("{identifier}-siw"));
    let mut previous = null_mut();
    loop {
        unsafe { SetLastError(0) };
        let window = unsafe { FindWindowExW(null_mut(), previous, class.as_ptr(), name.as_ptr()) };
        if window.is_null() {
            return if unsafe { GetLastError() } == 0 {
                Ok(None)
            } else {
                Err(win_error("FIND_TARGET"))
            };
        }
        previous = window;
        let mut pid = 0;
        if unsafe { GetWindowThreadProcessId(window, &mut pid) } == 0 {
            return Err(win_error("TARGET_PID"));
        }
        if pid == excluded_pid {
            continue;
        }
        unsafe {
            SetLastError(0);
            let extra = GetClassLongW(window, GCL_CBWNDEXTRA);
            if GetLastError() != 0 {
                return Err(win_error("TARGET_CLASS"));
            }
            // 新 target 的 slot 0 未置位时仍在选举；不能转给另一个 follower，旧插件没有 extra。
            if extra >= 4 {
                SetLastError(0);
                let owner = GetWindowLongW(window, 0);
                if GetLastError() != 0 {
                    return Err(win_error("TARGET_OWNER"));
                }
                if owner != 1 {
                    continue;
                }
            }
        }
        return Ok(Some(window));
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

fn win_error(operation: &str) -> String {
    format!(
        "SINGLE_INSTANCE_{operation}_FAILED: {}",
        std::io::Error::last_os_error()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_utf8_payload_preserves_cli_arguments_and_rejects_malformed_data() {
        assert_eq!(
            Request::parse("C:\\工作|app.exe|--cli||dsh://open\0".as_bytes()),
            Some(Request {
                cwd: "C:\\工作".into(),
                args: vec![
                    "app.exe".into(),
                    "--cli".into(),
                    "".into(),
                    "dsh://open".into()
                ],
            })
        );
        for bytes in [
            b"cwd|app".as_slice(),
            b"cwd\0",
            b"cwd|app\0extra\0",
            b"cwd|\xff\0",
        ] {
            assert_eq!(Request::parse(bytes), None);
        }
    }

    #[test]
    fn real_copydata_queues_before_attach_and_target_is_released() {
        let identifier = format!(
            "single-instance-check-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let mut target = Target::start(&identifier).unwrap();
        let mut title = [0u16; 256];
        let length = unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::GetWindowTextW(
                target.hwnd as _,
                title.as_mut_ptr(),
                title.len() as i32,
            )
        };
        assert_eq!(
            String::from_utf16(&title[..length as usize]).unwrap(),
            format!("{identifier}-siw")
        );
        let class = wide(&format!("{identifier}-sic"));
        let name = wide(&format!("{identifier}-siw"));
        assert_eq!(
            unsafe {
                windows_sys::Win32::UI::WindowsAndMessaging::FindWindowW(
                    class.as_ptr(),
                    name.as_ptr(),
                )
            },
            target.hwnd as HWND
        );
        assert!(find_owner(&identifier, 0).unwrap().is_none());
        unsafe { SetWindowLongW(target.hwnd as _, 0, 1) };
        assert_eq!(
            find_owner(&identifier, 0).unwrap(),
            Some(target.hwnd as HWND)
        );
        assert!(find_owner(&identifier, std::process::id())
            .unwrap()
            .is_none());
        Request {
            cwd: "C:\\独立测试".into(),
            args: vec!["app.exe".into(), "dsh://open".into()],
        }
        .send(target.hwnd as _)
        .unwrap();
        assert_eq!(
            target.inbox.lock().unwrap().pending,
            vec![Request {
                cwd: "C:\\独立测试".into(),
                args: vec!["app.exe".into(), "dsh://open".into()],
            }]
        );
        target.stop().unwrap();
        assert!(
            unsafe { FindWindowExW(null_mut(), null_mut(), class.as_ptr(), name.as_ptr()) }
                .is_null()
        );
        Target::start(&identifier).unwrap().stop().unwrap();
    }

    #[test]
    fn worker_lease_keeps_real_mutex_and_target_until_completion() {
        use windows_sys::Win32::UI::WindowsAndMessaging::FindWindowW;

        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<SingleInstance>();

        let identifier = format!(
            "single-instance-lease-check-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let main_lease = Arc::new(
            claim(&identifier)
                .unwrap()
                .expect("independent identifier must be owner"),
        );
        let hwnd = main_lease.target.hwnd as HWND;
        let worker_lease = Arc::clone(&main_lease);
        let (release, waiting) = mpsc::channel::<()>();
        let worker = thread::spawn(move || {
            let _single_instance = worker_lease;
            waiting.recv().expect("release the worker lease");
        });
        drop(main_lease);

        let mutex_name = wide(&format!("{identifier}-sim"));
        let class = wide(&format!("{identifier}-sic"));
        let name = wide(&format!("{identifier}-siw"));
        {
            let raw = unsafe { CreateMutexW(null(), 0, mutex_name.as_ptr()) };
            let error = unsafe { GetLastError() };
            assert!(
                !raw.is_null(),
                "{}",
                std::io::Error::from_raw_os_error(error as i32)
            );
            let _probe = unsafe { OwnedHandle::from_raw_handle(raw) };
            assert_eq!(error, ERROR_ALREADY_EXISTS);
            assert_eq!(unsafe { FindWindowW(class.as_ptr(), name.as_ptr()) }, hwnd);
            assert_eq!(find_owner(&identifier, 0).unwrap(), Some(hwnd));
        }

        release.send(()).unwrap();
        worker.join().unwrap();
        let raw = unsafe { CreateMutexW(null(), 0, mutex_name.as_ptr()) };
        let error = unsafe { GetLastError() };
        assert!(
            !raw.is_null(),
            "{}",
            std::io::Error::from_raw_os_error(error as i32)
        );
        let _probe = unsafe { OwnedHandle::from_raw_handle(raw) };
        assert_eq!(error, 0, "the worker must release the last mutex handle");
        assert!(unsafe { FindWindowW(class.as_ptr(), name.as_ptr()) }.is_null());
    }
}
