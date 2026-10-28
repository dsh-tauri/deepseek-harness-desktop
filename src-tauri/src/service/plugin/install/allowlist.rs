//! pnpm 构建放行白名单（`allowBuilds` / `onlyBuiltDependencies`）解析与写回：
//! 从 pnpm 失败输出解析它建议的允许键，合并写回 profile 的
//! `pnpm-workspace.yaml`（pnpm 10 的 list 与 11 的 map 双写），并自愈旧版
//! 字符串拼接遗留的「重复映射键」损坏文件（issue #49）。

use std::collections::HashMap;
use std::path::PathBuf;
use tauri::AppHandle;

use serde_yaml::{Mapping, Value};

use super::profile_dir;
use crate::service::profile::parse_workspace_document;

/// 从 pnpm 失败输出中解析需写入构建放行白名单的包名/键集合。
///
/// 兼容 pnpm 10 与 11 的两套输出形式（两者对 git 托管插件 prepare 门禁的提示不同）：
/// - pnpm 11（捆绑版）提示 `allowBuilds:\n  <key>: true`（map 形式），原样采纳 `<key>`；
/// - pnpm 10（旧 store 复用用户版）提示 `onlyBuiltDependencies:\n  - "<name>"`
///   （list 形式）与报错文本里的包名，二者归并取包名；
/// - 传递原生依赖被忽略构建（`Ignored build scripts:`）时，取其 `name@version` 的包名。
pub(super) fn parse_allowlist_keys(output: &str) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    let lines: Vec<&str> = output.lines().collect();

    // 1) git 托管插件的允许键：跟随 `allowBuilds:` 示例行后的缩进 `<key>: true`。
    //    pnpm 11 的报错（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`）建议按此形式放行。
    for (idx, line) in lines.iter().enumerate() {
        if line.trim() == "allowBuilds:" {
            if let Some(next) = lines.get(idx + 1) {
                if let Some(key) = extract_allow_line_key(next) {
                    push_unique(&mut keys, key);
                }
            }
        }
    }

    // 2) 传递原生构建包名：`Ignored build scripts: <name>@<ver>, ...`。
    for line in &lines {
        if let Some(sub) = line.split("Ignored build scripts:").nth(1) {
            for token in sub.split([',', ' ']) {
                let token = token.trim();
                if token.is_empty() {
                    continue;
                }
                // 版本号在最后一个 `@` 之后：scoped 包名（`@scope/name`）本身含 `@`，
                // 必须从尾部切分才能保留完整包名，否则 `split('@').next()` 会得到空串。
                let name = token
                    .rsplit_once('@')
                    .map_or(token, |(name, _)| name)
                    .trim();
                if !name.is_empty() {
                    push_unique(&mut keys, name.to_string());
                }
            }
        }
    }

    // 3) pnpm 10 的 `onlyBuiltDependencies:` 列表（git 托管插件 prepare 门禁）：
    //    onlyBuiltDependencies:
    //      - "dsh-better-sidebar"
    for (idx, line) in lines.iter().enumerate() {
        if line.trim() == "onlyBuiltDependencies:" {
            for next in lines.iter().skip(idx + 1) {
                let trimmed = next.trim_start();
                if let Some(rest) = trimmed.strip_prefix('-') {
                    // 列表项：可能带缩进也可能不带（pnpm 提示段两种形式都出现过），
                    // 先于「顶层键」判定接受，避免无缩进条目被误当作顶层键提前退出。
                    let item = rest.trim().trim_matches(['"', '\'']);
                    if !item.is_empty() {
                        push_unique(&mut keys, item.to_string());
                    }
                } else if !next.starts_with(' ')
                    && !next.starts_with('\t')
                    && !trimmed.is_empty()
                    && !trimmed.starts_with('#')
                {
                    break; // 顶层键（无缩进且非列表项），已离开列表
                }
                // 其余（缩进行的非列表项、空行、注释）：继续扫描
            }
        }
    }

    // 4) pnpm 10 报错文本里的包名（`The git-hosted package "NAME@VER" ... "onlyBuiltDependencies" allowlist.`），
    //    与第 3 步归并：即便列表被截断也能从消息取回名字。
    for line in &lines {
        if let Some(name) = extract_only_builds_git_name(line) {
            push_unique(&mut keys, name);
        }
    }

    keys
}

/// 若 `line` 形如 `  <key>: true`（有缩进），返回 `<key>`（去缩进与后缀）。
/// pnpm 报出的 depPath 键本身不带引号，这里只做剥离该行格式。
fn extract_allow_line_key(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    if trimmed.len() == line.len() {
        return None; // 无缩进，不是白名单条目
    }
    let suffix = trimmed.strip_suffix(": true")?;
    let key = suffix.trim_end();
    if key.is_empty() {
        return None;
    }
    Some(key.to_string())
}

/// 去重追加：避免同一键在不同输出块被重复计为待放行项。
fn push_unique(keys: &mut Vec<String>, key: String) {
    if !keys.iter().any(|k| k == &key) {
        keys.push(key);
    }
}

/// 从 pnpm 10 的 git 托管插件 prepare 门禁报错文本提取包名。
///
/// 形如 `The git-hosted package "NAME@VERSION" needs to execute build scripts
/// but is not in the "onlyBuiltDependencies" allowlist.`。
/// 仅匹配 `onlyBuiltDependencies` 形式的文本（pnpm 10）；pnpm 11 的 `allowBuilds`
/// 形式仍由 [`extract_allow_line_key`] 解析 `allowBuilds:` 块，二者互不干扰。
fn extract_only_builds_git_name(line: &str) -> Option<String> {
    if !line.contains("\"onlyBuiltDependencies\" allowlist") {
        return None;
    }
    let marker = "The git-hosted package \"";
    let start = line.find(marker)? + marker.len();
    let rest = &line[start..];
    let end = rest.find('"')?;
    let quoted = &rest[..end]; // "name@version"
                               // 包名（含 scoped 前缀 `@scope/name`）在最末一个 `@` 之前，版本号在之后。
    let (name, _version) = quoted.rsplit_once('@')?;
    (!name.is_empty()).then(|| name.to_string())
}

/// 从 pnpm 11 的 git depPath 允许键（`name@<pkgResolutionId>`）提取纯包名；
/// 普通包名 / `name@version` 选择器原样返回。
///
/// pnpm 10 的 `onlyBuiltDependencies` 只按包名（或包名@版本）匹配，git depPath 里的
/// resolution id（`git+ssh://…` / `https://…` 等）对它没有意义，必须剥掉，否则该
/// 放行项在 pnpm 10 下不生效、git 插件的 prepare 构建仍会被构建门禁拦截。
fn dep_path_to_name(key: &str) -> String {
    const GIT_RES_ID_MARKERS: &[&str] =
        &["@git+", "@https://", "@http://", "@git://", "@github.com/"];
    for marker in GIT_RES_ID_MARKERS {
        if let Some(pos) = key.find(marker) {
            return key[..pos].to_string();
        }
    }
    key.to_string()
}

/// profile 下的 `pnpm-workspace.yaml` 路径（$DSH_HOME/profiles/<当前档案>）。
///
/// 构建放行项必须写进**当前活动档案**的工作区配置：`dsh plugin --profile <档案>`
/// 驱动的 pnpm 只读取该档案目录下的 `pnpm-workspace.yaml`，写错路径（如全局或其它
/// 档案）会让放行项失效，安装/升级仍会被 pnpm 的构建门禁拦截。
fn profile_workspace_path(app_handle: &AppHandle) -> PathBuf {
    profile_dir(app_handle).join("pnpm-workspace.yaml")
}

/// 把新的构建放行键合并写回 profile 的 `pnpm-workspace.yaml`，同时写入
/// `allowBuilds`（map，pnpm 11）与 `onlyBuiltDependencies`（list，pnpm 10）。
///
/// 用 YAML 库（serde_yaml）整体改写而非字符串拼接，避免格式错乱：
/// - 键（git depPath 含 `@`/`/`/`:`/`#`）由库自动按需加引号，不再手工拼；
/// - 已存在的同名键会被就地覆盖，不会残留占位值。
///
/// TODO(v1): 移除对旧版损坏文件（issue #49）的自愈逻辑。v1 起只解析干净配置，
/// `apply_allow_build_keys` 中解析失败后的「同键去重再解析」与
/// `collapse_allow_builds_duplicates` 一并删除。
///
/// 防御性修复：旧版本用字符串拼接可能留下「重复映射键」的损坏文件
/// （最多见的是 `node-pty: set this to true or false` 占位行与真正的
/// `'node-pty': true` 并存，见 issue #49）。此处解析失败时先做一次
/// `allowBuilds` 同键去重再解析，把损坏文件自愈回合法 YAML。
pub(super) fn add_allow_build_keys(app_handle: &AppHandle, keys: &[String]) -> Result<(), String> {
    let path = profile_workspace_path(app_handle);
    let dir = path
        .parent()
        .ok_or("PREINSTALL_BAD_PROFILE_DIR: no profile dir")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("PREINSTALL_MKDIR: {e}"))?;

    let content = if path.exists() {
        std::fs::read_to_string(&path).map_err(|e| format!("PREINSTALL_READ_WORKSPACE: {e}"))?
    } else {
        // 与 dsh `initProfile` 生成的基础模板保持一致（尚无 allowBuilds）。
        "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n".to_string()
    };

    let rendered = apply_allow_build_keys(&content, keys)?;
    if rendered == content {
        return Ok(()); // 无变化（所有键已就位），避免无意义写盘
    }

    log::info!(
        "pnpm-workspace.yaml rewritten with allowBuilds {keys:?} at {}",
        path.display()
    );
    std::fs::write(&path, rendered).map_err(|e| format!("PREINSTALL_WRITE_WORKSPACE: {e}"))
}

/// 把新的构建放行键合并进 `pnpm-workspace.yaml` 文本并返回新文本。
///
/// 用 YAML 库（serde_yaml）整体改写而非字符串拼接，避免格式错乱：
/// - `allowBuilds`（pnpm 11）写为 map：键（git depPath 含 `@`/`/`/`:`/`#`）由库
///   自动按需加引号，已存在的同名键会被就地覆盖为 `true`，不残留占位值、不产生重复键；
/// - `onlyBuiltDependencies`（pnpm 10）写为 list：追加唯一的包名，不清空已有条目。
///
/// 防御性修复：旧版本用字符串拼接可能留下「重复映射键」的损坏文件
/// （最多见的是 `node-pty: set this to true or false` 占位行与真正的
/// `'node-pty': true` 并存，见 issue #49）。此处先尝试严格解析；解析失败时
/// 做一次 `allowBuilds` 同键去重再解析，把损坏文件自愈回合法 YAML。
fn apply_allow_build_keys(content: &str, keys: &[String]) -> Result<String, String> {
    // 先尝试严格解析。旧的损坏文件（重复映射键）严格解析会失败：
    // 把 `allowBuilds` 内同名键去重（保留最后写入的值）后再解析，自愈损坏状态。
    // 「多文档」（`---` 分隔，issue #526）同样让 serde_yaml 与 pnpm 都拒绝——交给
    // `parse_workspace_document` 归一化成单文档并标记需要回写。
    let (mut doc, repaired): (Value, bool) = match parse_workspace_document(content) {
        Ok((value, normalized)) => (value, normalized),
        Err(first_err) => {
            let normalized = collapse_allow_builds_duplicates(content);
            if normalized == content {
                return Err(format!("PREINSTALL_WORKSPACE_INVALID_YAML: {first_err}"));
            }
            let value = parse_workspace_document(&normalized)
                .map(|(value, _)| value)
                .map_err(|e| format!("PREINSTALL_WORKSPACE_INVALID_YAML: {e}"))?;
            (value, true)
        }
    };

    // 空/注释-only 内容解析为 `Value::Null`，视为全新空配置（pnpm-workspace.yaml
    // 可加载的最小映射）；其余非映射内容才是真正的损坏。
    if doc.is_null() {
        doc = Value::Mapping(Mapping::new());
    }

    let map = doc.as_mapping_mut().ok_or_else(|| {
        "PREINSTALL_WORKSPACE_NOT_MAP: pnpm-workspace.yaml must be a mapping".to_string()
    })?;

    let allow_key = Value::String("allowBuilds".to_string());
    if !map.contains_key(&allow_key) {
        map.insert(allow_key.clone(), Value::Mapping(Mapping::new()));
    }
    let allow_builds = map
        .get_mut(&allow_key)
        .and_then(Value::as_mapping_mut)
        .ok_or_else(|| {
            "PREINSTALL_WORKSPACE_ALLOWBUILDS_NOT_MAP: allowBuilds must be a mapping".to_string()
        })?;

    let mut dirty = false;
    for key in keys {
        let k = Value::String(key.clone());
        if allow_builds.get(&k) == Some(&Value::Bool(true)) {
            continue; // 已是 true，幂等跳过
        }
        // 直接覆盖旧值（含占位值/旧 false），由库负责按需加引号
        allow_builds.insert(k, Value::Bool(true));
        dirty = true;
    }

    for (key, value) in allow_builds.iter_mut() {
        if value.as_bool().is_none()
            && key
                .as_str()
                .is_some_and(|key| keys.contains(&dep_path_to_name(key)))
        {
            *value = Value::Bool(true);
            dirty = true;
        }
    }

    // `allowBuilds` 的借用已在上面循环结束后释放（NLL），此处才能对 `map`
    // 再次取可变引用处理 `onlyBuiltDependencies`。
    //
    // pnpm 10（旧 store 复用的用户版）只认 `onlyBuiltDependencies`（list 形式，
    // 见其报错提示），因此这里一并写回，保证 pnpm 10 / 11 两版都能读到放行项；
    // `allowBuilds`（map 形式）覆盖 pnpm 11（捆绑版），二者共存互不冲突。
    //
    // 注意：pnpm 11 的 git 允许键是 `name@<pkgResolutionId>` 完整 depPath（按
    // resolution id 匹配，只能写进 allowBuilds）；pnpm 10 只按包名匹配，因此写入
    // onlyBuiltDependencies 前必须经 [`dep_path_to_name`] 剥成纯包名。
    let only_key = Value::String("onlyBuiltDependencies".to_string());
    let to_add: Vec<Value> = {
        let existing_only = map.get(&only_key).and_then(Value::as_sequence);
        keys.iter()
            .map(|k| dep_path_to_name(k))
            .filter(|name| {
                existing_only.is_none_or(|seq| !seq.contains(&Value::String(name.clone())))
            })
            .map(Value::String)
            .collect()
    };
    if !to_add.is_empty() {
        if !map.contains_key(&only_key) {
            map.insert(only_key.clone(), Value::Sequence(Vec::new()));
        }
        let only_builds = map
            .get_mut(&only_key)
            .and_then(Value::as_sequence_mut)
            .ok_or_else(|| {
                "PREINSTALL_WORKSPACE_ONLYBUILT_NOT_SEQ: onlyBuiltDependencies must be a sequence"
                    .to_string()
            })?;
        for v in to_add {
            only_builds.push(v);
            dirty = true;
        }
    }
    if !dirty && !repaired {
        return Ok(content.to_string());
    }
    // 有键新增，或损坏文件已被自愈归一化——两种都要落回解析后的完整文档，
    // 否则会把损坏的原始文本原样返回。

    serde_yaml::to_string(&doc).map_err(|e| format!("PREINSTALL_WORKSPACE_RENDER: {e}"))
}

/// 把损坏的 `allowBuilds` 映射（同一键出现多次）去重为合法 YAML。
///
/// 仅作为旧版字符串拼接遗留损坏（重复映射键，见 issue #49）的兜底归一化：
/// 扫描 `allowBuilds:` 之后、下一个顶层键之前的缩进 `key: value` 行，同一键
/// 只保留最后一次出现的行（与 YAML「后者覆盖前者」语义一致），其余行原样保留。
fn collapse_allow_builds_duplicates(content: &str) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let mut in_allow = false;
    // 记录（键 → 该键所有行的索引），用于去重
    let mut key_indexes: HashMap<String, Vec<usize>> = HashMap::new();
    let mut order: Vec<String> = Vec::new();

    for (idx, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        if trimmed == "allowBuilds:" {
            in_allow = true;
            continue;
        }
        if in_allow {
            let is_indent = line.starts_with(' ') || line.starts_with('\t');
            let is_comment = trimmed.starts_with('#');
            if !is_indent || is_comment {
                in_allow = false; // 遇到顶层键或注释即离开 allowBuilds
                continue;
            }
            // 缩进的 `key: value` 行 → 提取键（冒号前）
            if let Some(col) = trimmed.find(':') {
                let key = trimmed[..col].trim().trim_matches(['\'', '"']);
                if !key.is_empty() {
                    if !key_indexes.contains_key(key) {
                        order.push(key.to_string());
                    }
                    key_indexes.entry(key.to_string()).or_default().push(idx);
                }
            }
        }
    }

    // 每个键只保留最后一个出现行，其余标记删除
    let mut keep: std::collections::HashSet<usize> = std::collections::HashSet::new();
    for key in &order {
        if let Some(idxs) = key_indexes.get(key) {
            if let Some(&last) = idxs.last() {
                keep.insert(last);
            }
        }
    }
    let mut out: Vec<&str> = Vec::with_capacity(lines.len());
    for (idx, line) in lines.iter().enumerate() {
        if key_indexes.values().any(|v| v.contains(&idx)) && !keep.contains(&idx) {
            continue; // 是被去重掉的重复键行
        }
        out.push(line);
    }
    // 避免重复键里夹带的空行粘连成异常空行：去掉去重区（allowBuilds 段）的连续空行
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_git_dep_path_key() {
        let out = "\
[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] Failed to prepare git-hosted package fetched from \"...\"
The git-hosted package \"dsh-better-sidebar@0.14.0\" needs to execute build scripts but is not in the \"allowBuilds\" allowlist.
...
allowBuilds:
  dsh-better-sidebar@git+ssh://git@github.com/omdsh-dev/DSH-better-sidebar.git#6c89: true
";
        let keys = parse_allowlist_keys(out);
        assert!(keys.contains(
            &"dsh-better-sidebar@git+ssh://git@github.com/omdsh-dev/DSH-better-sidebar.git#6c89"
                .to_string()
        ));
        assert!(!keys.contains(&"dsh-better-sidebar".to_string()));
    }

    #[test]
    fn parse_ignored_builds_name() {
        let out = "[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: node-pty@1.1.0\n";
        let keys = parse_allowlist_keys(out);
        assert_eq!(keys, vec!["node-pty".to_string()]);
    }

    #[test]
    fn parse_ignored_builds_scoped_name() {
        // 回归（CodeRabbit）：scoped 原生依赖 `@scope/name@version` 必须保留完整包名，
        // 不能按第一个 `@` 切分（那会得到空串导致该包被跳过、无法放行）。
        let out = "[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: @deepseek-ai/dsh-base@0.0.4, node-pty@1.1.0\n";
        let keys = parse_allowlist_keys(out);
        assert_eq!(
            keys,
            vec!["@deepseek-ai/dsh-base".to_string(), "node-pty".to_string()]
        );
    }

    #[test]
    fn parse_empty_when_irrelevant() {
        let out = "everything looks fine output\nno allowlist here\n";
        assert!(parse_allowlist_keys(out).is_empty());
    }

    #[test]
    fn parse_pnpm10_only_built_dependencies_list() {
        // 回归（issue：预装插件在 pnpm 10 下报 ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED）：
        // pnpm 10（旧 store 复用的用户版）只输出 onlyBuiltDependencies 列表与报错文本
        // 里的包名，不含 allowBuilds 块。此前 parse_allowlist_keys 只认 allowBuilds，
        // 导致读不到 dsh-better-sidebar、不写白名单、重试也被跳过，安装必然失败。
        let out = "\
[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] Failed to prepare git-hosted package fetched from \"https://codeload.github.com/omdsh-dev/DSH-better-sidebar/tar.gz/f9153dfc1ce47cf43445c1b351ee3ae47b4ad9f1\"
The git-hosted package \"dsh-better-sidebar@0.16.1\" needs to execute build scripts but is not in the \"onlyBuiltDependencies\" allowlist.
...
This error happened while installing a direct dependency of C:\\Users\\hairy\\.dsh.dev\\profiles\\web
Add the package to \"onlyBuiltDependencies\" in your project's pnpm-workspace.yaml to allow it to run scripts. For example:
onlyBuiltDependencies:
- \"dsh-better-sidebar\"
";
        let keys = parse_allowlist_keys(out);
        assert_eq!(keys, vec!["dsh-better-sidebar".to_string()]);
    }

    #[test]
    fn parse_pnpm10_unindented_list_items() {
        // 回归（CodeRabbit）：pnpm 10 提示段可能不带缩进（`- "name"` 与顶层键同列）。
        // 此前循环会把它误当顶层键提前退出，只靠报错文本回退解析才碰巧通过。
        let out = "onlyBuiltDependencies:\n- \"dsh-better-sidebar\"\n";
        let keys = parse_allowlist_keys(out);
        assert_eq!(keys, vec!["dsh-better-sidebar".to_string()]);
    }

    #[test]
    fn parse_pnpm10_scoped_package_from_message() {
        // 报错文本在列表被截断时也可取回名字；scoped 包名保留 `@scope/` 前缀。
        let out = "The git-hosted package \"@deepseek-ai/dsh-base@0.0.4\" needs to execute build scripts but is not in the \"onlyBuiltDependencies\" allowlist.\n";
        let keys = parse_allowlist_keys(out);
        assert_eq!(keys, vec!["@deepseek-ai/dsh-base".to_string()]);
    }

    #[test]
    fn extract_only_builds_git_name_strips_version_and_handles_scoped() {
        // 普通包名：name@version → name
        assert_eq!(
            extract_only_builds_git_name(
                "The git-hosted package \"node-pty@1.1.0\" needs to execute build scripts but is not in the \"onlyBuiltDependencies\" allowlist."
            ),
            Some("node-pty".to_string())
        );
        // scoped 包名：@scope/name@version → @scope/name（只剥最末一个 @ 后的版本号）
        assert_eq!(
            extract_only_builds_git_name(
                "The git-hosted package \"@deepseek-ai/dsh-base@0.0.4\" needs to execute build scripts but is not in the \"onlyBuiltDependencies\" allowlist."
            ),
            Some("@deepseek-ai/dsh-base".to_string())
        );
        // pnpm 11 的 allowBuilds 文本不匹配（交由 allowBuilds 块解析）
        assert_eq!(
            extract_only_builds_git_name(
                "The git-hosted package \"dsh-better-sidebar@0.14.0\" needs to execute build scripts but is not in the \"allowBuilds\" allowlist."
            ),
            None
        );
        // 非 git 门禁行不匹配
        assert_eq!(
            extract_only_builds_git_name("allowBuilds:\n  x: true"),
            None
        );
    }

    #[test]
    fn dep_path_to_name_strips_git_resolution_keeps_plain_names() {
        // git depPath（unscoped）：剥掉 resolution id，保留纯包名
        assert_eq!(
            dep_path_to_name(
                "dsh-better-sidebar@git+ssh://git@github.com/omdsh-dev/DSH-better-sidebar.git#6c89"
            ),
            "dsh-better-sidebar"
        );
        // git depPath（scoped）：同样只剥 resolution id，保留 `@scope/name`
        assert_eq!(
            dep_path_to_name(
                "@deepseek-ai/dsh-base@git+https://github.com/deepseek-ai/dsh-base.git#abc123"
            ),
            "@deepseek-ai/dsh-base"
        );
        // 普通包名 / 包名@版本选择器：原样返回
        assert_eq!(dep_path_to_name("node-pty"), "node-pty");
        assert_eq!(dep_path_to_name("node-pty@1.1.0"), "node-pty@1.1.0");
        assert_eq!(dep_path_to_name("@scope/pkg"), "@scope/pkg");
    }

    #[test]
    fn allow_line_key_requires_indent() {
        let key = extract_allow_line_key("  node-pty: true");
        assert_eq!(key.as_deref(), Some("node-pty"));

        // 无缩进（顶层键）不应被当作白名单条目
        assert_eq!(extract_allow_line_key("packages:"), None);
        assert_eq!(extract_allow_line_key("allowBuilds:"), None);
    }

    // ---- 归并写回 pnpm-workspace.yaml（issue #49 回归）----

    /// 从渲染结果里解析出单一 `allowBuilds` 映射，便于断言。
    fn allow_builds_map(yaml: &str) -> serde_yaml::Mapping {
        let doc: serde_yaml::Value = serde_yaml::from_str(yaml).expect("output must be valid YAML");
        doc.get("allowBuilds")
            .and_then(serde_yaml::Value::as_mapping)
            .expect("allowBuilds must be a mapping")
            .clone()
    }

    #[test]
    fn apply_adds_new_key_when_absent() {
        let base = "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n";
        // 无 allowBuilds 时首次写入
        let out = apply_allow_build_keys(base, &["node-pty".to_string()]).unwrap();
        let map = allow_builds_map(&out);
        assert_eq!(map.get("node-pty"), Some(&serde_yaml::Value::Bool(true)));
        // 顶级基础设置被保留
        let doc: serde_yaml::Value = serde_yaml::from_str(&out).unwrap();
        assert!(doc.get("packages").is_some());
        assert!(doc.get("nodeLinker").is_some());
    }

    #[test]
    fn apply_is_idempotent_and_does_not_duplicate() {
        // 已放行的键再次写入：结果不变（幂等、不产生重复键）。输入须同时包含
        // allowBuilds 与 onlyBuiltDependencies 两个放行出口（桌面端双写，见
        // apply_allow_build_keys），证明两处都幂等。
        let base = "packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n  node-pty: true\nonlyBuiltDependencies:\n  - node-pty\n";
        let out = apply_allow_build_keys(base, &["node-pty".to_string()]).unwrap();
        assert_eq!(out, base);
    }

    #[test]
    fn apply_settles_pnpm_pending_build_entry() {
        let base = "\
allowBuilds:
  '@modusensus/dsh-mneme': true
  '@modusensus/dsh-mneme@https://codeload.github.com/modusensus/dsh-mneme/tar.gz/add7c451...': set this to true or false
  '@modusensus/dsh-mneme@https://codeload.github.com/modusensus/dsh-mneme/tar.gz/denied': false
  '@modusensus/dsh-mneme-extra@https://example.com/other.tgz': set this to true or false
onlyBuiltDependencies:
  - '@modusensus/dsh-mneme'
";
        let keys = parse_allowlist_keys(
            "[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: @modusensus/dsh-mneme@https://codeload.github.com/modusensus/dsh-mneme/tar.gz/add7c451...\n",
        );
        assert_eq!(keys, vec!["@modusensus/dsh-mneme".to_string()]);
        let out = apply_allow_build_keys(base, &keys).unwrap();
        let map = allow_builds_map(&out);
        assert_eq!(
            map.get("@modusensus/dsh-mneme@https://codeload.github.com/modusensus/dsh-mneme/tar.gz/add7c451..."),
            Some(&Value::Bool(true))
        );
        assert_eq!(
            map.get("@modusensus/dsh-mneme@https://codeload.github.com/modusensus/dsh-mneme/tar.gz/denied"),
            Some(&Value::Bool(false))
        );
        assert_eq!(
            map.get("@modusensus/dsh-mneme-extra@https://example.com/other.tgz"),
            Some(&Value::String("set this to true or false".to_string()))
        );
        let doc: Value = serde_yaml::from_str(&out).unwrap();
        assert_eq!(
            doc["onlyBuiltDependencies"],
            Value::Sequence(vec![Value::String("@modusensus/dsh-mneme".to_string())])
        );
        assert_eq!(apply_allow_build_keys(&out, &keys).unwrap(), out);
    }

    #[test]
    fn apply_writes_both_allowbuilds_and_only_built_dependencies() {
        // pnpm 11 认 allowBuilds（map），pnpm 10 认 onlyBuiltDependencies（list），
        // 两者须同时写回，用户 pnpm 10 / 捆绑版 pnpm 11 都能读到放行项。
        let base = "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n";
        let out = apply_allow_build_keys(base, &["dsh-better-sidebar".to_string()]).unwrap();
        let doc: serde_yaml::Value = serde_yaml::from_str(&out).unwrap();
        // pnpm 11：allowBuilds 为 map 形式
        assert_eq!(
            doc["allowBuilds"]["dsh-better-sidebar"],
            serde_yaml::Value::Bool(true)
        );
        // pnpm 10：onlyBuiltDependencies 为 list 形式
        let only = doc
            .get("onlyBuiltDependencies")
            .and_then(serde_yaml::Value::as_sequence)
            .expect("onlyBuiltDependencies must be a sequence");
        assert_eq!(
            only,
            &vec![serde_yaml::Value::String("dsh-better-sidebar".to_string())]
        );
        // 基础设置被保留
        assert!(doc.get("packages").is_some());
        assert!(doc.get("nodeLinker").is_some());
    }

    #[test]
    fn apply_git_dep_path_writes_name_selector_for_pnpm10() {
        // 回归（CodeRabbit）：git 托管插件的完整 depPath 只写进 pnpm 11 的 allowBuilds
        // （按 resolution id 匹配）；pnpm 10 的 onlyBuiltDependencies 只按包名匹配，
        // 必须剥成纯包名，否则 pnpm 10 读不到放行项、prepare 构建仍会被门禁拦截。
        // 两个出口同时写好后，pnpm 10 / 11 之间切换都不会再次触发构建门禁。
        let base = "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n";
        let dep =
            "dsh-better-sidebar@git+ssh://git@github.com/omdsh-dev/DSH-better-sidebar.git#6c89"
                .to_string();
        let out = apply_allow_build_keys(base, std::slice::from_ref(&dep)).unwrap();
        let doc: serde_yaml::Value = serde_yaml::from_str(&out).unwrap();
        // pnpm 11：allowBuilds 保留完整 depPath
        assert_eq!(
            doc["allowBuilds"][&serde_yaml::Value::String(dep)],
            serde_yaml::Value::Bool(true)
        );
        // pnpm 10：onlyBuiltDependencies 只含纯包名
        let only = doc
            .get("onlyBuiltDependencies")
            .and_then(serde_yaml::Value::as_sequence)
            .expect("onlyBuiltDependencies must be a sequence");
        assert_eq!(
            only,
            &vec![serde_yaml::Value::String("dsh-better-sidebar".to_string())]
        );
    }

    #[test]
    fn apply_only_built_dependencies_preserves_existing_entries() {
        // onlyBuiltDependencies 已含旧条目时，只追加新键、不清空原有条目。
        let base = "packages:\n  - .\nallowBuilds:\n  esbuild: true\nonlyBuiltDependencies:\n  - esbuild\n";
        let out = apply_allow_build_keys(base, &["dsh-better-sidebar".to_string()]).unwrap();
        let doc: serde_yaml::Value = serde_yaml::from_str(&out).unwrap();
        let only = doc
            .get("onlyBuiltDependencies")
            .and_then(serde_yaml::Value::as_sequence)
            .expect("onlyBuiltDependencies must be a sequence");
        let names: Vec<&str> = only.iter().filter_map(|v| v.as_str()).collect();
        assert_eq!(names, vec!["esbuild", "dsh-better-sidebar"]);
    }

    #[test]
    fn apply_quotes_git_dep_path_keys() {
        let dep =
            "dsh-better-sidebar@git+ssh://git@github.com/omdsh-dev/DSH-better-sidebar.git#6c89"
                .to_string();
        // 空内容也能生成合法配置
        let out = apply_allow_build_keys("", std::slice::from_ref(&dep)).unwrap();
        let map = allow_builds_map(&out);
        assert_eq!(
            map.get(serde_yaml::Value::String(dep)),
            Some(&serde_yaml::Value::Bool(true))
        );
        // 库负责正确加引号，键原样（含 @ / : / #）可回读
        let doc: serde_yaml::Value = serde_yaml::from_str(&out).unwrap();
        assert_eq!(
            doc["allowBuilds"][&serde_yaml::Value::String(
                "dsh-better-sidebar@git+ssh://git@github.com/omdsh-dev/DSH-better-sidebar.git#6c89"
                    .to_string()
            )],
            serde_yaml::Value::Bool(true)
        );
    }

    #[test]
    fn apply_overwrites_placeholder_value_without_duplicate() {
        // 关键回归：旧版字符串拼接可能留下占位键 `node-pty: set this to true or false`
        // 与真实键并存。若解析保留重复键，或解析失败被去重兜底，最终都必须只保留
        // 一个 `node-pty: true`（不允许重复映射键）。
        let corrupted =
            "allowBuilds:\n  'dsh-better-sidebar@https://code...': true\n  node-pty: set this to true or false\n  'node-pty': true\n";
        let out = apply_allow_build_keys(corrupted, &["node-pty".to_string()]).unwrap();
        let map = allow_builds_map(&out);
        // 恰好只有一个 node-pty 键，值是 true（覆盖了占位值）
        assert_eq!(map.get("node-pty"), Some(&serde_yaml::Value::Bool(true)));
        // 序列化后全局不允许再出现“重复键”的等价行（node-pty 只出现一次）
        let node_pty_keys = out
            .lines()
            .filter(|l| {
                l.trim_start().starts_with("node-pty") || l.trim_start().starts_with("'node-pty'")
            })
            .count();
        assert_eq!(node_pty_keys, 1);
    }

    #[test]
    fn collapse_dedupes_allow_builds_keys() {
        let corrupted =
            "packages:\n  - .\nallowBuilds:\n  node-pty: set this to true or false\n  'node-pty': true\n  keep: true\n";
        let normalized = collapse_allow_builds_duplicates(corrupted);
        // 重复的 node-pty 只剩最后一个（值 true），同键不再重复
        let node_pty = normalized
            .lines()
            .filter(|l| {
                l.trim_start().starts_with("node-pty") || l.trim_start().starts_with("'node-pty'")
            })
            .count();
        assert_eq!(node_pty, 1);
        assert!(normalized.contains("keep"));
        // 去重结果必须是合法 YAML，且能被后续解析
        let out = apply_allow_build_keys(&normalized, &["node-pty".to_string()]).unwrap();
        assert_eq!(
            allow_builds_map(&out).get("node-pty"),
            Some(&serde_yaml::Value::Bool(true))
        );
    }

    /// issue #526：`---` 分隔的多文档 `pnpm-workspace.yaml` 在写回时归一化成单文档，
    /// 否则 pnpm（js-yaml `load`）仍然读不了这个文件。
    #[test]
    fn apply_normalizes_multi_document_workspace() {
        let multi = "packages:\n  - .\nnodeLinker: hoisted\n---\nautoInstallPeers: false\n";
        let out = apply_allow_build_keys(multi, &["node-pty".to_string()]).unwrap();

        // 输出必须是单文档：pnpm 与 serde_yaml 都只接受单文档流。
        assert_eq!(out.matches("\n---").count(), 0, "{out}");
        let doc: serde_yaml::Value = serde_yaml::from_str(&out).expect("output must be single-doc");
        assert!(doc.get("packages").is_some());
        assert!(doc.get("nodeLinker").is_some());
        assert_eq!(
            doc.get("autoInstallPeers")
                .and_then(serde_yaml::Value::as_bool),
            Some(false)
        );
        assert_eq!(
            allow_builds_map(&out).get("node-pty"),
            Some(&serde_yaml::Value::Bool(true))
        );
    }

    /// 多文档归一化后原样返回也必须是单文档（没有任何新键时走 `!dirty && !repaired`
    /// 的早返回分支，`repaired` 必须为真，否则损坏文本会被原样写回）。
    #[test]
    fn multi_document_workspace_is_rewritten_even_without_new_keys() {
        let multi = "packages:\n  - .\n---\nnodeLinker: hoisted\n";
        let out = apply_allow_build_keys(multi, &[]).unwrap();
        assert_eq!(out.matches("\n---").count(), 0, "{out}");
        assert!(serde_yaml::from_str::<serde_yaml::Value>(&out).is_ok());
    }
}
