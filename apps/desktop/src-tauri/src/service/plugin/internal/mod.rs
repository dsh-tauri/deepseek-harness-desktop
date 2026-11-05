//! 内置插件启动自愈：随安装包分发的内置插件（条目位于
//! `plugins.built-in`，产物目录 `resources/node_modules/<name>` 由构建期
//! `scripts/build-plugins.ts` 的 `pnpm deploy` 打包）在服务启动前核对
//! 「是否已安装 + 安装路径是否仍指向当前捆绑目录」：未安装 / 路径不正确 / 用户
//! 卸载后残留缺失 → 一律走常规安装流程强制重装，保证桌面外壳依赖的桥接层
//! （如 dsh-tauri）随包可用。
//!
//! debug 构建会自动发现仓库根 `packages/*` 中非私有且含 `dsh` 对象的包，把安装
//! 目标指到本地插件源码（热更新迭代，见 [`super::preset::bundled_plugin_dir`]）。
//!
//! 为什么放在启动而非安装流程：安装是用户主动行为，内置插件是应用自身的完整性
//! 要求——用户怎么卸载、何时卸载都不影响下次启动自动恢复，无需任何用户操作。
//!
//! 模块划分：协调/飞行（本文件）、profile 清单/入口文件操作（[`manifest`]）与
//! pnpm 失败后的离线自建链接兜底（[`materialize`]）。

use crate::AppHandle;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};

use super::cancel::terminate_owned_install;
use super::install::{install_internal, trust_policy_rejection};
use super::installed::{installed_name, profile_dir, ProfilePackageJson};
use super::preset::{
    bundled_dep_spec, bundled_plugin_dir, load_presets, PreinstallPluginInfo,
};
use super::process::{new_process_owner, PreinstallLogPayload, ProcessOwner, PREINSTALL_LOG_EVENT};
use crate::config;

use manifest::{
    collect_dangling_local_link_deps, dedupe_profile_bundles, dep_matches_spec,
    remove_duplicate_bundle_entries_from_patch, remove_internal_plugins_from_manifest,
    remove_stale_plugin_entry, write_profile_manifest,
};
pub(crate) use manifest::{internal_plugin_entry_is_ready, skip_unavailable_plugins};
use materialize::{materialize_links, OfflineLink};

mod manifest;
mod materialize;

/// 核对并强制安装缺失/路径不正确/被卸载的内置插件，在服务进程启动前调用。
///
/// 最佳努力：任何失败只记告警（调用方不阻断启动）；捆绑目录缺失（开发环境未跑
/// build:plugins）时跳过，交由常规引导流程处理；批量待装列表为空则不触发任何安装。
/// 内置插件阶段事件载荷：除开始/结束外定期发送 heartbeat，令前端只在安装确实
/// 无进展时触发 inactivity deadline，同时仍受绝对上限约束。
#[derive(serde::Serialize, Clone)]
struct InternalPluginsPhase {
    phase: &'static str,
    detail: InternalPluginPhaseDetail,
    completed: usize,
    total: usize,
}

#[derive(serde::Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum InternalPluginPhaseDetail {
    Waiting,
    Checking,
    Installing,
    Heartbeat,
    Done,
    Timeout,
    Cancelled,
}

/// 串行化内置插件核对/安装：auto_start（Rust 侧 start→launch）与前端 boot 流程
/// （新增的 boot 期 ensure 命令）可能并发触发，而安装会启动 `dsh plugin add`
/// 子进程——两个 pnpm 抢同一档案目录会互相打断。若另一路正在执行，这里等它
/// 完成后再核对（幂等：上次已装好则本轮全部 no-op）。
const ENSURE_ABSOLUTE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10 * 60);
const ENSURE_CLEANUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
const ENSURE_OWNER_DRAIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
const ENSURE_OWNER_DRAIN_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);
/// 复用「刚刚成功过」的核对结论的时间窗（issue #766）。
///
/// 一次启动里两路调用的间隔是秒级，30s 足够覆盖；超过窗口一律重新核对，避免长
/// 时间缓存掩盖窗口外的磁盘变化（例如手工删掉某个内置插件的 node_modules）。
const ENSURE_REUSE_WINDOW: std::time::Duration = std::time::Duration::from_secs(30);

/// 最近一次成功核对的输入指纹与完成时刻（issue #766）。
///
/// 一次启动里 `ensure` 会被调用两次：Rust 侧 auto_start（`workflow::start` →
/// `launch`）与前端 boot 的 `ensure_internal_plugins` 命令，两者间隔只有几百
/// 毫秒～几秒，输入（档案清单 + 核心版本 + 内置插件集合）完全一致，第二路必然
/// 整轮 no-op，却仍要重跑清单解析、失效链接清理、可写性预检与 loader 状态修复。
/// 记下成功结论后，第二路直接复用。
///
/// 只记成功：失败/取消绝不入缓存——两路中任何一路失败，另一路仍会完整重跑并把
/// 真实错误暴露给前端。指纹含档案清单内容，安装/卸载/去重都会让它自然失效。
#[derive(Clone)]
struct EnsureReceipt {
    fingerprint: u64,
    completed_at: std::time::Instant,
}

#[derive(Clone)]
struct EnsureFlight {
    id: u64,
    owner: ProcessOwner,
    state: EnsureFlightState,
    result: tokio::sync::watch::Receiver<Option<Result<(), String>>>,
    cancel: tokio::sync::watch::Sender<bool>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum EnsureFlightState {
    Running,
    Cancelling,
    CleanupFailed(String),
}

enum EnsureSubscription {
    Running(tokio::sync::watch::Receiver<Option<Result<(), String>>>),
    Cancelling(tokio::sync::watch::Receiver<Option<Result<(), String>>>),
    CleanupFailed(String),
}

#[derive(Default)]
struct EnsureCoordinator {
    next_id: u64,
    active: Option<EnsureFlight>,
    receipt: Option<EnsureReceipt>,
}

impl EnsureCoordinator {
    /// 输入未变、且上次成功核对仍在窗口内：本次调用无需再做任何事。
    fn reuse(&self, fingerprint: u64) -> bool {
        self.receipt.as_ref().is_some_and(|receipt| {
            receipt.fingerprint == fingerprint
                && receipt.completed_at.elapsed() <= ENSURE_REUSE_WINDOW
        })
    }

    fn record(&mut self, fingerprint: u64) {
        self.receipt = Some(EnsureReceipt {
            fingerprint,
            completed_at: std::time::Instant::now(),
        });
    }

    fn subscribe(&self) -> Option<EnsureSubscription> {
        self.active.as_ref().map(|flight| match &flight.state {
            EnsureFlightState::Running => EnsureSubscription::Running(flight.result.clone()),
            EnsureFlightState::Cancelling => EnsureSubscription::Cancelling(flight.result.clone()),
            EnsureFlightState::CleanupFailed(reason) => {
                EnsureSubscription::CleanupFailed(reason.clone())
            }
        })
    }

    #[allow(clippy::type_complexity)]
    fn start(
        &mut self,
    ) -> (
        u64,
        ProcessOwner,
        tokio::sync::watch::Sender<Option<Result<(), String>>>,
        tokio::sync::watch::Receiver<Option<Result<(), String>>>,
        tokio::sync::watch::Sender<bool>,
        tokio::sync::watch::Receiver<bool>,
    ) {
        self.next_id = self.next_id.wrapping_add(1);
        let id = self.next_id;
        let owner = new_process_owner();
        let (result_tx, result_rx) = tokio::sync::watch::channel(None);
        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        self.active = Some(EnsureFlight {
            id,
            owner,
            state: EnsureFlightState::Running,
            result: result_rx.clone(),
            cancel: cancel_tx.clone(),
        });
        (id, owner, result_tx, result_rx, cancel_tx, cancel_rx)
    }

    fn finish(&mut self, id: u64) {
        if self.active.as_ref().is_some_and(|flight| flight.id == id) {
            self.active = None;
        }
    }

    fn begin_cancel(&mut self) -> Option<tokio::sync::watch::Receiver<Option<Result<(), String>>>> {
        let active = self.active.as_mut()?;
        if !matches!(&active.state, EnsureFlightState::CleanupFailed(_)) {
            active.state = EnsureFlightState::Cancelling;
            let _ = active.cancel.send(true);
        }
        Some(active.result.clone())
    }

    fn mark_cleanup_failed(&mut self, id: u64, reason: String) {
        if let Some(active) = self.active.as_mut().filter(|flight| flight.id == id) {
            active.state = EnsureFlightState::CleanupFailed(reason);
        }
    }
}

fn ensure_lock(profile: &str) -> std::sync::Arc<tokio::sync::Mutex<EnsureCoordinator>> {
    static COORDINATORS: std::sync::OnceLock<
        std::sync::Mutex<HashMap<String, std::sync::Arc<tokio::sync::Mutex<EnsureCoordinator>>>>,
    > = std::sync::OnceLock::new();
    COORDINATORS
        .get_or_init(std::sync::Mutex::default)
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .entry(profile.to_string())
        .or_default()
        .clone()
}

/// 在启动 Harness 前修复旧桌面目录遗留的 profile loader 状态。
///
/// 这一步必须发生在启动 dsh 子进程之前：dsh 会同时合并 bundle patch、profile
/// patch、home patch；如果旧 checkout 曾把内置插件 patch 写入其中，单纯重装
/// `node_modules` 无法消除重复 loader entry。只清理桌面端明确拥有的内置 id，
/// 绝不触碰用户插件。
fn repair_loader_state(
    profile: &Path,
    dsh_home: &Path,
    internal: &[&PreinstallPluginInfo],
    manifest: &mut Option<serde_json::Value>,
    prepare: bool,
) -> Result<bool, String> {
    let bundle_ids: HashSet<&str> = internal.iter().map(|preset| preset.id.as_str()).collect();
    let mut pending = false;
    if let Some(manifest) = manifest.as_mut() {
        if dedupe_profile_bundles(manifest) {
            if prepare {
                write_profile_manifest(&profile.join("package.json"), manifest)?;
            } else {
                pending = true;
            }
        }
    }

    for patch_path in super::patch_layer_paths(profile, dsh_home) {
        let raw = match std::fs::read_to_string(&patch_path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                let code = if error.kind() == std::io::ErrorKind::InvalidData {
                    super::patch_guard::PATCH_ENCODING_FAILED
                } else {
                    "INTERNAL_PLUGIN_PATCH_READ_FAILED"
                };
                return Err(format!("{code}: {}: {error}", patch_path.display()));
            }
        };
        let mut patch = super::parse_patch_layer(&raw).map_err(|e| {
            format!(
                "INTERNAL_PLUGIN_PATCH_PARSE_FAILED: {}: {e}",
                patch_path.display()
            )
        })?;
        if remove_duplicate_bundle_entries_from_patch(&mut patch, &bundle_ids) {
            if !prepare {
                pending = true;
                continue;
            }
            let rendered = super::render_patch_layer(&patch)
                .map_err(|e| format!("INTERNAL_PLUGIN_PATCH_RENDER_FAILED: {e}"))?;
            super::atomic_write::write_patch_layer_atomically(&patch_path, &rendered).map_err(
                |e| {
                    format!(
                        "INTERNAL_PLUGIN_PATCH_WRITE_FAILED: {}: {e}",
                        patch_path.display()
                    )
                },
            )?;
            log::warn!(
                "INTERNAL_PLUGIN_PROFILE_MIGRATED: removed stale internal loader entries from {}",
                patch_path.display()
            );
        }
    }

    if !prepare {
        return Ok(pending);
    }

    // dsh 会把运行时组合结果写回 cordis.yml；旧版本留下的组合结果会在下一次
    // 启动时与新 patch 再合并，必须恢复官方约定的空根配置。
    let root = profile.join("cordis.yml");
    const EMPTY_ROOT: &str = "# dsh profile root — an empty entry list. The tree is composed as patches:\n# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any\n# --patch overlays. Edit cordis.patch.yml, not this file.\n[]\n";
    let existing = match std::fs::read_to_string(&root) {
        Ok(raw) => Some(raw),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(format!(
                "INTERNAL_PLUGIN_ROOT_READ_FAILED: {}: {error}",
                root.display()
            ))
        }
    };
    if existing.as_deref() != Some(EMPTY_ROOT) && profile.is_dir() {
        std::fs::write(&root, EMPTY_ROOT)
            .map_err(|e| format!("INTERNAL_PLUGIN_ROOT_WRITE_FAILED: {}: {e}", root.display()))?;
        log::warn!(
            "INTERNAL_PLUGIN_PROFILE_MIGRATED: reset stale profile root {}",
            root.display()
        );
    }
    Ok(false)
}

/// 核对输入指纹：档案路径 + loader 状态修复的全部输入 + 核心版本 + 内置插件的安装规格。
///
/// 只用于判断「这次调用与上次成功的那次是不是同一份输入」，因此取的都是廉价且必然
/// 随状态变化而变化的量。除了档案清单，还必须带上 `repair_loader_state` 会读写的另三个
/// 文件（档案根 `cordis.yml` 与两层 patch 层）：只盯 `package.json` 的话，patch 被改或
/// 根被写脏时指纹不变，复用就会连修复一起跳过，把脏状态留在档案里。内置插件按元组排序
/// 后整体喂入，避免清单条目顺序抖动造成假失效。
fn ensure_fingerprint(app_handle: &AppHandle, internal: &[PreinstallPluginInfo]) -> u64 {
    use std::hash::{Hash, Hasher};

    let profile = profile_dir(app_handle);
    let dsh_home = config::get_dsh_data_path(app_handle);
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    profile.to_string_lossy().as_ref().hash(&mut hasher);
    std::fs::read(profile.join("package.json"))
        .unwrap_or_default()
        .hash(&mut hasher);
    std::fs::read(profile.join("cordis.yml"))
        .unwrap_or_default()
        .hash(&mut hasher);
    for patch_path in super::patch_layer_paths(&profile, &dsh_home) {
        std::fs::read(patch_path)
            .unwrap_or_default()
            .hash(&mut hasher);
    }
    crate::service::core::active_version(app_handle).hash(&mut hasher);
    let mut specs: Vec<(&str, &str, &str)> = internal
        .iter()
        .map(|preset| {
            (
                preset.id.as_str(),
                preset.spec.as_str(),
                installed_name(preset),
            )
        })
        .collect();
    specs.sort_unstable();
    specs.hash(&mut hasher);
    hasher.finish()
}

pub(crate) async fn ensure(app_handle: &AppHandle) -> Result<(), String> {
    let profile = crate::service::profile::active_profile(app_handle);
    crate::service::workflow::instances::scope(profile, ensure_scoped(app_handle)).await
}

async fn ensure_scoped(app_handle: &AppHandle) -> Result<(), String> {
    let lock = ensure_lock(&crate::service::profile::active_profile(app_handle));
    let presets = load_presets(app_handle);
    let core_version = crate::service::core::active_version(app_handle);
    let internal: Vec<_> = presets
        .into_iter()
        .filter(|p| p.internal && !p.unsupported_on(core_version.as_deref()))
        .collect();
    if crate::service::workflow::has_owned_process() {
        if config::manifest::read(app_handle).is_none() {
            return Err("INTERNAL_PLUGIN_RESTART_REQUIRED: 内置插件清单不可读；请恢复应用资源后通过正常启动重试。".into());
        }
        let refs: Vec<_> = internal.iter().collect();
        let profile = profile_dir(app_handle);
        let check = prepare_internal_plugins(
            &profile,
            &config::get_dsh_data_path(app_handle),
            &refs,
            false,
            |id| bundled_plugin_dir(app_handle, id),
        )?;
        return require_running_plugins_ready(&profile, &check);
    }
    // 同一次启动的两路调用：后到的一路输入未变、且前一路刚成功，直接复用结论，
    // 连下面的失效链接清理、可写性预检与 loader 状态修复一起跳过（issue #766）。
    let fingerprint = ensure_fingerprint(app_handle, &internal);
    let reused = if internal.is_empty() {
        false
    } else {
        lock.lock().await.reuse(fingerprint)
    };
    if reused {
        log::debug!(
            "Internal plugin check already succeeded for the current profile state, skipping"
        );
        return Ok(());
    }
    let outcome =
        receive_current_or_next_flight(|| subscribe_or_start(app_handle, &internal)).await;
    if outcome.is_ok() {
        // 记「完成后的」指纹：本轮自己写回的状态（去重/修复/安装）就是已被核对过的
        // 状态，后到的那一路按同一状态算指纹即可命中，不会白跑第二轮。
        lock.lock()
            .await
            .record(ensure_fingerprint(app_handle, &internal));
    }
    outcome
}

async fn subscribe_or_start(
    app_handle: &AppHandle,
    internal: &[PreinstallPluginInfo],
) -> EnsureSubscription {
    let profile = crate::service::profile::active_profile(app_handle);
    let lock = ensure_lock(&profile);
    let mut coordinator = lock.lock().await;
    match coordinator.subscribe() {
        Some(subscription) => subscription,
        None => {
            let (id, owner, result_tx, result_rx, cancel_tx, cancel_rx) = coordinator.start();
            let app_handle = app_handle.clone();
            let internal = internal.to_vec();
            let lock = lock.clone();
            tauri::async_runtime::spawn(crate::service::workflow::instances::scope(
                profile,
                async move {
                    let mut outcome =
                        run_ensure_operation(&app_handle, &internal, owner, cancel_tx, cancel_rx)
                            .await;
                    // 强杀返回不等于持有句柄的 wait 已完成；必须等精确 owner 的 PID
                    // 守卫随 wait 退出，才能发布结果并允许 Retry 创建下一次 flight。

                    if !wait_for_owner_release(owner, ENSURE_OWNER_DRAIN_TIMEOUT).await {
                        let reason = format!(
                        "INTERNAL_PLUGIN_PROCESS_REAP_TIMEOUT: plugin process owner {owner:?} remained active for {} seconds",
                        ENSURE_OWNER_DRAIN_TIMEOUT.as_secs()
                    );
                        log::error!("{reason}");
                        outcome = Err(reason.clone());
                        let _ = result_tx.send(Some(outcome));
                        lock.lock().await.mark_cleanup_failed(id, reason);
                        // 保留 cleanup-failed flight 与唯一 owner；进程锁仍由 wait 线程持有。
                        // 若系统最终完成 reap，再释放 flight 允许后续 Retry。
                        while super::process::active_plugin_pid(owner).is_some() {
                            tokio::time::sleep(ENSURE_OWNER_DRAIN_INTERVAL).await;
                        }
                        lock.lock().await.finish(id);
                        return;
                    }
                    lock.lock().await.finish(id);
                    let _ = result_tx.send(Some(outcome));
                },
            ));
            EnsureSubscription::Running(result_rx)
        }
    }
}

async fn receive_current_or_next_flight<F, Fut>(mut acquire: F) -> Result<(), String>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = EnsureSubscription>,
{
    loop {
        let subscription = acquire().await;
        match subscription {
            EnsureSubscription::Running(mut result) => {
                return receive_flight_result(&mut result).await?;
            }
            EnsureSubscription::Cancelling(mut result) => {
                // Retry 不继承已取消 flight 的结果；等它完成清理并从 coordinator
                // 移除后回到循环，创建且只创建一个全新的 flight。
                let _ = receive_flight_result(&mut result).await?;
            }
            EnsureSubscription::CleanupFailed(reason) => return Err(reason),
        }
    }
}

async fn wait_for_owner_release(
    owner: super::process::ProcessOwner,
    timeout: std::time::Duration,
) -> bool {
    wait_for_release_with(
        || super::process::active_plugin_pid(owner).is_some(),
        timeout,
        ENSURE_OWNER_DRAIN_INTERVAL,
    )
    .await
}

async fn wait_for_release_with<F>(
    mut is_active: F,
    timeout: std::time::Duration,
    interval: std::time::Duration,
) -> bool
where
    F: FnMut() -> bool,
{
    let started = tokio::time::Instant::now();
    loop {
        if !is_active() {
            return true;
        }
        let elapsed = started.elapsed();
        if elapsed >= timeout {
            return false;
        }
        tokio::time::sleep(interval.min(timeout - elapsed)).await;
    }
}

async fn receive_flight_result(
    result: &mut tokio::sync::watch::Receiver<Option<Result<(), String>>>,
) -> Result<Result<(), String>, String> {
    loop {
        if let Some(outcome) = result.borrow().clone() {
            return Ok(outcome);
        }
        result.changed().await.map_err(|_| {
            "INTERNAL_PLUGIN_ENSURE_DROPPED: install task ended without result".to_string()
        })?;
    }
}

/// 取消共享的内置插件安装并等待拥有者完成清理，确保 Retry 不会叠加新进程。
pub(crate) async fn cancel() -> Result<(), String> {
    let mut result = {
        let profile =
            crate::service::workflow::instances::current_profile().unwrap_or_else(|| crate::service::profile::DEFAULT_PROFILE.into());
        let lock = ensure_lock(&profile);
        let mut coordinator = lock.lock().await;
        let Some(active) = &coordinator.active else {
            return Ok(());
        };
        log::info!(
            "cancelling internal plugin ensure flight owned by {:?}",
            active.owner
        );
        coordinator
            .begin_cancel()
            .expect("active flight must remain present while coordinator lock is held")
    };
    match receive_flight_result(&mut result).await? {
        Err(reason) if reason.starts_with("INTERNAL_PLUGIN_PROCESS_REAP_TIMEOUT:") => Err(reason),
        _ => Ok(()),
    }
}

async fn run_ensure_operation(
    app_handle: &AppHandle,
    internal: &[PreinstallPluginInfo],
    owner: ProcessOwner,
    cancel_tx: tokio::sync::watch::Sender<bool>,
    cancel: tokio::sync::watch::Receiver<bool>,
) -> Result<(), String> {
    let total = internal.len();
    emit_phase(
        app_handle,
        "loading",
        InternalPluginPhaseDetail::Waiting,
        0,
        total,
    );
    emit_phase(
        app_handle,
        "progress",
        InternalPluginPhaseDetail::Checking,
        0,
        total,
    );
    let refs: Vec<_> = internal.iter().collect();
    let operation = ensure_inner(app_handle, &refs, cancel.clone(), owner);
    wait_for_ensure_operation(
        operation,
        total,
        owner,
        cancel_tx,
        cancel,
        |phase, detail, completed| emit_phase(app_handle, phase, detail, completed, total),
    )
    .await
}

async fn wait_for_ensure_operation(
    operation: impl Future<Output = Result<(), String>>,
    total: usize,
    owner: ProcessOwner,
    cancel_tx: tokio::sync::watch::Sender<bool>,
    mut cancel: tokio::sync::watch::Receiver<bool>,
    mut emit: impl FnMut(&'static str, InternalPluginPhaseDetail, usize),
) -> Result<(), String> {
    tokio::pin!(operation);
    let deadline = tokio::time::sleep(ENSURE_ABSOLUTE_TIMEOUT);
    tokio::pin!(deadline);
    let period = std::time::Duration::from_secs(5);
    let mut heartbeat = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            outcome = &mut operation => {
                if outcome.as_ref().is_err_and(|reason| reason.starts_with("INTERNAL_PLUGIN_INSTALL_CANCELLED:")) {
                    emit("done", InternalPluginPhaseDetail::Cancelled, 0);
                } else {
                    emit("done", InternalPluginPhaseDetail::Done, total);
                }
                return outcome;
            }
            _ = &mut deadline => {
                let reason = "INTERNAL_PLUGIN_INSTALL_TIMEOUT: plugin install exceeded 600 seconds";
                log::error!("{reason}");
                let _ = cancel_tx.send(true);
                terminate_owned_install(owner).await;
                if tokio::time::timeout(ENSURE_CLEANUP_TIMEOUT, &mut operation).await.is_err() {
                    log::error!("INTERNAL_PLUGIN_CLEANUP_TIMEOUT: plugin process did not exit after forced termination");
                }
                emit("done", InternalPluginPhaseDetail::Timeout, 0);
                return Err(reason.to_string());
            }
            changed = cancel.changed() => {
                if changed.is_err() || *cancel.borrow() {
                    let reason = "INTERNAL_PLUGIN_INSTALL_CANCELLED: plugin install was cancelled";
                    log::warn!("{reason}");
                    terminate_owned_install(owner).await;
                    if tokio::time::timeout(ENSURE_CLEANUP_TIMEOUT, &mut operation).await.is_err() {
                        log::error!("INTERNAL_PLUGIN_CLEANUP_TIMEOUT: plugin process did not exit after forced termination");
                    }
                    emit("done", InternalPluginPhaseDetail::Cancelled, 0);
                    return Err(reason.to_string());
                }
            }
            _ = heartbeat.tick() => {
                emit("progress", InternalPluginPhaseDetail::Heartbeat, 0);
            }
        }
    }
}

fn emit_phase(
    app_handle: &AppHandle,
    phase: &'static str,
    detail: InternalPluginPhaseDetail,
    completed: usize,
    total: usize,
) {
    crate::service::workflow::instances::emit(
        app_handle,
        "internal-plugins-phase",
        InternalPluginsPhase {
            phase,
            detail,
            completed,
            total,
        },
    );
}

struct InternalPluginCheck {
    manifest: Option<serde_json::Value>,
    need: Vec<(String, String, PathBuf)>,
    orphans: Vec<String>,
    sources_ready: bool,
    migration_pending: bool,
}

fn prepare_internal_plugins(
    profile: &Path,
    dsh_home: &Path,
    internal: &[&PreinstallPluginInfo],
    prepare: bool,
    resolve_bundle: impl Fn(&str) -> Option<PathBuf>,
) -> Result<InternalPluginCheck, String> {
    let manifest_path = profile.join("package.json");
    let mut manifest = match std::fs::read_to_string(&manifest_path) {
        Ok(raw) => Some(
            serde_json::from_str::<serde_json::Value>(&raw)
                .map_err(|e| format!("INTERNAL_PLUGIN_MANIFEST_PARSE_FAILED: {e}"))?,
        ),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("INTERNAL_PLUGIN_MANIFEST_READ_FAILED: {e}")),
    };
    if prepare {
        crate::service::perm::ensure_writable_path(profile, dsh_home, "PROFILE_NOT_WRITABLE")?;
    }
    let mut migration_pending =
        repair_loader_state(profile, dsh_home, internal, &mut manifest, prepare)?;
    let parsed = manifest
        .as_ref()
        .map(|value| serde_json::from_value::<ProfilePackageJson>(value.clone()))
        .transpose()
        .map_err(|error| format!("INTERNAL_PLUGIN_MANIFEST_SCHEMA_FAILED: {error}"))?;
    let empty_dependencies = HashMap::new();
    let dependencies = parsed
        .as_ref()
        .map(|manifest| &manifest.dependencies)
        .unwrap_or(&empty_dependencies);
    let keep: HashSet<&str> = internal
        .iter()
        .flat_map(|preset| [preset.id.as_str(), installed_name(preset)])
        .collect();
    let mut orphans = manifest
        .as_ref()
        .map(|manifest| collect_dangling_local_link_deps(manifest, &keep, profile))
        .unwrap_or_default();
    let mut need = Vec::new();
    let mut sources_ready = true;
    let mut skipped = HashSet::new();
    for preset in internal {
        let name = installed_name(preset);
        if super::disable::has_patch_disable(&profile, &preset.id)
            || super::disable::has_patch_disable(&profile, name)
        {
            continue;
        }
        let entry = profile.join("node_modules").join(name);
        let link_ok = internal_plugin_entry_is_ready(&entry);
        let bundled = resolve_bundle(&preset.id);
        let Some(bundled) = bundled.filter(|source| internal_plugin_entry_is_ready(source)) else {
            log::warn!("INTERNAL_PLUGIN_SOURCE_MISSING: {name}: bundled manifest or host entry unavailable, skipping repair (installed_ready={link_ok})");
            sources_ready = false;
            if !link_ok {
                skipped.insert(name);
            }
            continue;
        };
        let name = name.to_string();
        let expected = bundled_dep_spec(&bundled);
        // ① 依赖声明：未声明，或声明的值不再指向当前捆绑目录（路径变更/被改
        // 写）→ 重装；② 依赖真实性：node_modules 链接/拷贝须真实存在（用户
        // 手动清过 node_modules 时声明可能残留但产物已不在）→ 重装。
        let dep_ok = dependencies
            .get(&name)
            .is_some_and(|actual| dep_matches_spec(actual, &expected));

        // ③ 挂载登记：`dsh.profile.bundles` 缺项时插件从不挂载——宿主插件的 apply
        // （含 dsh-tauri 的载体鉴权 gate）不运行，索引恒 401、健康检查永远
        // `boot page returned 401`。这种「依赖在、bundle 没登记」的半残状态必须判为
        // 需重装：只按 deps/link 判定会把它当成就绪，装过一次后永远修不回来。
        let bundle_ok = manifest
            .as_ref()
            .and_then(|value| value.pointer("/dsh/profile/bundles"))
            .and_then(|bundles| bundles.as_array())
            .is_some_and(|bundles| {
                bundles
                    .iter()
                    .any(|bundle| bundle.as_str() == Some(name.as_str()))
            });
        if !dep_ok || !link_ok || !bundle_ok {
            log::info!(
                "INTERNAL_PLUGIN_NEEDS_REINSTALL: {name}（dep_ok={dep_ok}, link_ok={link_ok}, bundle_ok={bundle_ok}, expected={expected}）"
            );
            // 应用升级会移动 `.app` 内的捆绑目录，旧 profile 可能留下指向上个
            // 版本资源的悬空链接。pnpm 在处理这些入口时会在真正改写依赖前以
            // 254 退出；先只清理 node_modules 入口（绝不跟随链接删除目标），再
            // 走常规 add，令 pnpm 从当前捆绑目录重建链接。
            need.push((preset.id.clone(), name, entry));
        }
    }
    if let Some(value) = manifest.as_mut() {
        if manifest::remove_internal_plugin_bundles(value, &skipped) {
            if prepare {
                write_profile_manifest(&manifest_path, value)?;
            } else {
                migration_pending = true;
            }
        }
    }
    orphans.sort();
    orphans.dedup();
    Ok(InternalPluginCheck {
        manifest,
        need,
        orphans,
        sources_ready,
        migration_pending,
    })
}

fn require_running_plugins_ready(
    profile: &Path,
    check: &InternalPluginCheck,
) -> Result<(), String> {
    let fallback = profile
        .join(".dsh-module-fallback")
        .try_exists()
        .map_err(|error| format!("INTERNAL_PLUGIN_FALLBACK_READ_FAILED: {error}"))?;
    if check.manifest.is_none()
        || !check.need.is_empty()
        || !check.orphans.is_empty()
        || check.migration_pending
        || fallback
    {
        return Err(format!(
            "INTERNAL_PLUGIN_RESTART_REQUIRED: 内置插件需要修复；请停止当前服务后通过正常启动重试（need={:?}, orphans={:?}, migration={}, sources_ready={}, fallback={}）。",
            check.need.iter().map(|(id, _, _)| id.as_str()).collect::<Vec<_>>(),
            check.orphans,
            check.migration_pending,
            check.sources_ready,
            fallback,
        ));
    }
    Ok(())
}

async fn prepare_internal_plugins_for_install(
    resolve_paths: impl FnOnce() -> (PathBuf, PathBuf),
    internal: &[&PreinstallPluginInfo],
    cancel: &tokio::sync::watch::Receiver<bool>,
    resolve_bundle: impl Fn(&str) -> Option<PathBuf>,
) -> Result<
    (
        tokio::sync::OwnedMutexGuard<()>,
        PathBuf,
        InternalPluginCheck,
    ),
    String,
> {
    let mut cancel_wait = cancel.clone();
    let operation = tokio::select! {
        operation = super::process::acquire_operation_lock() => operation?,
        _ = cancel_wait.wait_for(|cancelled| *cancelled) => {
            return Err("INTERNAL_PLUGIN_INSTALL_CANCELLED: plugin install was cancelled".into());
        }
    };
    if *cancel.borrow() {
        return Err("INTERNAL_PLUGIN_INSTALL_CANCELLED: plugin install was cancelled".into());
    }
    let (profile, dsh_home) = resolve_paths();
    let check = prepare_internal_plugins(&profile, &dsh_home, internal, true, resolve_bundle)?;
    Ok((operation, profile, check))
}

async fn ensure_inner(
    app_handle: &AppHandle,
    internal: &[&PreinstallPluginInfo],
    cancel: tokio::sync::watch::Receiver<bool>,
    owner: ProcessOwner,
) -> Result<(), String> {
    if *cancel.borrow() {
        return Err("INTERNAL_PLUGIN_INSTALL_CANCELLED: plugin install was cancelled".into());
    }
    let (operation, profile, check) = prepare_internal_plugins_for_install(
        || (profile_dir(app_handle), config::get_dsh_data_path(app_handle)),
        internal,
        &cancel,
        |id| bundled_plugin_dir(app_handle, id),
    )
    .await?;
    let manifest_path = profile.join("package.json");
    let InternalPluginCheck {
        mut manifest,
        need,
        orphans,
        ..
    } = check;
    if !orphans.is_empty() {
        log::info!("Uninstalling orphaned internal preset plugins: {orphans:?}");
        for name in &orphans {
            if !super::recovery::is_actionable_plugin_ref(name) {
                log::warn!("INTERNAL_PLUGIN_ORPHAN_SKIPPED: {name}（核心/官方包不执行孤儿卸载）");
                continue;
            }
            match super::uninstall_recovery(app_handle, name) {
                Ok(()) => {
                    if let Some(value) = manifest.as_mut() {
                        remove_internal_plugins_from_manifest(
                            value,
                            &HashSet::from([name.as_str()]),
                        );
                    }
                }
                Err(e) => log::warn!("INTERNAL_PLUGIN_ORPHAN_UNINSTALL_FAILED: {name}: {e}"),
            }
        }
    }
    // 无论本轮是否需要重装，都清理旧版 dsh 生成的 profile-local fallback。
    // 否则本轮 no-op 后，用户稍后从市场安装插件仍会把同一批 junction 交给 pnpm。
    //
    // best-effort（issue #466）：这只是旧目录的 housekeeping，失败绝不能中止本轮
    // 的插件核对/重装——该目录属主是 root（不可删除）时，用户看到的会是
    // 「Plugin installation 阶段失败：INTERNAL_PLUGIN_FALLBACK_REMOVE_FAILED」，
    // 把「档案目录权限不可写」这个真正要修的问题掩盖掉。与孤儿卸载「任何失败
    // 只记告警」的约定一致；安装失败分支同样忽略该错误。
    remove_legacy_profile_module_fallback_best_effort(&profile);
    if need.is_empty() {
        return Ok(());
    }

    let ids: Vec<String> = need.iter().map(|(id, _, _)| id.clone()).collect();
    log::info!("Reinstalling internal preset plugins: {ids:?}");
    emit_phase(
        app_handle,
        "progress",
        InternalPluginPhaseDetail::Installing,
        0,
        ids.len(),
    );

    // pnpm add 会先解析清单里的所有既有依赖。0.9.0 将随包目录从
    // `preset-plugins` 迁至 `internal-plugins` 后，旧 file:/link: 路径已不存在，pnpm
    // 会在真正改写依赖前以 ENOENT/254 退出。仅移除本轮即将重装的 internal 包声明
    // 与 bundle 引用，保留所有其它插件；add 成功后 dsh 会把它们按当前路径写回。
    if let Some(value) = manifest.as_mut() {
        let names: HashSet<&str> = need.iter().map(|(_, name, _)| name.as_str()).collect();
        if remove_internal_plugins_from_manifest(value, &names) {
            write_profile_manifest(&manifest_path, value)?;
        }
    }

    // 必须等全部检查完成后再删除旧入口：多个 internal id 可能映射到同一 npm 包，
    // 边遍历边删除会让后续原本健康的别名被误判缺失。统一去重后只删一次。
    //
    // 幂等跳过：仅删除「真的损坏/缺失」的入口。依赖声明缺失（dep_ok=false）但链接本身
    // 健康（link_ok=true）时仍会进入 need，此时绝不要 delete + recreate——Windows 下
    // 重建 junction/reparse point 后立即回读会随机 `-4094 [UNKNOWN] unknown error`
    // （issue #264），一处失败即令整个安装放弃、`link:` 依赖不落盘，下次启动又判定
    // dep_ok=false 再装，形成不可恢复的启动死循环。保留健康链接，交给本轮 `dsh plugin
    // add` 重写依赖声明即可（pnpm 处理 link: 依赖时会自行覆盖旧入口）。
    let mut entries = HashSet::new();
    for (_, _, entry) in &need {
        if !entries.insert(entry.clone()) {
            continue;
        }
        if internal_plugin_entry_is_ready(entry) {
            log::info!(
                "INTERNAL_PLUGIN_ENTRY_HEALTHY: keeping intact link {} (no delete + recreate)",
                entry.display()
            );
            continue;
        }
        remove_stale_plugin_entry(entry).map_err(|e| {
            format!(
                "INTERNAL_PLUGIN_STALE_ENTRY_REMOVE_FAILED: {}: {e}",
                entry.display()
            )
        })?;
    }
    // 复用常规安装编排（环境准备/补齐 pnpm/`dsh plugin add file:<dir>`）；
    // 启动阶段无持有进程，install 内部不会停服务。失败同样交给调用方告警。
    let install_result = install_internal(app_handle, &ids, cancel, owner, &operation).await;
    let _process = super::process::acquire_process_lock().await?;
    if let Err(e) = install_result {
        // 即使 pnpm 失败也清掉旧 fallback，下一次重试必须从干净入口开始。
        remove_legacy_profile_module_fallback_best_effort(&profile);
        // 两类**与内置插件本身无关**的 pnpm 失败都不该让启动自愈永久卡住：前者是
        // pnpm 的 `link:` 入口回读失败（libuv UV_UNKNOWN / 退出码 -4094，实时防护、
        // 云盘、重解析点过滤驱动等环境因素，重试与重装都越不过），后者是 pnpm 11 的
        // lockfile 供应链校验（`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`）把档案里
        // **已声明**的条目按发布时间判成违规，于是每一次插件操作都在这里硬失败
        // （issue #1348：内置插件每轮被打回，dsh-taiwind 永不落盘、界面错位）。
        // 内置插件的产物就随包分发，本不需要 registry 复核，因此统一改由桌面端自建
        // 链接并补齐清单（见 [`materialize`]）。
        let offline_reason = if is_supply_chain_policy_failure(&e) {
            Some("[harness] pnpm 的供应链校验拒绝了档案锁文件，内置插件改由应用直接建立链接…")
        } else if is_link_materialization_failure(&e, &need) {
            Some("[harness] pnpm 未把插件链接落盘，改由应用直接建立链接…")
        } else {
            None
        };
        if let Some(line) = offline_reason {
            crate::service::workflow::instances::emit(
                app_handle,
                PREINSTALL_LOG_EVENT,
                PreinstallLogPayload {
                    line: line.to_string(),
                },
            );
            match materialize_internal_links(app_handle, &profile, &need) {
                Ok(()) => {
                    log::warn!(
                        "INTERNAL_PLUGIN_OFFLINE_LINK_RECOVERED: internal plugin links materialized after pnpm failure: {e}"
                    );
                    return Ok(());
                }
                Err(fallback) => {
                    log::error!("INTERNAL_PLUGIN_OFFLINE_LINK_FAILED: {fallback}");
                    return Err(format!(
                        "INTERNAL_PLUGIN_INSTALL_FAILED: {e}（离线自建链接兜底失败：{fallback}）\n{}",
                        link_readback_hint(&profile)
                    ));
                }
            }
        }
        // 同一签名但诊断里读不到失败路径：无法确认失败的是内置插件入口，因此不做
        // 兜底（免得把用户自己依赖的真实失败吞成成功），只给可操作的排除项提示。
        if is_untraceable_link_readback_failure(&e) {
            log::warn!("INTERNAL_PLUGIN_OFFLINE_LINK_UNATTRIBUTED: {e}");
            return Err(format!(
                "INTERNAL_PLUGIN_INSTALL_FAILED: {e}\n{}",
                link_readback_hint(&profile)
            ));
        }
        return Err(format!("INTERNAL_PLUGIN_INSTALL_FAILED: {e}"));
    }

    // pnpm 成功 ≠ 链接与清单落盘：核心的 install 会按自己解析到的插件集重写
    // `dependencies` 与 `dsh.profile.bundles`，解析不到的内置插件会被**剪掉**
    // （本机 web profile 实测 13→2、11→0）；pnpm 也可能以 0 退出却没建出入口
    // （目标目录对它不可见时只发警告，见 pnpm local-resolver）。两者都会让内置
    // 插件不挂载：宿主插件的 apply 不运行，索引恒 401、健康检查永远 `boot page
    // returned 401`、最终 Process boot 超时。收尾同时回读入口与清单，缺任一项
    // 就用同一套物化路径写回（幂等）——否则 `bundle_ok` 每轮判需重装、每轮又被打回原形。
    let missing_manifest = presets_missing_from_manifest(&profile, &need);
    let unlinked = unlinked_internal_entries(&need);
    if missing_manifest.is_some() || !unlinked.is_empty() {
        materialize_internal_links(app_handle, &profile, &need)
            .map_err(|error| format!("INTERNAL_PLUGIN_MANIFEST_RECOVER_FAILED: {error}"))?;
        log::warn!(
            "INTERNAL_PLUGIN_MANIFEST_RECOVERED: repaired internal plugins after install (missing_manifest={missing_manifest:?}, unlinked={unlinked:?})"
        );
    }

    Ok(())
}

/// 安装后仍未真实落盘的内置插件入口（`node_modules/<name>/package.json` 不可读）。
fn unlinked_internal_entries(need: &[(String, String, PathBuf)]) -> Vec<String> {
    need.iter()
        .filter(|(_, _, entry)| !internal_plugin_entry_is_ready(entry))
        .map(|(_, name, _)| name.clone())
        .collect()
}

/// 安装收尾校验：返回清单里缺登记的安装包名（`dependencies` 与
/// `dsh.profile.bundles` 任一缺失即算），全都在则返回 `None`。
fn presets_missing_from_manifest(
    profile: &Path,
    need: &[(String, String, PathBuf)],
) -> Option<Vec<String>> {
    let manifest = std::fs::read_to_string(profile.join("package.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());
    let dependencies = manifest
        .as_ref()
        .and_then(|value| value.get("dependencies"));
    let bundles = manifest
        .as_ref()
        .and_then(|value| value.pointer("/dsh/profile/bundles"))
        .and_then(|value| value.as_array());
    let missing: Vec<String> = need
        .iter()
        .filter(|(_, name, _)| {
            let dep_ok = dependencies
                .and_then(|deps| deps.get(name.as_str()))
                .and_then(|value| value.as_str())
                .is_some();
            let bundle_ok = bundles.is_some_and(|list| {
                list.iter()
                    .any(|bundle| bundle.as_str() == Some(name.as_str()))
            });
            !dep_ok || !bundle_ok
        })
        .map(|(_, name, _)| name.clone())
        .collect();
    (!missing.is_empty()).then_some(missing)
}

/// 安全软件排除项提示：兜底失败与「同类但无法归因」时都要给，避免用户只看到裸
/// pnpm 报错而无从下手。
fn link_readback_hint(profile: &Path) -> String {
    format!(
        "提示：若本机安全软件（实时防护 / EDR / 云盘同步）拦截了档案目录的目录链接，\
         请把 {} 加入排除项后重试。",
        profile.join("node_modules").display()
    )
}

/// pnpm 诊断是否属于「`link:` 入口建成后回读 / 落盘失败」这一类签名（尚未归因）。
///
/// 注意退出码的措辞：`install` 落盘的是 `dsh plugin exited with code -4094`，
/// 匹配 `code -4094` 而不是 `exit code -4094`。
fn looks_like_link_readback_failure(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("preinstall_failed")
        && lower.contains("node_modules")
        && (lower.contains("code -4094") || lower.contains("unknown error, open"))
}

/// pnpm 的 lockfile 供应链校验（`minimumReleaseAge`）把档案里**已声明**的条目按发布
/// 时间判成违规——每一次插件操作都会在这里硬失败，与内置插件的产物本身无关（包目录
/// 随安装包分发）。因此这类失败同样改走离线自建链接，而不是把启动自愈卡死（#1348）。
///
/// 两种可观测形态都认：`install` 解析出精确条目时返回 `PLUGIN_POLICY_BLOCKED: [...]`；
/// 解析不出条目（pnpm 文案改版、违规条目来自用户自己的依赖）时只剩 pnpm 的原始输出
/// `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` / `Lockfile failed supply-chain policy check`。
fn is_supply_chain_policy_failure(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    // 同一句标题也用于信任降级（用户自己的依赖被降级），那不是发布时间门禁，不能绕过
    if trust_policy_rejection(error) {
        return false;
    }
    lower.contains("plugin_policy_blocked:")
        || lower.contains("err_pnpm_minimum_release_age_violation")
        || lower.contains("lockfile failed supply-chain policy check")
}

/// 同类签名但诊断里读不到失败路径：无从确认失败的就是内置插件入口。
fn is_untraceable_link_readback_failure(error: &str) -> bool {
    failed_open_path(error).is_none() && looks_like_link_readback_failure(error)
}

/// 判定安装失败是否属于「pnpm 建好 `link:` 入口后无法回读 / 未落盘」且**可归因到
/// 本轮待装的内置插件**——即离线自建链接能修、且修了不会掩盖别的失败的那一类。
///
/// - `PREINSTALL_SILENT_FAIL`：pnpm 以 0 退出却没落盘产物（源码存在时自建链接必然成功）；
/// - `cannot resolve profile bundle "<name>"`：pnpm 以 0 退出后，dsh 结算新依赖时
///   解析不到 `node_modules/<name>`（pnpm 对「目标目录不可见 / 刚建好的重解析点」
///   只发警告并 exit 0），**且**点名的包是本轮待装入口；
/// - `PREINSTALL_FAILED`：诊断含 `node_modules` 与 `unknown error, open
///   '<profile>/node_modules/...'`（或退出码 `-4094`，libuv `UV_UNKNOWN`），**且**
///   诊断里的失败路径确实落在本轮待装入口之下。
///
/// 网络 / spec / git 传输层 / 入口构建失败绝不命中：那些不是链接问题。同一签名也
/// 可能来自用户自己的 `link:` 依赖（`pnpm add` 会一并解析档案依赖），路径不可归因
/// 时一律不兜底——宁可漏修也不能把真实失败吞成「安装成功」，此时调用方改为给出
/// 排除项提示（见 [`is_untraceable_link_readback_failure`] 与 [`link_readback_hint`]）。
fn is_link_materialization_failure(error: &str, need: &[(String, String, PathBuf)]) -> bool {
    if error
        .to_ascii_lowercase()
        .contains("preinstall_silent_fail")
    {
        return true;
    }
    if names_unresolved_internal_bundle(error, need) {
        return true;
    }
    if !looks_like_link_readback_failure(error) {
        return false;
    }
    match failed_open_path(error) {
        Some(path) => need
            .iter()
            .any(|(_, _, entry)| path_lives_under(&path, entry)),
        None => false,
    }
}

/// 诊断是否点名了「本轮待装内置插件解析不到」。`dsh` 的措辞是
/// `cannot resolve profile bundle "<package>"`，包名即 `dsh.profile.bundles` 里的
/// 安装名；只比对安装名——预设 id 与安装名不同（scoped 包）时用 id 比对，会把用户
/// 同名的普通依赖误认成内置插件。
fn names_unresolved_internal_bundle(error: &str, need: &[(String, String, PathBuf)]) -> bool {
    if !error.contains("cannot resolve profile bundle") {
        return false;
    }
    need.iter().any(|(_, name, _)| {
        error.contains(&format!("cannot resolve profile bundle \"{name}\""))
            || error.contains(&format!("cannot resolve profile bundle '{name}'"))
    })
}

/// 取 pnpm 诊断里 `unknown error, open '<path>'` 的路径（统一分隔符、去尾斜杠）。
fn failed_open_path(error: &str) -> Option<String> {
    const MARKER: &str = "unknown error, open ";
    // 大小写折叠只改 ASCII 字节，偏移量在两份字符串上一致，因此仍返回原始大小写。
    let lower = error.to_ascii_lowercase();
    let start = lower.find(MARKER)? + MARKER.len();
    let rest = error.get(start..)?.trim_start();
    let rest = rest.strip_prefix('\'')?;
    let end = rest.find('\'')?;
    Some(normalize_link_path(&rest[..end]))
}

fn normalize_link_path(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_string()
}

/// 路径比较统一折叠大小写：Windows 不区分大小写，宁可漏兜底也不误吞其它依赖的失败。
fn path_lives_under(path: &str, entry: &Path) -> bool {
    let entry = normalize_link_path(&entry.to_string_lossy()).to_ascii_lowercase();
    let path = path.to_ascii_lowercase();
    path == entry || path.starts_with(&format!("{entry}/"))
}

/// 用桌面端的目录链接实现落盘本轮待修复的内置插件入口（离线、不依赖 node/pnpm）。
fn materialize_internal_links(
    app_handle: &AppHandle,
    profile: &Path,
    need: &[(String, String, PathBuf)],
) -> Result<(), String> {
    let mut links = Vec::with_capacity(need.len());
    for (id, name, entry) in need {
        let bundled = bundled_plugin_dir(app_handle, id)
            .ok_or_else(|| format!("INTERNAL_PLUGIN_BUNDLE_MISSING: {id}"))?;
        links.push(OfflineLink {
            id: id.clone(),
            name: name.clone(),
            spec: bundled_dep_spec(&bundled),
            bundled,
            entry: entry.clone(),
        });
    }
    materialize_links(profile, &links)?;
    // pnpm 失败路径已为这些 id 记过安装错误；兜底成功后必须清掉，否则插件面板
    // 会继续显示「安装失败」而实际上插件已就绪（与 verify 的成功路径一致）。
    for (id, _, _) in need {
        if let Err(e) = super::errors::clear(app_handle, id) {
            log::warn!("failed to clear plugin error for {id} after offline link: {e}");
        }
    }
    Ok(())
}

/// best-effort 包装：旧版 profile-local fallback 清理失败只记告警，绝不阻断本轮的
/// 插件核对与重装（issue #466）。返回 `Err` 的原函数保留完整错误细节供日志定位。
fn remove_legacy_profile_module_fallback_best_effort(profile: &Path) {
    if let Err(e) = remove_legacy_profile_module_fallback(profile) {
        log::warn!("INTERNAL_PLUGIN_FALLBACK_CLEANUP_FAILED: {e}");
    }
}

/// 清理旧版 profile-local fallback，避免 pnpm 管理跨目录 junction。
///
/// 先判回退目录是否存在，不存在即返回：要删的 junction 全部指向该目录
/// （[`is_legacy_profile_fallback_target`]），本函数又是仓库内唯一的删除方——删除
/// 之前必先扫过链接，遍历失败则提前返回、不删目录。所以「目录已不存在、却仍有指向
/// 它的链接」只可能来自仓库外的删除（用户手工删掉该目录，或旧版核心自行清理）；那
/// 属于残缺状态，后续插件安装与自愈会重新解析，不值得为它让每次启动都付全树遍历的
/// 代价。
///
/// 该遍历（本机 2273 项 / 207 目录 ≈ 480ms）在健康档案下是纯开销，而它位于每次
/// 启动都要走的核对路径上，必须跳过。
fn remove_legacy_profile_module_fallback(profile: &Path) -> Result<(), String> {
    let fallback = profile.join(".dsh-module-fallback");
    if !fallback.is_dir() {
        return Ok(());
    }

    let node_modules = profile.join("node_modules");
    if node_modules.is_dir() {
        remove_legacy_fallback_links(&node_modules)?;
    }

    std::fs::remove_dir_all(&fallback).map_err(|e| {
        format!(
            "INTERNAL_PLUGIN_FALLBACK_REMOVE_FAILED: {}: {e}",
            fallback.display()
        )
    })?;
    log::info!(
        "Removed legacy profile-local module fallback: {}",
        fallback.display()
    );
    Ok(())
}

/// 递归删除旧 fallback 中的 junction，先处理链接本身，不跟随到资源目录。
fn remove_legacy_fallback_links(root: &Path) -> Result<(), String> {
    let entries = std::fs::read_dir(root).map_err(|e| {
        format!(
            "INTERNAL_PLUGIN_FALLBACK_READ_FAILED: {}: {e}",
            root.display()
        )
    })?;
    for entry in entries {
        let entry = entry.map_err(|e| {
            format!(
                "INTERNAL_PLUGIN_FALLBACK_ENTRY_FAILED: {}: {e}",
                root.display()
            )
        })?;
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path).map_err(|e| {
            format!(
                "INTERNAL_PLUGIN_FALLBACK_STAT_FAILED: {}: {e}",
                path.display()
            )
        })?;
        if metadata.file_type().is_symlink() {
            if std::fs::read_link(&path)
                .ok()
                .is_some_and(|target| is_legacy_profile_fallback_target(&target))
            {
                remove_stale_plugin_entry(&path).map_err(|e| {
                    format!(
                        "INTERNAL_PLUGIN_FALLBACK_LINK_REMOVE_FAILED: {}: {e}",
                        path.display()
                    )
                })?;
            }
        } else if metadata.is_dir() {
            remove_legacy_fallback_links(&path)?;
        }
    }
    Ok(())
}

/// 判断 junction 目标是否属于旧版 profile-local fallback。
fn is_legacy_profile_fallback_target(target: &Path) -> bool {
    target
        .components()
        .any(|component| component.as_os_str() == ".dsh-module-fallback")
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn profile_reset_waits_for_internal_preparation_and_finalization() {
        use std::time::Duration;

        let _test_guard = super::super::process::TEST_PROCESS_LOCK.lock().await;
        let scratch = tempfile::tempdir().unwrap();
        let root = scratch.path().to_path_buf();
        let profile = root.join("profile");
        let source = root.join("source");
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("package.json"), br#"{"name":"builtin"}"#).unwrap();
        let manifest_path = profile.join("package.json");
        std::fs::write(
            &manifest_path,
            br#"{"dependencies":{"builtin":"1.0.0"},"dsh":{"profile":{"bundles":["builtin","builtin"]}}}"#,
        )
        .unwrap();
        let marker = profile.join("plugin-state");
        std::fs::write(&marker, "installed").unwrap();
        let (_cancel_tx, cancel) = tokio::sync::watch::channel(false);
        let (entered_tx, mut entered) = tokio::sync::mpsc::unbounded_channel();
        let (release, wait) = std::sync::mpsc::channel();
        let runtime = tokio::runtime::Handle::current();
        let preparation_root = root.clone();
        let preparation = tokio::task::spawn_blocking(move || {
            let preset = builtin("builtin");
            runtime.block_on(prepare_internal_plugins_for_install(
                || (profile, preparation_root),
                &[&preset],
                &cancel,
                |_| {
                    entered_tx.send(()).unwrap();
                    wait.recv_timeout(Duration::from_secs(10)).unwrap();
                    Some(source.clone())
                },
            ))
        });
        tokio::time::timeout(Duration::from_secs(5), entered.recv())
            .await
            .unwrap()
            .unwrap();
        let prepared: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
        assert_eq!(
            prepared["dsh"]["profile"]["bundles"],
            serde_json::json!(["builtin"])
        );
        let mut reset = Box::pin(async {
            let mutation = crate::service::profile::mutation::acquire().await.unwrap();
            mutation
                .spawn_blocking("profile".into(), move || {
                    crate::service::profile::reset_with_root(&root, "profile")
                })
                .await
                .unwrap()
                .unwrap();
        });
        assert!(tokio::time::timeout(Duration::from_millis(30), &mut reset)
            .await
            .is_err());
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), "installed");
        release.send(()).unwrap();
        let (operation, _, check) = tokio::time::timeout(Duration::from_secs(5), preparation)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(check.need.len(), 1);
        assert!(tokio::time::timeout(Duration::from_millis(30), &mut reset)
            .await
            .is_err());
        drop(operation);
        tokio::time::timeout(Duration::from_secs(5), reset)
            .await
            .unwrap();
        assert!(!marker.exists());
    }

    #[tokio::test]
    async fn cancelled_internal_preparation_does_not_repair_after_waiting_for_operation() {
        use std::time::Duration;

        let _test_guard = super::super::process::TEST_PROCESS_LOCK.lock().await;
        let scratch = tempfile::tempdir().unwrap();
        let profile = scratch.path().join("profile");
        std::fs::create_dir_all(&profile).unwrap();
        let manifest = br#"{"dsh":{"profile":{"bundles":["builtin","builtin"]}}}"#;
        std::fs::write(profile.join("package.json"), manifest).unwrap();
        let operation = super::super::process::acquire_operation_lock()
            .await
            .unwrap();
        let (cancel_tx, cancel) = tokio::sync::watch::channel(false);
        let preset = builtin("builtin");
        let presets = [&preset];
        let mut preparation = Box::pin(prepare_internal_plugins_for_install(
            || (profile.clone(), scratch.path().to_path_buf()),
            &presets,
            &cancel,
            |_| None,
        ));
        assert!(
            tokio::time::timeout(Duration::from_millis(30), &mut preparation)
                .await
                .is_err()
        );
        cancel_tx.send(true).unwrap();
        let mut seen_cancel = cancel.clone();
        assert!(*seen_cancel.borrow_and_update());
        let mut phases = Vec::new();
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            wait_for_ensure_operation(
                async { preparation.await.map(|_| ()) },
                presets.len(),
                new_process_owner(),
                cancel_tx,
                seen_cancel,
                |phase, detail, completed| {
                    phases.push(
                        serde_json::to_value(InternalPluginsPhase {
                            phase,
                            detail,
                            completed,
                            total: presets.len(),
                        })
                        .unwrap(),
                    );
                },
            ),
        )
        .await
        .unwrap();
        assert_eq!(
            result.err().unwrap(),
            "INTERNAL_PLUGIN_INSTALL_CANCELLED: plugin install was cancelled"
        );
        assert_eq!(
            phases,
            vec![serde_json::json!({
                "phase": "done",
                "detail": "cancelled",
                "completed": 0,
                "total": presets.len(),
            })]
        );
        assert_eq!(
            std::fs::read(profile.join("package.json")).unwrap(),
            manifest
        );
        drop(operation);
    }

    fn builtin(id: &str) -> PreinstallPluginInfo {
        PreinstallPluginInfo {
            id: id.into(),
            spec: id.into(),
            internal: true,
            package: None,
            version: None,
            name: id.into(),
            description: String::new(),
            repo_url: String::new(),
            recommended: false,
            fix: false,
            default_checked: false,
            default_unchecked: false,
            win_only: false,
        }
    }

    #[test]
    fn dev_plugin_sources_resume_when_declared_host_entry_appears() {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profiles/test");
        let source = root.path().join("source");
        let installed = profile.join("node_modules/builtin");
        let healthy = profile.join("node_modules/healthy");
        for directory in [&source, &installed, &healthy] {
            std::fs::create_dir_all(directory).unwrap();
        }
        for directory in [&source, &installed] {
            std::fs::write(
                directory.join("package.json"),
                br#"{"name":"builtin","main":"dist/index.js"}"#,
            )
            .unwrap();
        }
        std::fs::write(healthy.join("package.json"), br#"{"name":"healthy"}"#).unwrap();
        let manifest = serde_json::json!({
            "dependencies": {"builtin": bundled_dep_spec(&source), "healthy": bundled_dep_spec(&healthy), "user": "1.0.0"},
            "dsh": {"profile": {"bundles": ["builtin", "healthy", "user"]}},
            "custom": {"keep": true}
        });
        let path = profile.join("package.json");
        std::fs::write(&path, manifest.to_string()).unwrap();
        let presets = [builtin("builtin"), builtin("healthy")];
        let check = || {
            prepare_internal_plugins(
                &profile,
                root.path(),
                &[&presets[0], &presets[1]],
                true,
                |id| {
                    Some(if id == "builtin" {
                        source.clone()
                    } else {
                        healthy.clone()
                    })
                },
            )
        };
        let skipped = check().unwrap();
        assert!(skipped.need.is_empty());
        let after = skipped.manifest.unwrap();
        assert_eq!(after["dependencies"], manifest["dependencies"]);
        assert_eq!(
            after["dsh"]["profile"]["bundles"],
            serde_json::json!(["healthy", "user"])
        );
        assert_eq!(after["custom"], manifest["custom"]);
        let persisted: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(persisted, after);
        let settled = check().unwrap();
        require_running_plugins_ready(&profile, &settled).unwrap();
        std::fs::create_dir(source.join("dist")).unwrap();
        std::fs::write(source.join("dist/index.js"), b"export function apply() {}").unwrap();
        let ready = check().unwrap();
        assert_eq!(
            ready
                .need
                .iter()
                .map(|(id, _, _)| id.as_str())
                .collect::<Vec<_>>(),
            vec!["builtin"]
        );
    }

    #[test]
    fn dev_plugin_sources_missing_preserves_healthy_installed_copy() {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profiles/test");
        let installed = profile.join("node_modules/healthy");
        std::fs::create_dir_all(&installed).unwrap();
        std::fs::write(installed.join("package.json"), br#"{"main":"index.js"}"#).unwrap();
        std::fs::write(installed.join("index.js"), b"export function apply() {}").unwrap();
        let manifest = serde_json::json!({
            "dependencies": {"missing": "link:missing", "healthy": "link:healthy", "user": "1.0.0"},
            "dsh": {"profile": {"bundles": ["missing", "healthy", "user"]}}
        });
        let path = profile.join("package.json");
        std::fs::write(&path, manifest.to_string()).unwrap();
        let presets = [builtin("missing"), builtin("healthy")];
        let inspect = prepare_internal_plugins(
            &profile,
            root.path(),
            &[&presets[0], &presets[1]],
            false,
            |_| None,
        )
        .unwrap();
        assert!(inspect.need.is_empty());
        assert!(inspect.migration_pending);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            manifest.to_string()
        );
        let prepared = prepare_internal_plugins(
            &profile,
            root.path(),
            &[&presets[0], &presets[1]],
            true,
            |_| None,
        )
        .unwrap();
        assert!(prepared.need.is_empty());
        assert!(prepared.orphans.is_empty());
        let after = prepared.manifest.unwrap();
        assert_eq!(
            after["dsh"]["profile"]["bundles"],
            serde_json::json!(["healthy", "user"])
        );
        assert_eq!(after["dependencies"], manifest["dependencies"]);
        assert!(internal_plugin_entry_is_ready(&installed));
    }

    #[tokio::test]
    async fn unscoped_flight_cleanup_uses_the_acquired_coordinator() {
        use crate::service::workflow::instances;
        let acquired = super::ensure_lock("ensure-stored-profile");
        let (id, _, _, _, _, _) = acquired.lock().await.start();
        instances::scope("ensure-stored-profile".into(), async {
            let spawned = super::ensure_lock(&instances::current_profile().unwrap());
            assert!(std::sync::Arc::ptr_eq(&acquired, &spawned));
            spawned.lock().await.finish(id);
        })
        .await;
        assert!(acquired.lock().await.subscribe().is_none());
    }

    #[tokio::test]
    async fn internal_plugin_flights_are_shared_only_within_profile() {
        use crate::service::workflow::instances;
        instances::scope("ensure-profile-a".into(), async {
            let first = super::ensure_lock(&instances::current_profile().unwrap());
            assert!(std::sync::Arc::ptr_eq(
                &first,
                &super::ensure_lock(&instances::current_profile().unwrap())
            ));
            let (id, _, _, _, _, _) = first.lock().await.start();
            instances::scope("ensure-profile-b".into(), async {
                let second = super::ensure_lock(&instances::current_profile().unwrap());
                assert!(!std::sync::Arc::ptr_eq(&first, &second));
                assert!(second.lock().await.subscribe().is_none());
            })
            .await;
            assert!(first.lock().await.subscribe().is_some());
            first.lock().await.finish(id);
        })
        .await;
    }

    use super::*;

    #[test]
    fn loader_rejects_non_utf8_layers_without_rewriting_and_recovers_after_quarantine() {
        for bytes in [
            b"\xff\xfe[\0]\0\n\0".as_slice(),
            b"- id: plugin\n  name: \xc4\xe3\xba\xc3\n".as_slice(),
        ] {
            for home_layer in [false, true] {
                let temp = tempfile::tempdir().unwrap();
                let home = temp.path();
                let profile = home.join("profiles/tauri");
                std::fs::create_dir_all(&profile).unwrap();
                let path = if home_layer { home } else { &profile }.join("cordis.patch.yml");
                std::fs::write(&path, bytes).unwrap();

                for prepare in [false, true] {
                    let error =
                        repair_loader_state(&profile, home, &[], &mut None, prepare).unwrap_err();
                    assert!(
                        error.starts_with("INTERNAL_PLUGIN_PATCH_ENCODING_FAILED: "),
                        "{error}"
                    );
                    assert!(error.contains(&path.display().to_string()), "{error}");
                    assert!(error.contains("UTF-8"), "{error}");
                    assert_eq!(std::fs::read(&path).unwrap(), bytes);
                }

                let report = super::super::patch_guard::quarantine_patch_layers_in(&profile, home);
                assert!(!report.has_failures(), "{report:?}");
                assert_eq!(report.quarantined.len(), 1);
                assert_eq!(std::fs::read(&report.quarantined[0].backup).unwrap(), bytes);
                assert_eq!(
                    repair_loader_state(&profile, home, &[], &mut None, true),
                    Ok(false)
                );
            }
        }
    }

    #[test]
    fn loader_keeps_io_errors_distinct_from_encoding_errors() {
        let temp = tempfile::tempdir().unwrap();
        let profile = temp.path().join("profiles/tauri");
        std::fs::create_dir_all(profile.join("cordis.patch.yml")).unwrap();
        let error = repair_loader_state(&profile, temp.path(), &[], &mut None, true).unwrap_err();
        assert!(
            error.starts_with("INTERNAL_PLUGIN_PATCH_READ_FAILED: "),
            "{error}"
        );
        assert!(profile.join("cordis.patch.yml").is_dir());
    }

    #[test]
    fn loader_repair_keeps_js_expressions_in_patch_layers() {
        let temp = tempfile::tempdir().unwrap();
        let profile = temp.path().join("profiles/tauri");
        std::fs::create_dir_all(&profile).unwrap();
        let patch = profile.join("cordis.patch.yml");
        std::fs::write(
            &patch,
            "- insert:\n  - id: builtin\n  - id: user-plugin\n    config:\n      token: !!js process.env.TOKEN\n",
        )
        .unwrap();
        let builtin = PreinstallPluginInfo {
            id: "builtin".into(),
            spec: "builtin".into(),
            internal: true,
            package: None,
            version: None,
            name: "builtin".into(),
            description: String::new(),
            repo_url: String::new(),
            recommended: false,
            fix: false,
            default_checked: false,
            default_unchecked: false,
            win_only: false,
        };

        assert_eq!(
            repair_loader_state(&profile, temp.path(), &[&builtin], &mut None, true),
            Ok(false)
        );
        assert_eq!(
            std::fs::read_to_string(&patch).unwrap(),
            "- insert:\n  - id: user-plugin\n    config:\n      token: !!js process.env.TOKEN\n"
        );
    }

    #[test]
    fn post_install_manifest_check_rejects_missing_or_unreadable_manifest() {
        let root = tempfile::tempdir().unwrap();
        let need = need_entries(&["dsh-tauri", "dsh-tauri-ui"]);
        let expected = Some(vec!["dsh-tauri".to_string(), "dsh-tauri-ui".to_string()]);
        assert_eq!(presets_missing_from_manifest(root.path(), &need), expected);
        std::fs::create_dir(root.path().join("package.json")).unwrap();
        assert_eq!(presets_missing_from_manifest(root.path(), &need), expected);
    }

    #[test]
    fn post_install_manifest_check_rejects_truncated_manifest() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("package.json"),
            br#"{"dependencies":{"dsh-tauri":"#,
        )
        .unwrap();
        assert_eq!(
            presets_missing_from_manifest(root.path(), &need_entries(&["dsh-tauri"])),
            Some(vec!["dsh-tauri".to_string()])
        );
    }

    #[test]
    fn post_install_manifest_check_requires_dependency_and_bundle_registration() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("package.json"), serde_json::json!({
            "dependencies": {"dsh-tauri": "link:/resources/dsh-tauri", "dsh-tauri-ui": "link:/resources/dsh-tauri-ui"},
            "dsh": {"profile": {"bundles": ["dsh-tauri", "dsh-tauri-pet", "community-plugin"]}}
        }).to_string()).unwrap();
        assert_eq!(
            presets_missing_from_manifest(
                root.path(),
                &need_entries(&["dsh-tauri", "dsh-tauri-ui", "dsh-tauri-pet"])
            ),
            Some(vec![
                "dsh-tauri-ui".to_string(),
                "dsh-tauri-pet".to_string()
            ])
        );
        assert_eq!(
            presets_missing_from_manifest(root.path(), &need_entries(&["dsh-tauri"])),
            None
        );
        assert_eq!(presets_missing_from_manifest(root.path(), &[]), None);
    }

    /// 构造本轮待装列表 `(id, 包名, 入口)`：入口与 `ensure_inner` 一致地落在
    /// `<profile>/node_modules/<包名>`，用报告里的真实 profile 路径。
    fn need_entries(names: &[&str]) -> Vec<(String, String, PathBuf)> {
        let profile = Path::new("C:\\Users\\w00012491\\.dsh\\profiles\\tauri");
        names
            .iter()
            .map(|name| {
                (
                    (*name).to_string(),
                    (*name).to_string(),
                    profile.join("node_modules").join(name),
                )
            })
            .collect()
    }

    /// issue #264 的**恒定**版本：pnpm 建好 `link:` 目录链接后回读 package.json
    /// 失败（libuv UV_UNKNOWN / 退出码 -4094），必须命中离线自建链接兜底。
    #[test]
    fn link_materialization_failure_detects_uv_unknown_readback() {
        let error = "PREINSTALL_FAILED: dsh plugin exited with code -4094: UNKNOWN  UNKNOWN: \
                     unknown error, open 'C:\\Users\\w00012491\\.dsh\\profiles\\tauri\\node_modules\\\
                     dsh-tauri-scheduler\\package.json'";
        let need = need_entries(&["dsh-tauri-scheduler"]);
        assert!(is_link_materialization_failure(error, &need));
        // pnpm / Node 的措辞随版本变化，判定大小写不敏感
        assert!(is_link_materialization_failure(
            &error.to_ascii_lowercase(),
            &need
        ));
    }

    #[test]
    fn link_materialization_failure_detects_silent_install() {
        assert!(is_link_materialization_failure(
            "PREINSTALL_SILENT_FAIL: dsh plugin exited with code 0, but no install artifact was \
             created for [dsh-tauri]. Expected package manifests: [...]",
            &need_entries(&["dsh-tauri"])
        ));
    }

    /// issue #1156：pnpm 以 0 退出（或 pnpm 没落盘却让 dsh 继续结算）时，dsh 的
    /// `cannot resolve profile bundle` 点名了本轮待装入口，同样必须走离线自建链接兜底。
    #[test]
    fn link_materialization_failure_detects_unresolved_internal_bundle() {
        let error =
            "PREINSTALL_FAILED: dsh plugin exited with code 1: throw new Error(`${binName}: \
                     cannot resolve profile bundle ${JSON.stringify(packageName)} ...`);\n\
                     Error: dsh: cannot resolve profile bundle \"dsh-tauri\" from the dsh \
                     installation or C:\\Users\\A1\\.dsh\\profiles\\web; run 'dsh plugin --profile \
                     web install' if its dependency is not installed";
        assert!(is_link_materialization_failure(
            error,
            &need_entries(&["dsh-tauri", "dsh-tauri-ui"])
        ));
        // scoped 包：诊断里出现的是安装名
        assert!(is_link_materialization_failure(
            "cannot resolve profile bundle '@scope/dsh-tauri' from the dsh installation",
            &need_entries(&["@scope/dsh-tauri"])
        ));
        // 预设 id 与安装名不同时只认安装名：同名 id 出现在错误里不能归因
        let scoped = vec![(
            "dsh-tauri".to_string(),
            "@scope/dsh-tauri".to_string(),
            PathBuf::from("node_modules/@scope/dsh-tauri"),
        )];
        assert!(!is_link_materialization_failure(
            "cannot resolve profile bundle \"dsh-tauri\" from the dsh installation",
            &scoped
        ));
        assert!(is_link_materialization_failure(
            "cannot resolve profile bundle \"@scope/dsh-tauri\" from the dsh installation",
            &scoped
        ));
        // 点名的不是本轮待装入口（用户自己的依赖 / 其它包）：绝不兜底
        assert!(!is_link_materialization_failure(
            error,
            &need_entries(&["dsh-tauri-ui"])
        ));
        assert!(!is_link_materialization_failure(
            "cannot resolve profile bundle \"someone-else\" from the dsh installation",
            &need_entries(&["dsh-tauri"])
        ));
    }

    /// pnpm 以 0 退出但入口没落盘时，收尾必须识别出来并重新物化（issue #1156）。
    #[test]
    fn post_install_repair_detects_unlinked_internal_entries() {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path();
        let need: Vec<(String, String, PathBuf)> = ["dsh-tauri"]
            .into_iter()
            .map(|name| {
                (
                    name.to_string(),
                    name.to_string(),
                    profile.join("node_modules").join(name),
                )
            })
            .collect();

        assert_eq!(
            unlinked_internal_entries(&need),
            vec!["dsh-tauri".to_string()]
        );
        std::fs::create_dir_all(profile.join("node_modules").join("dsh-tauri")).unwrap();
        std::fs::write(
            profile
                .join("node_modules")
                .join("dsh-tauri")
                .join("package.json"),
            r#"{"name":"dsh-tauri"}"#,
        )
        .unwrap();
        assert!(unlinked_internal_entries(&need).is_empty());
    }

    /// pnpm 11 的 lockfile 供应链校验会让内置插件每一轮都被打回（#1348）：两种可观测
    /// 形态都必须命中，否则 dsh-taiwind 永不落盘、设置界面持续错位。
    #[test]
    fn supply_chain_policy_failure_covers_parsed_and_raw_forms() {
        assert!(is_supply_chain_policy_failure(
            "PLUGIN_POLICY_BLOCKED: [{\"name\":\"dsh-taiwind\",\"version\":\"0.1.2\"}]"
        ));
        assert!(is_supply_chain_policy_failure(
            "PREINSTALL_FAILED: dsh plugin exited with code 1: \u{2717} Lockfile failed supply-chain policy check (334 entries in 2.1s) Error: ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION"
        ));
        assert!(is_supply_chain_policy_failure(
            "INTERNAL_PLUGIN_INSTALL_FAILED: PREINSTALL_FAILED: dsh plugin exited with code 1: Error: ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION"
        ));
    }

    /// 其它失败一律不能命中：兜底会把用户自己的真实失败吞成「安装成功」。
    #[test]
    fn supply_chain_policy_failure_rejects_unrelated_failures() {
        for error in [
            "PREINSTALL_FAILED: dsh plugin exited with code 1: ERR_PNPM_SPEC_NOT_SUPPORTED",
            "NETWORK_ERROR: plugin registry request failed; check network or proxy settings and retry.",
            "PREINSTALL_FAILED: dsh plugin exited with code -4094: UNKNOWN: unknown error, open 'C:\\x\\node_modules\\dsh-tauri\\package.json'",
            "PLUGIN_VERSION_INCOMPATIBLE: []",
            "PREINSTALL_FAILED: dsh plugin exited with code 1: ✗ Lockfile failed supply-chain policy check (201 entries) Error: ERR_PNPM_TRUST_DOWNGRADE lodash@4.17.21 is a downgrade",
        ] {
            assert!(!is_supply_chain_policy_failure(error), "{error}");
        }
    }

    /// 同一签名也可能来自用户自己的 `link:` 依赖（`pnpm add` 会一并解析项目依赖）：
    /// 失败路径不属于本轮内置插件时绝不能兜底，否则真实失败被吞成「安装成功」。
    #[test]
    fn link_materialization_failure_rejects_foreign_dependency_path() {
        let error = "PREINSTALL_FAILED: dsh plugin exited with code -4094: UNKNOWN  UNKNOWN: \
                     unknown error, open 'C:\\Users\\w00012491\\.dsh\\profiles\\tauri\\node_modules\\\
                     someone-else-plugin\\package.json'";
        assert!(!is_link_materialization_failure(
            error,
            &need_entries(&["dsh-tauri-scheduler"])
        ));
    }

    /// 同类签名但诊断里没有可解析的失败路径：不能归因到内置插件入口，因此既不
    /// 兜底（免得掩盖用户依赖的失败）也不能只丢裸错误，要走「只给排除项提示」。
    #[test]
    fn link_materialization_failure_rejects_unattributed_diagnostic() {
        let error = "PREINSTALL_FAILED: dsh plugin exited with code -4094: UNKNOWN: cannot \
                     materialize node_modules entry";
        let need = need_entries(&["dsh-tauri-scheduler"]);

        assert!(!is_link_materialization_failure(error, &need));
        assert!(is_untraceable_link_readback_failure(error));
        // 能解析出路径后就不再是「无法归因」，只是路径不属于本轮待装入口
        assert!(!is_untraceable_link_readback_failure(
            "PREINSTALL_FAILED: dsh plugin exited with code -4094: UNKNOWN: unknown error, open \
             'C:\\Users\\w00012491\\.dsh\\profiles\\tauri\\node_modules\\someone-else\\package.json'"
        ));
    }

    #[test]
    fn link_materialization_failure_rejects_unrelated_failures() {
        let need = need_entries(&["dsh-tauri"]);
        assert!(!is_link_materialization_failure(
            "PREINSTALL_FAILED: dsh plugin exited with code 1: ERR_PNPM_SPEC_NOT_SUPPORTED",
            &need
        ));
        assert!(!is_link_materialization_failure(
            "NETWORK_ERROR: plugin registry request failed; check network or proxy settings and retry.",
            &need
        ));
        assert!(!is_link_materialization_failure(
            "PREINSTALL_ENTRY_FAILED:\ndsh-tauri: PLUGIN_ENTRY_MISSING",
            &need
        ));
        // 含 -4094 但诊断里没有 profile 链接路径：不是本兜底能解的那一类
        assert!(!is_link_materialization_failure(
            "PREINSTALL_FAILED: dsh plugin exited with code -4094: some unrelated output",
            &need
        ));
        assert!(!is_untraceable_link_readback_failure(
            "PREINSTALL_FAILED: dsh plugin exited with code -4094: some unrelated output"
        ));
    }

    #[test]
    fn legacy_fallback_target_detection_is_path_component_aware() {
        let base = Path::new("home")
            .join("test")
            .join(".dsh")
            .join("profiles")
            .join("web");
        assert!(is_legacy_profile_fallback_target(
            &base
                .join(".dsh-module-fallback")
                .join("node_modules")
                .join("anymatch"),
        ));
        assert!(!is_legacy_profile_fallback_target(
            &base.join("node_modules").join("anymatch"),
        ));
        assert!(!is_legacy_profile_fallback_target(
            &base.join(".dsh-module-fallback-old").join("anymatch"),
        ));
    }

    #[tokio::test]
    async fn coordinator_coalesces_waiters_and_releases_for_retry() {
        let mut coordinator = EnsureCoordinator::default();
        let (first_id, first_owner, result_tx, first, _, _) = coordinator.start();
        let EnsureSubscription::Running(duplicate) = coordinator.subscribe().unwrap() else {
            panic!("running flight must coalesce running waiters");
        };
        assert_eq!(coordinator.active.as_ref().unwrap().owner, first_owner);
        coordinator.finish(first_id);
        assert!(coordinator.subscribe().is_none());
        result_tx.send(Some(Ok(()))).unwrap();
        assert_eq!(first.borrow().as_ref(), Some(&Ok(())));
        assert_eq!(duplicate.borrow().as_ref(), Some(&Ok(())));

        let (retry_id, _, _, _, _, _) = coordinator.start();
        assert_ne!(retry_id, first_id);
    }

    #[tokio::test]
    async fn cancel_then_immediate_retry_starts_one_fresh_flight() {
        type FlightResultSender = tokio::sync::watch::Sender<Option<Result<(), String>>>;

        let coordinator =
            std::sync::Arc::new(tokio::sync::Mutex::new(EnsureCoordinator::default()));
        let fresh_flight = std::sync::Arc::new(tokio::sync::Mutex::new(
            None::<(u64, ProcessOwner, FlightResultSender)>,
        ));
        let fresh_started = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let cancelling_subscribers = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let cancelling_subscribed = std::sync::Arc::new(tokio::sync::Notify::new());

        let (cancelled_id, cancelled_owner, cancelled_tx) = {
            let mut coordinator = coordinator.lock().await;
            let (id, owner, result_tx, _, _, mut cancel_signal) = coordinator.start();
            coordinator.begin_cancel().unwrap();
            assert!(*cancel_signal.borrow_and_update());
            (id, owner, result_tx)
        };

        async fn retry(
            coordinator: std::sync::Arc<tokio::sync::Mutex<EnsureCoordinator>>,
            fresh_flight: std::sync::Arc<
                tokio::sync::Mutex<Option<(u64, ProcessOwner, FlightResultSender)>>,
            >,
            fresh_started: std::sync::Arc<std::sync::atomic::AtomicUsize>,
            cancelling_subscribers: std::sync::Arc<std::sync::atomic::AtomicUsize>,
            cancelling_subscribed: std::sync::Arc<tokio::sync::Notify>,
        ) -> Result<(), String> {
            receive_current_or_next_flight(|| {
                let coordinator = coordinator.clone();
                let fresh_flight = fresh_flight.clone();
                let fresh_started = fresh_started.clone();
                let cancelling_subscribers = cancelling_subscribers.clone();
                let cancelling_subscribed = cancelling_subscribed.clone();
                async move {
                    let mut coordinator = coordinator.lock().await;
                    if let Some(subscription) = coordinator.subscribe() {
                        if matches!(&subscription, EnsureSubscription::Cancelling(_)) {
                            cancelling_subscribers
                                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                            cancelling_subscribed.notify_one();
                        }

                        return subscription;
                    }
                    let (id, owner, result_tx, result_rx, _, _) = coordinator.start();
                    fresh_started.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    *fresh_flight.lock().await = Some((id, owner, result_tx));
                    EnsureSubscription::Running(result_rx)
                }
            })
            .await
        }

        let first_retry = tokio::spawn(retry(
            coordinator.clone(),
            fresh_flight.clone(),
            fresh_started.clone(),
            cancelling_subscribers.clone(),
            cancelling_subscribed.clone(),
        ));
        let second_retry = tokio::spawn(retry(
            coordinator.clone(),
            fresh_flight.clone(),
            fresh_started.clone(),
            cancelling_subscribers.clone(),
            cancelling_subscribed.clone(),
        ));

        while cancelling_subscribers.load(std::sync::atomic::Ordering::SeqCst) < 2 {
            cancelling_subscribed.notified().await;
        }
        {
            let mut coordinator = coordinator.lock().await;
            coordinator.finish(cancelled_id);
        }
        cancelled_tx
            .send(Some(Err(
                "INTERNAL_PLUGIN_INSTALL_CANCELLED: plugin install was cancelled".to_string(),
            )))
            .unwrap();

        let (retry_id, retry_owner, retry_tx) = loop {
            if let Some(flight) = fresh_flight.lock().await.take() {
                break flight;
            }
            tokio::task::yield_now().await;
        };
        assert_ne!(retry_owner, cancelled_owner);
        assert_eq!(fresh_started.load(std::sync::atomic::Ordering::SeqCst), 1);

        coordinator.lock().await.finish(retry_id);
        retry_tx.send(Some(Ok(()))).unwrap();
        assert!(first_retry.await.unwrap().is_ok());
        assert!(second_retry.await.unwrap().is_ok());
        assert_eq!(fresh_started.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(coordinator.lock().await.subscribe().is_none());
    }

    #[tokio::test]
    async fn stuck_owner_is_bounded_and_blocks_new_flights_without_hanging_waiters() {
        let released = wait_for_release_with(
            || true,
            std::time::Duration::from_millis(5),
            std::time::Duration::from_millis(1),
        )
        .await;
        assert!(!released);

        let mut coordinator = EnsureCoordinator::default();
        let (id, _, result_tx, mut result, _, _) = coordinator.start();
        let reason = "INTERNAL_PLUGIN_PROCESS_REAP_TIMEOUT: test owner remained active".to_string();
        result_tx.send(Some(Err(reason.clone()))).unwrap();
        coordinator.mark_cleanup_failed(id, reason.clone());

        assert!(matches!(
            coordinator.subscribe(),
            Some(EnsureSubscription::CleanupFailed(error)) if error == reason
        ));
        let outcome = receive_flight_result(&mut result).await.unwrap();
        assert_eq!(outcome, Err(reason));
        assert_eq!(coordinator.next_id, 1);
    }

    /// issue #466：旧版 profile-local fallback 目录不可删（典型：属主是 root）时，
    /// 清理失败只能告警，绝不阻断本轮的插件核对/重装——否则用户看到的是这条
    /// housekeeping 错误，而真正要修的是档案目录权限。
    #[cfg(unix)]
    #[test]
    fn unwritable_fallback_cleanup_is_best_effort() {
        use std::os::unix::fs::PermissionsExt;

        let profile =
            std::env::temp_dir().join(format!("dsh-fallback-guard-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&profile);
        // 目录结构：profile/.dsh-module-fallback/node_modules/<entry>
        let nested = profile.join(".dsh-module-fallback").join("node_modules");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("anymatch"), b"").unwrap();

        // 去掉 node_modules 的写权限：递归删除其内部条目时 EACCES
        let mut locked = std::fs::metadata(&nested).unwrap().permissions();
        locked.set_mode(0o555);
        std::fs::set_permissions(&nested, locked).unwrap();

        // 以 root 身份运行时权限位不生效（清理会成功，`nested` 已被删除），此时跳过
        // 错误断言，且恢复权限前必须先确认目录还在
        if let Err(error) = remove_legacy_profile_module_fallback(&profile) {
            assert!(
                error.starts_with("INTERNAL_PLUGIN_FALLBACK_REMOVE_FAILED"),
                "{error}"
            );
        }
        // best-effort 包装：无论底层成功与否都不得返回错误或 panic
        remove_legacy_profile_module_fallback_best_effort(&profile);

        if let Ok(metadata) = std::fs::metadata(&nested) {
            let mut open = metadata.permissions();
            open.set_mode(0o755);
            let _ = std::fs::set_permissions(&nested, open);
        }
        let _ = std::fs::remove_dir_all(&profile);
    }
}
