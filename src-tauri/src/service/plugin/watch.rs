//! 已安装插件监控：轮询 profile 插件文件（`package.json` + `node_modules` 下
//! 各直接依赖清单），内容变化时解析为结构化列表并通过 `dsh-plugins-updated`
//! 事件实时推送给前端（由根布局写入插件列表查询缓存）。
//!
//! 采用与主题轮询（`config/theme.rs`）一致的「秒级 tick + 指纹比对」方案，
//! 不引入 notify 等文件监听依赖：插件数量少（个位数到十几个），每次读取的
//! 都是小 JSON 文件，开销可忽略；pnpm add/remove/install 期间的连续写盘由
//! 2s 防抖合并，避免事件风暴。
//!
//! 模块划分参考 [`super::installed`]（预装插件检测）：installed 聚焦预设清单
//! 的勾选态，这里解析「实际已安装」的插件元信息（名称/版本/描述/仓库地址/
//! 是否启动加载），供前端做已安装列表展示与后续插件管理。

use crate::service::workflow::instances;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::AppHandle;

use super::errors::{self, PluginError};
use super::installed::{installed_name, profile_dir, ProfilePackageJson};
use super::preset::{load_presets, PreinstallPluginInfo};

/// 前端监听的事件名（插件列表变化时推送）
pub(crate) const PLUGINS_UPDATED_EVENT: &str = "dsh-plugins-updated";

/// 防抖窗口：pnpm 安装/卸载会在数秒内连续写盘，窗口内只保留最新指纹，
/// 避免每个 tick 都推送一次中间态
const DEBOUNCE: Duration = Duration::from_secs(2);

/// 已安装插件（序列化为 camelCase 给前端）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DshPlugin {
    /// 依赖键（npm 包名），前端主键
    pub id: String,
    /// 展示名：插件 package.json 的 name，缺失时回落预设清单/依赖键
    pub name: String,
    /// 已安装版本（解析失败时为空字符串）
    pub version: String,
    pub description: String,
    /// 仓库地址（repository.url / homepage），缺失时回落预设清单
    pub repo_url: String,
    /// 是否在 `dsh.profile.bundles` 中（启动时自动加载）
    pub bundled: bool,
    /// 是否在 profile 的 `cordis.patch.yml` 中被禁用（`disabled: true`）。
    ///
    /// 这是插件开关的唯一状态，与官方 Plugins 页 / dshmarket 共用：`bundled`
    /// 只表示是否在 `dsh.profile.bundles` 中被自动加载，不代表用户开关。
    pub patch_disabled: bool,
    /// 预设清单中的「推荐」标记（绿色 chip）
    pub recommended: bool,
    /// 预设清单中的「修复」标记（黄色 chip）
    pub fix: bool,
    /// 预设清单中的「内置」标记（随包分发/本地热更新，前端据此隐藏卸载入口并标注）
    pub internal: bool,
    /// 是否有可用更新（由 `service::plugin::update` 探测；尚未判定时为 false，
    /// 前端在挂载后经 `refresh_plugin_updates` 补齐——因此有更新时才显示升级按钮，
    /// 不会「常驻」）
    pub update_available: bool,
    /// 判定得到的「最新版本」（registry latest / git HEAD SHA）；未判定或不可判定时缺省
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<String>,
    /// 是否有单插件快照（`$DSH_HOME/.plugin-backups/<id>.tgz`），前端据此展示
    /// 还原 / 删除快照入口
    pub has_snapshot: bool,
    /// 异常信息（安装/升级/卸载失败或页面运行期上报）；`None` = 正常
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<PluginError>,
}

/// 用于强类型解析插件自身 package.json 的辅助结构
#[derive(Deserialize, Default)]
struct PluginPackageJson {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    homepage: Option<String>,
    #[serde(default)]
    repository: Option<RepositoryField>,
}

/// repository 字段兼容两种形态：字符串 URL 或 `{ "type": "git", "url": ... }` 对象
#[derive(Deserialize)]
#[serde(untagged)]
enum RepositoryField {
    Url(String),
    Object { url: Option<String> },
}

/// 插件在 node_modules 下的目录：`node_modules/<id>`（scoped 包 id 形如
/// `@scope/pkg`，join 会按分隔符展开成 `node_modules/@scope/pkg`）
fn plugin_dir(profile: &Path, id: &str) -> PathBuf {
    profile.join("node_modules").join(id)
}

/// 规范化仓库地址，便于系统浏览器直接打开：
/// `git+https://...` / `git://...` → `https://...`，去掉末尾 `.git`
pub(crate) fn normalize_repo_url(url: &str) -> String {
    let mut normalized = url.trim().to_string();
    if let Some(rest) = normalized.strip_prefix("git+") {
        normalized = rest.to_string();
    }
    if let Some(rest) = normalized.strip_prefix("git://") {
        normalized = format!("https://{rest}");
    }
    if let Some(rest) = normalized.strip_suffix(".git") {
        normalized = rest.to_string();
    }
    normalized
}

/// 读取并解析插件自身的 package.json；缺失/损坏时返回 None（不阻断整体解析）
fn read_plugin_meta(dir: &Path) -> Option<PluginPackageJson> {
    let content = std::fs::read_to_string(dir.join("package.json")).ok()?;
    serde_json::from_str(&content).ok()
}

/// 解析 profile 目录下实际已安装的插件列表（纯函数，便于单元测试）。
///
/// 只列出 profile package.json `dependencies` 中的直接依赖——node_modules 里
/// 还有大量传递依赖（clsx/zod 等），它们不是用户安装的 dsh 插件，不应展示。
pub(crate) fn parse_plugins(profile: &Path, presets: &[PreinstallPluginInfo]) -> Vec<DshPlugin> {
    let manifest_content = match std::fs::read_to_string(profile.join("package.json")) {
        Ok(content) => content,
        Err(_) => return Vec::new(),
    };
    let manifest: ProfilePackageJson = match serde_json::from_str(&manifest_content) {
        Ok(manifest) => manifest,
        Err(_) => return Vec::new(),
    };

    let bundled: HashSet<&str> = manifest
        .dsh
        .as_ref()
        .and_then(|dsh| dsh.profile.as_ref())
        .map(|profile| profile.bundles.iter().map(String::as_str).collect())
        .unwrap_or_default();

    let preset_map: HashMap<&str, &PreinstallPluginInfo> =
        presets.iter().map(|p| (p.id.as_str(), p)).collect();

    // 内置插件按真实依赖键（installed_name：package 优先否则 id）归集，
    // 与 `internal.rs::ensure` 的安装/自愈口径一致
    let internal_names: HashSet<String> = presets
        .iter()
        .filter(|p| p.internal)
        .map(|p| installed_name(p).to_string())
        .collect();

    // 插件开关的唯一状态：`cordis.patch.yml` 顶层 `disabled: true` 条目（与官方
    // Plugins 页 / dshmarket 共用）。
    let patch_disabled_set = crate::service::plugin::disable::load_patch_disabled(profile);

    let mut dep_ids: Vec<&String> = manifest.dependencies.keys().collect();
    // 稳定排序：启动加载（bundles）的插件在前，其余按 id 字典序
    dep_ids.sort_by_key(|id| (!bundled.contains(id.as_str()), id.as_str()));

    dep_ids
        .into_iter()
        .map(|id| {
            let preset = preset_map.get(id.as_str());
            let meta = read_plugin_meta(&plugin_dir(profile, id));
            let repo_url = meta
                .as_ref()
                .and_then(|m| match &m.repository {
                    Some(RepositoryField::Url(url)) => Some(url.clone()),
                    Some(RepositoryField::Object { url }) => url.clone(),
                    None => m.homepage.clone(),
                })
                .or_else(|| preset.map(|p| p.repo_url.clone()))
                .map(|url| normalize_repo_url(&url))
                .unwrap_or_default();
            let name = meta
                .as_ref()
                .and_then(|m| m.name.clone())
                .or_else(|| preset.map(|p| p.name.clone()))
                .unwrap_or_else(|| id.clone());
            let patch_disabled_by_name = patch_disabled_set.contains(name.as_str());
            DshPlugin {
                id: id.clone(),
                name,
                version: meta
                    .as_ref()
                    .and_then(|m| m.version.clone())
                    .unwrap_or_default(),
                description: meta
                    .as_ref()
                    .and_then(|m| m.description.clone())
                    .or_else(|| preset.map(|p| p.description.clone()))
                    .unwrap_or_default(),
                repo_url,
                bundled: bundled.contains(id.as_str()),
                patch_disabled: patch_disabled_set.contains(id.as_str()) || patch_disabled_by_name,
                recommended: preset.map(|p| p.recommended).unwrap_or(false),
                fix: preset.map(|p| p.fix).unwrap_or(false),
                internal: internal_names.contains(id.as_str()),
                update_available: false,
                latest_version: None,
                has_snapshot: false,
                error: None,
            }
        })
        .collect()
}

/// 将仍然有效的错误记录并入插件列表。
///
/// 安装失败记录描述的是当时「清单已有引用、但 node_modules 产物缺失」的状态；后续
/// 重试或外部修复成功后，插件 package.json 已能解析出版本，旧记录便不再代表当前状态。
/// 若继续合并这类历史记录，前端会同时误显异常图标和作为修复入口的升级按钮。
fn merge_current_errors(plugins: &mut [DshPlugin], registry: &HashMap<String, PluginError>) {
    for plugin in plugins {
        plugin.error = registry.get(&plugin.id).and_then(|error| {
            let recovered_install = error.action == "install" && !plugin.version.is_empty();
            (!recovered_install).then(|| error.clone())
        });
    }
}

/// 已安装插件列表（含解析后的元信息与错误记录），前端首次加载/手动刷新用
pub fn list(app_handle: &AppHandle) -> Vec<DshPlugin> {
    let presets = load_presets(app_handle);
    let mut plugins = parse_plugins(&profile_dir(app_handle), &presets);
    // 合并错误注册表：错误记录变化不反映在文件指纹里，这里每次列表重建时并入。
    // 已恢复的安装错误会被过滤，避免持久化历史状态污染当前健康状态。
    let registry = errors::load(app_handle);
    merge_current_errors(&mut plugins, &registry);
    // 单插件快照存在性（快照不在 profile 文件指纹里，须单独探测）
    for plugin in &mut plugins {
        plugin.has_snapshot = super::snapshot::has_snapshot(app_handle, &plugin.id);
    }
    plugins
}

/// 主动推送一次插件列表（插件安装/升级/卸载/错误记录后调用，不等指纹轮询
/// 防抖；错误数据变化不改变文件指纹，必须显式推送）。
///
/// 同时把监控指纹同步到当前状态，避免紧接着的下一次轮询重复推送同一列表。
pub fn force_emit(app_handle: &AppHandle) {
    let fp = fingerprint(app_handle);
    let profile = crate::service::profile::active_profile(app_handle);
    let mut states = STATE.get_or_init(Mutex::default).lock().unwrap();
    let state = states.entry(profile).or_default();
    state.pending_fp = None;
    state.last_fp = fp;
    drop(states);
    emit(app_handle);
}

/// 变化指纹：profile package.json、各直接依赖插件 package.json，以及
/// `cordis.patch.yml` 的内容拼接。
///
/// pnpm add/remove/install 会重写 profile 清单（依赖与 bundles）并落盘插件包，
/// 任一变化都会改变指纹；插件开关写在 patch 里，被官方插件页 / 手工编辑改动时也要
/// 触发插件列表刷新（issue #399）。profile 未初始化（首次运行）时返回 None。
fn fingerprint(app_handle: &AppHandle) -> Option<String> {
    let dir = profile_dir(app_handle);
    let manifest = std::fs::read_to_string(dir.join("package.json")).ok()?;
    let parsed = serde_json::from_str::<ProfilePackageJson>(&manifest).ok()?;
    let mut dep_ids: Vec<&String> = parsed.dependencies.keys().collect();
    dep_ids.sort();

    let mut parts = vec![manifest];
    for id in dep_ids {
        if let Ok(content) = std::fs::read_to_string(plugin_dir(&dir, id).join("package.json")) {
            parts.push(content);
        }
    }
    // patch 不在依赖文件里，但直接决定插件列表的开关状态：一并纳入指纹，
    // 外部直接编辑该文件时也能实时刷新。
    if let Ok(content) = std::fs::read_to_string(dir.join("cordis.patch.yml")) {
        parts.push(content);
    }
    Some(parts.join("\n---\n"))
}

/// 监控状态：指纹 + 防抖窗口（仅 check_and_emit 单线程轮询访问）
#[derive(Default)]
struct WatchState {
    /// 上次已推送的指纹（内容一致则跳过）
    last_fp: Option<String>,
    /// 上次推送时间（用于防抖合并）
    last_emit: Option<Instant>,
    /// 防抖窗口内待推送的最新指纹
    pending_fp: Option<String>,
}

static STATE: OnceLock<Mutex<HashMap<String, WatchState>>> = OnceLock::new();

/// 秒级轮询入口（由 scheduler 永久循环调用）：指纹变化且超过防抖窗口时，
/// 重新解析插件列表并推送 `dsh-plugins-updated` 事件。
pub fn check_and_emit(app_handle: &AppHandle) {
    if instances::current_profile().is_none() {
        for profile in instances::profiles() {
            instances::scope_sync(profile, || check_and_emit(app_handle));
        }
        return;
    }
    let fp = fingerprint(app_handle);
    let profile = crate::service::profile::active_profile(app_handle);
    let mut states = STATE.get_or_init(Mutex::default).lock().unwrap();
    let state = states.entry(profile).or_default();

    if state.last_fp.as_deref() == fp.as_deref() {
        return;
    }
    // 指纹变化：先记下待推送值，再判断是否已过防抖窗口（安装过程中连续
    // 变化时合并为一次推送，窗口结束前的变化会在后续 tick 补推）
    state.pending_fp = fp;
    let can_emit = state
        .last_emit
        .is_none_or(|last| last.elapsed() >= DEBOUNCE);
    if !can_emit {
        return;
    }
    state.last_emit = Some(Instant::now());
    state.last_fp = state.pending_fp.take();
    emit(app_handle);
}

/// 解析并推送插件列表；profile 被移除（指纹为 None）时推送空列表让前端清空
fn emit(app_handle: &AppHandle) {
    let plugins = list(app_handle);
    log::debug!(
        "dsh plugins changed, emitting {} plugin(s) to frontend",
        plugins.len()
    );
    instances::emit(app_handle, PLUGINS_UPDATED_EVENT, &plugins);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造临时 profile：package.json + node_modules 下的插件包清单
    /// （tag 用于区分不同测试的临时目录，避免并行执行时互相清理）
    fn build_profile(tag: &str, packages: &[(&str, &str)]) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("dsh-watch-test-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        let mut manifest = serde_json::json!({
            "name": "dsh-profile-web",
            "private": true,
            "dependencies": {},
            "dsh": { "profile": { "bundles": [] } }
        });
        let mut deps = serde_json::Map::new();
        let mut bundles = Vec::new();
        for (id, meta_json) in packages {
            deps.insert((*id).to_string(), serde_json::Value::String("1.0.0".into()));
            let pkg_dir = dir.join("node_modules").join(id);
            std::fs::create_dir_all(&pkg_dir).unwrap();
            std::fs::write(pkg_dir.join("package.json"), *meta_json).unwrap();
            if meta_json.contains("\"dsh\"") {
                bundles.push((*id).to_string());
            }
        }
        manifest["dependencies"] = serde_json::Value::Object(deps);
        manifest["dsh"]["profile"]["bundles"] =
            serde_json::Value::Array(bundles.into_iter().map(serde_json::Value::String).collect());
        std::fs::write(
            dir.join("package.json"),
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();
        dir
    }

    fn presets_for_test() -> Vec<PreinstallPluginInfo> {
        vec![PreinstallPluginInfo {
            id: "dshmarket".into(),
            spec: "dshmarket".into(),
            name: "DSH Market".into(),
            description: "Visual plugin market".into(),
            repo_url: "https://github.com/dsh-market/dsh-market".into(),
            recommended: true,
            fix: false,
            default_checked: false,
            default_unchecked: false,
            version: None,
            win_only: false,
            package: None,
            internal: false,
        }]
    }

    #[test]
    fn watch_state_default_starts_without_fingerprints_or_debounce() {
        let state = Mutex::<WatchState>::default();
        let state = state.lock().unwrap();
        assert_eq!(state.last_fp, None);
        assert_eq!(state.last_emit, None);
        assert_eq!(state.pending_fp, None);
    }

    #[test]
    fn repo_url_normalization_preserves_existing_boundaries() {
        for (input, expected) in [
            ("  git+git://example/repo.git  ", "https://example/repo"),
            ("git+https://example/repo.git", "https://example/repo"),
            ("git://example/repo.git", "https://example/repo"),
            ("https://example/repo.git/", "https://example/repo.git/"),
            (
                "https://example/repo.git?x=1",
                "https://example/repo.git?x=1",
            ),
            ("git+ssh://example/repo.git", "ssh://example/repo"),
            (
                "git+git+https://example/repo.git",
                "git+https://example/repo",
            ),
            ("Git://example/repo.git", "Git://example/repo"),
            ("  ", ""),
        ] {
            assert_eq!(normalize_repo_url(input), expected, "{input}");
        }
    }

    #[test]
    fn parse_plugins_lists_direct_deps_with_meta() {
        let dir = build_profile(
            "meta",
            &[
                (
                    "dshmarket",
                    r#"{"name":"dshmarket","version":"1.13.1","description":"market","repository":{"type":"git","url":"git+https://github.com/dsh-market/dsh-market.git"},"dsh":{"bundle":{}}}"#,
                ),
                (
                    "@anionex/dsh-turn-rewind",
                    r#"{"name":"@anionex/dsh-turn-rewind","version":"0.1.1","description":"rewind"}"#,
                ),
            ],
        );
        let plugins = parse_plugins(&dir, &presets_for_test());
        assert_eq!(plugins.len(), 2);

        let market = plugins.iter().find(|p| p.id == "dshmarket").unwrap();
        assert!(market.bundled);
        assert!(market.recommended);
        assert_eq!(market.version, "1.13.1");
        assert_eq!(market.repo_url, "https://github.com/dsh-market/dsh-market");

        let rewind = plugins
            .iter()
            .find(|p| p.id == "@anionex/dsh-turn-rewind")
            .unwrap();
        assert!(!rewind.bundled);
        assert!(!rewind.recommended);
        assert_eq!(rewind.name, "@anionex/dsh-turn-rewind");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parse_plugins_falls_back_to_preset_and_sorts_bundled_first() {
        let dir = build_profile(
            "fallback",
            &[
                ("dsh-at-file", r#"{"name":"dsh-at-file"}"#),
                ("dshmarket", r#"{"name":"dshmarket","dsh":{"bundle":{}}}"#),
            ],
        );
        let plugins = parse_plugins(&dir, &presets_for_test());
        // bundled（dshmarket）在前
        assert_eq!(plugins[0].id, "dshmarket");
        // 无版本/描述时回落预设清单
        let market = &plugins[0];
        assert_eq!(market.version, "");
        assert_eq!(market.description, "Visual plugin market");
        assert_eq!(market.repo_url, "https://github.com/dsh-market/dsh-market");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parse_plugins_marks_internal_presets() {
        let dir = build_profile(
            "internal",
            &[
                (
                    "dsh-tauri",
                    r#"{"name":"dsh-tauri","version":"0.2.0","description":"bridge"}"#,
                ),
                ("dshmarket", r#"{"name":"dshmarket","version":"1.13.1"}"#),
            ],
        );
        let mut presets = presets_for_test();
        presets.push(PreinstallPluginInfo {
            id: "dsh-tauri".into(),
            spec: "dsh-tauri@0.2.0".into(),
            name: "DSH Tauri".into(),
            description: "Message bridge".into(),
            repo_url: "https://github.com/dsh-tauri-desk/dsh-tauri".into(),
            recommended: true,
            fix: false,
            default_checked: false,
            default_unchecked: false,
            version: None,
            win_only: false,
            package: None,
            internal: true,
        });
        let plugins = parse_plugins(&dir, &presets);
        assert_eq!(plugins.len(), 2);
        let tauri = plugins.iter().find(|p| p.id == "dsh-tauri").unwrap();
        assert!(tauri.internal);
        let market = plugins.iter().find(|p| p.id == "dshmarket").unwrap();
        assert!(!market.internal);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn recovered_install_error_is_not_exposed_as_current_error() {
        let mut plugins = vec![DshPlugin {
            id: "dsh-notification".into(),
            name: "DSH Notification".into(),
            version: "0.1.3".into(),
            description: String::new(),
            repo_url: String::new(),
            bundled: true,
            patch_disabled: false,
            recommended: false,
            fix: false,
            internal: false,
            update_available: false,
            latest_version: None,
            has_snapshot: false,
            error: None,
        }];
        let registry = HashMap::from([(
            "dsh-notification".into(),
            PluginError {
                message: "PREINSTALL_SILENT_FAIL: missing artifact".into(),
                action: "install".into(),
                at: "1700000000".into(),
            },
        )]);

        merge_current_errors(&mut plugins, &registry);

        assert!(plugins[0].error.is_none());
    }

    #[test]
    fn unresolved_install_and_runtime_errors_remain_visible() {
        let plugin = DshPlugin {
            id: "dsh-notification".into(),
            name: "DSH Notification".into(),
            version: String::new(),
            description: String::new(),
            repo_url: String::new(),
            bundled: true,
            patch_disabled: false,
            recommended: false,
            fix: false,
            internal: false,
            update_available: false,
            latest_version: None,
            has_snapshot: false,
            error: None,
        };
        let install_error = PluginError {
            message: "missing artifact".into(),
            action: "install".into(),
            at: "1700000000".into(),
        };
        let mut plugins = vec![plugin.clone()];
        merge_current_errors(
            &mut plugins,
            &HashMap::from([("dsh-notification".into(), install_error.clone())]),
        );
        assert_eq!(plugins[0].error, Some(install_error));

        let runtime_error = PluginError {
            message: "runtime failure".into(),
            action: "runtime".into(),
            at: "1700000001".into(),
        };
        let mut healthy_plugins = vec![DshPlugin {
            version: "0.1.3".into(),
            ..plugin
        }];
        merge_current_errors(
            &mut healthy_plugins,
            &HashMap::from([("dsh-notification".into(), runtime_error.clone())]),
        );
        assert_eq!(healthy_plugins[0].error, Some(runtime_error));
    }

    #[test]
    fn parse_plugins_returns_empty_without_manifest() {
        let dir = std::env::temp_dir().join(format!("dsh-watch-empty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(parse_plugins(&dir, &[]).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 三种状态由 `bundled`（是否在 `dsh.profile.bundles`）与 patch 禁用共同决定：
    /// - 在 bundles 且未被 patch 禁用 → bundled=true, patch_disabled=false（正常加载）
    /// - 不在 bundles 但被 patch 禁用 → bundled=false, patch_disabled=true（已禁用，可启用）
    /// - 不在 bundles 且未被 patch 禁用 → bundled=false, patch_disabled=false（未加载）
    #[test]
    fn parse_plugins_distinguishes_disabled_from_unloaded() {
        let dir = std::env::temp_dir().join(format!("dsh-watch-disabled-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        let manifest = serde_json::json!({
            "name": "dsh-profile-web",
            "private": true,
            "dependencies": {
                "dsh-loaded": "1.0.0",
                "dsh-disabled": "1.0.0",
                "dsh-unloaded": "1.0.0"
            },
            "dsh": { "profile": { "bundles": ["dsh-loaded"] } }
        });
        std::fs::write(
            dir.join("package.json"),
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();
        for id in ["dsh-loaded", "dsh-disabled", "dsh-unloaded"] {
            let pkg_dir = dir.join("node_modules").join(id);
            std::fs::create_dir_all(&pkg_dir).unwrap();
            std::fs::write(
                pkg_dir.join("package.json"),
                format!(r#"{{"name":"{id}"}}"#),
            )
            .unwrap();
        }
        // 仅 dsh-disabled 在 patch 里被禁用。
        std::fs::write(
            dir.join("cordis.patch.yml"),
            "- id: dsh-disabled\n  disabled: true\n",
        )
        .unwrap();

        let plugins = parse_plugins(&dir, &[]);
        let loaded = plugins.iter().find(|p| p.id == "dsh-loaded").unwrap();
        assert!(loaded.bundled);
        assert!(!loaded.patch_disabled);
        let disabled_plugin = plugins.iter().find(|p| p.id == "dsh-disabled").unwrap();
        assert!(!disabled_plugin.bundled);
        assert!(disabled_plugin.patch_disabled);
        let unloaded = plugins.iter().find(|p| p.id == "dsh-unloaded").unwrap();
        assert!(!unloaded.bundled);
        assert!(!unloaded.patch_disabled);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// `cordis.patch.yml` 里 `disabled: false` 与未带 disabled 字段的条目不标记禁用。
    #[test]
    fn parse_plugins_marks_config_override_disabled() {
        let dir = build_profile(
            "patch",
            &[
                (
                    "dshmarket",
                    r#"{"name":"dshmarket","version":"1.13.1","dsh":{"bundle":{}}}"#,
                ),
                (
                    "dsh-tauri-pet",
                    r#"{"name":"dsh-tauri-pet","version":"0.1.0"}"#,
                ),
                ("dsh-other", r#"{"name":"dsh-other","version":"0.1.0"}"#),
            ],
        );
        // dshmarket 由配置覆盖禁用；dsh-tauri-pet 显式 disabled: false（非禁用）
        std::fs::write(
            dir.join("cordis.patch.yml"),
            "- id: dshmarket\n  disabled: true\n- id: dsh-tauri-pet\n  disabled: false\n",
        )
        .unwrap();
        let plugins = parse_plugins(&dir, &presets_for_test());
        let market = plugins.iter().find(|p| p.id == "dshmarket").unwrap();
        assert!(market.patch_disabled);
        let pet = plugins.iter().find(|p| p.id == "dsh-tauri-pet").unwrap();
        assert!(!pet.patch_disabled);
        let other = plugins.iter().find(|p| p.id == "dsh-other").unwrap();
        assert!(!other.patch_disabled);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 包内 `name` 与依赖键不一致（loader 别名形态）时，patch 条目按
    /// package.json name 命中同样标记为配置覆盖禁用。
    #[test]
    fn parse_plugins_marks_patch_disabled_by_package_name_alias() {
        let dir = build_profile(
            "patch-alias",
            &[(
                "dsh-better-sidebar",
                r#"{"name":"better-sidebar","version":"1.0.0"}"#,
            )],
        );
        std::fs::write(
            dir.join("cordis.patch.yml"),
            "- id: better-sidebar\n  disabled: true\n",
        )
        .unwrap();
        let plugins = parse_plugins(&dir, &[]);
        let sidebar = plugins
            .iter()
            .find(|p| p.id == "dsh-better-sidebar")
            .unwrap();
        assert!(sidebar.patch_disabled);

        std::fs::remove_dir_all(&dir).ok();
    }
}
