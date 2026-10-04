//! 本地插件热重载：把用户以本地路径安装的插件源码目录折算成一组 watch root，
//! 写进桌面端独占的补丁层文件，随启动以 `--patch <文件>` 注入核心 HMR。
//!
//! 核心自带 `@deepseek-ai/dsh-hmr` 在档案下恒为启用状态，缺的只是「监听哪些目录」
//! ——`config.root` 默认为空。补上这组 root 后，本地插件源码的改动由核心 HMR 直接
//! 热重载（dispose + 重新 import + 重建插件 fiber），无需重启服务。
//!
//! 为什么单独一个文件：`$DSH_HOME/cordis.patch.yml` 与档案层 `cordis.patch.yml` 都是
//! 用户手写资产（见 [`super::patch_guard`] 的约定），桌面端只在显式恢复流程里改写。
//! HMR 是随安装状态变化的运行期状态，必须有自己的文件；该文件只在启动前复算，不被
//! 任何清理流程触碰，无本地插件时直接删除（`--patch` 指向不存在的文件会让核心大声
//! 失败，见 `dsh-app-boot` 的 `loadOverlayPatches`）。
//!
//! 三条硬约束（均为实测结论）：
//! 1. 补丁的 `config` 是整体替换（逐键浅覆盖），条目里必须写完整配置对象；
//! 2. watch root 必须是真实长路径：Windows 8.3 短名会让 chokidar 原生断言崩溃；
//! 3. 相对 root 里一旦出现 `..`，忽略规则会被拼成跨盘串而全部失效，故同盘 root 用
//!    不含 `..` 的相对路径、跨盘 root 用绝对路径。

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};

use tauri::{AppHandle, Manager};

use super::installed::{profile_dir, ProfilePackageJson};
use super::patch_guard::now_stamp;
use crate::config;

/// 桌面端独占的 HMR 补丁层文件名（与用户手写的 `cordis.patch.yml` 区分开）。
pub(crate) const HMR_PATCH_FILENAME: &str = "cordis.hmr.patch.yml";

/// 补丁条目必须逐字命中核心内置的 HMR 服务：`name` 写错会被静默跳过。
const HMR_ENTRY_ID: &str = "hmr";
const HMR_ENTRY_NAME: &str = "@deepseek-ai/dsh-hmr";

/// picomatch 的「转义反斜杠」写法 `[/\]` 需要两个真实反斜杠字符：裸反斜杠在 Windows
/// 上永不匹配（核心默认的 `**/node_modules` 在本机因此是失效的，这里连同 `cache` /
/// `data` 一起显式给出，逐条实测过 16 组路径）。
const BS: &str = "\\\\";

/// 与核心默认值一致的 debounce（毫秒）；显式写出因为 `config` 是整体替换。
const HMR_DEBOUNCE_MS: u64 = 100;

/// 当前本地插件热重载状态（前端展示用）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalHmrStatus {
    /// 用户开关的持久化值（与「此刻是否真的在监听」无关）。
    pub enabled: bool,
    /// 当前是否真的有本地插件源目录被监听（开关打开且存在待监听的目录）。
    pub watching: bool,
    /// 生效时注入的补丁层路径。
    pub patch_path: Option<String>,
    /// 被监听的本地插件源目录（真实长路径）。
    pub roots: Vec<String>,
}

/// HMR 补丁层路径（app-data 下，与用户补丁层无关）。
pub(crate) fn patch_path(app_handle: &AppHandle) -> PathBuf {
    config::get_base_dir(app_handle).join(HMR_PATCH_FILENAME)
}

/// 复算并写出 HMR 补丁层：需要热重载时返回其路径，否则删除残留并返回 `None`。
///
/// 每次启动都要重算：`--patch` 只在本次进程有效，而本地插件的安装状态可能已经变化。
/// 任何一步失败都退化为「不传 `--patch`」（热重载只是便利功能，不该阻断启动）。
pub(crate) fn sync_layer(app_handle: &AppHandle) -> Option<PathBuf> {
    let path = patch_path(app_handle);
    let roots = local_watch_roots(app_handle);
    let rendered = if hmr_enabled(app_handle) {
        render_layer(&roots)
    } else {
        None
    };
    let Some(rendered) = rendered else {
        remove_layer(&path);
        return None;
    };
    if std::fs::read_to_string(&path).is_ok_and(|current| current == rendered) {
        return Some(path);
    }
    match write_layer(&path, &rendered) {
        Ok(()) => {
            log::info!("HMR layer written: {}", path.display());
            Some(path)
        }
        Err(error) => {
            log::warn!("HMR_LAYER_WRITE_FAILED: {error}");
            None
        }
    }
}

/// 当前本地插件热重载状态。
pub(crate) fn status(app_handle: &AppHandle) -> LocalHmrStatus {
    let path = patch_path(app_handle);
    let roots = local_watch_roots(app_handle);
    let enabled = hmr_enabled(app_handle);
    LocalHmrStatus {
        enabled,
        watching: enabled && !roots.is_empty(),
        patch_path: path.exists().then(|| path.display().to_string()),
        roots: roots.iter().map(|dir| dir.display().to_string()).collect(),
    }
}

fn hmr_enabled(app_handle: &AppHandle) -> bool {
    config::read_store_dat_setting(app_handle).local_plugin_hmr
}

/// 需要热重载的本地插件源码目录：已装且已挂载（在 `dsh.profile.bundles` 里）、以
/// `link:` / `file:` 声明、目录真实存在、且不属于随包分发的内置插件。
pub(crate) fn local_watch_roots(app_handle: &AppHandle) -> Vec<PathBuf> {
    let profile = profile_dir(app_handle);
    let Some(manifest) = read_manifest(&profile) else {
        return Vec::new();
    };
    watch_roots_in(&profile, &manifest, |_name, dir| {
        is_bundled(app_handle, dir)
    })
}

fn watch_roots_in(
    profile: &Path,
    manifest: &ProfilePackageJson,
    is_excluded: impl Fn(&str, &Path) -> bool,
) -> Vec<PathBuf> {
    let bundles: BTreeSet<&str> = manifest
        .dsh
        .as_ref()
        .and_then(|dsh| dsh.profile.as_ref())
        .map(|inner| inner.bundles.iter().map(String::as_str).collect())
        .unwrap_or_default();
    let mut roots = BTreeSet::new();
    for (name, spec) in &manifest.dependencies {
        if !bundles.contains(name.as_str()) {
            continue;
        }
        let Some(raw) = local_dep_path(spec) else {
            continue;
        };
        let Some(dir) = resolve_dir(&raw, profile) else {
            continue;
        };
        if is_excluded(name, &dir) {
            continue;
        }
        roots.insert(dir);
    }
    prune_nested(roots.into_iter().collect())
}

fn read_manifest(profile: &Path) -> Option<ProfilePackageJson> {
    let content = std::fs::read_to_string(profile.join("package.json")).ok()?;
    serde_json::from_str(&content).ok()
}

/// 本地依赖的原始路径部分：`link:` / `file:` 前缀之外的一律不是本地目录。
fn local_dep_path(spec: &str) -> Option<String> {
    let raw = spec
        .strip_prefix("link:")
        .or_else(|| spec.strip_prefix("file:"))?;
    let trimmed = raw.trim().trim_end_matches(['/', '\\']);
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// 解析成真实长路径：pnpm 的 `link:` 是目录联接，必须落到源码目录本身，
/// 且必须是长名（8.3 短名会让 chokidar 原生断言崩溃）。
fn resolve_dir(raw: &str, profile: &Path) -> Option<PathBuf> {
    let normalized = raw.replace('/', std::path::MAIN_SEPARATOR_STR);
    let path = Path::new(&normalized);
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        profile.join(path)
    };
    let resolved = dunce::canonicalize(&joined).ok()?;
    resolved.is_dir().then_some(resolved)
}

/// 随包分发的内置插件源码目录：改它没有意义（升级即被覆盖），不该进 watch root。
fn is_bundled(app_handle: &AppHandle, dir: &Path) -> bool {
    let Ok(resource_dir) = app_handle.path().resource_dir() else {
        return false;
    };
    let flatten = |path: &Path| {
        let mut text = path
            .to_string_lossy()
            .replace('/', std::path::MAIN_SEPARATOR_STR);
        if !text.ends_with(std::path::MAIN_SEPARATOR) {
            text.push_str(std::path::MAIN_SEPARATOR_STR);
        }
        text.to_lowercase()
    };
    flatten(dir).starts_with(&flatten(dunce::simplified(&resource_dir)))
}

/// 去掉被父目录覆盖的子目录：chokidar 递归监听父目录即可，重复 root 只增开销。
fn prune_nested(dirs: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut kept: Vec<PathBuf> = Vec::new();
    for dir in dirs {
        if kept.iter().any(|parent| dir.starts_with(parent)) {
            continue;
        }
        kept.retain(|child| !child.starts_with(&dir));
        kept.push(dir);
    }
    kept
}

/// 一组 root 的 `base`：取成员最多的卷（同卷才能算出不含 `..` 的相对路径）。
///
/// 跨卷（本地插件分别装在 C:/D:）时只能给其中一个卷配 `base`，其余 root 用绝对
/// 路径；`relative(base, 绝对路径)` 在 Windows 上原样返回绝对路径，忽略规则对那
/// 部分 root 失效（只是多监听几个文件，不影响正确性）。
fn pick_base(roots: &[PathBuf]) -> Option<PathBuf> {
    let mut groups: Vec<(std::ffi::OsString, Vec<PathBuf>)> = Vec::new();
    for root in roots {
        let key = root
            .components()
            .next()
            .map(|part| part.as_os_str().to_os_string())
            .unwrap_or_default();
        match groups.iter_mut().find(|(existing, _)| *existing == key) {
            Some((_, members)) => members.push(root.clone()),
            None => groups.push((key, vec![root.clone()])),
        }
    }
    let mut best: Option<Vec<PathBuf>> = None;
    for (_, members) in groups {
        if best
            .as_ref()
            .is_none_or(|current| members.len() > current.len())
        {
            best = Some(members);
        }
    }
    common_ancestor(&best?)
}

/// 一组绝对路径的最深公共祖先；跨卷（首个分量不同）时返回 `None`。
fn common_ancestor(paths: &[PathBuf]) -> Option<PathBuf> {
    let first = paths.first()?;
    let mut shared: Vec<Component> = first.components().collect();
    for path in &paths[1..] {
        let mut index = 0;
        for (left, right) in shared.iter().zip(path.components()) {
            if *left != right {
                break;
            }
            index += 1;
        }
        shared.truncate(index);
    }
    let ancestor: PathBuf = shared.into_iter().collect();
    ancestor.is_absolute().then_some(ancestor)
}

fn relative_root(base: &Path, root: &Path) -> String {
    let text = root
        .strip_prefix(base)
        .unwrap_or(root)
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/");
    let trimmed = text.trim_matches('/');
    if trimmed.is_empty() {
        ".".to_string()
    } else {
        trimmed.to_string()
    }
}

/// `file://` URL：核心用 `fileURLToPath(new URL(config.base, ctx.baseUrl))` 还原目录，
/// 只认 file 协议（裸 `D:/x` 会抛 ERR_INVALID_URL_SCHEME）。
///
/// 用 `Url::from_file_path` 而不是拼字符串：路径里的保留字符必须百分号编码，否则
/// `#` 会被 `new URL()` 当成 fragment 起始符，`fileURLToPath` 只还原出 `#` 之前的
/// 半截目录（实测 `D:/my#plugin` ⇒ `D:/my`）；编码后 `%23` 能逐字还原。非 UTF-8
/// 路径、非磁盘盘符（UNC）以及含 `..` 的相对路径都返回 `None`。
fn file_url(dir: &Path) -> Option<String> {
    if dir
        .components()
        .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
    {
        return None;
    }
    tauri::Url::from_file_path(dir)
        .ok()
        .map(|url| url.as_str().to_string())
}

fn render_layer(roots: &[PathBuf]) -> Option<String> {
    let base = pick_base(roots)?;
    let base_url = file_url(&base)?;
    let mut yaml = String::from("- id: ");
    yaml.push_str(HMR_ENTRY_ID);
    yaml.push_str(
        "
  name: '",
    );
    yaml.push_str(HMR_ENTRY_NAME);
    yaml.push_str(
        "'
  config:
    base: ",
    );
    yaml.push_str(&base_url);
    yaml.push_str(
        "
    root:",
    );
    for root in roots {
        yaml.push_str(
            "
      - ",
        );
        yaml.push_str(&root_value(&base, root));
    }
    yaml.push_str(
        "
    ignored:",
    );
    for pattern in ignore_patterns() {
        yaml.push_str(
            "
      - '",
        );
        yaml.push_str(&pattern);
        yaml.push('\'');
    }
    yaml.push_str(
        "
    debounce: ",
    );
    yaml.push_str(&HMR_DEBOUNCE_MS.to_string());
    yaml.push('\n');
    Some(yaml)
}

fn root_value(base: &Path, root: &Path) -> String {
    if root.starts_with(base) {
        relative_root(base, root)
    } else {
        root.to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/")
    }
}

fn ignore_patterns() -> Vec<String> {
    vec![
        format!("**[/{BS}]node_modules"),
        format!("**[/{BS}]node_modules[/{BS}]**"),
        format!("node_modules[/{BS}]**"),
        format!("**[/{BS}].*"),
        "cache".to_string(),
        "data".to_string(),
    ]
}

fn write_layer(path: &Path, rendered: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("HMR_LAYER_MKDIR_FAILED: {}: {e}", parent.display()))?;
    }
    let temp = path.with_file_name(format!("{HMR_PATCH_FILENAME}.tmp-{}", now_stamp()));
    std::fs::write(&temp, rendered).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("HMR_LAYER_WRITE_FAILED: {}: {e}", temp.display())
    })?;
    std::fs::rename(&temp, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("HMR_LAYER_WRITE_FAILED: {}: {e}", path.display())
    })
}

fn remove_layer(path: &Path) {
    if !path.exists() {
        return;
    }
    match std::fs::remove_file(path) {
        Ok(()) => log::info!("HMR layer removed: {}", path.display()),
        Err(error) => log::warn!("HMR_LAYER_REMOVE_FAILED: {}: {error}", path.display()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dsh-hmr-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dunce::canonicalize(&dir).unwrap()
    }

    fn manifest(dependencies: &[(&str, String)], bundles: &[&str]) -> ProfilePackageJson {
        let deps: HashMap<String, String> = dependencies
            .iter()
            .map(|(name, spec)| (name.to_string(), spec.clone()))
            .collect();
        serde_json::from_value(serde_json::json!({
            "name": "dsh-profile-test",
            "private": true,
            "dependencies": deps,
            "dsh": { "profile": { "bundles": bundles } },
        }))
        .unwrap()
    }

    fn plugin_dir(profile: &Path, name: &str) -> PathBuf {
        let dir = profile.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        dunce::canonicalize(&dir).unwrap()
    }

    /// 实机热重载验证直接复用这份生产字节：只有显式给出 DSH_HMR_LAYER_DUMP 目录时
    /// 才落盘，默认（含 CI）不写共享临时目录。
    fn dump_layer(name: &str, yaml: &str) {
        let Some(dir) = std::env::var_os("DSH_HMR_LAYER_DUMP") else {
            return;
        };
        std::fs::write(Path::new(&dir).join(name), yaml).unwrap();
    }

    #[test]
    fn ignore_patterns_escape_the_backslash_twice() {
        let patterns = ignore_patterns();
        assert_eq!(
            patterns,
            vec![
                "**[/\\\\]node_modules".to_string(),
                "**[/\\\\]node_modules[/\\\\]**".to_string(),
                "node_modules[/\\\\]**".to_string(),
                "**[/\\\\].*".to_string(),
                "cache".to_string(),
                "data".to_string(),
            ]
        );
        // 每个 `[/\]` 转义段都必须落成两个真实反斜杠：单个反斜杠在 picomatch 里
        // 被当成转义符，模式永不匹配（这正是核心默认规则在本机失效的原因）。
        for pattern in &patterns {
            assert!(!pattern.contains("[/\\]"), "{pattern}");
        }
    }

    #[test]
    fn local_dep_path_accepts_both_prefixes_and_trims_separators() {
        assert_eq!(
            local_dep_path("link:D:/plugins/mine/"),
            Some("D:/plugins/mine".to_string())
        );
        assert_eq!(
            local_dep_path("file:D:\\plugins\\mine"),
            Some("D:\\plugins\\mine".to_string())
        );
        assert_eq!(local_dep_path("^1.2.3"), None);
        assert_eq!(local_dep_path("github:user/repo"), None);
        assert_eq!(local_dep_path("link:"), None);
    }

    #[test]
    fn resolve_dir_needs_a_real_directory() {
        let profile = tmp_dir("resolve");
        let dir = plugin_dir(&profile, "mine");
        assert_eq!(resolve_dir("mine", &profile), Some(dir.clone()));
        assert_eq!(resolve_dir("./mine", &profile), Some(dir));
        assert_eq!(resolve_dir("missing", &profile), None);
        let _ = std::fs::remove_dir_all(&profile);
    }

    #[test]
    fn watch_roots_only_cover_mounted_local_plugins() {
        let profile = tmp_dir("watch-roots");
        let local = plugin_dir(&profile, "local");
        let sibling = plugin_dir(&profile, "plain");
        let excluded = plugin_dir(&profile, "excluded");
        let unbundled = plugin_dir(&profile, "unbundled");
        let manifest = manifest(
            &[
                ("local", format!("link:{}", local.display())),
                ("sibling", "link:plain".to_string()),
                ("unbundled", format!("link:{}", unbundled.display())),
                ("excluded", format!("link:{}", excluded.display())),
                ("registry", "^1.0.0".to_string()),
                ("ghost", "link:no-such-dir".to_string()),
            ],
            &[
                "local",
                "sibling",
                "unbundled",
                "excluded",
                "registry",
                "ghost",
            ],
        );

        let roots = watch_roots_in(&profile, &manifest, |name, _| name == "excluded");
        assert_eq!(roots, vec![local, sibling, unbundled]);
        let _ = std::fs::remove_dir_all(&profile);
    }

    #[test]
    fn prune_nested_keeps_the_topmost_directory() {
        let root = PathBuf::from("X:\\hmr-tmp").join("prune");
        let outside = PathBuf::from("X:\\hmr-tmp").join("outside");
        let roots = prune_nested(vec![
            root.join("a\\b"),
            root.clone(),
            root.join("a\\b\\c"),
            root.join("ab"),
            outside.clone(),
        ]);
        assert_eq!(roots, vec![root.clone(), outside]);

        // 前缀相同但不是祖先目录的兄弟目录必须保留（按路径分量比较，不是字符串前缀）
        let sibling = prune_nested(vec![root.join("a\\b"), root.join("a\\bc")]);
        assert_eq!(sibling, vec![root.join("a\\b"), root.join("a\\bc")]);
    }

    #[test]
    fn common_ancestor_stops_at_the_shared_prefix() {
        // 夹具必须落在真实临时目录上：`X:\hmr-tmp` 这类 Windows 字面量在 Unix 上
        // 只是单个相对分量（不是绝对路径），公共祖先会直接算成 `None`。
        let root = tmp_dir("common");
        assert_eq!(
            common_ancestor(&[root.join("a").join("b"), root.join("a").join("c")]),
            Some(root.join("a"))
        );
        assert_eq!(
            common_ancestor(std::slice::from_ref(&root)),
            Some(root.clone())
        );
        assert_eq!(common_ancestor(&[]), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn pick_base_prefers_the_volume_with_more_roots() {
        let root = tmp_dir("pick-base");
        let single = vec![root.join("only")];
        assert_eq!(pick_base(&single), Some(single[0].clone()));

        let roots = vec![root.join("a").join("p1"), root.join("a").join("p2")];
        assert_eq!(pick_base(&roots), Some(root.join("a")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn render_layer_writes_a_complete_hmr_config() {
        // 夹具必须是真实的绝对目录：`X:\hmr-tmp` 在 Unix 上不是绝对路径，`pick_base`
        // 会返回 `None`。base 行按同一实现函数算出（盘符大小写、分隔符都取真实临时
        // 目录的形态，不硬编码平台），其余字节逐字固定。
        let root = tmp_dir("render").join("plugins");
        std::fs::create_dir_all(&root).unwrap();
        let roots = vec![root.join("mine"), root.join("other").join("sub")];
        let yaml = render_layer(&roots).expect("render");

        let entries: Vec<serde_yaml::Value> = serde_yaml::from_str(&yaml).expect("parse");
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry["id"].as_str(), Some(HMR_ENTRY_ID));
        assert_eq!(entry["name"].as_str(), Some(HMR_ENTRY_NAME));
        let config = &entry["config"];
        let base = config["base"].as_str().expect("base");
        assert!(base.starts_with("file:///"), "{base}");
        assert_eq!(config["root"].as_sequence().unwrap().len(), 2, "{yaml}");
        assert_eq!(config["root"][0].as_str(), Some("mine"));
        assert_eq!(config["root"][1].as_str(), Some("other/sub"));
        assert_eq!(config["ignored"].as_sequence().unwrap().len(), 6);
        assert_eq!(config["debounce"].as_u64(), Some(HMR_DEBOUNCE_MS));

        // 逐字固定整份补丁层：核心按 id 整块替换 config，任何字段写错或漏写都会被静默忽略。
        let base_line = format!("    base: {}", file_url(&root).expect("file url"));
        let golden = [
            "- id: hmr",
            "  name: '@deepseek-ai/dsh-hmr'",
            "  config:",
            base_line.as_str(),
            "    root:",
            "      - mine",
            "      - other/sub",
            "    ignored:",
            "      - '**[/\\\\]node_modules'",
            "      - '**[/\\\\]node_modules[/\\\\]**'",
            "      - 'node_modules[/\\\\]**'",
            "      - '**[/\\\\].*'",
            "      - 'cache'",
            "      - 'data'",
            "    debounce: 100",
        ]
        .join("\n")
            + "\n";
        assert_eq!(yaml, golden);
    }

    /// 含保留字符（`#`）的真实目录：源码路径带 `#` 时 URL 必须百分号编码，否则
    /// `new URL()` 把它当 fragment 起始符，核心会去监听被截断的父目录。
    fn reserved_dir(tag: &str) -> PathBuf {
        let dir = tmp_dir(tag).join("my#plugin");
        std::fs::create_dir_all(&dir).unwrap();
        dunce::canonicalize(&dir).unwrap()
    }

    #[test]
    fn render_layer_percent_encodes_reserved_characters() {
        let source = reserved_dir("reserved");
        let yaml = render_layer(std::slice::from_ref(&source)).expect("render");
        dump_layer("dsh-hmr-layer-hash-out.yml", &yaml);
        let entries: Vec<serde_yaml::Value> = serde_yaml::from_str(&yaml).expect("parse");
        let config = &entries[0]["config"];
        let base = config["base"].as_str().expect("base");
        assert!(base.contains("my%23plugin"), "{base}");
        assert!(!base.contains('#'), "{base}");

        // 还原必须逐字回到真实源码目录：`#` 直接写进 URL 时这里只会得到 `my`。
        let restored = tauri::Url::parse(base).expect("parse url").to_file_path();
        assert_eq!(restored.ok(), Some(source));
    }

    #[test]
    fn render_layer_round_trips_a_real_link_dependency() {
        let home = tmp_dir("roundtrip");
        let profile = home.join("profiles").join("p3");
        std::fs::create_dir_all(&profile).unwrap();
        let profile = dunce::canonicalize(&profile).unwrap();
        let source = plugin_dir(&profile, "mine");
        let spec = super::super::install::local_spec_from_path(&source);
        let manifest = manifest(&[("probe-hmr-plugin", spec)], &["probe-hmr-plugin"]);

        let roots = watch_roots_in(&profile, &manifest, |_name, _dir| false);
        assert_eq!(roots, vec![source.clone()]);

        let yaml = render_layer(&roots).expect("render");
        dump_layer("dsh-hmr-layer-out.yml", &yaml);

        let entries: Vec<serde_yaml::Value> = serde_yaml::from_str(&yaml).expect("parse");
        let config = &entries[0]["config"];
        // `file://` 之后 Windows 还多一层根斜杠（`file:///C:/x`），Unix 剥完即是绝对路径。
        let raw = config["base"]
            .as_str()
            .expect("base")
            .trim_start_matches("file://");
        #[cfg(windows)]
        let raw = raw.trim_start_matches('/');
        let base = PathBuf::from(raw);
        let resolved = config["root"]
            .as_sequence()
            .expect("root")
            .iter()
            .map(|item| base.join(item.as_str().expect("root item")))
            .collect::<Vec<_>>();
        // base 与 root 拼回来必须正好是插件的真实源码目录：任何一步的形态偏差都会让
        // 核心监听一个不存在的目录（chokidar 对缺失的监听根目录是静默的）。
        assert_eq!(resolved, vec![source]);
    }

    #[test]
    fn render_layer_needs_at_least_one_root() {
        assert_eq!(render_layer(&[]), None);
    }

    #[cfg(windows)]
    #[test]
    fn render_layer_keeps_foreign_volumes_absolute() {
        let roots = vec![
            PathBuf::from("D:\\plugins\\mine"),
            PathBuf::from("C:\\other\\plugin"),
        ];
        let yaml = render_layer(&roots).expect("render");
        let entries: Vec<serde_yaml::Value> = serde_yaml::from_str(&yaml).expect("parse");
        let config = &entries[0]["config"];
        assert_eq!(config["base"].as_str(), Some("file:///D:/plugins/mine"));
        assert_eq!(config["root"][0].as_str(), Some("."));
        assert_eq!(config["root"][1].as_str(), Some("C:/other/plugin"));
    }
}
