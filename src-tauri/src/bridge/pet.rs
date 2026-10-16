//! bridge/pet.rs — 桌宠（外置透明宠物窗口）的 Tauri 命令出口。
//!
//! 这些命令被 dsh 容器（iframe 内的 dsh 界面 / dsh-tauri-pet 插件）经 invoke
//! 桥调用（壳层桥监听模块 `src/hooks/use-invoke-iframe.ts` 把 iframe 的
//! postMessage invoke 转发到 `@tauri-apps/api/core` 的 `invoke`）。所有状态
//! 读写统一落在 `config::setting`（持久化）与 `desktop::pet`（窗口）。
//! 错误遵循仓库约定：`Result<_, String>`，Err 以大写协议前缀开头（如
//! `PET_SIZE_OUT_OF_RANGE:`）。
//!
//! 实时性：一切会改变设置状态（开关/选择/大小）的命令都通过 `pet://status`
//! 事件把最新设置推给 pet 窗口；会话 CRUD 则通过独立的 `session:*` 事件直接转发
//! （含 `session:clear`：宿主会话流重连时整批作废桌宠侧遗留气泡）。

use crate::config;
use crate::desktop::pet as pet_window;
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::{StreamExt, TryStreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use zip::ZipArchive;

/// 宠物大小百分比合法区间（精灵图缩放 50%–200%，与插件设置页滑条一致）。
pub const PET_SIZE_MIN: f64 = pet_window::PET_SIZE_MIN_PERCENT;
pub const PET_SIZE_MAX: f64 = pet_window::PET_SIZE_MAX_PERCENT;

/// 导入桌宠资源包的压缩大小上限（32 MiB）。
const PET_PACKAGE_MAX_BYTES: usize = 32 * 1024 * 1024;
/// 防止 zip 炸弹的条目数与解压后总大小上限。
const PET_PACKAGE_MAX_ENTRIES: usize = 512;
const PET_PACKAGE_MAX_UNCOMPRESSED_BYTES: u64 = 128 * 1024 * 1024;
/// 清单和单张精灵图的读取上限。
const PET_MANIFEST_MAX_BYTES: u64 = 64 * 1024;
const PET_SPRITESHEET_MAX_BYTES: u64 = 8 * 1024 * 1024;
const PET_CONFIG_MAX_BYTES: u64 = 1024 * 1024;
const PET_VIDEO_MAX_BYTES: u64 = 512 * 1024 * 1024;
const PET_PREVIEW_MAX_DIMENSION: u16 = 4096;
const PET_SPRITESHEET_MAX_DIMENSION: u32 = 16_384;
const PET_SPRITESHEET_MAX_PIXELS: u64 = 64 * 1024 * 1024;
/// Codex 图集协议：列恒为 8，行数由 `spriteVersionNumber` 决定（v1=8x9 / v2=8x11）。
const PET_SPRITE_V1: u8 = 1;
const PET_SPRITE_V2: u8 = 2;
const PET_SPRITE_COLUMNS: u8 = 8;
const PET_SPRITE_V1_ROWS: u8 = 9;
const PET_SPRITE_V2_ROWS: u8 = 11;

/// 设置变化推送给 pet 窗口的事件名；会话生命周期使用 `session:*` 事件。
pub const PET_STATUS_EVENT: &str = "pet://status";

/// 桌宠当前完整状态（设置页、插件与 pet 窗口读取）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PetStatus {
    /// 桌宠是否启用（持久化）。关闭宠物即写 false，重启后保持关闭。
    pub enabled: bool,
    /// 桌宠窗口当前是否应显示。
    ///
    /// 恒等于 `enabled`：窗口的可见性现在完全由持久开关决定 —— 从前的「临时收起」
    /// （进程内瞬态、重启即恢复）已移除，用户主动关闭就是关闭。字段保留是为了
    /// 桥接契约稳定（侧栏绿点、pet 窗口渲染都读它）。
    pub visible: bool,
    /// 当前桌宠 id；持久值缺省或空白时返回空串（未选择任何宠物）。
    pub active_pet: String,
    /// 宠物大小百分比（50–200，100 = 精灵图原始尺寸）；None = 未设置（默认 100）。
    pub pet_size: Option<f64>,
    /// 是否允许抛射（拖拽甩出后飞行、撞屏幕边缘回弹）；默认关闭。
    ///
    /// 经 `pet://status` 广播给 pet 窗口，由窗口侧的物理层决定是否响应释放速度
    /// （issue #930）。
    pub throw_enabled: bool,
    pub autonomy_enabled: bool,
    pub autonomy_supported: bool,
    pub resize_enabled: bool,
    pub move_enabled: bool,
    pub drag_probability: u8,
}

/// 文件系统宠物的数据来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PetSource {
    Chat,
    Codex,
}

impl PetSource {
    /// 来源字符串是跨 iframe 的安全边界，只接受两个精确值。
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "chat" => Ok(Self::Chat),
            "codex" => Ok(Self::Codex),
            _ => Err("PET_SOURCE_INVALID: source must be chat or codex".to_string()),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Codex => "codex",
        }
    }
}

/// `pet.json` 的受支持字段；`spriteVersionNumber` 缺省表示清单未声明，网格按图集尺寸推断。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PetManifest {
    id: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    sprite_version_number: Option<u8>,
    #[serde(default)]
    spritesheet_path: String,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    config_path: Option<String>,
    #[serde(default)]
    uri_path: Option<String>,
    #[serde(default)]
    mac_uri_path: Option<String>,
    #[serde(default)]
    preview_path: Option<String>,
    #[serde(default)]
    ext: Option<config::manifest::PresetPetExt>,
    #[serde(default)]
    size: Option<f64>,
}

/// 列表项使用来源限定 id，避免 chat 与 codex 同名时互相覆盖。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PetListItem {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub thumbnail: Option<String>,
    pub source: String,
    pub kind: String,
    pub thumbnail_type: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PetAsset {
    Codex {
        id: String,
        spritesheet: String,
        sprite_version_number: u8,
        columns: u8,
        rows: u8,
    },
    Dsh {
        id: String,
        config: Value,
        uri: config::manifest::PresetPetUri,
        ext: config::manifest::PresetPetExt,
        #[serde(skip_serializing_if = "Option::is_none")]
        size: Option<f64>,
    },
}

/// 全新安装（从未写过 `active_pet`）或旧版非法值默认选中的宠物：清单里的第一个预设
/// 条目。清单是唯一事实来源，不在这里硬编码 id（条目直连远端素材，选中即可渲染）。
fn default_active_pet(app: &AppHandle) -> String {
    crate::bridge::preset_pet::read_preset_catalog(app)
        .ok()
        .and_then(|catalog| catalog.into_iter().next().map(|spec| spec.id))
        .unwrap_or_default()
}

/// 将缺省、旧版未限定 id 或非法选择归一化为可渲染的激活 id。
///
/// 合法值：预设宠物 id（清单 `pets.built-in` 的安全字符集）或来源限定 id。
/// 缺省（`None`）与非法值回落到 [`default_active_pet`]：新手第一次打开设置页就应看到
/// 一只被选中的宠物，而不是「什么都没有」的透明窗口。空串是**显式**清除（设置页
/// 「取消选择」），保持为空，否则取消选择会被默认值立刻撤销。
fn normalize_active_pet(active_pet: Option<&str>, default_id: &str) -> String {
    let Some(raw) = active_pet else {
        return default_id.to_string();
    };
    let id = raw.trim();
    if id.is_empty() {
        return String::new();
    }
    if crate::bridge::preset_pet::safe_preset_id(id) || parse_qualified_id(id).is_ok() {
        id.to_string()
    } else {
        default_id.to_string()
    }
}

/// 由持久设置推导唯一的对外状态（窗口可见性 = 持久开关，没有额外的进程内状态）。
fn status_from_setting(setting: &config::Setting, default_id: &str) -> PetStatus {
    PetStatus {
        enabled: setting.pet_enabled,
        visible: setting.pet_enabled,
        active_pet: normalize_active_pet(setting.active_pet.as_deref(), default_id),
        pet_size: setting.pet_size,
        throw_enabled: setting.throw_enabled,
        autonomy_enabled: setting.pet_autonomy_enabled,
        resize_enabled: setting.pet_resize_enabled,
        move_enabled: setting.pet_move_enabled,
        autonomy_supported: cfg!(windows),
        drag_probability: setting.pet_drag_probability,
    }
}

/// 把最新状态推送给 pet 窗口（动作与设置变化共用同一事件）。
fn emit_pet_status(app: &AppHandle, status: &PetStatus) {
    let _ = app.emit_to(
        pet_window::PET_WINDOW_LABEL,
        PET_STATUS_EVENT,
        status.clone(),
    );
}

/// 查询桌宠当前完整状态。
#[tauri::command]
pub fn get_pet_status(app: AppHandle) -> PetStatus {
    status_from_setting(
        &config::get_store_dat_setting(&app),
        &default_active_pet(&app),
    )
}

/// 查询当前运行环境能否让桌宠窗口置顶并定位（issue #649）。
///
/// 结果由运行环境推导，与持久设置无关，因此不并入 [`PetStatus`]：
/// [`status_from_setting`] 是 [`config::Setting`] 的纯函数，掺入环境变量会破坏这一点。
#[tauri::command]
pub fn get_pet_overlay_supported() -> bool {
    crate::pet_overlay_supported_env()
}

/// 读取「强制 XWayland」开关（issue #649 的方案 2，默认关闭）。
///
/// 该设置作用于整个应用而非只有桌宠，命令名因此不带 `pet_` 前缀；落在本模块只因
/// 桌宠遮挡是它唯一的症状与唯一的消费方。同理不并入 [`PetStatus`]：后者经
/// `pet://status` 广播给桌宠窗口与侧栏指示点，两者都不关心这个值。
#[tauri::command]
pub fn get_force_xwayland(app: AppHandle) -> bool {
    config::get_store_dat_setting(&app).force_xwayland
}

/// 写入「强制 XWayland」开关，返回落盘后的值。
///
/// 不操作窗口、不广播 `pet://status`：`GDK_BACKEND` 只在 GTK 初始化时被读取一次，
/// 本次进程里没有任何东西能因此改变，生效要等下次启动。
#[tauri::command]
pub fn set_force_xwayland(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let updated = config::update_store_dat_setting(&app, |setting| {
        setting.force_xwayland = enabled;
    });
    Ok(updated.force_xwayland)
}

/// 启用/关闭桌宠（持久化）。侧栏入口、设置页与桌宠窗口自身的关闭请求都走这里。
///
/// 关闭即销毁窗口实例（不是 hide，见 `desktop::pet::set_pet_window_visible`：隐藏窗口里
/// 的 `<video>` 仍会播放并持有 Video Wake Lock，issue #469），因此必须走
/// [`defer_pet_window_op`] 在非主线程执行。
///
/// **持久化是刻意的**：`enabled=false` 落盘后重启不再自动拉起桌宠。从前「收起」只改
/// 进程内瞬态，导致用户明明关了宠物、重启又自己出来。
///
/// 启用时若没有选中任何宠物（用户取消选择过），补上默认预设：启用的桌宠必须有内容可
/// 渲染，否则用户看到的是一个空窗口 —— 观感与「宠物坏了」完全一样。
#[tauri::command]
pub fn set_pet_enabled(app: AppHandle, enabled: bool) -> Result<PetStatus, String> {
    let fallback = default_active_pet(&app);
    let updated = config::update_store_dat_setting(&app, |setting| {
        setting.pet_enabled = enabled;
        let selected = setting.active_pet.as_deref().map(str::trim).unwrap_or("");
        if enabled && selected.is_empty() {
            setting.active_pet = Some(fallback.clone());
        }
    });
    // 关闭即无消费者：先停掉宿主会话流订阅，窗口销毁随后在后台完成。
    sync_pet_session_stream(&app, enabled);
    defer_pet_window_op(&app, enabled)?;
    let status = status_from_setting(&updated, &fallback);
    emit_pet_status(&app, &status);
    Ok(status)
}

/// 选择桌宠模型包并持久化 active_pet。
///
/// 空串表示清除选择（存 `Some("")`，与缺省 `None` 区分开）：设置页已选卡片可再次点击
/// 取消，而不是一旦选中就无法撤销；缺省值才回落默认预设。清空后桌宠窗口无内容可渲染，
/// 调用方应同时关闭窗口。
#[tauri::command]
pub fn set_active_pet(app: AppHandle, id: String) -> Result<PetStatus, String> {
    let cleared = normalize_set_active_pet_id(&id)?;
    let updated = config::update_store_dat_setting(&app, |setting| {
        setting.active_pet = cleared;
    });
    let status = status_from_setting(&updated, &default_active_pet(&app));
    emit_pet_status(&app, &status);
    Ok(status)
}

/// 选择 id 归一化：空串（去除首尾空白后）表示清除选择（存空串，不存 `None`——`None` 是
/// 「从未选择」，要回落默认预设）；非空沿用既有合法性校验（预设安全字符集或来源限定
/// id），非法 id 保持报错而不静默清空。
fn normalize_set_active_pet_id(id: &str) -> Result<Option<String>, String> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Ok(Some(String::new()));
    }
    validate_active_pet_id(trimmed)?;
    Ok(Some(trimmed.to_string()))
}

/// 设置宠物大小百分比（设置页滑条，50–200），并实时同步窗口尺寸。
#[tauri::command]
pub fn set_pet_size(app: AppHandle, size: f64) -> Result<PetStatus, String> {
    if !size.is_finite() || !(PET_SIZE_MIN..=PET_SIZE_MAX).contains(&size) {
        return Err(format!(
            "PET_SIZE_OUT_OF_RANGE: pet size percent must be within {PET_SIZE_MIN}..={PET_SIZE_MAX}"
        ));
    }
    let updated = config::update_store_dat_setting(&app, |setting| {
        setting.pet_size = Some(size);
    });
    // 窗口尺寸由 pet WebView（知道当前资源真实画布比例）在收到状态事件后实时设置；
    // Rust 不再绕开前端重复 set_size，避免内置鲸鱼（16:9）与自定义图集比例不一致时被
    // 两处高度交替重设，造成大小变更时上下闪烁（issue #308）。DPI 变化仍由 Rust 的
    // ScaleFactorChanged 分支按当前宠物比例重设。
    let status = status_from_setting(&updated, &default_active_pet(&app));
    emit_pet_status(&app, &status);
    Ok(status)
}

#[tauri::command]
pub fn set_pet_drag_probability(app: AppHandle, probability: u8) -> Result<PetStatus, String> {
    if probability > 100 {
        return Err("PET_DRAG_PROBABILITY_OUT_OF_RANGE: expected 0..=100".into());
    }
    let mut autonomy = app
        .state::<Mutex<crate::desktop::pet_autonomy::PetAutonomy>>()
        .inner()
        .lock()
        .map_err(|_| "PET_AUTONOMY_LOCK_FAILED".to_string())?;
    let updated = config::update_store_dat_setting(&app, |setting| {
        setting.pet_drag_probability = probability;
    });
    autonomy.rest(Instant::now(), 6);
    drop(autonomy);
    let status = status_from_setting(&updated, &default_active_pet(&app));
    emit_pet_status(&app, &status);
    Ok(status)
}

#[tauri::command]
pub fn set_pet_autonomy_enabled(app: AppHandle, enabled: bool) -> Result<PetStatus, String> {
    if enabled && !cfg!(windows) {
        return Err("PET_AUTONOMY_UNSUPPORTED: Windows required".into());
    }
    let updated = config::update_store_dat_setting(&app, |setting| {
        setting.pet_autonomy_enabled = enabled;
    });
    app.state::<Mutex<crate::desktop::pet_autonomy::PetAutonomy>>()
        .lock()
        .map_err(|_| "PET_AUTONOMY_LOCK_FAILED".to_string())?
        .rest(Instant::now(), 6);
    let status = status_from_setting(&updated, &default_active_pet(&app));
    emit_pet_status(&app, &status);
    Ok(status)
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PetInteractionKind {
    Resize,
    Move,
}

#[tauri::command]
pub fn set_pet_interaction_enabled(
    app: AppHandle,
    kind: PetInteractionKind,
    enabled: bool,
) -> Result<PetStatus, String> {
    let mut autonomy = app
        .state::<Mutex<crate::desktop::pet_autonomy::PetAutonomy>>()
        .inner()
        .lock()
        .map_err(|_| "PET_AUTONOMY_LOCK_FAILED".to_string())?;
    let updated = config::update_store_dat_setting(&app, |setting| match kind {
        PetInteractionKind::Resize => setting.pet_resize_enabled = enabled,
        PetInteractionKind::Move => setting.pet_move_enabled = enabled,
    });
    autonomy.rest(Instant::now(), 6);
    drop(autonomy);
    let status = status_from_setting(&updated, &default_active_pet(&app));
    emit_pet_status(&app, &status);
    Ok(status)
}

/// 启用/关闭抛射能力（设置页 Switch，默认关闭，issue #930）。
///
/// 与 [`set_pet_size`] 同形：只落盘 + 广播状态，不做窗口操作——抛射完全是 pet WebView
/// 内的物理层行为，窗口侧收到 `pet://status` 立即生效，无需重启。
#[tauri::command]
pub fn set_pet_throw_enabled(app: AppHandle, enabled: bool) -> Result<PetStatus, String> {
    let updated = config::update_store_dat_setting(&app, |setting| {
        setting.throw_enabled = enabled;
    });
    let status = status_from_setting(&updated, &default_active_pet(&app));
    emit_pet_status(&app, &status);
    Ok(status)
}

/// 删除用户导入的宠物：来源限定 id 删除对应来源目录，预设 id 反注册远端条目（内置预设删不到）。
///
/// 被删的宠物正好是当前激活项时顺带清空选择——否则窗口会一直指向已经不存在的素材。
#[tauri::command]
pub fn delete_pet(app: AppHandle, id: String) -> Result<PetStatus, String> {
    let id = id.trim().to_string();
    match parse_qualified_id(&id) {
        Ok((source, manifest_id)) => {
            delete_pet_directory(&pets_dir(&app, source)?, source, manifest_id)?
        }
        Err(_) if crate::bridge::preset_pet::safe_preset_id(&id) => {
            crate::bridge::preset_pet::unregister_remote_pet(&app, &id)?
        }
        Err(_) => {
            return Err(
                "PET_ID_INVALID: pet id must be a preset id or source-qualified".to_string(),
            )
        }
    }
    let setting = config::get_store_dat_setting(&app);
    if setting.active_pet.as_deref() == Some(id.as_str()) {
        return set_active_pet(app, String::new());
    }
    Ok(status_from_setting(&setting, &default_active_pet(&app)))
}

/// 删除来源目录中清单 id 匹配的宠物目录；目录名不一定等于清单 id，按清单反查真实路径。
fn delete_pet_directory(root: &Path, source: PetSource, manifest_id: &str) -> Result<(), String> {
    let _guard = pet_import_lock()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let (directory, _) = find_pet_directory(root, manifest_id)?.ok_or_else(|| {
        format!(
            "PET_NOT_FOUND: pet {} was not found",
            qualified_id(source, manifest_id)
        )
    })?;
    fs::remove_dir_all(&directory).map_err(|error| {
        format!(
            "PET_DELETE_FAILED: failed to remove {}: {error}",
            directory.display()
        )
    })
}

/// 将 DSH 会话原始数据推送到独立桌宠 WebView，不在桌面端构造宠物专用结构。
#[tauri::command]
pub fn push_pet_session(app: AppHandle, action: String, session: Value) -> Result<(), String> {
    let action = action.trim();
    if !matches!(action, "create" | "update" | "remove") {
        return Err("PET_SESSION_ACTION_INVALID: action must be create/update/remove".to_string());
    }
    let id = session
        .get("id")
        .or_else(|| session.get("sessionId"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "PET_SESSION_ID_INVALID: raw session must include id".to_string())?;
    let event = session_event_of(action).expect("session action was validated above");
    app.emit_to(pet_window::PET_WINDOW_LABEL, event, session)
        .map_err(|error| format!("PET_SESSION_PUSH_FAILED: failed to emit session {id}: {error}"))
}

const SESSION_STREAM_PATH: &str = "/api/tauri/pet/session/stream";

/// 「宿主累计态已丢弃」注释帧文本（与
/// `packages/dsh-tauri-pet/src/shared/constants.ts` 的 `SSE_STATE_LOST_COMMENT` 逐字一致）。
///
/// 宿主逐会话累计态只在**最后一个**消费者断开时丢弃。新消费者接入时若已无其他消费者，
/// 宿主状态必然从零重建，旧气泡全部作废——宿主随后下发这一帧，消费端据此清屏。
const SSE_STATE_LOST_COMMENT: &str = "state-lost";

/// 会话增量「动作 → 桌宠窗口事件名」映射（与 push_pet_session 共用）。
///
/// `clear` 不是单个会话的动作而是整批作废：它由宿主在「接入时已无其他消费者」的连接上以
/// `: state-lost` 注释帧宣告（见 [`SSE_STATE_LOST_COMMENT`]）——宿主不会把累计态重放给新
/// 消费者，因此那份状态一旦随旧连接丢弃，桌宠侧就只能整批作废；反之只要还有别的消费者在，
/// 宿主状态就仍然有效，清屏会误杀活气泡。
fn session_event_of(action: &str) -> Option<&'static str> {
    match action {
        "create" => Some("session:create"),
        "update" => Some("session:update"),
        "remove" => Some("session:remove"),
        "clear" => Some("session:clear"),
        _ => None,
    }
}

/// 直接把「动作 + 展示载荷」推给桌宠窗口（返回是否成功，仅用于 debug 日志）。
fn emit_pet_session(app: &AppHandle, action: &str, payload: &Value) {
    let Some(event) = session_event_of(action) else {
        return;
    };
    let _ = app.emit_to(pet_window::PET_WINDOW_LABEL, event, payload.clone());
}

/// 消费宿主会话增量 SSE 流：读取 `http://127.0.0.1:<port>/api/tauri/pet/session/stream`，
/// 每个 `data:` 帧（`{"action":...,"payload":...}`）解析后经 emit_to 直达桌宠 WebView；
/// `: state-lost` 注释帧翻译成一次整批作废（见 [`SSE_STATE_LOST_COMMENT`]）。
///
/// 方案 1（host → rust → pet）：Rust 不再依赖 iframe 的 invoke 桥转发（#396 根因），
/// 而是作为宿主流的消费者。流中断（宿主未就绪/重启）时退避重连，幂等可恢复。
async fn consume_pet_session_stream(app: &AppHandle, url: &str) -> Result<(), String> {
    consume_pet_session_stream_with(url, |action, payload| {
        emit_pet_session(app, action, payload);
    })
    .await
}

/// [`consume_pet_session_stream`] 的取帧主体：把每个动作交给 `on_frame`，与 Tauri 运行时解耦。
async fn consume_pet_session_stream_with<F>(url: &str, mut on_frame: F) -> Result<(), String>
where
    F: FnMut(&str, &Value),
{
    // 访问的是本机 dsh，不能继承 `HTTP_PROXY` / `ALL_PROXY`（与 `loopback_http_client`
    // 同一理由）：部分代理不尊重回环地址直连，会把这条 SSE 转发到外部代理，表现为
    // `HTTP 502` / `HTTP 404` / `error decoding response body` 的反复断线重连 ——
    // 即便偶尔连上，代理缓冲也会把逐条帧攒成一批，气泡文案滞后且抖动。
    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }

    // 宿主侧累计态的生命周期就是「有消费者」，本端一断一接（宿主重启、宿主热重载、
    // 桌宠重新启用）都意味着宿主已丢弃逐会话状态、不会再为旧会话补发 remove；此时
    // 桌宠窗口里的气泡仍是上一轮的并作废。但这件事**只有宿主知道**：若仍有别的消费者
    // 挂在流上，宿主状态留存且不会重放，本端无条件清屏就会误杀那些仍然有效的气泡。
    // 因此清屏时机交给宿主宣告（`: state-lost` 注释帧，见 `SSE_STATE_LOST_COMMENT`）。
    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();
    // SSE: data: 行累积，遇空行派发一帧；注释帧只认 state-lost，其余（含心跳）忽略。
    let mut pending_data: Vec<String> = Vec::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| error.to_string())?;
        buffer.extend_from_slice(&chunk);
        while let Some(position) = buffer.iter().position(|&byte| byte == b'\n') {
            let line_bytes: Vec<u8> = buffer.drain(..=position).collect();
            let line = String::from_utf8_lossy(&line_bytes[..line_bytes.len() - 1]).into_owned();
            let trimmed = line.trim();
            if let Some(data) = trimmed.strip_prefix("data:") {
                pending_data.push(data.trim().to_string());
            } else if trimmed.is_empty() && !pending_data.is_empty() {
                let frame: Value = serde_json::from_str(&pending_data.join("\n"))
                    .map_err(|error| error.to_string())?;
                let action = frame
                    .get("action")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let payload = frame.get("payload").cloned().unwrap_or(Value::Null);
                on_frame(&action, &payload);
                pending_data.clear();
            } else if trimmed.strip_prefix(':').map(str::trim) == Some(SSE_STATE_LOST_COMMENT) {
                // 宿主宣告上一轮累计态已丢弃（接入时已无其他消费者才会发）：整批作废气泡。
                on_frame("clear", &Value::Null);
            }
            // 其余行（心跳等注释帧、SSE 字段行）忽略。
        }
    }
    Ok(())
}

/// 会话增量流消费任务的句柄：桌宠停用/隐藏时 abort，宿主侧 SSE 客户端随连接
/// 关闭归零（宿主插件据此注销 `session/event` 监听）。
fn pet_stream_handle() -> &'static Mutex<Option<tauri::async_runtime::JoinHandle<()>>> {
    static HANDLE: OnceLock<Mutex<Option<tauri::async_runtime::JoinHandle<()>>>> = OnceLock::new();
    HANDLE.get_or_init(|| Mutex::new(None))
}

/// 是否需要订阅宿主会话增量流：桌宠已启用（窗口存在）。
///
/// 关闭桌宠（`set_pet_enabled(false)`）会销毁窗口，同样视为无消费者——窗口不渲染时
/// 转发毫无意义，停掉订阅即让宿主的热路径与逐会话累计态一并短路。
pub fn pet_stream_wanted(app: &AppHandle) -> bool {
    let status = status_from_setting(
        &config::get_store_dat_setting(app),
        &default_active_pet(app),
    );
    status.enabled
}

/// 断线重连日志的重记间隔：状态持续不变时最多这么久重记一次。
///
/// 宿主未就绪（启动中，或插件操作期间被主动停止）时这条流会每 2s 失败一次，
/// 逐次输出会在几秒内刷满日志、把真正的错误挤掉。
const PET_STREAM_RELOG_INTERVAL: Duration = Duration::from_secs(60);

/// 「会话流正常结束」在日志节流里的状态名（宿主重启时属正常，不需要告警）。
const PET_STREAM_ENDED: &str = "stream ended";

/// 重连日志节流器：只在「状态首次出现 / 状态变化 / 距上次输出已超过
/// [`PET_STREAM_RELOG_INTERVAL`]」时允许输出，其余相同的重复失败降级为 debug。
///
/// 状态用失败原因字符串表示：宿主不可用期间原因通常是稳定的一条（如
/// `HTTP 502 Bad Gateway`），于是整段不可用期被压成首行 + 每分钟一行；原因变化
/// （换了一种坏法）则立即重新输出，不会把新问题一起静默掉。
struct PetStreamLogThrottle {
    last_state: Option<String>,
    last_logged: Instant,
    relog_interval: Duration,
}

impl PetStreamLogThrottle {
    fn new() -> Self {
        Self {
            last_state: None,
            last_logged: Instant::now(),
            relog_interval: PET_STREAM_RELOG_INTERVAL,
        }
    }

    /// 记录一次状态，返回这一行是否应当输出。
    fn should_log(&mut self, state: &str) -> bool {
        let repeated = self.last_state.as_deref() == Some(state);
        self.last_state = Some(state.to_string());
        if repeated && self.last_logged.elapsed() < self.relog_interval {
            return false;
        }
        self.last_logged = Instant::now();
        true
    }
}

/// 按「是否有消费者」启停「宿主会话增量 SSE」消费任务（见
/// [`consume_pet_session_stream`]），幂等：启用且无活动任务才 spawn；停用时
/// abort 任务，连接立即关闭。
///
/// 调用点：应用 setup、`set_pet_enabled`。桌宠关闭后 Rust 不再是宿主流的消费者，
/// 宿主侧随即不再为桌宠做任何转发。
pub fn sync_pet_session_stream(app: &AppHandle, wanted: bool) {
    let slot = pet_stream_handle();
    let mut handle = slot.lock().unwrap_or_else(|error| error.into_inner());
    if !wanted {
        if let Some(task) = handle.take() {
            task.abort();
            log::info!("[pet-stream] host session stream stopped (pet disabled or hidden)");
        }
        return;
    }
    if handle
        .as_ref()
        .is_some_and(|task| !task.inner().is_finished())
    {
        return;
    }
    let app = app.clone();
    *handle = Some(tauri::async_runtime::spawn(async move {
        // 重连是 2s 一次的常态循环，宿主未就绪时会连续失败几十上百次：逐次输出
        // 会刷满日志并挤掉真正的错误，因此按状态节流（见 [`PetStreamLogThrottle`]）。
        let mut throttle = PetStreamLogThrottle::new();
        loop {
            let setting = config::get_store_dat_setting(&app);
            let url = format!("http://127.0.0.1:{}{}", setting.port, SESSION_STREAM_PATH);
            match consume_pet_session_stream(&app, &url).await {
                Ok(()) => {
                    if throttle.should_log(PET_STREAM_ENDED) {
                        log::info!("[pet-stream] host session stream ended; reconnecting in 2s");
                    } else {
                        log::debug!("[pet-stream] host session stream ended (repeated)");
                    }
                }
                Err(error) => {
                    if throttle.should_log(&error) {
                        log::warn!(
                            "[pet-stream] host session stream error: {error}; reconnecting in 2s"
                        );
                    } else {
                        log::debug!("[pet-stream] host session stream error (suppressed): {error}");
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    }));
}

/// 按物理像素增量移动桌宠窗口，限制在可见显示器并保存最终位置。
///
/// 缩放（`pet://status` 收到新 pet_size）后由 pet WebView 调用 `move_pet_window(0, 0)`
/// 把放大后的窗口夹回可见屏幕，避免右侧/底部被推出屏幕。
#[tauri::command]
pub fn move_pet_window(app: AppHandle, delta_x: i32, delta_y: i32) -> Result<(), String> {
    pet_window::move_pet_window(&app, delta_x, delta_y)
}

/// 拖拽收尾：把桌宠窗口当前位置落盘，不做显示器夹取。
///
/// 位置由前端按宠物本体边界夹好（贴边也算合法），整窗夹取会在松手瞬间把宠物从
/// 屏幕边缘推开；见 `desktop::pet::persist_pet_window_position` 的文档。
#[tauri::command]
pub fn persist_pet_window_position(app: AppHandle) -> Result<(), String> {
    pet_window::persist_pet_window_position(&app)
}

/// 串行化桌宠窗口的可见性操作，保证「关闭 → 再启用」按调用顺序执行。
fn pet_window_op_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// 把窗口可见性操作丢到异步运行时执行（创建窗口与销毁窗口都**不允许**在主线程调用）。
///
/// # 为什么必须离开主线程
///
/// Tauri 的 command handler 在主线程执行，而 `tauri-runtime-wry` 对主线程上的窗口
/// 生命周期消息是**直接 panic**：
///
/// - `WindowMessage::Destroy`：`panic!("cannot handle \`WindowMessage::Destroy\` on the
///   main thread")`（tauri-runtime-wry 2.11.4 lib.rs:3494）；调用点在 `send_user_message`
///   判定「当前线程 == 主线程」后**同步**派发，因此主线程调 `destroy()` 必崩。
/// - `create_window`：经 channel 等主线程事件循环回包，主线程调用必然死锁
///   （同文件 lib.rs:2757 注释）。
///
/// 之前的 `hide()` 之所以看起来能用，只是因为 `WindowMessage::Hide` 走了不 panic 的分支；
/// 换成销毁后就踩中了这条主线程断言（实测表现为：关闭宠物后 `get_pet_status` 等
/// 全部 invoke 超时、主 webview 一起卡住）。
fn defer_pet_window_op(app: &AppHandle, visible: bool) -> Result<(), String> {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // 串行锁：并发/快速连点的关闭与启用不会交错，最终态等于最后一次调用。
        let _guard = pet_window_op_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Err(error) = pet_window::set_pet_window_visible(&app, visible) {
            log::error!("PET_WINDOW_VISIBILITY_FAILED: visible={visible}: {error}");
            let status = status_from_setting(
                &config::get_store_dat_setting(&app),
                &default_active_pet(&app),
            );
            emit_pet_status(&app, &status);
        }
    });
    Ok(())
}

/// pet 窗口点击穿透开关；返回实际生效的穿透态，前端据此对齐本地 optimistic 状态。
///
/// # 为什么不直接用 `setIgnoreCursorEvents`（issue #437）
///
/// Linux 下 tao 处理 `CursorIgnoreEvents(true)` 时对 GtkWindow 的底层 GdkWindow
/// 直接 `unwrap()`（tao 0.35.3 event_loop.rs:457，截至 0.37.0 上游仍未修复），
/// 窗口从未显示（未 realize，GdkWindow 不存在）即 panic；panic 发生在 GTK
/// 事件循环回调里无法回卷 → SIGABRT，整个桌面端崩溃。而本应用在 setup 阶段
/// 总会预创建隐藏的 pet 窗口（`desktop::pet::init_pet_window`，全新安装默认
/// 不启用桌宠则永远不 show），其 webview 仍会加载 pet.html 并在收到首个全局
/// 鼠标事件时请求穿透——这正是 v0.11.0 初始化阶段必崩的路径。
///
/// 因此所有穿透切换必须经由此命令：窗口不可见（GTK 未 map，必然未 realize）
/// 时吞掉 `true` 请求并返回未生效；`false`（恢复接收事件）在 tao 走无 unwrap
/// 的分支，始终安全转发。GTK 窗口 hide 只 unmap 不 unrealize，首次 show 之后
/// GdkWindow 持续存在，故「可见 ⇒ 转发安全」。
#[tauri::command]
pub fn set_pet_ignore_cursor_events(window: WebviewWindow, ignore: bool) -> Result<bool, String> {
    if window.label() != pet_window::PET_WINDOW_LABEL {
        return Err(
            "PET_WINDOW_LABEL_MISMATCH: this command is restricted to the pet window".to_string(),
        );
    }
    if ignore {
        let visible = window
            .is_visible()
            .map_err(|error| format!("PET_WINDOW_STATE_FAILED: {error}"))?;
        if !visible {
            // 隐藏窗口的穿透无意义：吞掉并上报「未生效」，避免 tao 在未
            // realize 窗口上的 unwrap panic（issue #437）。
            return Ok(false);
        }
    }
    window
        .set_ignore_cursor_events(ignore)
        .map_err(|error| format!("PET_CURSOR_IGNORE_FAILED: {error}"))?;
    Ok(ignore)
}

/// 返回来源对应的真实目录；chat 直接使用 `$DSH_HOME/pets`，codex 直接使用
/// 用户主目录下的 `.codex/pets`，均不经过应用 AppData。
fn pets_dir(app: &AppHandle, source: PetSource) -> Result<PathBuf, String> {
    match source {
        PetSource::Chat => Ok(config::get_dsh_data_path(app).join("pets")),
        PetSource::Codex => app
            .path()
            .home_dir()
            .map(|home| home.join(".codex").join("pets"))
            .map_err(|error| format!("PET_HOME_DIR_FAILED: failed to resolve home dir: {error}")),
    }
}

fn valid_manifest_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || value == '-' || value == '_')
}

fn validate_manifest_id(id: &str) -> Result<(), String> {
    if valid_manifest_id(id) {
        Ok(())
    } else {
        Err("PET_ID_INVALID: manifest id must be 1..=64 ascii letters/digits/-/_".to_string())
    }
}

fn qualified_id(source: PetSource, manifest_id: &str) -> String {
    format!("{}:{manifest_id}", source.as_str())
}

fn parse_qualified_id(id: &str) -> Result<(PetSource, &str), String> {
    let (source, manifest_id) = id
        .split_once(':')
        .ok_or_else(|| "PET_ID_INVALID: filesystem pet id must be source-qualified".to_string())?;
    let source = PetSource::parse(source)?;
    validate_manifest_id(manifest_id)?;
    Ok((source, manifest_id))
}

/// 校验激活宠物 id：预设宠物（安全字符集）或来源限定 id。
fn validate_active_pet_id(id: &str) -> Result<(), String> {
    if crate::bridge::preset_pet::safe_preset_id(id) {
        return Ok(());
    }
    parse_qualified_id(id).map(|_| ())
}

/// 路径只允许普通相对组件；显式拒绝反斜杠和冒号，以便 Unix 上的校验结果也能
/// 覆盖 Windows 的目录分隔符、盘符与 NTFS ADS 语义。
fn safe_relative_path(value: &str) -> Result<PathBuf, String> {
    if value.is_empty() || value.contains('\0') || value.contains('\\') || value.contains(':') {
        return Err("PET_PATH_INVALID: path must be a portable relative path".to_string());
    }
    let mut result = PathBuf::new();
    for component in Path::new(value).components() {
        match component {
            Component::Normal(part) if !part.is_empty() => {
                let name = part.to_string_lossy();
                let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
                if name.ends_with(['.', ' '])
                    || name.chars().any(|c| c < ' ' || "<>\"|?*".contains(c))
                    || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                    || (stem.len() == 4
                        && (stem.starts_with("COM") || stem.starts_with("LPT"))
                        && matches!(stem.as_bytes()[3], b'1'..=b'9'))
                {
                    return Err(
                        "PET_PATH_INVALID: path contains a nonportable filename".to_string()
                    );
                }
                result.push(part);
            }
            _ => {
                return Err(
                    "PET_PATH_INVALID: path must not be absolute or contain traversal".to_string(),
                )
            }
        }
    }
    if result.as_os_str().is_empty() {
        return Err("PET_PATH_INVALID: path must not be empty".to_string());
    }
    Ok(result)
}

/// 限量读取文件，避免列表缩略图和渲染接口把异常大文件塞进 IPC。
fn read_bounded_file(path: &Path, limit: u64, prefix: &str) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path)
        .map_err(|error| format!("{prefix}: failed to read {}: {error}", path.display()))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("{prefix}: failed to read {}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("{prefix}: {} is not a file", path.display()));
    }
    if metadata.len() > limit {
        return Err(format!(
            "{prefix}: {} exceeds the {limit} byte limit",
            path.display()
        ));
    }
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
    file.take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| format!("{prefix}: failed to read {}: {error}", path.display()))?;
    if bytes.len() as u64 > limit {
        return Err(format!(
            "{prefix}: {} exceeds the {limit} byte limit",
            path.display()
        ));
    }
    Ok(bytes)
}

fn parse_manifest_bytes(bytes: &[u8]) -> Result<PetManifest, String> {
    let manifest: PetManifest = serde_json::from_slice(bytes)
        .map_err(|error| format!("PET_MANIFEST_INVALID: invalid pet.json: {error}"))?;
    validate_manifest_id(&manifest.id)?;
    if let Some(version) = manifest.sprite_version_number {
        if version != PET_SPRITE_V1 && version != PET_SPRITE_V2 {
            return Err(format!(
                "PET_SPRITE_VERSION_UNSUPPORTED: spriteVersionNumber must be {PET_SPRITE_V1} or {PET_SPRITE_V2}"
            ));
        }
    }
    match manifest.kind.as_deref() {
        Some("dsh") => {
            for path in [
                manifest.config_path.as_deref(),
                manifest.uri_path.as_deref(),
                manifest.preview_path.as_deref(),
            ] {
                safe_relative_path(path.ok_or_else(|| {
                    "PET_MANIFEST_INVALID: dsh requires configPath, uriPath and previewPath"
                        .to_string()
                })?)?;
            }
            if let Some(path) = &manifest.mac_uri_path {
                safe_relative_path(path)?;
            }
            let ext = manifest
                .ext
                .as_ref()
                .ok_or_else(|| "PET_MANIFEST_INVALID: dsh requires ext".to_string())?;
            if ext.default != "webm"
                || ext
                    .mac
                    .as_deref()
                    .is_some_and(|ext| ext != "mov" && ext != "webm")
                || (manifest.mac_uri_path.is_some() && ext.mac.as_deref() != Some("mov"))
                || (ext.mac.as_deref() == Some("mov") && manifest.mac_uri_path.is_none())
            {
                return Err(
                    "PET_MANIFEST_INVALID: dsh ext must be webm (default) / mov (mac)".to_string(),
                );
            }
            if manifest
                .size
                .is_some_and(|size| !size.is_finite() || size <= 0.0 || size > 4096.0)
            {
                return Err("PET_MANIFEST_INVALID: size must be within 0..=4096".to_string());
            }
        }
        // 图集宠物不认 `kind`：外部生态用它标注宠物类别（如 person/pet），只以 `spritesheetPath` 为准。
        _ => {
            safe_relative_path(&manifest.spritesheet_path)?;
        }
    }
    Ok(manifest)
}

fn read_manifest(directory: &Path) -> Result<PetManifest, String> {
    let bytes = read_bounded_file(
        &contained_file(directory, "pet.json")?,
        PET_MANIFEST_MAX_BYTES,
        "PET_MANIFEST_READ_FAILED",
    )?;
    parse_manifest_bytes(&bytes)
}

/// 跟随符号链接后仍必须留在宠物目录中；导入包本身则会更早直接拒绝链接条目。
fn contained_file(directory: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = safe_relative_path(relative)?;
    let root = directory.canonicalize().map_err(|error| {
        format!(
            "PET_ASSET_READ_FAILED: failed to resolve {}: {error}",
            directory.display()
        )
    })?;
    let candidate = directory
        .join(relative)
        .canonicalize()
        .map_err(|error| format!("PET_ASSET_READ_FAILED: failed to resolve asset: {error}"))?;
    if !candidate.starts_with(&root) {
        return Err("PET_PATH_INVALID: path escapes the pet directory".to_string());
    }
    Ok(candidate)
}

/// 图集网格：列恒为 8，行数由版本决定（v1=9 / v2=11）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SpriteGrid {
    version: u8,
    columns: u8,
    rows: u8,
}

/// 由图集高度确定网格，清单声明的版本只在两种布局都整除时用于消歧。
///
/// 声明与图集比例不符时以图集为准：旧版 8x9 图集沿用缺省 v2 声明（或清单漏写版本）
/// 是常见写法，按声明拒绝会让整个宠物无法导入。
fn sprite_grid(declared: Option<u8>, width: u32, height: u32) -> Result<SpriteGrid, String> {
    if !width.is_multiple_of(u32::from(PET_SPRITE_COLUMNS)) {
        return Err(format!(
            "PET_ASSET_DIMENSIONS_INVALID: spritesheet width must be divisible by {PET_SPRITE_COLUMNS} columns"
        ));
    }
    let v1 = height.is_multiple_of(u32::from(PET_SPRITE_V1_ROWS));
    let v2 = height.is_multiple_of(u32::from(PET_SPRITE_V2_ROWS));
    let version = match (v1, v2) {
        (false, false) => {
            return Err(format!(
                "PET_ASSET_DIMENSIONS_INVALID: spritesheet height must be divisible by {PET_SPRITE_V1_ROWS} (v1) or {PET_SPRITE_V2_ROWS} (v2) rows"
            ))
        }
        (true, false) => PET_SPRITE_V1,
        (false, true) => PET_SPRITE_V2,
        (true, true) => declared.unwrap_or(PET_SPRITE_V2),
    };
    Ok(SpriteGrid {
        version,
        columns: PET_SPRITE_COLUMNS,
        rows: if version == PET_SPRITE_V1 {
            PET_SPRITE_V1_ROWS
        } else {
            PET_SPRITE_V2_ROWS
        },
    })
}

fn spritesheet_dimensions(
    bytes: &[u8],
    declared: Option<u8>,
) -> Result<(&'static str, SpriteGrid), String> {
    let (mime, width, height) = if bytes.len() >= 24 && bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        if &bytes[12..16] != b"IHDR" {
            return Err("PET_ASSET_FORMAT_INVALID: PNG is missing IHDR".to_string());
        }
        (
            "image/png",
            u32::from_be_bytes(bytes[16..20].try_into().unwrap()),
            u32::from_be_bytes(bytes[20..24].try_into().unwrap()),
        )
    } else if bytes.len() >= 30 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        let chunk = &bytes[12..16];
        let (width, height) = match chunk {
            b"VP8X" if bytes.len() >= 30 => (
                1 + u32::from(bytes[24])
                    + (u32::from(bytes[25]) << 8)
                    + (u32::from(bytes[26]) << 16),
                1 + u32::from(bytes[27])
                    + (u32::from(bytes[28]) << 8)
                    + (u32::from(bytes[29]) << 16),
            ),
            b"VP8L" if bytes.len() >= 25 && bytes[20] == 0x2f => (
                1 + u32::from(bytes[21]) + ((u32::from(bytes[22]) & 0x3f) << 8),
                1 + (u32::from(bytes[22]) >> 6)
                    + (u32::from(bytes[23]) << 2)
                    + ((u32::from(bytes[24]) & 0x0f) << 10),
            ),
            b"VP8 " if bytes.len() >= 30 && bytes[23..26] == [0x9d, 0x01, 0x2a] => (
                u32::from(u16::from_le_bytes([bytes[26], bytes[27]]) & 0x3fff),
                u32::from(u16::from_le_bytes([bytes[28], bytes[29]]) & 0x3fff),
            ),
            _ => {
                return Err(
                    "PET_ASSET_FORMAT_INVALID: unsupported or malformed WebP header".to_string(),
                )
            }
        };
        ("image/webp", width, height)
    } else {
        return Err("PET_ASSET_FORMAT_INVALID: spritesheet must be PNG or WebP".to_string());
    };

    let pixels = u64::from(width) * u64::from(height);
    if width == 0
        || height == 0
        || width > PET_SPRITESHEET_MAX_DIMENSION
        || height > PET_SPRITESHEET_MAX_DIMENSION
        || pixels > PET_SPRITESHEET_MAX_PIXELS
    {
        return Err(format!(
            "PET_ASSET_DIMENSIONS_INVALID: spritesheet dimensions exceed {PET_SPRITESHEET_MAX_DIMENSION}px or {PET_SPRITESHEET_MAX_PIXELS} pixels"
        ));
    }
    Ok((mime, sprite_grid(declared, width, height)?))
}

/// 读取并校验精灵图，返回可直接渲染的 data URL 与它的真实网格。
fn read_spritesheet(
    directory: &Path,
    relative: &str,
    declared: Option<u8>,
) -> Result<(String, SpriteGrid), String> {
    let path = contained_file(directory, relative)?;
    let bytes = read_bounded_file(&path, PET_SPRITESHEET_MAX_BYTES, "PET_ASSET_READ_FAILED")?;
    let (mime, grid) = spritesheet_dimensions(&bytes, declared)?;
    Ok((
        format!("data:{mime};base64,{}", STANDARD.encode(bytes)),
        grid,
    ))
}

fn image_data_url(
    directory: &Path,
    relative: &str,
    declared: Option<u8>,
) -> Result<String, String> {
    read_spritesheet(directory, relative, declared).map(|(url, _)| url)
}

fn validate_pet_source(source: PetSource, manifest: &PetManifest) -> Result<(), String> {
    if source == PetSource::Codex && manifest.kind.as_deref() == Some("dsh") {
        return Err("PET_KIND_FORBIDDEN: Codex pets must use spritesheets".to_string());
    }
    Ok(())
}

fn gif_data_url(directory: &Path, relative: &str) -> Result<String, String> {
    let path = contained_file(directory, relative)?;
    let bytes = read_bounded_file(&path, PET_SPRITESHEET_MAX_BYTES, "PET_PREVIEW_READ_FAILED")?;
    if bytes.len() < 13 || (!bytes.starts_with(b"GIF87a") && !bytes.starts_with(b"GIF89a")) {
        return Err("PET_PREVIEW_INVALID: preview must have a GIF header".to_string());
    }
    let width = u16::from_le_bytes([bytes[6], bytes[7]]);
    let height = u16::from_le_bytes([bytes[8], bytes[9]]);
    if width == 0 || width != height || width > PET_PREVIEW_MAX_DIMENSION {
        return Err("PET_PREVIEW_INVALID: GIF must be square and within 1..=4096px".to_string());
    }
    Ok(format!("data:image/gif;base64,{}", STANDARD.encode(bytes)))
}

fn animation_names(config: &Value) -> Result<HashSet<String>, String> {
    fn collect(value: &Value, names: &mut HashSet<String>) -> Result<(), String> {
        let values = match value {
            Value::String(_) => std::slice::from_ref(value),
            Value::Array(values) => values.as_slice(),
            _ => {
                return Err(
                    "PET_CONFIG_INVALID: animation slot must be a string or string array"
                        .to_string(),
                )
            }
        };
        for value in values {
            let name = value.as_str().ok_or_else(|| {
                "PET_CONFIG_INVALID: animation pool must contain strings".to_string()
            })?;
            safe_relative_path(name)?;
            names.insert(name.to_string());
        }
        Ok(())
    }
    fn collect_map(value: &Value, names: &mut HashSet<String>, events: bool) -> Result<(), String> {
        let values = value
            .as_object()
            .ok_or_else(|| "PET_CONFIG_INVALID: motions/events must be objects".to_string())?;
        for value in values.values() {
            if events {
                for slot in value.as_array().ok_or_else(|| {
                    "PET_CONFIG_INVALID: event must contain an array of animation slots".to_string()
                })? {
                    collect(slot, names)?;
                }
            } else {
                collect(value, names)?;
            }
        }
        Ok(())
    }
    let mut names = HashSet::new();
    if let Some(motions) = config.get("motions") {
        collect_map(motions, &mut names, false)?;
    }
    if let Some(animations) = config.get("animations") {
        if !animations.is_object() {
            return Err("PET_CONFIG_INVALID: animations must be an object".to_string());
        }
        for key in ["idle", "turn", "drag", "clicks"] {
            if let Some(pool) = animations.get(key) {
                if !pool.is_array() {
                    return Err(format!(
                        "PET_CONFIG_INVALID: animations.{key} must be an array"
                    ));
                }
                collect(pool, &mut names)?;
            }
        }
        for (key, events) in [("motions", false), ("events", true)] {
            if let Some(pool) = animations.get(key) {
                collect_map(pool, &mut names, events)?;
            }
        }
        if let Some(moves) = animations.get("moves") {
            if !moves.is_object() || !moves.get("actions").is_some_and(Value::is_array) {
                return Err("PET_CONFIG_INVALID: moves requires an actions array".to_string());
            }
        }
        if let Some(actions) = animations.pointer("/moves/actions") {
            let actions = actions
                .as_array()
                .ok_or_else(|| "PET_CONFIG_INVALID: moves.actions must be an array".to_string())?;
            for action in actions {
                if !action.get("name").is_some_and(Value::is_string) {
                    return Err("PET_CONFIG_INVALID: move requires a string name".to_string());
                }
                collect(
                    action
                        .get("name")
                        .ok_or_else(|| "PET_CONFIG_INVALID: move requires name".to_string())?,
                    &mut names,
                )?;
            }
        }
        if let Some(categories) = animations.get("categories") {
            let categories = categories
                .as_array()
                .ok_or_else(|| "PET_CONFIG_INVALID: categories must be an array".to_string())?;
            for category in categories {
                let actions = category
                    .get("actions")
                    .filter(|value| value.is_array())
                    .ok_or_else(|| {
                        "PET_CONFIG_INVALID: category requires an actions array".to_string()
                    })?;
                collect(actions, &mut names)?;
            }
        }
    }
    if names.is_empty() {
        return Err("PET_CONFIG_INVALID: config must reference at least one animation".to_string());
    }
    Ok(names)
}

fn read_dsh_asset(
    directory: &Path,
    manifest: &PetManifest,
    id: String,
) -> Result<(PetAsset, Vec<PathBuf>), String> {
    let path = contained_file(directory, manifest.config_path.as_deref().unwrap())?;
    let bytes = read_bounded_file(&path, PET_CONFIG_MAX_BYTES, "PET_CONFIG_READ_FAILED")?;
    let raw =
        std::str::from_utf8(&bytes).map_err(|error| format!("PET_CONFIG_INVALID: {error}"))?;
    let config: Value = serde_json::from_str(&config::manifest::strip_jsonc(raw))
        .map_err(|error| format!("PET_CONFIG_INVALID: {error}"))?;
    if !config.is_object() {
        return Err("PET_CONFIG_INVALID: config must be an object".to_string());
    }
    let names = animation_names(&config)?;
    let ext = manifest.ext.as_ref().unwrap();
    let mut files = Vec::new();
    let mut uri = config::manifest::PresetPetUri {
        default: String::new(),
        mac: None,
    };
    for (relative, extension, mac) in [
        (
            manifest.uri_path.as_deref(),
            Some(ext.default.as_str()),
            false,
        ),
        (manifest.mac_uri_path.as_deref(), ext.mac.as_deref(), true),
    ] {
        let Some(relative) = relative else { continue };
        let extension = extension.unwrap();
        let base = contained_file(directory, relative)?;
        if !base.is_dir() {
            return Err("PET_PATH_INVALID: uriPath must be a directory".to_string());
        }
        for name in &names {
            let path = contained_file(directory, &format!("{relative}/{name}.{extension}"))?;
            let metadata =
                fs::metadata(&path).map_err(|error| format!("PET_ASSET_READ_FAILED: {error}"))?;
            if !metadata.is_file() || metadata.len() == 0 || metadata.len() > PET_VIDEO_MAX_BYTES {
                return Err(
                    "PET_ASSET_INVALID: video must be a nonempty file within 512MiB".to_string(),
                );
            }
            files.push(path);
        }
        let path = dunce::simplified(&base)
            .to_str()
            .ok_or_else(|| "PET_PATH_INVALID: asset directory must be UTF-8".to_string())?
            .to_string();
        if mac {
            uri.mac = Some(path);
        } else {
            uri.default = path;
        }
    }
    gif_data_url(directory, manifest.preview_path.as_deref().unwrap())?;
    files.sort();
    files.dedup();
    Ok((
        PetAsset::Dsh {
            id,
            config,
            uri,
            ext: ext.clone(),
            size: manifest.size,
        },
        files,
    ))
}

fn manifest_to_list_item(
    source: PetSource,
    directory: &Path,
    manifest: PetManifest,
) -> PetListItem {
    let name = manifest
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&manifest.id)
        .to_string();
    let description = manifest
        .description
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let is_dsh = manifest.kind.as_deref() == Some("dsh");
    let thumbnail = if is_dsh {
        gif_data_url(directory, manifest.preview_path.as_deref().unwrap()).ok()
    } else {
        image_data_url(
            directory,
            &manifest.spritesheet_path,
            manifest.sprite_version_number,
        )
        .ok()
    };
    PetListItem {
        id: qualified_id(source, &manifest.id),
        name,
        description,
        thumbnail,
        source: source.as_str().to_string(),
        kind: if is_dsh { "dsh" } else { "codex" }.to_string(),
        thumbnail_type: if is_dsh { "gif" } else { "spritesheet" }.to_string(),
    }
}

fn immediate_pet_directories(root: &Path) -> Result<Vec<PathBuf>, String> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!(
                "PET_LIST_FAILED: failed to read {}: {error}",
                root.display()
            ))
        }
    };
    let mut directories = Vec::new();
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() && !file_type.is_symlink() {
            directories.push(entry.path());
        }
    }
    directories.sort();
    Ok(directories)
}

/// 列出指定来源目录中的清单。损坏的单个宠物会被忽略，不阻断其余可用宠物。
#[tauri::command]
pub fn list_pets(app: AppHandle, source: String) -> Result<Vec<PetListItem>, String> {
    let source = PetSource::parse(source.trim())?;
    let root = pets_dir(&app, source)?;
    let mut items = Vec::new();
    let mut ids = HashSet::new();
    for directory in immediate_pet_directories(&root)? {
        let Ok(manifest) = read_manifest(&directory) else {
            continue;
        };
        if validate_pet_source(source, &manifest).is_err() {
            continue;
        }
        let id = qualified_id(source, &manifest.id);
        if ids.insert(id) {
            items.push(manifest_to_list_item(source, &directory, manifest));
        }
    }
    items.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(items)
}

fn find_pet_directory(
    root: &Path,
    manifest_id: &str,
) -> Result<Option<(PathBuf, PetManifest)>, String> {
    for directory in immediate_pet_directories(root)? {
        let Ok(manifest) = read_manifest(&directory) else {
            continue;
        };
        if manifest.id == manifest_id {
            return Ok(Some((directory, manifest)));
        }
    }
    Ok(None)
}

/// 按来源限定 id 读取真实精灵图。
#[tauri::command]
pub fn get_pet_asset(app: AppHandle, id: String) -> Result<PetAsset, String> {
    let id = id.trim();
    let (source, manifest_id) = parse_qualified_id(id)?;
    let root = pets_dir(&app, source)?;
    let (directory, manifest) = find_pet_directory(&root, manifest_id)?.ok_or_else(|| {
        format!(
            "PET_NOT_FOUND: pet {} was not found",
            qualified_id(source, manifest_id)
        )
    })?;
    validate_pet_source(source, &manifest)?;
    if manifest.kind.as_deref() == Some("dsh") {
        let (asset, files) = read_dsh_asset(&directory, &manifest, id.to_string())?;
        let scope = app.asset_protocol_scope();
        for file in files {
            scope
                .allow_file(file)
                .map_err(|error| format!("PET_ASSET_SCOPE_FAILED: {error}"))?;
        }
        return Ok(asset);
    }
    let (spritesheet, grid) = read_spritesheet(
        &directory,
        &manifest.spritesheet_path,
        manifest.sprite_version_number,
    )?;
    Ok(PetAsset::Codex {
        id: qualified_id(source, &manifest.id),
        spritesheet,
        sprite_version_number: grid.version,
        columns: grid.columns,
        rows: grid.rows,
    })
}

fn pet_import_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// zip 条目额外拒绝符号链接与其他特殊 Unix 文件类型。
fn safe_archive_entry(name: &str, unix_mode: Option<u32>) -> Result<PathBuf, String> {
    if let Some(mode) = unix_mode {
        let file_type = mode & 0o170000;
        if file_type != 0 && file_type != 0o040000 && file_type != 0o100000 {
            return Err("PET_ARCHIVE_LINK_FORBIDDEN: archive links are not allowed".to_string());
        }
    }
    safe_relative_path(name.trim_end_matches('/'))
}

/// 归档里与宠物无关的条目：操作系统元数据（macOS Finder 的 `__MACOSX` 资源叉、
/// AppleDouble `._*`、`.DS_Store`，Windows 的 `Thumbs.db`/`desktop.ini`）与本应用
/// 在 `~/.codex/pets` 下的导入暂存目录。整理/压缩宠物目录时它们几乎必然出现，
/// 参与布局判定会把正常包误判成「多根归档」。
fn ignored_archive_entry(path: &Path) -> bool {
    path.components().any(|component| {
        let Component::Normal(part) = component else {
            return false;
        };
        let name = part.to_string_lossy();
        matches!(
            name.as_ref(),
            "__MACOSX" | ".DS_Store" | "Thumbs.db" | "desktop.ini" | ".staging"
        ) || name.starts_with("._")
    })
}

/// 定位归档里唯一的 `pet.json`，返回需要剥离的前缀（`None` = 清单就在归档根）。
///
/// 包装目录层数不设限：把 `~/.codex/pets` 或 `<id>/` 整体压缩都会带上包装目录，
/// 只要除元数据外所有条目都位于同一个 `pet.json` 所在目录下（或本身就是该目录的
/// 上级包装目录），就是一个有效包。
fn archive_root_prefix(paths: &[(PathBuf, bool)]) -> Result<Option<PathBuf>, String> {
    let manifests = paths
        .iter()
        .filter(|(path, is_dir)| {
            !is_dir
                && !ignored_archive_entry(path)
                && path.file_name().and_then(|value| value.to_str()) == Some("pet.json")
        })
        .map(|(path, _)| path.clone())
        .collect::<Vec<_>>();
    if manifests.len() != 1 {
        return Err(
            "PET_ARCHIVE_LAYOUT_INVALID: archive must contain exactly one pet.json".to_string(),
        );
    }
    let prefix = match manifests[0].parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
        _ => return Ok(None),
    };
    if paths.iter().any(|(path, is_dir)| {
        !ignored_archive_entry(path)
            && !path.starts_with(&prefix)
            && !(*is_dir && prefix.starts_with(path))
    }) {
        return Err(
            "PET_ARCHIVE_LAYOUT_INVALID: archive must have exactly one supported root".to_string(),
        );
    }
    Ok(Some(prefix))
}

/// 流式复制时按实际解压字节数截断，不能只信任 zip 中声明的文件大小。
fn copy_archive_entry<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    total: &mut u64,
    limit: u64,
) -> Result<(), String> {
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let remaining = limit.saturating_sub(*total);
        if remaining == 0 {
            let mut probe = [0_u8; 1];
            let count = reader.read(&mut probe).map_err(|error| {
                format!("PET_ARCHIVE_EXTRACT_FAILED: failed to read archive entry: {error}")
            })?;
            if count == 0 {
                return Ok(());
            }
            return Err(format!(
                "PET_ARCHIVE_TOO_LARGE: uncompressed files must not exceed {limit} bytes"
            ));
        }
        let chunk_limit = usize::try_from(remaining)
            .unwrap_or(usize::MAX)
            .min(buffer.len());
        let count = reader.read(&mut buffer[..chunk_limit]).map_err(|error| {
            format!("PET_ARCHIVE_EXTRACT_FAILED: failed to read archive entry: {error}")
        })?;
        if count == 0 {
            return Ok(());
        }
        writer.write_all(&buffer[..count]).map_err(|error| {
            format!("PET_ARCHIVE_EXTRACT_FAILED: failed to write archive entry: {error}")
        })?;
        *total = total
            .checked_add(count as u64)
            .ok_or_else(|| "PET_ARCHIVE_TOO_LARGE: uncompressed size overflow".to_string())?;
    }
}

/// 两遍处理 zip：先完整验证路径、类型和声明大小，再向 staging 写入。
fn extract_pet_archive(bytes: &[u8], staging: &Path) -> Result<PetManifest, String> {
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| format!("PET_ARCHIVE_INVALID: failed to open zip: {error}"))?;
    if archive.is_empty() || archive.len() > PET_PACKAGE_MAX_ENTRIES {
        return Err(format!(
            "PET_ARCHIVE_ENTRY_LIMIT: archive must contain 1..={PET_PACKAGE_MAX_ENTRIES} entries"
        ));
    }

    let mut paths = Vec::with_capacity(archive.len());
    let mut declared_total = 0_u64;
    for index in 0..archive.len() {
        let file = archive
            .by_index(index)
            .map_err(|error| format!("PET_ARCHIVE_INVALID: failed to read entry: {error}"))?;
        let path = safe_archive_entry(file.name(), file.unix_mode())?;
        if ignored_archive_entry(&path) {
            continue;
        }
        let is_dir = file.is_dir();
        if !is_dir {
            declared_total = declared_total
                .checked_add(file.size())
                .ok_or_else(|| "PET_ARCHIVE_TOO_LARGE: uncompressed size overflow".to_string())?;
            if declared_total > PET_PACKAGE_MAX_UNCOMPRESSED_BYTES {
                return Err(format!(
                    "PET_ARCHIVE_TOO_LARGE: uncompressed files must not exceed {PET_PACKAGE_MAX_UNCOMPRESSED_BYTES} bytes"
                ));
            }
        }
        paths.push((path, is_dir));
    }
    let prefix = archive_root_prefix(&paths)?;

    fs::create_dir(staging).map_err(|error| {
        format!("PET_IMPORT_STAGING_FAILED: failed to create staging directory: {error}")
    })?;
    let mut outputs = HashSet::new();
    let mut actual_total = 0_u64;
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|error| format!("PET_ARCHIVE_INVALID: failed to read entry: {error}"))?;
        let path = safe_archive_entry(file.name(), file.unix_mode())?;
        if ignored_archive_entry(&path) {
            continue;
        }
        let relative = match prefix.as_deref() {
            // wrapper 自身的条目与它的上级包装目录条目（如 `pets/`）都不含内容；
            // 布局校验已确认上级条目只能是目录。
            Some(wrapper) => match path.strip_prefix(wrapper) {
                Ok(relative) => relative,
                Err(_) => continue,
            },
            None => path.as_path(),
        };
        if relative.as_os_str().is_empty() || !outputs.insert(relative.to_path_buf()) {
            if relative.as_os_str().is_empty() {
                continue;
            }
            return Err("PET_ARCHIVE_DUPLICATE_ENTRY: duplicate output path".to_string());
        }
        let output_path = staging.join(relative);
        if file.is_dir() {
            fs::create_dir_all(&output_path).map_err(|error| {
                format!("PET_ARCHIVE_EXTRACT_FAILED: failed to create directory: {error}")
            })?;
            continue;
        }
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!("PET_ARCHIVE_EXTRACT_FAILED: failed to create directory: {error}")
            })?;
        }
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output_path)
            .map_err(|error| {
                format!("PET_ARCHIVE_EXTRACT_FAILED: failed to create file: {error}")
            })?;
        copy_archive_entry(
            &mut file,
            &mut output,
            &mut actual_total,
            PET_PACKAGE_MAX_UNCOMPRESSED_BYTES,
        )?;
    }

    let manifest = read_manifest(staging)?;
    validate_pet_source(PetSource::Codex, &manifest)?;
    image_data_url(
        staging,
        &manifest.spritesheet_path,
        manifest.sprite_version_number,
    )?;
    Ok(manifest)
}

fn unique_staging_path(staging_root: &Path) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    staging_root.join(format!("import-{}-{nonce}", std::process::id()))
}

fn prepare_staging_root(root: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(root)
        .map_err(|error| format!("PET_DIR_FAILED: failed to create pets directory: {error}"))?;
    let staging_root = root.join(".staging");
    match fs::symlink_metadata(&staging_root) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            Err("PET_IMPORT_STAGING_FAILED: .staging must be a real directory".to_string())
        }
        Ok(_) => Ok(staging_root),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&staging_root).map_err(|error| {
                format!("PET_IMPORT_STAGING_FAILED: failed to create staging directory: {error}")
            })?;
            Ok(staging_root)
        }
        Err(error) => Err(format!(
            "PET_IMPORT_STAGING_FAILED: failed to inspect staging directory: {error}"
        )),
    }
}

fn path_exists_including_symlink(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!(
            "PET_IMPORT_COMMIT_FAILED: failed to inspect target: {error}"
        )),
    }
}

/// 导入 Codex v2 宠物：上传文件名不参与安装路径，只在 `~/.codex/pets` 内按清单 id 提交。
#[tauri::command]
pub fn import_pet(app: AppHandle, name: String, data: String) -> Result<PetListItem, String> {
    // 前端协议仍携带文件名，但文件名可能含 Unicode/空格且属于不可信展示数据。
    let _ = name;
    let encoded_limit = PET_PACKAGE_MAX_BYTES.div_ceil(3) * 4;
    if data.len() > encoded_limit {
        return Err(format!(
            "PET_PACKAGE_TOO_LARGE: pet package must not exceed {PET_PACKAGE_MAX_BYTES} compressed bytes"
        ));
    }
    let bytes = STANDARD
        .decode(data.as_bytes())
        .map_err(|error| format!("PET_PACKAGE_DECODE_FAILED: invalid base64 payload: {error}"))?;
    if bytes.len() > PET_PACKAGE_MAX_BYTES {
        return Err(format!(
            "PET_PACKAGE_TOO_LARGE: pet package must not exceed {PET_PACKAGE_MAX_BYTES} compressed bytes"
        ));
    }

    let root = pets_dir(&app, PetSource::Codex)?;
    let _guard = pet_import_lock()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let staging_root = prepare_staging_root(&root)?;
    let staging = unique_staging_path(&staging_root);
    let result = (|| {
        let manifest = extract_pet_archive(&bytes, &staging)?;
        let target = root.join(&manifest.id);
        if path_exists_including_symlink(&target)? {
            return Err(format!(
                "PET_ALREADY_IMPORTED: Codex pet target {} already exists",
                manifest.id
            ));
        }
        if let Some((existing, _)) = find_pet_directory(&root, &manifest.id)? {
            return Err(format!(
                "PET_ALREADY_IMPORTED: Codex pet id {} already exists at {}",
                manifest.id,
                existing.display()
            ));
        }
        fs::rename(&staging, &target).map_err(|error| {
            format!("PET_IMPORT_COMMIT_FAILED: failed to install Codex pet: {error}")
        })?;
        Ok(manifest_to_list_item(PetSource::Codex, &target, manifest))
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

fn parse_pet_repository(repository: &str) -> Result<(String, String), String> {
    let invalid =
        || "PET_REPOSITORY_INVALID: use owner/repo or https://github.com/owner/repo".to_string();
    let input = repository.trim();
    let path = if input.contains("://") {
        let url = reqwest::Url::parse(input).map_err(|_| invalid())?;
        if url.scheme() != "https"
            || url.host_str() != Some("github.com")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(invalid());
        }
        url.path()
            .trim_start_matches('/')
            .trim_end_matches('/')
            .to_string()
    } else {
        input.to_string()
    };
    let (owner, repo) = path.split_once('/').ok_or_else(invalid)?;
    let repo = repo.strip_suffix(".git").unwrap_or(repo);
    if owner.is_empty()
        || owner.len() > 39
        || owner.starts_with('-')
        || owner.ends_with('-')
        || !owner
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        || repo.is_empty()
        || repo.len() > 100
        || matches!(repo, "." | "..")
        || !repo
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
    {
        return Err(invalid());
    }
    Ok((owner.to_string(), repo.to_string()))
}

fn repository_asset_url(base: &str, relative: &str) -> Result<String, String> {
    let path = safe_relative_path(relative)?;
    let mut url =
        reqwest::Url::parse(base).map_err(|error| format!("PET_REPOSITORY_INVALID: {error}"))?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "PET_REPOSITORY_INVALID: invalid resource base".to_string())?;
        segments.pop_if_empty();
        for part in path.components() {
            segments.push(
                part.as_os_str()
                    .to_str()
                    .ok_or_else(|| "PET_PATH_INVALID: path must be UTF-8".to_string())?,
            );
        }
    }
    Ok(url.to_string())
}

fn repository_spec(
    base: &str,
    name: &str,
    bytes: Option<&[u8]>,
) -> Result<config::manifest::PresetPetSpec, String> {
    let manifest = if let Some(bytes) = bytes {
        parse_manifest_bytes(bytes)?
    } else {
        parse_manifest_bytes(
            &serde_json::to_vec(&serde_json::json!({
                "id": name, "kind": "dsh", "configPath": "config.jsonc", "uriPath": "webm",
                "previewPath": "preview/preview.gif", "ext": {"default": "webm", "mac": "webm"}
            }))
            .map_err(|error| format!("PET_MANIFEST_INVALID: {error}"))?,
        )?
    };
    if manifest.kind.as_deref() != Some("dsh") {
        return Err("PET_KIND_FORBIDDEN: repository pets must use kind dsh".to_string());
    }
    let config = repository_asset_url(base, manifest.config_path.as_deref().unwrap())?;
    let image = repository_asset_url(base, manifest.preview_path.as_deref().unwrap())?;
    let uri = config::manifest::PresetPetUri {
        default: repository_asset_url(base, manifest.uri_path.as_deref().unwrap())?,
        mac: manifest
            .mac_uri_path
            .as_deref()
            .map(|path| repository_asset_url(base, path))
            .transpose()?,
    };
    Ok(config::manifest::PresetPetSpec {
        name: manifest
            .display_name
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| manifest.id.clone()),
        id: manifest.id,
        desc: manifest.description,
        image: Some(image),
        kind: Some("dsh".to_string()),
        size: manifest.size,
        config,
        uri,
        ext: manifest.ext,
    })
}

async fn repository_metadata(
    client: &reqwest::Client,
    url: &str,
    limit: u64,
    optional: bool,
) -> Result<Option<Vec<u8>>, String> {
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("PET_REPOSITORY_DOWNLOAD_FAILED: {error}"))?;
    if optional && response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!(
            "PET_REPOSITORY_DOWNLOAD_FAILED: HTTP {}",
            response.status()
        ));
    }
    if response.content_length().is_some_and(|size| size > limit) {
        return Err("PET_REPOSITORY_TOO_LARGE: metadata exceeds its byte limit".to_string());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("PET_REPOSITORY_DOWNLOAD_FAILED: {error}"))?
    {
        if chunk.len() as u64 > limit.saturating_sub(bytes.len() as u64) {
            return Err("PET_REPOSITORY_TOO_LARGE: metadata exceeds its byte limit".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Some(bytes))
}

async fn read_repository_spec(
    client: &reqwest::Client,
    base: &str,
    name: &str,
    check_media: bool,
) -> Result<config::manifest::PresetPetSpec, String> {
    let manifest = repository_metadata(
        client,
        &repository_asset_url(base, "pet.json")?,
        PET_MANIFEST_MAX_BYTES,
        true,
    )
    .await?;
    let spec = repository_spec(base, name, manifest.as_deref())?;
    let bytes = repository_metadata(client, &spec.config, PET_CONFIG_MAX_BYTES, false)
        .await?
        .unwrap();
    let raw =
        std::str::from_utf8(&bytes).map_err(|error| format!("PET_CONFIG_INVALID: {error}"))?;
    let value: Value = serde_json::from_str(&config::manifest::strip_jsonc(raw))
        .map_err(|error| format!("PET_CONFIG_INVALID: {error}"))?;
    let names = animation_names(&value)?;
    if check_media {
        let ext = spec.ext.as_ref().unwrap();
        let mut urls = vec![spec.image.clone().unwrap()];
        for (uri, extension) in [
            (Some(spec.uri.default.as_str()), Some(ext.default.as_str())),
            (spec.uri.mac.as_deref(), ext.mac.as_deref()),
        ] {
            let Some(uri) = uri else { continue };
            for name in &names {
                urls.push(repository_asset_url(
                    &format!("{uri}/"),
                    &format!("{name}.{}", extension.unwrap()),
                )?);
            }
        }
        futures_util::stream::iter(urls.into_iter().map(|url| async move {
            let response = client
                .head(&url)
                .send()
                .await
                .map_err(|error| format!("PET_REPOSITORY_DOWNLOAD_FAILED: {error}"))?;
            if !response.status().is_success() {
                return Err(format!(
                    "PET_ASSET_INVALID: HTTP {} for {url}",
                    response.status()
                ));
            }
            Ok::<_, String>(())
        }))
        .buffer_unordered(4)
        .try_collect::<Vec<_>>()
        .await?;
    }
    Ok(spec)
}

fn repository_client(app: &AppHandle) -> Result<reqwest::Client, String> {
    config::proxy::http_client_builder(app)?
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("deepseek-harness-desktop")
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|error| format!("PET_REPOSITORY_DOWNLOAD_FAILED: {error}"))
}

pub(super) fn pet_repository_revision(
    spec: &config::manifest::PresetPetSpec,
) -> Result<(String, String, String), String> {
    let url = reqwest::Url::parse(&spec.config)
        .map_err(|error| format!("PET_REPOSITORY_INVALID: {error}"))?;
    let parts: Vec<_> = url.path_segments().into_iter().flatten().collect();
    if url.scheme() != "https"
        || url.host_str() != Some("raw.githubusercontent.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || parts.len() < 4
        || !(parts[2] == "HEAD" || valid_commit(parts[2]))
    {
        return Err("PET_REPOSITORY_INVALID: pet is not a registered GitHub repository".into());
    }
    let (owner, name) = parse_pet_repository(&format!("{}/{}", parts[0], parts[1]))?;
    Ok((owner, name, parts[2].to_string()))
}

fn valid_commit(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|value| value.is_ascii_hexdigit())
}

async fn repository_head(
    client: &reqwest::Client,
    owner: &str,
    name: &str,
) -> Result<String, String> {
    let bytes = repository_metadata(
        client,
        &format!("https://api.github.com/repos/{owner}/{name}/commits/HEAD"),
        PET_CONFIG_MAX_BYTES,
        false,
    )
    .await?
    .unwrap();
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("PET_REPOSITORY_INVALID: {error}"))?;
    value
        .get("sha")
        .and_then(Value::as_str)
        .filter(|sha| valid_commit(sha))
        .map(|sha| sha.to_ascii_lowercase())
        .ok_or_else(|| "PET_REPOSITORY_INVALID: missing commit SHA".into())
}

#[tauri::command]
pub async fn check_pet_updates(app: AppHandle) -> Result<Vec<String>, String> {
    let entries = crate::bridge::preset_pet::list_preset_pets(app.clone())?;
    let client = repository_client(&app)?;
    // ponytail: 仓库提交变化都提示更新；需要排除纯文档提交时改用资源树 SHA。
    Ok(futures_util::stream::iter(
        entries
            .into_iter()
            .filter(|entry| entry.remote)
            .map(|entry| {
                let client = &client;
                async move {
                    let (owner, name, current) = pet_repository_revision(&entry.spec).ok()?;
                    let latest = repository_head(client, &owner, &name).await.ok()?;
                    (current.to_ascii_lowercase() != latest).then_some(entry.spec.id)
                }
            }),
    )
    .buffer_unordered(4)
    .filter_map(|id| async { id })
    .take_until(tokio::time::sleep(Duration::from_secs(12)))
    .collect()
    .await)
}

#[tauri::command]
pub async fn update_pet_repository(
    app: AppHandle,
    id: String,
) -> Result<config::manifest::PresetPetSpec, String> {
    let entry = crate::bridge::preset_pet::list_preset_pets(app.clone())?
        .into_iter()
        .find(|entry| entry.remote && entry.spec.id == id)
        .ok_or_else(|| format!("PET_NOT_FOUND: preset {id} is not registered"))?;
    let (owner, name, _) = pet_repository_revision(&entry.spec)?;
    let spec = tokio::time::timeout(Duration::from_secs(12), async {
        let client = repository_client(&app)?;
        let commit = repository_head(&client, &owner, &name).await?;
        read_repository_spec(
            &client,
            &format!("https://raw.githubusercontent.com/{owner}/{name}/{commit}/"),
            &name,
            true,
        )
        .await
    })
    .await
    .map_err(|_| "PET_REPOSITORY_TIMEOUT: update exceeded 12 seconds".to_string())??;
    let spec = crate::bridge::preset_pet::update_remote_pet(
        &app,
        config::manifest::PresetPetSpec { id, ..spec },
    )?;
    let _ = app.emit_to(pet_window::PET_WINDOW_LABEL, "pet://catalog", &spec.id);
    Ok(spec)
}

#[tauri::command]
pub async fn import_pet_repository(
    app: AppHandle,
    repository: String,
) -> Result<config::manifest::PresetPetSpec, String> {
    let (owner, name) = parse_pet_repository(&repository)?;
    tokio::time::timeout(Duration::from_secs(12), async {
        let client = repository_client(&app)?;
        let commit = repository_head(&client, &owner, &name).await?;
        let base = format!("https://raw.githubusercontent.com/{owner}/{name}/{commit}/");
        let spec = read_repository_spec(&client, &base, &name, false).await?;
        crate::bridge::preset_pet::register_remote_pet(&app, spec)
    })
    .await
    .map_err(|_| "PET_REPOSITORY_TIMEOUT: metadata registration exceeded 12 seconds".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use zip::write::FileOptions;
    use zip::CompressionMethod;

    struct TestDirectory(PathBuf);

    #[tokio::test]
    async fn repository_metadata_skips_media_on_import_and_checks_it_before_update() {
        for (manifest, check_media, missing_media) in [
            (None, false, false),
            (
                Some(
                    r#"{"id":"declared","kind":"dsh","configPath":"assets/config.jsonc","uriPath":"webm","previewPath":"preview/preview.gif","ext":{"default":"webm","mac":"webm"}}"#,
                ),
                false,
                false,
            ),
            (None, true, false),
            (None, true, true),
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let base = format!("http://{}/", listener.local_addr().unwrap());
            let handle = std::thread::spawn(move || {
                let mut paths = Vec::new();
                for index in 0..if check_media { 4 } else { 2 } {
                    let (mut socket, _) = listener.accept().unwrap();
                    let mut request = [0u8; 4096];
                    let count = socket.read(&mut request).unwrap();
                    paths.push(
                        String::from_utf8_lossy(&request[..count])
                            .lines()
                            .next()
                            .unwrap()
                            .to_string(),
                    );
                    let (status, body) = if index == 0 {
                        (
                            if manifest.is_some() {
                                "200 OK"
                            } else {
                                "404 Not Found"
                            },
                            manifest.unwrap_or(""),
                        )
                    } else if index == 1 {
                        ("200 OK", r#"{"animations":{"idle":["idle"]}}"#)
                    } else {
                        (
                            if missing_media && index == 3 {
                                "404 Not Found"
                            } else {
                                "200 OK"
                            },
                            "",
                        )
                    };
                    write!(socket, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                }
                paths
            });
            let client = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap();
            let result = read_repository_spec(&client, &base, "pet", check_media).await;
            let paths = handle.join().unwrap();
            if check_media {
                let mut media = paths[2..].to_vec();
                media.sort();
                assert_eq!(
                    media,
                    [
                        "HEAD /preview/preview.gif HTTP/1.1",
                        "HEAD /webm/idle.webm HTTP/1.1"
                    ]
                );
            }
            if missing_media {
                assert!(result
                    .unwrap_err()
                    .starts_with("PET_ASSET_INVALID: HTTP 404"));
                continue;
            }
            let spec = result.unwrap();
            assert_eq!(
                paths[..2],
                [
                    "GET /pet.json HTTP/1.1",
                    if manifest.is_some() {
                        "GET /assets/config.jsonc HTTP/1.1"
                    } else {
                        "GET /config.jsonc HTTP/1.1"
                    }
                ]
            );
            assert_eq!(
                spec.config,
                format!(
                    "{base}{}",
                    if manifest.is_some() {
                        "assets/config.jsonc"
                    } else {
                        "config.jsonc"
                    }
                )
            );
            assert_eq!(spec.uri.default, format!("{base}webm"));
            assert_eq!(spec.image, Some(format!("{base}preview/preview.gif")));
        }
    }

    #[test]
    fn repository_registration_without_manifest_contains_only_remote_resource_urls() {
        let spec = repository_spec(
            "https://raw.githubusercontent.com/owner/pet/HEAD/",
            "pet",
            None,
        )
        .unwrap();
        assert_eq!(spec.id, "pet");
        assert_eq!(spec.kind.as_deref(), Some("dsh"));
        assert_eq!(
            spec.config,
            "https://raw.githubusercontent.com/owner/pet/HEAD/config.jsonc"
        );
        assert_eq!(
            spec.uri.default,
            "https://raw.githubusercontent.com/owner/pet/HEAD/webm"
        );
        assert_eq!(
            spec.image.as_deref(),
            Some("https://raw.githubusercontent.com/owner/pet/HEAD/preview/preview.gif")
        );
        assert_eq!(spec.ext.unwrap().mac.as_deref(), Some("webm"));
        assert!(spec.uri.mac.is_none());
        assert!(repository_spec(
            "https://raw.githubusercontent.com/o/r/HEAD/",
            "unsafe.name",
            None
        )
        .unwrap_err()
        .starts_with("PET_ID_INVALID:"));
    }

    #[test]
    fn repository_registration_respects_manifest_paths_and_encodes_resource_names() {
        let raw = br#"{"id":"declared","displayName":"Pet","kind":"dsh","configPath":"assets/config.jsonc","uriPath":"assets/webm","macUriPath":"assets/mov","previewPath":"preview/pet.gif","ext":{"default":"webm","mac":"mov"},"size":200}"#;
        let base = "https://raw.githubusercontent.com/o/r/HEAD/";
        let spec = repository_spec(base, "ignored", Some(raw)).unwrap();
        assert_eq!(spec.id, "declared");
        assert_eq!(spec.name, "Pet");
        assert_eq!(spec.size, Some(200.0));
        assert_eq!(
            spec.config,
            "https://raw.githubusercontent.com/o/r/HEAD/assets/config.jsonc"
        );
        assert_eq!(
            spec.uri.mac.as_deref(),
            Some("https://raw.githubusercontent.com/o/r/HEAD/assets/mov")
        );
        assert_eq!(
            repository_asset_url(base, "preview/pet #1.gif").unwrap(),
            "https://raw.githubusercontent.com/o/r/HEAD/preview/pet%20%231.gif"
        );
        for path in [
            "../outside",
            "https://evil.test/c",
            "C:/private",
            "\\private",
        ] {
            assert!(repository_asset_url(base, path)
                .unwrap_err()
                .starts_with("PET_PATH_INVALID:"));
        }
        assert!(repository_spec(
            base,
            "pet",
            Some(br#"{"id":"pet","spritesheetPath":"sprite.webp"}"#)
        )
        .unwrap_err()
        .starts_with("PET_KIND_FORBIDDEN:"));
    }

    #[test]
    fn repository_updates_recover_origin_from_pinned_urls_and_reject_untrusted_targets() {
        let base =
            "https://raw.githubusercontent.com/owner/pet/0123456789abcdef0123456789abcdef01234567/";
        let mut spec = repository_spec(base, "pet", None).unwrap();
        assert_eq!(
            pet_repository_revision(&spec).unwrap(),
            (
                "owner".into(),
                "pet".into(),
                "0123456789abcdef0123456789abcdef01234567".into()
            )
        );
        spec.config = "https://raw.githubusercontent.com/owner/pet/HEAD/config.jsonc".into();
        assert_eq!(pet_repository_revision(&spec).unwrap().2, "HEAD");
        for url in [
            "https://evil.test/o/r/HEAD/c",
            "http://raw.githubusercontent.com/o/r/HEAD/c",
            "https://user@raw.githubusercontent.com/o/r/HEAD/c",
            "https://raw.githubusercontent.com/o/r/main/c",
            "https://raw.githubusercontent.com/o/r/HEAD/c?x=1",
        ] {
            spec.config = url.into();
            assert!(pet_repository_revision(&spec)
                .unwrap_err()
                .starts_with("PET_REPOSITORY_INVALID:"));
        }
    }

    #[test]
    fn repository_input_accepts_only_github_repository_names() {
        for input in ["owner/pet-name", " https://github.com/owner/pet-name.git/ "] {
            assert_eq!(
                parse_pet_repository(input).unwrap(),
                ("owner".to_string(), "pet-name".to_string())
            );
        }
        for input in [
            "",
            "http://github.com/a/b",
            "https://github.com.evil/a/b",
            "https://127.0.0.1/a/b",
            "https://user@github.com/a/b",
            "https://github.com:8080/a/b",
            "https://github.com/a/b?x=1",
            "https://github.com/a/b#main",
            "a/b/tree/main",
            "a/../b",
            "a/b%2fc",
            "a\\b",
            "a/..",
        ] {
            assert!(
                parse_pet_repository(input)
                    .unwrap_err()
                    .starts_with("PET_REPOSITORY_INVALID:"),
                "{input}"
            );
        }
    }

    // ---- 重连日志节流（宿主不可用期间每 2s 一次失败不能刷满日志）----

    #[test]
    fn session_event_of_maps_every_stream_action() {
        // 宿主会话流的 action → 桌宠窗口事件名；clear 是「整批作废」的首帧动作。
        assert_eq!(session_event_of("create"), Some("session:create"));
        assert_eq!(session_event_of("update"), Some("session:update"));
        assert_eq!(session_event_of("remove"), Some("session:remove"));
        assert_eq!(session_event_of("clear"), Some("session:clear"));
        // 未知 action 静默忽略（不 emit），而不是把它拼成事件名。
        assert_eq!(session_event_of("bogus"), None);
    }

    /// 起一个「先回 `prefix` 注释帧、再回一帧 SSE 数据」后关闭的本地服务端，返回其 URL。
    fn spawn_single_frame_sse_server(prefix: &str, action: &str, payload: &str) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind sse port");
        let port = listener.local_addr().expect("read sse port").port();
        let body = format!("{prefix}data: {{\"action\":\"{action}\",\"payload\":{payload}}}\n\n");
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept sse client");
            let mut request = [0u8; 1024];
            let _ = std::io::Read::read(&mut socket, &mut request);
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = std::io::Write::write_all(&mut socket, response.as_bytes());
        });
        format!("http://127.0.0.1:{port}/session/stream")
    }

    /// 宿主宣告累计态已丢弃（接入时已无其他消费者）时必须先整批作废：宿主不会把累计态重放
    /// 给新消费者，桌宠窗口里上一轮的气泡只能靠这一帧清掉（重启后残留气泡的根因）。
    #[tokio::test]
    async fn stream_connect_clears_stale_bubbles_when_host_state_was_dropped() {
        let url = spawn_single_frame_sse_server(": state-lost\n\n", "create", "{\"id\":\"s1\"}");
        let mut actions: Vec<String> = Vec::new();
        consume_pet_session_stream_with(&url, |action, _| actions.push(action.to_string()))
            .await
            .expect("consume single-frame stream");

        assert_eq!(actions, vec!["clear".to_string(), "create".to_string()]);
    }

    /// 没有 state-lost 宣告就说明宿主累计态仍然有效（还有别的消费者挂在流上）：这时宿主
    /// 既不重放也不丢弃状态，清屏会把仍然活着的气泡误杀，因此只能原样保留；心跳注释帧
    /// 同样不得被当成清屏信号。
    #[tokio::test]
    async fn stream_connect_without_state_lost_keeps_live_bubbles() {
        let url = spawn_single_frame_sse_server(": keepalive\n\n", "create", "{\"id\":\"s1\"}");
        let mut actions: Vec<String> = Vec::new();
        consume_pet_session_stream_with(&url, |action, _| actions.push(action.to_string()))
            .await
            .expect("consume single-frame stream");

        assert_eq!(actions, vec!["create".to_string()]);
    }

    /// 连接未建立成功（宿主未就绪，返回非 2xx）时不得清屏：此刻是重连退避中的常态失败，
    /// 桌宠窗口里正在显示的气泡仍然有效，误清会让气泡每 2s 闪没一次。
    #[tokio::test]
    async fn stream_connect_failure_leaves_bubbles_untouched() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind sse port");
        let port = listener.local_addr().expect("read sse port").port();
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept sse client");
            let mut request = [0u8; 1024];
            let _ = std::io::Read::read(&mut socket, &mut request);
            let _ = std::io::Write::write_all(
                &mut socket,
                b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
        });

        let mut actions: Vec<String> = Vec::new();
        let error = consume_pet_session_stream_with(
            &format!("http://127.0.0.1:{port}/session/stream"),
            |action, _| actions.push(action.to_string()),
        )
        .await
        .expect_err("non-2xx stream must fail");

        assert!(error.starts_with("HTTP 502"), "unexpected error: {error}");
        assert!(actions.is_empty(), "no frame may be emitted: {actions:?}");
    }

    fn throttle(relog_interval: Duration) -> PetStreamLogThrottle {
        PetStreamLogThrottle {
            last_state: None,
            last_logged: Instant::now(),
            relog_interval,
        }
    }

    #[test]
    fn pet_stream_throttle_suppresses_identical_failures() {
        // 宿主不可用期间同一条 502 每次重连都复现：只留第一行，其余静默
        let mut throttle = throttle(Duration::from_secs(60));
        assert!(throttle.should_log("HTTP 502 Bad Gateway"));
        assert!(!throttle.should_log("HTTP 502 Bad Gateway"));
        assert!(!throttle.should_log("HTTP 502 Bad Gateway"));

        // 换成另一种坏法 → 立即重新输出，不会被前一种的静默期吞掉
        assert!(throttle.should_log("error decoding response body"));
        // 回到前一种原因同样算状态变化
        assert!(throttle.should_log("HTTP 502 Bad Gateway"));
    }

    #[test]
    fn pet_stream_throttle_relogs_after_interval() {
        // 长时间不可用仍需留痕：到期后重记一次，而不是整段彻底静默
        let mut throttle = throttle(Duration::ZERO);
        assert!(throttle.should_log("HTTP 502 Bad Gateway"));
        assert!(throttle.should_log("HTTP 502 Bad Gateway"));
    }

    #[test]
    fn pet_stream_throttle_keeps_ended_and_error_distinct() {
        // 「正常结束」（宿主重启）与失败是两种状态，不会互相静默掉
        let mut throttle = throttle(Duration::from_secs(60));
        assert!(throttle.should_log(PET_STREAM_ENDED));
        assert!(!throttle.should_log(PET_STREAM_ENDED));
        assert!(throttle.should_log("HTTP 502 Bad Gateway"));
        assert!(throttle.should_log(PET_STREAM_ENDED));
    }

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            Self(
                std::env::temp_dir().join(format!("dsh-pet-{name}-{}-{nonce}", std::process::id())),
            )
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn build_archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = FileOptions::default().compression_method(CompressionMethod::Stored);
        for (name, bytes) in entries {
            if name.ends_with('/') {
                writer.add_directory(*name, options).unwrap();
                continue;
            }
            writer.start_file(*name, options).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn valid_test_webp() -> Vec<u8> {
        let mut bytes = b"RIFF\x16\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00\x00\x00\x00\x00".to_vec();
        bytes.extend_from_slice(&[87, 0, 0, 87, 0, 0]);
        bytes
    }

    #[test]
    fn active_pet_defaults_to_first_preset_when_unset_or_invalid() {
        const DEFAULT: &str = "maid-deepseek-whale";
        // 全新安装默认选中第一只预设宠物：设置页一打开就有选中的卡片，
        // 启用的桌宠窗口也一定有内容可渲染。
        assert_eq!(normalize_active_pet(None, DEFAULT), DEFAULT);
        // 空串是显式清除（设置页「取消选择」），不能被默认值立刻撤销。
        assert_eq!(normalize_active_pet(Some("   "), DEFAULT), "");
        assert_eq!(
            normalize_active_pet(Some(" chat:custom-pet "), DEFAULT),
            "chat:custom-pet",
            "有效 id 应只去除首尾空白"
        );
        assert_eq!(
            normalize_active_pet(Some("codex:custom_pet"), DEFAULT),
            "codex:custom_pet"
        );
        // 未限定 id（预设宠物，安全字符集）与来源限定 id 都是合法激活选择；
        // 只有非法字符集 / 未知来源限定才回落到默认预设（同样是可渲染的宠物）。
        assert_eq!(normalize_active_pet(Some("cat"), DEFAULT), "cat");
        assert_eq!(normalize_active_pet(Some("shiba"), DEFAULT), "shiba");
        for legacy_or_invalid in ["other:pet", "chat:../pet", "bad id", "x/y"] {
            assert_eq!(
                normalize_active_pet(Some(legacy_or_invalid), DEFAULT),
                DEFAULT,
                "旧版或非法 id {legacy_or_invalid} 应回落到默认预设"
            );
        }
    }

    #[test]
    fn set_active_pet_accepts_empty_as_clear() {
        // 空串/纯空白表示清除选择：存空串而非 None —— None 是「从未选择」，
        // 会在读取时回落默认预设，清除就成了永远无效的操作。
        assert_eq!(normalize_set_active_pet_id(""), Ok(Some(String::new())));
        assert_eq!(normalize_set_active_pet_id("   "), Ok(Some(String::new())));
        // 非空保持既有校验：合法 id 原样存（去空白），非法 id 仍然报错。
        assert_eq!(
            normalize_set_active_pet_id("  maid-deepseek-whale  "),
            Ok(Some("maid-deepseek-whale".to_string()))
        );
        assert_eq!(
            normalize_set_active_pet_id("chat:custom-pet"),
            Ok(Some("chat:custom-pet".to_string()))
        );
        assert!(
            normalize_set_active_pet_id("bad id").is_err(),
            "非法 id 不应被静默当作清除"
        );
    }

    #[test]
    fn status_never_reports_visible_when_disabled() {
        let setting = config::Setting {
            pet_enabled: false,
            ..Default::default()
        };
        let status = status_from_setting(&setting, "");
        assert!(!status.enabled);
        assert!(!status.visible);
        assert_eq!(status.active_pet, "");
    }

    #[test]
    fn throw_defaults_off_and_follows_the_setting() {
        let default_status = status_from_setting(&config::Setting::default(), "");
        assert!(
            !default_status.throw_enabled,
            "抛射必须默认关闭（issue #930）"
        );

        let enabled = config::Setting {
            throw_enabled: true,
            ..Default::default()
        };
        assert!(status_from_setting(&enabled, "").throw_enabled);
    }

    #[test]
    fn manifest_parsing_keeps_version_optional_and_qualifies_source_ids() {
        let manifest = parse_manifest_bytes(
            br#"{"id":"blue_whale","displayName":"Blue Whale","description":"Chat pet","spritesheetPath":"art/pet.webp"}"#,
        )
        .unwrap();
        assert_eq!(
            manifest.sprite_version_number, None,
            "清单未声明版本时不应替用户假定 v2，网格交给图集尺寸推断"
        );
        assert_eq!(
            qualified_id(PetSource::Chat, &manifest.id),
            "chat:blue_whale"
        );
        assert_eq!(
            qualified_id(PetSource::Codex, &manifest.id),
            "codex:blue_whale"
        );
    }

    #[test]
    fn manifest_accepts_both_codex_sprite_versions() {
        for version in [1_u8, 2] {
            let body = format!(
                r#"{{"id":"legacy","spriteVersionNumber":{version},"spritesheetPath":"spritesheet.webp"}}"#
            );
            let manifest = parse_manifest_bytes(body.as_bytes()).unwrap();
            assert_eq!(manifest.sprite_version_number, Some(version));
        }
        let invalid_id =
            parse_manifest_bytes(br#"{"id":"../pet","spritesheetPath":"spritesheet.webp"}"#)
                .unwrap_err();
        assert!(invalid_id.starts_with("PET_ID_INVALID:"));
        let unsupported = parse_manifest_bytes(
            br#"{"id":"legacy","spriteVersionNumber":3,"spritesheetPath":"spritesheet.webp"}"#,
        )
        .unwrap_err();
        assert!(unsupported.starts_with("PET_SPRITE_VERSION_UNSUPPORTED:"));
    }

    #[test]
    fn qualified_ids_require_known_source_and_safe_manifest_id() {
        assert_eq!(
            parse_qualified_id("chat:pet_1").unwrap(),
            (PetSource::Chat, "pet_1")
        );
        assert!(parse_qualified_id("pet_1")
            .unwrap_err()
            .starts_with("PET_ID_INVALID:"));
        assert!(parse_qualified_id("other:pet_1")
            .unwrap_err()
            .starts_with("PET_SOURCE_INVALID:"));
        assert!(parse_qualified_id("codex:../pet")
            .unwrap_err()
            .starts_with("PET_ID_INVALID:"));
    }

    #[test]
    fn archive_paths_reject_traversal_absolute_windows_and_links() {
        for path in [
            "../escape",
            "/absolute",
            "a/../../escape",
            "C:/escape",
            "..\\escape",
        ] {
            assert!(
                safe_archive_entry(path, Some(0o100644)).is_err(),
                "应拒绝 {path}"
            );
        }
        assert!(safe_archive_entry("pet/spritesheet.webp", Some(0o100644)).is_ok());
        assert!(safe_archive_entry("pet/link", Some(0o120777))
            .unwrap_err()
            .starts_with("PET_ARCHIVE_LINK_FORBIDDEN:"));
    }

    #[test]
    fn archive_layout_accepts_root_or_wrapped_roots() {
        let root = vec![
            (PathBuf::from("pet.json"), false),
            (PathBuf::from("spritesheet.webp"), false),
        ];
        assert_eq!(archive_root_prefix(&root).unwrap(), None);

        let wrapped = vec![
            (PathBuf::from("my-pet"), true),
            (PathBuf::from("my-pet/pet.json"), false),
            (PathBuf::from("my-pet/spritesheet.webp"), false),
        ];
        assert_eq!(
            archive_root_prefix(&wrapped).unwrap(),
            Some(PathBuf::from("my-pet"))
        );

        // 把 `~/.codex/pets` 整体压缩：宠物目录之外还有包装目录，仍按包内根目录安装。
        let nested = vec![
            (PathBuf::from("pets"), true),
            (PathBuf::from("pets/my-pet"), true),
            (PathBuf::from("pets/my-pet/pet.json"), false),
            (PathBuf::from("pets/my-pet/spritesheet.webp"), false),
        ];
        assert_eq!(
            archive_root_prefix(&nested).unwrap(),
            Some(PathBuf::from("pets/my-pet"))
        );

        let mixed = vec![
            (PathBuf::from("my-pet/pet.json"), false),
            (PathBuf::from("outside.txt"), false),
        ];
        assert!(archive_root_prefix(&mixed)
            .unwrap_err()
            .starts_with("PET_ARCHIVE_LAYOUT_INVALID:"));

        let duplicate_manifests = vec![
            (PathBuf::from("pet.json"), false),
            (PathBuf::from("wrapper/pet.json"), false),
        ];
        assert!(archive_root_prefix(&duplicate_manifests)
            .unwrap_err()
            .starts_with("PET_ARCHIVE_LAYOUT_INVALID:"));
    }

    #[test]
    fn archive_layout_ignores_os_metadata_entries() {
        // macOS Finder/ditto 压缩会附带 `__MACOSX` 资源叉、AppleDouble `._*` 与 `.DS_Store`，
        // 它们不属于宠物内容，不得让正常包被判成「多根归档」。
        let finder_zip = vec![
            (PathBuf::from("my-pet"), true),
            (PathBuf::from("my-pet/pet.json"), false),
            (PathBuf::from("my-pet/spritesheet.webp"), false),
            (PathBuf::from("__MACOSX"), true),
            (PathBuf::from("__MACOSX/my-pet"), true),
            (PathBuf::from("__MACOSX/my-pet/._pet.json"), false),
            (PathBuf::from(".DS_Store"), false),
        ];
        assert_eq!(
            archive_root_prefix(&finder_zip).unwrap(),
            Some(PathBuf::from("my-pet"))
        );

        // 本应用自己的导入暂存在 `~/.codex/pets/.staging`，也不能算第二个根。
        let with_staging = vec![
            (PathBuf::from("pets/my-pet/pet.json"), false),
            (PathBuf::from("pets/.staging"), true),
        ];
        assert_eq!(
            archive_root_prefix(&with_staging).unwrap(),
            Some(PathBuf::from("pets/my-pet"))
        );

        for path in ["__MACOSX/pet/._pet.json", "pet/.DS_Store", "pet/._x"] {
            assert!(ignored_archive_entry(Path::new(path)), "{path} 应被忽略");
        }
        for path in ["pet/pet.json", "pet/art/spritesheet.webp"] {
            assert!(!ignored_archive_entry(Path::new(path)));
        }
    }

    #[test]
    fn bounded_copy_stops_before_writing_past_total_limit() {
        let mut reader = Cursor::new(vec![7_u8; 6]);
        let mut output = Vec::new();
        let mut total = 3_u64;
        let error = copy_archive_entry(&mut reader, &mut output, &mut total, 8).unwrap_err();
        assert!(error.starts_with("PET_ARCHIVE_TOO_LARGE:"));
        assert_eq!(total, 8);
        assert_eq!(output.len(), 5, "不得把超过总上限的字节写入 staging");
    }

    #[test]
    fn spritesheet_dimensions_accept_v1_and_v2_grids() {
        let valid = valid_test_webp();
        assert_eq!(
            spritesheet_dimensions(&valid, None).unwrap(),
            (
                "image/webp",
                SpriteGrid {
                    version: PET_SPRITE_V2,
                    columns: 8,
                    rows: 11
                }
            ),
            "88x88 同时整除 8 与 11，缺省取 v2"
        );

        // 高度只整除 9：8x9 的旧版图集必须按 v1 接受，而不是要求 11 行。
        let mut v1 = valid.clone();
        v1[27..30].copy_from_slice(&[89, 0, 0]);
        assert_eq!(
            spritesheet_dimensions(&v1, None).unwrap().1,
            SpriteGrid {
                version: PET_SPRITE_V1,
                columns: 8,
                rows: 9
            }
        );
        assert_eq!(
            spritesheet_dimensions(&v1, Some(PET_SPRITE_V2)).unwrap().1,
            SpriteGrid {
                version: PET_SPRITE_V1,
                columns: 8,
                rows: 9
            },
            "声明与图集不符时以图集比例为准，否则整个宠物无法导入"
        );

        let mut invalid_grid = valid.clone();
        invalid_grid[24] = 86;
        assert!(spritesheet_dimensions(&invalid_grid, None)
            .unwrap_err()
            .starts_with("PET_ASSET_DIMENSIONS_INVALID:"));

        let mut invalid_height = valid.clone();
        invalid_height[27..30].copy_from_slice(&[99, 0, 0]);
        assert!(spritesheet_dimensions(&invalid_height, None)
            .unwrap_err()
            .starts_with("PET_ASSET_DIMENSIONS_INVALID:"));

        let mut oversized = valid;
        oversized[24..27].copy_from_slice(&[0xff, 0xff, 0x00]);
        assert!(spritesheet_dimensions(&oversized, None)
            .unwrap_err()
            .starts_with("PET_ASSET_DIMENSIONS_INVALID:"));
    }

    #[test]
    fn extraction_accepts_wrapper_and_validates_manifest_asset() {
        let manifest = br#"{"id":"wrapped_pet","displayName":"Wrapped","spritesheetPath":"art/spritesheet.webp"}"#;
        let webp = valid_test_webp();
        let archive = build_archive(&[
            ("wrapper/pet.json", manifest),
            ("wrapper/art/spritesheet.webp", &webp),
        ]);
        let directory = TestDirectory::new("valid-wrapper");
        let parsed = extract_pet_archive(&archive, &directory.0).unwrap();
        assert_eq!(parsed.id, "wrapped_pet");
        assert_eq!(fs::read(directory.0.join("pet.json")).unwrap(), manifest);
        assert_eq!(
            fs::read(directory.0.join("art/spritesheet.webp")).unwrap(),
            webp
        );
        assert!(!directory.0.join("wrapper").exists());
    }

    #[test]
    fn extraction_accepts_codex_manifest_with_unrecognized_kind() {
        // 外部生成的 Codex 宠物会用 `kind` 标注自己的类别（如 person/pet），导入只认图集路径，
        // 新增的白名单把这些宠物全部挡在门外。
        let manifest = br#"{"id":"ene","kind":"person","spriteVersionNumber":2,"spritesheetPath":"spritesheet.webp"}"#;
        let webp = valid_test_webp();
        let archive = build_archive(&[
            ("ene.codex-pet/pet.json", manifest),
            ("ene.codex-pet/spritesheet.webp", &webp),
        ]);
        let directory = TestDirectory::new("unknown-kind");
        let parsed = extract_pet_archive(&archive, &directory.0).unwrap();
        assert_eq!(parsed.id, "ene");
        assert_eq!(parsed.kind.as_deref(), Some("person"));

        let installed = read_manifest(&directory.0).unwrap();
        validate_pet_source(PetSource::Codex, &installed).unwrap();
        let item = manifest_to_list_item(PetSource::Codex, &directory.0, installed);
        assert_eq!(item.id, "codex:ene");
        assert_eq!(item.source, "codex");
        assert_eq!(item.kind, "codex");
        assert_eq!(item.thumbnail_type, "spritesheet");
        assert!(item
            .thumbnail
            .unwrap()
            .starts_with("data:image/webp;base64,"));
    }

    #[test]
    fn extraction_accepts_macos_finder_archive_with_v1_atlas() {
        // issue #559：Finder/ditto 生成的 zip 会带上 `__MACOSX` 资源叉与 `.DS_Store`，
        // 且用户常把 `~/.codex/pets` 整体压缩（宠物目录外还有包装目录）。
        let manifest = br#"{"id":"jiaran","displayName":"Jiaran","spriteVersionNumber":1,"spritesheetPath":"spritesheet.webp"}"#;
        let mut webp = valid_test_webp();
        webp[27..30].copy_from_slice(&[89, 0, 0]);
        let archive = build_archive(&[
            ("pets/", b""),
            ("pets/jiaran/", b""),
            ("pets/jiaran/pet.json", manifest),
            ("pets/jiaran/spritesheet.webp", &webp),
            ("pets/.DS_Store", b"junk"),
            ("__MACOSX/", b""),
            ("__MACOSX/pets/jiaran/._pet.json", b"junk"),
            ("__MACOSX/pets/jiaran/._spritesheet.webp", b"junk"),
        ]);
        let directory = TestDirectory::new("macos-finder");
        let parsed = extract_pet_archive(&archive, &directory.0).unwrap();
        assert_eq!(parsed.id, "jiaran");
        assert_eq!(parsed.sprite_version_number, Some(PET_SPRITE_V1));
        assert_eq!(fs::read(directory.0.join("pet.json")).unwrap(), manifest);
        assert_eq!(
            read_spritesheet(
                &directory.0,
                &parsed.spritesheet_path,
                parsed.sprite_version_number
            )
            .unwrap()
            .1,
            SpriteGrid {
                version: PET_SPRITE_V1,
                columns: 8,
                rows: 9
            }
        );
        assert!(!directory.0.join("pets").exists());
        assert!(!directory.0.join("__MACOSX").exists());
        assert!(!directory.0.join(".DS_Store").exists());
    }

    #[test]
    fn delete_pet_directory_removes_the_manifest_match_and_keeps_siblings() {
        let root = TestDirectory::new("delete-pet");
        for (folder, id) in [("folder-a", "alpha"), ("folder-b", "beta")] {
            fs::create_dir_all(root.0.join(folder)).unwrap();
            fs::write(
                root.0.join(folder).join("pet.json"),
                format!(r#"{{"id":"{id}","spritesheetPath":"spritesheet.webp"}}"#),
            )
            .unwrap();
        }

        assert!(delete_pet_directory(&root.0, PetSource::Codex, "missing")
            .unwrap_err()
            .starts_with("PET_NOT_FOUND:"));
        assert_eq!(
            delete_pet_directory(&root.0, PetSource::Codex, "alpha"),
            Ok(())
        );
        assert!(!root.0.join("folder-a").exists());
        assert!(root.0.join("folder-b").join("pet.json").is_file());
    }

    #[test]
    fn bare_pets_directory_entries_list_without_preset_catalog() {
        // 落点是纯文件系统扫描：`$DSH_HOME/pets/<dir>/pet.json` 齐备就会被列出，
        // 不需要先注册进预设清单；preset_pet 的远端校验只管随包分发的条目。
        let root = TestDirectory::new("pets-root");
        let pet = root.0.join("my-pet");
        fs::create_dir_all(pet.join("art")).unwrap();
        fs::write(
            pet.join("pet.json"),
            br#"{"id":"my-pet","displayName":"My Pet","spritesheetPath":"art/pet.png"}"#,
        )
        .unwrap();
        let mut png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
        png.extend_from_slice(&8_u32.to_be_bytes());
        png.extend_from_slice(&11_u32.to_be_bytes());
        fs::write(pet.join("art/pet.png"), &png).unwrap();
        fs::write(root.0.join("README.txt"), b"not a pet").unwrap();
        let empty = root.0.join("empty");
        fs::create_dir(&empty).unwrap();

        assert_eq!(
            immediate_pet_directories(&root.0).unwrap(),
            vec![empty.clone(), pet.clone()],
            "只枚举直接子目录，普通文件不进列表"
        );
        assert!(
            read_manifest(&empty).is_err(),
            "缺少 pet.json 的目录应被跳过"
        );

        let item = manifest_to_list_item(PetSource::Chat, &pet, read_manifest(&pet).unwrap());
        assert_eq!(item.id, "chat:my-pet");
        assert_eq!(item.name, "My Pet");
        assert_eq!(item.source, "chat");
        assert!(item.thumbnail.is_some(), "图集合规时应生成缩略图");
        assert!(validate_active_pet_id(&item.id).is_ok());
    }

    fn dsh_fixture(directory: &Path) -> PetManifest {
        fs::create_dir_all(directory.join("webm")).unwrap();
        fs::create_dir_all(directory.join("preview")).unwrap();
        fs::write(directory.join("pet.json"), br#"{"id":"video-pet","kind":"dsh","configPath":"config.jsonc","uriPath":"webm","previewPath":"preview/preview.gif","ext":{"default":"webm","mac":"webm"},"size":220}"#).unwrap();
        fs::write(
            directory.join("config.jsonc"),
            br#"{
            // JSONC must retain comment markers inside strings
            "motions": {"idle": "idle", "working": ["work"],},
            "whisperPrompt": "https://example.test/*not a comment*/",
        }"#,
        )
        .unwrap();
        fs::write(directory.join("webm/idle.webm"), b"video-idle").unwrap();
        fs::write(directory.join("webm/work.webm"), b"video-work").unwrap();
        fs::write(directory.join("webm/unreferenced.webm"), b"private-video").unwrap();
        fs::write(directory.join("webm/private.txt"), b"private").unwrap();
        fs::write(
            directory.join("preview/preview.gif"),
            b"GIF89a\x10\x00\x10\x00\x00\x00\x00",
        )
        .unwrap();
        read_manifest(directory).unwrap()
    }

    #[test]
    fn dsh_asset_preserves_jsonc_object_and_only_authorizes_referenced_videos() {
        let root = tempfile::tempdir().unwrap();
        let manifest = dsh_fixture(root.path());
        let (asset, files) =
            read_dsh_asset(root.path(), &manifest, "chat:video-pet".to_string()).unwrap();
        let value = serde_json::to_value(asset).unwrap();
        assert_eq!(value["kind"], "dsh");
        assert_eq!(value["id"], "chat:video-pet");
        assert_eq!(
            value["config"]["motions"]["working"],
            serde_json::json!(["work"])
        );
        assert_eq!(
            value["config"]["whisperPrompt"],
            "https://example.test/*not a comment*/"
        );
        assert_eq!(
            value["ext"],
            serde_json::json!({"default":"webm","mac":"webm"})
        );
        assert_eq!(value["size"], 220.0);
        assert!(Path::new(value["uri"]["default"].as_str().unwrap()).is_absolute());
        assert_eq!(
            Path::new(value["uri"]["default"].as_str().unwrap()),
            dunce::simplified(&root.path().join("webm").canonicalize().unwrap())
        );
        assert!(value["uri"].get("mac").is_none());
        assert!(value.get("spritesheet").is_none());
        assert_eq!(
            files,
            vec![
                root.path().join("webm/idle.webm").canonicalize().unwrap(),
                root.path().join("webm/work.webm").canonicalize().unwrap()
            ]
        );
        let app = tauri::test::mock_app();
        let scope = tauri::scope::fs::Scope::new(
            &app,
            &tauri::utils::config::FsScope::AllowedPaths(Vec::new()),
        )
        .unwrap();
        for file in files {
            scope.allow_file(file).unwrap();
        }
        assert!(scope.is_allowed(root.path().join("webm/idle.webm")));
        for file in [
            "pet.json",
            "config.jsonc",
            "preview/preview.gif",
            "webm/private.txt",
            "webm/unreferenced.webm",
        ] {
            assert!(
                !scope.is_allowed(root.path().join(file)),
                "must not authorize {file}"
            );
        }
        assert!(!scope.is_allowed(root.path()));
        let item = manifest_to_list_item(PetSource::Chat, root.path(), manifest);
        assert_eq!(item.kind, "dsh");
        assert_eq!(item.thumbnail_type, "gif");
        assert_eq!(
            item.thumbnail.unwrap(),
            "data:image/gif;base64,R0lGODlhEAAQAAAAAA=="
        );
    }

    #[test]
    fn dsh_reference_enumeration_covers_component_pools_without_metadata() {
        let config = serde_json::json!({
            "motions": {"idle": "idle"},
            "animations": {
                "idle": ["breathe"], "turn": ["turn"], "drag": ["drag"], "clicks": ["click"],
                "motions": {"working": ["work"]},
                "moves": {"default": {"speed": 2}, "actions": [{"name": "walk", "params": {"speed": 2}}]},
                "categories": [{"id": "not-a-video", "weight": 1, "actions": ["jump"]}],
                "events": {"workStatus": ["think", ["code", "write"]]}
            }
        });
        let mut names: Vec<_> = animation_names(&config).unwrap().into_iter().collect();
        names.sort();
        assert_eq!(
            names,
            [
                "breathe", "click", "code", "drag", "idle", "jump", "think", "turn", "walk",
                "work", "write"
            ]
        );
    }

    #[test]
    fn dsh_assets_reject_missing_traversing_or_oversized_files() {
        let root = tempfile::tempdir().unwrap();
        let manifest = dsh_fixture(root.path());
        for raw in [
            r#"[]"#,
            r#"{}"#,
            r#"{"motions":{"idle":"../private"}}"#,
            r#"{"motions":{"idle":"C:/private"}}"#,
            r#"{"motions":{"idle":"missing"}}"#,
        ] {
            fs::write(root.path().join("config.jsonc"), raw).unwrap();
            assert!(
                read_dsh_asset(root.path(), &manifest, "chat:video-pet".to_string()).is_err(),
                "must reject {raw}"
            );
        }
        fs::write(
            root.path().join("config.jsonc"),
            r#"{"motions":{"idle":"idle"}}"#,
        )
        .unwrap();
        let video = fs::OpenOptions::new()
            .write(true)
            .open(root.path().join("webm/idle.webm"))
            .unwrap();
        video.set_len(PET_VIDEO_MAX_BYTES + 1).unwrap();
        assert!(
            read_dsh_asset(root.path(), &manifest, "chat:video-pet".to_string())
                .unwrap_err()
                .starts_with("PET_ASSET_INVALID:")
        );
        video.set_len(0).unwrap();
        assert!(
            read_dsh_asset(root.path(), &manifest, "chat:video-pet".to_string())
                .unwrap_err()
                .starts_with("PET_ASSET_INVALID:")
        );
        let config = fs::OpenOptions::new()
            .write(true)
            .open(root.path().join("config.jsonc"))
            .unwrap();
        config.set_len(PET_CONFIG_MAX_BYTES + 1).unwrap();
        assert!(
            read_dsh_asset(root.path(), &manifest, "chat:video-pet".to_string())
                .unwrap_err()
                .starts_with("PET_CONFIG_READ_FAILED:")
        );
    }

    #[test]
    fn dsh_preview_rejects_nonsquare_bad_header_and_oversized_gif() {
        let root = tempfile::tempdir().unwrap();
        dsh_fixture(root.path());
        for bytes in [
            b"not-a-gif-header".as_slice(),
            b"GIF89a\x10\x00\x11\x00\x00\x00\x00",
            b"GIF89a\x00\x00\x00\x00\x00\x00\x00",
            b"GIF89a\x01\x10\x01\x10\x00\x00\x00",
        ] {
            fs::write(root.path().join("preview/preview.gif"), bytes).unwrap();
            assert!(gif_data_url(root.path(), "preview/preview.gif")
                .unwrap_err()
                .starts_with("PET_PREVIEW_INVALID:"));
        }
        let gif = fs::OpenOptions::new()
            .write(true)
            .open(root.path().join("preview/preview.gif"))
            .unwrap();
        gif.set_len(PET_SPRITESHEET_MAX_BYTES + 1).unwrap();
        assert!(gif_data_url(root.path(), "preview/preview.gif")
            .unwrap_err()
            .starts_with("PET_PREVIEW_READ_FAILED:"));
    }

    #[test]
    fn dsh_mac_directory_requires_mov_and_checks_every_reference() {
        let root = tempfile::tempdir().unwrap();
        let mut manifest = dsh_fixture(root.path());
        manifest.mac_uri_path = Some("mov".to_string());
        manifest.ext.as_mut().unwrap().mac = Some("mov".to_string());
        fs::create_dir(root.path().join("mov")).unwrap();
        fs::write(root.path().join("mov/idle.mov"), b"idle-mov").unwrap();
        assert!(
            read_dsh_asset(root.path(), &manifest, "chat:video-pet".to_string())
                .unwrap_err()
                .starts_with("PET_ASSET_READ_FAILED:")
        );
        fs::write(root.path().join("mov/work.mov"), b"work-mov").unwrap();
        let (asset, files) =
            read_dsh_asset(root.path(), &manifest, "chat:video-pet".to_string()).unwrap();
        let value = serde_json::to_value(asset).unwrap();
        assert!(Path::new(value["uri"]["mac"].as_str().unwrap()).is_absolute());
        assert_eq!(value["ext"]["mac"], "mov");
        assert_eq!(files.len(), 4);
        assert!(parse_manifest_bytes(br#"{"id":"x","kind":"dsh","configPath":"c.jsonc","uriPath":"webm","macUriPath":"mov","previewPath":"p.gif","ext":{"default":"webm","mac":"webm"}}"#).unwrap_err().starts_with("PET_MANIFEST_INVALID:"));
    }

    #[test]
    fn dsh_manifest_rejects_mac_mov_without_mac_directory() {
        assert!(parse_manifest_bytes(br#"{"id":"x","kind":"dsh","configPath":"config.jsonc","uriPath":"webm","previewPath":"preview/preview.gif","ext":{"default":"webm","mac":"mov"}}"#)
            .unwrap_err().starts_with("PET_MANIFEST_INVALID:"));
    }

    #[test]
    fn dsh_is_forbidden_in_codex_source_and_zip_import() {
        let root = tempfile::tempdir().unwrap();
        let manifest = dsh_fixture(root.path());
        assert!(validate_pet_source(PetSource::Chat, &manifest).is_ok());
        assert!(validate_pet_source(PetSource::Codex, &manifest)
            .unwrap_err()
            .starts_with("PET_KIND_FORBIDDEN:"));
        let bytes = fs::read(root.path().join("pet.json")).unwrap();
        let archive = build_archive(&[("pet.json", &bytes)]);
        let staging = root.path().join("staging");
        assert!(extract_pet_archive(&archive, &staging)
            .unwrap_err()
            .starts_with("PET_KIND_FORBIDDEN:"));
        let legacy =
            parse_manifest_bytes(br#"{"id":"old","spritesheetPath":"sprite.webp"}"#).unwrap();
        assert!(validate_pet_source(PetSource::Codex, &legacy).is_ok());
        let value = serde_json::to_value(PetAsset::Codex {
            id: "codex:old".to_string(),
            spritesheet: "data:image/webp;base64,eA==".to_string(),
            sprite_version_number: 1,
            columns: 8,
            rows: 9,
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({"kind":"codex","id":"codex:old","spritesheet":"data:image/webp;base64,eA==","sprite_version_number":1,"columns":8,"rows":9})
        );
    }

    #[cfg(windows)]
    #[test]
    fn dsh_junctioned_config_preview_and_video_cannot_escape_root() {
        use std::os::windows::process::CommandExt;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let mut manifest = dsh_fixture(root.path());
        dsh_fixture(outside.path());
        let junction = root.path().join("external");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(outside.path())
            .creation_flags(0x08000000)
            .status()
            .unwrap();
        assert!(status.success(), "must create isolated junction");
        for relative in [
            "external/pet.json",
            "external/config.jsonc",
            "external/preview/preview.gif",
            "external/webm/idle.webm",
        ] {
            assert!(contained_file(root.path(), relative)
                .unwrap_err()
                .starts_with("PET_PATH_INVALID:"));
        }
        for field in ["config", "preview", "video"] {
            match field {
                "config" => manifest.config_path = Some("external/config.jsonc".to_string()),
                "preview" => {
                    manifest.preview_path = Some("external/preview/preview.gif".to_string())
                }
                "video" => manifest.uri_path = Some("external/webm".to_string()),
                _ => unreachable!(),
            }
            assert!(
                read_dsh_asset(root.path(), &manifest, "chat:video-pet".to_string())
                    .unwrap_err()
                    .starts_with("PET_PATH_INVALID:")
            );
            manifest = read_manifest(root.path()).unwrap();
        }
        fs::remove_dir(&junction).unwrap();
        assert!(outside.path().join("pet.json").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn dsh_symlinked_manifest_config_preview_and_video_cannot_escape_root() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let manifest = dsh_fixture(root.path());
        for relative in [
            "pet.json",
            "config.jsonc",
            "preview/preview.gif",
            "webm/idle.webm",
        ] {
            let path = root.path().join(relative);
            let original = fs::read(&path).unwrap();
            let target = outside.path().join("external");
            fs::write(&target, &original).unwrap();
            fs::remove_file(&path).unwrap();
            std::os::unix::fs::symlink(&target, &path).unwrap();
            assert!(contained_file(root.path(), relative)
                .unwrap_err()
                .starts_with("PET_PATH_INVALID:"));
            if relative == "pet.json" {
                assert!(read_manifest(root.path())
                    .unwrap_err()
                    .starts_with("PET_PATH_INVALID:"));
            } else {
                assert!(
                    read_dsh_asset(root.path(), &manifest, "chat:video-pet".to_string())
                        .unwrap_err()
                        .starts_with("PET_PATH_INVALID:")
                );
            }
            fs::remove_file(&path).unwrap();
            fs::write(path, original).unwrap();
        }
    }

    #[test]
    fn extraction_rejects_traversal_before_creating_staging() {
        let archive = build_archive(&[
            (
                "pet.json",
                br#"{"id":"safe_pet","spritesheetPath":"spritesheet.webp"}"#,
            ),
            ("../escape", b"bad"),
            ("spritesheet.webp", b"RIFF\x04\x00\x00\x00WEBP"),
        ]);
        let directory = TestDirectory::new("traversal");
        let error = extract_pet_archive(&archive, &directory.0).unwrap_err();
        assert!(error.starts_with("PET_PATH_INVALID:"));
        assert!(!directory.0.exists(), "完整校验失败前不得创建 staging");
    }
}
