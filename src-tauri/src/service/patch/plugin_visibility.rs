//! 插件可见性补丁：`dsh-tauri-*` 在官方插件页与插件市场里不出现。
//!
//! 桌面端内置插件以 profile bundle 身份加载，因此会同时落进官方 Web 侧的两个界面：
//! 官方侧边栏 Plugins 管理页把 profile 持有的 bundle 列进 Installed 分组，插件市场
//! （dshmarket）把 profile 依赖里不属于 inbox 的包列成社区插件。两处都只看「名字在
//! 不在自己的内置/inbox 名单里」——上游没有可配置的隐藏开关（`docs/specs/plugin.baisc.md`
//! 的退级策略把「桌面壳补丁」列为第二级手段），故这里对两个前端做幂等文件补丁：
//!
//! - 官方 `dsh-client-ui-plugin-manager` 的内置名单是硬编码的
//!   `BUILTIN_PROFILE_BUNDLES`，唯一使用点是分组过滤行 `listed`（Installed/Official
//!   两个分组、卡片、详情页都从它派生）。把 `dsh-tauri-*` 与该名单同等对待即可整组消失；
//! - dshmarket 的 `INBOX_BUNDLES` 只有 `.has()` 调用点，名单本身是字面量数组，按壳的
//!   内置插件与当前 profile 里实际出现的 `dsh-tauri-*` 包名的并集补齐即可。
//!
//! 壳自身的插件弹窗（`get_dsh_plugins` → `src/ui/config/plugin.tsx`）不经过这两个
//! 界面，因此不受影响。挂点与其它补丁一致：`service::workflow::launch` 启动 dsh
//! 进程前，最佳努力、失败仅告警；锚点缺失（上游改写布局）时安全跳过。

use std::collections::BTreeSet;
use std::path::Path;

use tauri::AppHandle;

use crate::service::plugin::{declared_packages, load_presets, profile_dir};
use crate::utils::{patch_core_file, patch_dsh, PatchOutcome};

/// 桌面端内置插件的包名前缀：`dsh-tauri-*` 一律视为「壳自己的插件」。
const PLUGIN_PREFIX: &str = "dsh-tauri";

/// 官方插件管理页前端 bundle（相对活动核心安装目录的包内路径）。
const PLUGIN_MANAGER_CLIENT_JS: &str =
    "node_modules/@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js";

/// 官方分组过滤行的函数头（分组过滤行的唯一来源，`Installed` / `Official` 都从它派生）。
const LISTED_PREFIX: &str = "const listed = state.packages.filter((pkg) => ";

/// 过滤行里判定「属于内置名单」的那一段：插入点就是它的末尾。
const BUILTIN_GUARD: &str = "!BUILTIN_PROFILE_BUNDLES.has(pkg.name) && ";

/// 壳插件判定，与 [`BUILTIN_GUARD`] 同级；它本身兼作补丁标记（幂等判据）。
const PREFIX_GUARD: &str = "!pkg.name.startsWith(\"dsh-tauri\") && ";

/// 插件市场登记 inbox bundle 的两份编译产物（相对活动 profile 目录）：`routes.js`
/// 从 `profile.js` 取名单，校验逻辑从 `order.js` 取，两份都要补。
const MARKET_BUNDLE_FILES: [&str; 2] = [
    "node_modules/dshmarket/lib/profile.js",
    "node_modules/dshmarket/lib/order.js",
];

/// marketplace 名单字面量的锚点（两份产物里的写法一致）。
const INBOX_ANCHOR: &str = "export const INBOX_BUNDLES = new Set([";

/// 官方插件页补丁的纯函数部分：在分组过滤行里追加 `dsh-tauri-*` 判定。
///
/// 只锚定函数头与「内置名单判定」两段，过滤条件其余部分（上游改过
/// `pkg.optional` → `pkg.official` 这类字段名）不参与匹配；判定已插入即视为已打过
/// （幂等，也认早期无标记版本打出的判定）；找不到这两段时安全跳过——宁可就地失效，
/// 也不要在未知布局上盲插。
fn patch_plugin_manager(source: &str) -> PatchOutcome {
    if source.contains(PREFIX_GUARD) {
        return PatchOutcome::AlreadyPatched;
    }
    let Some(start) = source.find(LISTED_PREFIX) else {
        return PatchOutcome::AnchorMissing;
    };
    let guard_start = start + LISTED_PREFIX.len();
    let Some(guard) = source[guard_start..].find(BUILTIN_GUARD) else {
        return PatchOutcome::AnchorMissing;
    };
    let insert_at = guard_start + guard + BUILTIN_GUARD.len();
    let mut patched = source.to_string();
    patched.insert_str(insert_at, PREFIX_GUARD);
    PatchOutcome::Patched(patched)
}

/// 插件市场名单补丁的纯函数部分：把 `names` 里尚未登记的名字追加进
/// `INBOX_BUNDLES` 字面量。
///
/// 插入点取名单本体最后一个非空白字符之后，换行与分隔符都只看**名单本体**（不看锚点
/// 之前的文件内容）：本体含换行则每个名字独占一行、按首个元素的对齐缩进；本体非空且
/// 末项没有尾逗号（单行数组，或末项没写逗号的多行数组）时先补一个逗号，保证生成的字面
/// 量始终合法。按名字逐个判定是否已存在，因此插件增减后再次启动会自动补齐（不做
/// 「整体已打过」的粗判，否则新增的 `dsh-tauri-*` 永远进不了名单）；名字全在名单里则
/// 返回 [`PatchOutcome::AlreadyPatched`]。找不到字面量、或本体里出现行注释（补出的分隔符
/// 会被注释吞掉）时返回 [`PatchOutcome::AnchorMissing`]。
fn patch_inbox_bundles(source: &str, names: &[String]) -> PatchOutcome {
    let Some(start) = source.find(INBOX_ANCHOR) else {
        return PatchOutcome::AnchorMissing;
    };
    let body_start = start + INBOX_ANCHOR.len();
    let Some(end) = source[body_start..].find("])") else {
        return PatchOutcome::AnchorMissing;
    };
    let body = &source[body_start..body_start + end];
    let missing: Vec<&str> = names
        .iter()
        .map(String::as_str)
        .filter(|name| !body.contains(&format!("'{name}'")))
        .collect();
    if missing.is_empty() {
        return PatchOutcome::AlreadyPatched;
    }

    // 名单本体里的行注释会让补出的分隔符被注释吞掉（`['a' // note` 这类形态），不解析 JS
    // 无法安全插入，按未知布局就地失效。
    if body.contains("//") {
        return PatchOutcome::AnchorMissing;
    }

    let multiline = body.contains('\n');
    let indent = if multiline {
        element_indent(source, body_start)
    } else {
        ""
    };
    let last = body.trim_end_matches([' ', '\t', '\r', '\n']);
    let separator = if last.is_empty() || last.ends_with(',') {
        ""
    } else {
        ","
    };
    let mut inserted = String::from(separator);
    for name in missing {
        if multiline {
            inserted.push('\n');
            inserted.push_str(indent);
        }
        inserted.push('\'');
        inserted.push_str(name);
        inserted.push_str("',");
    }
    let mut patched = source.to_string();
    patched.insert_str(body_start + last.len(), &inserted);
    PatchOutcome::Patched(patched)
}

/// `source` 从 `anchor` 之后第一个元素行的前导空白；用于让新元素与既有元素对齐。
fn element_indent(source: &str, anchor_end: usize) -> &str {
    let Some(offset) = source[anchor_end..].find('\n') else {
        return "";
    };
    let line_start = anchor_end + offset + 1;
    let line_end = source[line_start..]
        .find('\n')
        .map_or(source.len(), |end| line_start + end);
    &source[line_start..line_start + leading_blank_len(&source[line_start..line_end])]
}

/// 文本开头连续空白（空格/制表符）的字节数。
fn leading_blank_len(text: &str) -> usize {
    text.len() - text.trim_start_matches([' ', '\t']).len()
}

/// 名单里允许登记的包名：只接受 npm 包名的合法字符。
///
/// 名字来自 profile / 清单，直接拼进市场前端的单引号字面量；名字若含引号或换行会写坏
/// 产物，故此处按字符集白名单收口，异常名字直接不进名单。
fn is_safe_bundle_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '@' | '/' | '.' | '-' | '_'))
}

/// 把 `dsh-tauri-*` 从官方插件页与插件市场隐藏。
pub fn apply(app_handle: &AppHandle) -> Result<(), String> {
    patch_dsh(app_handle, PLUGIN_MANAGER_CLIENT_JS, patch_plugin_manager)?;
    let names = hidden_bundle_names(app_handle);
    if names.is_empty() {
        return Ok(());
    }
    let profile = profile_dir(app_handle);
    for file in MARKET_BUNDLE_FILES {
        patch_core_file(&profile, file, |source| {
            patch_inbox_bundles(source, &names)
        })?;
    }
    Ok(())
}

/// 对显式给定的核心安装目录施加官方插件页补丁（E2E 编排复用）。
///
/// 市场补丁作用于 profile 目录、且依赖 marketplace 是否安装，不在此列。
pub fn apply_at(core_dir: &Path) -> Result<(), String> {
    patch_core_file(core_dir, PLUGIN_MANAGER_CLIENT_JS, patch_plugin_manager)
}

/// 需要从官方插件页与插件市场隐藏的包名：壳的内置插件与当前 profile 里实际声明的
/// `dsh-tauri-*` 包名的并集（去重排序）。
///
/// 内置插件取自清单（debug 下含 `packages/*` 的发现结果）而非 profile，这样尚未装进
/// 档案、或正在自愈重装的新内置插件在第一次启动就被隐藏；profile 一侧覆盖早期以普通
/// 插件身份装进档案、已不在清单里的 `dsh-tauri-*`（例如 `dsh-tauri-session`）。任一侧
/// 读不到时退化为空，仍由另一侧决定名单；名字另按 [`is_safe_bundle_name`] 收口。
fn hidden_bundle_names(app_handle: &AppHandle) -> Vec<String> {
    let internal = load_presets(app_handle)
        .into_iter()
        .filter(|plugin| plugin.internal)
        .map(|plugin| plugin.package.unwrap_or(plugin.id));
    let declared = declared_packages(app_handle).unwrap_or_default();
    internal
        .chain(declared)
        .filter(|name| name.starts_with(PLUGIN_PREFIX) && is_safe_bundle_name(name))
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const LISTED_LINE: &str = "\t\t\tconst listed = state.packages.filter((pkg) => !BUILTIN_PROFILE_BUNDLES.has(pkg.name) && (pkg.installed || pkg.optional || pkg.error !== void 0));\n\t\t\tconst mine = listed.filter((pkg) => pkg.installed || !pkg.optional);\n";

    /// 官方 `dsh-client-ui-plugin-manager` 0.2.1-alpha.2 的真实过滤行：上游把
    /// `pkg.optional` 改成了 `pkg.official`，旧补丁的全行锚点因此失效。
    const LISTED_LINE_OFFICIAL: &str = "\t\t\tconst listed = state.packages.filter((pkg) => !BUILTIN_PROFILE_BUNDLES.has(pkg.name) && (pkg.installed || pkg.official || pkg.error !== void 0));\n\t\t\tconst mine = listed.filter((pkg) => !pkg.official);\n\t\t\tconst official = listed.filter((pkg) => pkg.official);\n";

    #[test]
    fn plugin_manager_hides_prefix_inside_group_filter() {
        match patch_plugin_manager(LISTED_LINE) {
            PatchOutcome::Patched(patched) => {
                assert!(patched.contains(
                    "!BUILTIN_PROFILE_BUNDLES.has(pkg.name) && !pkg.name.startsWith(\"dsh-tauri\") && (pkg.installed"
                ));
                assert!(patched.contains("const mine = listed.filter("));
            }
            other => panic!("expected Patched, got {other:?}"),
        }
    }

    /// 上游改字段名后补丁仍要生效：锚点只依赖函数头与内置名单判定。
    #[test]
    fn plugin_manager_hides_prefix_after_the_upstream_official_field() {
        match patch_plugin_manager(LISTED_LINE_OFFICIAL) {
            PatchOutcome::Patched(patched) => {
                assert!(patched.contains(
                    "!BUILTIN_PROFILE_BUNDLES.has(pkg.name) && !pkg.name.startsWith(\"dsh-tauri\") && (pkg.installed || pkg.official"
                ));
                assert!(patched.contains("const official = listed.filter((pkg) => pkg.official);"));
            }
            other => panic!("expected Patched, got {other:?}"),
        }
    }

    #[test]
    fn plugin_manager_is_idempotent() {
        let PatchOutcome::Patched(patched) = patch_plugin_manager(LISTED_LINE) else {
            panic!("expected Patched");
        };
        assert_eq!(patch_plugin_manager(&patched), PatchOutcome::AlreadyPatched);
        let PatchOutcome::Patched(patched) = patch_plugin_manager(LISTED_LINE_OFFICIAL) else {
            panic!("expected Patched");
        };
        assert_eq!(patch_plugin_manager(&patched), PatchOutcome::AlreadyPatched);
    }

    #[test]
    fn plugin_manager_skips_when_anchor_missing() {
        assert_eq!(
            patch_plugin_manager("\t\t\tconst listed = other.call();\n"),
            PatchOutcome::AnchorMissing
        );
    }

    /// 真实产物形态：单引号 + 四空格缩进 + 独立 `]);` 行。
    const INBOX: &str = "export const INBOX_BUNDLES = new Set([\n    '@deepseek-ai/dsh-base',\n    '@deepseek-ai/dsh-web-app',\n    '@deepseek-ai/dsh-headless',\n]);\n\nexport function readInstalled() {}\n";

    fn names() -> Vec<String> {
        vec!["dsh-tauri".to_string(), "dsh-tauri-ui".to_string()]
    }

    #[test]
    fn market_lists_are_extended_with_alignment() {
        match patch_inbox_bundles(INBOX, &names()) {
            PatchOutcome::Patched(patched) => {
                assert!(patched.contains(
                    "    '@deepseek-ai/dsh-headless',\n    'dsh-tauri',\n    'dsh-tauri-ui',\n]);"
                ));
                assert!(patched.ends_with("\n\nexport function readInstalled() {}\n"));
            }
            other => panic!("expected Patched, got {other:?}"),
        }
    }

    #[test]
    fn market_lists_append_only_missing_names() {
        let PatchOutcome::Patched(once) = patch_inbox_bundles(INBOX, &names()) else {
            panic!("expected Patched");
        };
        assert_eq!(patch_inbox_bundles(&once, &names()), PatchOutcome::AlreadyPatched);
        match patch_inbox_bundles(&once, &["dsh-tauri-scheduler".to_string()]) {
            PatchOutcome::Patched(patched) => {
                assert_eq!(patched.matches("'dsh-tauri',").count(), 1);
                assert!(patched.contains("'dsh-tauri-scheduler',\n]);"));
            }
            other => panic!("expected Patched, got {other:?}"),
        }
    }

    #[test]
    fn market_lists_handle_single_line_literal() {
        let source = "export const INBOX_BUNDLES = new Set(['@deepseek-ai/dsh-base']);\n";
        match patch_inbox_bundles(source, &names()) {
            PatchOutcome::Patched(patched) => {
                assert_eq!(
                    patched,
                    "export const INBOX_BUNDLES = new Set(['@deepseek-ai/dsh-base','dsh-tauri','dsh-tauri-ui',]);\n"
                );
            }
            other => panic!("expected Patched, got {other:?}"),
        }
    }

    #[test]
    fn market_patch_skips_when_anchor_missing() {
        assert_eq!(
            patch_inbox_bundles("const OTHER = new Set([]);\n", &names()),
            PatchOutcome::AnchorMissing
        );
    }

    /// 单行字面量出现在文件首行之后（此前按「锚点之前有没有换行」判断会漏补分隔符）。
    #[test]
    fn market_lists_handle_single_line_literal_after_a_header() {
        let source =
            "// header line\nexport const INBOX_BUNDLES = new Set(['@deepseek-ai/dsh-base']);\n";
        match patch_inbox_bundles(source, &names()) {
            PatchOutcome::Patched(patched) => assert_eq!(
                patched,
                "// header line\nexport const INBOX_BUNDLES = new Set(['@deepseek-ai/dsh-base','dsh-tauri','dsh-tauri-ui',]);\n"
            ),
            other => panic!("expected Patched, got {other:?}"),
        }
    }

    /// 多行字面量末项没有尾逗号（此前按「锚点之前有没有换行」判断会漏补分隔符）。
    #[test]
    fn market_lists_handle_multi_line_literal_without_trailing_comma() {
        let source = "export const INBOX_BUNDLES = new Set([\n    '@deepseek-ai/dsh-base'\n]);\n";
        let PatchOutcome::Patched(patched) = patch_inbox_bundles(source, &names()) else {
            panic!("expected Patched");
        };
        assert_eq!(
            patched,
            "export const INBOX_BUNDLES = new Set([\n    '@deepseek-ai/dsh-base',\n    'dsh-tauri',\n    'dsh-tauri-ui',\n]);\n"
        );
        assert_eq!(patch_inbox_bundles(&patched, &names()), PatchOutcome::AlreadyPatched);
    }

    /// 名单本体里有行注释时无法安全补分隔符（补出的逗号会被注释吞掉），就地失效。
    #[test]
    fn market_patch_skips_body_with_line_comment() {
        assert_eq!(
            patch_inbox_bundles(
                "export const INBOX_BUNDLES = new Set([\n    '@deepseek-ai/dsh-base' // note\n]);\n",
                &names()
            ),
            PatchOutcome::AnchorMissing
        );
    }

    #[test]
    fn bundle_names_must_be_plain_package_names() {
        assert!(is_safe_bundle_name("dsh-tauri-session"));
        assert!(is_safe_bundle_name("@scope/dsh-tauri.inner_v2"));
        assert!(!is_safe_bundle_name("dsh-tauri');evil('"));
        assert!(!is_safe_bundle_name("dsh-tauri\n"));
        assert!(!is_safe_bundle_name(""));
    }
}
