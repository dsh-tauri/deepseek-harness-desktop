//! 单插件升级/卸载：`dsh plugin --profile <当前档案> update/remove <id>`。
//! 与安装共用环境准备（shim、pnpm 选版、停止服务）与 allowBuilds 重试；
//! 卸载后核验 profile 清单，插件仍被引用时走离线卸载兜底（受保护包除外）。
//! 另含启动期弃用插件自动卸载（`uninstall_deprecated_plugins`）。

use std::collections::HashSet;
use std::ffi::OsString;
use std::path::Path;
use tauri::{AppHandle, Manager};

use crate::config;
use crate::service::cli;
use crate::service::core;
use crate::service::profile::active_profile;
use crate::service::workflow;

use super::artifact::{ensure_plugin_entry_built, installed_package_name};
use super::build_plugin_envs;
use super::harness_prefer_bundled_pnpm;
use super::diagnose::{
    git_transport_hint, incompatible_versions, network_error_hint, pick_error_message,
    policy_blocked_versions, policy_verification_network_failure, store_mismatch_hint,
};
use super::errors;
use super::installed_name;
use super::is_actionable_plugin_ref;
use super::is_installed;
use super::load_deprecated_ids;
use super::load_presets;
use super::new_process_owner;
use super::pnpm::ensure_pnpm;
use super::profile_dir;
use super::run_plugin_with_allow_build_retry;
use super::uninstall_recovery;
use super::PreinstallPluginInfo;
use crate::service::plugin::update::known_latest;
use crate::service::profile::profile_release_age_excluded;

/// 批量升级：每个条目是 `<id>` 或 `<id>@<版本>`，两者走的路不同。
///
/// - 带版本（面板的升级入口一直显示着目标版本，所以这是常态）：直接显式安装那个版本
///   （见 [`install_targets`]）——不猜、不从声明范围里挑，于是「来源被钉死」「探测缓存
///   没命中」都不会再让升级落空；
/// - 不带版本（面板没探测到新版本、修复入口、外部调用）：先用宿主自己的探测补齐目标
///   （见 [`resolve_missing_targets`]），补不上才沿用 `dsh plugin update <id> --latest`
///   让 pnpm 在声明范围内挑最新，再逐项核验是否真的落地（见 [`update_to_latest`]）。
///
/// 逐项核验的结果汇总成一条错误消息（见 [`update_failure_payload`]）。
pub async fn update_many(app_handle: &AppHandle, specs: &[String]) -> Result<(), String> {
    let mut requested: Vec<(String, Option<String>)> = specs
        .iter()
        .map(|spec| split_upgrade_spec(spec))
        .collect();
    if requested.iter().any(|(_, version)| version.is_none()) {
        resolve_missing_targets(app_handle, &mut requested).await;
    }
    let explicit: Vec<(String, String)> = requested
        .iter()
        .filter_map(|(id, version)| Some((id.clone(), version.clone()?)))
        .collect();
    let implicit: Vec<String> = requested
        .iter()
        .filter(|(_, version)| version.is_none())
        .map(|(id, _)| id.clone())
        .collect();
    let mut failures = Vec::new();
    if !explicit.is_empty() {
        failures.extend(install_targets(app_handle, &explicit).await?);
    }
    if !implicit.is_empty() {
        failures.extend(update_to_latest(app_handle, &implicit).await?);
    }
    match update_failure_payload(failures) {
        Some(message) => Err(message),
        None => Ok(()),
    }
}

/// 面板没给出目标版本的条目：宿主自己探一次 registry 再决定精确目标。
///
/// 前端只在探测缓存命中时才知道目标版本，缓存没命中（面板没刷新过、探测被限流或
/// 失败）时条目会退化成 `<id>`，而只靠 `--latest` 又要看 pnpm 的发布时长窗口脸色。
/// 宿主这里补一次探测（带 TTL 缓存，命中时零请求），把「确实有更新」的条目升级成
/// 精确目标，让升级结果不再取决于某一次 UI 快照。
async fn resolve_missing_targets(
    app_handle: &AppHandle,
    requested: &mut [(String, Option<String>)],
) {
    if let Err(e) = crate::service::plugin::update::refresh(app_handle).await {
        log::warn!("failed to probe plugin updates before upgrading: {e}");
        return;
    }
    let profile = profile_dir(app_handle);
    for (id, version) in requested.iter_mut() {
        if version.is_some() {
            continue;
        }
        let Some(latest) = known_latest(app_handle, id) else {
            continue;
        };
        if !is_registry_version(&latest) || installed_package_version(&profile, id).as_deref() == Some(latest.as_str()) {
            continue;
        }
        *version = Some(latest);
    }
}

/// 显式安装一批精确目标（一次 pnpm 调用处理整批），并逐项核验是否真的落地。
///
/// `pnpm add <id>@<version>` 直接请求那个版本，声明里钉死来源（catalog 条目 / git ref /
/// `link:` 本地目录 / 精确版本）也照样被改写到目标版本——这正是「用户授权过那个新版本、
/// 升级却始终停在旧版本」的唯一出路。
///
/// 目标还在发布保护期内时先让 pnpm 如实报错（不加旗标），再用**我们自己请求的目标**合成
/// 拒绝载荷请用户授权（见 [`policy_refusal_from_specs`]）；授权会写进档案豁免清单，重跑时
/// 本批目标全部已豁免，带上放宽旗标就是安全的。反过来，没豁免就放宽会把太新的条目写进
/// lock，此后每一次插件操作都会在 lockfile 校验阶段失败（见 §5.3 的自愈说明）。
async fn install_targets(
    app_handle: &AppHandle,
    targets: &[(String, String)],
) -> Result<Vec<String>, String> {
    let profile = profile_dir(app_handle);
    let specs: Vec<String> = targets
        .iter()
        .map(|(id, version)| format!("{id}@{version}"))
        .collect();
    let ids: Vec<String> = targets.iter().map(|(id, _)| id.clone()).collect();
    let before: Vec<Option<String>> = ids
        .iter()
        .map(|id| dependency_fingerprint(&profile, id))
        .collect();
    let mut args = specs.clone();
    if targets.iter().all(|(id, version)| {
        profile_release_age_excluded(app_handle, &format!("{id}@{version}"))
    }) {
        args.push(RELEASE_AGE_RELAXED_FLAG.to_string());
    }
    if let Err(e) = run_plugin_command(app_handle, &ids, "add", &args).await {
        return Err(policy_refusal_from_specs(&specs, &e).unwrap_or(e));
    }
    let mut failures = Vec::new();
    for (index, (id, version)) in targets.iter().enumerate() {
        if let Err(e) =
            verify_update_landed(app_handle, id, before[index].as_deref(), Some(version)).await
        {
            failures.push(e);
        }
    }
    Ok(failures)
}

/// 没有目标版本的条目：`dsh plugin update <id> --latest` 让 pnpm 在声明范围内挑最新，
/// 逐项核验没落地的那些再尝试一次显式安装（见 [`force_upgrade_spec`]，只对已授权过的目标
/// 动手；未授权的先由前端走授权流程）。
async fn update_to_latest(app_handle: &AppHandle, ids: &[String]) -> Result<Vec<String>, String> {
    let profile = profile_dir(app_handle);
    let before: Vec<Option<String>> = ids
        .iter()
        .map(|id| dependency_fingerprint(&profile, id))
        .collect();
    let targets: Vec<(bool, bool)> = ids
        .iter()
        .map(|id| release_age_target(app_handle, &profile, id))
        .collect();
    let mut args = update_pnpm_args(ids);
    if relax_release_age(&targets) {
        args.push(RELEASE_AGE_RELAXED_FLAG.to_string());
    }
    run_plugin_command(app_handle, ids, "update", &args).await?;
    let mut failures = Vec::new();
    let mut forced = Vec::new();
    for (index, id) in ids.iter().enumerate() {
        match verify_update_landed(app_handle, id, before[index].as_deref(), None).await {
            Ok(()) => {}
            Err(e) => match force_upgrade_spec(id, &e) {
                Some(spec) => forced.push(spec),
                None => failures.push(e),
            },
        }
    }
    if forced.is_empty() {
        return Ok(failures);
    }
    log::warn!("dsh plugin update was blocked by the declared source, forcing {forced:?}");
    let forced_ids: Vec<String> = forced
        .iter()
        .map(|spec| split_upgrade_spec(spec).0)
        .collect();
    if let Err(e) = run_plugin_command(app_handle, &forced_ids, "add", &forced).await {
        return Err(policy_refusal_from_specs(&forced, &e).unwrap_or(e));
    }
    for (index, id) in ids.iter().enumerate() {
        let target = format!("{id}@");
        if !forced.iter().any(|spec| spec.starts_with(&target)) {
            continue;
        }
        if let Err(e) = verify_update_landed(app_handle, id, before[index].as_deref(), None).await {
            failures.push(e);
        }
    }
    Ok(failures)
}

/// 把面板给的升级条目切成 `(id, 目标版本)`：`aaa@1.2.3` 与 `@scope/aaa@1.2.3` 都按最后
/// 一个 `@` 切，`@scope/aaa`（无版本）与 `github:owner/repo` 这类非 registry 版本整条当
/// id——它们的「最新」是提交 SHA，装不了、也不该进发布时长豁免清单。
fn split_upgrade_spec(spec: &str) -> (String, Option<String>) {
    let Some((id, version)) = spec.rsplit_once('@') else {
        return (spec.to_string(), None);
    };
    if id.is_empty() {
        return (spec.to_string(), None);
    }
    if !is_registry_version(version) {
        return (id.to_string(), None);
    }
    (id.to_string(), Some(version.to_string()))
}

/// 显式安装被发布时长门禁拦住时，用**我们自己请求的目标**合成拒绝载荷。
///
/// pnpm 在两个阶段报的文本不同（解析形 / lockfile 校验形，见 `super::diagnose`），而
/// 「装不上」这一侧只知道失败。按请求的精确目标如实点名，前端才能照常请用户授权；授权
/// 会写进档案豁免清单，重跑时本批目标全部已授权，于是带上放宽旗标真的装上。
fn policy_refusal_from_specs(specs: &[String], failure: &str) -> Option<String> {
    if !failure.contains("ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION")
        && !failure.contains("minimumReleaseAge")
    {
        return None;
    }
    let blocked: Vec<serde_json::Value> = specs
        .iter()
        .filter_map(|spec| {
            let (id, version) = split_upgrade_spec(spec);
            let version = version?;
            Some(serde_json::json!({ "name": id, "version": version }))
        })
        .collect();
    if blocked.is_empty() {
        return None;
    }
    Some(format!(
        "PLUGIN_POLICY_BLOCKED: {}",
        serde_json::Value::Array(blocked)
    ))
}

/// 升级没落地、且只剩「声明把来源钉死」这一种成因时，显式安装目标版本所需的 spec。
///
/// `--latest` 只让 pnpm 越过声明**范围**里的版本；把来源钉死的声明（git ref、`link:`
/// 本地目录、精确版本、catalog 条目）在更新时会被 pnpm 原样保留——git spec 甚至不会被
/// 退化成 semver 范围——于是「用户已经授权过那个精确版本」仍然停在旧版本上。这种情况
/// 只有 `pnpm add <id>@<version>` 会把声明改写到目标版本，由 [`update_many`] 补这一步。
///
/// 只对**已授权过**的目标动手：`retryable` 为真说明用户还没授权，必须先走授权流程，
/// 否则等于替用户绕过发布时长门禁；`latest` 不是 registry 版本（git 提交 / 本地目录）时
/// 没有可安装的版本，显式安装无从谈起。
fn force_upgrade_spec(id: &str, failure: &str) -> Option<String> {
    let payload = failure.strip_prefix(UPDATE_HOLD_PREFIX)?;
    let payload: serde_json::Value = serde_json::from_str(payload).ok()?;
    if payload.get("retryable").and_then(serde_json::Value::as_bool) != Some(false) {
        return None;
    }
    let latest = payload.get("latest").and_then(serde_json::Value::as_str)?;
    if !is_registry_version(latest) {
        return None;
    }
    Some(format!("{id}@{latest}"))
}

/// 升级没生效的前缀：`PLUGIN_UPDATE_NO_CHANGE: <JSON>`。
const UPDATE_HOLD_PREFIX: &str = "PLUGIN_UPDATE_NO_CHANGE:";

/// 把逐项核验的失败汇成一条错误消息。
///
/// 多个 id 各自没生效时**不能**把每条 `PLUGIN_UPDATE_NO_CHANGE:` 用换行拼起来：前端把前缀
/// 之后的内容整体当成一份载荷，多份 JSON 拼在一起不再合法，解析失败会让整批退化成
/// 「升级插件 X 失败」，把「授权一下就能装的版本」说成损坏（见
/// `src/store/modules/plugins/utils.ts` 的 `parseUpdateHold`）。因此把每个没生效的条目收进
/// 一个 JSON 数组一次性带出去，前端就能逐项归因：能授权的进授权流程，钉死来源的中性提示。
/// 混进真正的失败（入口构建等）时优先如实报那条——它才是用户要处理的问题。
fn update_failure_payload(failures: Vec<String>) -> Option<String> {
    let mut holds = Vec::new();
    let mut others = Vec::new();
    for failure in failures {
        let payload = failure.strip_prefix(UPDATE_HOLD_PREFIX);
        match payload.and_then(|payload| serde_json::from_str::<serde_json::Value>(payload).ok()) {
            Some(value) => holds.push(value),
            None => others.push(failure),
        }
    }
    if !others.is_empty() {
        return Some(others.join("\n"));
    }
    if holds.is_empty() {
        return None;
    }
    Some(format!(
        "{UPDATE_HOLD_PREFIX} {}",
        serde_json::Value::Array(holds)
    ))
}

/// 升级时转发给 pnpm 的参数：每个 id 后各跟一个 `--latest`。
///
/// `update` 动词不写在这里：它由 [`single_plugin_args`] 作为动作统一放在参数最前，
/// 重复一次会变成 `pnpm update update <id>`（见该函数的说明）。
///
/// `--latest` 不能省：profile 里的依赖 spec 通常是范围（`catalog:` 或 `^x.y.z`），
/// 裸 `pnpm update` 只在声明范围内取值——档案的 spec 是 `catalog:` 时范围来自
/// `pnpm-workspace.yaml` 的 catalog 条目，条目钉在旧版本上（`^0.18.1` 之于 0.19.0，
/// 0.x 的 caret 不含次版本）就会直接打印 `Already up to date` 并以 0 退出，桌面端
/// 据此报「升级成功」而版本纹丝不动。加 `--latest` 才允许 pnpm 越过声明范围，并由
/// pnpm 自己把 catalog 条目改写到新版本；git spec 不受影响（`--latest` 不会把
/// `github:owner/repo` 退化成 semver 范围，实测原样保留）。
fn update_pnpm_args(ids: &[String]) -> Vec<String> {
    ids.iter()
        .flat_map(|id| [id.clone(), "--latest".to_string()])
        .collect()
}

/// 放宽 pnpm 发布时长门禁的参数：档案的 `minimumReleaseAgeExclude` 会被解析阶段采信，
/// lockfile 校验阶段却照旧按默认窗口拦截，授权过的精确版本因此永远装不上（见
/// [`relax_release_age`]）。
pub(super) const RELEASE_AGE_RELAXED_FLAG: &str = "--config.minimumReleaseAge=0";

/// 单个 id 的发布时长门禁事实：`(有可升级的 registry 目标, 该目标已授权)`。
///
/// 目标版本取更新探测缓存（[`known_latest`]，不新发网络请求）；git 托管插件的「最新」是
/// 提交 SHA、`next` 这类 ref 都不是版本，不能进发布时长豁免清单，按形状挡掉。
fn release_age_target(app_handle: &AppHandle, profile: &Path, id: &str) -> (bool, bool) {
    let target = known_latest(app_handle, id);
    let target = target.as_deref().filter(|latest| is_registry_version(latest));
    let Some(target) = target else {
        return (false, false);
    };
    let upgradable = installed_package_version(profile, id).as_deref() != Some(target);
    let excluded = profile_release_age_excluded(app_handle, &format!("{id}@{target}"));
    (upgradable, excluded)
}

/// 这次 `update` 调用是否要放宽发布时长门禁（[`RELEASE_AGE_RELAXED_FLAG`]）。
///
/// 实测 bundled pnpm 11.7.0：档案已列出 `billion-context@0.1.174` 时
/// `pnpm update billion-context --latest` 仍以 1 退出并报
/// `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`，同一命令追加
/// `--config.minimumReleaseAge=0` 才装到 0.1.174——「授权过的版本装不上」正是
/// 升级入口报「没有可授权的新版本」的成因。
///
/// 该旗标是**全调用生效**的：一旦放宽，同批里未被授权的包也可能跟着越过默认窗口。
/// 因此只在「本批每个可升级的 registry 目标都已授权」时放宽；混进一个未授权的可
/// 升级目标就保持默认窗口，界面照旧先请用户授权。升级入口按单个插件派发，批里通常
/// 只有一个目标。
fn relax_release_age(targets: &[(bool, bool)]) -> bool {
    let mut authorized = 0;
    for (upgradable, excluded) in targets {
        if !*upgradable {
            continue;
        }
        if !*excluded {
            return false;
        }
        authorized += 1;
    }
    authorized > 0
}

/// registry 版本形状：数字开头且含 `.`。git 托管插件的「最新」是提交 SHA、`next`
/// 这类 ref 都不是版本，不能进发布时长豁免清单。
fn is_registry_version(value: &str) -> bool {
    value.contains('.') && value.starts_with(|c: char| c.is_ascii_digit())
}

/// 依赖的「解析指纹」：profile `pnpm-lock.yaml` 当前 importer（`importers["."]`）
/// 中该直接依赖的 `specifier @ version`；该依赖不在 lock 里时回落到
/// `node_modules/<id>/package.json` 的实际版本。
///
/// 用途是核验升级是否真的落地（见 [`verify_update_landed`]）：pnpm 可能以 0
/// 退出却什么都没装，而「什么都没装」在两种依赖上表现不同——registry 依赖是版本号
/// 不变，git 依赖是版本号本来就可能不变（插件不 bump version）而只有 lock 里的
/// codeload 提交变化。因此指纹取 lock 的解析结果，两种依赖都能识别。
/// 两侧都读不到时返回 `None`，调用方跳过核验：绝不用不确定的读数误报升级失败。
fn dependency_fingerprint(profile: &Path, id: &str) -> Option<String> {
    if let Some(entry) = lock_dependency_entry(profile, id) {
        return Some(entry);
    }
    installed_package_version(profile, id).map(|version| format!("{id}@{version}"))
}

/// `pnpm-lock.yaml` 当前 importer 中该直接依赖的 `specifier @ version`。
///
/// 必须经 importer 归属（与 [`super::update`] 读取 Git 锁定提交的口径一致）：全局
/// 扫描会把同名传递依赖的解析结果算进来，指纹就会因无关依赖变动而抖动。
/// lock 缺失、损坏或结构不是预期形态时返回 `None`（交由调用方跳过核验）。
fn lock_dependency_entry(profile: &Path, id: &str) -> Option<String> {
    lock_dependency(profile, id).map(|(specifier, version)| format!("{specifier} @ {version}"))
}

/// importer 中该依赖的 `specifier` 与解析出的精确版本。
fn lock_dependency(profile: &Path, id: &str) -> Option<(String, String)> {
    let text = std::fs::read_to_string(profile.join("pnpm-lock.yaml")).ok()?;
    let lockfile: serde_yaml::Value = serde_yaml::from_str(&text).ok()?;
    let dependency = lockfile
        .get("importers")?
        .get(".")?
        .get("dependencies")?
        .get(id)?;
    let specifier = dependency
        .get("specifier")
        .and_then(serde_yaml::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let version = dependency
        .get("version")
        .and_then(serde_yaml::Value::as_str)
        .unwrap_or_default()
        .to_string();
    Some((specifier, version))
}

/// importer 里该依赖已解析的精确版本（不在 lock 中 / 读不出时 `None`）。
///
/// 供发布时长门禁的自愈判定使用（见 `install::heal_locked_release_age`）：被 pnpm 拦下
/// 的版本若正是 lock 里早早解析好的那个，说明它早就装到本机了，不是本次新解析的版本。
pub(super) fn locked_package_version(profile: &Path, id: &str) -> Option<String> {
    lock_dependency(profile, id).map(|(_, version)| version)
}

/// `node_modules/<id>/package.json` 声明的版本（缺失或损坏返回 `None`）。
fn installed_package_version(profile: &Path, id: &str) -> Option<String> {
    let path = profile.join("node_modules").join(id).join("package.json");
    let content = std::fs::read_to_string(path).ok()?;
    let manifest: serde_json::Value = serde_json::from_str(&content).ok()?;
    manifest.get("version")?.as_str().map(String::from)
}

/// 批量卸载：单次 `dsh plugin remove <id1> <id2> ...`，随后逐项核验 profile 清单，
/// 仍被引用时走离线卸载兜底（第三方可卸载插件），最后级联清理各自的单插件快照。
pub async fn remove_many(app_handle: &AppHandle, ids: &[String]) -> Result<(), String> {
    let command_result = run_plugin_command(app_handle, ids, "remove", ids).await;
    let mut failures = Vec::new();
    for id in ids {
        // `dsh plugin remove` 以子进程退出码为准，可能出现「命令成功但插件仍在」的
        // 边界（如 bundle 层残留、pnpm 静默失败）；node_modules / lockfile 损坏时
        // （典型：安装只写入了 profile 清单而产物缺失，见 issue #90）pnpm 甚至会
        // 直接失败。两种情形统一核验 profile 清单：只要插件仍被引用就回落离线卸载
        // （直接改清单 + 删目录 + 清 lockfile），确保插件真正移除
        // （参考 dsh-market 的「卸载后核验」约定：确认插件离开 profile 才算成功）。
        if is_installed(app_handle, id) {
            // 第三方可卸载插件才允许离线兜底；核心/官方等受保护包即使残留也不强删
            // （`uninstall_recovery` 对它们会拒绝）。
            if is_actionable_plugin_ref(id) {
                let outcome = match &command_result {
                    Ok(()) => "reported success".to_string(),
                    Err(e) => format!("failed: {e}"),
                };
                log::warn!(
                    "dsh plugin remove {outcome} but {id} is still referenced by profile manifest; forcing offline uninstall"
                );
                match uninstall_recovery(app_handle, id) {
                    Ok(()) => {
                        // 离线兜底成功：插件已真正从 profile 移除，清除历史错误，避免
                        // 前端残留异常标记（best-effort）。
                        if let Err(e) = errors::clear(app_handle, id) {
                            log::warn!("failed to clear plugin error for {id}: {e}");
                        }
                    }
                    Err(e) => failures.push(format!("{id}: {e}")),
                }
            } else {
                // 受保护包：命令失败则如实上报（不要把失败误报为成功），成功则仅告警。
                if let Err(e) = &command_result {
                    failures.push(format!("{id}: {e}"));
                }
                log::warn!(
                    "dsh plugin remove reported success but protected package {id} is still referenced by profile manifest; skipping offline uninstall"
                );
            }
        }
        // 卸载级联清理单插件快照（best-effort）：只有插件确实离开 profile 才删。
        // 离线兜底失败或受保护包残留时插件仍在，快照是用户唯一的回滚手段，必须保留
        // （issue #303：插件已移除则快照随之失效，避免残留孤儿快照占用存储）。
        if !is_installed(app_handle, id) {
            super::super::snapshot::delete_best_effort(app_handle, id);
        }
    }
    // 与单插件卸载的原语义一致：以「条目是否真的离开 profile」为准。命令以非 0
    // 退出但插件已被移走时不报错（卸载已达成），只有仍残留且兜底也失败才算失败。
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("\n"))
    }
}

/// 计算需要自动卸载的弃用插件已安装包名（纯函数，便于单测）。
///
/// 命中条件：id 登记在弃用名单（`resources/manifest.jsonc` 的 `plugins.depercated`，
/// 见 [`super::super::preset::load_deprecated_ids`]）且当前已安装，或插件被当前核心
/// 淘汰（[`PreinstallPluginInfo::retire_on`]：核心已超出清单声明的版本区间、或已安装
/// 版本不再落在该核心对应的插件版本区间内）。返回实际安装包名——离线卸载
/// （`uninstall_recovery`）以它为键从 profile 清单与 `node_modules` 精准移除
/// （scoped 包名与预设 id 不一致时也能正确卸载）。
///
/// 两条来源缺一不可：
/// 1. 预设仍声明该 id：以 `installed_name`（实际 npm 包名）为准；内部插件由启动
///    自愈强制安装，不适用弃用语义，跳过。
/// 2. 兜底——预设清单已不存在该 id（被整体删除，如 `dsh-tauri-panel` 并入核心后
///    从 `plugins.built-in` 移除）：此时按弃用名单登记的 id 本身核对。少了
///    这一步，弃用名单对「连预设条目一起删掉」的插件永远无效，其 `link:` 目标还会
///    因安装目录残留而躲过失效链接清理，残留 bundle 直接拖垮启动。
fn deprecated_installed_names(
    presets: &[PreinstallPluginInfo],
    deprecated_ids: &HashSet<String>,
    core_version: Option<&str>,
    installed: impl Fn(&str) -> bool,
    installed_version: impl Fn(&str) -> Option<String>,
) -> Vec<String> {
    let mut names: Vec<String> = presets
        .iter()
        .filter(|p| {
            let name = installed_name(p);
            if !installed(name) {
                return false;
            }
            if !p.internal && deprecated_ids.contains(&p.id) {
                return true;
            }
            p.retire_on(core_version, installed_version(name).as_deref())
        })
        .map(|p| installed_name(p).to_string())
        .collect();
    for id in deprecated_ids {
        if presets.iter().any(|p| p.id == *id) {
            continue;
        }
        if installed(id) {
            names.push(id.clone());
        }
    }
    names.sort();
    names.dedup();
    names
}

/// 弃用插件在 profile 中的残留判定：清单引用或 `node_modules` 入口。
///
/// 入口用 `symlink_metadata` 判定：junction / 符号链接的目标目录消失时 `exists()`
/// 返回 false，但入口本身仍是 profile 解析路径上的残留，必须能被识别并清掉
/// （`uninstall_recovery` 对已清空清单的 id 幂等，只清入口与 patch 层）。
fn deprecated_residue_present(app_handle: &AppHandle, name: &str) -> bool {
    is_installed(app_handle, name)
        || std::fs::symlink_metadata(profile_dir(app_handle).join("node_modules").join(name))
            .is_ok()
}

pub(crate) async fn uninstall_deprecated_plugins(app_handle: &AppHandle) -> Result<(), String> {
    let presets = load_presets(app_handle);
    let core_version = core::active_version(app_handle);
    let deprecated_ids = load_deprecated_ids(app_handle);
    let profile = profile_dir(app_handle);
    let names = deprecated_installed_names(
        &presets,
        &deprecated_ids,
        core_version.as_deref(),
        |name| deprecated_residue_present(app_handle, name),
        |name| installed_package_version(&profile, name),
    );
    if names.is_empty() {
        return Ok(());
    }
    log::info!("uninstalling deprecated preset plugins: {names:?}");
    let mut failures = Vec::new();
    for name in &names {
        log::info!("DEPRECATED_PLUGIN_UNINSTALL: removing deprecated plugin {name}");
        if let Err(e) = uninstall_recovery(app_handle, name) {
            log::warn!("DEPRECATED_PLUGIN_UNINSTALL_FAILED: {name}: {e}");
            failures.push(format!("{name}: {e}"));
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "DEPRECATED_PLUGIN_UNINSTALL_FAILED: {}",
            failures.join("; ")
        ))
    }
}

/// `dsh plugin` 的参数：`plugin --profile <档案> <action> <sub_args...>`。
///
/// `dsh plugin` 把 `--profile` 之后的参数**原样**转发给 pnpm（`dsh plugin --profile
/// <name> <pnpm-args...>`），所以动作动词只能出现一次：`sub_args` 里再带一次动词，
/// pnpm 收到的就是 `pnpm remove remove <id>`（issue #715 日志中的 `pnpm remove
/// remove dshmarket`）——`remove` 会去找一个名为 `remove` 的依赖，卸载/升级因此
/// 不生效甚至失败。
///
/// 版本豁免授权（`allow-version`，见 [`super::allow_version_exemptions`]）同样走
/// 这个形状：dsh 在转发给 pnpm 之前先拦下该动词，`--profile` 的拼装完全一致。
pub(super) fn single_plugin_args(profile: &str, action: &str, sub_args: &[String]) -> Vec<OsString> {
    let mut args = vec![
        OsString::from("plugin"),
        OsString::from("--profile"),
        OsString::from(profile),
        OsString::from(action),
    ];
    args.extend(sub_args.iter().map(OsString::from));
    args
}

/// 批量执行插件的升级/卸载：准备环境 → 停止服务 → 运行**一次** `dsh plugin`
/// （`dsh plugin` 把动词之后的参数原样转发 pnpm，一次调用即可处理多个依赖）→
/// 失败逐项记录错误、成功逐项清除错误。
async fn run_plugin_command(
    app_handle: &AppHandle,
    ids: &[String],
    action: &str,
    sub_args: &[String],
) -> Result<(), String> {
    if ids.is_empty() {
        return Err("PLUGIN_EMPTY_ID: plugin id is empty".to_string());
    }
    let window = app_handle
        .get_webview_window("main")
        .ok_or("WINDOW_NOT_FOUND: main window missing")?;

    cli::ensure_shims(app_handle)?;

    let node = config::get_node_binary_path(app_handle);
    let dsh_bin = core::active_dsh_binary(app_handle);
    if !node.exists() {
        return Err("NODE_NOT_FOUND: Node.js runtime missing".to_string());
    }
    if !dsh_bin.exists() {
        return Err("HARNESS_NOT_FOUND: dsh CLI missing".to_string());
    }

    let owner = new_process_owner();
    let prefer_bundled_pnpm = ensure_pnpm(app_handle, &window, owner).await?;
    // `.npmrc` 可能在服务启动后被删除；升级/卸载同样可能触发 pnpm 非交互清理。
    super::ensure_profile_npmrc(app_handle)?;
    // 与批量安装保持一致：旧档案也必须具备精确的 release-age 例外，
    // 否则升级/卸载触发 pnpm lockfile 校验时同样会被 issue #222 的问题阻断。
    super::ensure_profile_pnpm_policy(app_handle)?;
    // 升级前自动快照当前版本（覆盖式），失败仅告警不阻断升级
    // （issue #303：自动快照失败不阻塞主流程；还原入口在插件面板）。
    // 与批量安装一致，这里**不再**停掉运行中的服务：插件包只会被随后的 pnpm 改写，
    // 先停服对快照一致性没有帮助，反而让用户在升级中途失去服务。
    if action == "update" {
        for id in ids {
            super::super::snapshot::create_best_effort(app_handle, id);
        }
    }

    let envs = build_plugin_envs(app_handle, prefer_bundled_pnpm);

    let mut args = vec![dsh_bin.as_os_str().to_os_string()];
    args.extend(single_plugin_args(
        &active_profile(app_handle),
        action,
        sub_args,
    ));

    let cwd = config::get_dsh_install_path(app_handle);
    log::info!("Running dsh plugin {action} for {ids:?}");
    let (exit_code, output, last_attempt) = run_plugin_with_allow_build_retry(
        app_handle, &node, &args, &cwd, &envs, &window, action, None, owner,
    )
    .await?;

    // 门禁自愈：lockfile 里早有的太新条目会让**每一次**状态变更都失败
    // （见 `super::heal_locked_release_age`）。补齐豁免后放宽窗口重跑一次——本批若已经
    // 因全部目标授权而放宽过（参数里已有旗标），就没什么可补的，直接按原样分类。
    let relaxed = args
        .iter()
        .any(|arg| arg.to_str() == Some(RELEASE_AGE_RELAXED_FLAG));
    let (exit_code, output, last_attempt) = if exit_code != 0
        && !relaxed
        && super::heal_locked_release_age(app_handle, &last_attempt)
    {
        let mut retry_args = args.clone();
        retry_args.push(OsString::from(RELEASE_AGE_RELAXED_FLAG));
        run_plugin_with_allow_build_retry(
            app_handle, &node, &retry_args, &cwd, &envs, &window, action, None, owner,
        )
        .await?
    } else {
        (exit_code, output, last_attempt)
    };

    if exit_code != 0 {
        log::error!("dsh plugin {action} failed for {ids:?} with exit code {exit_code}");
        // 版本兼容性拒绝：dsh 在 pnpm 之前核对插件声明的 DSH peer 依赖，未授权精确版本
        // 即拒绝（不下载、不构建），升级同样会撞上（新版本声明了更高的核心 peer 依赖）。
        // 与批量安装路径一致地解析成精确三元组，交前端「授权后重跑」；不记插件错误——
        // 插件没坏，只是待用户授权。
        let incompatible = incompatible_versions(&last_attempt);
        if !incompatible.is_empty() {
            log::warn!(
                "dsh refused the {action} for incompatible plugin versions: {incompatible:?}"
            );
            return Err(format!(
                "PLUGIN_VERSION_INCOMPATIBLE: {}",
                serde_json::to_string(&incompatible).unwrap_or_default()
            ));
        }
        // 真实的发布时长策略违规优先识别：档案已声明/装了太新的版本，pnpm 的 lockfile
        // 校验不放行，于是升级/卸载/安装都会在这里失败。不是插件故障、也不是网络问题
        // （发布时间都拿到了），重试无用——解析成精确 `包名@版本` 交给前端由用户授权，
        // 写进档案的 `minimumReleaseAgeExclude` 后再重跑。
        let policy_blocked = policy_blocked_versions(&last_attempt);
        if !policy_blocked.is_empty() {
            log::warn!(
                "pnpm release-age policy rejected {} profile entries during {action}: {policy_blocked:?}",
                policy_blocked.len()
            );
            return Err(format!(
                "PLUGIN_POLICY_BLOCKED: {}",
                serde_json::to_string(&policy_blocked).unwrap_or_default()
            ));
        }
        // lockfile 供应链校验因 registry 元数据拉取失败而误判违规时，对用户而言就是
        // 网络问题：给「检查网络后重试」而不是一条看不懂的供应链违规。分类只看最后
        // 一次尝试的输出——历次拼接会让早先一次的网络字样给真·违规「背书」；拼接串
        // 仍用于用户可见的诊断文本。
        let hint = git_transport_hint(&last_attempt);
        let network_error = network_error_hint(&last_attempt).is_some()
            || policy_verification_network_failure(&last_attempt)
            || (exit_code == 3 && last_attempt.trim().is_empty());
        let store_hint = store_mismatch_hint(&last_attempt);
        let message = if network_error {
            "NETWORK_ERROR: plugin registry request failed; check network or proxy settings and retry."
                .to_string()
        } else if let Some(store_hint) = store_hint.as_deref() {
            store_hint.to_string()
        } else {
            pick_error_message(&output, hint)
        };
        for id in ids {
            if let Err(e) = errors::record(app_handle, id, action, &message) {
                log::warn!("failed to record plugin error for {id}: {e}");
            }
        }
        if network_error {
            return Err("NETWORK_ERROR: plugin registry request failed; check network or proxy settings and retry.".to_string());
        }
        // 与批量安装一致：把 pnpm 因 store 布局不匹配给出的两条路径补进错误里
        if let Some(store_hint) = store_hint {
            log::warn!("pnpm store incompatibility detected during plugin {action}: {store_hint}");
            return Err(format!(
                "PLUGIN_{}_FAILED: dsh plugin exited with code {exit_code} ({store_hint})",
                action.to_uppercase()
            ));
        }
        return Err(format!(
            "PLUGIN_{}_FAILED: dsh plugin exited with code {exit_code}",
            action.to_uppercase()
        ));
    }

    // 成功：逐项清除历史错误；卸载 win-terminal-inspector 时顺带清理 patch 挂载
    for id in ids {
        if let Err(e) = errors::clear(app_handle, id) {
            log::warn!("failed to clear plugin error for {id}: {e}");
        }
    }
    if action == "remove" && ids.iter().any(|id| id == "dsh-win-terminal-inspector") {
        if let Err(e) = workflow::win_inspector::apply(app_handle) {
            log::warn!("win inspector patch prune failed after remove: {e}");
        }
    }
    log::info!("dsh plugin {action} succeeded for {ids:?}");
    Ok(())
}

/// 升级后逐项核验：确认升级真的落地，并补构建缺失的声明入口。
///
/// 假成功核验：pnpm 以 0 退出、但该依赖的解析结果与升级前完全一致，说明这次
/// 升级没有落地。两种已知成因都属于「按当前策略不该动」，而不是插件损坏：
/// 1. 档案 spec 把版本钉死（`catalog:` 条目 / git 提交 / `link:` 本地目录），
///    `--latest` 也越不过声明范围——这一种由 [`update_many`] 在授权后用显式安装兜底
///    （见 [`force_upgrade_spec`]），只有兜底也推不动时才把「没升级」报给用户；
/// 2. pnpm 的 release-age 策略：新版本发布不足 `minimumReleaseAge`（pnpm 11
///    默认 1440 分钟 = 24 小时）时解析会回落到仍达标的最新版本，命令照旧以 0
///    退出且**不打印任何说明**——实测 bundled pnpm 11.7.0 在 `^2.10.15` 上
///    `update --latest` 静默停在 2.10.15。用户授权该精确版本后，由 [`update_many`]
///    追加 `--config.minimumReleaseAge=0` 才能真正落地（档案里的豁免只被解析阶段
///    采信，lockfile 校验阶段照样拦）。因此这条消息不能只归因于 catalog 钉死
///    （会把人引偏）。
/// 必须如实报「没升级」——报成功会让用户以为已在新版本上（与 [`remove_many`] 的
/// 「卸载后核验」同理）；但**不**记进插件错误：插件没坏，记了会让列表挂上
/// 「可能已损坏或与当前环境不兼容」的误导标记（安装/升级真失败各有记录点）。
///
/// 入口核验与安装一致：git 托管插件升级后同样可能停在「prepare 未构建 → 声明
/// 入口缺失」坏态，若不拦截，下一次启动即崩溃（见 [`ensure_plugin_entry_built`]）。
/// 包名先解析（预设 package 覆盖 / 清单依赖 basename），解析不到时跳过核验
/// （警告即可，不误杀成功更新）。
async fn verify_update_landed(
    app_handle: &AppHandle,
    id: &str,
    before: Option<&str>,
    expected: Option<&str>,
) -> Result<(), String> {
    if let Some(expected) = expected {
        // 已经就是用户要的那个版本：pnpm 没有东西可改，指纹自然不变，但请求的状态已经达成
        // ——显式安装之后这一条必须算成功，否则「装上了」会被报成「没有变化」。
        if installed_package_version(&profile_dir(app_handle), id).as_deref() == Some(expected) {
            return Ok(());
        }
    }
    if let Some(before) = before {
        if dependency_fingerprint(&profile_dir(app_handle), id).as_deref() == Some(before) {
            let detail = installed_package_version(&profile_dir(app_handle), id)
                .unwrap_or_else(|| before.to_string());
            // 只有「新版本太新」这一种成因有出路（授权那个精确版本即可过闸），因此把
            // 目标版本与「是否已在豁免清单里」一并带出去：已经授权过还是不动，说明成因
            // 是档案把来源钉死，界面就别再给按钮——否则用户只会反复点一个没用的动作。
            // 目标版本优先用本次请求带来的版本（面板显示的那个），探测缓存只在没有时才
            // 兜底：缓存没命中会让 `latest` 为空、`retryable` 判成不可授权，用户点升级
            // 就只剩一句「没有变化」。
            let latest = expected
                .filter(|expected| *expected != detail && is_registry_version(expected))
                .map(str::to_string)
                .or_else(|| {
                    known_latest(app_handle, id).filter(|latest| latest != &detail && is_registry_version(latest))
                });
            let retryable = latest.as_deref().is_some_and(|latest| {
                !profile_release_age_excluded(app_handle, &format!("{id}@{latest}"))
            });
            log::warn!(
                "dsh plugin update made no change for {id}, still at {detail}, newest {latest:?}, actionable {retryable}"
            );
            return Err(format!(
                "{UPDATE_HOLD_PREFIX} {}",
                serde_json::json!({
                    "name": id,
                    "version": detail,
                    "latest": latest,
                    "retryable": retryable,
                })
            ));
        }
    }
    let Some(name) = installed_package_name(app_handle, id) else {
        log::warn!("plugin {id} not resolvable to a package name, skipping entry verify");
        return Ok(());
    };
    let window = app_handle
        .get_webview_window("main")
        .ok_or("WINDOW_NOT_FOUND: main window missing")?;
    let envs = build_plugin_envs(app_handle, harness_prefer_bundled_pnpm(app_handle));
    let pkg_dir = profile_dir(app_handle).join("node_modules").join(name);
    if let Err(e) = ensure_plugin_entry_built(app_handle, id, &pkg_dir, &envs, &window).await {
        if let Err(err) = errors::record(app_handle, id, "update", &e) {
            log::warn!("failed to record plugin error for {id}: {err}");
        }
        return Err(e);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::manifest::{PluginVersion, VersionPair};

    /// 测试入口：只关心弃用清单时补一个「未知核心版本 + 未知已安装版本」。
    fn deprecated_names(
        presets: &[PreinstallPluginInfo],
        ids: &HashSet<String>,
        installed: impl Fn(&str) -> bool,
    ) -> Vec<String> {
        deprecated_installed_names(presets, ids, None, installed, |_| None)
    }

    /// 内置插件被核心吸收后同样退役：只靠清单声明的版本矩阵（`retire_on`）判定，
    /// 弃用清单不参与。
    #[test]
    fn unsupported_internal_entry_is_uninstalled() {
        let mut entry = preset("dsh-internal", "dsh-tauri@0.2.0", true);
        entry.version = Some(PluginVersion::Matrix(vec![VersionPair {
            version: "^1.2.3".into(),
            dsh: "^0.1.5-rc.1".into(),
        }]));

        // 核心已超出声明区间，且已安装版本仍落在同代区间内 → 退役
        assert_eq!(
            deprecated_installed_names(
                &[entry.clone()],
                &HashSet::new(),
                Some("0.2.0"),
                |name| name == "dsh-internal",
                |_| Some("1.2.3".into()),
            ),
            vec!["dsh-internal".to_string()]
        );

        // 已安装版本比清单声明的更新 → 保留，不误删用户手上的修复版
        assert!(deprecated_installed_names(
            &[entry],
            &HashSet::new(),
            Some("0.2.0"),
            |name| name == "dsh-internal",
            |_| Some("2.0.0".into()),
        )
        .is_empty());
    }

    /// 一批里两个 id 都没生效时，两条 hold 载荷必须并成**一个** JSON 数组：拼成多行会让
    /// 前端 `parseUpdateHold` 解析失败，把「授权一下就能装」说成「升级失败」。
    #[test]
    fn update_failure_payload_merges_holds_into_one_array() {
        let message = update_failure_payload(vec![
            format!(
                "{UPDATE_HOLD_PREFIX} {}",
                serde_json::json!({"name": "a", "version": "1.0.0", "latest": "2.0.0", "retryable": true})
            ),
            format!(
                "{UPDATE_HOLD_PREFIX} {}",
                serde_json::json!({"name": "b", "version": "1.0.0", "latest": null, "retryable": false})
            ),
        ])
        .expect("message");

        let payload = message.strip_prefix(UPDATE_HOLD_PREFIX).expect("prefix");
        let parsed: serde_json::Value = serde_json::from_str(payload).expect("array payload");
        let items = parsed.as_array().expect("array");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["name"], "a");
        assert_eq!(items[1]["retryable"], false);
    }

    /// 真正的失败（入口构建等）不能被 hold 载荷吞掉，否则用户看不到要处理的问题。
    #[test]
    fn update_failure_payload_prefers_real_failures() {
        let message = update_failure_payload(vec![
            "PLUGIN_ENTRY_MISSING: a is broken".to_string(),
            format!(
                "{UPDATE_HOLD_PREFIX} {}",
                serde_json::json!({"name": "a", "latest": "2.0.0", "retryable": true})
            ),
        ])
        .expect("message");

        assert_eq!(message, "PLUGIN_ENTRY_MISSING: a is broken");
        assert!(update_failure_payload(Vec::new()).is_none());
    }

    /// 只有「已授权过的 registry 目标」才补显式安装：未授权时先走授权流程，git / link 目标
    /// 没有可安装的版本号。
    #[test]
    fn pinned_upgrades_are_forced_only_after_authorisation() {
        let hold = |latest: &str, retryable: bool| {
            format!(
                "{UPDATE_HOLD_PREFIX} {}",
                serde_json::json!({"name": "a", "latest": latest, "retryable": retryable})
            )
        };

        assert_eq!(
            force_upgrade_spec("a", &hold("0.1.174", false)),
            Some("a@0.1.174".to_string())
        );
        assert_eq!(force_upgrade_spec("a", &hold("0.1.174", true)), None);
        assert_eq!(force_upgrade_spec("a", &hold("main", false)), None);
        assert_eq!(force_upgrade_spec("a", &hold("", false)), None);
        assert_eq!(force_upgrade_spec("a", "PLUGIN_ENTRY_MISSING: broken"), None);
    }

    /// 面板给的条目才带版本：`@scope` 包按最后一个 `@` 切，非 registry 版本（git ref、`next`）
    /// 整条当 id——它们进不了 `pnpm add <id>@<version>`，也不该进发布时长豁免清单。
    #[test]
    fn upgrade_specs_split_versions_only_when_they_are_registry_versions() {
        assert_eq!(
            split_upgrade_spec("aaa@1.2.3"),
            ("aaa".to_string(), Some("1.2.3".to_string()))
        );
        assert_eq!(
            split_upgrade_spec("@scope/aaa@1.2.3"),
            ("@scope/aaa".to_string(), Some("1.2.3".to_string()))
        );
        assert_eq!(
            split_upgrade_spec("@scope/aaa"),
            ("@scope/aaa".to_string(), None)
        );
        assert_eq!(split_upgrade_spec("aaa@next"), ("aaa".to_string(), None));
        assert_eq!(
            split_upgrade_spec("github:owner/repo#main"),
            ("github:owner/repo#main".to_string(), None)
        );
    }

    /// 显式安装被发布时长门禁拦住时，按请求的精确目标合成拒绝载荷——pnpm 两个阶段报的文本
    /// 不同，前端要的是「哪个包、哪个版本」。
    #[test]
    fn policy_refusals_name_the_requested_targets() {
        let specs = vec!["aaa@1.2.3".to_string(), "bbb@2.0.0".to_string()];
        let failure = "ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION  aaa@1.2.3 was published at ...";

        assert_eq!(
            policy_refusal_from_specs(&specs, failure),
            Some(
                "PLUGIN_POLICY_BLOCKED: [{\"name\":\"aaa\",\"version\":\"1.2.3\"},{\"name\":\"bbb\",\"version\":\"2.0.0\"}]"
                    .to_string()
            )
        );
        assert_eq!(policy_refusal_from_specs(&specs, "PLUGIN_ENTRY_MISSING: broken"), None);
        assert_eq!(
            policy_refusal_from_specs(&["aaa@next".to_string()], failure),
            None
        );
    }

    fn preset(id: &str, spec: &str, internal: bool) -> PreinstallPluginInfo {
        PreinstallPluginInfo {
            id: id.into(),
            spec: spec.into(),
            package: None,
            name: String::new(),
            description: String::new(),
            repo_url: String::new(),
            recommended: false,
            fix: false,
            default_checked: false,
            default_unchecked: false,
            version: None,
            win_only: false,
            internal,
        }
    }

    #[test]
    fn unsupported_cleanup_respects_declared_version_ranges() {
        let declared = vec![
            VersionPair {
                version: "^1.2.0".into(),
                dsh: "^0.1.5-rc.1".into(),
            },
            VersionPair {
                version: "^1.4.0".into(),
                dsh: "^0.1.7-rc.1".into(),
            },
        ];
        for (core, actual, remove) in [
            (Some("0.1.5-rc.3"), Some("1.2.0"), false),
            (Some("0.1.6"), Some("1.2.5"), false),
            (Some("0.1.6"), Some("1.4.0"), false),
            (Some("0.1.7-rc.2"), Some("1.4.0"), false),
            (Some("0.1.7-rc.2"), Some("1.2.0"), true),
            // 回归：核心仍在声明区间内、已装版本**新于**该代区间 → 保留（用户自升级）
            (Some("0.1.7-rc.2"), Some("1.5.0"), false),
            (Some("0.1.7-rc.2"), Some("2.0.0"), false),
            (Some("0.1.5-rc.3"), Some("1.3.0"), false),
            (Some("0.1.5-rc.3"), Some("9.9.9"), false),
            (Some("0.2.0"), Some("1.4.0"), true),
            (Some("0.2.0"), Some("2.0.0"), false),
            (Some("0.2.0"), Some("1.0.0"), false),
            (Some("0.2.0"), None, false),
            (Some("0.2.0"), Some("invalid"), false),
            (None, Some("1.2.0"), false),
            (Some("invalid"), Some("1.2.0"), false),
        ] {
            let mut entry = preset("probe", "@scope/probe", false);
            entry.package = Some("@scope/probe".into());
            entry.version = Some(PluginVersion::Matrix(declared.clone()));
            let names = deprecated_installed_names(
                &[entry.clone()],
                &HashSet::new(),
                core,
                |name| name == "@scope/probe",
                |name| {
                    assert_eq!(name, "@scope/probe");
                    actual.map(String::from)
                },
            );
            let expected = if remove {
                vec!["@scope/probe".to_string()]
            } else {
                Vec::new()
            };
            assert_eq!(names, expected, "core={core:?}, actual={actual:?}");
        }
    }

    #[test]
    fn explicit_deprecation_removes_regardless_of_installed_version() {
        // 显式弃用是发布侧决策：与已安装版本、与核心版本都无关，一律卸载
        let mut entry = preset("probe", "probe", false);
        entry.version = Some(PluginVersion::Declared("1.2.0".into()));
        let ids = HashSet::from(["probe".to_string()]);
        assert_eq!(
            deprecated_installed_names(&[entry], &ids, None, |_| true, |_| Some("2.0.0".into()),),
            vec!["probe".to_string()]
        );
    }

    #[test]
    fn unsupported_cleanup_reads_actual_scoped_package_version() {
        let dir = probe_profile("cleanup-version", LOCK_CATALOG, Some("0.18.1"));
        let package = dir.join("node_modules/@scope/probe");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(
            package.join("package.json"),
            r#"{"name":"@scope/probe","version":"2.0.0"}"#,
        )
        .unwrap();
        let mut entry = preset("probe", "@scope/probe", false);
        entry.package = Some("@scope/probe".into());
        entry.version = Some(PluginVersion::Matrix(vec![VersionPair {
            version: "^0.18.0".into(),
            dsh: "^0.1.5-rc.1".into(),
        }]));
        let names = deprecated_installed_names(
            &[entry],
            &HashSet::new(),
            Some("0.2.0"),
            |_| true,
            |name| installed_package_version(&dir, name),
        );
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(
            names.is_empty(),
            "newer installed scoped package must be preserved"
        );
    }

    #[test]
    fn deprecated_installed_only_picks_marked_and_installed() {
        // 三个弃用条目都在预设清单里声明（预设驱动的常规路径），逐个区分命中。
        let deprecated: HashSet<String> = ["dsh-ok", "dsh-scoped", "dsh-not-installed"]
            .into_iter()
            .map(String::from)
            .collect();
        let mut scoped = preset("dsh-scoped", "github:x/y", false);
        scoped.package = Some("@scope/deprecated".into());
        let declared = vec![
            preset("dsh-ok", "dshmarket", false),
            scoped,
            preset("dsh-not-installed", "dshmarket", false),
        ];

        // 命中：登记且已安装 → 返回实际安装包名（dsh-ok 未声明 package，回落 id）
        let only_ok = |name: &str| name == "dsh-ok";
        assert_eq!(
            deprecated_names(&declared, &deprecated, only_ok),
            vec!["dsh-ok".to_string()]
        );

        // scoped 包：返回真实安装包名（与预设 id 不一致）
        let only_scoped = |name: &str| name == "@scope/deprecated";
        assert_eq!(
            deprecated_names(&declared, &deprecated, only_scoped),
            vec!["@scope/deprecated".to_string()]
        );

        // 登记了但未安装：不命中
        assert!(deprecated_names(&declared, &deprecated, |_| false).is_empty());

        // 未登记弃用：即使已安装也不命中
        let plain = preset("dsh-plain", "dsh-plain", false);
        assert!(deprecated_names(&[plain], &deprecated, |name| name == "dsh-plain").is_empty());

        // 内部插件即使登记弃用也不命中（内部插件由启动自愈强制安装）
        let internal = preset("dsh-internal", "dsh-tauri@0.2.0", true);
        assert!(deprecated_names(&[internal], &deprecated, |name| matches!(
            name,
            "dsh-internal"
        ))
        .is_empty());
    }

    #[test]
    fn deprecated_installed_falls_back_when_preset_entry_removed() {
        // 弃用条目已从预设清单整体删除（dsh-tauri-panel 并入核心后从
        // plugins.built-in 移除）：预设驱动的循环命中不到，兜底按 id 卸载。
        let removed: HashSet<String> = ["dsh-tauri-panel"].into_iter().map(String::from).collect();

        assert_eq!(
            deprecated_names(&[], &removed, |name| name == "dsh-tauri-panel"),
            vec!["dsh-tauri-panel".to_string()]
        );

        // 清单里根本没有弃用条目：即使同名包已安装也不命中
        assert!(
            deprecated_names(&[], &HashSet::new(), |name| name == "dsh-tauri-panel").is_empty()
        );

        // 仍被预设声明（内部插件由自愈强制安装）：不走兜底，避免与自愈互相拉扯
        assert!(deprecated_names(
            &[preset("dsh-tauri-panel", "dsh-tauri@0.2.0", true)],
            &removed,
            |name| name == "dsh-tauri-panel"
        )
        .is_empty());
    }

    // ---- 升级参数与「假成功」核验 ----

    #[test]
    fn update_args_request_latest() {
        // 回归锚点：缺了 `--latest`，pnpm 只在声明范围内取值。档案把依赖钉在
        // `catalog:` 条目上时（catalog `^0.18.1` 之于 0.19.0），升级会退化成
        // 「退出码 0 但什么都没装」的假成功——正是 sidebar 0.18.1→0.19.0 不生效的根因。
        assert_eq!(
            update_pnpm_args(&["dsh-better-sidebar".to_string()]),
            vec!["dsh-better-sidebar", "--latest"]
        );
    }

    /// 回归用户报告：授权过的精确版本此前永远装不上——档案里的发布时长豁免只被
    /// 解析阶段采信，lockfile 校验阶段照旧按默认窗口拦截，`--latest` 于是「退出 0
    /// 但版本没动」。已授权的目标版本必须让那次调用带上门禁放宽参数。
    #[test]
    fn release_age_relaxation_requires_an_authorized_registry_target() {
        assert!(relax_release_age(&[(true, true)]));
        // 没授权过 → 不放宽，界面照旧先请用户授权
        assert!(!relax_release_age(&[(true, false)]));
        // 混进未授权的可升级目标 → 整批保持默认窗口，不能顺带把它放过去
        assert!(!relax_release_age(&[(true, true), (true, false)]));
        // 没有可升级目标的目标不阻碍放宽（同版本 / 没有 registry 目标）
        assert!(relax_release_age(&[(true, true), (false, false)]));
        assert!(!relax_release_age(&[(false, true)]));
        assert!(!relax_release_age(&[]));
    }

    #[test]
    fn registry_versions_are_recognized_by_shape() {
        assert!(is_registry_version("0.1.174"));
        assert!(is_registry_version("1.66.5"));
        assert!(!is_registry_version("next"));
        assert!(!is_registry_version("b3a69187e1bac1bf6162e3d37d005e58bc2ee74e"));
        assert!(!is_registry_version(""));
    }

    /// 回归 issue #715：`dsh plugin` 把动作之后的参数原样转发给 pnpm，动作动词因此
    /// 只能出现一次。升级/卸载曾把动词同时放进 `action` 与 `sub_args`，实际执行
    /// `pnpm remove remove <id>`、`pnpm update update <id> --latest`。
    #[test]
    fn single_plugin_args_keep_the_pnpm_verb_once() {
        let remove = single_plugin_args("tauri", "remove", &["dshmarket".to_string()]);
        assert_eq!(
            remove,
            vec!["plugin", "--profile", "tauri", "remove", "dshmarket"]
        );

        let update = single_plugin_args(
            "tauri",
            "update",
            &update_pnpm_args(&["dsh-better-sidebar".to_string()]),
        );
        assert_eq!(
            update,
            vec![
                "plugin",
                "--profile",
                "tauri",
                "update",
                "dsh-better-sidebar",
                "--latest"
            ]
        );

        for (action, args) in [("remove", &remove), ("update", &update)] {
            let joined: Vec<String> = args
                .iter()
                .map(|argument| argument.to_string_lossy().into_owned())
                .collect();
            assert_eq!(
                joined.iter().filter(|argument| *argument == action).count(),
                1,
                "{action} must appear exactly once in {joined:?}"
            );
        }
    }

    /// 造一个最小 profile：写入 `pnpm-lock.yaml` 与 `node_modules/dsh-probe/package.json`。
    fn probe_profile(label: &str, lock: &str, installed: Option<&str>) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("dsh-plugin-fp-{}-{label}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("node_modules").join("dsh-probe")).unwrap();
        std::fs::write(dir.join("pnpm-lock.yaml"), lock).unwrap();
        if let Some(version) = installed {
            std::fs::write(
                dir.join("node_modules")
                    .join("dsh-probe")
                    .join("package.json"),
                format!(r#"{{"name":"dsh-probe","version":"{version}"}}"#),
            )
            .unwrap();
        }
        dir
    }

    /// catalog 依赖的 lock 形态（与真实档案一致：specifier 是 `catalog:`，version 是解析结果）
    const LOCK_CATALOG: &str = "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      dsh-probe:\n        specifier: 'catalog:'\n        version: 0.18.1\n";

    #[test]
    fn fingerprint_uses_current_importer_entry() {
        let dir = probe_profile("entry", LOCK_CATALOG, Some("0.18.1"));
        assert_eq!(
            dependency_fingerprint(&dir, "dsh-probe").as_deref(),
            Some("catalog: @ 0.18.1")
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn fingerprint_changes_when_resolved_version_moves() {
        // 升级真的落地 → 指纹必须变化；否则会把成功误判成「假成功」而报错
        let before = probe_profile("bump-before", LOCK_CATALOG, Some("0.18.1"));
        let after = probe_profile(
            "bump-after",
            &LOCK_CATALOG.replace("version: 0.18.1", "version: 0.19.0"),
            Some("0.19.0"),
        );
        assert_ne!(
            dependency_fingerprint(&before, "dsh-probe"),
            dependency_fingerprint(&after, "dsh-probe")
        );
        std::fs::remove_dir_all(&before).ok();
        std::fs::remove_dir_all(&after).ok();
    }

    #[test]
    fn fingerprint_detects_git_commit_change_with_stable_version() {
        // git 依赖：插件不 bump version，只有 lock 里的 codeload 提交变化。
        // 指纹必须仍能识别（否则 git 插件的正常升级会被误报为假成功）。
        let lock = |sha: &str| {
            format!("lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      dsh-probe:\n        specifier: 'catalog:'\n        version: https://codeload.github.com/o/r/tar.gz/{sha}\n")
        };
        let before = probe_profile("git-before", &lock("aaaaaaaaaaaaaaaa"), Some("0.2.21"));
        let after = probe_profile("git-after", &lock("bbbbbbbbbbbbbbbb"), Some("0.2.21"));
        assert_ne!(
            dependency_fingerprint(&before, "dsh-probe"),
            dependency_fingerprint(&after, "dsh-probe")
        );
        std::fs::remove_dir_all(&before).ok();
        std::fs::remove_dir_all(&after).ok();
    }

    #[test]
    fn fingerprint_falls_back_to_installed_version() {
        // lock 里没有该依赖（或 lock 不可用）→ 回落到 node_modules 版本，
        // 「版本没动」这一假成功形态仍然可识别
        let dir = probe_profile(
            "fallback",
            "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies: {}\n",
            Some("0.18.1"),
        );
        assert_eq!(
            dependency_fingerprint(&dir, "dsh-probe").as_deref(),
            Some("dsh-probe@0.18.1")
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn fingerprint_is_none_when_nothing_is_readable() {
        // 两侧都读不到 → None，调用方跳过核验：不确定时绝不误报升级失败
        let dir = probe_profile("unreadable", "", None);
        assert_eq!(dependency_fingerprint(&dir, "dsh-probe"), None);
        std::fs::remove_dir_all(&dir).ok();
    }
}
