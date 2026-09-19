//! 离线安装包随包资源的**零拷贝落位**。
//!
//! 离线包把 Node.js 运行时、推荐 dsh 内核与 pnpm 预解压进 `resources/{node,dsh,pnpm}`
//! （内核 127 MiB / 一万余文件）。直接使用这些目录是不行的：桌面端每次启动都会往里
//! 写东西——`service::patch` 会改写 `node_modules/@deepseek-ai` 下的 8 个文件（其中
//! `alpha_auth` 决定要不要给服务传 `--skip-auth`），`prepare_active_runtime` 要在核心
//! 的 `node_modules` 下建内置插件与 profile 插件的入口链接。而 macOS 的 `.app`、
//! Linux 的 AppImage/deb 里的 `resources/` 都是只读的。
//!
//! 落位分三块，都不复制大块内容：
//!
//! 1. **Node / pnpm**：整目录链接到既有路径约定（`{app_data}/runtime`、
//!    `{app_data}/dependencies/pnpm`）。两者全程只读使用（pnpm 的 store 在
//!    `$DSH_HOME`），一个链接即可满足 `config::get_node_install_path`、CLI shim 里
//!    写死的 `%APP_DIR%\runtime\node.exe` 等全部既有约定。
//! 2. **dsh 内核**：在 `dependencies/dsh` 落位，方式按随包核心目录**是否可写**每次
//!    启动重新判定（[`core_writable`]）：
//!
//!    - [`LinkMode::Link`]（可写，Windows 每用户安装即如此）：`dependencies/dsh`
//!      就是 `resources/dsh` 的目录链接。补丁直接写穿到随包资源上——**被加载的就是
//!      被改写的同一份文件**，零额外磁盘占用，不存在"补丁副本与核心不同步"。
//!    - [`LinkMode::Layer`]（只读）：建一层链接层，只把补丁目标的祖先目录复制成真实
//!      文件，其余目录建链接。补丁写入落在应用数据目录。
//!
//!    链接层哪些目录必须真实，由补丁层自己声明（[`real_dirs`] 读
//!    `service::patch::patched_paths()`）：补丁写不穿目录链接，写在只读资源上必然
//!    失败，而 `patch_dsh` 对失败只记日志——`alpha_auth` 的补丁落不了地，
//!    `--skip-auth` 就不会下发，内嵌页面会要求登录。新增补丁只要登记进声明，两种
//!    模式都自动跟随；落位后逐项自检（链路真实 + 可写），把脱节变成硬错误而不是
//!    运行时静默降级。
//! 3. **核心切换照旧**：`dependencies/dsh` ↔ `dependencies/<tag>` 仍是目录互换，
//!    链接/链接层都能被重命名。用户下载的真实核心绝不覆盖——活动槽位被真实核心占用
//!    时，内置核心退到自己的 tag 槽位，作为可切换的普通版本存在。

use crate::config;
use crate::service::core::create_directory_link;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// 链接层标记文件（只用于 [`LinkMode::Layer`]：链接层是真实目录，可以放标记）。
///
/// `Link` 模式不放标记：核心目录本身是指向随包资源的链接，标记会写进安装包资源；
/// 该模式的归属由"它是指向当前随包核心的链接"直接判定。
const MARKER_FILE: &str = ".bundle-links.json";

/// 内置核心落位方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LinkMode {
    /// 随包核心目录可写：`dependencies/dsh` 就是它的目录链接，补丁写穿到
    /// `resources/dsh`。
    Link,
    /// 随包核心目录只读：链接层，补丁目标复制为真实文件。
    Layer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct LinkMarker {
    /// 链接层指向的随包核心目录（绝对路径）
    source: String,
    /// 生成链接层时的内置核心版本
    version: String,
}

fn read_marker(dir: &Path) -> Option<LinkMarker> {
    let content = fs::read_to_string(dir.join(MARKER_FILE)).ok()?;
    serde_json::from_str(&content).ok()
}

/// 必须以**真实文件**落地的目录（相对核心根）。
///
/// 来自 `service::patch::patched_paths()` 的声明——补丁的写入目标及其全部祖先目录。
/// 这些目录一旦是链接，写入就会透传到只读的随包资源上；`patch_dsh` 对失败只记日志，
/// 表现为补丁静默失效。`node_modules` 本身始终真实：`prepare_active_runtime` 要在
/// 这里建内置插件与 profile 插件的入口链接。
///
/// 刻意不做成"复制某个 scope"：那样既多复制几十 MB，又把补丁目标与落位逻辑的耦合
/// 写死在两个地方——新增补丁落在别的包里就会静默失效。
fn real_dirs() -> HashSet<PathBuf> {
    let mut dirs = HashSet::from([PathBuf::from("node_modules")]);
    for target in crate::service::patch::patched_paths() {
        let mut parent = Path::new(target).parent();
        while let Some(dir) = parent {
            if dir.as_os_str().is_empty() {
                break;
            }
            dirs.insert(dir.to_path_buf());
            parent = dir.parent();
        }
    }
    dirs
}

/// 随包核心目录是否可写：能否在里面创建并删除一个探针文件。
///
/// 决定用 [`LinkMode::Link`] 还是 [`LinkMode::Layer`]。每次启动重新探测：权限/挂载
/// 方式变了会自动切换模式，而不是留下一个补丁写不进去的核心。
fn core_writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".dsh-write-probe-{}", std::process::id()));
    if fs::write(&probe, b"").is_err() {
        return false;
    }
    let _ = fs::remove_file(&probe);
    true
}

fn is_link(path: &Path) -> Result<bool, String> {
    Ok(fs::symlink_metadata(path)
        .map_err(|e| format!("BUNDLE_LINKS_STAT_FAILED: {}: {e}", path.display()))?
        .file_type()
        .is_symlink())
}

/// 判定某个目录是否已经是当前随包核心的落位产物，以及用的哪种方式。
fn materialized_mode(dir: &Path, source: &Path, version: &str) -> Option<LinkMode> {
    let metadata = fs::symlink_metadata(dir).ok()?;
    if metadata.file_type().is_symlink() {
        let target = fs::read_link(dir).ok()?;
        let target = if target.is_absolute() {
            target
        } else {
            dir.parent()?.join(target)
        };
        // 链接指向当前随包核心即可：资源被新安装包替换后链接自动指向新版本，
        // 不需要重建（补丁会在启动时按新内容重新判定）。
        let resolved = fs::canonicalize(target).ok()?;
        return (resolved == fs::canonicalize(source).ok()?).then_some(LinkMode::Link);
    }
    if !metadata.is_dir() {
        return None;
    }
    let marker = read_marker(dir)?;
    (marker.source == source.to_string_lossy() && marker.version == version)
        .then_some(LinkMode::Layer)
}

/// 某个核心目录是否就是内置核心当前的落位产物（`Link` 链接或 `Layer` 链接层）。
///
/// 核心列表与卸载保护都以此为准，而不是比较版本号：用户完全可能另外下载一个与内置
/// 核心同版本的槽位，那是他自己的副本，不该被标成「内置核心」、更不该禁止卸载。
pub fn is_bundled_dir(app_handle: &AppHandle, dir: &Path) -> bool {
    let Some(source) = config::bundled_dsh_dir(app_handle) else {
        return false;
    };
    let Some(version) = config::bundled_dsh_version(app_handle) else {
        return false;
    };
    materialized_mode(dir, &source, &version).is_some()
}

/// 内置核心是否需要（重新）落位；`None` 表示已就绪或让位给用户自己的核心。
fn plan(app_handle: &AppHandle, source: &Path, version: &str, tag: &str, mode: LinkMode) -> Option<PathBuf> {
    let active = config::get_dsh_install_path(app_handle);
    if let Some(current) = materialized_mode(&active, source, version) {
        return if current == mode && verify_patch_targets(&active, false).is_ok() {
            None
        } else {
            Some(active)
        };
    }
    // 不存在，或是我们自己留下的链接（含悬垂链接）：直接落位为活动核心
    if !active.exists() || is_link(&active).unwrap_or(false) {
        return Some(active);
    }

    // 活动槽位是用户自己的真实核心：内置核心退到自己的 tag 槽位
    let slot = active
        .parent()
        .map(|deps| deps.join(tag))
        .unwrap_or_else(|| active.clone());
    if let Some(current) = materialized_mode(&slot, source, version) {
        return if current == mode && verify_patch_targets(&slot, false).is_ok() {
            None
        } else {
            Some(slot)
        };
    }
    if !slot.exists() || is_link(&slot).unwrap_or(false) {
        return Some(slot);
    }
    log::info!(
        "BUNDLE_LINKS_SKIP: {} is occupied by a downloaded core, keeping it untouched",
        slot.display()
    );
    None
}

/// 把随包内置核心落位到应用数据目录（幂等）。
///
/// 返回是否真正（重新）落位。普通安装包（无 `resources/bundle.json`）直接空转。
pub fn materialize(app_handle: &AppHandle) -> Result<bool, String> {
    if !config::is_offline_bundle(app_handle) {
        return Ok(false);
    }
    // Node / pnpm 的链接与内核落位互不依赖：任一项失败都不应连带跳过另一项。
    link_runtime_dirs(app_handle);
    materialize_core(app_handle)
}

/// 随包 Node 运行时与 pnpm 以整目录链接落到既有路径约定上。
///
/// 两者全程只读使用（pnpm 的 store 在 `$DSH_HOME`，Node 只被启动/调用），因此一个
/// 目录链接即可零拷贝满足全部既有约定：`config::get_node_install_path` 的
/// `runtime/`、`dependencies/pnpm`，以及 CLI shim 里写死的
/// `%APP_DIR%\runtime\node.exe` 与 `%APP_DIR%\dependencies\pnpm\bin\pnpm.cjs`。
/// 已有真实运行时（用户下载过）时不覆盖。
fn link_runtime_dirs(app_handle: &AppHandle) {
    // 逐项独立：Node 链接失败不应连带跳过 pnpm（反之亦然），失败项由
    // `Installable::check_installed` 走原有下载路径兜底。
    if let Some(node) = config::bundled_node_dir(app_handle) {
        if let Err(e) = link_runtime_dir(&node, &config::get_node_install_path(app_handle), "node") {
            log::warn!("{e}");
        }
    }
    if let Some(pnpm) = config::bundled_pnpm_dir(app_handle) {
        if let Err(e) = link_runtime_dir(&pnpm, &config::get_pnpm_install_path(app_handle), "pnpm") {
            log::warn!("{e}");
        }
    }
}

fn link_runtime_dir(source: &Path, dest: &Path, label: &str) -> Result<(), String> {
    match fs::symlink_metadata(dest) {
        // 悬垂链接（随包资源被移动/删除）：先移除再重建，避免永久失效
        Ok(meta) if meta.file_type().is_symlink() && !dest.exists() => remove_link(dest)?,
        Ok(_) => return Ok(()),
        Err(_) => {}
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("BUNDLE_LINKS_RUNTIME_FAILED: {}: {e}", parent.display()))?;
    }
    let absolute = fs::canonicalize(source)
        .map_err(|e| format!("BUNDLE_LINKS_RUNTIME_FAILED: {}: {e}", source.display()))?;
    create_directory_link(&absolute, dest).map_err(|e| {
        format!(
            "BUNDLE_LINKS_RUNTIME_FAILED: {label}: {} -> {}: {e}",
            dest.display(),
            absolute.display()
        )
    })
}

/// 内置核心落位：见模块头。
fn materialize_core(app_handle: &AppHandle) -> Result<bool, String> {
    let Some(source) = config::bundled_dsh_dir(app_handle) else {
        return Ok(false);
    };
    // 随包目录不完整（构建缺陷）时不做落位：让原有下载路径兜底。
    if config::bundled_dsh_binary(app_handle).is_none() {
        log::warn!(
            "BUNDLE_LINKS_INCOMPLETE: bundled core entry is missing under {}",
            source.display()
        );
        return Ok(false);
    }
    let Some(version) = config::bundled_dsh_version(app_handle) else {
        return Ok(false);
    };
    let tag = config::bundled_core_tag(app_handle)
        .unwrap_or_else(|| format!("dsh-{version}-bundled"));
    let mode = if core_writable(&source) {
        LinkMode::Link
    } else {
        LinkMode::Layer
    };

    let Some(target) = plan(app_handle, &source, &version, &tag, mode) else {
        return Ok(false);
    };

    materialize_into(&source, &target, &version, mode)?;
    log::info!(
        "BUNDLE_LINKS: materialized bundled core {version} at {} ({mode:?}, source {})",
        target.display(),
        source.display()
    );

    // 内置核心的记录 tag/commit：核心列表据此标注「内置核心」，切换时也据此命名
    // 备份槽位。只在活动槽位就是内置核心时写入，避免覆盖用户所选核心的记录。
    if target == config::get_dsh_install_path(app_handle) {
        let commit = config::bundled_core_commit(app_handle);
        config::update_store_dat_setting(app_handle, |setting| {
            setting.dsh_pkg_tag = Some(tag);
            if commit.is_some() {
                setting.dsh_pkg_commit = commit;
            }
        });
    }
    Ok(true)
}

/// 先在暂存兄弟目录里建好并自检，全部成功后才与目标换位。
///
/// 直接删掉旧目标再重建是不行的：中途失败会留下一个没有标记的半成品真实目录，
/// [`materialized_mode`] 认不出它，[`plan`] 会当成用户自己的核心而永不修复，
/// 应用就此没有可用内核。暂存名以 `.` 开头，不会被核心列表的槽位扫描误认。
fn materialize_into(source: &Path, target: &Path, version: &str, mode: LinkMode) -> Result<(), String> {
    let parent = target.parent().unwrap_or(Path::new("."));
    let leaf = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("core");
    let staging = parent.join(format!(".{leaf}.bundling-{}", std::process::id()));
    let backup = parent.join(format!(".{leaf}.bundling-backup"));

    // 上次崩溃残留
    remove_materialized(&staging)?;
    if let Err(e) = build_into(source, &staging, version, mode) {
        let _ = remove_materialized(&staging);
        return Err(e);
    }
    // 建完立即自检：补丁目标必须真实可写。这里失败说明落位方式与补丁声明脱节，
    // 属于必须修的缺陷，不能等补丁在运行时静默失效。
    if let Err(e) = verify_patch_targets(&staging, true) {
        let _ = remove_materialized(&staging);
        return Err(e);
    }

    remove_materialized(&backup)?;
    let had_previous = fs::symlink_metadata(target).is_ok();
    if had_previous {
        fs::rename(target, &backup).map_err(|e| {
            let _ = remove_materialized(&staging);
            format!("BUNDLE_LINKS_SWAP_FAILED: {}: {e}", target.display())
        })?;
    }
    if let Err(e) = fs::rename(&staging, target) {
        if had_previous {
            let _ = fs::rename(&backup, target);
        }
        let _ = remove_materialized(&staging);
        return Err(format!(
            "BUNDLE_LINKS_SWAP_FAILED: {} -> {}: {e}",
            staging.display(),
            target.display()
        ));
    }
    // 备份可能被仍在运行的旧进程占用，删除失败只告警：它带 `.` 前缀，不会被当成槽位，
    // 下次启动会再清一次。
    if let Err(e) = remove_materialized(&backup) {
        log::warn!("{e}");
    }
    Ok(())
}

/// 按模式建出落位产物（不校验、不换位）。
fn build_into(source: &Path, target: &Path, version: &str, mode: LinkMode) -> Result<(), String> {
    match mode {
        LinkMode::Link => {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("BUNDLE_LINKS_CREATE_FAILED: {}: {e}", parent.display()))?;
            }
            let absolute = fs::canonicalize(source)
                .map_err(|e| format!("BUNDLE_LINKS_CREATE_FAILED: {}: {e}", source.display()))?;
            match create_directory_link(&absolute, target) {
                Ok(()) => Ok(()),
                // 目录链接建不出来（Unix 上符号链接不可用、Windows 上非权限类失败）：
                // 退回链接层。`link_entry` 在链接失败时还会逐项退化为复制，因此这一步
                // 总能产出可用的核心，而不是让 `Dsh::check_installed` 落空去联网下载。
                Err(e) => {
                    log::warn!(
                        "BUNDLE_LINKS_LINK_FAILED: {} -> {} ({e}), falling back to a link layer",
                        target.display(),
                        absolute.display()
                    );
                    let _ = remove_materialized(target);
                    build_link_layer(source, target, version)
                }
            }
        }
        LinkMode::Layer => build_link_layer(source, target, version),
    }
}

/// 删除上一次的落位产物：链接只删入口，链接层只删链接与它自己复制的内容。
///
/// 调用方（[`plan`]）已确认目标属于内置核心；真实核心绝不会走到这里。
fn remove_materialized(target: &Path) -> Result<(), String> {
    match fs::symlink_metadata(target) {
        Err(_) => Ok(()),
        Ok(meta) if meta.file_type().is_symlink() => remove_link(target),
        Ok(_) => remove_link_layer(target),
    }
}

/// 建链接层：只有补丁目标的祖先目录与 `node_modules` 复制为真实内容，其余目录建
/// 链接，文件一律复制（文件链接在 Windows 上需要特权）。
fn build_link_layer(source: &Path, dest: &Path, version: &str) -> Result<(), String> {
    let real = real_dirs();
    build_tree(source, dest, Path::new(""), &real)?;

    let marker = LinkMarker {
        source: source.to_string_lossy().into_owned(),
        version: version.to_string(),
    };
    let payload = serde_json::to_string_pretty(&marker)
        .map_err(|e| format!("BUNDLE_LINKS_MARKER_FAILED: {e}"))?;
    fs::write(dest.join(MARKER_FILE), payload)
        .map_err(|e| format!("BUNDLE_LINKS_MARKER_FAILED: {}: {e}", dest.display()))?;
    Ok(())
}

/// 递归建树：`real` 里的目录（补丁目标的祖先 + `node_modules`）复制为真实目录，
/// 其余目录建链接，文件一律复制。
fn build_tree(src: &Path, dest: &Path, rel: &Path, real: &HashSet<PathBuf>) -> Result<(), String> {
    fs::create_dir_all(dest)
        .map_err(|e| format!("BUNDLE_LINKS_CREATE_FAILED: {}: {e}", dest.display()))?;
    for entry in read_dir(src)? {
        let from = entry.path();
        let name = entry.file_name();
        let to = dest.join(&name);
        let rel_child = rel.join(&name);
        let metadata = fs::symlink_metadata(&from)
            .map_err(|e| format!("BUNDLE_LINKS_ENTRY_FAILED: {}: {e}", from.display()))?;
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            if real.contains(&rel_child) {
                build_tree(&from, &to, &rel_child, real)?;
            } else {
                link_entry(&from, &to)?;
            }
        } else {
            copy_tree(&from, &to)?;
        }
    }
    Ok(())
}

/// 校验所有补丁目标从核心根**之下**到文件的整条链路都是真实目录。
///
/// 只检查文件本身是不是链接是不够的：`node_modules/@deepseek-ai` 是链接时，其下的
/// `dsh-web-app/lib/startup.js` 在 `symlink_metadata` 眼里仍是普通文件，写入却会
/// 透传到只读的随包资源。因此逐级上溯，任何一级是链接即判定失败。
///
/// 核心根自身不计入：[`LinkMode::Link`] 下它本来就是链接，而链接目标的可写性由
/// [`core_writable`] 单独保证（每次启动重新探测）。
///
/// `probe_writes` 为真时额外尝试以写模式打开：只读挂载/权限异常下补丁会静默失败，
/// 落位阶段就要暴露出来（启动路径上的常规校验不做写探测，避免与运行中的进程抢锁）。
fn verify_patch_targets(dir: &Path, probe_writes: bool) -> Result<(), String> {
    for target in crate::service::patch::patched_paths() {
        let path = dir.join(target);
        if !path.exists() {
            // 该核心版本没有这个文件：补丁本来就会安全跳过。
            continue;
        }
        let mut node = Some(path.as_path());
        while let Some(current) = node {
            if !current.starts_with(dir) || current == dir {
                break;
            }
            if is_link(current)? {
                return Err(format!(
                    "BUNDLE_LINKS_PATCH_TARGET_LINKED: {target} is behind a directory link ({}), patches cannot be written",
                    current.display()
                ));
            }
            node = current.parent();
        }
        if probe_writes {
            fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .map_err(|e| format!("BUNDLE_LINKS_PATCH_TARGET_READONLY: {target}: {e}"))?;
        }
    }
    Ok(())
}

fn read_dir(dir: &Path) -> Result<Vec<fs::DirEntry>, String> {
    let entries = fs::read_dir(dir)
        .map_err(|e| format!("BUNDLE_LINKS_READ_FAILED: {}: {e}", dir.display()))?;
    entries
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("BUNDLE_LINKS_READ_FAILED: {}: {e}", dir.display()))
}

/// 目录建链接，文件直接复制。
///
/// 文件不做链接：Windows 的文件符号链接同样需要 SeCreateSymbolicLinkPrivilege，而
/// junction 回退只适用于目录；顶层只有 `package.json` / `package-lock.json` 两个
/// 小文件，复制代价可忽略。链接失败（文件系统不支持）时退回整目录复制。
fn link_entry(from: &Path, to: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(from)
        .map_err(|e| format!("BUNDLE_LINKS_ENTRY_FAILED: {}: {e}", from.display()))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return copy_tree(from, to);
    }
    // 链接目标必须是绝对路径：junction 记录的是字面目标，相对路径会在应用数据
    // 目录下解析到错误位置。
    let absolute = fs::canonicalize(from)
        .map_err(|e| format!("BUNDLE_LINKS_ENTRY_FAILED: {}: {e}", from.display()))?;
    match create_directory_link(&absolute, to) {
        Ok(()) => Ok(()),
        Err(e) => {
            log::warn!(
                "BUNDLE_LINKS_FALLBACK_COPY: cannot link {} -> {} ({e}), copying instead",
                to.display(),
                absolute.display()
            );
            copy_tree(from, to)
        }
    }
}

/// 递归复制目录/文件（Unix 上原样重建符号链接）。
fn copy_tree(src: &Path, dest: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(src)
        .map_err(|e| format!("BUNDLE_LINKS_COPY_FAILED: {}: {e}", src.display()))?;
    if metadata.file_type().is_symlink() {
        return copy_symlink(src, dest);
    }
    if metadata.is_dir() {
        fs::create_dir_all(dest)
            .map_err(|e| format!("BUNDLE_LINKS_COPY_FAILED: {}: {e}", dest.display()))?;
        for entry in read_dir(src)? {
            copy_tree(&entry.path(), &dest.join(entry.file_name()))?;
        }
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("BUNDLE_LINKS_COPY_FAILED: {}: {e}", parent.display()))?;
    }
    fs::copy(src, dest).map_err(|e| {
        format!(
            "BUNDLE_LINKS_COPY_FAILED: {} -> {}: {e}",
            src.display(),
            dest.display()
        )
    })?;
    Ok(())
}

#[cfg(unix)]
fn copy_symlink(src: &Path, dest: &Path) -> Result<(), String> {
    let target = fs::read_link(src)
        .map_err(|e| format!("BUNDLE_LINKS_COPY_FAILED: {}: {e}", src.display()))?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("BUNDLE_LINKS_COPY_FAILED: {}: {e}", parent.display()))?;
    }
    std::os::unix::fs::symlink(&target, dest).map_err(|e| {
        format!(
            "BUNDLE_LINKS_COPY_FAILED: {} -> {}: {e}",
            src.display(),
            dest.display()
        )
    })
}

#[cfg(not(unix))]
fn copy_symlink(src: &Path, dest: &Path) -> Result<(), String> {
    let resolved = fs::canonicalize(src)
        .map_err(|e| format!("BUNDLE_LINKS_COPY_FAILED: {}: {e}", src.display()))?;
    copy_tree(&resolved, dest)
}

/// 删除链接层：只移除链接本身，绝不递归进入链接目标（否则会删掉随包资源）。
fn remove_link_layer(dest: &Path) -> Result<(), String> {
    for entry in read_dir(dest)? {
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|e| format!("BUNDLE_LINKS_REMOVE_FAILED: {}: {e}", path.display()))?;
        if metadata.file_type().is_symlink() {
            remove_link(&path)?;
        } else if metadata.is_dir() {
            fs::remove_dir_all(&path)
                .map_err(|e| format!("BUNDLE_LINKS_REMOVE_FAILED: {}: {e}", path.display()))?;
        } else {
            fs::remove_file(&path)
                .map_err(|e| format!("BUNDLE_LINKS_REMOVE_FAILED: {}: {e}", path.display()))?;
        }
    }
    fs::remove_dir(dest)
        .map_err(|e| format!("BUNDLE_LINKS_REMOVE_FAILED: {}: {e}", dest.display()))
}

/// 只删除链接入口本身。Windows 的 junction 是目录重解析点，用 `remove_dir` 移除。
fn remove_link(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    let result = fs::remove_dir(path).or_else(|_| fs::remove_file(path));
    #[cfg(not(windows))]
    let result = fs::remove_file(path);
    result.map_err(|e| format!("BUNDLE_LINKS_REMOVE_FAILED: {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dsh-bundle-links-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    /// 造一个最小内核：按**真实补丁声明**生成补丁目标，再放一个同 scope 下的非补丁包
    /// 与一个顶层包——后两者在链接层里必须保持链接。
    fn fake_core(root: &Path) {
        for target in crate::service::patch::patched_paths() {
            let path = root.join(target);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, b"original").unwrap();
        }
        let untouched = root.join("node_modules/@deepseek-ai/dsh-web-frontend");
        fs::create_dir_all(&untouched).unwrap();
        fs::write(untouched.join("index.js"), b"frontend").unwrap();
        let plain = root.join("node_modules/node-pty");
        fs::create_dir_all(&plain).unwrap();
        fs::write(plain.join("index.js"), b"pty").unwrap();
        fs::write(
            root.join("package.json"),
            br#"{"dependencies":{"@deepseek-ai/dsh":"0.1.5-rc.2"}}"#,
        )
        .unwrap();
        fs::write(root.join("package-lock.json"), b"{}").unwrap();
    }

    fn first_patch_target() -> &'static str {
        crate::service::patch::patched_paths()[0]
    }

    /// `Link` 模式：核心目录就是随包资源的链接，补丁**直接写进 resources/dsh**。
    #[test]
    fn link_mode_patches_resources_in_place() {
        let root = temp_dir("link-mode");
        let source = root.join("resources").join("dsh");
        let target = root.join("dependencies").join("dsh");
        fake_core(&source);

        assert!(core_writable(&source));
        materialize_into(&source, &target, "0.1.5-rc.2", LinkMode::Link).unwrap();

        assert!(fs::symlink_metadata(&target).unwrap().file_type().is_symlink());
        assert_eq!(
            materialized_mode(&target, &source, "0.1.5-rc.2"),
            Some(LinkMode::Link)
        );

        // 通过活动核心目录写入 = 写进随包资源本身（加载的与改写的是同一份文件）
        for patch_target in crate::service::patch::patched_paths() {
            let path = target.join(patch_target);
            fs::write(&path, b"patched").unwrap();
            assert_eq!(
                fs::read(source.join(patch_target)).unwrap().as_slice(),
                b"patched",
                "Link 模式下补丁应落在随包资源上: {patch_target}"
            );
        }

        // 删除只移除链接入口，随包资源保持不动
        remove_materialized(&target).unwrap();
        assert!(!target.exists());
        assert!(source.join(first_patch_target()).is_file());
        let _ = fs::remove_dir_all(root);
    }

    /// `Layer` 模式：补丁目标复制为真实文件，写入不穿透到只读的随包资源。
    #[test]
    fn layer_mode_makes_exactly_the_patch_targets_real() {
        let root = temp_dir("layer-mode");
        let source = root.join("resources").join("dsh");
        let target = root.join("dependencies").join("dsh");
        fake_core(&source);

        materialize_into(&source, &target, "0.1.5-rc.2", LinkMode::Layer).unwrap();

        assert!(!fs::symlink_metadata(&target).unwrap().file_type().is_symlink());
        assert_eq!(
            materialized_mode(&target, &source, "0.1.5-rc.2"),
            Some(LinkMode::Layer)
        );

        for patch_target in crate::service::patch::patched_paths() {
            let patched = target.join(patch_target);
            assert!(
                !fs::symlink_metadata(&patched).unwrap().file_type().is_symlink(),
                "补丁目标必须是真实文件: {patch_target}"
            );
            fs::write(&patched, b"patched").unwrap();
            assert_eq!(
                fs::read(source.join(patch_target)).unwrap().as_slice(),
                b"original",
                "补丁不得写进随包资源: {patch_target}"
            );
        }

        // 无补丁的包保持链接，且 node_modules 本身是可写真实目录
        for linked in [
            "node_modules/@deepseek-ai/dsh-web-frontend",
            "node_modules/node-pty",
        ] {
            let path = target.join(linked);
            assert!(
                fs::symlink_metadata(&path).unwrap().file_type().is_symlink(),
                "无补丁的包必须保持链接: {linked}"
            );
        }
        assert_eq!(
            fs::read(target.join("node_modules/node-pty/index.js")).unwrap().as_slice(),
            b"pty"
        );
        fs::create_dir(target.join("node_modules/dsh-tauri")).unwrap();

        // 顶层文件复制为真实文件
        assert!(!fs::symlink_metadata(target.join("package.json")).unwrap().file_type().is_symlink());
        let _ = fs::remove_dir_all(root);
    }

    /// 模式切换：可写→只读（或反之）时必须重建，而不是留下一个补丁写不进去的核心。
    #[test]
    fn mode_change_triggers_a_rebuild() {
        let root = temp_dir("mode-switch");
        let source = root.join("resources").join("dsh");
        let target = root.join("dependencies").join("dsh");
        fake_core(&source);

        materialize_into(&source, &target, "0.1.5-rc.2", LinkMode::Link).unwrap();
        assert_eq!(
            materialized_mode(&target, &source, "0.1.5-rc.2"),
            Some(LinkMode::Link)
        );

        materialize_into(&source, &target, "0.1.5-rc.2", LinkMode::Layer).unwrap();
        assert_eq!(
            materialized_mode(&target, &source, "0.1.5-rc.2"),
            Some(LinkMode::Layer)
        );
        assert!(!fs::symlink_metadata(&target).unwrap().file_type().is_symlink());
        // 切换后补丁不再写进随包资源
        fs::write(target.join(first_patch_target()), b"patched").unwrap();
        assert_eq!(
            fs::read(source.join(first_patch_target())).unwrap().as_slice(),
            b"original"
        );
        let _ = fs::remove_dir_all(root);
    }

    /// 重建失败时必须保住旧的落位产物：不能留下一个没有标记的半成品目录
    /// （那会被 `plan` 当成用户自己的核心，从此不再修复）。
    #[test]
    fn failed_rebuild_keeps_the_previous_materialization() {
        let root = temp_dir("failed-rebuild");
        let source = root.join("resources").join("dsh");
        let target = root.join("dependencies").join("dsh");
        fake_core(&source);
        materialize_into(&source, &target, "0.1.5-rc.2", LinkMode::Layer).unwrap();
        let before = fs::read(target.join(first_patch_target())).unwrap();

        // 源目录被破坏（补丁目标消失导致 copy 失败）：这里用一个不存在的源模拟
        let missing = root.join("resources").join("gone");
        let error = materialize_into(&missing, &target, "0.1.6-rc.1", LinkMode::Layer).expect_err("必须失败");
        assert!(error.starts_with("BUNDLE_LINKS_"), "unexpected error: {error}");

        // 旧落位产物原样保留，且仍被认作内置核心的落位结果
        assert_eq!(fs::read(target.join(first_patch_target())).unwrap(), before);
        assert_eq!(
            materialized_mode(&target, &source, "0.1.5-rc.2"),
            Some(LinkMode::Layer)
        );
        // 暂存/备份目录不残留
        let leftovers: Vec<_> = fs::read_dir(root.join("dependencies"))
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with('.'))
            .collect();
        assert!(leftovers.is_empty(), "leftovers: {leftovers:?}");
        let _ = fs::remove_dir_all(root);
    }

    /// 与内置核心同版本的**下载槽位**不是内置核心：不能被认领，也不能被禁止卸载。
    #[test]
    fn same_version_downloaded_slot_is_not_the_bundled_core() {
        let root = temp_dir("same-version");
        let source = root.join("resources").join("dsh");
        fake_core(&source);
        let slot = root.join("dependencies").join("dsh-0.1.5-rc.2-99999999999");
        fake_core(&slot);

        // 真实目录、无标记 → 不是内置核心的落位产物
        assert_eq!(materialized_mode(&slot, &source, "0.1.5-rc.2"), None);
        let _ = fs::remove_dir_all(root);
    }

    /// `real_dirs()` 必须覆盖每个补丁目标的全部祖先目录，否则那个目标会落在链接后面。
    #[test]
    fn real_dirs_cover_every_patch_ancestor() {
        let real = real_dirs();
        assert!(real.contains(&PathBuf::from("node_modules")));
        for target in crate::service::patch::patched_paths() {
            let mut parent = Path::new(target).parent();
            while let Some(dir) = parent {
                if dir.as_os_str().is_empty() {
                    break;
                }
                assert!(real.contains(dir), "缺少祖先目录 {dir:?}（目标 {target}）");
                parent = dir.parent();
            }
        }
    }

    /// 补丁目标被留在链接后面时必须**报错**，不能静默产出一个补丁写不进去的落位。
    #[test]
    fn patch_target_behind_a_link_fails_verification() {
        let root = temp_dir("verify");
        let source = root.join("resources").join("dsh");
        fake_core(&source);
        let target = root.join("dependencies").join("dsh");

        // 造一个"整包链接"的错误布局：把补丁目标所在包直接链接过去
        fs::create_dir_all(target.join("node_modules")).unwrap();
        let patch_target = first_patch_target();
        let package = Path::new(patch_target).parent().unwrap().parent().unwrap();
        fs::create_dir_all(target.join(package).parent().unwrap()).unwrap();
        let absolute = fs::canonicalize(source.join(package)).unwrap();
        create_directory_link(&absolute, &target.join(package)).unwrap();

        let error = verify_patch_targets(&target, false).expect_err("必须报错");
        assert!(
            error.starts_with("BUNDLE_LINKS_PATCH_TARGET_LINKED:"),
            "unexpected error: {error}"
        );
        let _ = fs::remove_dir_all(root);
    }

    /// 目标文件不存在（该核心版本没有这个补丁点）时不算失败：补丁本来就会安全跳过。
    #[test]
    fn verification_passes_when_patch_targets_are_absent() {
        let root = temp_dir("verify-absent");
        let target = root.join("dependencies").join("dsh");
        fs::create_dir_all(&target).unwrap();
        assert!(verify_patch_targets(&target, false).is_ok());
        let _ = fs::remove_dir_all(root);
    }

    /// 用户自己下载的真实核心（无标记、非链接）绝不被认领、绝不删除。
    #[test]
    fn real_core_is_never_claimed_or_replaced() {
        let root = temp_dir("occupied");
        let source = root.join("resources").join("dsh");
        fake_core(&source);
        let real = root.join("dependencies").join("dsh");
        fake_core(&real);

        assert_eq!(materialized_mode(&real, &source, "0.1.5-rc.2"), None);
        assert!(plan_free(&real, &source, "0.1.5-rc.2").is_none());
        let _ = fs::remove_dir_all(root);
    }

    /// `plan` 的"目标是否可用"判定：不存在或属于内置核心才可落位。
    fn plan_free(dir: &Path, source: &Path, version: &str) -> Option<PathBuf> {
        if let Some(_mode) = materialized_mode(dir, source, version) {
            return Some(dir.to_path_buf());
        }
        if !dir.exists() || is_link(dir).unwrap_or(false) {
            return Some(dir.to_path_buf());
        }
        None
    }

    /// 链接层重建时必须清掉上一次的残留（例如已卸载插件的入口链接）。
    #[test]
    fn rebuild_replaces_a_stale_layer() {
        let root = temp_dir("rebuild");
        let source = root.join("resources").join("dsh");
        let target = root.join("dependencies").join("dsh");
        fake_core(&source);
        materialize_into(&source, &target, "0.1.5-rc.2", LinkMode::Layer).unwrap();
        fs::create_dir(target.join("node_modules").join("stale-plugin")).unwrap();

        materialize_into(&source, &target, "0.1.6-rc.1", LinkMode::Layer).unwrap();

        assert!(!target.join("node_modules").join("stale-plugin").exists());
        assert_eq!(read_marker(&target).unwrap().version, "0.1.6-rc.1");
        assert!(source.join("node_modules/node-pty/index.js").is_file());
        let _ = fs::remove_dir_all(root);
    }

    /// 运行时整目录链接：建一次、幂等、已有真实运行时绝不覆盖。
    #[test]
    fn runtime_dir_link_is_idempotent_and_never_replaces_real_dirs() {
        let root = temp_dir("runtime-link");
        let source = root.join("resources").join("node");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join(if cfg!(windows) { "node.exe" } else { "node" }), b"node").unwrap();

        let dest = root.join("runtime");
        link_runtime_dir(&source, &dest, "node").unwrap();
        assert!(fs::symlink_metadata(&dest).unwrap().file_type().is_symlink());
        assert!(dest.join(if cfg!(windows) { "node.exe" } else { "node" }).is_file());

        // 幂等：重复调用不报错也不重建
        link_runtime_dir(&source, &dest, "node").unwrap();

        // 已有真实运行时（用户下载过）时保持原样
        let real = root.join("real-runtime");
        fs::create_dir_all(&real).unwrap();
        fs::write(real.join("marker"), b"downloaded").unwrap();
        link_runtime_dir(&source, &real, "node").unwrap();
        assert!(real.join("marker").is_file());
        assert!(!fs::symlink_metadata(&real).unwrap().file_type().is_symlink());

        let _ = fs::remove_dir_all(root);
    }

    /// `runtime/` 是指向随包运行时的链接时，下载路径的 `fs::remove_dir_all` 必须
    /// 只删链接本身——否则一次「重装 Node」就会把 `resources/node` 整个删掉。
    #[test]
    fn remove_dir_all_does_not_follow_directory_links() {
        let root = temp_dir("remove-all-link");
        let source = root.join("resources").join("node");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("node.exe"), b"node").unwrap();

        let link = root.join("runtime");
        link_runtime_dir(&source, &link, "node").unwrap();
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());

        fs::remove_dir_all(&link).unwrap();

        assert!(!link.exists(), "link entry must be gone");
        assert!(
            source.join("node.exe").is_file(),
            "link target must survive remove_dir_all"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn copy_tree_mirrors_directory_layout() {
        let root = temp_dir("copy");
        let src = root.join("src");
        fs::create_dir_all(src.join("bin")).unwrap();
        fs::write(src.join("bin/node"), b"binary").unwrap();

        let dest = root.join("dest");
        copy_tree(&src, &dest).unwrap();

        assert_eq!(fs::read(dest.join("bin/node")).unwrap(), b"binary");
        let _ = fs::remove_dir_all(root);
    }
}
