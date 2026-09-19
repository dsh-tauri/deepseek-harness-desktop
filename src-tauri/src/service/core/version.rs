//! 预打包核心的多版本管理：列出、切换、下载历史版本、卸载。
//!
//! 磁盘布局：激活版本固定为 `dependencies/dsh`（既有代码全部依赖该路径），
//! 历史版本存放在 `dependencies/<tag>` 槽位，切换/卸载依赖既有版本行。本地
//! 核心的探测见 [`super::local`]，来源判定与活动入口见 [`super::source`]。

use crate::config;
use crate::service::{download, fs_guard, workflow};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use super::local::{find_user_dsh_bin, local_core};
use super::source::{active_source, core_supports_bundled_plugins, CoreSource, HarnessCore};

/// `dependencies` 目录（激活 `dsh` 与历史 `dsh-<tag>` 槽位的共同父级）。
fn dependencies_dir(app_handle: &AppHandle) -> PathBuf {
    config::get_dsh_install_path(app_handle)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// 历史版本槽位（新命名）：`dependencies/<tag>`。release tag 本身以 `dsh-` 开头
/// （如 `dsh-0.1.0-rc.8-32331963388`），因此槽位目录名即 tag，不再叠加前缀。
fn slot_dir(app_handle: &AppHandle, tag: &str) -> PathBuf {
    dependencies_dir(app_handle).join(tag)
}

/// 定位已下载的槽位：优先新命名 `dependencies/<tag>`，兼容旧版遗留的双前缀
/// `dependencies/dsh-<tag>`（tag 以 `dsh-` 开头时旧命名会产生 `dsh-dsh-...`）。
fn existing_slot_dir(app_handle: &AppHandle, tag: &str) -> Option<PathBuf> {
    let deps = dependencies_dir(app_handle);
    let new = safe_slot_path(&deps, tag).ok()?;
    if new.is_dir() {
        return Some(new);
    }
    let legacy = safe_slot_path(&deps, &format!("dsh-{tag}")).ok()?;
    legacy.is_dir().then_some(legacy)
}

/// 构造槽位路径，并拒绝越出 dependencies 根目录的既有路径或符号链接。
fn safe_slot_path(deps: &Path, tag: &str) -> Result<PathBuf, String> {
    fs_guard::validate_id(tag)?;
    let path = deps.join(tag);
    if path.exists() {
        fs_guard::ensure_within(&path, deps)?;
    }
    Ok(path)
}

/// 读取发行版目录 `package.json` 中 `@deepseek-ai/dsh` 依赖版本（历史槽位展示用）。
fn read_manifest_dsh_version(dir: &Path) -> Option<String> {
    let content = std::fs::read_to_string(dir.join("package.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&content).ok()?;
    v.get("dependencies")?
        .get("@deepseek-ai/dsh")?
        .as_str()
        .map(|s| s.trim_start_matches(['^', '~', '=', '>', '<']).to_string())
}

/// 核心列表：本地核心 + deepseek-harness-pkg 各发布版本（按版本去重）。
///
/// 版本行数据源为 GitHub releases（`fetch_dsh_pkg_releases`，最新在前，含
/// Pre-release label）：预览版（label 或 tag 命名，见 `download::is_preview_tag`）
/// 照常列出供手动下载安装，仅带「预览版」标记、不参与更新提示。pkg 仓库会对
/// 同一版本打多个 tag（含测试打包），这里按版本去重——同一版本只保留**最后一个**
/// tag，预览标记以保留的 tag 为准。releases 拉取失败（离线/限流）时回退 git
/// tags（无 label，预览标记按 tag 命名兜底），再失败降级为磁盘扫描，只列出
/// 本地、激活与已下载的历史版本。
pub async fn list(app_handle: &AppHandle) -> Vec<HarnessCore> {
    let source = active_source(app_handle);
    let local = local_core(app_handle);
    let local_bin = local
        .as_ref()
        .map(|c| c.bin.to_string_lossy().into_owned())
        .or_else(|| find_user_dsh_bin(app_handle).map(|b| b.to_string_lossy().into_owned()));

    let mut rows: Vec<HarnessCore> = vec![HarnessCore {
        id: "local".to_string(),
        source: CoreSource::Local,
        version: local
            .as_ref()
            .map(|c| c.version.clone())
            .unwrap_or_default(),
        tag: String::new(),
        path: local_bin.clone().unwrap_or_default(),
        dir: local
            .as_ref()
            .map(|c| c.package_dir.to_string_lossy().into_owned())
            .unwrap_or_default(),
        present: local.is_some(),
        active: source == CoreSource::Local,
        preview: false,
        above_recommended: local
            .as_ref()
            .is_some_and(|c| config::is_dsh_version_above_recommended(app_handle, &c.version)),
        orphaned: false,
        bundled: false,
        recommended_version: config::recommended_dsh_version(app_handle),
        error: None,
    }];

    // 激活的预打包信息：tag（可空，旧安装无记录）+ 安装目录状态
    let active_tag = config::get_dsh_pkg_tag(app_handle);
    let active_dir = config::get_dsh_install_path(app_handle);
    let active_present = config::get_dsh_binary_path(app_handle).exists();
    // 激活核心按「版本」而非 tag 匹配版本行：pkg 仓库会对同一版本重打包/打
    // 测试 tag，版本行去重后保留的 tag 未必等于本机安装时的记录 tag。按 tag
    // 精确匹配会让激活版本行误标「未下载」并在列表底部多出一条重复激活行。
    let active_version = if source == CoreSource::App {
        active_app_version(&active_tag, config::get_dsh_version(app_handle))
    } else {
        None
    };
    // 已安装的预打包版本号（无论当前以哪种来源运行都存在）：用于保证预打包行
    // 始终如实呈现为"已安装"，即便本次以本地核心运行，也不会把它标成"未下载"。
    // 旧记录可能没有版本号，稍后从激活目录 package.json 兜底读取。
    let installed_version = config::get_dsh_version(app_handle).or_else(|| {
        (source == CoreSource::App && active_present)
            .then(|| read_manifest_dsh_version(&active_dir))
            .flatten()
    });

    // 版本行：GitHub releases（最新在前，含 Pre-release label）→ 按版本去重，
    // 同版本只保留最后一个 tag。releases 拉取失败（离线/限流）时回退 git tags，
    // 预览标记按 tag 命名兜底（见 `download::is_preview_tag`）。
    let (release_metas, remote_catalog_available) = match download::fetch_dsh_pkg_releases().await {
        Ok(metas) => (metas, true),
        Err(e) => {
            log::warn!(
                "Failed to fetch dsh pkg releases ({}), falling back to git tags",
                e
            );
            match download::fetch_dsh_pkg_tags().await {
                Ok(tags) => (
                    tags.into_iter()
                        .map(|(tag, _)| download::DshPkgReleaseMeta {
                            tag,
                            prerelease: false,
                        })
                        .collect(),
                    true,
                ),
                Err(e) => {
                    log::warn!("Failed to fetch dsh pkg tags: {}", e);
                    (Vec::new(), false)
                }
            }
        }
    };
    let mut version_tags: Vec<(String, String, bool)> = Vec::new(); // (version, tag, preview)，保持首次出现顺序
    for meta in &release_metas {
        let Some(version) = download::parse_version_from_tag(&meta.tag) else {
            continue;
        };
        // 预览标记：GitHub Pre-release label 优先，tag 命名兜底（漏标 label 的
        // 预览版也按命名识别）
        let preview = meta.prerelease || download::is_preview_tag(&meta.tag);
        if let Some(entry) = version_tags.iter_mut().find(|(v, _, _)| v == &version) {
            // 同版本重复（测试打包）：保留最后一个 tag，预览标记以保留的 tag 为准
            entry.1 = meta.tag.clone();
            entry.2 = preview;
        } else {
            version_tags.push((version, meta.tag.clone(), preview));
        }
    }

    // 按 SemVer 从新到旧排列；预发布版本也按主版本和预发布标识参与排序。
    // 例如 0.1.2-alpha.1 应排在 0.1.1-rc.2 之前。
    version_tags.sort_by(|(a, _, _), (b, _, _)| {
        match (semver::Version::parse(a), semver::Version::parse(b)) {
            (Ok(a), Ok(b)) => b.cmp(&a),
            _ => b.cmp(a),
        }
    });

    // 激活行就地标记：按版本匹配激活核心（不置顶，作为普通版本行标 active）
    let mut active_rendered = false;
    for (version, tag, preview) in &version_tags {
        let is_active = active_version.as_deref() == Some(version.as_str());
        // 已安装的预打包核心：即使本次以本地核心运行（source=Local）也要如实标为
        // "已安装"，避免本地核心出现后预打包被当作未下载/消失（issue #54）。
        let is_installed = installed_version.as_deref() == Some(version.as_str());
        if is_active || is_installed {
            active_rendered = true;
        }
        let slot = existing_slot_dir(app_handle, tag);
        let present = if is_active || is_installed {
            active_present
        } else {
            slot.is_some()
        };
        let (path, dir) = if is_active || is_installed {
            let s = active_dir.to_string_lossy().into_owned();
            (s.clone(), s)
        } else if let Some(slot) = slot {
            let s = slot.to_string_lossy().into_owned();
            (s.clone(), s)
        } else {
            (String::new(), String::new())
        };
        rows.push(HarnessCore {
            id: format!("app-{tag}"),
            source: CoreSource::App,
            version: version.clone(),
            tag: tag.clone(),
            path,
            dir,
            present,
            active: is_active,
            preview: *preview,
            above_recommended: config::is_dsh_version_above_recommended(app_handle, version),
            orphaned: false,
            bundled: false,
            recommended_version: config::recommended_dsh_version(app_handle),
            error: None,
        });
    }

    // 已安装的预打包版本未出现在版本列表（离线/限流/tag 被移除/旧版无 tag 记录）：
    // 纳入版本行之后，保持列表不置顶；无论当前是否以本地核心运行都要列出，
    // 避免"本地核心出现后预打包消失"。
    if !active_rendered && active_present {
        rows.push(HarnessCore {
            id: active_tag
                .as_ref()
                .map(|t| format!("app-{t}"))
                .unwrap_or_else(|| "app".to_string()),
            source: CoreSource::App,
            version: installed_version.clone().unwrap_or_default(),
            tag: active_tag.clone().unwrap_or_default(),
            path: active_dir.to_string_lossy().into_owned(),
            dir: active_dir.to_string_lossy().into_owned(),
            present: true,
            active: source == CoreSource::App,
            orphaned: false,
            // 无远程元数据（离线/限流）：预览标记按 tag 命名兜底
            preview: active_tag.as_deref().is_some_and(download::is_preview_tag),
            above_recommended: installed_version
                .as_deref()
                .is_some_and(|v| config::is_dsh_version_above_recommended(app_handle, v)),
            bundled: false,
            recommended_version: config::recommended_dsh_version(app_handle),
            error: None,
        });
    }

    // 磁盘扫描：tags 拉取失败/限流，或存在已下载但不在 tags 列表的版本（被移除的
    // 测试打包）时，把已下载的 `dsh-*` 槽位补进列表；同样按版本去重。
    // 激活版本已由版本行（或底部激活行）呈现，先放入 seen 避免扫描再补一条重复行。
    let mut seen_versions: HashSet<String> =
        version_tags.iter().map(|(v, _, _)| v.clone()).collect();
    let known_tags: HashSet<String> = version_tags.iter().map(|(_, tag, _)| tag.clone()).collect();
    let mut seen_tags = known_tags.clone();
    if let Some(v) = &active_version {
        seen_versions.insert(v.clone());
    }
    if let Some(v) = &installed_version {
        seen_versions.insert(v.clone());
    }
    if let Ok(entries) = std::fs::read_dir(dependencies_dir(app_handle)) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            // 新命名槽位目录名即 tag（`dsh-0.1.0-rc.8-...`）；旧版双前缀
            // `dsh-dsh-...` 剥一层 `dsh-` 还原 tag。`dsh` 为激活目录，跳过。
            let tag = if let Some(rest) = name.strip_prefix("dsh-dsh-") {
                Some(format!("dsh-{rest}"))
            } else if name.starts_with("dsh-") || name.starts_with("src-") {
                Some(name.clone())
            } else {
                None
            };
            let Some(tag) = tag else { continue };
            if !entry.path().is_dir() {
                continue;
            }
            let version = read_manifest_dsh_version(&entry.path())
                .or_else(|| download::parse_version_from_tag(&tag))
                .unwrap_or_default();
            if version.is_empty() || !seen_tags.insert(tag.clone()) {
                continue;
            }
            let orphaned = remote_catalog_available && !known_tags.contains(&tag);
            if !orphaned && !seen_versions.insert(version.clone()) {
                continue;
            }
            let dir = entry.path();
            rows.push(HarnessCore {
                id: format!("app-{tag}"),
                source: CoreSource::App,
                version: version.clone(),
                tag: tag.clone(),
                path: dir.to_string_lossy().into_owned(),
                dir: dir.to_string_lossy().into_owned(),
                present: true,
                active: false,
                // 无远程元数据（离线/限流）：预览标记按 tag 命名兜底
                preview: download::is_preview_tag(&tag),
                above_recommended: config::is_dsh_version_above_recommended(app_handle, &version),
                orphaned,
                bundled: false,
                recommended_version: config::recommended_dsh_version(app_handle),
                error: None,
            });
        }
    }

    // 「内置核心」按**落位身份**标注，而不是比较版本号：用户完全可能另外下载一个与
    // 内置核心同版本的槽位，那是他自己的副本，不该被标成内置核心、更不该禁止卸载。
    for row in rows.iter_mut() {
        row.bundled = !row.dir.is_empty()
            && crate::service::bundle::is_bundled_dir(app_handle, Path::new(&row.dir));
    }

    rows
}

/// 已装核心列表中是否包含给定 semver 版本（含 active 和非 active 槽位）。
///
/// `check_dsh_update` 用它跳过「最新版本的核心已下载但未激活」场景的 toast：
/// 只要最新 release 的 semver 已存在于某个已装槽位就不提示，避免用户白点
/// 一次「立即更新」做无意义的整包重下。版本号按字符串相等比较（dsh 的版本
/// 字符串已是 semver，build-id 不参与版本号识别——同 semver 的不同 build-id
/// 在用户视角下都算「同版本」）。
pub async fn has_installed_version(app_handle: &AppHandle, version: &str) -> bool {
    // 双路径：「激活版本」快速匹配 + 「磁盘扫描」确认非激活槽位也包含此版本。
    // 仅靠 `list().present` 不够：若 version_tags 里有某版本、磁盘上没有对应
    // 槽位，`present` 会是 false，但实际激活的核心可能就是那个版本（`installed_version`
    // 读自激活槽位的 `package.json`，与 version_tags 不同步时尤为常见）。
    if config::get_dsh_version(app_handle).as_deref() == Some(version) {
        return true;
    }
    list(app_handle)
        .await
        .into_iter()
        .any(|c| c.present && c.version == version)
}

/// 停止并清扫旧核心进程，确保核心来源变更时不会继续使用旧入口。
async fn stop_harness_for_core_switch(app_handle: &AppHandle) -> Result<(), String> {
    if workflow::has_owned_process() {
        workflow::stop(app_handle.clone()).await?;
    }
    let handle = app_handle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        workflow::terminate_stale_harness_processes(&handle);
    })
    .await
    .map_err(|e| format!("CORE_SWITCH_STOP_FAILED: {e}"))?;
    Ok(())
}

/// 切换活动核心（持久化 + 预打包版本目录互换；服务重启由前端负责）。
///
/// `id` 取值：`local` | `app`（无 tag 记录的旧激活行）| `app-<tag>`。
pub async fn set_active(app_handle: &AppHandle, id: &str) -> Result<HarnessCore, String> {
    let transition_guard = if id == "app" || id == "local" {
        Some(workflow::acquire_core_transition().await?)
    } else {
        None
    };
    if id == "local" {
        let Some(core) = local_core(app_handle) else {
            return Err("CORE_LOCAL_NOT_FOUND: no local core detected".to_string());
        };
        // 低于内置插件基线的本地核心无法加载随包插件（issue #596）：显式切换同样
        // 拒绝并给出可操作提示，而不是让用户切过去再撞一次启动失败。
        if !core_supports_bundled_plugins(app_handle, &core.version) {
            return Err(format!(
                "CORE_LOCAL_UNSUPPORTED: local dsh {} is below the bundled-plugin baseline {}; update it (`npm install -g @deepseek-ai/dsh@latest`) or keep a bundled version",
                core.version,
                config::recommended_dsh_version(app_handle).unwrap_or_default(),
            ));
        }
        stop_harness_for_core_switch(app_handle).await?;
        let mut setting = config::get_store_dat_setting(app_handle);
        setting.active_core = Some(CoreSource::Local.as_str().to_string());
        config::set_store_dat_setting(app_handle, setting);
    } else if id == "app" {
        if !config::get_dsh_binary_path(app_handle).exists() {
            return Err("CORE_APP_NOT_FOUND: bundled core is not installed".to_string());
        }
        stop_harness_for_core_switch(app_handle).await?;
        let mut setting = config::get_store_dat_setting(app_handle);
        setting.active_core = Some(CoreSource::App.as_str().to_string());
        config::set_store_dat_setting(app_handle, setting);
    } else if let Some(tag) = id.strip_prefix("app-") {
        switch_app_version(app_handle, tag).await?;
    } else {
        return Err(format!("CORE_INVALID_ID: {id}"));
    }
    // 查询核心列表可能联网；不要让慢查询继续占用切换锁，重启流程会在
    // set_active 返回后通过同一把锁与启动串行化。
    drop(transition_guard);

    Ok(list(app_handle)
        .await
        .into_iter()
        .find(|c| c.active)
        .ok_or_else(|| "CORE_NOT_FOUND: active core disappeared after switch".to_string())?)
}

/// 切换到指定 tag 的预打包版本（已下载的历史槽位）。
///
/// 磁盘布局：激活版本固定为 `dependencies/dsh`（既有代码全部依赖该路径），
/// 已下载的历史版本存放在 `dependencies/<tag>`（tag 以 `dsh-` 开头）。切换 = 目录
/// 互换：先把当前激活目录改名为自己的 tag 槽位（清理残留同名槽位），再把目标槽位
/// 改名为激活目录；任一步失败回滚。切换前先停服务并清扫残留进程，避免目录被进程
/// 句柄锁定（Windows DLL 锁）；切换期间持有与 `launch` 共用的转换锁，阻止并发
/// `launch` 或另一个切换在互换窗口内插入并锁死目录（CORE_SWITCH_FAILED, os error 32）。
async fn switch_app_version(app_handle: &AppHandle, tag: &str) -> Result<(), String> {
    // 从切换开始到目录互换完成持续持有与 launch 共用的转换锁，避免两个切换
    // 重叠，也避免 launch 在状态检查后插入并从旧的 dependencies/dsh 加载 DLL。
    let _transition_guard = workflow::acquire_core_transition().await?;
    let deps = dependencies_dir(app_handle);
    let active_dir = config::get_dsh_install_path(app_handle);
    fs_guard::validate_id(tag)?;
    let target_dir = existing_slot_dir(app_handle, tag)
        .ok_or_else(|| format!("CORE_VERSION_NOT_DOWNLOADED: {tag}"))?;
    let cur_tag = config::get_dsh_pkg_tag(app_handle);

    // 激活目录已是目标版本（tag 相同）→ 仅切来源标记（如 local → app 同版本）
    if cur_tag.as_deref() == Some(tag) {
        let mut setting = config::get_store_dat_setting(app_handle);
        setting.active_core = Some(CoreSource::App.as_str().to_string());
        config::set_store_dat_setting(app_handle, setting);
        return Ok(());
    }

    // 切换前停止运行中的服务，避免目录被进程句柄锁定
    if workflow::has_owned_process() {
        workflow::stop(app_handle.clone()).await.map_err(|e| {
            format!(
                "CORE_SWITCH_STOP_FAILED: failed to stop harness before core switch at {}: {e}",
                active_dir.display()
            )
        })?;
    }
    // 只停本应用持有的进程还不够：崩溃/强杀残留的孤儿 Harness 实例（不在
    // .harness.pid 标记中）同样从 dependencies/dsh 启动、占用目录文件句柄，
    // 会导致切换重命名失败（os error 32）。与安装流程一致，按命令行路径精确
    // 清扫所有本应用 dsh 安装目录启动的进程。枚举/结束涉及 powershell 枚举与
    // taskkill（同步阻塞），移出 Tokio 线程。
    {
        let handle = app_handle.clone();
        tauri::async_runtime::spawn_blocking(move || {
            workflow::terminate_stale_harness_processes(&handle);
        })
        .await
        .map_err(|e| format!("CORE_SWITCH_STOP_FAILED: {e}"))?;
    }

    // 1. 当前激活目录让出激活位：改名为自己的 tag 槽位（残留槽位先清理）
    let backup_tag = cur_tag.clone().unwrap_or_else(|| {
        // 无 tag 记录（旧版安装）：用版本号兜底命名槽位
        format!(
            "dsh-{}",
            config::get_dsh_version(app_handle).unwrap_or_else(|| "unknown".to_string())
        )
    });
    let backup_dir = safe_slot_path(&deps, &backup_tag)?;
    if active_dir.exists() {
        if backup_dir.exists() && !download::remove_dir_with_retry(&backup_dir).await {
            return Err(format!(
                "CORE_SWITCH_FAILED: cannot clean old backup {}",
                backup_dir.display()
            ));
        }
        download::rename_with_retry(&active_dir, &backup_dir)
            .await
            .map_err(|e| {
                format!(
                    "CORE_SWITCH_FAILED: {} -> {}: {e}",
                    active_dir.display(),
                    backup_dir.display()
                )
            })?;
    }

    // 2. 目标版本进入激活位；失败回滚
    if let Err(e) = download::rename_with_retry(&target_dir, &active_dir).await {
        let _ = download::rename_with_retry(&backup_dir, &active_dir).await;
        return Err(format!(
            "CORE_SWITCH_FAILED: {} -> {}: {e}",
            target_dir.display(),
            active_dir.display()
        ));
    }

    // 3. 记录切换：tag + commit（commit 从 tags 列表反查，失败保留原值）
    let commit = match download::fetch_dsh_pkg_tags().await {
        Ok(tags) => tags.into_iter().find(|(t, _)| t == tag).map(|(_, c)| c),
        Err(e) => {
            log::warn!("failed to resolve commit for tag {tag}: {e}");
            None
        }
    };
    let mut setting = config::get_store_dat_setting(app_handle);
    setting.active_core = Some(CoreSource::App.as_str().to_string());
    setting.dsh_pkg_tag = Some(tag.to_string());
    if let Some(c) = commit {
        setting.dsh_pkg_commit = Some(c);
    }
    config::set_store_dat_setting(app_handle, setting);
    Ok(())
}

/// 下载指定 tag 的预打包核心到历史槽位 `dependencies/<tag>`（不激活，切换由
/// `set_active` 完成）。幂等：已下载时直接返回该版本行。
pub async fn download_version(app_handle: &AppHandle, tag: &str) -> Result<HarnessCore, String> {
    // 路径安全：tag 直接进入 `dependencies/<tag>` 槽位路径，需挡 `..`/分隔符
    fs_guard::validate_id(tag)?;
    let dest = slot_dir(app_handle, tag);
    if dest.exists() {
        return Ok(row_for_tag(app_handle, tag, &dest));
    }

    // 1. 拉该 tag 的资产地址 + 可信摘要（digest 缺失时安全中止，沿用
    //    DSH_INTEGRITY_UNAVAILABLE 设计：不下载无法验证完整性的内容）
    let info = download::fetch_dsh_pkg_asset(tag)
        .await
        .map_err(|e| format!("CORE_METADATA_FAILED: {e}"))?;
    let digest = info.digest.ok_or_else(|| {
        format!("CORE_INTEGRITY_UNAVAILABLE: trusted SHA-256 unavailable for {tag}, cannot download safely")
    })?;

    // 2. 下载 + 校验 + 原子解压到历史槽位（两阶段进度：下载 0-50，解压 50-100）
    //    下载默认走 GitHub 官方直连，失败自动切换 ghfast.top 镜像兜底。
    let window = app_handle
        .get_webview_window("main")
        .ok_or("WINDOW_NOT_FOUND: main window missing")?;
    let mut tracker = download::ProgressTracker::new(&window, 2);
    tracker.start_phase("download", &format!("正在下载核心版本 {tag}"));
    let urls = vec![
        info.asset_url.clone(),
        config::mirror_download_url(&info.asset_url),
    ];
    let buffer = download::download_file_from_sources(&tracker, urls)
        .await
        .map_err(|e| format!("CORE_DOWNLOAD_FAILED: {e}"))?;
    download::verify_sha256(&buffer, &digest).map_err(|e| format!("CORE_INTEGRITY_FAILED: {e}"))?;
    tracker.end_phase();
    let name = info
        .asset_url
        .rsplit('/')
        .next()
        .unwrap_or(&info.asset_url)
        .to_string();
    tracker.start_phase("extract", &format!("正在解压核心版本 {tag}"));
    download::ensure_extract(&tracker, name, buffer, dest.clone())
        .await
        .map_err(|e| format!("CORE_EXTRACT_FAILED: {e}"))?;
    tracker.end_phase();
    log::info!("Downloaded dsh core {tag} to {}", dest.display());

    Ok(row_for_tag(app_handle, tag, &dest))
}

/// 卸载已下载的历史版本（激活中的版本不可卸载）。
pub async fn remove_version(app_handle: &AppHandle, id: &str) -> Result<(), String> {
    let Some(tag) = id.strip_prefix("app-") else {
        return Err(format!("CORE_INVALID_ID: {id}"));
    };
    // 路径安全：tag 需通过字符集白名单（tag 形如 `dsh-0.1.0-rc.8-<commit>`），
    // 拒绝 `..`、分隔符等，防止 `remove_core("app-..")` 把目标推出依赖根目录。
    fs_guard::validate_id(tag)?;
    let cur_tag = config::get_dsh_pkg_tag(app_handle);
    if cur_tag.as_deref() == Some(tag) && active_source(app_handle) == CoreSource::App {
        return Err(format!(
            "CORE_ACTIVE_VERSION: cannot remove in-use version {tag}"
        ));
    }
    let dir = existing_slot_dir(app_handle, tag)
        .ok_or_else(|| format!("CORE_VERSION_NOT_FOUND: {tag}"))?;

    // 离线安装包的内置核心不允许卸载：它是随包分发的兜底内核，删掉后内网/离线
    // 环境将再无可用核心（重装应用才能恢复）。核心面板同样不渲染卸载入口。
    //
    // 按落位身份判定而不是版本号：用户另外下载的同版本槽位是他自己的副本，可以卸载。
    if crate::service::bundle::is_bundled_dir(app_handle, &dir) {
        let version = read_manifest_dsh_version(&dir)
            .or_else(|| download::parse_version_from_tag(tag))
            .unwrap_or_default();
        return Err(format!(
            "CORE_BUNDLED_PROTECTED: bundled core {version} cannot be removed"
        ));
    }

    // 停止服务避免句柄锁定（被删目录可能是上一份激活副本，句柄未释放）
    if workflow::has_owned_process() {
        if let Err(e) = workflow::stop(app_handle.clone()).await {
            log::warn!("failed to stop harness before core removal: {e}");
        }
    }
    if !download::remove_dir_with_retry(&dir).await {
        return Err(format!(
            "CORE_REMOVE_FAILED: cannot remove {}",
            dir.display()
        ));
    }
    Ok(())
}

/// 解析激活预打包核心的版本号：优先记录 tag（`dsh-<version>-<commit>`），
/// 解析不出（无 tag 记录/格式不符）时用安装目录清单版本兜底。
fn active_app_version(
    active_tag: &Option<String>,
    manifest_version: Option<String>,
) -> Option<String> {
    active_tag
        .as_deref()
        .and_then(download::parse_version_from_tag)
        .or(manifest_version)
}

/// 构造某个已下载 tag 的核心行（下载完成/已存在时返回）。
fn row_for_tag(app_handle: &AppHandle, tag: &str, dir: &Path) -> HarnessCore {
    let active = config::get_dsh_pkg_tag(app_handle).as_deref() == Some(tag)
        && active_source(app_handle) == CoreSource::App;
    let version = download::parse_version_from_tag(tag).unwrap_or_default();
    let dir_str = dir.to_string_lossy().into_owned();
    HarnessCore {
        id: format!("app-{tag}"),
        source: CoreSource::App,
        bundled: crate::service::bundle::is_bundled_dir(app_handle, dir),
        version,
        tag: tag.to_string(),
        path: dir_str.clone(),
        dir: dir_str,
        present: true,
        active,
        preview: download::is_preview_tag(tag),
        above_recommended: download::parse_version_from_tag(tag)
            .is_some_and(|version| config::is_dsh_version_above_recommended(app_handle, &version)),
        orphaned: false,
        recommended_version: config::recommended_dsh_version(app_handle),
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slot_paths_reject_traversal_and_accept_release_tag() {
        let root = std::env::temp_dir().join(format!("dsh-core-slots-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();

        assert!(safe_slot_path(&root, "foo/../../target").is_err());
        let valid = "dsh-0.1.0-rc.8-32331963388";
        let expected = root.join(valid);
        assert_eq!(safe_slot_path(&root, valid).unwrap(), expected);

        std::fs::create_dir_all(&expected).unwrap();
        assert_eq!(safe_slot_path(&root, valid).unwrap(), expected);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn slot_paths_reject_symlink_escape() {
        let root = std::env::temp_dir().join(format!("dsh-core-slots-link-{}", std::process::id()));
        let outside =
            std::env::temp_dir().join(format!("dsh-core-slots-outside-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("dsh-evil")).unwrap();

        assert!(safe_slot_path(&root, "dsh-evil").is_err());
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[test]
    fn list_dedupes_versions_keeping_last_tag() {
        // 模拟 pkg 仓库的测试打包：同一版本打多个 tag（最新在前），去重后每个版本
        // 只保留最后一个 tag，且顺序保持首次出现顺序（版本新→旧）。预览标记
        // （Pre-release label 或 tag 命名）以保留的 tag 为准：同版本先去重、再取
        // 保留 tag 自己的标记。
        let metas = vec![
            // 最新：预览版（label + 命名一致）
            ("dsh-0.2.0-preview.1-32490000001".to_string(), true),
            ("dsh-0.1.1-rc.1-32342588166".to_string(), false),
            ("dsh-0.1.0-rc.8-32331963388".to_string(), false),
            // 同版本重复（测试打包）：后到的是预览 label，但再后到的是普通 release
            ("dsh-0.1.0-rc.8-32342588166".to_string(), true),
            ("dsh-0.1.0-rc.8-32342588167".to_string(), false),
            ("dsh-0.1.0-rc.7-31773193667".to_string(), false),
            ("dsh-0.1.0-rc.7-31773193668".to_string(), false),
            // 漏标 Pre-release label 的预览版：按 tag 命名兜底识别
            ("dsh-0.1.0-beta.1-32490000002".to_string(), false),
        ];
        let mut version_tags: Vec<(String, String, bool)> = Vec::new();
        for meta in &metas {
            let Some(version) = download::parse_version_from_tag(&meta.0) else {
                continue;
            };
            let preview = meta.1 || download::is_preview_tag(&meta.0);
            if let Some(entry) = version_tags.iter_mut().find(|(v, _, _)| v == &version) {
                entry.1 = meta.0.clone();
                entry.2 = preview;
            } else {
                version_tags.push((version, meta.0.clone(), preview));
            }
        }
        let versions: Vec<&str> = version_tags.iter().map(|(v, _, _)| v.as_str()).collect();
        let kept_tags: Vec<&str> = version_tags.iter().map(|(_, t, _)| t.as_str()).collect();
        let previews: Vec<bool> = version_tags.iter().map(|(_, _, p)| *p).collect();
        assert_eq!(
            versions,
            vec![
                "0.2.0-preview.1",
                "0.1.1-rc.1",
                "0.1.0-rc.8",
                "0.1.0-rc.7",
                "0.1.0-beta.1"
            ]
        );
        // rc.8 / rc.7 都保留了最后一个 tag
        assert_eq!(kept_tags[2], "dsh-0.1.0-rc.8-32342588167");
        assert_eq!(kept_tags[3], "dsh-0.1.0-rc.7-31773193668");
        // 预览标记以保留的 tag 为准：rc.8 最终保留普通 release → 非预览；
        // 预览版（label 或命名）→ 预览
        assert_eq!(previews, vec![true, false, false, false, true]);
    }
}
