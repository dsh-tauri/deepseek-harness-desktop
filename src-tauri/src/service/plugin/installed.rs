//! 已安装插件检测：强类型解析 profile 下 package.json 的 `dependencies` 键与
//! `dsh.profile.bundles` 列表，得到已安装插件 id 集合，并组装前端渲染列表。

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use super::preset::{load_deprecated_ids, load_presets, PreinstallPluginInfo};

/// 用于强类型解析 profile 下 package.json 的辅助结构
/// （字段 pub(crate)：供 watch 模块解析已安装插件清单复用）
#[derive(Deserialize)]
pub(crate) struct ProfilePackageJson {
    #[serde(default)]
    pub(crate) dependencies: HashMap<String, String>,
    #[serde(default)]
    pub(crate) dsh: Option<ProfileDshSection>,
}

#[derive(Deserialize)]
pub(crate) struct ProfileDshSection {
    #[serde(default)]
    pub(crate) profile: Option<ProfileInner>,
}

#[derive(Deserialize)]
pub(crate) struct ProfileInner {
    #[serde(default)]
    pub(crate) bundles: Vec<String>,
}

/// 插件所在的 profile 目录（$DSH_HOME/profiles/<当前档案>）。
///
/// 档案由桌面端设置（`active_profile`）决定，不再写死 web；启动服务与插件
/// 操作都以同一份「当前档案」为准（见 service::profile::active_profile）。
pub(crate) fn profile_dir(app_handle: &AppHandle) -> PathBuf {
    crate::service::profile::profile_dir_of(
        app_handle,
        &crate::service::profile::active_profile(app_handle),
    )
}

/// 已安装的插件 id 集合：通过强类型反序列化读取 package.json 的 `dependencies` 键与 `bundles` 列表。
///
/// 供「插件是否已安装」的单点判定（[`is_installed`]）与安全模式的用户插件清除
/// （[`super::safe`]）共用：后者需要的是全量清单，而非逐个 id 的探测。
pub(crate) fn list_installed(app_handle: &AppHandle) -> HashSet<String> {
    declared_packages(app_handle).unwrap_or_default()
}

/// 档案清单声明的包名；清单缺失、不可读或结构不合法时返回 `None`。
///
/// 与 [`list_installed`] 的区别是区分「确实没有声明任何包」与「读不到声明」：
/// 删除类操作必须把后者当未知状态处理，否则一次解析失败会让所有已声明的包
/// 变成「未声明」，进而被误删。
pub(crate) fn declared_packages(app_handle: &AppHandle) -> Option<HashSet<String>> {
    let manifest_path = profile_dir(app_handle).join("package.json");
    let content = std::fs::read_to_string(&manifest_path).ok()?;
    let manifest = serde_json::from_str::<ProfilePackageJson>(&content).ok()?;

    let mut set: HashSet<String> = manifest.dependencies.into_keys().collect();
    if let Some(dsh) = manifest.dsh {
        if let Some(profile) = dsh.profile {
            set.extend(profile.bundles);
        }
    }
    Some(set)
}

/// 插件是否仍被 profile 清单（`dependencies` / `dsh.profile.bundles`）引用。
///
/// 供卸载后校验使用（见 [`super::install::remove`]）：`dsh plugin remove` 以子进程
/// 退出码为准，可能出现「命令成功但插件仍在」的边界（如 bundle 层残留、pnpm 静默
/// 失败），校验不过时由调用方回落到离线卸载，确保插件真正从 profile 移除
/// （参考 dsh-market 的「卸载后核验」约定）。
pub(crate) fn is_installed(app_handle: &AppHandle, id: &str) -> bool {
    list_installed(app_handle).contains(id)
}

/// 预装插件列表项（含已安装检测结果），序列化给前端
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreinstallPlugin {
    pub id: String,
    pub name: String,
    pub description: String,
    pub repo_url: String,
    pub recommended: bool,
    /// 是否为「修复」类项（前端渲染黄色 chip，默认勾选）
    pub fix: bool,
    /// 无 chip 但默认勾选（首次引导直接勾上，不标「推荐」）
    pub default_checked: bool,
    /// 显式声明首次引导不默认勾选（仍可标「推荐」chip，但不预选）
    pub default_unchecked: bool,
    pub installed: bool,
    pub unsupported: bool,
}

/// 用于“已安装”检测的包名：预设显式声明 `package` 时用它（scoped 包名与预设
/// id 不一致），未声明则回落到 `id`。供内部（`internal.rs` 内置插件自愈）复用。
pub(crate) fn installed_name(p: &PreinstallPluginInfo) -> &str {
    p.package.as_deref().unwrap_or(p.id.as_str())
}

pub(super) fn deprecated_installed_names(
    presets: &[PreinstallPluginInfo],
    deprecated_ids: &HashSet<String>,
    core_version: Option<&str>,
    mut installed: impl FnMut(&str) -> bool,
    mut installed_version: impl FnMut(&str) -> Option<String>,
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
            matches!(
                p.version,
                Some(crate::config::manifest::PluginVersion::Matrix(_))
            ) && p.retire_on(core_version, installed_version(name).as_deref())
        })
        .map(|p| installed_name(p).to_string())
        .collect();
    for id in deprecated_ids {
        if !presets.iter().any(|p| p.id == *id) && installed(id) {
            names.push(id.clone());
        }
    }
    names.sort();
    names.dedup();
    names
}

pub(super) fn deprecated_plugins_at(
    profile: &Path,
    manifest: &ProfilePackageJson,
    presets: &[PreinstallPluginInfo],
    deprecated_ids: &HashSet<String>,
    core_version: Option<&str>,
) -> Result<(Vec<String>, bool), String> {
    let bundles = manifest.dsh.as_ref().and_then(|dsh| dsh.profile.as_ref());
    let mut failure = None;
    let mut known = true;
    let names = deprecated_installed_names(
        presets,
        deprecated_ids,
        core_version,
        |name| {
            if manifest.dependencies.contains_key(name)
                || bundles.is_some_and(|profile| profile.bundles.iter().any(|id| id == name))
            {
                return true;
            }
            match std::fs::symlink_metadata(profile.join("node_modules").join(name)) {
                Ok(_) => true,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
                Err(error) => {
                    failure = Some(format!(
                        "DEPRECATED_PLUGIN_ENTRY_READ_FAILED: {name}: {error}"
                    ));
                    false
                }
            }
        },
        |name| {
            let version = std::fs::read_to_string(
                profile.join("node_modules").join(name).join("package.json"),
            )
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|manifest| manifest.get("version")?.as_str().map(String::from));
            known &= presets
                .iter()
                .filter(|preset| installed_name(preset) == name)
                .all(|preset| {
                    preset.version.as_ref().is_some_and(|range| {
                        range
                            .outdated_for_core_generation(core_version, version.as_deref())
                            .is_some()
                    })
                });
            version
        },
    );
    match failure {
        Some(error) => Err(error),
        None => Ok((names, known)),
    }
}

/// 预装插件列表（含 installed 状态），前端渲染用
pub fn list(app_handle: &AppHandle) -> Vec<PreinstallPlugin> {
    let installed = list_installed(app_handle);
    let is_windows = cfg!(windows);
    // 弃用插件（清单 `plugins.depercated` 登记）不再提供安装入口，启动时自动卸载，
    // 不进入首次引导清单。
    let deprecated_ids = load_deprecated_ids(app_handle);
    // 当前活动核心版本：按预设声明的（插件版本 ↔ 核心版本）矩阵判定兼容性。
    let core_version = crate::service::core::active_version(app_handle);

    load_presets(app_handle)
        .into_iter()
        .filter(|p| !p.win_only || is_windows)
        // 内置插件（internal:true）由启动自愈强制安装，不进入首次引导清单：
        // 对用户而言它们“必装”，给出可取消的勾选框反而造成歧义。
        .filter(|p| !p.internal)
        // 弃用插件不再提供安装入口，启动时自动卸载，不进入清单。
        .filter(|p| !deprecated_ids.contains(&p.id))
        .map(|p| {
            // 已安装检测以实际 npm 包名为准：预设可显式声明 package（scoped 包
            // 名与预设 id 不一致时），未声明则回落到 id。
            let is_installed = installed.contains(installed_name(&p));
            // 超出支持上限的预设仍留在清单里：界面置灰并给出「不支持当前核心」，
            // 而不是静默消失，用户才能理解插件为何不再可选。
            let unsupported = p.unsupported_on(core_version.as_deref());
            PreinstallPlugin {
                id: p.id,
                name: p.name,
                description: p.description,
                repo_url: p.repo_url,
                recommended: p.recommended,
                fix: p.fix,
                default_checked: p.default_checked,
                default_unchecked: p.default_unchecked,
                installed: is_installed,
                unsupported,
            }
        })
        .collect()
}

const NPMRC_KEY: &str = "confirmModulesPurge=false";

/// 在给定 `.npmrc` 路径上写入 `confirmModulesPurge=false`（幂等合并）。
///
/// 拆出纯路径版便于单元测试（不依赖 AppHandle）；`ensure_profile_npmrc` 仅负责
/// 把 profile 路径传进来。
pub(crate) fn ensure_npmrc_at(npmrc_path: &PathBuf) -> Result<(), String> {
    // 读取既有内容（不存在按空处理）
    let existing = match std::fs::read_to_string(npmrc_path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("NPMRC_READ_FAILED: {e}")),
    };

    // 已含目标键则无需改动（逐行精确匹配，避免重复追加）
    if existing.lines().any(|l| l.trim() == NPMRC_KEY) {
        return Ok(());
    }

    // 合并写入：保留原内容，末尾另起一行追加目标键
    let mut content = existing;
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(NPMRC_KEY);
    content.push('\n');

    if let Some(dir) = npmrc_path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("NPMRC_DIR_CREATE_FAILED: {e}"))?;
    }
    std::fs::write(npmrc_path, content).map_err(|e| format!("NPMRC_WRITE_FAILED: {e}"))?;
    log::info!("Ensured profile .npmrc: {}", npmrc_path.display());
    Ok(())
}

/// pnpm 在无 TTY 环境（dsh-market 等以子进程方式调用 pnpm 的插件 UI）下重装/更新
/// 插件时，若需要清理或重建 node_modules 会触发交互式确认，没有 TTY 就会直接中止
/// （`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`），表现为插件更新失败。
///
/// 在 profile 目录写入 `confirmModulesPurge=false` 让 pnpm 跳过该确认、直接执行，
/// 从根源上避免这类更新失败。幂等合并：若已存在相同配置或另有其它配置内容，
/// 一律原样保留，绝不覆盖用户已有的 `.npmrc`。最佳努力调用方不应让失败阻断启动。
pub(crate) fn ensure_profile_npmrc(app_handle: &AppHandle) -> Result<(), String> {
    ensure_npmrc_at(&profile_dir(app_handle).join(".npmrc"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_npmrc(label: &str) -> PathBuf {
        std::env::temp_dir()
            .join(format!("dsh-npmrc-test-{}-{label}", std::process::id()))
            .join(".npmrc")
    }

    #[test]
    fn npmrc_created_when_missing() {
        let path = temp_npmrc("created");
        let _ = std::fs::remove_file(&path);
        ensure_npmrc_at(&path).unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.lines().any(|l| l.trim() == NPMRC_KEY));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn npmrc_preserves_existing_content_and_is_idempotent() {
        let path = temp_npmrc("preserve");
        let _ = std::fs::remove_file(&path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "registry=https://registry.npmjs.org/\n").unwrap();

        // 首次：保留既有配置并追加目标键
        ensure_npmrc_at(&path).unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("registry=https://registry.npmjs.org/"));
        assert_eq!(content.matches(NPMRC_KEY).count(), 1);

        // 再次调用：幂等，不重复追加
        ensure_npmrc_at(&path).unwrap();
        let content2 = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("registry=https://registry.npmjs.org/"));
        assert_eq!(content2.matches(NPMRC_KEY).count(), 1);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn list_installed_parses_manifest() {
        let dir = std::env::temp_dir().join(format!("dsh-plugin-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let manifest_json = serde_json::json!({
            "name": "dsh-profile-web",
            "private": true,
            "dependencies": {
                "dshmarket": "1.0.0",
                "@deepseek-ai/dsh-base": "1.0.0"
            },
            "dsh": {
                "profile": {
                    "bundles": ["@deepseek-ai/dsh-base", "dshmarket"]
                }
            }
        });
        std::fs::write(
            dir.join("package.json"),
            serde_json::to_string(&manifest_json).unwrap(),
        )
        .unwrap();

        let content = std::fs::read_to_string(dir.join("package.json")).unwrap();
        let parsed: ProfilePackageJson = serde_json::from_str(&content).unwrap();

        let mut set: HashSet<String> = parsed.dependencies.into_keys().collect();
        if let Some(dsh) = parsed.dsh {
            if let Some(profile) = dsh.profile {
                set.extend(profile.bundles);
            }
        }

        assert!(set.contains("dshmarket"));
        assert!(set.contains("@deepseek-ai/dsh-base"));
        assert_eq!(set.len(), 2);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn installed_name_resolves_package_else_id() {
        let installed = PreinstallPluginInfo {
            id: "dsh-session-context-menu".into(),
            spec: "github:baihejiangnan/dsh-session-context-menu".into(),
            package: Some("@baihejiangnan/dsh-session-context-menu".into()),
            name: "DSH Session Context Menu".into(),
            description: String::new(),
            repo_url: String::new(),
            recommended: false,
            fix: false,
            default_checked: true,
            default_unchecked: false,
            version: None,
            win_only: false,
            internal: false,
        };
        // scoped 包名与预设 id 不同：以 package 为准
        assert_eq!(
            installed_name(&installed),
            "@baihejiangnan/dsh-session-context-menu"
        );

        // 未声明 package 时回落到 id
        let plain = PreinstallPluginInfo {
            package: None,
            ..installed
        };
        assert_eq!(installed_name(&plain), "dsh-session-context-menu");
    }
}
