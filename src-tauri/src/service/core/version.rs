//! 预打包核心的多版本管理：列出、切换、下载历史版本、卸载。
//!
//! 磁盘布局：激活版本固定为 `dependencies/dsh`（既有代码全部依赖该路径），
//! 历史版本存放在 `dependencies/<tag>` 槽位，切换/卸载依赖既有版本行。本地
//! 核心的探测见 [`super::local`]，来源判定与活动入口见 [`super::source`]。
//!
//! 随包资源构建（离线包）不适用上面的目录互换：随包内核必须留在安装目录里
//! （`$Resources/dsh`，见 [`config::dependencies::bundled_core_dir`]），它在面板里
//! 作为固定置顶的「本地」行存在，切换只是把 `dsh` 依赖根指向目标槽位或指回随包内核。

use crate::config;
use crate::service::{download, fs_guard, workflow};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use super::local::{find_user_dsh_bin, local_core};
use super::source::{
    active_is_bundled, active_source, core_supports_bundled_plugins, CoreSource, HarnessCore,
};

/// 随包内核的行 id：面板据此置顶并标记「本地」，[`set_active`] 据此切回随包内核。
const BUNDLED_CORE_ID: &str = "app-bundled";

/// `dependencies` 目录（下载的核心槽位与普通安装的 `dsh` 激活目录的共同父级）。
///
/// 恒落在应用数据目录之下：槽位是桌面端自己下载的产物，即使清单把激活核心托管到安装
/// 包资源（离线包 `$Resources/dsh`）也不能让下载产物写进安装目录——那里在 macOS `.app`
/// 上是签名的只读内容、在 Linux deb 里属于 root，且会随应用升级被覆盖。
fn dependencies_dir(app_handle: &AppHandle) -> PathBuf {
    config::get_base_dir(app_handle).join("dependencies")
}

/// 历史版本槽位：`dependencies/<tag>`。release tag 本身以 `dsh-` 开头
/// （如 `dsh-0.1.0-rc.8-32331963388`），因此槽位目录名即 tag，不再叠加前缀。
fn slot_dir(app_handle: &AppHandle, tag: &str) -> PathBuf {
    dependencies_dir(app_handle).join(tag)
}

/// 定位已下载的槽位：`dependencies/<tag>` 存在时返回该目录。
fn existing_slot_dir(app_handle: &AppHandle, tag: &str) -> Option<PathBuf> {
    let deps = dependencies_dir(app_handle);
    let slot = safe_slot_path(&deps, tag).ok()?;
    slot.is_dir().then_some(slot)
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
    let (release_metas, remote_catalog_available) = fetch_release_catalog(app_handle).await;
    rows_with_release_catalog(app_handle, release_metas, remote_catalog_available)
}

/// 版本行数据源：GitHub releases → git tags → 空（离线/限流时调用方降级为磁盘扫描）。
async fn fetch_release_catalog(app_handle: &AppHandle) -> (Vec<download::DshPkgReleaseMeta>, bool) {
    match download::fetch_dsh_pkg_releases(app_handle).await {
        Ok(metas) => (metas, true),
        Err(e) => {
            log::warn!(
                "Failed to fetch dsh pkg releases ({}), falling back to git tags",
                e
            );
            match download::fetch_dsh_pkg_tags(app_handle).await {
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
    }
}

/// 只用本地信息（激活记录 + 磁盘槽位）构造核心列表，不联网。
///
/// 核心切换是纯本地操作，回包不该等一轮 GitHub 往返（`fetch_dsh_pkg_releases`
/// 数秒级，离线更久）；切换后的「新激活行」与离线列表都走这条路。
fn list_local(app_handle: &AppHandle) -> Vec<HarnessCore> {
    rows_with_release_catalog(app_handle, Vec::new(), false)
}

/// 按给定版本行数据源构造核心列表（`release_metas` 为空即离线/本地视图）。
fn rows_with_release_catalog(
    app_handle: &AppHandle,
    release_metas: Vec<download::DshPkgReleaseMeta>,
    remote_catalog_available: bool,
) -> Vec<HarnessCore> {
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
        removable: false,
        preview: false,
        above_recommended: local
            .as_ref()
            .is_some_and(|c| config::is_dsh_version_above_recommended(app_handle, &c.version)),
        orphaned: false,
        bundled: false,
        recommended_version: config::recommended_dsh_version(app_handle),
        error: None,
    }];

    // 随包资源构建（离线包）：随包内核独立成一行并置顶（`app-bundled`），用户仍可下载
    // 其它版本（槽位在 AppData）并切换，也可以切回它。
    let bundled_dir = config::dependencies::bundled_core_dir(app_handle);
    let bundled_active = active_is_bundled(app_handle);
    if let Some(dir) = &bundled_dir {
        let version = read_manifest_dsh_version(dir).unwrap_or_default();
        let dir_str = dir.to_string_lossy().into_owned();
        rows.insert(
            0,
            HarnessCore {
                id: BUNDLED_CORE_ID.to_string(),
                source: CoreSource::App,
                above_recommended: config::is_dsh_version_above_recommended(app_handle, &version),
                version,
                tag: String::new(),
                path: dir_str.clone(),
                dir: dir_str,
                present: dir.join(config::dependencies::entry_relative(app_handle, config::dependencies::DEP_DSH)).is_file(),
                active: bundled_active,
                removable: false,
                preview: false,
                orphaned: false,
                bundled: true,
                recommended_version: config::recommended_dsh_version(app_handle),
                error: None,
            },
        );
    }

    // 激活的预打包信息：tag（可空，旧安装无记录）+ 安装目录状态
    let active_tag = config::get_dsh_pkg_tag(app_handle);
    let active_dir = config::get_dsh_install_path(app_handle);
    let active_present = config::get_dsh_binary_path(app_handle).exists();
    // 激活核心按「版本」而非 tag 匹配版本行：pkg 仓库会对同一版本重打包/打
    // 测试 tag，版本行去重后保留的 tag 未必等于本机安装时的记录 tag。按 tag
    // 精确匹配会让激活版本行误标「未下载」并在列表底部多出一条重复激活行。
    // 激活副本的引擎版本：发行包清单里 `dependencies["@deepseek-ai/dsh"]` 是打包时钉住的
    // 引擎版本（版本行的版本号就是它），顶层 `version` 还滞后一个发行版。旧记录没有版本
    // 号时从激活目录兜底读取。
    let manifest_version = config::get_dsh_version(app_handle).or_else(|| {
        (source == CoreSource::App && active_present)
            .then(|| read_manifest_dsh_version(&active_dir))
            .flatten()
    });
    // 就地安装的激活副本（`dependencies/dsh` 那一份目录）的 release 身份只认 store 里的
    // tag 记录：引擎版本号只是"版本行的版本号"，凭它认领版本行会把这份目录标成另一个
    // tag 的已装行——切换找不到槽位（CORE_VERSION_NOT_DOWNLOADED）、卸载找不到目录
    // （CORE_VERSION_NOT_FOUND），并吞掉核心更新提示（issue #790）。
    // 随包内核激活时（`app-bundled` 行已经代表它）不再让版本行认领同一份目录。
    let installed_release = (!bundled_active)
        .then(|| trusted_release_version(active_tag.as_deref(), manifest_version.as_deref()))
        .flatten();

    // 版本行：GitHub releases（最新在前，含 Pre-release label）→ 按版本去重，
    // 同版本只保留最后一个 tag。releases 拉取失败（离线/限流）时回退 git tags，
    // 预览标记按 tag 命名兜底（见 `download::is_preview_tag`）。
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
    for (version, catalog_tag, preview) in &version_tags {
        // 已安装的预打包核心：即使本次以本地核心运行（source=Local）也要如实标为
        // "已安装"，避免本地核心出现后预打包被当作未下载/消失（issue #54）。
        let in_place = installed_release.as_deref() == Some(version.as_str());
        let is_active = in_place && source == CoreSource::App;
        // 就地安装的副本没有槽位目录，它的 release 身份取 store 里的 tag 记录：同版本被
        // 重打包时版本行去重后保留的 tag 未必是本机安装时的那个，按它生成的 id 切换/
        // 卸载会找不到目录（issue #790）。
        let tag = if in_place {
            active_tag.as_deref().unwrap_or(catalog_tag.as_str())
        } else {
            catalog_tag.as_str()
        };
        if in_place {
            active_rendered = true;
        }
        let slot = existing_slot_dir(app_handle, tag);
        let removable = !in_place && slot.is_some();
        let (present, path, dir) = if in_place {
            let s = active_dir.to_string_lossy().into_owned();
            (active_present, s.clone(), s)
        } else if let Some(slot) = slot {
            let s = slot.to_string_lossy().into_owned();
            (true, s.clone(), s)
        } else {
            (false, String::new(), String::new())
        };
        rows.push(HarnessCore {
            id: format!("app-{tag}"),
            source: CoreSource::App,
            version: version.clone(),
            tag: tag.to_string(),
            path,
            dir,
            present,
            active: is_active,
            removable,
            preview: *preview,
            above_recommended: config::is_dsh_version_above_recommended(app_handle, version),
            orphaned: false,
            bundled: false,
            recommended_version: config::recommended_dsh_version(app_handle),
            error: None,
        });
    }

    // 激活副本没能对上任何版本行（离线/限流/tag 被移除/记录与清单不一致）：补一行没有
    // release 身份的旧激活行，按清单引擎版本如实呈现为"已安装"，激活入口走
    // `set_active("app")`。它没有槽位目录，因此既不列 tag 也不提供卸载（issue #790）。
    // 纳入版本行之后，保持列表不置顶；无论当前是否以本地核心运行都要列出，
    // 避免"本地核心出现后预打包消失"。
    // 随包内核已独立成行时不再兜底：`active_dir` 就是随包目录，再补一行会把下载版本
    // 的旧 tag 指向随包目录，出现重复且错误的「当前使用中」。
    if !active_rendered && active_present && !bundled_active {
        rows.push(HarnessCore {
            id: "app".to_string(),
            source: CoreSource::App,
            version: manifest_version.clone().unwrap_or_default(),
            tag: String::new(),
            path: active_dir.to_string_lossy().into_owned(),
            dir: active_dir.to_string_lossy().into_owned(),
            present: true,
            active: source == CoreSource::App,
            removable: false,
            orphaned: false,
            bundled: false,
            // 无远程元数据（离线/限流）：预览标记按 tag 命名兜底
            preview: active_tag.as_deref().is_some_and(download::is_preview_tag),
            above_recommended: manifest_version
                .as_deref()
                .is_some_and(|v| config::is_dsh_version_above_recommended(app_handle, v)),
            recommended_version: config::recommended_dsh_version(app_handle),
            error: None,
        });
    }

    // 磁盘扫描：tags 拉取失败/限流，或存在已下载但不在 tags 列表的版本（被移除的
    // 测试打包）时，把已下载的 `dsh-*` 槽位补进列表；同样按版本去重。
    // 激活版本已由版本行（或底部激活行）呈现，先放入 seen 避免扫描再补一条重复行。
    // 只放可信的 release 身份：认不出身份时就别拿清单引擎版本顶替，否则版本号相同的
    // 真实槽位会被跳过，既看不见也卸不掉，更新提示还会当成「没装过」再让用户重下一遍
    // （issue #790）。
    let mut seen_versions: HashSet<String> =
        version_tags.iter().map(|(v, _, _)| v.clone()).collect();
    let known_tags: HashSet<String> = version_tags.iter().map(|(_, tag, _)| tag.clone()).collect();
    let mut seen_tags = known_tags.clone();
    if !bundled_active {
        if let Some(v) = &installed_release {
            seen_versions.insert(v.clone());
        }
    }
    if let Ok(entries) = std::fs::read_dir(dependencies_dir(app_handle)) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            // 槽位目录名即 tag（`dsh-0.1.0-rc.8-...`）。`dsh` 为激活目录，跳过。
            let tag = if name.starts_with("dsh-") || name.starts_with("src-") {
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
                removable: true,
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

    rows
}

/// 已装核心列表中是否有「带着 release 身份」的槽位包含给定 semver 版本。
///
/// `check_dsh_update` 用它跳过「最新版本的核心已下载但未激活」场景的 toast：
/// 只要最新 release 的 semver 已存在于某个已装槽位（或随包内核）就不提示，避免用户白点
/// 一次「立即更新」做无意义的整包重下。版本号按字符串相等比较（dsh 的版本
/// 字符串已是 semver，build-id 不参与版本号识别——同 semver 的不同 build-id
/// 在用户视角下都算「同版本」）。就地安装的激活副本只有引擎版本号、没有 release
/// 身份，不能凭它判定某个 release 已安装，否则会吞掉核心更新提示（issue #790）。
pub async fn has_installed_version(app_handle: &AppHandle, version: &str) -> bool {
    any_release_installed(&list(app_handle).await, version)
}

/// 已装核心列表里是否有行的 semver 等于给定版本、且带着 release 身份（见
/// [`release_installed_on_disk`]）。
fn any_release_installed(cores: &[HarnessCore], version: &str) -> bool {
    cores
        .iter()
        .any(|c| release_installed_on_disk(c) && c.version == version)
}

/// 这一行能否作为「对应版本的核心已经装好」的证据：release 身份在盘上——磁盘槽位目录
/// （tag 即目录名，含已不在目录里的历史槽位）或 store 里与清单一致的 tag 记录；随包
/// 内核随应用分发也算。无 release 身份的 `app` 兜底行只是"激活目录里有一份版本号相同
/// 的副本"，证明不了某个 release 已下载（issue #790）。
fn release_installed_on_disk(core: &HarnessCore) -> bool {
    core.present && core.source == CoreSource::App && (core.bundled || !core.tag.is_empty())
}

/// 就地安装的激活副本（`dependencies/dsh`）的 release 身份：只认 store 里的 tag 记录，
/// 且记录里的版本号必须与清单里的引擎版本一致。
///
/// 发行包 package.json 里 `dependencies["@deepseek-ai/dsh"]` 是打包时钉住的引擎版本、
/// 顶层 `version` 还滞后一个发行版，都不是 release 身份；记录与清单不一致说明记录停在
/// 上一次安装（切换中断/就地覆盖），此时任何版本行都不能认领这份目录，交给无 tag 的
/// `app` 兜底行如实呈现（issue #790）。
fn trusted_release_version(
    active_tag: Option<&str>,
    manifest_version: Option<&str>,
) -> Option<String> {
    let version = active_tag.and_then(download::parse_version_from_tag)?;
    (Some(version.as_str()) == manifest_version).then_some(version)
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
/// `id` 取值：`local` | `app`（无 tag 记录的旧激活行）| `app-bundled`（随包内核）| `app-<tag>`。
pub async fn set_active(app_handle: &AppHandle, id: &str) -> Result<HarnessCore, String> {
    let transition_guard = if id == "app" || id == BUNDLED_CORE_ID || id == "local" {
        Some(workflow::acquire_core_transition().await?)
    } else {
        None
    };
    if id == "local" {
        let Some(core) = local_core(app_handle) else {
            return Err("CORE_LOCAL_NOT_FOUND: no local core detected".to_string());
        };
        // 低于最低支持版本的本地核心无法加载随包插件（issue #596）：显式切换同样
        // 拒绝并给出可操作提示，而不是让用户切过去再撞一次启动失败。
        let baseline = config::manifest::minimum_dsh_version(app_handle);
        if !core_supports_bundled_plugins(&core.version, baseline.as_deref()) {
            return Err(format!(
                "CORE_LOCAL_UNSUPPORTED: local dsh {} is below the minimum supported core; update it (`npm install -g @deepseek-ai/dsh@latest`) or keep a bundled version",
                core.version,
            ));
        }
        stop_harness_for_core_switch(app_handle).await?;
        let mut setting = config::get_store_dat_setting(app_handle);
        setting.active_core = Some(CoreSource::Local.as_str().to_string());
        config::set_store_dat_setting(app_handle, setting);
        // 映射表记录「该依赖由系统环境满足」（`null`），与清单的 `Path | null` 语义一致。
        config::dependencies::record(app_handle, config::dependencies::DEP_DSH, None);
    } else if id == BUNDLED_CORE_ID {
        // 切回随包内核：它始终在安装目录里，只需把 dsh 依赖根指回去。
        let Some(bundled) = config::dependencies::bundled_core_dir(app_handle) else {
            return Err("CORE_BUNDLED_NOT_FOUND: this install ships no bundled core".to_string());
        };
        let entry = config::dependencies::entry_relative(app_handle, config::dependencies::DEP_DSH);
        if !bundled.join(entry).is_file() {
            return Err("CORE_BUNDLED_NOT_FOUND: bundled core files are missing".to_string());
        }
        stop_harness_for_core_switch(app_handle).await?;
        let mut setting = config::get_store_dat_setting(app_handle);
        setting.active_core = Some(CoreSource::App.as_str().to_string());
        // 随包内核没有 pkg tag/commit：必须清掉下载版本留下的记录，否则版本展示与
        // 「当前激活」判定仍指着那份已下载的核心。
        setting.dsh_pkg_tag = None;
        setting.dsh_pkg_commit = None;
        config::set_store_dat_setting(app_handle, setting);
        config::dependencies::record(app_handle, config::dependencies::DEP_DSH, Some(bundled));
    } else if id == "app" {
        if !config::get_dsh_binary_path(app_handle).exists() {
            return Err("CORE_APP_NOT_FOUND: bundled core is not installed".to_string());
        }
        stop_harness_for_core_switch(app_handle).await?;
        let mut setting = config::get_store_dat_setting(app_handle);
        setting.active_core = Some(CoreSource::App.as_str().to_string());
        config::set_store_dat_setting(app_handle, setting);
        // 切回预打包核心：托管根重新成为该依赖的安装根。
        record_managed_core(app_handle);
    } else if let Some(tag) = id.strip_prefix("app-") {
        switch_app_version(app_handle, tag).await?;
    } else {
        return Err(format!("CORE_INVALID_ID: {id}"));
    }
    // 先释放切换锁再构造回包：重启流程要拿同一把锁与启动串行化，而回包已是纯本地
    // 构造（`list_local`），不必也不该在锁内多做一步。
    drop(transition_guard);

    // 回包只用本地列表构造，不再调用联网的 `list()`：核心切换是本地操作，为拿一个
    // 返回行等一轮 GitHub 往返会让「切换核心」白等数秒（离线更久）。
    list_local(app_handle)
        .into_iter()
        .find(|c| c.active)
        .ok_or_else(|| "CORE_NOT_FOUND: active core disappeared after switch".to_string())
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
    // 槽位互换只在托管根内进行（映射可能把激活核心指向安装目录的捆绑副本）；
    // 随包资源构建不互换，见下方分支。
    let active_dir = config::dependencies::managed_root(app_handle, config::dependencies::DEP_DSH);
    fs_guard::validate_id(tag)?;
    let cur_tag = config::get_dsh_pkg_tag(app_handle);

    // 激活目录已是目标版本（tag 相同）→ 仅切来源标记（如 local → app 同版本）
    if cur_tag.as_deref() == Some(tag) && config::get_dsh_binary_path(app_handle).is_file() {
        stop_harness_for_core_switch(app_handle).await?;
        let mut setting = config::get_store_dat_setting(app_handle);
        setting.active_core = Some(CoreSource::App.as_str().to_string());
        config::set_store_dat_setting(app_handle, setting);
        return Ok(());
    }
    let target_dir = existing_slot_dir(app_handle, tag)
        .ok_or_else(|| format!("CORE_VERSION_NOT_DOWNLOADED: {tag}"))?;

    // 随包资源构建：随包内核必须留在安装目录（`$Resources/dsh`），不能像普通安装那样
    // 把「激活目录 ↔ 槽位目录」互换——那会把安装包资源搬进 AppData，也会让应用升级
    // 覆盖掉用户选中的版本。改为把 `dsh` 依赖根指向槽位本身：槽位本就在 AppData 里，
    // 切回随包内核只是把根指回去（见 `set_active` 的 `app-bundled` 分支）。
    if config::dependencies::bundled_core_dir(app_handle).is_some() {
        stop_harness_for_core_switch(app_handle).await?;
        let commit = match download::fetch_dsh_pkg_tags(app_handle).await {
            Ok(tags) => tags.into_iter().find(|(t, _)| t == tag).map(|(_, c)| c),
            Err(e) => {
                log::warn!("failed to resolve commit for tag {tag}: {e}");
                None
            }
        };
        let mut setting = config::get_store_dat_setting(app_handle);
        setting.active_core = Some(CoreSource::App.as_str().to_string());
        setting.dsh_pkg_tag = Some(tag.to_string());
        if let Some(commit) = commit {
            setting.dsh_pkg_commit = Some(commit);
        }
        config::set_store_dat_setting(app_handle, setting);
        config::dependencies::record(app_handle, config::dependencies::DEP_DSH, Some(target_dir));
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

    // 1. 当前激活目录让出激活位：改名为自己的 tag 槽位（旧备份先移到临时位置，切换成功后再清理）
    let backup_tag = cur_tag.clone().unwrap_or_else(|| {
        format!(
            "dsh-{}",
            config::get_dsh_version(app_handle).unwrap_or_else(|| "unknown".to_string())
        )
    });
    let backup_dir = safe_slot_path(&deps, &backup_tag)?;

    let holding = deps.join(format!(".backup-holding-{}", std::process::id()));
    let stale_backup = deps.join(format!(".backup-stale-{}", std::process::id()));

    if backup_dir.exists() {
        download::rename_with_retry(&backup_dir, &holding)
            .await
            .map_err(|e| {
                format!(
                    "CORE_SWITCH_FAILED: {} -> {}: {e}",
                    backup_dir.display(),
                    holding.display()
                )
            })?;
    }

    if active_dir.exists() {
        if let Err(e) = download::rename_with_retry(&active_dir, &backup_dir).await {
            if holding.exists() {
                let _ = download::rename_with_retry(&holding, &backup_dir).await;
            }
            return Err(format!(
                "CORE_SWITCH_FAILED: {} -> {}: {e}",
                active_dir.display(),
                backup_dir.display()
            ));
        }
    }

    if let Err(e) = download::rename_with_retry(&target_dir, &active_dir).await {
        let rollback1 = download::rename_with_retry(&backup_dir, &active_dir).await;
        let rollback2 = if holding.exists() {
            download::rename_with_retry(&holding, &backup_dir).await
        } else {
            Ok::<(), std::io::Error>(())
        };
        return Err(format!(
            "CORE_SWITCH_FAILED: {} -> {}: {e} (rollback active: {}, rollback backup: {})",
            target_dir.display(),
            active_dir.display(),
            rollback1.is_ok(),
            rollback2.is_ok()
        ));
    }

    if holding.exists() && !download::remove_dir_with_retry(&holding).await {
        log::warn!(
            "CORE_SWITCH_WARNING: failed to remove stale backup {} after successful switch",
            holding.display()
        );
        if let Err(e) = download::rename_with_retry(&holding, &stale_backup).await {
            log::warn!(
                "CORE_SWITCH_WARNING: failed to rename stale backup to {}: {e}",
                stale_backup.display()
            );
        }
    }

    // 3. 记录切换：tag + commit（commit 从 tags 列表反查，失败保留原值）
    let commit = match download::fetch_dsh_pkg_tags(app_handle).await {
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
    // 切换后的激活核心回到托管根；映射表随之写回，界面与解析链路保持一致。
    record_managed_core(app_handle);
    Ok(())
}

/// 把 `dsh` 映射写回托管根（预打包核心的激活目录）。
fn record_managed_core(app_handle: &AppHandle) {
    config::dependencies::record(
        app_handle,
        config::dependencies::DEP_DSH,
        Some(config::dependencies::managed_root(
            app_handle,
            config::dependencies::DEP_DSH,
        )),
    );
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
    let info = download::fetch_dsh_pkg_asset(app_handle, tag)
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
///
/// 删除**不会**先停服务：绝大多数卸载针对的是没在跑的已下载版本，其目录没有被任何
/// 进程持有；无条件停服会连带中断用户当前正在使用的核心会话（用户视角就是「点一下
/// 卸载，正在跑的核心全挂了」）。只有直接删除因句柄锁定失败时（例如删到上一份激活
/// 副本、残留进程仍加载着它），才走「停服务 → 重试」的慢路径。
pub async fn remove_version(app_handle: &AppHandle, id: &str) -> Result<(), String> {
    // 随包内核随安装包分发，是内网/离线环境唯一的兜底内核：删掉就只能重装应用才能恢复。
    if id == BUNDLED_CORE_ID {
        return Err(
            "CORE_BUNDLED_PROTECTED: the bundled core ships with the app and cannot be removed"
                .to_string(),
        );
    }
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

    // 快速路径：目录未被任何进程持有，一次删掉，全程不碰运行中的服务。
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => {
            log::info!("Removed dsh core slot {tag} at {}", dir.display());
            return Ok(());
        }
        Err(e) => {
            log::warn!("dsh core slot {tag} is locked ({e}); stopping the service before retry");
        }
    }

    // 慢路径：目录仍被句柄锁定（可能是上一份激活副本的残留进程加载着它）。
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
    log::info!("Removed dsh core slot {tag} after stopping the service");
    Ok(())
}

/// 构造某个已下载 tag 的核心行（下载完成/已存在时返回）。
fn row_for_tag(app_handle: &AppHandle, tag: &str, dir: &Path) -> HarnessCore {
    let active = config::get_dsh_pkg_tag(app_handle).as_deref() == Some(tag)
        && active_source(app_handle) == CoreSource::App;
    let dir_str = dir.to_string_lossy().into_owned();
    HarnessCore {
        id: format!("app-{tag}"),
        source: CoreSource::App,
        version: download::parse_version_from_tag(tag).unwrap_or_default(),
        tag: tag.to_string(),
        path: dir_str.clone(),
        dir: dir_str,
        present: true,
        active,
        removable: true,
        preview: download::is_preview_tag(tag),
        above_recommended: download::parse_version_from_tag(tag)
            .is_some_and(|version| config::is_dsh_version_above_recommended(app_handle, &version)),
        orphaned: false,
        bundled: false,
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

    #[test]
    fn trusted_release_version_requires_record_manifest_agreement() {
        // 记录与清单引擎版本一致（正常安装/切换）：可信
        assert_eq!(
            trusted_release_version(Some("dsh-0.2.0-rc.2-36556493178"), Some("0.2.0-rc.2")),
            Some("0.2.0-rc.2".to_string())
        );
        // 记录停在上一份安装（就地覆盖安装/切换中断）：不可信，交给无 tag 的兜底行，
        // 否则会把激活目录认领成记录里那个 tag 的已装行（issue #790）
        assert_eq!(
            trusted_release_version(Some("dsh-0.1.7-rc.2-36024748146"), Some("0.2.0-rc.2")),
            None
        );
        // 无 tag 记录 / tag 解析不出 / 清单读不到版本：都不可信
        assert_eq!(trusted_release_version(None, Some("0.2.0-rc.2")), None);
        assert_eq!(
            trusted_release_version(Some("dsh-latest"), Some("0.2.0-rc.2")),
            None
        );
        assert_eq!(
            trusted_release_version(Some("dsh-0.2.0-rc.2-36556493178"), None),
            None
        );
    }

    fn core_row(
        id: &str,
        source: CoreSource,
        tag: &str,
        present: bool,
        bundled: bool,
    ) -> HarnessCore {
        HarnessCore {
            id: id.to_string(),
            source,
            version: "0.2.0-rc.2".to_string(),
            tag: tag.to_string(),
            path: String::new(),
            dir: String::new(),
            present,
            active: false,
            removable: false,
            preview: false,
            above_recommended: false,
            orphaned: false,
            bundled,
            recommended_version: None,
            error: None,
        }
    }

    #[test]
    fn release_installed_on_disk_needs_release_identity() {
        // 槽位行（tag 即目录名）：算已装
        assert!(release_installed_on_disk(&core_row(
            "app-dsh-0.2.0-rc.2-36556493178",
            CoreSource::App,
            "dsh-0.2.0-rc.2-36556493178",
            true,
            false
        )));
        // 随包内核（版本由清单给出，没有独立 tag）：算已装
        assert!(release_installed_on_disk(&core_row(
            "app-bundled",
            CoreSource::App,
            "",
            true,
            true
        )));
        // 无 release 身份的兜底行：只是激活目录里有一份版本号相同的副本，证明不了
        // 某个 release 已下载——凭它判定会吞掉核心更新提示（issue #790）
        assert!(!release_installed_on_disk(&core_row(
            "app",
            CoreSource::App,
            "",
            true,
            false
        )));
        // 本地核心与文件缺失的行都不算
        assert!(!release_installed_on_disk(&core_row(
            "local",
            CoreSource::Local,
            "dsh-0.2.0-rc.2-36556493178",
            true,
            false
        )));
        assert!(!release_installed_on_disk(&core_row(
            "app-dsh-0.2.0-rc.2-36556493178",
            CoreSource::App,
            "dsh-0.2.0-rc.2-36556493178",
            false,
            false
        )));
    }

    #[test]
    fn ghost_row_does_not_report_the_version_as_installed() {
        let tag = "dsh-0.2.0-rc.2-36556493178";
        // 修复后：只有带 release 身份的槽位行才算已装
        assert!(any_release_installed(
            &[core_row(
                &format!("app-{tag}"),
                CoreSource::App,
                tag,
                true,
                false
            )],
            "0.2.0-rc.2"
        ));
        // 修复前：无 tag 的兜底行（激活目录里有一份版本号相同的副本）也会被当成
        // 「已下载」，于是 check_dsh_update 吞掉更新提示（issue #790）
        assert!(!any_release_installed(
            &[core_row("app", CoreSource::App, "", true, false)],
            "0.2.0-rc.2"
        ));
        assert!(!any_release_installed(
            &[core_row("local", CoreSource::Local, tag, true, false)],
            "0.2.0-rc.2"
        ));
    }
}
