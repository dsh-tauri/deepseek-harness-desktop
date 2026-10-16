//! 预装插件完整性自检与离线修复（verify）。
//!
//! 动机（issue #90）：首次引导「安装全部推荐插件」后，若安装只把插件写入了
//! profile 清单（`package.json` 的 `dependencies` + `dsh.profile.bundles`）而
//! `node_modules` 中的插件产物缺失/损坏（安装中断、磁盘异常、半失败状态等），
//! dsh 服务启动时 loader 会对每个缺失插件抛 `ERR_MODULE_NOT_FOUND`（日志特征
//! `Cannot find package 'X' imported from .../cordis-plugin-loader/lib/index.js`），
//! 整个插件树加载失败、服务无法启动；更糟的是 pnpm 在损坏的 node_modules 上
//! 同样无法卸载/升级，用户被卡死在「启动失败 + 卸载失败」的组合里。
//!
//! 本模块在服务启动前核对「清单引用的预装插件是否真实存在于 profile 的
//! `node_modules`」，缺失时以现有 manifest + lockfile 为准在 profile 目录执行
//! `pnpm install` 重建依赖图（不解析新版本、不写清单，纯修复节点_modules 与
//! 锁文件一致）；修复后仍缺失再给对应插件记录错误标记（前端插件面板显示异常，
//! 配合 [`super::install::remove`] 的离线卸载兜底即可移除问题插件）。
//!
//! 全程最佳努力：任何失败只记日志/错误标记，不阻断启动——最终启动失败场景仍
//! 由前端 recovery 对话框（`recovery.rs`）兜底定位与卸载。

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use crate::config;
use crate::service::cli;

use super::errors;
use super::install::{build_plugin_envs, new_process_owner, run_plugin_process};
use super::installed::{installed_name, profile_dir, ProfilePackageJson};
use super::preset::{load_presets, PreinstallPluginInfo};
use super::process::is_process_cleanup_failure;

/// 判定清单引用的预装插件是否缺失产物（纯函数，便于单测）。
///
/// 命中条件：插件被 profile 清单引用（`dependencies` 键或 `dsh.profile.bundles`
/// 列表，按实际 npm 包名 `installed_name`），但其包目录在 `node_modules` 下
/// 缺少 `package.json`（目录不存在、被删、或只是残壳都不算就绪）。
pub(super) fn missing_plugin_ids(
    presets: &[PreinstallPluginInfo],
    dependencies: &HashMap<String, String>,
    bundles: &[String],
    node_modules: &Path,
) -> Vec<String> {
    presets
        .iter()
        .filter(|preset| {
            let name = installed_name(preset);
            let referenced =
                dependencies.contains_key(name) || bundles.iter().any(|bundle| bundle == name);
            if !referenced {
                return false;
            }
            !node_modules.join(name).join("package.json").is_file()
        })
        .map(|preset| preset.id.clone())
        .collect()
}

/// 给指定的缺失插件记录错误标记（前端插件面板显示异常并可卸载兜底）。
fn record_missing(app_handle: &AppHandle, ids: &[String], detail: &str) {
    for id in ids {
        if let Err(e) = errors::record(app_handle, id, "install", detail) {
            log::warn!("failed to record plugin integrity error for {id}: {e}");
        }
    }
}

/// 启动前调用：核对并修复预装插件完整性。普通失败只告警并记录错误标记，返回 Ok；
/// 仅进程清理/协调器失败会以 Err 上抛，交由调用方终止本次启动（见下文）。
pub(crate) async fn ensure_preset_plugins(app_handle: &AppHandle) -> Result<(), String> {
    let presets = load_presets(app_handle);
    if presets.is_empty() {
        return Ok(());
    }

    let profile = profile_dir(app_handle);
    // 读取清单（dependencies + bundles）；档案未初始化（无 package.json /
    // 不可解析）视为尚未安装任何插件，无需修复。
    let (dependencies, bundles) = match std::fs::read_to_string(profile.join("package.json")) {
        Ok(raw) => match serde_json::from_str::<ProfilePackageJson>(&raw) {
            Ok(manifest) => (
                manifest.dependencies,
                manifest
                    .dsh
                    .and_then(|d| d.profile)
                    .map(|p| p.bundles)
                    .unwrap_or_default(),
            ),
            Err(_) => return Ok(()),
        },
        Err(_) => return Ok(()),
    };

    let node_modules = profile.join("node_modules");
    let missing = missing_plugin_ids(&presets, &dependencies, &bundles, &node_modules);
    if missing.is_empty() {
        return Ok(());
    }
    log::warn!(
        "PRESET_PLUGIN_INTEGRITY: {} preset plugin(s) referenced by profile but missing from node_modules: {missing:?}",
        missing.len()
    );

    // 修复：在 profile 目录以现有 manifest + lockfile 为准执行 `pnpm install`，
    // 重建 node_modules 依赖图（不解析新版本）。普通修复失败不阻断启动，给缺失插件
    // 记录错误标记，让前端插件面板暴露问题、用户可走卸载兜底恢复。
    //
    // 例外是进程清理/协调器失败（`is_process_cleanup_failure`）：那说明前一进程的
    // 去向未确认，继续 spawn 新的 pnpm 会与残留进程抢同一个 store 与档案。此时必须
    // 把失败交给调用方终止启动，而不是降级成一次「最佳努力」的告警。
    if let Err(e) = repair_with_pnpm_install(app_handle, &profile).await {
        if is_process_cleanup_failure(&e) {
            return Err(e);
        }
        log::warn!("PRESET_PLUGIN_REPAIR_FAILED: {e}");
        record_missing(app_handle, &missing, &e);
        return Ok(());
    }

    // 复检：dependencies/bundles 未变（pnpm install 不写清单），只需重新探测产物。
    let still_missing = missing_plugin_ids(&presets, &dependencies, &bundles, &node_modules);
    if still_missing.is_empty() {
        log::info!("preset plugin integrity repaired via pnpm install: {missing:?}");
        return Ok(());
    }
    let detail = format!(
        "PRESET_PLUGIN_STILL_MISSING: 修复后仍缺失以下插件产物: {still_missing:?}。可尝试卸载后重新安装。"
    );
    log::warn!("{detail}");
    record_missing(app_handle, &still_missing, &detail);
    Ok(())
}

/// 在 profile 目录执行 `pnpm install` 修复 node_modules 依赖图。
///
/// 选定直接执行的 pnpm（见 [`pnpm_direct`]），环境沿用桌面端插件子进程策略
/// （`build_plugin_envs`：隔离 $DSH_HOME、PATH 前置 shim 与 node 目录、pnpm
/// 选版开关），与安装/升级/卸载同一套行为，避免意外的 store/版本不兼容。
///
/// 走 [`run_plugin_process`]（与其他装机路径同一执行器）：它持有共享进程锁直到
/// 阻塞等待结束，因此前一进程清理未确认时这里会直接拿到协调器错误，而不是绕开
/// 锁再起一个 pnpm。
async fn repair_with_pnpm_install(app_handle: &AppHandle, profile: &Path) -> Result<(), String> {
    let (program, mut args) = pnpm_direct(app_handle).await?.ok_or_else(|| {
        "PNPM_NOT_FOUND: 无捆绑 pnpm 且无用户 pnpm，无法修复插件依赖（如需可手动执行 pnpm install）"
            .to_string()
    })?;
    let bundled = config::get_pnpm_binary_path(app_handle);
    let prefer_bundled = args
        .iter()
        .any(|arg| arg.as_os_str() == bundled.as_os_str());
    args.push(OsString::from("install"));

    let window = crate::utils::operation_window(app_handle)
        .ok_or("WINDOW_NOT_FOUND: current profile window missing")?;
    let envs = build_plugin_envs(app_handle, prefer_bundled);
    log::info!(
        "repairing profile node_modules via pnpm install in {}",
        profile.display()
    );
    let (exit_code, output) = run_plugin_process(
        &program,
        &args,
        profile,
        &envs,
        &window,
        new_process_owner(),
    )
    .await?;
    if exit_code != 0 {
        // 日志只保留输出尾部，避免刷屏（pnpm 失败信息集中在末尾）。
        let tail: String = output
            .chars()
            .rev()
            .take(REPAIR_OUTPUT_LIMIT)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        return Err(format!(
            "PNPM_INSTALL_FAILED: exit code {exit_code}: {tail}"
        ));
    }
    Ok(())
}

/// 修复输出日志保留的最大字符数（pnpm 失败信息集中在输出末尾）。
const REPAIR_OUTPUT_LIMIT: usize = 4000;

/// 选定修复用的 pnpm 直接执行程序：(program, 前置参数)。
///
/// 与 [`super::install::ensure_pnpm`] 同一套 store 主版本感知策略（pnpm 10 与 11
/// 的 store 布局互不兼容，主版本不一致会 `ERR_PNPM_UNEXPECTED_STORE` 失败），
/// 但修复路径**不触发下载**（启动阶段零额外下载）：
/// - 档案 store 主版本已知 → 优先选主版本一致的 pnpm（捆绑版 → 用户版）；
/// - store 未知（全新档案/未装过依赖）→ 捆绑版优先，否则用户版；
/// - 全不匹配时仍退回捆绑版尽力一试（失败由调用方记录错误标记）。
///
/// Windows 上 `.cmd`/`.bat` 无法被 CreateProcess 直接执行（需 cmd.exe 解析），
/// 用户 pnpm 只接受 `.exe`。
pub(crate) async fn pnpm_direct(
    app_handle: &AppHandle,
) -> Result<Option<(PathBuf, Vec<OsString>)>, String> {
    use super::install::{bundled_pnpm_major, pnpm_major_version_at_bounded, profile_store_major};

    let bundled = config::get_pnpm_binary_path(app_handle);
    let bundled_ready = bundled.exists();
    let store = profile_store_major(app_handle);
    let bundled_matches =
        bundled_ready && store.is_none_or(|s| bundled_pnpm_major(app_handle) == Some(s));

    if bundled_matches {
        let node = config::get_node_binary_path(app_handle);
        return Ok(Some((node, vec![bundled.into_os_string()])));
    }

    // 用户 pnpm 主版本与 store 一致（或 store 未知）都可直接用。Windows
    // CreateProcess 不能直接执行 `.cmd`/`.bat`，因此专门查找原生 pnpm.exe。
    #[cfg(windows)]
    let user_pnpm = cli::find_user_pnpm_executable(app_handle);
    #[cfg(not(windows))]
    let user_pnpm = cli::find_user_pnpm(app_handle);
    if let Some(user) = user_pnpm {
        let matches = match store {
            None => true,
            Some(store) => {
                pnpm_major_version_at_bounded(
                    &user,
                    Some(&config::get_node_binary_path(app_handle)),
                    None,
                    super::process::new_process_owner(),
                )
                .await?
                    == Some(store)
            }
        };
        if matches {
            return Ok(Some((user, Vec::new())));
        }
    }

    // 都不匹配：退回捆绑版尽力一试（pnpm 会因 store 不兼容失败，由调用方记录）
    if bundled_ready {
        let node = config::get_node_binary_path(app_handle);
        return Ok(Some((node, vec![bundled.into_os_string()])));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn preset(id: &str, package: Option<&str>) -> PreinstallPluginInfo {
        PreinstallPluginInfo {
            id: id.into(),
            spec: String::new(),
            package: package.map(String::from),
            name: String::new(),
            description: String::new(),
            repo_url: String::new(),
            recommended: false,
            fix: false,
            default_checked: false,
            default_unchecked: false,
            version: None,
            win_only: false,
            internal: false,
        }
    }

    fn setup(dir_label: &str, present: &[&str]) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("dsh-verify-{}-{}", std::process::id(), dir_label));
        let _ = fs::remove_dir_all(&root);
        let node_modules = root.join("node_modules");
        for name in present {
            let dir = node_modules.join(name);
            fs::create_dir_all(&dir).expect("create node_modules pkg dir");
            fs::write(dir.join("package.json"), "{}").expect("write package.json");
        }
        root
    }

    #[test]
    fn missing_detects_absent_but_referenced() {
        let presets = vec![preset("dshmarket", None), preset("dsh-notification", None)];
        let deps = HashMap::from([
            ("dshmarket".to_string(), "1.0.0".to_string()),
            (
                "dsh-notification".to_string(),
                "github:omdsh-dev/dsh-notification".to_string(),
            ),
        ]);
        let bundles = vec!["dshmarket".to_string()];
        // dshmarket 在（引用且产物在）；dsh-notification 被引用但产物缺失
        let root = setup("absent", &["dshmarket"]);
        let missing = missing_plugin_ids(&presets, &deps, &bundles, &root.join("node_modules"));
        assert_eq!(missing, vec!["dsh-notification"]);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn missing_ignores_unreferenced_and_present() {
        let presets = vec![
            preset("dshmarket", None),
            preset("dsh-better-sidebar", None),
        ];
        let deps = HashMap::from([("dshmarket".to_string(), "^1.0.0".to_string())]);
        let bundles: Vec<String> = Vec::new();
        // 全部就绪：dshmarket 已装；better-sidebar 未被引用
        let root = setup("ok", &["dshmarket"]);
        let missing = missing_plugin_ids(&presets, &deps, &bundles, &root.join("node_modules"));
        assert!(missing.is_empty());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn missing_resolves_scoped_package_name() {
        // scoped 包名（installed_name 走 package 字段）对应 node_modules/@scope/name
        let presets = vec![preset(
            "dsh-session-context-menu",
            Some("@baihejiangnan/dsh-session-context-menu"),
        )];
        let deps = HashMap::from([(
            "@baihejiangnan/dsh-session-context-menu".to_string(),
            "github:baihejiangnan/dsh-session-context-menu".to_string(),
        )]);
        let bundles = vec!["@baihejiangnan/dsh-session-context-menu".to_string()];
        // 按 scoped 目录探测：存在 → 不缺失
        let root = setup("scoped", &["@baihejiangnan/dsh-session-context-menu"]);
        let missing = missing_plugin_ids(&presets, &deps, &bundles, &root.join("node_modules"));
        assert!(missing.is_empty());
        // 目录缺失 → 缺失
        let missing = missing_plugin_ids(
            &presets,
            &deps,
            &bundles,
            &root.join("missing-node_modules"),
        );
        assert_eq!(missing, vec!["dsh-session-context-menu"]);
        fs::remove_dir_all(&root).ok();
    }
}
