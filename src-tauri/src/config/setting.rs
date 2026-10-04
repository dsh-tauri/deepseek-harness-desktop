use super::constants::*;
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_store::StoreExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct Setting {
    #[serde(default)]
    pub proxy_url: String,
    #[serde(default)]
    pub appearance: super::Appearance,
    pub installed: bool,
    pub port: u16,
    #[serde(default)]
    pub harness_max_heap_mb: Option<u32>,
    pub auto_start: bool,
    pub language: String,
    #[serde(default)]
    pub dsh_pkg_commit: Option<String>,
    /// 已安装 Harness 发行版对应的 GitHub release tag（与 dsh_pkg_commit 配套，
    /// 用于甄别“记录滞后于文件”与“同版本热修”两种不一致）
    #[serde(default)]
    pub dsh_pkg_tag: Option<String>,
    /// 命令行集成开关：安装后在用户 PATH 中注册 `dsh` 命令
    #[serde(default = "default_cli_link_enabled")]
    pub cli_link_enabled: bool,
    /// 预装插件引导是否已完成（确认安装或跳过都算完成，之后不再弹出）
    #[serde(default)]
    pub preinstall_done: bool,
    /// 上次引导结束时的清单 `plugins` 节内容指纹。资源清单每次安装都会被
    /// 强制覆盖、旧文件不复存在，只能把「上次看到的内容」记在这里，每次启动再比对：
    /// 内容有变更 → 重新进入预设引导。`None` = 老用户升级（无基线）→ 弹一次建立基线。
    #[serde(default)]
    pub preset_hash: Option<String>,
    /// 当前使用的档案 id（`$DSH_HOME/profiles/<id>`，默认 web）。
    /// 桌面端启动服务与插件管理都以它为准（见 service::profile）。
    /// 老用户 store 里可能仍是旧引导档案名 `desktop`：启动迁移
    /// （`service::profile::migrate_desktop_profile_name`）会把它改指 `tauri`。
    #[serde(default = "default_active_profile")]
    pub active_profile: String,
    /// 首装档案引导是否已完成：桌面端首次安装时自动新建引导档案（`tauri`）并
    /// 切换为当前档案（见 service::profile::migrate_desktop_profile_name），成功
    /// 后置位，之后启动不再重做（一次性幂等标记）。
    #[serde(default)]
    pub desktop_profile_ready: bool,
    /// 活动核心的显式选择：`Some("local")` = 用户 CLI 安装的本地核心，
    /// `Some("app")` = 桌面端预打包核心；`None` = 自动（本地核心存在时优先）。
    #[serde(default)]
    pub active_core: Option<String>,
    /// 用户手动设置的服务端口（设置页「端口」输入，见 bridge::config）。
    /// 自动避让递增（配置端口被占 → 逐级顶高，见 workflow::launch）后，启动时
    /// 该端口空闲则回落回用户选择的值；`None` = 从未手动设置，回落目标为默认
    /// 端口（3080/3081）。避免端口只增不减、一路从 3080 漂到 3084+（issue #91）。
    #[serde(default)]
    pub manual_port: Option<u16>,
    /// 桌面主 WebView 的缩放比例。旧配置缺失时回落到 100%，读取与写入时均会
    /// 归一化到受支持的 50%–200% 范围和 10% 步长。
    #[serde(default = "default_zoom_factor")]
    pub zoom_factor: f64,
    /// 点击窗口关闭按钮时的行为：`tray` = 隐藏到托盘继续驻留，`quit` = 直接退出应用。
    /// 只接受 `tray` / `quit` 两个字面量，读取与写入时均归一化，未知值回落 `tray`；
    /// 字段刻意用 `String` 而非 enum——任一字段反序列化失败会让整个 `Setting` 回落
    /// 默认，严格 enum 的一个意外值会连带清空端口/语言/档案等全部设置。
    #[serde(default = "default_close_action")]
    pub close_action: String,
    /// 保留备份份数（手动备份触发裁剪）。
    #[serde(default = "default_backup_retention_count")]
    pub backup_retention_count: u32,
    /// 备份是否包含凭据文件（`.credentials.yaml`）。
    #[serde(default)]
    pub backup_include_credentials: bool,
    /// 桌宠能力是否永久启用；临时隐藏不能改动此字段。
    #[serde(default)]
    pub pet_enabled: bool,
    /// 当前选中的桌宠模型包（预设 id，或 `chat:` / `codex:` 来源限定 id）；
    /// `None` = 从未选择，对外回落清单里的第一只预设宠物；空串 = 用户显式取消选择。
    #[serde(default)]
    pub active_pet: Option<String>,
    /// 桌宠精灵图的显示宽度（逻辑像素）；`None` = 沿用窗口侧默认值。
    #[serde(default)]
    pub pet_size: Option<f64>,
    /// 强制以 XWayland 运行（默认关闭，下次启动生效）。
    ///
    /// 影响的是整个应用而非只有桌宠：原生 Wayland 下桌宠既不能置顶也不能定位
    /// （issue #649），把应用拉到 XWayland 是在 GNOME 上恢复这两项能力的唯一办法，
    /// 代价是主窗口也一并经 XWayland 渲染。默认关闭，由用户显式开启。
    #[serde(default)]
    pub force_xwayland: bool,
}

pub const ZOOM_FACTOR_MIN: f64 = 0.5;
pub const ZOOM_FACTOR_MAX: f64 = 2.0;
pub const ZOOM_FACTOR_STEP: f64 = 0.1;
pub const HARNESS_HEAP_MIN_MB: u32 = 1024;
pub const HARNESS_HEAP_MAX_MB: u32 = 32768;
pub const CLOSE_ACTION_TRAY: &str = "tray";
pub const CLOSE_ACTION_QUIT: &str = "quit";

pub fn normalize_harness_max_heap_mb(value: Option<u32>) -> Option<u32> {
    value.filter(|mb| (HARNESS_HEAP_MIN_MB..=HARNESS_HEAP_MAX_MB).contains(mb))
}

/// 默认档案：桌面端内置的 web 档案
fn default_active_profile() -> String {
    "web".to_string()
}

/// 命令行集成默认开启（开发者工具场景，安装完成即可用）
fn default_cli_link_enabled() -> bool {
    true
}

/// 界面默认缩放为 100%。
pub fn default_zoom_factor() -> f64 {
    1.0
}

/// 默认关闭行为：隐藏到托盘继续驻留（D-09）。
pub fn default_close_action() -> String {
    CLOSE_ACTION_TRAY.to_string()
}

/// 默认保留备份份数：10 份。
pub fn default_backup_retention_count() -> u32 {
    10
}

/// 把外部或旧存储中的关闭行为收敛到白名单，未知值一律回落到默认行为。
///
/// 只做精确匹配：不做 `trim()`、不做大小写折叠——store 可被手工编辑、旧版本或其它
/// 平台写入，宽松匹配会让 `"quit "` / `"TRAY"` 这类值以非预期形态进入下游判断。
pub fn normalize_close_action(value: &str) -> String {
    match value {
        CLOSE_ACTION_TRAY | CLOSE_ACTION_QUIT => value.to_string(),
        _ => default_close_action(),
    }
}

/// 将外部或旧存储中的缩放值限制到桌面端支持的稳定步长。
pub fn normalize_zoom_factor(value: f64) -> f64 {
    if !value.is_finite() {
        return default_zoom_factor();
    }
    let clamped = value.clamp(ZOOM_FACTOR_MIN, ZOOM_FACTOR_MAX);
    let steps_per_unit = 1.0 / ZOOM_FACTOR_STEP;
    (clamped * steps_per_unit).round() / steps_per_unit
}

/// 归一化保留份数到有效范围 [1, 50]，未知/越界回落默认 10。
pub fn normalize_backup_retention(retention_count: u32) -> u32 {
    if retention_count == 0 || retention_count > 50 {
        default_backup_retention_count()
    } else {
        retention_count
    }
}

fn normalize_setting(setting: &mut Setting) {
    setting.proxy_url = super::proxy::normalize_proxy_url(&setting.proxy_url).unwrap_or_default();
    setting.appearance.normalize();
    setting.zoom_factor = normalize_zoom_factor(setting.zoom_factor);
    setting.harness_max_heap_mb = normalize_harness_max_heap_mb(setting.harness_max_heap_mb);
    setting.close_action = normalize_close_action(&setting.close_action);
    setting.backup_retention_count = normalize_backup_retention(setting.backup_retention_count);
}

/// 默认服务端口：debug 构建与生产隔离，避免开发时与已运行的桌面端争用 3080。
pub fn default_port() -> u16 {
    if cfg!(debug_assertions) {
        DSH_DEV_PORT
    } else {
        DSH_PORT
    }
}

impl Default for Setting {
    fn default() -> Self {
        Self {
            proxy_url: String::new(),
            appearance: super::Appearance::default(),
            installed: false,
            port: default_port(),
            harness_max_heap_mb: None,
            auto_start: true,
            language: "zh-CN".to_string(),
            dsh_pkg_commit: None,
            dsh_pkg_tag: None,
            cli_link_enabled: default_cli_link_enabled(),
            preinstall_done: false,
            preset_hash: None,
            active_profile: default_active_profile(),
            desktop_profile_ready: false,
            active_core: None,
            manual_port: None,
            zoom_factor: default_zoom_factor(),
            close_action: default_close_action(),
            backup_retention_count: default_backup_retention_count(),
            backup_include_credentials: false,
            pet_enabled: false,
            active_pet: None,
            pet_size: None,
            force_xwayland: false,
        }
    }
}

/// 当前是否为 E2E 运行（内嵌 WebDriver server 被请求）。
pub fn is_e2e_run() -> bool {
    std::env::var_os(E2E_PORT_ENV_VAR).is_some_and(|v| !v.is_empty())
}

/// 当前进程应使用的 Store 持久化文件名（生产 / 开发 / E2E 三方隔离的唯一真值）。
///
/// store（端口、installed、active_core、窗口几何等）属于「应用数据」而非共用核心：
/// 生产默认 3080、开发默认 3081，共用一份 store 会让两边端口一路漂移并相互污染状态；
/// E2E 若复用开发文件，用例写入的窗口几何会覆盖用户正在使用的开发版配置。
///
/// 注意 `app_data_dir()` 在 Windows 上由 `SHGetKnownFolderPath` 解析，重定向
/// `APPDATA` 环境变量**无法**把 store 引到 scratch 目录——三方隔离只能靠换文件名。
pub fn store_dat_file_name() -> &'static str {
    resolve_store_dat_file(is_e2e_run(), cfg!(debug_assertions))
}

/// `store_dat_file_name` 的纯函数内核：把「是否 E2E」「是否 debug」映射到文件名。
fn resolve_store_dat_file(e2e: bool, debug: bool) -> &'static str {
    if e2e {
        STORE_DAT_TEST_FILE
    } else if debug {
        STORE_DAT_DEV_FILE
    } else {
        STORE_DAT_FILE
    }
}

/// 启动最早期读取 `force_xwayland`，绕过 `tauri_plugin_store` 直接解析 store 文件。
///
/// `GDK_BACKEND` 必须在 GTK 初始化之前设置，那时 `AppHandle` 尚不存在，插件的
/// `StoreExt` 用不了。路径由 `logger::identifier_dir()` 与 `store_dat_file_name()` 拼出，
/// 与插件的 `BaseDirectory::AppData` + 文件名解析一致，开发 / E2E / 生产三份 store
/// 不互读。store 靠文件名区分 dev，目录不带 `dev/` 一层，与日志的做法不同。
/// 文件缺失、JSON 非法、键缺失一律按关闭处理：此处早于 `logger::init()`，
/// 无处告警，静默回落到默认行为比中断启动合适。
pub fn force_xwayland_setting() -> bool {
    crate::logger::identifier_dir()
        .map(|dir| dir.join(store_dat_file_name()))
        .and_then(|path| std::fs::read_to_string(path).ok())
        .is_some_and(|raw| force_xwayland_in_store_json(&raw))
}

/// `force_xwayland_setting` 的纯函数内核，便于单测覆盖各种损坏输入。
fn force_xwayland_in_store_json(raw: &str) -> bool {
    let Ok(root) = serde_json::from_str::<serde_json::Value>(raw) else {
        return false;
    };
    let Some(value) = root.get(STORE_SETTING_KEY) else {
        return false;
    };
    let object = unwrap_json_value(value);
    object
        .get("force_xwayland")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

fn setting_write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// 首装检测结果（进程内缓存）：`true` = 本次启动时 store 持久化文件尚不存在，
/// 即桌面端首次安装/首次启动（无论是否装过 dsh CLI——后者正是需要隔离的
/// 场景：CLI 侧的大量插件/补丁不应涌入桌面端档案）。
static FIRST_INSTALL: OnceLock<bool> = OnceLock::new();

/// 首装检测：store 持久化文件不存在 → 桌面端首次安装。
///
/// 必须在窗口创建与任何 store 写入之前调用一次（builder setup 最先）：窗口
/// 几何恢复/退出保存都会写 store 并创建文件，判定晚于它们会把首装误判为升级。
/// 判定结果进程内缓存，之后任何时点读取都拿到本次启动的同一结论。
pub fn detect_first_install<R: Runtime>(app_handle: &AppHandle<R>) -> bool {
    *FIRST_INSTALL.get_or_init(|| {
        app_handle
            .path()
            .app_data_dir()
            // 目录解析失败按老用户处理（保守：不做引导，回落 web 档案老行为）
            .map(|dir| !dir.join(store_dat_file_name()).exists())
            .unwrap_or(false)
    })
}

/// 读取首装检测结果；尚未检测（或检测失败）时返回 `false`，保守按老用户处理。
pub fn is_first_install() -> bool {
    FIRST_INSTALL.get().copied().unwrap_or(false)
}

pub(crate) fn unwrap_json_value(
    value: &serde_json::Value,
) -> std::borrow::Cow<'_, serde_json::Value> {
    value
        .as_str()
        .and_then(|text| serde_json::from_str(text).ok())
        .map(std::borrow::Cow::Owned)
        .unwrap_or(std::borrow::Cow::Borrowed(value))
}

fn setting_from_value(value: Option<&serde_json::Value>) -> Setting {
    let mut setting = value
        .and_then(|value| serde_json::from_value(unwrap_json_value(value).into_owned()).ok())
        .unwrap_or_default();
    normalize_setting(&mut setting);
    setting
}

fn read_store_dat_setting<R: Runtime>(app_handle: &AppHandle<R>) -> Setting {
    let store = app_handle
        .store(store_dat_file_name())
        .expect("Failed to load store");
    let raw = store.get(STORE_SETTING_KEY);
    setting_from_value(raw.as_ref())
}

fn write_store_dat_setting(app_handle: &AppHandle, setting: &Setting) -> serde_json::Value {
    let store = app_handle
        .store(store_dat_file_name())
        .expect("Failed to load store");
    let value = serde_json::to_value(setting).unwrap();
    store.set(STORE_SETTING_KEY, value.clone());
    store.save().expect("Failed to save store");
    value
}

fn emit_setting(app_handle: &AppHandle, value: &serde_json::Value) {
    app_handle
        .emit("setting_updated", value)
        .expect("Failed to emit event");
}

fn preserve_persisted_fields(mut replacement: Setting, current: &Setting) -> Setting {
    replacement.proxy_url.clone_from(&current.proxy_url);
    replacement.appearance.clone_from(&current.appearance);
    replacement.zoom_factor = normalize_zoom_factor(current.zoom_factor);
    replacement.harness_max_heap_mb = normalize_harness_max_heap_mb(current.harness_max_heap_mb);
    replacement.close_action = normalize_close_action(&current.close_action);
    replacement.pet_enabled = current.pet_enabled;
    replacement.active_pet.clone_from(&current.active_pet);
    replacement.pet_size = current.pet_size;
    replacement.force_xwayland = current.force_xwayland;
    replacement
}

/// 兼容旧调用方的整对象写入，但始终保留锁内读到的最新缩放、关窗动作与桌宠
/// 持久字段，避免长流程用陈旧 `Setting` 覆盖精确更新路径刚写入的值（丢更新）。
pub fn set_store_dat_setting(app_handle: &AppHandle, mut setting: Setting) {
    let value = {
        let _guard = setting_write_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let current = read_store_dat_setting(app_handle);
        setting = preserve_persisted_fields(setting, &current);
        normalize_setting(&mut setting);
        write_store_dat_setting(app_handle, &setting)
    };
    emit_setting(app_handle, &value);
}

/// 在一个短临界区内读取、修改并写回设置，避免多个精确字段更新彼此丢失。
pub fn update_store_dat_setting<F>(app_handle: &AppHandle, update: F) -> Setting
where
    F: FnOnce(&mut Setting),
{
    let (setting, value) = {
        let _guard = setting_write_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut setting = read_store_dat_setting(app_handle);
        update(&mut setting);
        normalize_setting(&mut setting);
        let value = write_store_dat_setting(app_handle, &setting);
        (setting, value)
    };
    emit_setting(app_handle, &value);
    setting
}

/// 泛型 `Runtime`：允许从非 Wry 具体化的窗口句柄（如工具函数的
/// `WebviewWindow<R>`）读取设置；具体类型调用方不受影响。
pub fn get_store_dat_setting<R: Runtime>(app_handle: &AppHandle<R>) -> Setting {
    let _guard = setting_write_lock()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    read_store_dat_setting(app_handle)
}

/// 已安装 Harness 发行版对应的 GitHub release commit hash
pub fn get_dsh_pkg_commit(app_handle: &AppHandle) -> Option<String> {
    get_store_dat_setting(app_handle).dsh_pkg_commit
}

/// 已安装 Harness 发行版对应的 GitHub release tag
pub fn get_dsh_pkg_tag(app_handle: &AppHandle) -> Option<String> {
    get_store_dat_setting(app_handle).dsh_pkg_tag
}

pub fn set_dsh_pkg_identity(app_handle: &AppHandle, commit: String, tag: String) {
    update_store_dat_setting(app_handle, |setting| {
        setting.dsh_pkg_commit = Some(commit);
        setting.dsh_pkg_tag = Some(tag);
    });
}

#[cfg(test)]
mod tests {
    use super::{
        default_close_action, default_zoom_factor, force_xwayland_in_store_json,
        normalize_close_action, normalize_setting, normalize_zoom_factor,
        preserve_persisted_fields, resolve_store_dat_file, setting_from_value, unwrap_json_value,
        Setting, STORE_DAT_DEV_FILE, STORE_DAT_FILE, STORE_DAT_TEST_FILE, STORE_SETTING_KEY,
        ZOOM_FACTOR_MAX, ZOOM_FACTOR_MIN,
    };

    /// 启动前读取跑在 `logger::init()` 之前，任何损坏输入都只能静默回落到关闭。
    #[test]
    fn force_xwayland_falls_back_to_off_on_any_unreadable_store() {
        // 正常形状：`setting` 的值是对象。
        assert!(force_xwayland_in_store_json(
            r#"{"setting":{"force_xwayland":true}}"#
        ));
        assert!(!force_xwayland_in_store_json(
            r#"{"setting":{"force_xwayland":false}}"#
        ));
        // 历史形状：`setting` 的值是一个内含对象的 JSON 字符串，read_store_dat_setting
        // 同样兼容；漏掉这一支会让部分用户的设置被静默读成关闭。
        assert!(force_xwayland_in_store_json(
            r#"{"setting":"{\"force_xwayland\":true}"}"#
        ));
        // 字段缺失（老版本写下的 store）。
        assert!(!force_xwayland_in_store_json(
            r#"{"setting":{"port":3080}}"#
        ));
        // 键缺失、JSON 非法、空文件。
        assert!(!force_xwayland_in_store_json(r#"{"window_state":{}}"#));
        assert!(!force_xwayland_in_store_json("{ not json"));
        assert!(!force_xwayland_in_store_json(""));
        // 字符串包裹但内层非法。
        assert!(!force_xwayland_in_store_json(r#"{"setting":"not json"}"#));
        // 值不是 bool：不做真值推断，按关闭处理。
        assert!(!force_xwayland_in_store_json(
            r#"{"setting":{"force_xwayland":"yes"}}"#
        ));
        assert!(!force_xwayland_in_store_json(
            r#"{"setting":{"force_xwayland":1}}"#
        ));
    }

    /// 启动前读取按字符串字面量取字段，与 `Setting` 的序列化形状只靠约定对齐。
    /// 字段改名不会有编译错误，只会让读取静默失效，这里拿真实序列化结果兜住。
    #[test]
    fn force_xwayland_key_matches_the_serialized_setting() {
        let setting = Setting {
            force_xwayland: true,
            ..Setting::default()
        };
        let raw = serde_json::json!({ STORE_SETTING_KEY: setting }).to_string();
        assert!(force_xwayland_in_store_json(&raw));
    }

    #[test]
    fn store_dat_file_name_isolates_the_three_modes() {
        assert_eq!(resolve_store_dat_file(true, true), STORE_DAT_TEST_FILE);
        assert_eq!(resolve_store_dat_file(true, false), STORE_DAT_TEST_FILE);
        assert_eq!(resolve_store_dat_file(false, true), STORE_DAT_DEV_FILE);
        assert_eq!(resolve_store_dat_file(false, false), STORE_DAT_FILE);
    }

    /// 三方文件名必须互不相同：任何一处塌缩都会让某一方改写另一方的用户状态。
    #[test]
    fn store_dat_file_names_are_pairwise_distinct() {
        let names = [STORE_DAT_FILE, STORE_DAT_DEV_FILE, STORE_DAT_TEST_FILE];
        for (i, a) in names.iter().enumerate() {
            for b in names.iter().skip(i + 1) {
                assert_ne!(a, b, "Store 文件名重复：{a} 与 {b}");
            }
        }
    }

    #[test]
    fn zoom_factor_defaults_for_legacy_settings() {
        let setting: Setting = serde_json::from_value(serde_json::json!({
            "installed": true,
            "port": 3080,
            "auto_start": true,
            "language": "en-US"
        }))
        .expect("legacy setting should deserialize");

        assert_eq!(setting.zoom_factor, default_zoom_factor());
    }

    #[test]
    fn zoom_factor_is_clamped_and_rounded() {
        assert_eq!(normalize_zoom_factor(0.1), ZOOM_FACTOR_MIN);
        assert_eq!(normalize_zoom_factor(3.0), ZOOM_FACTOR_MAX);
        assert!((normalize_zoom_factor(1.14) - 1.1).abs() < f64::EPSILON);
        let canonical = normalize_zoom_factor(1.16);
        assert_eq!(canonical, 1.2);
        assert_eq!(serde_json::to_string(&canonical).unwrap(), "1.2");
    }

    #[test]
    fn invalid_zoom_factor_resets_to_default() {
        assert_eq!(normalize_zoom_factor(f64::NAN), default_zoom_factor());
        assert_eq!(normalize_zoom_factor(f64::INFINITY), default_zoom_factor());
    }

    #[test]
    fn malformed_appearance_preserves_operational_settings() {
        for (appearance, expected) in [
            (
                serde_json::json!({ "palette": "nord", "terminal": true, "opacity": 77.5 }),
                ("nord", true, 78),
            ),
            (
                serde_json::json!({ "opacity": 300 }),
                ("default", false, 100),
            ),
            (serde_json::json!({ "opacity": -1 }), ("default", false, 20)),
            (
                serde_json::json!({ "opacity": "70" }),
                ("default", false, 100),
            ),
            (
                serde_json::json!({ "opacity": null }),
                ("default", false, 100),
            ),
            (
                serde_json::json!({ "palette": [], "terminal": "true", "opacity": 64 }),
                ("default", false, 64),
            ),
            (serde_json::json!(null), ("default", false, 100)),
            (serde_json::json!([]), ("default", false, 100)),
            (serde_json::json!("invalid"), ("default", false, 100)),
        ] {
            let mut object = serde_json::json!({
                "installed": true,
                "port": 4099,
                "manual_port": 4099,
                "auto_start": false,
                "language": "en-US",
                "active_profile": "custom-profile",
                "active_core": "app",
                "dsh_pkg_commit": "saved-core",
                "dsh_pkg_tag": "saved-release",
                "preinstall_done": true,
                "desktop_profile_ready": true,
                "cli_link_enabled": false,
                "harness_max_heap_mb": 2048,
                "zoom_factor": 1.2,
                "close_action": "quit"
            });
            object["appearance"] = appearance;
            for value in [
                object.clone(),
                serde_json::Value::String(object.to_string()),
            ] {
                let setting = setting_from_value(Some(&value));
                assert_eq!(setting.appearance.palette, expected.0, "{value}");
                assert_eq!(setting.appearance.terminal, expected.1, "{value}");
                assert_eq!(setting.appearance.opacity, expected.2, "{value}");
                let saved = serde_json::to_value(setting).unwrap();
                for (key, expected) in object.as_object().unwrap() {
                    if key != "appearance" {
                        assert_eq!(&saved[key], expected, "{key} changed for {value}");
                    }
                }
            }
        }
    }

    #[test]
    fn settings_decode_object_and_wrapped_object_with_same_normalization() {
        let object = serde_json::json!({
            "installed": true,
            "port": 4099,
            "auto_start": false,
            "language": "en-US",
            "zoom_factor": 1.16,
            "harness_max_heap_mb": 32769,
            "close_action": "QUIT",
            "backup_retention_count": 51
        });
        let wrapped = serde_json::Value::String(object.to_string());
        for value in [&object, &wrapped] {
            let setting = setting_from_value(Some(value));
            assert!(setting.installed);
            assert_eq!(setting.port, 4099);
            assert!(!setting.auto_start);
            assert_eq!(setting.language, "en-US");
            assert_eq!(setting.zoom_factor, 1.2);
            assert_eq!(setting.harness_max_heap_mb, None);
            assert_eq!(setting.close_action, "tray");
            assert_eq!(setting.backup_retention_count, 10);
            assert_eq!(setting.active_profile, "web");
        }
    }

    #[test]
    fn settings_decode_invalid_shapes_keep_chinese_default_language() {
        let invalid = [
            serde_json::Value::Null,
            serde_json::json!([]),
            serde_json::json!({}),
            serde_json::json!("not json"),
            serde_json::json!("null"),
            serde_json::json!({
                "installed": true,
                "port": 4099,
                "auto_start": true
            }),
        ];
        for value in &invalid {
            let setting = setting_from_value(Some(value));
            assert!(!setting.installed);
            assert_eq!(setting.language, "zh-CN");
            assert_eq!(setting.active_profile, "web");
            assert_eq!(setting.close_action, "tray");
        }
        assert_eq!(setting_from_value(None).language, "zh-CN");
    }

    #[test]
    fn unwrap_json_value_borrows_objects_and_parses_strings_once() {
        let object = serde_json::json!({ "force_xwayland": true });
        assert!(matches!(
            unwrap_json_value(&object),
            std::borrow::Cow::Borrowed(value) if std::ptr::eq(value, &object)
        ));
        let wrapped = serde_json::json!(object.to_string());
        assert_eq!(unwrap_json_value(&wrapped).as_ref(), &object);
        let invalid = serde_json::json!("not json");
        assert_eq!(unwrap_json_value(&invalid).as_ref(), &invalid);
        let nested = serde_json::json!(wrapped.to_string());
        assert_eq!(unwrap_json_value(&nested).as_ref(), &wrapped);
    }

    #[test]
    fn settings_normalization_preserves_boundary_values_and_unrelated_fields() {
        for heap_mb in [1024, 32768] {
            for retention in [1, 50] {
                let mut setting = Setting {
                    language: "custom-language".to_string(),
                    port: 4099,
                    zoom_factor: f64::NEG_INFINITY,
                    harness_max_heap_mb: Some(heap_mb),
                    close_action: "quit".to_string(),
                    backup_retention_count: retention,
                    backup_include_credentials: true,
                    active_pet: Some(String::new()),
                    ..Default::default()
                };
                normalize_setting(&mut setting);
                assert_eq!(setting.harness_max_heap_mb, Some(heap_mb));
                assert_eq!(setting.backup_retention_count, retention);
                assert_eq!(setting.zoom_factor, 1.0);
                assert_eq!(setting.close_action, "quit");
                assert_eq!(setting.language, "custom-language");
                assert_eq!(setting.port, 4099);
                assert!(setting.backup_include_credentials);
                assert_eq!(setting.active_pet.as_deref(), Some(""));
            }
        }
        for heap_mb in [0, 1023, 32769, u32::MAX] {
            let mut setting = Setting {
                harness_max_heap_mb: Some(heap_mb),
                backup_retention_count: 0,
                ..Default::default()
            };
            normalize_setting(&mut setting);
            assert_eq!(setting.harness_max_heap_mb, None);
            assert_eq!(setting.backup_retention_count, 10);
        }
    }

    #[test]
    fn legacy_full_setting_write_preserves_latest_fields() {
        let stale = Setting {
            installed: true,
            language: "en-US".to_string(),
            port: 4099,
            harness_max_heap_mb: Some(1024),
            backup_retention_count: 50,
            dsh_pkg_commit: Some("new-commit".to_string()),
            dsh_pkg_tag: Some("new-tag".to_string()),
            zoom_factor: 0.8,
            close_action: "quit".to_string(),
            pet_enabled: false,
            active_pet: Some("chat:stale".to_string()),
            pet_size: Some(80.0),
            force_xwayland: false,
            ..Default::default()
        };

        let current = Setting {
            proxy_url: "socks5h://127.0.0.1:1080".to_string(),
            appearance: super::super::Appearance {
                palette: "nord".into(),
                terminal: true,
                opacity: 70,
                transparency: true,
                sidebar_only: true,
            },
            harness_max_heap_mb: Some(4096),
            zoom_factor: 1.6,
            close_action: "tray".to_string(),
            pet_enabled: true,
            active_pet: Some("codex:latest".to_string()),
            pet_size: Some(140.0),
            force_xwayland: true,
            ..Default::default()
        };

        let merged = preserve_persisted_fields(stale, &current);

        assert_eq!(merged.proxy_url, current.proxy_url);
        assert!(merged.installed);
        assert_eq!(merged.language, "en-US");
        assert_eq!(merged.port, 4099);
        assert_eq!(merged.backup_retention_count, 50);
        assert_eq!(merged.dsh_pkg_commit.as_deref(), Some("new-commit"));
        assert_eq!(merged.dsh_pkg_tag.as_deref(), Some("new-tag"));
        assert_eq!(merged.harness_max_heap_mb, Some(4096));
        assert_eq!(merged.zoom_factor, 1.6);
        assert_eq!(merged.appearance, current.appearance);
        assert_eq!(merged.close_action, "tray");
        assert!(merged.pet_enabled);
        assert_eq!(merged.active_pet.as_deref(), Some("codex:latest"));
        assert_eq!(
            merged.pet_size,
            Some(140.0),
            "整对象写入不得覆盖最新桌宠字段"
        );
        assert!(
            merged.force_xwayland,
            "整对象写入不得覆盖最新的 XWayland 开关"
        );
    }

    #[test]
    fn proxy_setting_survives_serialization_and_defaults_for_legacy_settings() {
        let setting = Setting {
            proxy_url: "socks5h://127.0.0.1:1080".to_string(),
            ..Default::default()
        };
        let mut value = serde_json::to_value(&setting).unwrap();
        let restored: Setting = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(restored.proxy_url, "socks5h://127.0.0.1:1080");
        value.as_object_mut().unwrap().remove("proxy_url");
        let legacy: Setting = serde_json::from_value(value).unwrap();
        assert_eq!(legacy.proxy_url, "");
    }

    #[test]
    fn close_action_defaults_for_legacy_settings() {
        let setting: Setting = serde_json::from_value(serde_json::json!({
            "installed": true,
            "port": 4099,
            "auto_start": true,
            "language": "en-US"
        }))
        .expect("legacy setting should deserialize");

        assert_eq!(
            setting.close_action,
            default_close_action(),
            "旧配置缺失 close_action 时应回落默认"
        );
        assert_eq!(setting.port, 4099, "缺失 close_action 不应影响其余字段");
    }

    #[test]
    fn close_action_normalizes_unknown_values() {
        assert_eq!(normalize_close_action("tray"), "tray");
        assert_eq!(normalize_close_action("quit"), "quit");

        for raw in ["", "TRAY", "bogus", "quit ", "tray;drop"] {
            assert_eq!(
                normalize_close_action(raw),
                "tray",
                "非法值 {raw} 应回落默认"
            );
        }

        let setting: Setting = serde_json::from_value(serde_json::json!({
            "installed": true,
            "port": 4099,
            "auto_start": true,
            "language": "en-US",
            "close_action": "bogus"
        }))
        .expect("tampered setting should deserialize");

        assert_eq!(
            normalize_close_action(&setting.close_action),
            "tray",
            "store 中的非法值应在读取路径被归一化"
        );
        assert_eq!(
            setting.port, 4099,
            "非法 close_action 不得触发 Setting 整体回落默认"
        );
    }

    #[test]
    fn close_action_default_is_tray() {
        assert_eq!(
            default_close_action(),
            "tray",
            "新用户默认关闭行为为隐藏到托盘"
        );
        assert_eq!(Setting::default().close_action, "tray");
    }

    #[test]
    fn close_action_round_trip() {
        let setting = Setting {
            close_action: "quit".to_string(),
            ..Default::default()
        };
        let json = serde_json::to_string(&setting).expect("setting should serialize");
        let restored: Setting = serde_json::from_str(&json).expect("setting should deserialize");

        assert_eq!(
            normalize_close_action(&restored.close_action),
            "quit",
            "写入 store 再读回后关闭行为应保持不变"
        );
    }

    #[test]
    fn pet_defaults_closed_and_legacy_enabled_value_survives() {
        assert!(!Setting::default().pet_enabled, "新安装必须默认关闭桌宠");

        let legacy: Setting = serde_json::from_value(serde_json::json!({
            "installed": true,
            "port": 3080,
            "auto_start": true,
            "language": "zh-CN",
            "pet_enabled": true,
            "pet_visible": false
        }))
        .expect("legacy setting should deserialize");
        assert!(legacy.pet_enabled, "旧版临时隐藏字段不得关闭永久启用状态");
    }
}
