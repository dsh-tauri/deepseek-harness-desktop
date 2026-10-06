//! 本地安装包导入（issue #138）：内网机访问不了 GitHub 时，用预先下载的官方
//! 发行资产（`deepseek-harness-pkg-<平台>.zip`）装配核心，不再依赖联网下载。
//!
//! 流程：复制到应用数据目录 → 校验平台与包结构 → 比对官方摘要 → 解压到历史槽位
//! `dependencies/<tag>` → 激活。版本身份以官方 tag 为准：能取到官方发行元数据时按
//! SHA-256 反查 tag，取不到（内网完全断网）时用包内声明的版本拼出本地 tag，此时
//! 无法比对摘要，界面提示用户自行确认安装包来源。

use crate::config;
use crate::service::{download, fs_guard};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// 安装包大小上限（当前官方资产约 133 MB，预留升级余量）。
const MAX_PACKAGE_BYTES: u64 = 1024 * 1024 * 1024;
/// 包内必须存在的核心入口（与 `config::dependencies` 中 dsh 的默认入口一致）。
const REQUIRED_ENTRY: &str = "node_modules/@deepseek-ai/dsh/lib/bin.js";
/// 可识别的官方资产名后缀：用于判定「拿到了别的平台或架构的包」。
const OFFICIAL_SUFFIXES: [&str; 4] = [
    "-windows.zip",
    "-linux.zip",
    "-macos-arm64.zip",
    "-macos-x64.zip",
];
/// 离线路径的本地 tag 后缀。必须用 `-` 分隔：`parse_version_from_tag` 取 tag 的
/// 最后一段当 build-id，没有这一段会把 `0.2.0-rc.2` 截成 `0.2.0-rc`。
const LOCAL_TAG_SUFFIX: &str = "local";

/// 导入结果：对话框据此展示版本、离线提示与摘要。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreImportPlan {
    pub tag: String,
    pub version: String,
    pub commit: String,
    pub digest: String,
    pub size: u64,
    /// 是否已对照官方发行摘要校验（内网取不到官方元数据时为 false）
    pub verified: bool,
}

/// 安装包缓存目录：`<base>/packages`。用户选中的文件先复制到这里，后续解压与
/// 重试都只依赖本机路径（原文件可能在 U 盘或网络盘上）。
fn package_dir(app_handle: &AppHandle) -> PathBuf {
    config::get_base_dir(app_handle).join("packages")
}

fn cached_package_path(app_handle: &AppHandle, file_name: &str) -> PathBuf {
    package_dir(app_handle).join(file_name)
}

fn same_file(source: &Path, target: &Path) -> bool {
    match (fs::canonicalize(source), fs::canonicalize(target)) {
        (Ok(source), Ok(target)) => source == target,
        _ => false,
    }
}

/// 平台或架构不匹配时返回规范错误串；无法判定（非官方资产名）时返回 `None`。
fn platform_mismatch(file_name: &str) -> Option<String> {
    let official = config::dsh_pkg_asset_filename().ok()?;
    let recognized = OFFICIAL_SUFFIXES
        .iter()
        .any(|suffix| file_name.ends_with(suffix));
    (recognized && file_name != official).then(|| {
        format!(
            "CORE_IMPORT_PLATFORM_MISMATCH: {file_name} cannot run on this machine, download {official}"
        )
    })
}

/// 离线路径的本地 tag（见 `LOCAL_TAG_SUFFIX` 的说明）。
fn local_tag(version: &str) -> String {
    format!("dsh-{version}-{LOCAL_TAG_SUFFIX}")
}

/// 流式计算文件 SHA-256，输出与 GitHub 发行摘要同形的 `sha256:<hex>`。
fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("CORE_IMPORT_UNREADABLE: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| format!("CORE_IMPORT_UNREADABLE: {e}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

/// 复制安装包到应用数据目录：先写同目录临时文件再改名，中途中断不会留下半个包。
fn copy_package(source: &Path, target: &Path) -> Result<(), String> {
    let staging = target.with_extension("copying");
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("CORE_IMPORT_COPY_FAILED: {e}"))?;
    }
    let _ = fs::remove_file(&staging);
    fs::copy(source, &staging).map_err(|e| format!("CORE_IMPORT_COPY_FAILED: {e}"))?;
    fs::rename(&staging, target).map_err(|e| format!("CORE_IMPORT_COPY_FAILED: {e}"))
}

/// 包内声明的核心版本：根 `package.json` 的 `dependencies["@deepseek-ai/dsh"]`，
/// 与 `version::read_manifest_dsh_version` 同源判定（槽位行的版本列由它决定）。
fn read_package_version(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|e| format!("CORE_IMPORT_UNREADABLE: {e}"))?;
    let mut archive = zip::ZipArchive::new(BufReader::new(file))
        .map_err(|e| format!("CORE_IMPORT_NOT_A_PACKAGE: {e}"))?;

    let manifest = {
        let mut entry = archive.by_name("package.json").map_err(|_| {
            "CORE_IMPORT_NOT_A_PACKAGE: package.json is missing at the archive root".to_string()
        })?;
        let mut text = String::new();
        entry
            .read_to_string(&mut text)
            .map_err(|e| format!("CORE_IMPORT_UNREADABLE: {e}"))?;
        let value: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| format!("CORE_IMPORT_NOT_A_PACKAGE: invalid package.json: {e}"))?;
        if value.get("name").and_then(|name| name.as_str()) != Some("deepseek-harness-pkg") {
            return Err(
                "CORE_IMPORT_NOT_A_PACKAGE: not a deepseek-harness-pkg archive".to_string(),
            );
        }
        value
    };

    // 解压前先确认核心入口在包里，避免解压出一份切过去也起不来的槽位。
    archive.by_name(REQUIRED_ENTRY).map_err(|_| {
        format!("CORE_IMPORT_NOT_A_PACKAGE: {REQUIRED_ENTRY} is missing from the archive")
    })?;

    manifest
        .get("dependencies")
        .and_then(|deps| deps.get("@deepseek-ai/dsh"))
        .and_then(|value| value.as_str())
        .map(|value| {
            value
                .trim_start_matches(['^', '~', '=', '>', '<'])
                .to_string()
        })
        .filter(|version| !version.is_empty())
        .ok_or_else(|| {
            "CORE_IMPORT_NOT_A_PACKAGE: package.json declares no @deepseek-ai/dsh dependency"
                .to_string()
        })
}

/// 识别用户选中的安装包（复制、摘要、平台与结构校验、版本反查），不做任何激活。
pub async fn inspect_local_package(
    app_handle: &AppHandle,
    path: &str,
) -> Result<CoreImportPlan, String> {
    let source = PathBuf::from(path);
    let file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("CORE_IMPORT_INVALID_PATH: {path}"))?
        .to_string();
    if !source.is_file() {
        return Err(format!("CORE_IMPORT_INVALID_PATH: {path}"));
    }
    if let Some(error) = platform_mismatch(&file_name) {
        return Err(error);
    }
    let size = fs::metadata(&source)
        .map_err(|e| format!("CORE_IMPORT_UNREADABLE: {e}"))?
        .len();
    if size > MAX_PACKAGE_BYTES {
        return Err(format!(
            "CORE_IMPORT_TOO_LARGE: {size} bytes exceeds the {MAX_PACKAGE_BYTES} byte limit"
        ));
    }

    let target = cached_package_path(app_handle, &file_name);
    let copy_source = source.clone();
    let copy_target = target.clone();
    let digest = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        if !same_file(&copy_source, &copy_target) {
            copy_package(&copy_source, &copy_target)?;
        }
        sha256_file(&copy_target)
    })
    .await
    .map_err(|e| format!("CORE_IMPORT_COPY_FAILED: {e}"))??;

    let version = {
        let package = target.clone();
        tauri::async_runtime::spawn_blocking(move || read_package_version(&package))
            .await
            .map_err(|e| format!("CORE_IMPORT_NOT_A_PACKAGE: {e}"))??
    };

    // 官方发行元数据：能取到时按摘要反查 tag（下载内容与校验摘要同源），取不到时
    // 走离线路径——用包内声明的版本拼本地 tag，界面提示未校验。
    let releases = match download::fetch_dsh_pkg_releases(app_handle).await {
        Ok(releases) => Some(releases),
        Err(e) => {
            log::warn!("Failed to fetch dsh pkg releases for local package import: {e}");
            None
        }
    };
    // 同一版本在 pkg 仓库里可能有多个 tag（重打包 / 测试打包），官方标记的预发布
    // 也要算候选：本包自身常常就是预发布版本。逐候选比对，命中即停。
    let candidates: Vec<String> = releases
        .as_ref()
        .map(|releases| {
            releases
                .iter()
                .filter(|meta| {
                    download::parse_version_from_tag(&meta.tag).as_deref() == Some(version.as_str())
                })
                .map(|meta| meta.tag.clone())
                .collect()
        })
        .unwrap_or_default();

    let mut matched: Option<(String, String)> = None;
    for tag in &candidates {
        let Ok(info) = download::fetch_dsh_pkg_asset(app_handle, tag).await else {
            continue;
        };
        if info.digest.as_deref() == Some(digest.as_str()) {
            matched = Some((tag.clone(), info.commit));
            break;
        }
    }

    let (tag, commit, verified) = match matched {
        Some((tag, commit)) => (tag, commit, true),
        // 官方元数据取不到，或该版本不在官方发行目录里：无法比对摘要，按包内版本落地。
        None if candidates.is_empty() => (local_tag(&version), LOCAL_TAG_SUFFIX.to_string(), false),
        None => {
            return Err(format!(
                "CORE_IMPORT_DIGEST_MISMATCH: {file_name} does not match the published {version} release ({})",
                candidates.join(", ")
            ));
        }
    };

    Ok(CoreImportPlan {
        tag,
        version,
        commit,
        digest,
        size,
        verified,
    })
}

/// 导入本地安装包：识别 → 解压到历史槽位 → 激活。已存在的同 tag 槽位直接复用，
/// 重复导入不会重新解压（切换由 `set_active` 完成，重启由前端启动流程负责）。
pub async fn import_local_package(
    app_handle: &AppHandle,
    path: &str,
) -> Result<CoreImportPlan, String> {
    let plan = inspect_local_package(app_handle, path).await?;
    fs_guard::validate_id(&plan.tag)?;

    let file_name = PathBuf::from(path)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("CORE_IMPORT_INVALID_PATH: {path}"))?
        .to_string();
    let slots = super::version::dependencies_dir(app_handle);
    fs::create_dir_all(&slots).map_err(|e| format!("CORE_IMPORT_EXTRACT_FAILED: {e}"))?;
    let slot = slots.join(&plan.tag);

    if slot.is_dir() {
        log::info!(
            "Core slot {} already exists, activating it instead of unpacking again",
            slot.display()
        );
    } else {
        let package = cached_package_path(app_handle, &file_name);
        let buffer = fs::read(&package).map_err(|e| format!("CORE_IMPORT_UNREADABLE: {e}"))?;

        let window = app_handle
            .get_webview_window("main")
            .ok_or("WINDOW_NOT_FOUND: main window missing")?;
        let mut tracker = download::ProgressTracker::new(&window, 2);
        tracker.start_phase("extract", &format!("正在解压本地安装包 {}", plan.tag));
        if let Err(e) = download::ensure_extract(&tracker, file_name, buffer, slot.clone()).await {
            // 解压中途失败会留下同盘的暂存目录（上百 MB），清掉再报错。
            let staging = slots.join(format!(".{}.installing-{}", plan.tag, std::process::id()));
            let _ = download::remove_dir_with_retry(&staging).await;
            return Err(format!("CORE_IMPORT_EXTRACT_FAILED: {e}"));
        }
        tracker.end_phase();
        log::info!("Imported local core package to {}", slot.display());
    }

    crate::service::core::set_active(app_handle, &format!("app-{}", plan.tag)).await?;
    // 切换链路靠联网反查 tag→commit，内网导入取不到，会留下与 tag 不匹配的旧 commit，
    // 让更新检查误判滞后；这里用导入时已确认的身份覆盖。
    config::set_dsh_pkg_identity(app_handle, plan.commit.clone(), plan.tag.clone());
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::FileOptions;

    fn write_package(dir: &Path, name: &str, root_name: &str, version: Option<&str>) -> PathBuf {
        let path = dir.join(name);
        let file = fs::File::create(&path).expect("create package");
        let mut writer = zip::ZipWriter::new(file);
        let options = FileOptions::default();
        let deps = match version {
            Some(version) => format!(r#"{{"@deepseek-ai/dsh":"{version}"}}"#),
            None => "{}".to_string(),
        };
        let manifest = format!(r#"{{"name":"{root_name}","dependencies":{deps}}}"#);
        writer
            .start_file("package.json", options)
            .expect("start manifest");
        writer
            .write_all(manifest.as_bytes())
            .expect("write manifest");
        writer
            .start_file(REQUIRED_ENTRY, options)
            .expect("start entry");
        writer.write_all(b"// entry").expect("write entry");
        writer.finish().expect("finish package");
        path
    }

    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dsh-core-import-{}-{label}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    #[test]
    fn reads_the_core_version_declared_by_the_package() {
        let dir = scratch("version");
        let package = write_package(
            &dir,
            "deepseek-harness-pkg-windows.zip",
            "deepseek-harness-pkg",
            Some("0.2.0-rc.2"),
        );
        assert_eq!(read_package_version(&package).unwrap(), "0.2.0-rc.2");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rejects_archives_that_are_not_a_harness_package() {
        let dir = scratch("foreign");
        let package = write_package(&dir, "other.zip", "some-other-tool", Some("1.0.0"));
        let error = read_package_version(&package).unwrap_err();
        assert!(error.starts_with("CORE_IMPORT_NOT_A_PACKAGE"), "{error}");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rejects_packages_without_a_declared_core_dependency() {
        let dir = scratch("noref");
        let package = write_package(
            &dir,
            "deepseek-harness-pkg-windows.zip",
            "deepseek-harness-pkg",
            None,
        );
        let error = read_package_version(&package).unwrap_err();
        assert!(error.starts_with("CORE_IMPORT_NOT_A_PACKAGE"), "{error}");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rejects_files_that_are_not_archives() {
        let dir = scratch("plain");
        let path = dir.join("deepseek-harness-pkg-windows.zip");
        fs::write(&path, b"not a zip").unwrap();
        let error = read_package_version(&path).unwrap_err();
        assert!(error.starts_with("CORE_IMPORT_NOT_A_PACKAGE"), "{error}");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rejects_packages_built_for_another_platform() {
        let official = config::dsh_pkg_asset_filename().unwrap();
        assert!(platform_mismatch(&official).is_none());
        assert!(platform_mismatch("deepseek-harness-pkg-custom.zip").is_none());
        let other = OFFICIAL_SUFFIXES
            .iter()
            .map(|suffix| format!("deepseek-harness-pkg{suffix}"))
            .find(|name| *name != official)
            .expect("another platform asset name");
        let error = platform_mismatch(&other).unwrap();
        assert!(
            error.starts_with("CORE_IMPORT_PLATFORM_MISMATCH"),
            "{error}"
        );
        assert!(error.contains(&official), "{error}");
    }

    #[test]
    fn local_tag_keeps_the_full_version_parsable() {
        // 回归：没有 build-id 段时 parse_version_from_tag 会把 0.2.0-rc.2 截成 0.2.0-rc。
        for version in ["0.2.0-rc.2", "0.1.7-rc.10", "0.2.0"] {
            let tag = local_tag(version);
            assert_eq!(
                download::parse_version_from_tag(&tag).as_deref(),
                Some(version),
                "{tag}"
            );
        }
    }
}
