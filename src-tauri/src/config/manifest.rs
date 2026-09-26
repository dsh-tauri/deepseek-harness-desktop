//! 资源清单（`resources/manifest.jsonc`）：引擎版本、插件目录、预设宠物与依赖
//! 映射规范的唯一真值来源。
//!
//! 定位顺序按构建区分：debug 优先源码 `resources/`（构建产物中的资源可能过期），
//! release 优先随安装包分发的资源目录，两者互为兜底。清单缺失/损坏只记日志并回落
//! 空清单——插件与宠物目录不是启动硬依赖；依赖映射的读写见 [`super::dependencies`]。

use serde::Deserialize;
use std::collections::BTreeMap;
use std::env;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime};

/// 资源清单文件名
pub const MANIFEST_FILE: &str = "manifest.jsonc";

/// 资源清单根结构
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Manifest {
    pub engines: Engines,
    pub plugins: Plugins,
    pub pets: Pets,
    pub dependencies: BTreeMap<String, DependencySpec>,
}

/// 引擎版本声明（仅消费 `dsh`；node/pnpm/git 为发布侧声明，运行期常量另见 constants）
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Engines {
    pub dsh: DshEngine,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct DshEngine {
    /// 推荐核心版本（更新提示与「高于推荐版本」标记用）
    pub recommend: String,
    /// 最低支持核心版本（低于它的核心不参与本地优先）
    pub minimum: String,
}

#[derive(Debug, Clone, Default, serde::Serialize, Deserialize)]
#[serde(default)]
pub struct Plugins {
    /// 弃用插件 id（清单键为历史拼写 `depercated`）
    #[serde(rename = "depercated")]
    pub deprecated: Vec<String>,
    /// 随包内置插件
    #[serde(rename = "built-in")]
    pub built_in: Vec<PluginEntry>,
    /// 社区预设插件
    pub preset: Vec<PluginEntry>,
}

/// 插件清单条目
#[derive(Debug, Clone, Default, serde::Serialize, Deserialize)]
#[serde(default)]
pub struct PluginEntry {
    pub id: String,
    pub spec: String,
    pub name: String,
    pub description: String,
    /// 仓库地址（历史字段名 `repoUrl`）
    pub repo: String,
    /// profile `dependencies`/`bundles` 中的实际包名；缺省与 `id` 相同
    pub package: Option<String>,
    pub recommended: bool,
    /// 「修复」类项（Windows 极简模式），默认勾选
    pub fix: bool,
    /// 首次引导默认勾选
    pub checked: bool,
    /// 仅 Windows 列出
    #[serde(rename = "winOnly")]
    pub win_only: bool,
    /// 版本区间声明：`"latest"` 字符串或（插件版本区间 ↔ 核心版本区间）配对矩阵
    #[serde(default, deserialize_with = "deserialize_version")]
    pub version: Option<PluginVersion>,
}

/// 插件版本声明
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(untagged)]
pub enum PluginVersion {
    /// 无区间语义的字符串声明（如 `"latest"`）
    Declared(String),
    /// （插件版本区间 ↔ 核心版本区间）配对矩阵
    Matrix(Vec<VersionPair>),
}

/// 版本配对：`dsh` 核心区间命中时，兼容的插件版本为 `version` 区间
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, Deserialize)]
pub struct VersionPair {
    pub version: String,
    pub dsh: String,
}

/// 区间是否命中给定版本（区间无法解析时视为不命中）
fn req_matches(req: &str, version: &semver::Version) -> bool {
    parse_req(req).is_some_and(|req| req.matches(version))
}

/// 解析区间声明，兼容 npm 风格的空格分隔多比较符。
///
/// 清单按 npm 习惯书写（`>=0.1.7-rc.1 <0.1.7-rc.5`），而 `semver` crate 只认逗号
/// 分隔、且不允许运算符与版本之间有空格：这里把两类写法都归一到 `a,b` 形式，
/// 无法解析时返回 None（调用方按「不做判定」处理，避免手误把插件误标不兼容）。
fn parse_req(raw: &str) -> Option<semver::VersionReq> {
    let mut parts: Vec<String> = Vec::new();
    let mut pending: Option<String> = None;
    for token in raw.split_whitespace() {
        let token = token.trim_matches(',');
        if token.is_empty() {
            continue;
        }
        if matches!(token, ">" | ">=" | "<" | "<=" | "=" | "^" | "~") {
            pending = Some(token.to_string());
            continue;
        }
        match pending.take() {
            Some(op) => parts.push(format!("{op}{token}")),
            None => parts.push(token.to_string()),
        }
    }
    if pending.is_some() || parts.is_empty() {
        return None;
    }
    semver::VersionReq::parse(&parts.join(",")).ok()
}

impl PluginVersion {
    /// 当前核心命中的插件版本区间（没有任何 `dsh` 区间命中时为 None）。
    ///
    /// 矩阵按**升序阶梯**声明（越靠后的一代越新）。较旧的区间通常对上界开放
    /// （如 `^0.1.5-rc.1` 覆盖整个 0.1.x），因此 release 核心可能同时落在多条区间内；
    /// 此时必须取**最后**一条命中规则，否则会把新插件按旧一代的推荐区间钉版本。
    pub fn plugin_req_for_core(&self, core: Option<&str>) -> Option<&str> {
        let PluginVersion::Matrix(pairs) = self else {
            return None;
        };
        let core = semver::Version::parse(core?).ok()?;
        pairs
            .iter()
            .rev()
            .find(|pair| req_matches(&pair.dsh, &core))
            .map(|pair| pair.version.as_str())
    }

    /// 核心是否已超出矩阵声明的全部 `dsh` 区间（无矩阵或版本不可解析时为 false）
    ///
    /// 全部区间都能解析、且没有一条命中该核心才算「不兼容当前核心」；任一条区间写错
    /// 时不做判定（宁可显示兼容，也不让手误把插件在界面上误标）。
    pub fn unsupported_on(&self, core: Option<&str>) -> bool {
        let PluginVersion::Matrix(pairs) = self else {
            return false;
        };
        let Some(Ok(core)) = core.map(semver::Version::parse) else {
            return false;
        };
        let mut declared = false;
        for pair in pairs {
            let Some(req) = parse_req(&pair.dsh) else {
                return false;
            };
            declared = true;
            if req.matches(&core) {
                return false;
            }
        }
        declared
    }

    /// 已安装版本是否属于核心当前那一代（`None` = 无法判定：没有命中区间，或版本 /
    /// 区间无法解析）
    pub fn installed_matches_core_generation(
        &self,
        core: Option<&str>,
        installed: Option<&str>,
    ) -> Option<bool> {
        let req = parse_req(self.plugin_req_for_core(core)?)?;
        let installed = semver::Version::parse(installed?).ok()?;
        Some(req.matches(&installed))
    }

    /// 已安装版本是否落在矩阵声明的任一同代区间内（核心已超出时的清理判定）
    pub fn matches_any_declared(&self, installed: Option<&str>) -> bool {
        let PluginVersion::Matrix(pairs) = self else {
            return false;
        };
        let Some(Ok(installed)) = installed.map(semver::Version::parse) else {
            return false;
        };
        pairs
            .iter()
            .any(|pair| req_matches(&pair.version, &installed))
    }
}

fn deserialize_version<'de, D>(deserializer: D) -> Result<Option<PluginVersion>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Raw {
        Declared(String),
        Matrix(Vec<VersionPair>),
    }
    Ok(match Option::<Raw>::deserialize(deserializer)? {
        None => None,
        Some(Raw::Declared(value)) => Some(PluginVersion::Declared(value)),
        Some(Raw::Matrix(pairs)) => Some(PluginVersion::Matrix(pairs)),
    })
}

/// 预设宠物目录
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Pets {
    #[serde(rename = "built-in")]
    pub built_in: Vec<PresetPetSpec>,
}

/// 预设宠物条目：字段名与 `dsh-pet-component` 的 props 一一对应，前端拿到后直接
/// 展开给 `<Pet>`；`deny_unknown_fields` 保证清单写错字段（如 `sizeMB`）立即报错。
#[derive(Debug, Clone, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresetPetSpec {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desc: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<f64>,
    pub config: String,
    pub uri: PresetPetUri,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ext: Option<PresetPetExt>,
}

/// 素材基地址：`default` 必填，`mac` 覆盖 Apple 平台（WKWebView 不认 VP9-alpha）
#[derive(Debug, Clone, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresetPetUri {
    pub default: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mac: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresetPetExt {
    pub default: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mac: Option<String>,
}

/// 依赖映射规范：入口相对路径与默认托管根
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DependencySpec {
    /// 入口相对路径（相对依赖根），按平台覆盖：`default` / `windows` / `macos` / `linux`
    pub entry: EntrySpec,
    /// AppData 下的默认托管根（相对 AppData 基础目录，或 `resources/...`）
    pub managed_root: Option<String>,
    /// 是否允许运行期覆盖为任意位置
    pub overridable: bool,
}

/// 入口路径声明：单一路径字符串或按平台映射
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum EntrySpec {
    Single(String),
    Platform(BTreeMap<String, String>),
    #[default]
    Empty,
}

impl<'de> Deserialize<'de> for EntrySpec {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Single(String),
            Platform(BTreeMap<String, String>),
        }
        Ok(match Option::<Raw>::deserialize(deserializer)? {
            None => EntrySpec::Empty,
            Some(Raw::Single(value)) => EntrySpec::Single(value),
            Some(Raw::Platform(map)) => EntrySpec::Platform(map),
        })
    }
}

impl EntrySpec {
    /// 当前平台的入口相对路径
    pub fn resolve(&self) -> Option<&str> {
        match self {
            EntrySpec::Single(value) => (!value.is_empty()).then_some(value.as_str()),
            EntrySpec::Platform(map) => map
                .get(env::consts::OS)
                .or_else(|| map.get("default"))
                .map(String::as_str),
            EntrySpec::Empty => None,
        }
    }
}

/// 安装包资源根：`resources/...` 位置令牌与入口路径的解析基准。
///
/// Tauri 2 在 Windows 上 `resource_dir()` 恒等于 exe 所在目录，安装包与开发产物
/// 都会把资源按 `resources/**` 前缀落盘到 `{resource_dir}/resources/` 子目录，
/// 因此实际资源根可能是该子目录；两处都探测不到时回落到资源目录本身。
///
/// 返回前统一剥离 Windows 扩展长度前缀：`resource_dir()` 取自
/// `tauri_utils::platform::current_exe()`（内部对 exe 路径做了 canonicalize），
/// 在 Windows 上带 `\\?\` verbatim 前缀。该前缀会随依赖托管根（`$Resources/dsh`
/// 等）拼进入口路径，而随包内核的入口要交给 node 当主模块：node 的
/// `resolveMainPath` 解析 verbatim 路径会直接以
/// `EISDIR: illegal operation on a directory, lstat 'C:'` 退出（Node 25 实测），
/// 随包核心因此永远起不来。CLI shim 也会把这个前缀写进 `.cmd`，同样要归一化。
pub fn resource_root<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?;
    Some(simplify_resource_root(pick_resource_root(&dir).unwrap_or(dir)))
}

/// 归一化资源根：`dunce::simplified` 剥掉 Windows 的 `\\?\` 前缀（非 Windows 为 no-op），
/// 不改动文件系统、也不要求路径存在。
fn simplify_resource_root(path: PathBuf) -> PathBuf {
    dunce::simplified(&path).to_path_buf()
}

/// 资源根探测顺序：扁平布局（exe 同级）优先，再 `resources/` 子目录布局。
fn pick_resource_root(dir: &Path) -> Option<PathBuf> {
    if dir.join(MANIFEST_FILE).is_file() {
        return Some(dir.to_path_buf());
    }
    let nested = dir.join("resources");
    nested.join(MANIFEST_FILE).is_file().then_some(nested)
}

fn source_manifest_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join(MANIFEST_FILE)
}

/// 定位资源清单：debug 优先当前 checkout，release 优先进安装包资源。
pub fn manifest_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    let packaged = resource_root(app).map(|root| root.join(MANIFEST_FILE));
    let source = source_manifest_path();
    if cfg!(debug_assertions) {
        candidates.push(source.clone());
        candidates.extend(packaged.clone());
    } else {
        candidates.extend(packaged.clone());
        candidates.push(source.clone());
    }
    candidates.into_iter().find(|path| path.is_file())
}

/// 解析结果缓存：清单是热路径（核心来源判定、插件清单、宠物列表、依赖映射都要读），
/// 按「路径 + mtime」命中即复用解析结果；debug 下编辑清单会因 mtime 变化而重载。
static CACHE: std::sync::Mutex<Option<(PathBuf, u64, Manifest)>> = std::sync::Mutex::new(None);

/// 在缓存命中的清单上取值；缺失/损坏时返回 None。
///
/// 缓存锁在闭包执行期间持有，因此闭包内**不得**再次调用本模块的读取接口
/// （std 互斥锁不可重入）。
pub fn with_manifest<R: Runtime, T>(
    app: &AppHandle<R>,
    pick: impl FnOnce(&Manifest) -> T,
) -> Option<T> {
    let path = match manifest_path(app) {
        Some(path) => path,
        None => {
            log::warn!("RESOURCE_MANIFEST_MISSING: {MANIFEST_FILE} not found in resource dir or source resources dir");
            return None;
        }
    };
    let stamp = super::file_stamp(&path);
    let mut guard = CACHE.lock().unwrap_or_else(|error| error.into_inner());
    let fresh = matches!(
        guard.as_ref(),
        Some((cached_path, cached_stamp, _)) if cached_path == &path && *cached_stamp == stamp
    );
    if !fresh {
        match read_at(&path) {
            Ok(manifest) => *guard = Some((path.clone(), stamp, manifest)),
            Err(error) => {
                log::error!("RESOURCE_MANIFEST_INVALID: {}: {error}", path.display());
                return None;
            }
        }
    }
    guard.as_ref().map(|(_, _, manifest)| pick(manifest))
}

/// 读取并解析资源清单；缺失/损坏时返回 None（调用方按空清单处理）
pub fn read<R: Runtime>(app: &AppHandle<R>) -> Option<Manifest> {
    with_manifest(app, Manifest::clone)
}

/// 读取指定路径的清单（单测与依赖映射共用）
pub fn read_at(path: &Path) -> Result<Manifest, String> {
    let raw = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    parse(&raw)
}

/// 解析 JSONC 文本：容忍 `//`、`/* */` 注释与尾逗号
pub fn parse(raw: &str) -> Result<Manifest, String> {
    let stripped = strip_jsonc(raw);
    serde_json::from_str(&stripped).map_err(|error| error.to_string())
}

/// 清单中的推荐 DSH 核心版本
pub fn recommended_dsh_version<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let version = with_manifest(app, |manifest| {
        manifest.engines.dsh.recommend.trim().to_string()
    })?;
    (!version.is_empty() && semver::Version::parse(&version).is_ok()).then_some(version)
}

/// 清单中的最低支持 DSH 核心版本
pub fn minimum_dsh_version<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let version = with_manifest(app, |manifest| {
        manifest.engines.dsh.minimum.trim().to_string()
    })?;
    (!version.is_empty()).then_some(version)
}

/// 版本是否高于推荐版本；任一版本无法解析时返回 false
pub fn is_above_recommended<R: Runtime>(app: &AppHandle<R>, version: &str) -> bool {
    let Some(recommended) = recommended_dsh_version(app) else {
        return false;
    };
    match (
        semver::Version::parse(version),
        semver::Version::parse(&recommended),
    ) {
        (Ok(actual), Ok(recommended)) => actual > recommended,
        _ => false,
    }
}

/// 依赖映射规范（清单缺失或未声明该键时返回 None）
pub fn dependency_spec<R: Runtime>(app: &AppHandle<R>, key: &str) -> Option<DependencySpec> {
    with_manifest(app, |manifest| manifest.dependencies.get(key).cloned())?
}

/// 位置令牌解析：`resources/...` 相对安装包资源根，其余相对 AppData 基础目录，
/// 绝对路径原样返回——依赖可以位于任意位置（AppData 托管、安装目录捆绑、
/// 或用户指定的其它盘符）。
pub fn resolve_location<R: Runtime>(app: &AppHandle<R>, raw: &str) -> PathBuf {
    resolve_location_from(
        &super::runtime::get_base_dir(app),
        resource_root(app).as_deref(),
        raw,
    )
}

/// 位置令牌解析（依赖可位于任意位置：AppData 托管、安装目录捆绑、或用户指定的其它盘符）：
///
/// - 绝对路径（`C:/...`、`/opt/...`）原样返回；
/// - `$AppData/...`（大小写不敏感）= AppData 基础目录，debug 构建即 `<base>/dev` 的同级；
/// - `$Resources/...` = 安装包资源根（`resources/` 为等价旧写法），探测不到时回落 AppData；
/// - 其余相对路径 = 相对 AppData 基础目录。
pub fn resolve_location_from(base: &Path, resource_root: Option<&Path>, raw: &str) -> PathBuf {
    let value = raw.trim();
    if PathBuf::from(value).is_absolute() {
        return PathBuf::from(value);
    }
    let normalized = value.replace('\\', "/");
    if let Some(rest) = normalized.strip_prefix("./") {
        return resolve_location_from(base, resource_root, rest);
    }
    if let Some(rest) = strip_prefix_ci(&normalized, "$appdata") {
        return join_token(base, rest);
    }
    if let Some(rest) = strip_prefix_ci(&normalized, "$resources") {
        return join_token(resource_root.unwrap_or(base), rest);
    }
    if let Some(rest) = normalized.strip_prefix("resources/") {
        if let Some(root) = resource_root {
            return join_token(root, rest);
        }
    }
    base.join(value)
}

/// 大小写不敏感前缀剥离：前缀后必须是结束或 `/`（避免 `$resourcesfoo` 被当成令牌）
fn strip_prefix_ci<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    let head = value.get(..prefix.len())?;
    if !head.eq_ignore_ascii_case(prefix) {
        return None;
    }
    let rest = &value[prefix.len()..];
    if rest.is_empty() {
        return Some(rest);
    }
    rest.strip_prefix('/')
}

/// 令牌剩余片段拼到根上（空片段取根本身）
fn join_token(root: &Path, rest: &str) -> PathBuf {
    if rest.is_empty() || rest == "." {
        return root.to_path_buf();
    }
    root.join(rest.replace('/', std::path::MAIN_SEPARATOR_STR))
}

fn strip_jsonc(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let mut out = String::with_capacity(raw.len());
    let mut i = 0;
    let mut in_string = false;
    while i < chars.len() {
        let c = chars[i];
        if in_string {
            out.push(c);
            if c == '\\' {
                if let Some(next) = chars.get(i + 1) {
                    out.push(*next);
                    i += 2;
                    continue;
                }
            } else if c == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            in_string = true;
            out.push(c);
            i += 1;
            continue;
        }
        if c == '/' && chars.get(i + 1) == Some(&'/') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && chars.get(i + 1) == Some(&'*') {
            i += 2;
            while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            i = (i + 2).min(chars.len());
            continue;
        }
        out.push(c);
        i += 1;
    }
    strip_trailing_commas(&out)
}

fn strip_trailing_commas(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let mut out = String::with_capacity(raw.len());
    let mut i = 0;
    let mut in_string = false;
    while i < chars.len() {
        let c = chars[i];
        if in_string {
            out.push(c);
            if c == '\\' {
                if let Some(next) = chars.get(i + 1) {
                    out.push(*next);
                    i += 2;
                    continue;
                }
            } else if c == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            in_string = true;
            out.push(c);
            i += 1;
            continue;
        }
        if c == ',' {
            let mut j = i + 1;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            if matches!(chars.get(j), Some('}') | Some(']')) {
                i += 1;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shipped_manifest() -> Manifest {
        parse(&std::fs::read_to_string(source_manifest_path()).expect("manifest should exist"))
            .expect("shipped manifest should be valid")
    }

    #[test]
    fn shipped_manifest_carries_engines_plugins_pets_and_dependencies() {
        let manifest = shipped_manifest();
        assert_eq!(manifest.engines.dsh.recommend, "0.1.7-rc.2");
        assert_eq!(manifest.engines.dsh.minimum, "0.1.5-rc.1");
        assert!(!manifest.plugins.preset.is_empty());
        assert!(!manifest.plugins.built_in.is_empty());
        assert!(!manifest.plugins.deprecated.is_empty());
        assert!(!manifest.pets.built_in.is_empty());
        for key in ["node", "pnpm", "dsh", "git"] {
            assert!(
                manifest.dependencies.contains_key(key),
                "依赖映射规范缺少 {key}"
            );
        }
    }

    #[test]
    fn dependency_entries_resolve_per_platform() {
        let manifest = shipped_manifest();
        let node = &manifest.dependencies["node"];
        assert!(node.managed_root.is_some());
        assert!(node.overridable);
        assert!(node.entry.resolve().is_some());

        let pnpm = &manifest.dependencies["pnpm"];
        assert_eq!(pnpm.entry.resolve(), Some("bin/pnpm.cjs"));

        let dsh = &manifest.dependencies["dsh"];
        assert_eq!(
            dsh.entry.resolve(),
            Some("node_modules/@deepseek-ai/dsh/lib/bin.js")
        );
    }

    #[test]
    fn plugin_version_matrix_matches_core_ranges() {
        let matrix = PluginVersion::Matrix(vec![
            VersionPair {
                version: "^0.19.1".to_string(),
                dsh: "^0.1.5-rc.1".to_string(),
            },
            VersionPair {
                version: "^0.21.1".to_string(),
                dsh: "^0.1.7-rc.1".to_string(),
            },
        ]);
        assert_eq!(
            matrix.plugin_req_for_core(Some("0.1.5-rc.3")),
            Some("^0.19.1")
        );
        assert_eq!(
            matrix.plugin_req_for_core(Some("0.1.7-rc.2")),
            Some("^0.21.1")
        );
        // release 核心同时落在两条区间内：必须取最新一代规则，否则会把新插件按旧一代钉版本
        assert_eq!(matrix.plugin_req_for_core(Some("0.1.8")), Some("^0.21.1"));
        assert_eq!(matrix.plugin_req_for_core(Some("0.2.0")), None);
        assert!(!matrix.unsupported_on(Some("0.1.5-rc.3")));
        assert!(!matrix.unsupported_on(Some("0.1.8")));
        assert!(!matrix.unsupported_on(None));
        assert!(!matrix.unsupported_on(Some("not-a-version")));
        assert!(matrix.unsupported_on(Some("0.2.0")));
        assert!(matrix.matches_any_declared(Some("0.19.5")));
        assert!(matrix.matches_any_declared(Some("0.21.3")));
        assert!(!matrix.matches_any_declared(Some("0.25.0")));
        assert!(!matrix.matches_any_declared(None));
    }

    #[test]
    fn declared_version_string_is_never_unsupported() {
        let declared = PluginVersion::Declared("latest".to_string());
        assert!(!declared.unsupported_on(Some("9.9.9")));
        // 字符串声明不参与按核心钉版本（`latest` 这类标记不该拼进 spec）
        assert_eq!(declared.plugin_req_for_core(Some("9.9.9")), None);
        assert!(!declared.matches_any_declared(Some("9.9.9")));
    }

    #[test]
    fn jsonc_tolerates_comments_and_trailing_commas() {
        let raw = r#"
        {
          // 行注释
          "engines": { "dsh": { "recommend": "1.2.3", "minimum": "1.0.0" } },
          /* 块注释
             跨行 */
          "dependencies": {
            "node": { "managedRoot": "runtime", "entry": { "windows": "node.exe", }, },
          },
        }
        "#;
        let manifest = parse(raw).expect("jsonc should parse");
        assert_eq!(manifest.engines.dsh.recommend, "1.2.3");
        assert_eq!(
            manifest.dependencies["node"].entry,
            EntrySpec::Platform(BTreeMap::from([(
                "windows".to_string(),
                "node.exe".to_string()
            )]))
        );
    }

    #[test]
    fn jsonc_keeps_comment_markers_inside_strings() {
        let raw = r#"{"plugins":{"preset":[{"id":"x","spec":"x","name":"a//b/*c*/","description":"d","repo":""}]}}"#;
        let manifest = parse(raw).expect("string content must survive comment stripping");
        assert_eq!(manifest.plugins.preset[0].name, "a//b/*c*/");
    }

    #[test]
    fn resource_root_probe_prefers_flat_then_nested() {
        let dir = std::env::temp_dir().join(format!(
            "dsh-manifest-probe-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // 两处都没有 → 无资源根
        assert_eq!(pick_resource_root(&dir), None);

        // 只有嵌套布局 → 命中 `resources/` 子目录
        let nested = dir.join("resources");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join(MANIFEST_FILE), "{}").unwrap();
        assert_eq!(pick_resource_root(&dir), Some(nested.clone()));

        // 扁平布局存在 → 扁平优先（Tauri 2 的两种落盘形态同时出现时以 exe 同级为准）
        std::fs::write(dir.join(MANIFEST_FILE), "{}").unwrap();
        assert_eq!(pick_resource_root(&dir), Some(dir.clone()));

        let _ = std::fs::remove_dir_all(dir);
    }

    /// 随包资源构建（离线包）会把核心托管根指向 `$Resources/dsh`，该路径会作为
    /// node 的主模块参数。`resource_dir()` 在 Windows 上是 canonicalize 结果（带
    /// `\\?\`），而 node 的 resolveMainPath 解析 verbatim 路径会直接以
    /// `EISDIR: ... lstat 'C:'` 退出，因此资源根必须先归一化。
    #[test]
    fn resource_root_simplifies_windows_verbatim_prefix() {
        let verbatim = PathBuf::from(r"\\?\C:\app\resources\dsh");
        let simplified = simplify_resource_root(verbatim);
        if cfg!(windows) {
            assert_eq!(simplified, PathBuf::from(r"C:\app\resources\dsh"));
            assert!(!simplified.to_string_lossy().starts_with(r"\\?\"));
        } else {
            // 非 Windows 上 dunce::simplified 是 no-op，路径原样保留
            assert_eq!(simplified, PathBuf::from(r"\\?\C:\app\resources\dsh"));
        }
    }

    #[test]
    fn location_token_resolves_arbitrary_bases() {
        let base = PathBuf::from("C:/app/data");
        let resources = PathBuf::from("C:/app/resources");
        let absolute = if cfg!(windows) {
            "D:/anywhere"
        } else {
            "/anywhere"
        };

        assert_eq!(
            resolve_location_from(&base, Some(&resources), "dependencies/dsh"),
            base.join("dependencies/dsh")
        );
        assert_eq!(
            resolve_location_from(&base, Some(&resources), "resources/dsh"),
            resources.join("dsh")
        );
        assert_eq!(
            resolve_location_from(&base, Some(&resources), r"resources\node"),
            resources.join("node")
        );
        assert_eq!(
            resolve_location_from(&base, Some(&resources), absolute),
            PathBuf::from(absolute)
        );
    }

    #[test]
    fn location_prefix_tokens_are_case_insensitive_and_typed() {
        let base = PathBuf::from("C:/app/data");
        let resources = PathBuf::from("C:/app/resources");

        for raw in [
            "$AppData/runtime",
            "$appdata/runtime",
            "$APPDATA\\runtime",
            "$AppData",
        ] {
            let expected = if raw.ends_with("runtime") {
                base.join("runtime")
            } else {
                base.clone()
            };
            assert_eq!(
                resolve_location_from(&base, Some(&resources), raw),
                expected,
                "{raw}"
            );
        }

        for raw in ["$Resources/dsh", "$resources/dsh", r"$RESOURCES\dsh"] {
            assert_eq!(
                resolve_location_from(&base, Some(&resources), raw),
                resources.join("dsh"),
                "{raw}"
            );
        }

        // 资源根探测不到时回落 AppData，而不是相对当前工作目录
        assert_eq!(
            resolve_location_from(&base, None, "$Resources/dsh"),
            base.join("dsh")
        );
        // 前缀不完整（不是令牌）时按普通相对路径处理
        assert_eq!(
            resolve_location_from(&base, Some(&resources), "$resourcesfoo/dsh"),
            base.join("$resourcesfoo/dsh")
        );
    }
}
