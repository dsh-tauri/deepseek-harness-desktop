//! 窗口几何持久化：记住窗口大小、位置与最大化状态，重启后恢复。
//!
//! 本 crate 是 tauri-plugin-window-state 2.5.1 的 vendored 副本（issue #1383）。
//! 与上游的差异只有四处，都是本项目在 Electron 运行时下的硬约束：
//!
//! - 记录里补上 scale_factor 与 size_is_inner：物理像素跨缩放显示器不等价，恢复前必须按
//!   目标显示器换算，旧记录（缺字段）按外框尺寸迁移；
//! - 恢复改成「尺寸与位置解耦」：尺寸抬到最小尺寸并夹进屏幕并集，位置压在屏幕上则夹紧、
//!   离屏则主屏居中（issue #464、#1360）；
//! - 移动/缩放事件只写内存缓存，磁盘只在退出时写一次，事件路径不查窗口几何——在 Electron
//!   运行时里每次窗口几何查询都是一次同步 IPC，拖动时每秒数百次会把主线程拖死（issue #1380）；
//! - 可一次性把旧版 store 里的 window_state 记录迁移成本插件状态文件（issue #1383）。

#![cfg(not(any(target_os = "android", target_os = "ios")))]

use bitflags::bitflags;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs::create_dir_all,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow, Window,
    WindowEvent,
    plugin::{Builder as PluginBuilder, TauriPlugin},
};

mod cmd;
mod geometry;

use geometry::{
    ScreenRect, migrate_legacy_outer_size, rescale_to_current, resolve_geometry_in, target_scale,
};

type LabelMapperFn = dyn Fn(&str) -> &str + Send + Sync;
type FilterCallbackFn = dyn Fn(&str) -> bool + Send + Sync;

/// 默认状态文件名。
///
/// 需要自定义文件名时用 AppHandleExt::filename 取实际值。
pub const DEFAULT_FILENAME: &str = ".window-state.json";

/// 本插件可失败操作的错误类型。
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// 读写状态文件失败。
    #[error(transparent)]
    Io(#[from] std::io::Error),
    /// 调用 Tauri（解析应用目录、操作窗口等）失败。
    #[error(transparent)]
    Tauri(#[from] tauri::Error),
    /// 状态文件序列化/反序列化失败。
    #[error(transparent)]
    SerdeJson(#[from] serde_json::Error),
}

/// 带本插件错误类型的 Result 别名。
pub type Result<T> = std::result::Result<T, Error>;

bitflags! {
    /// 控制保存与恢复哪些窗口状态的标志位，用按位或组合。
    #[derive(Clone, Copy, Debug)]
    pub struct StateFlags: u32 {
        /// 窗口尺寸。
        const SIZE        = 1 << 0;
        /// 窗口位置。
        const POSITION    = 1 << 1;
        /// 是否最大化。
        const MAXIMIZED   = 1 << 2;
        /// 是否可见。
        const VISIBLE     = 1 << 3;
        /// 是否有装饰边框。
        const DECORATIONS = 1 << 4;
        /// 是否全屏。
        const FULLSCREEN  = 1 << 5;
    }
}

impl Default for StateFlags {
    fn default() -> Self {
        Self::all()
    }
}

/// 一次性迁移来源：旧版把窗口几何写在应用 store 文件的某个键里。
struct LegacyStore {
    file: String,
    key: String,
    label: String,
}

struct PluginState {
    pub(crate) state_flags: StateFlags,
    filename: String,
    map_label: Option<Box<LabelMapperFn>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct WindowState {
    #[serde(default)]
    width: u32,
    #[serde(default)]
    height: u32,
    #[serde(default)]
    x: Option<i32>,
    #[serde(default)]
    y: Option<i32>,
    /// 最大化之前的位置：最大化会把 x/y 改写成显示器角落
    #[serde(default)]
    prev_x: Option<i32>,
    #[serde(default)]
    prev_y: Option<i32>,
    #[serde(default)]
    maximized: bool,
    #[serde(default = "visible_by_default")]
    visible: bool,
    #[serde(default = "decorated_by_default")]
    decorated: bool,
    #[serde(default)]
    fullscreen: bool,
    /// 尺寸是否为内容区尺寸。
    ///
    /// 缺字段时取 false（旧记录按外框尺寸迁移），因此这里必须是字段级默认值：容器级
    /// serde(default) 会用 WindowState::default 填，那样缺字段会变成 true，历史记录
    /// 的外框尺寸就被当成内容区尺寸直接用，窗口每次恢复都小一圈。
    #[serde(default)]
    size_is_inner: bool,
    /// 采样时的显示器缩放；旧记录缺少此字段时为 0，表示未知、不换算
    #[serde(default)]
    scale_factor: f64,
}

fn visible_by_default() -> bool {
    true
}

fn decorated_by_default() -> bool {
    true
}

impl Default for WindowState {
    fn default() -> Self {
        Self {
            width: Default::default(),
            height: Default::default(),
            x: Default::default(),
            y: Default::default(),
            prev_x: Default::default(),
            prev_y: Default::default(),
            maximized: Default::default(),
            visible: true,
            decorated: true,
            fullscreen: Default::default(),
            size_is_inner: true,
            scale_factor: Default::default(),
        }
    }
}

struct WindowStateCache(Arc<Mutex<HashMap<String, WindowState>>>);

/// 启动期「几何恢复窗口」门闩：置位期间的一切几何记录都不进缓存。
///
/// 窗口是程序化创建的：在恢复上次几何之前，平台已经先按建窗默认值建好窗口并派发
/// Moved/Resized。这些瞬态几何一旦进缓存，退出时窗口不可采样（隐藏/全屏）就会把它们当成
/// 用户保存值写盘，用户保存的尺寸被覆盖成默认值（issue #464）。这里按恢复窗口期统一
/// 门控，而不是依赖各平台各自的建窗时序。
static RESTORING_GEOMETRY: AtomicBool = AtomicBool::new(false);

/// 启动几何恢复窗口的 RAII 守卫：begin 进入，drop 退出。
///
/// 用守卫而不是裸置位/清零：建窗中途返回错误等异常路径也会正常释放，不会把几何记录永久
/// 关掉（那会导致再也不记住窗口大小）。允许嵌套，drop 时恢复进入前的状态。
pub struct GeometryRestoreGuard {
    previous: bool,
}

impl GeometryRestoreGuard {
    /// 进入恢复窗口；必须在创建窗口之前调用。
    pub fn begin() -> Self {
        Self {
            previous: RESTORING_GEOMETRY.swap(true, Ordering::SeqCst),
        }
    }
}

impl Drop for GeometryRestoreGuard {
    fn drop(&mut self) {
        RESTORING_GEOMETRY.store(self.previous, Ordering::SeqCst);
    }
}

fn is_restoring_geometry() -> bool {
    RESTORING_GEOMETRY.load(Ordering::SeqCst)
}

/// AppHandle 的窗口状态扩展。
pub trait AppHandleExt {
    /// 把所有被跟踪窗口的当前状态写入磁盘
    fn save_window_state(&self, flags: StateFlags) -> Result<()>;
    /// 状态文件名
    fn filename(&self) -> String;
}

impl<R: Runtime> AppHandleExt for tauri::AppHandle<R> {
    fn save_window_state(&self, flags: StateFlags) -> Result<()> {
        let app_dir = self.path().app_config_dir()?;
        let plugin_state = self.state::<PluginState>();
        let state_path = app_dir.join(&plugin_state.filename);
        let windows = self.webview_windows();
        let cache = self.state::<WindowStateCache>();
        let mut state = cache.0.lock().unwrap();

        for (label, s) in state.iter_mut() {
            let window = if let Some(map) = &plugin_state.map_label {
                windows
                    .iter()
                    .find_map(|(l, window)| (map(l) == label.as_str()).then_some(window))
            } else {
                windows.get(label)
            };

            let Some(window) = window else { continue };

            if window.is_fullscreen().unwrap_or(false) {
                continue;
            }

            // 采样失败（窗口已销毁或 IPC 异常）不清空缓存：内存里的几何仍是退出前最后
            // 一次真实事件，丢掉它等于把用户的移动/缩放白记一场。
            if let Err(error) = window.update_state(s, flags) {
                log::warn!("window state sample skipped for {label}: {error}");
            }
        }

        create_dir_all(app_dir)?;
        std::fs::write(state_path, serde_json::to_vec_pretty(&*state)?)?;

        Ok(())
    }

    fn filename(&self) -> String {
        self.state::<PluginState>().filename.clone()
    }
}

/// Window 与 WebviewWindow 的窗口状态扩展。
pub trait WindowExt {
    /// 从状态文件恢复本窗口的几何
    fn restore_state(&self, flags: StateFlags) -> tauri::Result<()>;
}

impl<R: Runtime> WindowExt for WebviewWindow<R> {
    fn restore_state(&self, flags: StateFlags) -> tauri::Result<()> {
        self.as_ref().window().restore_state(flags)
    }
}

impl<R: Runtime> WindowExt for Window<R> {
    fn restore_state(&self, flags: StateFlags) -> tauri::Result<()> {
        let _restoring = GeometryRestoreGuard::begin();

        let plugin_state = self.app_handle().state::<PluginState>();
        let label = plugin_state
            .map_label
            .as_ref()
            .map(|map| map(self.label()))
            .unwrap_or_else(|| self.label());

        let cache = self.state::<WindowStateCache>();
        let saved = {
            let c = cache.0.lock().unwrap();
            c.get(label)
                .filter(|state| state != &&WindowState::default())
                .cloned()
        };

        let Some(saved) = saved else {
            let mut metadata = WindowState::default();

            if flags.contains(StateFlags::SIZE) {
                let size = restorable_size(self)?;
                metadata.width = size.width;
                metadata.height = size.height;
                metadata.size_is_inner = true;
            }

            if flags.contains(StateFlags::POSITION) {
                let pos = self.outer_position()?;
                metadata.x = Some(pos.x);
                metadata.y = Some(pos.y);
            }

            if flags.contains(StateFlags::MAXIMIZED) {
                metadata.maximized = self.is_maximized()?;
            }

            if flags.contains(StateFlags::VISIBLE) {
                metadata.visible = self.is_visible()?;
            }

            if flags.contains(StateFlags::DECORATIONS) {
                metadata.decorated = self.is_decorated()?;
            }

            if flags.contains(StateFlags::FULLSCREEN) {
                metadata.fullscreen = self.is_fullscreen()?;
            }

            metadata.scale_factor = self
                .scale_factor()
                .ok()
                .filter(|scale| scale.is_finite() && *scale > 0.0)
                .unwrap_or(0.0);

            cache.0.lock().unwrap().insert(label.into(), metadata);
            return Ok(());
        };

        let mut state = saved;
        if !state.size_is_inner
            && let (Ok(outer), Ok(inner)) = (self.outer_size(), self.inner_size())
        {
            state = migrate_legacy_outer_size(&state, outer, inner);
        }

        let screens = screens_of(self.app_handle());
        let primary = primary_screen(self.app_handle());
        state = rescale_to_current(&state, target_scale(&state, &screens, primary));

        if let Some(geometry) = resolve_geometry_in(&state, &screens, primary) {
            if flags.contains(StateFlags::SIZE) {
                self.set_size(tauri::Size::Physical(geometry.size))?;
            }
            if flags.contains(StateFlags::POSITION)
                && let Some(position) = geometry.position
            {
                self.set_position(tauri::Position::Physical(position))?;
            }
        }

        if flags.contains(StateFlags::DECORATIONS) {
            self.set_decorations(state.decorated)?;
        }

        if flags.contains(StateFlags::MAXIMIZED) && state.maximized {
            self.maximize()?;
        }

        if flags.contains(StateFlags::FULLSCREEN) {
            self.set_fullscreen(state.fullscreen)?;
        }

        if let Some(entry) = cache.0.lock().unwrap().get_mut(label) {
            *entry = state.clone();
        }

        if flags.contains(StateFlags::VISIBLE) && state.visible {
            self.show()?;
            self.set_focus()?;
        }

        Ok(())
    }
}

/// set_size 要用的尺寸：macOS 上是内容区高度，非 macOS 就是 inner_size。
///
/// set_size 设的是内容区尺寸，而在 macOS 上 inner_size 报告的是 webview 边界（标题栏覆盖
/// 在内容上时包含标题栏），照它保存会让窗口每次恢复都长高一个标题栏。
fn restorable_size<R: Runtime>(window: &Window<R>) -> tauri::Result<PhysicalSize<u32>> {
    #[cfg(target_os = "macos")]
    {
        let outer = window.outer_size()?;
        let title_bar = window.inner_position()?.y - window.outer_position()?.y;
        Ok(PhysicalSize::new(
            outer.width,
            outer.height.saturating_sub(title_bar.max(0) as u32),
        ))
    }
    #[cfg(not(target_os = "macos"))]
    window.inner_size()
}

/// 记一帧窗口移动：只写内存缓存，不碰磁盘、不查窗口几何。
///
/// 事件本身已带位置。回头问 outer_position 在 Electron 运行时里是一次同步 IPC，而拖动时
/// 每秒有数百个 move（issue #1380）。
fn record_moved(state: &mut WindowState, position: PhysicalPosition<i32>) {
    if is_restoring_geometry() {
        return;
    }
    state.prev_x = state.x;
    state.prev_y = state.y;
    state.x = Some(position.x);
    state.y = Some(position.y);
}

/// 记一帧窗口缩放：只写内存缓存。
///
/// 全屏与最大化都会派发 Resized，而这些尺寸不是可恢复的普通窗口几何。丢样本是为了
/// 让缓存留住最后一次普通尺寸：退出时 `update_state` 在最大化状态下同样跳过尺寸采样，
/// 缓存里若已被最大化尺寸覆盖，取消最大化后窗口就再也回不到原来的大小。
fn record_resized<R: Runtime>(
    window: &Window<R>,
    state: &mut WindowState,
    size: PhysicalSize<u32>,
) {
    if window.is_fullscreen().unwrap_or(false) || window.is_maximized().unwrap_or(false) {
        return;
    }
    apply_resized(state, size, window.scale_factor().ok());
}

/// 把一帧缩放写进状态：尺寸与它自己的缩放因子必须成对更新。
///
/// 缩放因子采样无效（窗口已关闭、IPC 异常）时保留旧值，否则同一份物理尺寸会失去量纲，
/// 下次跨屏恢复就换算错。
fn apply_resized(state: &mut WindowState, size: PhysicalSize<u32>, scale: Option<f64>) {
    if is_restoring_geometry() {
        return;
    }
    state.width = size.width;
    state.height = size.height;
    state.size_is_inner = true;
    state.scale_factor = scale
        .filter(|scale| scale.is_finite() && *scale > 0.0)
        .unwrap_or(state.scale_factor);
}

trait WindowExtInternal {
    fn update_state(&self, state: &mut WindowState, flags: StateFlags) -> tauri::Result<()>;
}

impl<R: Runtime> WindowExtInternal for WebviewWindow<R> {
    fn update_state(&self, state: &mut WindowState, flags: StateFlags) -> tauri::Result<()> {
        self.as_ref().window().update_state(state, flags)
    }
}

impl<R: Runtime> WindowExtInternal for Window<R> {
    fn update_state(&self, state: &mut WindowState, flags: StateFlags) -> tauri::Result<()> {
        if is_restoring_geometry() {
            return Ok(());
        }

        let is_maximized = flags
            .intersects(StateFlags::MAXIMIZED | StateFlags::POSITION | StateFlags::SIZE)
            && self.is_maximized()?;
        let is_minimized =
            flags.intersects(StateFlags::POSITION | StateFlags::SIZE) && self.is_minimized()?;

        if flags.contains(StateFlags::MAXIMIZED) {
            state.maximized = is_maximized;
        }

        if flags.contains(StateFlags::FULLSCREEN) {
            state.fullscreen = self.is_fullscreen()?;
        }

        if flags.contains(StateFlags::DECORATIONS) {
            state.decorated = self.is_decorated()?;
        }

        let visible = self.is_visible()?;

        if flags.contains(StateFlags::VISIBLE) {
            state.visible = visible;
        }

        if flags.contains(StateFlags::SIZE) && !is_maximized && !is_minimized && visible {
            let size = restorable_size(self)?;
            if size.width > 0 && size.height > 0 {
                apply_resized(state, size, self.scale_factor().ok());
            }
        }

        if flags.contains(StateFlags::POSITION) && !is_maximized && !is_minimized && visible {
            let position = self.outer_position()?;
            state.x = Some(position.x);
            state.y = Some(position.y);
        }

        Ok(())
    }
}

/// 窗口状态插件的构建器。
#[derive(Default)]
pub struct Builder {
    denylist: HashSet<String>,
    filter_callback: Option<Box<FilterCallbackFn>>,
    skip_initial_state: HashSet<String>,
    state_flags: StateFlags,
    map_label: Option<Box<LabelMapperFn>>,
    filename: Option<String>,
    legacy_store: Option<LegacyStore>,
}

impl Builder {
    /// 默认配置：启用全部 StateFlags、无黑白名单、使用 DEFAULT_FILENAME。
    pub fn new() -> Self {
        Self::default()
    }

    /// 设置需要保存与恢复的状态位。
    pub fn with_state_flags(mut self, flags: StateFlags) -> Self {
        self.state_flags = flags;
        self
    }

    /// 设置自定义状态文件名。
    pub fn with_filename(mut self, filename: impl Into<String>) -> Self {
        self.filename.replace(filename.into());
        self
    }

    /// 设置不跟踪的窗口（例如 splash）。
    pub fn with_denylist(mut self, denylist: &[&str]) -> Self {
        self.denylist = denylist.iter().map(|l| l.to_string()).collect();
        self
    }

    /// 设置跟踪过滤器：返回 true 才保存该窗口状态。
    pub fn with_filter<F>(mut self, filter_callback: F) -> Self
    where
        F: Fn(&str) -> bool + Send + Sync + 'static,
    {
        self.filter_callback = Some(Box::new(filter_callback));
        self
    }

    /// 跳过指定窗口的自动恢复，交给调用方自行选择合适的时机恢复。
    pub fn skip_initial_state(mut self, label: &str) -> Self {
        self.skip_initial_state.insert(label.into());
        self
    }

    /// 变换窗口标签，用于让多个窗口共用同一份状态。
    pub fn map_label<F>(mut self, map_fn: F) -> Self
    where
        F: Fn(&str) -> &str + Sync + Send + 'static,
    {
        self.map_label = Some(Box::new(map_fn));
        self
    }

    /// 一次性把旧版 store 里的窗口几何迁移到本插件的状态文件（issue #1383）。
    ///
    /// file 是应用 store 文件名（相对 app data 目录），key 是记录键，label 是迁移后归属
    /// 的窗口标签。只在状态文件尚不存在时执行一次；成功写入后删除 store 里的旧键。
    pub fn with_legacy_store(
        mut self,
        file: impl Into<String>,
        key: impl Into<String>,
        label: impl Into<String>,
    ) -> Self {
        self.legacy_store = Some(LegacyStore {
            file: file.into(),
            key: key.into(),
            label: label.into(),
        });
        self
    }

    /// 构建插件。
    ///
    /// 初始化时加载状态文件并尝试迁移旧记录；窗口就绪时按配置恢复状态（可用
    /// skip_initial_state 关掉）；移动/缩放事件只更新内存缓存；退出时由调用方通过
    /// AppHandleExt::save_window_state 落盘。
    pub fn build<R: Runtime>(self) -> TauriPlugin<R> {
        let Builder {
            denylist,
            filter_callback,
            skip_initial_state,
            state_flags,
            map_label,
            filename,
            legacy_store,
        } = self;
        let filename = filename.unwrap_or_else(|| DEFAULT_FILENAME.into());

        PluginBuilder::new("window-state")
            .invoke_handler(tauri::generate_handler![
                cmd::save_window_state,
                cmd::restore_state,
                cmd::filename
            ])
            .setup(move |app, _api| {
                let app_dir = app.path().app_config_dir()?;
                if let Some(legacy) = &legacy_store
                    && let Err(error) = migrate_legacy_store(app, legacy, &app_dir, &filename)
                {
                    log::warn!("window state migration skipped: {error}");
                }
                let cache = load_saved_window_states(&app_dir, &filename).unwrap_or_else(|error| {
                    log::debug!("window state file not loaded: {error}");
                    Default::default()
                });
                app.manage(WindowStateCache(Arc::new(Mutex::new(cache))));
                app.manage(PluginState {
                    state_flags,
                    filename,
                    map_label,
                });
                Ok(())
            })
            .on_window_ready(move |window| {
                let plugin_state = window.app_handle().state::<PluginState>();
                let label = plugin_state
                    .map_label
                    .as_ref()
                    .map(|map| map(window.label()))
                    .unwrap_or_else(|| window.label());

                if denylist.contains(label) {
                    return;
                }

                if let Some(filter_callback) = &filter_callback
                    && !filter_callback(label)
                {
                    return;
                }

                if !skip_initial_state.contains(label) {
                    let _ = window.restore_state(state_flags);
                }

                let cache = window.state::<WindowStateCache>();
                let cache = cache.0.clone();
                let label = label.to_string();
                let window_clone = window.clone();

                {
                    cache
                        .lock()
                        .unwrap()
                        .entry(label.clone())
                        .or_insert_with(WindowState::default);
                }

                window.on_window_event(move |e| match e {
                    WindowEvent::Moved(position) if state_flags.contains(StateFlags::POSITION) => {
                        let mut c = cache.lock().unwrap();
                        if let Some(state) = c.get_mut(&label) {
                            record_moved(state, *position);
                        }
                    }
                    WindowEvent::Resized(size) if state_flags.contains(StateFlags::SIZE) => {
                        let mut c = cache.lock().unwrap();
                        if let Some(state) = c.get_mut(&label) {
                            record_resized(&window_clone, state, *size);
                        }
                    }
                    _ => {}
                });
            })
            .build()
    }
}

fn load_saved_window_states(
    app_dir: &Path,
    filename: &str,
) -> Result<HashMap<String, WindowState>> {
    let file = std::fs::File::open(app_dir.join(filename))?;
    let reader = std::io::BufReader::new(file);
    Ok(serde_json::from_reader(reader)?)
}

/// 取出旧版记录，反序列化成本插件的记录。
///
/// 旧记录只有 maximized、x/y、width/height、size_is_inner、scale_factor，其余字段由 serde
/// 默认值补齐；x/y 为 null 表示没有位置记录。取走即删除，迁移成功后旧键不再保留。
fn take_legacy_record(store: &mut serde_json::Value, key: &str) -> Option<WindowState> {
    let record = store.as_object_mut()?.remove(key)?;
    serde_json::from_value(record).ok()
}

/// 把旧版 store 记录迁移成插件的状态文件，成功后删掉 store 里的旧键。
///
/// 只在状态文件不存在时执行一次：文件存在说明已经迁移过（或有更新的记录），不再覆盖。
fn migrate_legacy_store<R: Runtime>(
    app: &AppHandle<R>,
    legacy: &LegacyStore,
    app_dir: &Path,
    filename: &str,
) -> Result<()> {
    let state_path = app_dir.join(filename);
    if state_path.exists() {
        return Ok(());
    }

    let store_path = app.path().app_data_dir()?.join(&legacy.file);
    if !store_path.exists() {
        return Ok(());
    }
    let mut store: serde_json::Value = serde_json::from_slice(&std::fs::read(&store_path)?)?;
    let Some(state) = take_legacy_record(&mut store, &legacy.key) else {
        return Ok(());
    };

    let mut states = HashMap::new();
    states.insert(legacy.label.clone(), state);

    create_dir_all(app_dir)?;
    std::fs::write(&state_path, serde_json::to_vec_pretty(&states)?)?;
    std::fs::write(store_path, serde_json::to_vec_pretty(&store)?)?;

    Ok(())
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
                    scale_factor: monitor.scale_factor(),
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
        scale_factor: monitor.scale_factor(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::MutexGuard;

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn lock() -> MutexGuard<'static, ()> {
        TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn state_at(x: i32, y: i32, width: u32, height: u32, scale: f64) -> WindowState {
        WindowState {
            width,
            height,
            x: Some(x),
            y: Some(y),
            scale_factor: scale,
            ..WindowState::default()
        }
    }

    #[test]
    fn legacy_record_without_scale_is_unknown_scale() {
        let json =
            r#"{"maximized":true,"x":120,"y":80,"width":1137,"height":792,"size_is_inner":true}"#;
        let state: WindowState = serde_json::from_str(json).unwrap();
        assert!(state.maximized);
        assert_eq!(state.x, Some(120));
        assert_eq!(state.y, Some(80));
        assert_eq!(state.width, 1137);
        assert_eq!(state.height, 792);
        assert_eq!(state.scale_factor, 0.0);
        assert!(state.size_is_inner);
    }

    #[test]
    fn record_without_size_kind_is_treated_as_outer_size() {
        // 缺 size_is_inner 的历史记录一律按外框尺寸迁移：serde 对缺失字段取 bool 的默认值
        // false，不能依赖 WindowState::default 里的 true。
        let state: WindowState = serde_json::from_str(r#"{"width":1137,"height":792}"#).unwrap();
        assert!(!state.size_is_inner);
        assert_eq!(state.scale_factor, 0.0);
        assert!(!state.maximized);
    }

    #[test]
    fn empty_object_parses_to_zero_size() {
        let state: WindowState = serde_json::from_str("{}").unwrap();
        assert_eq!(state.width, 0);
        assert_eq!(state.height, 0);
        assert_eq!(state.x, None);
        assert_eq!(state.y, None);
    }

    #[test]
    fn state_roundtrips_through_json() {
        let state = WindowState {
            maximized: true,
            scale_factor: 1.5,
            prev_x: Some(10),
            prev_y: Some(20),
            ..state_at(30, 40, 1280, 840, 1.5)
        };
        let json = serde_json::to_string(&state).unwrap();
        assert_eq!(serde_json::from_str::<WindowState>(&json).unwrap(), state);
    }

    #[test]
    fn null_position_means_no_saved_position() {
        let state: WindowState =
            serde_json::from_str(r#"{"width":1280,"height":840,"x":null,"y":null}"#).unwrap();
        assert_eq!(state.x, None);
        assert_eq!(state.y, None);
    }

    #[test]
    fn moved_event_only_touches_memory() {
        let _guard = lock();
        let mut state = state_at(100, 200, 1280, 840, 1.25);
        record_moved(&mut state, PhysicalPosition::new(300, 400));
        assert_eq!(state.x, Some(300));
        assert_eq!(state.y, Some(400));
        assert_eq!(state.prev_x, Some(100));
        assert_eq!(state.prev_y, Some(200));
        assert_eq!(state.width, 1280);
        assert_eq!(state.height, 840);
    }

    #[test]
    fn second_move_shifts_previous_position() {
        let _guard = lock();
        let mut state = state_at(100, 200, 1280, 840, 1.0);
        record_moved(&mut state, PhysicalPosition::new(300, 400));
        record_moved(&mut state, PhysicalPosition::new(500, 600));
        assert_eq!(state.prev_x, Some(300));
        assert_eq!(state.prev_y, Some(400));
        assert_eq!(state.x, Some(500));
        assert_eq!(state.y, Some(600));
    }

    #[test]
    fn resized_event_pairs_size_with_its_own_scale() {
        let _guard = lock();
        let mut state = state_at(0, 0, 1280, 840, 1.0);
        apply_resized(&mut state, PhysicalSize::new(1920, 1080), Some(1.25));
        assert_eq!(state.width, 1920);
        assert_eq!(state.height, 1080);
        assert_eq!(state.scale_factor, 1.25);
        assert!(state.size_is_inner);
    }

    #[test]
    fn resized_event_keeps_scale_when_sample_is_invalid() {
        let _guard = lock();
        let mut state = state_at(0, 0, 1280, 840, 1.5);
        apply_resized(&mut state, PhysicalSize::new(1600, 900), Some(0.0));
        assert_eq!(state.scale_factor, 1.5);
        apply_resized(&mut state, PhysicalSize::new(1600, 900), Some(f64::NAN));
        assert_eq!(state.scale_factor, 1.5);
        apply_resized(&mut state, PhysicalSize::new(1600, 900), None);
        assert_eq!(state.scale_factor, 1.5);
        assert_eq!(state.width, 1600);
    }

    #[test]
    fn restore_guard_gates_geometry_records() {
        let _guard = lock();
        let mut state = state_at(100, 200, 1280, 840, 1.0);
        {
            let _restoring = GeometryRestoreGuard::begin();
            record_moved(&mut state, PhysicalPosition::new(900, 900));
            apply_resized(&mut state, PhysicalSize::new(640, 480), Some(2.0));
            assert_eq!(state.x, Some(100));
            assert_eq!(state.y, Some(200));
            assert_eq!(state.width, 1280);
            assert_eq!(state.height, 840);
        }
        record_moved(&mut state, PhysicalPosition::new(300, 400));
        apply_resized(&mut state, PhysicalSize::new(1600, 900), Some(1.0));
        assert_eq!(state.x, Some(300));
        assert_eq!(state.width, 1600);
    }

    #[test]
    fn restore_guard_nests() {
        let _guard = lock();
        let outer = GeometryRestoreGuard::begin();
        {
            let _inner = GeometryRestoreGuard::begin();
        }
        assert!(is_restoring_geometry());
        drop(outer);
        assert!(!is_restoring_geometry());
    }

    #[test]
    fn legacy_record_is_taken_out_of_store() {
        let mut store = serde_json::json!({
            "setting": {"theme": "dark"},
            "window_state": {"x": 10, "y": 20, "width": 1137, "height": 792},
        });

        let state = take_legacy_record(&mut store, "window_state").expect("migrated");

        assert_eq!(state.x, Some(10));
        assert_eq!(state.width, 1137);
        assert!(!state.size_is_inner);
        assert!(store.get("window_state").is_none());
        assert_eq!(store["setting"]["theme"], serde_json::json!("dark"));
    }

    #[test]
    fn store_without_legacy_key_yields_nothing() {
        let mut store = serde_json::json!({"setting": {"theme": "dark"}});
        assert!(take_legacy_record(&mut store, "window_state").is_none());
        assert!(store.get("setting").is_some());
    }

    #[test]
    fn malformed_legacy_record_is_ignored() {
        let mut store = serde_json::json!({"window_state": "not an object"});
        assert!(take_legacy_record(&mut store, "window_state").is_none());
    }

    #[test]
    fn non_object_store_yields_nothing() {
        let mut store = serde_json::json!([1, 2, 3]);
        assert!(take_legacy_record(&mut store, "window_state").is_none());
    }

    #[test]
    fn migrated_state_file_keeps_label_mapping() {
        let state: WindowState =
            serde_json::from_str(r#"{"x":10,"y":20,"width":1137,"height":792}"#)
                .expect("legacy record parses");
        let mut states = HashMap::new();
        states.insert("main".to_string(), state);
        let encoded = serde_json::to_string(&states).unwrap();
        let decoded: HashMap<String, WindowState> = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded["main"].width, 1137);
        assert!(!decoded["main"].size_is_inner);
    }
}
