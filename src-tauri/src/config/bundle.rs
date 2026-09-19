//! 离线安装包（`resources/bundle.json`）识别与随包资源路径。
//!
//! 离线包构建（见 `.github/workflows/release-bundle.yml`）把 Node.js 运行时、推荐
//! dsh 内核与 pnpm 预解压进 `resources/{node,dsh,pnpm}`，并写一份
//! `resources/bundle.json`。检测到该清单即视为离线包：
//!
//! - **Node / pnpm 直接使用**随包目录，跳过 PATH 上的本地安装与应用数据目录副本
//!   （两者都只读使用，不需要可写）；
//! - **dsh 内核零拷贝落位**到应用数据目录的 `dependencies/dsh`（见 `service::bundle`）：
//!   顶层条目与 `node_modules` 的绝大多数条目都是指向 `resources/dsh` 的目录链接，
//!   只有补丁目标 `node_modules/@deepseek-ai` 复制为真实文件——桌面端每次启动都会
//!   改写其中的 8 个文件（见 `service::patch`），链接无法承载写入。

use serde::Deserialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime};

/// 随包清单文件名（只有离线包构建会写入）
const MANIFEST_FILE: &str = "bundle.json";
/// 随包 Node.js 运行时目录名
pub const BUNDLE_NODE_DIR: &str = "node";
/// 随包 Harness 发行版目录名
pub const BUNDLE_DSH_DIR: &str = "dsh";
/// 随包 pnpm 目录名
pub const BUNDLE_PNPM_DIR: &str = "pnpm";

/// 随包清单 `resources/bundle.json`：只有 `dsh` 是运行时需要的字段
/// （内置核心的版本 / tag / 提交标识），Node、pnpm、平台等仅作构建期记录。
#[derive(Debug, Clone, Deserialize)]
pub struct BundleManifest {
    #[serde(default)]
    pub dsh: Option<BundleDsh>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BundleDsh {
    pub version: String,
    #[serde(default)]
    pub tag: Option<String>,
    #[serde(default)]
    pub commit: Option<String>,
}

/// 安装包资源根下的候选位置。
///
/// Tauri 2 在 Windows 上 `resource_dir()` 恒等于 exe 所在目录，而资源实际按
/// `resources/**` 前缀落盘到 `{resource_dir}/resources/`，因此两个位置都要探测
/// （与 `plugin::preset` 的查找策略一致）。
fn resource_candidates<R: Runtime>(app_handle: &AppHandle<R>, name: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(dir) = app_handle.path().resource_dir() {
        paths.push(dir.join(name));
        paths.push(dir.join("resources").join(name));
    }
    paths
}

fn find_resource<R: Runtime>(app_handle: &AppHandle<R>, name: &str) -> Option<PathBuf> {
    resource_candidates(app_handle, name)
        .into_iter()
        .find(|path| path.exists())
}

/// 本次安装是否由离线包构建产出（`resources/bundle.json` 是唯一判据）。
pub fn is_offline_bundle<R: Runtime>(app_handle: &AppHandle<R>) -> bool {
    resource_candidates(app_handle, MANIFEST_FILE)
        .into_iter()
        .any(|path| path.is_file())
}

/// 读取随包清单（缺失/损坏时返回 None）。
pub fn bundle_manifest<R: Runtime>(app_handle: &AppHandle<R>) -> Option<BundleManifest> {
    let path = resource_candidates(app_handle, MANIFEST_FILE)
        .into_iter()
        .find(|path| path.is_file())?;
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// 随包 Node.js 运行时目录
pub fn bundled_node_dir<R: Runtime>(app_handle: &AppHandle<R>) -> Option<PathBuf> {
    find_resource(app_handle, BUNDLE_NODE_DIR).filter(|path| path.is_dir())
}

/// 随包 Harness 发行版目录
pub fn bundled_dsh_dir<R: Runtime>(app_handle: &AppHandle<R>) -> Option<PathBuf> {
    find_resource(app_handle, BUNDLE_DSH_DIR).filter(|path| path.is_dir())
}

/// 随包 pnpm 目录
pub fn bundled_pnpm_dir<R: Runtime>(app_handle: &AppHandle<R>) -> Option<PathBuf> {
    find_resource(app_handle, BUNDLE_PNPM_DIR).filter(|path| path.is_dir())
}

/// 随包 Node.js 可执行文件（未随包分发或文件缺失时返回 None）。
pub fn bundled_node_binary<R: Runtime>(app_handle: &AppHandle<R>) -> Option<PathBuf> {
    let dir = bundled_node_dir(app_handle)?;
    let binary = if cfg!(windows) {
        dir.join("node.exe")
    } else {
        dir.join("bin").join("node")
    };
    binary.is_file().then_some(binary)
}

/// 随包 pnpm CLI 入口（纯 JS 发行，用 node 运行）。
pub fn bundled_pnpm_binary<R: Runtime>(app_handle: &AppHandle<R>) -> Option<PathBuf> {
    let binary = bundled_pnpm_dir(app_handle)?.join(crate::config::PNPM_ENTRY_RELATIVE);
    binary.is_file().then_some(binary)
}

/// 随包核心的 dsh 入口。
pub fn bundled_dsh_binary<R: Runtime>(app_handle: &AppHandle<R>) -> Option<PathBuf> {
    let binary = bundled_dsh_dir(app_handle)?.join(crate::config::DSH_ENTRY_RELATIVE);
    binary.is_file().then_some(binary)
}

/// 读取发行版目录 `package.json` 中 `@deepseek-ai/dsh` 依赖版本。
fn read_manifest_dsh_version(dir: &std::path::Path) -> Option<String> {
    let value: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("package.json")).ok()?).ok()?;
    value
        .get("dependencies")?
        .get("@deepseek-ai/dsh")?
        .as_str()
        .map(|version| version.trim_start_matches(['^', '~', '=', '>', '<']).to_string())
}

/// 内置核心版本号：随包清单优先，清单缺失时读 `resources/dsh/package.json`。
pub fn bundled_dsh_version<R: Runtime>(app_handle: &AppHandle<R>) -> Option<String> {
    if let Some(version) = bundle_manifest(app_handle)
        .and_then(|manifest| manifest.dsh)
        .map(|dsh| dsh.version)
        .filter(|version| !version.is_empty())
    {
        return Some(version);
    }
    bundled_dsh_dir(app_handle).and_then(|dir| read_manifest_dsh_version(&dir))
}

/// 内置核心对应的 release tag：清单优先，缺失时按版本号合成一个可被
/// `download::parse_version_from_tag` 解析的 tag（槽位目录名即 tag）。
pub fn bundled_core_tag<R: Runtime>(app_handle: &AppHandle<R>) -> Option<String> {
    if let Some(tag) = bundle_manifest(app_handle)
        .and_then(|manifest| manifest.dsh)
        .and_then(|dsh| dsh.tag)
        .filter(|tag| !tag.is_empty())
    {
        return Some(tag);
    }
    bundled_dsh_version(app_handle).map(|version| format!("dsh-{version}-bundled"))
}

/// 内置核心对应的提交标识（清单未记录时为空）。
pub fn bundled_core_commit<R: Runtime>(app_handle: &AppHandle<R>) -> Option<String> {
    bundle_manifest(app_handle)
        .and_then(|manifest| manifest.dsh)
        .and_then(|dsh| dsh.commit)
        .filter(|commit| !commit.is_empty())
}
