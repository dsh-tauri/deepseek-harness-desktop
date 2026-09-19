use super::constants::*;
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_store::StoreExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct Setting {
    pub installed: bool,
    pub port: u16,
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
    /// 上次引导结束时的 `preset-plugins.json` 内容指纹。资源文件每次安装都会被
    /// 强制覆盖、旧文件不复存在，只能把「上次看到的内容」记在这里，每次启动再比对：
    /// 内容有变更 → 重新进入预设引导。`None` = 老用户升级（无基线）→ 弹一次建立基线。
    #[serde(default)]
    pub preset_hash: Option<String>,
    /// 旧版 AppData `data/dsh` → 官方 `$DSH_HOME`（~/.dsh）数据迁移是否已完成。
    /// 幂等标记：迁移成功并删除旧目录后置位，避免重复合并。
    #[serde(default)]
    pub dsh_home_migrated: bool,
    /// 当前使用的档案 id（`$DSH_HOME/profiles/<id>`，默认 web）。
    /// 桌面端启动服务与插件管理都以它为准（见 service::profile）。
    /// 老用户 store 里可能仍是旧引导档案名 `desktop`：启动迁移
    /// （`service::profile::migrate_desktop_profile_name`）会把它改指 `tauri`。
    #[serde(default = "default_active_profile")]
    pub active_profile: String,
    /// 首装档案引导是否已完成：桌面端首次安装时自动新建引导档案（`tauri`）并
    /// 切换为当前档案（见 service::profile::migrate_desktop_profile_name），成功
    /// 后置位，之后启动不再重做（幂等标记，语义同 dsh_home_migrated）。
    #[serde(default)]
    pub desktop_profile_ready: bool,
    /// 活动核心的显式选择：`Some("local")` = 用户 CLI 安装的本地核心，
    /// `Some("app")` = 桌面端预打包核心；`None` = 自动（离线包用内置核心，
    /// 否则本地核心存在时优先）。
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
    /// 当前选中的桌宠模型包（`x.x.x.sprites/` 目录名或用户导入的 .zip 包名）；
    /// `None` 或空串对外统一映射到内置默认宠物。
    #[serde(default)]
    pub active_pet: Option<String>,
    /// 桌宠精灵图的显示宽度（逻辑像素）；`None` = 沿用窗口侧默认值。
    #[serde(default)]
    pub pet_size: Option<f64>,
}

pub const ZOOM_FACTOR_MIN: f64 = 0.5;
pub const ZOOM_FACTOR_MAX: f64 = 2.0;
pub const ZOOM_FACTOR_STEP: f64 = 0.1;

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
    "tray".to_string()
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
        "tray" | "quit" => value.to_string(),
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

/// 把 Setting 的保留份数字段归一化到有效范围。
fn normalize_backup_fields(setting: &mut Setting) {
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
            installed: false,
            port: default_port(),
            auto_start: true,
            language: "zh-CN".to_string(),
            dsh_pkg_commit: None,
            dsh_pkg_tag: None,
            cli_link_enabled: default_cli_link_enabled(),
            preinstall_done: false,
            preset_hash: None,
            dsh_home_migrated: false,
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
        }
    }
}

/// Store 持久化文件名：debug 构建与生产隔离（各自独立文件）。
///
/// store（端口、installed、active_core 等）属于「应用数据」而非共用核心——
/// 生产默认 3080、开发默认 3081，共用一份 store 会让两边端口一路漂移
/// （release 读到开发写入的 3081 后把 3080 让出，开发下次又从 3081 漂走）
/// 并相互污染安装/核心等状态。
fn store_dat_file_name() -> &'static str {
    if cfg!(debug_assertions) {
        STORE_DAT_DEV_FILE
    } else {
        STORE_DAT_FILE
    }
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

fn read_store_dat_setting<R: Runtime>(app_handle: &AppHandle<R>) -> Setting {
    let store = app_handle
        .store(store_dat_file_name())
        .expect("Failed to load store");
    let raw = store.get(STORE_SETTING_KEY);
    let value = raw.as_ref().and_then(|v| {
        v.as_str()
            .and_then(|s| serde_json::from_str(s).ok())
            .or_else(|| Some(v.clone()))
    });
    let mut setting = value
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_else(Setting::default);
    setting.zoom_factor = normalize_zoom_factor(setting.zoom_factor);
    setting.close_action = normalize_close_action(&setting.close_action);
    normalize_backup_fields(&mut setting);
    setting
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
    replacement.zoom_factor = normalize_zoom_factor(current.zoom_factor);
    replacement.close_action = normalize_close_action(&current.close_action);
    replacement.pet_enabled = current.pet_enabled;
    replacement.active_pet.clone_from(&current.active_pet);
    replacement.pet_size = current.pet_size;
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
        normalize_backup_fields(&mut setting);
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
        setting.zoom_factor = normalize_zoom_factor(setting.zoom_factor);
        // 落盘前的第二道闸：调用方（含前端 invoke）写入的不可信取值不以原始形态进 store
        setting.close_action = normalize_close_action(&setting.close_action);
        normalize_backup_fields(&mut setting);
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

/// 记录已安装 Harness 发行版的 GitHub release commit hash
pub fn set_dsh_pkg_commit(app_handle: &AppHandle, commit: String) {
    let mut setting = get_store_dat_setting(app_handle);
    setting.dsh_pkg_commit = Some(commit);
    set_store_dat_setting(app_handle, setting);
}

/// 已安装 Harness 发行版对应的 GitHub release tag
pub fn get_dsh_pkg_tag(app_handle: &AppHandle) -> Option<String> {
    get_store_dat_setting(app_handle).dsh_pkg_tag
}

/// 记录已安装 Harness 发行版的 GitHub release tag
pub fn set_dsh_pkg_tag(app_handle: &AppHandle, tag: String) {
    let mut setting = get_store_dat_setting(app_handle);
    setting.dsh_pkg_tag = Some(tag);
    set_store_dat_setting(app_handle, setting);
}

#[cfg(test)]
mod tests {
    use super::{
        default_close_action, default_zoom_factor, normalize_close_action, normalize_zoom_factor,
        preserve_persisted_fields, Setting, ZOOM_FACTOR_MAX, ZOOM_FACTOR_MIN,
    };

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
    fn legacy_full_setting_write_preserves_latest_fields() {
        let mut stale = Setting::default();
        stale.zoom_factor = 0.8;
        stale.close_action = "quit".to_string();
        stale.pet_enabled = false;
        stale.active_pet = Some("chat:stale".to_string());
        stale.pet_size = Some(80.0);

        let mut current = Setting::default();
        current.zoom_factor = 1.6;
        current.close_action = "tray".to_string();
        current.pet_enabled = true;
        current.active_pet = Some("codex:latest".to_string());
        current.pet_size = Some(140.0);

        let merged = preserve_persisted_fields(stale, &current);

        assert_eq!(merged.zoom_factor, 1.6);
        assert_eq!(merged.close_action, "tray");
        assert!(merged.pet_enabled);
        assert_eq!(merged.active_pet.as_deref(), Some("codex:latest"));
        assert_eq!(
            merged.pet_size,
            Some(140.0),
            "整对象写入不得覆盖最新桌宠字段"
        );
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
