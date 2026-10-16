//! 依赖映射表：`<AppData>[/dev]/dependencies.json`。
//!
//! 桌面端不再假设 node/pnpm/dsh 一定装在固定的 AppData 路径下，而是把每个依赖
//! 的**安装根**记在映射表里：
//!
//! - 路径 → 使用该根（可为任意绝对路径，或 `resources/...` 令牌，见
//!   [`super::manifest::resolve_location_from`]）；
//! - `null` → 由系统环境满足，桌面端不托管该依赖；
//! - 键缺失 → 尚未探测，按清单的 `managedRoot` 默认托管根解析。
//!
//! 入口相对路径由清单 `dependencies.<key>.entry` 决定，因此「装在哪」与「入口形状」
//! 各有一处真值。将来做本地捆绑版只需把清单（或映射表）指向 `resources/*`，路径解析
//! 逻辑无需改动。写入单点收口到 [`record`]，且内容不变时不落盘。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Runtime};

use super::manifest;

/// 映射表文件名（debug 构建与其它依赖同处 `<base>/dev/` 之下）
pub const MAPPING_FILE: &str = "dependencies.json";

/// 逻辑依赖键
pub const DEP_NODE: &str = "node";
pub const DEP_PNPM: &str = "pnpm";
pub const DEP_DSH: &str = "dsh";
pub const DEP_GIT: &str = "git";

/// 读-改-写映射表的进程内互斥：多处（安装、检测、核心切换）都会写同一文件
static MAPPING_LOCK: Mutex<()> = Mutex::new(());

/// 映射表内容：键 → 安装根（`null` = 系统环境）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DependencyMapping(pub BTreeMap<String, Option<String>>);

impl DependencyMapping {
    /// 单键映射：`Some(None)` = 系统环境，`Some(Some(path))` = 指定根，`None` = 未记录
    pub fn get(&self, key: &str) -> Option<Option<PathBuf>> {
        self.0
            .get(key)
            .map(|value| value.as_ref().map(PathBuf::from))
    }

    /// 记录单键（`None` = 系统环境）
    pub fn set(&mut self, key: &str, value: Option<PathBuf>) {
        self.0.insert(
            key.to_string(),
            value.map(|path| path.to_string_lossy().into_owned()),
        );
    }
}

/// 映射表文件路径
pub fn mapping_path<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    super::runtime::get_base_dir(app).join(MAPPING_FILE)
}

/// 解析缓存：映射表在解析热路径上被反复读取（每个 `get_*_install_path`），按
/// 「路径 + mtime」命中即复用；写盘后由 [`write_mapping`] 直接刷新缓存。
static CACHE: Mutex<Option<(PathBuf, u64, DependencyMapping)>> = Mutex::new(None);

fn cached(path: &Path, stamp: u64) -> Option<DependencyMapping> {
    let guard = CACHE.lock().unwrap_or_else(|error| error.into_inner());
    guard
        .as_ref()
        .filter(|(cached_path, cached_stamp, _)| cached_path == path && *cached_stamp == stamp)
        .map(|(_, _, mapping)| mapping.clone())
}

fn store_cache(path: &Path, stamp: u64, mapping: &DependencyMapping) {
    let mut guard = CACHE.lock().unwrap_or_else(|error| error.into_inner());
    *guard = Some((path.to_path_buf(), stamp, mapping.clone()));
}

/// 读取映射表；缺失/损坏时返回空表（解析失败只告警，绝不阻断启动）
pub fn read_mapping<R: Runtime>(app: &AppHandle<R>) -> DependencyMapping {
    read_mapping_cached(&mapping_path(app))
}

fn read_mapping_cached(path: &Path) -> DependencyMapping {
    let stamp = super::file_stamp(path);
    if let Some(mapping) = cached(path, stamp) {
        return mapping;
    }
    let mapping = read_mapping_at(path);
    store_cache(path, stamp, &mapping);
    mapping
}

pub(crate) fn read_mapping_at(path: &Path) -> DependencyMapping {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return DependencyMapping::default();
    };
    match serde_json::from_str(&raw) {
        Ok(mapping) => mapping,
        Err(error) => {
            log::warn!(
                "DEPENDENCY_MAPPING_INVALID: {}: {error}; falling back to manifest defaults",
                path.display()
            );
            DependencyMapping::default()
        }
    }
}

/// 落盘（原子替换：同目录临时文件 + rename）。内容未变化时不写盘。
pub fn write_mapping<R: Runtime>(
    app: &AppHandle<R>,
    mapping: &DependencyMapping,
) -> Result<(), String> {
    let path = mapping_path(app);
    let body = serde_json::to_string_pretty(mapping).map_err(|error| error.to_string())?;
    if std::fs::read_to_string(&path).is_ok_and(|current| current == body) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("DEPENDENCY_MAPPING_WRITE_FAILED: {error}"))?;
    }
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, &body)
        .map_err(|error| format!("DEPENDENCY_MAPPING_WRITE_FAILED: {error}"))?;
    std::fs::rename(&temp, &path).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        format!("DEPENDENCY_MAPPING_WRITE_FAILED: {error}")
    })?;
    // 同一秒内的写入可能不改变 mtime 粒度，这里显式刷新缓存而不是依赖文件时间。
    store_cache(&path, super::file_stamp(&path), mapping);
    Ok(())
}

/// 记录单个依赖的安装根（`None` = 系统环境）。
///
/// 映射表的唯一写入口；写入失败只告警——解析链路在下次启动时按清单默认根兜底，
/// 不该因为一次落盘失败阻断安装/启动。
pub fn record<R: Runtime>(app: &AppHandle<R>, key: &str, value: Option<PathBuf>) {
    let _guard = MAPPING_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let current = read_mapping(app);
    let mut next = current.clone();
    next.set(key, value);
    if next.0 == current.0 {
        return;
    }
    if let Err(error) = write_mapping(app, &next) {
        log::warn!("DEPENDENCY_MAPPING_RECORD_FAILED: {key}: {error}");
    } else {
        log::info!(
            "dependency mapping updated: {key} = {}",
            next.0
                .get(key)
                .and_then(|value| value.clone())
                .unwrap_or_else(|| "<system>".to_string())
        );
    }
}

/// 单键映射（见 [`DependencyMapping::get`]）
pub fn mapped<R: Runtime>(app: &AppHandle<R>, key: &str) -> Option<Option<PathBuf>> {
    read_mapping(app).get(key)
}

/// 清单声明的默认托管根（映射未记录或为系统时使用）
pub fn managed_root<R: Runtime>(app: &AppHandle<R>, key: &str) -> PathBuf {
    let base = super::runtime::get_base_dir(app);
    let resources = manifest::resource_root(app);
    manifest::with_manifest(app, |manifest| {
        managed_root_from(&base, resources.as_deref(), Some(manifest), key)
    })
    .unwrap_or_else(|| managed_root_from(&base, resources.as_deref(), None, key))
}

pub(crate) fn managed_root_from(
    base: &Path,
    resources: Option<&Path>,
    manifest: Option<&manifest::Manifest>,
    key: &str,
) -> PathBuf {
    match manifest
        .and_then(|manifest| manifest.dependencies.get(key))
        .and_then(|spec| spec.managed_root.as_deref())
    {
        Some(raw) => manifest::resolve_location_from(base, resources, raw),
        None => base.join(default_managed_root(key)),
    }
}

/// 当前生效的依赖根：映射指定的根优先，否则回落清单默认托管根
///
/// 映射表里的值同样按 [`manifest::resolve_location_from`] 解析：绝对路径原样使用（任意
/// 位置），`$AppData/...` / `$Resources/...` 指向数据目录 / 安装包资源根。因此本地
/// 捆绑 / 切换内核只需在映射表里写 `"dsh": "$Resources/dsh"` 或任意绝对路径，不必
/// 改动清单或重装。
///
/// 清单把 `dependencies.<key>.overridable` 声明为 false 时，映射表记录的位置一律
/// 被忽略（本地捆绑版内核固定随包，不允许被运行时改写）。
///
/// 记录的位置**已不存在**时同样按「未记录」处理：离线包（随包资源）升级、用户手工
/// 删除下载的核心目录都会留下悬空记录，继续采信会让就绪判定把可用资源判成缺失，
/// 进而转去联网下载。此时回落到清单托管根——普通安装的托管根与记录值本就同路，
/// 悬空回落不影响既有行为。
pub fn active_root<R: Runtime>(app: &AppHandle<R>, key: &str) -> PathBuf {
    let base = super::runtime::get_base_dir(app);
    let resources = manifest::resource_root(app);
    let mapping = read_mapping(app);
    manifest::with_manifest(app, |manifest| {
        active_root_from(&base, resources.as_deref(), Some(manifest), &mapping, key)
    })
    .unwrap_or_else(|| active_root_from(&base, resources.as_deref(), None, &mapping, key))
}

pub(crate) fn active_root_from(
    base: &Path,
    resources: Option<&Path>,
    manifest: Option<&manifest::Manifest>,
    mapping: &DependencyMapping,
    key: &str,
) -> PathBuf {
    let overridable = manifest
        .and_then(|manifest| manifest.dependencies.get(key))
        .is_none_or(|spec| spec.overridable);
    if overridable {
        if let Some(Some(recorded)) = mapping.get(key) {
            let resolved =
                manifest::resolve_location_from(base, resources, &recorded.to_string_lossy());
            if resolved.exists() {
                return resolved;
            }
        }
    }
    managed_root_from(base, resources, manifest, key)
}

/// 随包资源构建的随包核心根（`$Resources/dsh`）；非随包构建为 None。
///
/// 这类安装的运行时全部随安装包分发（见 `.github/actions/prepare-bundle-resources`），
/// 运行期下载在离线机器上必然失败：启动就绪判定据此放宽「补不上的依赖」，核心面板据此
/// 把随包内核作为「本地」项置顶。
///
/// 判定按**清单托管根**而不是当前生效根：随包核心始终是安装目录里那一份，与该依赖
/// 当前是否被映射到别处的槽位无关。
pub fn bundled_core_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let root = manifest::resource_root(app)?;
    let managed = managed_root(app, DEP_DSH);
    // 资源根自身不算：只有把核心托管到 `$Resources/<name>` 才是随包构建。
    (managed != root && managed.starts_with(&root)).then_some(managed)
}

/// 入口相对路径（相对依赖根）：清单 `dependencies.<key>.entry`，未声明时用内置默认
pub fn entry_relative<R: Runtime>(app: &AppHandle<R>, key: &str) -> PathBuf {
    manifest::with_manifest(app, |manifest| entry_relative_from(Some(manifest), key))
        .unwrap_or_else(|| entry_relative_from(None, key))
}

pub(crate) fn entry_relative_from(manifest: Option<&manifest::Manifest>, key: &str) -> PathBuf {
    let declared = manifest
        .and_then(|manifest| manifest.dependencies.get(key))
        .and_then(|spec| spec.entry.resolve());
    split_entry(declared.unwrap_or_else(|| default_entry(key)))
}

/// 当前生效的依赖入口绝对路径（不校验存在性）
pub fn binary_path<R: Runtime>(app: &AppHandle<R>, key: &str) -> PathBuf {
    active_root(app, key).join(entry_relative(app, key))
}

/// 入口路径 → 相对路径（统一分隔符；`/` 与 `\` 都接受）
fn split_entry(raw: &str) -> PathBuf {
    raw.split(['/', '\\'])
        .filter(|segment| !segment.is_empty())
        .collect()
}

fn default_managed_root(key: &str) -> &'static str {
    match key {
        DEP_NODE => "runtime",
        DEP_PNPM => "dependencies/pnpm",
        DEP_DSH => "dependencies/dsh",
        DEP_GIT => "dependencies/git",
        _ => "dependencies",
    }
}

fn default_entry(key: &str) -> &'static str {
    match key {
        DEP_NODE => {
            if cfg!(windows) {
                "node.exe"
            } else {
                "bin/node"
            }
        }
        DEP_PNPM => "bin/pnpm.cjs",
        DEP_DSH => "node_modules/@deepseek-ai/dsh/lib/bin.js",
        DEP_GIT => {
            if cfg!(windows) {
                "cmd/git.exe"
            } else {
                "bin/git"
            }
        }
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "dsh-deps-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ))
    }

    #[test]
    fn mapping_round_trips_system_and_path_roots() {
        let dir = temp_path("mapping");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(MAPPING_FILE);

        let mut mapping = DependencyMapping::default();
        mapping.set(DEP_NODE, Some(PathBuf::from("C:/app/runtime")));
        mapping.set(DEP_PNPM, None);
        std::fs::write(&file, serde_json::to_string_pretty(&mapping).unwrap()).unwrap();

        let read = read_mapping_at(&file);
        assert_eq!(
            read.get(DEP_NODE),
            Some(Some(PathBuf::from("C:/app/runtime")))
        );
        assert_eq!(read.get(DEP_PNPM), Some(None));
        assert_eq!(read.get(DEP_DSH), None);
        assert!(read.get(DEP_NODE).is_some_and(|value| value.is_some()));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn invalid_mapping_falls_back_to_empty_table() {
        let dir = temp_path("invalid");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(MAPPING_FILE);
        std::fs::write(&file, "{ not json").unwrap();
        assert!(read_mapping_at(&file).0.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn root_resolution_preserves_mapping_and_manifest_precedence() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("data");
        let resources = dir.path().join("resources");
        std::fs::create_dir_all(resources.join("mapped")).unwrap();
        let mut manifest = manifest::parse(
            r#"{"dependencies":{"dsh":{"managedRoot":"$AppData/default-core","overridable":true,"entry":"lib\\bin.js"}}}"#,
        )
        .unwrap();
        let mut mapping = DependencyMapping::default();
        let resolve = |manifest: Option<&manifest::Manifest>, mapping: &DependencyMapping| {
            active_root_from(&base, Some(&resources), manifest, mapping, DEP_DSH)
        };
        assert_eq!(
            resolve(Some(&manifest), &mapping),
            base.join("default-core")
        );
        mapping.set(DEP_DSH, None);
        assert_eq!(
            resolve(Some(&manifest), &mapping),
            base.join("default-core")
        );
        mapping.set(DEP_DSH, Some("$Resources/missing".into()));
        assert_eq!(
            resolve(Some(&manifest), &mapping),
            base.join("default-core")
        );
        mapping.set(DEP_DSH, Some("$Resources/mapped".into()));
        assert_eq!(resolve(Some(&manifest), &mapping), resources.join("mapped"));
        manifest.dependencies.get_mut(DEP_DSH).unwrap().overridable = false;
        assert_eq!(
            resolve(Some(&manifest), &mapping),
            base.join("default-core")
        );
        assert_eq!(resolve(None, &mapping), resources.join("mapped"));
        mapping.set(DEP_DSH, Some("$AppData/missing".into()));
        assert_eq!(resolve(None, &mapping), base.join("dependencies/dsh"));
        assert_eq!(
            managed_root_from(&base, None, Some(&manifest), DEP_DSH),
            base.join("default-core")
        );
        assert_eq!(
            entry_relative_from(Some(&manifest), DEP_DSH),
            PathBuf::from("lib").join("bin.js")
        );
        assert_eq!(
            entry_relative_from(None, DEP_PNPM),
            PathBuf::from("bin").join("pnpm.cjs")
        );
    }

    #[test]
    fn entry_split_accepts_both_separators() {
        assert_eq!(
            split_entry("bin/pnpm.cjs"),
            PathBuf::from("bin").join("pnpm.cjs")
        );
        assert_eq!(
            split_entry(r"node_modules\@deepseek-ai\dsh\lib\bin.js"),
            PathBuf::from("node_modules")
                .join("@deepseek-ai")
                .join("dsh")
                .join("lib")
                .join("bin.js")
        );
        assert_eq!(split_entry("node.exe"), PathBuf::from("node.exe"));
    }

    #[test]
    fn default_roots_and_entries_match_the_manifest_spec() {
        assert_eq!(default_managed_root(DEP_NODE), "runtime");
        assert_eq!(default_managed_root(DEP_PNPM), "dependencies/pnpm");
        assert_eq!(default_managed_root(DEP_DSH), "dependencies/dsh");
        assert_eq!(default_entry(DEP_PNPM), "bin/pnpm.cjs");
        assert_eq!(
            default_entry(DEP_DSH),
            "node_modules/@deepseek-ai/dsh/lib/bin.js"
        );
        assert_eq!(
            default_entry(DEP_GIT),
            if cfg!(windows) {
                "cmd/git.exe"
            } else {
                "bin/git"
            }
        );
    }

    #[test]
    fn shipped_manifest_matches_builtin_defaults() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(manifest::MANIFEST_FILE);
        let manifest = manifest::read_at(&path).expect("manifest should parse");
        // 清单声明的托管根可以是 `$AppData/...` 令牌，因此比较**解析后**的位置
        let base = PathBuf::from("C:/app-data");
        let resources = PathBuf::from("C:/app-resources");
        for (key, root, entry) in [
            (
                DEP_NODE,
                default_managed_root(DEP_NODE),
                default_entry(DEP_NODE),
            ),
            (
                DEP_PNPM,
                default_managed_root(DEP_PNPM),
                default_entry(DEP_PNPM),
            ),
            (
                DEP_DSH,
                default_managed_root(DEP_DSH),
                default_entry(DEP_DSH),
            ),
            (
                DEP_GIT,
                default_managed_root(DEP_GIT),
                default_entry(DEP_GIT),
            ),
        ] {
            let spec = manifest.dependencies.get(key).expect("spec should exist");
            let declared = spec.managed_root.as_deref().expect("managedRoot");
            assert_eq!(
                manifest::resolve_location_from(&base, Some(&resources), declared),
                base.join(root),
                "{key}"
            );
            assert_eq!(spec.entry.resolve(), Some(entry), "{key}");
        }
    }
}
