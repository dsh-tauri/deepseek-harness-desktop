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

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

use super::cancel::terminate_owned_install;
use super::install::install_internal;
use super::installed::{installed_name, profile_dir, ProfilePackageJson};
use super::preset::{bundled_dep_spec, bundled_plugin_dir, load_presets, PreinstallPluginInfo};
use super::process::{new_process_owner, PreinstallLogPayload, ProcessOwner, PREINSTALL_LOG_EVENT};
use crate::config;

use manifest::{
    collect_dangling_local_link_deps, dedupe_profile_bundles, dep_matches_spec,
    internal_plugin_entry_is_ready, is_local_link_dep, remove_duplicate_bundle_entries_from_patch,
    remove_internal_plugins_from_manifest, remove_stale_plugin_entry, write_profile_manifest,
};
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

static ENSURE_LOCK: std::sync::OnceLock<tokio::sync::Mutex<EnsureCoordinator>> =
    std::sync::OnceLock::new();

fn ensure_lock() -> &'static tokio::sync::Mutex<EnsureCoordinator> {
    ENSURE_LOCK.get_or_init(|| tokio::sync::Mutex::new(EnsureCoordinator::default()))
}

/// 在启动 Harness 前修复旧桌面目录遗留的 profile loader 状态。
///
/// 这一步必须发生在启动 dsh 子进程之前：dsh 会同时合并 bundle patch、profile
/// patch、home patch；如果旧 checkout 曾把内置插件 patch 写入其中，单纯重装
/// `node_modules` 无法消除重复 loader entry。只清理桌面端明确拥有的内置 id，
/// 绝不触碰用户插件。
pub(crate) fn repair_loader_state(app_handle: &AppHandle) -> Result<(), String> {
    let core_version = crate::service::core::active_version(app_handle);
    let internal: Vec<_> = load_presets(app_handle)
        .into_iter()
        .filter(|preset| preset.internal && !preset.unsupported_on(core_version.as_deref()))
        .collect();
    let bundle_ids: HashSet<&str> = internal.iter().map(|preset| preset.id.as_str()).collect();
    let profile = profile_dir(app_handle);
    let profile_manifest = profile.join("package.json");
    let mut changed_manifest = false;
    if let Ok(raw) = std::fs::read_to_string(&profile_manifest) {
        let mut manifest = serde_json::from_str::<serde_json::Value>(&raw)
            .map_err(|e| format!("INTERNAL_PLUGIN_MANIFEST_PARSE_FAILED: {e}"))?;
        changed_manifest = dedupe_profile_bundles(&mut manifest);
        if changed_manifest {
            write_profile_manifest(&profile_manifest, &manifest)?;
        }
    }

    for patch_path in super::patch_layer_paths(&profile, &config::get_dsh_data_path(app_handle)) {
        let Ok(raw) = std::fs::read_to_string(&patch_path) else {
            continue;
        };
        let mut patch = serde_yaml::from_str::<serde_yaml::Value>(&raw).map_err(|e| {
            format!(
                "INTERNAL_PLUGIN_PATCH_PARSE_FAILED: {}: {e}",
                patch_path.display()
            )
        })?;
        if remove_duplicate_bundle_entries_from_patch(&mut patch, &bundle_ids) {
            let rendered = serde_yaml::to_string(&patch)
                .map_err(|e| format!("INTERNAL_PLUGIN_PATCH_RENDER_FAILED: {e}"))?;
            std::fs::write(&patch_path, rendered).map_err(|e| {
                format!(
                    "INTERNAL_PLUGIN_PATCH_WRITE_FAILED: {}: {e}",
                    patch_path.display()
                )
            })?;
            log::warn!(
                "INTERNAL_PLUGIN_PROFILE_MIGRATED: removed stale internal loader entries from {}",
                patch_path.display()
            );
        }
    }

    // dsh 会把运行时组合结果写回 cordis.yml；旧版本留下的组合结果会在下一次
    // 启动时与新 patch 再合并，必须恢复官方约定的空根配置。
    let root = profile.join("cordis.yml");
    const EMPTY_ROOT: &str = "# dsh profile root — an empty entry list. The tree is composed as patches:\n# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any\n# --patch overlays. Edit cordis.patch.yml, not this file.\n[]\n";
    if std::fs::read_to_string(&root).ok().as_deref() != Some(EMPTY_ROOT) && profile.is_dir() {
        std::fs::write(&root, EMPTY_ROOT)
            .map_err(|e| format!("INTERNAL_PLUGIN_ROOT_WRITE_FAILED: {}: {e}", root.display()))?;
        log::warn!(
            "INTERNAL_PLUGIN_PROFILE_MIGRATED: reset stale profile root {}",
            root.display()
        );
    }
    if changed_manifest {
        log::warn!(
            "INTERNAL_PLUGIN_PROFILE_MIGRATED: deduplicated profile bundles in {}",
            profile_manifest.display()
        );
    }
    Ok(())
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
    std::fs::read(profile.join("disabled-plugins.json"))
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
    let presets = load_presets(app_handle);
    // 被核心吸收的内置插件（当前核心已超出其声明的全部核心版本区间）自愈不再装回，
    // 与 `uninstall_deprecated_plugins` 的退役判定同源，避免两边互相拉扯。
    let core_version = crate::service::core::active_version(app_handle);
    let internal: Vec<_> = presets
        .into_iter()
        .filter(|p| p.internal && !p.unsupported_on(core_version.as_deref()))
        .collect();
    // 同一次启动的两路调用：后到的一路输入未变、且前一路刚成功，直接复用结论，
    // 连下面的失效链接清理、可写性预检与 loader 状态修复一起跳过（issue #766）。
    let fingerprint = ensure_fingerprint(app_handle, &internal);
    let reused = if internal.is_empty() {
        false
    } else {
        ensure_lock().lock().await.reuse(fingerprint)
    };
    if reused {
        log::debug!(
            "Internal plugin check already succeeded for the current profile state, skipping"
        );
        return Ok(());
    }
    prune_dangling_link_deps(app_handle, &internal);
    if internal.is_empty() {
        return Ok(());
    }

    // 写入前可写性预检（issue #466）：档案目录属主不是当前用户时（典型：此前用
    // sudo 运行过 dsh，macOS 的 sudo 保留 $HOME）**读得到、写不了**——清单能读，
    // 但 .npmrc、cordis.yml、链接、依赖全部 EACCES。必须在任何写入与 pnpm 之前
    // 给出可执行诊断（失败路径 + 属主 + chown 命令），否则用户只会看到 pnpm/写盘的
    // 裸 os error 13，或一路走到 spawn 之后 dsh 才崩在 cordis.yml 上（只剩
    // "exited early"）。放在 repair_loader_state 之前：它同样会写档案清单/patch/根
    // 配置，权限错位时最先失败的就是那里。预检不创建目录：建档案留给
    // dsh/init_profile_dir 自己的初始化逻辑（issue #452）。
    crate::service::perm::ensure_writable_path(
        &profile_dir(app_handle),
        &config::get_dsh_data_path(app_handle),
        "PROFILE_NOT_WRITABLE",
    )?;

    super::disable::preserve_disabled_bundles(&profile_dir(app_handle))?;
    repair_loader_state(app_handle)?;
    let outcome =
        receive_current_or_next_flight(|| subscribe_or_start(app_handle, &internal)).await;
    if outcome.is_ok() {
        // 记「完成后的」指纹：本轮自己写回的状态（去重/修复/安装）就是已被核对过的
        // 状态，后到的那一路按同一状态算指纹即可命中，不会白跑第二轮。
        ensure_lock()
            .lock()
            .await
            .record(ensure_fingerprint(app_handle, &internal));
    }
    outcome
}

/// 卸载「本地链接目标已不存在」的失效依赖（含已被删除的内置包），在服务启动前调用。
///
/// 已删除的包不再出现在预设清单里，孤儿分支（bundled 目录缺失）永远碰不到它，其
/// `link:` 悬空依赖与 `dsh.profile.bundles` 引用会永久留档，令 dsh 每次启动都报
/// `cannot resolve profile bundle <name>`。与孤儿卸载同一模式：best-effort、离线
/// 精准（改写清单 + 删入口 + 剥 patch 层），任何失败只记告警，绝不阻断启动。
fn prune_dangling_link_deps(app_handle: &AppHandle, internal: &[PreinstallPluginInfo]) {
    let profile = profile_dir(app_handle);
    let manifest_path = profile.join("package.json");
    let Ok(raw) = std::fs::read_to_string(&manifest_path) else {
        return;
    };
    let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&raw) else {
        log::warn!("INTERNAL_PLUGIN_MANIFEST_PARSE_FAILED: 跳过失效链接依赖清理");
        return;
    };
    let mut keep: HashSet<&str> = HashSet::new();
    for preset in internal {
        keep.insert(preset.id.as_str());
        keep.insert(installed_name(preset));
    }
    for name in collect_dangling_local_link_deps(&manifest, &keep, &profile) {
        if !super::recovery::is_actionable_plugin_ref(&name) {
            log::warn!("INTERNAL_PLUGIN_DANGLING_LINK_SKIPPED: {name}（核心/官方包不执行卸载）");
            continue;
        }
        log::warn!(
            "INTERNAL_PLUGIN_DANGLING_LINK_UNINSTALLING: {name}（本地链接目标已不存在，卸载失效依赖）"
        );
        if let Err(e) = super::uninstall_recovery(app_handle, &name) {
            log::warn!("INTERNAL_PLUGIN_DANGLING_LINK_UNINSTALL_FAILED: {name}: {e}");
        }
    }
}

async fn subscribe_or_start(
    app_handle: &AppHandle,
    internal: &[PreinstallPluginInfo],
) -> EnsureSubscription {
    let mut coordinator = ensure_lock().lock().await;
    match coordinator.subscribe() {
        Some(subscription) => subscription,
        None => {
            let (id, owner, result_tx, result_rx, cancel_tx, cancel_rx) = coordinator.start();
            let app_handle = app_handle.clone();
            let internal = internal.to_vec();
            tauri::async_runtime::spawn(async move {
                let mut outcome =
                    run_ensure_operation(&app_handle, &internal, owner, cancel_tx, cancel_rx).await;
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
                    ensure_lock().lock().await.mark_cleanup_failed(id, reason);
                    // 保留 cleanup-failed flight 与唯一 owner；进程锁仍由 wait 线程持有。
                    // 若系统最终完成 reap，再释放 flight 允许后续 Retry。
                    while super::process::active_plugin_pid(owner).is_some() {
                        tokio::time::sleep(ENSURE_OWNER_DRAIN_INTERVAL).await;
                    }
                    ensure_lock().lock().await.finish(id);
                    return;
                }
                ensure_lock().lock().await.finish(id);
                let _ = result_tx.send(Some(outcome));
            });
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
        let mut coordinator = ensure_lock().lock().await;
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
    mut cancel: tokio::sync::watch::Receiver<bool>,
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
    tokio::pin!(operation);
    let deadline = tokio::time::sleep(ENSURE_ABSOLUTE_TIMEOUT);
    tokio::pin!(deadline);
    let period = std::time::Duration::from_secs(5);
    let mut heartbeat = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            outcome = &mut operation => {
                emit_phase(app_handle, "done", InternalPluginPhaseDetail::Done, total, total);
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
                emit_phase(app_handle, "done", InternalPluginPhaseDetail::Timeout, 0, total);
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
                    emit_phase(app_handle, "done", InternalPluginPhaseDetail::Cancelled, 0, total);
                    return Err(reason.to_string());
                }
            }
            _ = heartbeat.tick() => {
                emit_phase(app_handle, "progress", InternalPluginPhaseDetail::Heartbeat, 0, total);
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
    let _ = app_handle.emit(
        "internal-plugins-phase",
        InternalPluginsPhase {
            phase,
            detail,
            completed,
            total,
        },
    );
}

/// 实际的核对与安装：遍历 internal 预设，未安装 / 路径不对 / 被卸载 → 批量重装。
async fn ensure_inner(
    app_handle: &AppHandle,
    internal: &[&PreinstallPluginInfo],
    cancel: tokio::sync::watch::Receiver<bool>,
    owner: ProcessOwner,
) -> Result<(), String> {
    log::info!(
        "checking {} internal preset plugins for install state",
        internal.len()
    );

    // 一次读取当前档案；缺失时按「全部未安装」处理，由安装流程自行初始化。已有但
    // 损坏的清单不能静默覆盖，否则可能丢失用户其它插件，故直接给出可诊断错误。
    let profile = profile_dir(app_handle);
    let manifest_path = profile.join("package.json");
    let mut manifest = match std::fs::read_to_string(&manifest_path) {
        Ok(raw) => Some(
            serde_json::from_str::<serde_json::Value>(&raw)
                .map_err(|e| format!("INTERNAL_PLUGIN_MANIFEST_PARSE_FAILED: {e}"))?,
        ),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("INTERNAL_PLUGIN_MANIFEST_READ_FAILED: {e}")),
    };
    let dependencies: HashMap<String, String> = match manifest.as_ref() {
        Some(value) => {
            serde_json::from_value::<ProfilePackageJson>(value.clone())
                .map_err(|e| format!("INTERNAL_PLUGIN_MANIFEST_SCHEMA_FAILED: {e}"))?
                .dependencies
        }
        None => HashMap::new(),
    };

    // 旧工作目录留下的 profile 可能含重复 bundle；先做幂等迁移，避免在
    // 检查依赖正常时直接进入 Cordis 并触发 duplicate loader entry。
    let mut migrated = false;
    if let Some(value) = manifest.as_mut() {
        migrated = dedupe_profile_bundles(value);
    }

    let bundle_ids: HashSet<&str> = internal.iter().map(|preset| preset.id.as_str()).collect();
    let patch_path = profile.join("cordis.patch.yml");
    let mut patch = std::fs::read_to_string(&patch_path)
        .ok()
        .and_then(|raw| serde_yaml::from_str::<serde_yaml::Value>(&raw).ok());
    if let Some(value) = patch.as_mut() {
        if remove_duplicate_bundle_entries_from_patch(value, &bundle_ids) {
            let rendered = serde_yaml::to_string(value)
                .map_err(|e| format!("INTERNAL_PLUGIN_PATCH_RENDER_FAILED: {e}"))?;
            std::fs::write(&patch_path, rendered)
                .map_err(|e| format!("INTERNAL_PLUGIN_PATCH_WRITE_FAILED: {e}"))?;
            migrated = true;
            log::warn!(
                "INTERNAL_PLUGIN_PROFILE_MIGRATED: removed duplicate bundle entries from {}",
                patch_path.display()
            );
        }
    }
    if migrated {
        if let Some(value) = manifest.as_ref() {
            write_profile_manifest(&manifest_path, value)?;
        }
    }

    let mut need: Vec<(String, String, PathBuf)> = Vec::new();
    // 本分支要「直接卸载」的孤儿内置插件（安装包名）：其捆绑目录已不存在且仍以
    // `link:`/`file:` 本地依赖形式安装在 profile 里。见下方 bundle 缺失分支的说明。
    let mut orphans: Vec<String> = Vec::new();
    let disabled = super::disable::load_disabled(&profile);
    for preset in internal {
        if disabled.contains_key(&preset.id) || disabled.contains_key(installed_name(preset)) {
            continue;
        }
        let Some(bundled) = bundled_plugin_dir(app_handle, &preset.id) else {
            // 未找到内置插件目录：release 说明构建期 build:plugins 未打包（发布
            // 缺陷，由 build:plugins 响亮失败）；debug 自动发现 packages/* 中非私有
            // 且含 dsh 对象的包，未命中时跳过（「找不到则不装」）。
            //
            // debug 下这是「切换 git 分支导致某内置插件源码消失」的典型场景：上一
            // 分支把它以 `link:<packages/<id>>` 装进 profile，当前分支不再有该目录，
            // 悬空链接指向不存在的源。此时重装无从谈起（无源），且残留悬空链接会让
            // loader 无法解析。因此只要它仍以本地链接（`link:`/`file:`）形式安装在
            // profile 里，就直接卸载该插件；registry/git 等非本地依赖（用户独立安装
            // 的同名包）绝不误卸。
            let name = installed_name(preset).to_string();
            let is_orphan = dependencies
                .get(&name)
                .is_some_and(|spec| is_local_link_dep(spec));
            if is_orphan {
                log::warn!(
                    "INTERNAL_PLUGIN_BUNDLE_MISSING_UNINSTALLING: {name}（link 指向的捆绑目录已不存在，卸载悬空内置插件）"
                );
                orphans.push(name);
            } else {
                log::warn!(
                    "INTERNAL_PLUGIN_BUNDLE_MISSING: {}（release 需构建期 build:plugins；debug 无匹配的 packages/* 包）",
                    preset.id
                );
            }
            continue;
        };
        let name = installed_name(preset).to_string();
        // 捆绑目录被解析到但源 package.json 不可读（悬空源/资源被清理）：pnpm 对指向
        // 不存在目录的 `link:` 依赖会静默 exit 0（日志特征 `Installing a dependency
        // from a non-existent directory`），重装必然再次假成功，形成启动死循环。这类
        // 是「应用资源缺失」而非「路径变更」：直接给出精确错误，阻断本轮重装。
        if !bundled.join("package.json").is_file() {
            return Err(format!(
                "INTERNAL_PLUGIN_SOURCE_MISSING: 内置插件 {name} 的捆绑源目录 {} 缺失或不可读（应用资源目录可能被移动/删除或盘符变更）。pnpm 会静默跳过安装（exit 0 无产物），导致服务启动时 loader 抛 ERR_MODULE_NOT_FOUND。请重新安装应用或恢复应用资源目录后重试。",
                bundled.display()
            ));
        }
        let expected = bundled_dep_spec(&bundled);
        // ① 依赖声明：未声明，或声明的值不再指向当前捆绑目录（路径变更/被改
        // 写）→ 重装；② 依赖真实性：node_modules 链接/拷贝须真实存在（用户
        // 手动清过 node_modules 时声明可能残留但产物已不在）→ 重装。
        let dep_ok = dependencies
            .get(&name)
            .is_some_and(|actual| dep_matches_spec(actual, &expected));
        let entry = profile.join("node_modules").join(&name);
        let link_ok = internal_plugin_entry_is_ready(&entry);
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
    // 卸载孤儿内置插件：best-effort、离线精准，不依赖 node/pnpm（其源目录已
    // 不存在，走 `dsh plugin remove` 也没有可安装的本地链接可删）。与弃用插件
    // 自动卸载同一模式：任何失败只记告警，绝不阻断本轮其余重装或整体启动。
    if !orphans.is_empty() {
        log::info!("Uninstalling orphaned internal preset plugins: {orphans:?}");
        for name in &orphans {
            if !super::recovery::is_actionable_plugin_ref(name) {
                log::warn!("INTERNAL_PLUGIN_ORPHAN_SKIPPED: {name}（核心/官方包不执行孤儿卸载）");
                continue;
            }
            if let Err(e) = super::uninstall_recovery(app_handle, name) {
                log::warn!("INTERNAL_PLUGIN_ORPHAN_UNINSTALL_FAILED: {name}: {e}");
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
    let install_result = install_internal(app_handle, &ids, cancel, owner).await;
    if let Err(e) = install_result {
        // 即使 pnpm 失败也清掉旧 fallback，下一次重试必须从干净入口开始。
        remove_legacy_profile_module_fallback_best_effort(&profile);
        // pnpm 的 `link:` 安装路径在「建好目录链接后立刻回读 package.json」这一步
        // 失败时（libuv UV_UNKNOWN / 退出码 -4094）可能是**环境性的恒定失败**
        // （实时防护 / 云盘 / 重解析点过滤驱动），重试与重装都无法越过；此时改由
        // 桌面端自建链接并补齐清单，让内置插件落盘、启动继续，而不是把应用永久
        // 卡在 Plugin installation 阶段（见 [`materialize`]）。
        if is_link_materialization_failure(&e, &need) {
            let _ = app_handle.emit(
                PREINSTALL_LOG_EVENT,
                PreinstallLogPayload {
                    line: "[harness] pnpm 无法回读新建的插件链接，改由应用直接建立链接…"
                        .to_string(),
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

    // pnpm 成功 ≠ 清单被登记：核心的 install 会按自己解析到的插件集重写
    // `dependencies` 与 `dsh.profile.bundles`，解析不到的内置插件会被**剪掉**
    // （本机 web profile 实测 13→2、11→0）。剪掉即不挂载：宿主插件的 apply 不运行，
    // 索引恒 401、健康检查永远 `boot page returned 401`、最终 Process boot 超时。
    // 收尾回读清单，缺项就用同一套物化路径写回（幂等）——否则 `bundle_ok` 每轮判
    // 需重装、每轮又被打回原形。
    if let Some(missing) = presets_missing_from_manifest(&profile, &need) {
        materialize_internal_links(app_handle, &profile, &need)
            .map_err(|error| format!("INTERNAL_PLUGIN_MANIFEST_RECOVER_FAILED: {error}"))?;
        log::warn!(
            "INTERNAL_PLUGIN_MANIFEST_RECOVERED: re-registered internal plugins dropped by install: {missing:?}"
        );
    }

    Ok(())
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

/// 同类签名但诊断里读不到失败路径：无从确认失败的就是内置插件入口。
fn is_untraceable_link_readback_failure(error: &str) -> bool {
    failed_open_path(error).is_none() && looks_like_link_readback_failure(error)
}

/// 判定安装失败是否属于「pnpm 建好 `link:` 入口后无法回读 / 未落盘」且**可归因到
/// 本轮待装的内置插件**——即离线自建链接能修、且修了不会掩盖别的失败的那一类。
///
/// - `PREINSTALL_SILENT_FAIL`：pnpm 以 0 退出却没落盘产物（源码存在时自建链接必然成功）；
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
    super::disable::preserve_disabled_bundles(profile)?;
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
    use super::*;

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
