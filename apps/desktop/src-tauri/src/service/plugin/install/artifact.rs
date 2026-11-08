//! 安装产物核验与修复：逐插件核验 `node_modules/<安装名>/package.json` 真实落盘
//! （防「假成功」），并就地补构建缺失的声明入口（`ensure_plugin_entry_built`，
//! 见 `dsh.plugin.json` / `package.json` 的 `main`/`exports` 解析）。

use crate::{AppHandle, Window};
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use tauri::{ Emitter};

use serde_json::Value as JsonValue;

use super::append_command_output;
use super::errors;
use super::installed_name;
use super::load_presets;
use super::profile_dir;
use super::InstallTarget;
use super::{new_process_owner, run_plugin_process, PreinstallLogPayload, PREINSTALL_LOG_EVENT};

pub(super) fn verify_installed_products(
    app_handle: &AppHandle,
    targets: &[InstallTarget],
    command_output: &str,
) -> Result<(), String> {
    let node_modules = profile_dir(app_handle).join("node_modules");
    let mut missing = Vec::new();
    for target in targets {
        // 无法静态得知包名的 spec（git / 任意 URL）跳过核验：把整条 spec 当目录名会
        // 制造必然失败的误报（见 [`super::spec::package_name_of_spec`]）。
        let Some(name) = target.name.as_deref() else {
            continue;
        };
        let manifest = node_modules.join(name).join("package.json");
        if manifest.is_file() {
            if let Err(e) = errors::clear(app_handle, &target.id) {
                log::warn!("failed to clear plugin error for {}: {e}", target.id);
            }
        } else {
            missing.push((target.id.clone(), manifest));
        }
    }
    if missing.is_empty() {
        return Ok(());
    }
    let detail = if let Some(source_detail) = bundled_source_missing_detail(app_handle, &missing) {
        source_detail
    } else {
        silent_install_failure_detail(&missing, command_output)
    };
    log::error!("{detail}");
    for (id, _) in &missing {
        if let Err(e) = errors::record(app_handle, id, "install", &detail) {
            log::warn!("failed to record plugin error for {id}: {e}");
        }
    }
    Err(detail)
}

/// 为 exit 0 但无落盘产物的假成功生成可操作诊断：明确缺失插件、预期清单路径，
/// 并区分「子进程完全无输出」与「有输出但仍未落盘」，方便日志反馈直接定位。
fn silent_install_failure_detail(missing: &[(String, PathBuf)], command_output: &str) -> String {
    let ids = missing
        .iter()
        .map(|(id, _)| id.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let manifests = missing
        .iter()
        .map(|(_, path)| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let output_hint = if command_output.trim().is_empty() {
        "The dsh plugin command produced no output."
    } else {
        "Review the preinstall log above for the command output."
    };
    format!(
        "PREINSTALL_SILENT_FAIL: dsh plugin exited with code 0, but no install artifact was created for [{ids}]. Expected package manifests: [{manifests}]. {output_hint} Retry the installation; if it repeats, include the preinstall log and these paths in the bug report."
    )
}

/// 当缺失产物来自「内置插件源目录缺失」时，返回精确、可操作的诊断；否则 None。
///
/// 内置插件以 `link:<捆绑目录绝对路径>` 形式安装（见 [`super::spec::preset_spec_for_install`]），
/// 当应用安装目录被移动 / 盘符变更 / 资源目录被清理时，pnpm 对指向不存在目录的
/// `link:` 依赖会**静默以 exit 0 成功**（日志特征 `Installing a dependency from a
/// non-existent directory`），留下悬空 junction 而 `package.json` 不可读——这正是
/// `PREINSTALL_SILENT_FAIL` 最常见的根因（表现为应用启动后 loader 抛
/// `ERR_MODULE_NOT_FOUND`，见 issue 启动失败日志链）。此时如实报告缺失的源目录与
/// 修复指引（重装应用 / 恢复资源），而不是让用户盲目重试。
fn bundled_source_missing_detail(
    app_handle: &AppHandle,
    missing: &[(String, PathBuf)],
) -> Option<String> {
    let resolve = |id: &str| super::bundled_plugin_dir(app_handle, id);
    bundled_source_missing_detail_with(missing, &resolve)
}

/// [`bundled_source_missing_detail`] 的纯函数形态：`resolve` 把插件 id 解析为内置
/// 捆绑源目录（None 表示该 id 非内置插件 / 源目录不可解析）。便于无 AppHandle 单测。
fn bundled_source_missing_detail_with(
    missing: &[(String, PathBuf)],
    resolve: &dyn Fn(&str) -> Option<PathBuf>,
) -> Option<String> {
    let mut source_missing: Vec<String> = Vec::new();
    for (id, _) in missing {
        let Some(dir) = resolve(id) else {
            continue;
        };
        if !dir.join("package.json").is_file() {
            source_missing.push(format!("{id}（{}）", dir.display()));
        }
    }
    if source_missing.is_empty() {
        return None;
    }
    Some(format!(
        "BUNDLED_PLUGIN_SOURCE_MISSING: 应用资源中的内置插件源目录缺失或不可读，pnpm 静默跳过安装（exit 0 无产物），导致以下内置插件未落盘: {}. 这些源目录随应用安装包分发；若应用安装目录被移动/删除、盘符变更或资源目录被清理，会触发此问题。请重新安装应用或恢复应用资源目录后重试。",
        source_missing.join("; ")
    ))
}

/// 解析插件包声明的主入口（与 cordis 加载器实际读取的字段一致）：
/// 优先 `dsh.plugin.json` 的 `main`（加载器入口，见 loader 报错路径），
/// 回落 `package.json` 的 `main` / `exports["."]`（字符串简写 → 对象
/// `default` → `import` → `require`）。
/// 仅负责解析声明，不校验产物是否存在；入口越界（`../` 逃逸/绝对路径）
/// 或无可解析入口时返回 None。
fn declared_main_entry(pkg_dir: &Path) -> Option<PathBuf> {
    /// 拼接声明入口并拒绝越界：绝对路径会被 `join` 整体替换基路径，`../`
    /// 逃逸在 `starts_with` 的词法比较下不会被解析——两者都会让核验目标指向
    /// 包外文件，导致假通过。
    fn join_contained(pkg_dir: &Path, entry: &str) -> Option<PathBuf> {
        let candidate = Path::new(entry);
        if candidate.is_absolute()
            || candidate
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return None;
        }
        let joined = pkg_dir.join(candidate);
        joined.starts_with(pkg_dir).then_some(joined)
    }
    let from_main_field = |value: &JsonValue| -> Option<PathBuf> {
        value
            .get("main")
            .and_then(|v| v.as_str())
            .and_then(|main| join_contained(pkg_dir, main))
    };
    let plugin_manifest_text = std::fs::read_to_string(pkg_dir.join("dsh.plugin.json")).ok();
    if let Some(text) = plugin_manifest_text
        && let Ok(value) = serde_json::from_str::<JsonValue>(&text)
        && let Some(entry) = from_main_field(&value)
    {
        return Some(entry);
    }
    let pkg_text = std::fs::read_to_string(pkg_dir.join("package.json")).ok()?;
    let value = serde_json::from_str::<JsonValue>(&pkg_text).ok()?;
    if let Some(entry) = from_main_field(&value) {
        return Some(entry);
    }
    let exports = value.get("exports");
    // 字符串简写："exports": "./lib/index.js"（`get(".")` 对字符串取值会落空，
    // 必须先试字符串形态）
    if let Some(shorthand) = exports.and_then(|v| v.as_str()) {
        return join_contained(pkg_dir, shorthand);
    }
    let dot = exports.and_then(|v| v.get("."));
    for key in ["default", "import", "require"] {
        if let Some(entry) = dot
            .and_then(|d| d.get(key))
            .and_then(|v| v.as_str())
            .and_then(|s| join_contained(pkg_dir, s))
        {
            return Some(entry);
        }
    }
    None
}

/// 把插件 id 解析为 profile 中实际的 npm 包名：预设表（`package` 覆盖字段）
/// 优先；找不到预设时按 profile 清单 `dependencies` 键的 basename 匹配
/// （覆盖 `@scope/name` 形态，如 `dsh-session-context-menu` →
/// `@baihejiangnan/dsh-session-context-menu`）。
pub(super) fn installed_package_name(app_handle: &AppHandle, id: &str) -> Option<String> {
    if let Some(preset) = load_presets(app_handle).iter().find(|p| p.id == id) {
        return Some(installed_name(preset).to_string());
    }
    let manifest_path = profile_dir(app_handle).join("package.json");
    let text = std::fs::read_to_string(&manifest_path).ok()?;
    let value = serde_json::from_str::<JsonValue>(&text).ok()?;
    value
        .get("dependencies")
        .and_then(|d| d.as_object())
        .and_then(|deps| {
            deps.keys()
                .find(|name| name.rsplit('/').next() == Some(id))
                .cloned()
        })
}

/// 核验已装插件包的声明入口产物，缺失时就地补构建或如实报错。
///
/// 背景：`verify_installed_products` 核验的是「包是否落盘」（`package.json`
/// 存在），但 pnpm 放行 git 托管插件的 `prepare` 后，构建仍可能停在不产出的
/// 坏态：tsdown 在 `node_modules` 内加载其 TS 配置受 Node 版本限制（报错建议
/// `--config-loader` 用 `tsx`/`unrun`），此时 `dsh plugin add` 以 0 退出且
/// `package.json` 已落盘，但 `lib/index.js` 缺失——下一次启动 cordis 加载器
/// `ERR_MODULE_NOT_FOUND` 崩溃（应用内所有 fetch 必挂，表现为「插件目录 /
/// 历史会话全部 Failed to fetch」）。
/// 补构建按成本递增：`run build` → `run prepare` → `exec tsdown --config-loader unrun`
/// （社区已知绕过方式，unrun 已随 tsdown 进插件 devDeps）。全部失败则记录错误并
/// 如实返回，杜绝「装上了却跑不起来」的静默成功。
///
/// `pkg_dir` 由调用方解析（install 用预设的 `installed_name`，update 用
/// `installed_package_name`），本函数不再假设 id 即包名。
pub(super) async fn ensure_plugin_entry_built(
    app_handle: &AppHandle,
    id: &str,
    pkg_dir: &Path,
    envs: &HashMap<String, String>,
    window: &Window,
) -> Result<(), String> {
    if !pkg_dir.is_dir() {
        return Err(format!(
            "PLUGIN_ENTRY_MISSING: {id} 未安装（{} 不存在），请重新安装",
            pkg_dir.display()
        ));
    }
    let Some(entry) = declared_main_entry(pkg_dir) else {
        // 无声明入口（包本身不暴露可核验产物）：不阻塞，仅告警
        log::warn!("plugin {id} declares no verifiable main entry, skipping build verify");
        return Ok(());
    };
    if entry.is_file() {
        return Ok(());
    }

    // 与 verify 修复路径同一套 store 主版本感知 pnpm 选择（捆绑版优先，不匹配
    // 时回落用户 pnpm.exe），不硬编码单一 pnpm，避免「装了用户版却没捆绑版」
    // 或 v10/v11 store 不兼容的假失败。
    let Some((program, pre_args)) = super::super::verify::pnpm_direct(app_handle).await? else {
        return Err(format!(
            "PNPM_NOT_FOUND: no usable pnpm (bundled or user) to rebuild plugin {id}"
        ));
    };
    log::warn!(
        "plugin {id} declared entry {} is missing; rebuilding in place",
        entry.display()
    );
    let attempts: [(&str, &[&str]); 3] = [
        ("build", &["run", "build"]),
        ("prepare", &["run", "prepare"]),
        (
            "tsdown --config-loader unrun",
            &["exec", "tsdown", "--config-loader", "unrun"],
        ),
    ];
    let mut all_output = String::new();
    for (label, args) in attempts {
        let _ = window.emit(
            PREINSTALL_LOG_EVENT,
            PreinstallLogPayload {
                line: format!(
                    "[pnpm] {id} 缺少构建产物（{}），正在补构建（{label}）…",
                    entry.display()
                ),
            },
        );
        let mut full_args = pre_args.clone();
        full_args.extend(args.iter().map(|a| OsString::from(*a)));
        // 单次 spawn 失败（pnpm 瞬时不可用等）不致命：记日志后尝试下一策略，
        // 输出跨尝试累计，保证最终报错携带最早一次的有效诊断。
        // main 侧 `run_plugin_process` 要求显式 ProcessOwner（pid 槽位跟踪/取消）；
        // 补构建是独立的一次性构建，不隶属 install/update 的操作锁，取新 owner。
        match run_plugin_process(
            &program,
            &full_args,
            pkg_dir,
            envs,
            window,
            new_process_owner(),
        )
        .await
        {
            Ok((code, output)) => {
                append_command_output(&mut all_output, &output);
                // 产物出现即视为成功（目标=「入口存在、加载器不崩」）；
                // 退出码非 0 但产物已生成（如 post-build 钩子失败）仅记警告。
                if entry.is_file() {
                    if code != 0 {
                        log::warn!(
                            "plugin {id} build via {label} exited {code} but entry {} exists",
                            entry.display()
                        );
                    }
                    log::info!("plugin {id} rebuilt via {label}: {}", entry.display());
                    return Ok(());
                }
                log::warn!("plugin {id} build via {label} exited {code}; trying next strategy");
            }
            Err(e) => {
                log::warn!(
                    "plugin {id} build via {label} failed to spawn: {e}; trying next strategy"
                );
            }
        }
    }
    let tail = all_output
        .lines()
        .rev()
        .take(8)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    Err(format!(
        "PLUGIN_ENTRY_MISSING: {id} 声明的入口 {} 构建失败（build/prepare 均未产出），尾部日志：\n{tail}",
        entry.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn silent_install_failure_reports_empty_output_and_expected_artifact() {
        let missing = vec![(
            "dsh-win-terminal-inspector".to_string(),
            PathBuf::from(
                "C:\\Users\\test\\.dsh\\profiles\\web\\node_modules\\dsh-win-terminal-inspector\\package.json",
            ),
        )];

        let detail = silent_install_failure_detail(&missing, "  \r\n");

        assert!(detail.starts_with("PREINSTALL_SILENT_FAIL:"));
        assert!(detail.contains("dsh-win-terminal-inspector"));
        assert!(detail.contains("package.json"));
        assert!(detail.contains("produced no output"));
        assert!(detail.contains("Retry the installation"));
    }

    /// 验证已有命令日志时，引导用户查看日志而不会误报为完全无输出。
    #[test]
    fn silent_install_failure_points_to_existing_command_log() {
        let missing = vec![(
            "dshmarket".to_string(),
            PathBuf::from("/tmp/profile/node_modules/dshmarket/package.json"),
        )];

        let detail = silent_install_failure_detail(&missing, "pnpm completed\n");

        assert!(detail.contains("Review the preinstall log above"));
        assert!(!detail.contains("produced no output"));
    }

    /// 内置插件源目录缺失：诊断应精确报出 BUNDLED_PLUGIN_SOURCE_MISSING 与源路径、
    /// 修复指引，而不是笼统的 silent-fail 文案。
    #[test]
    fn bundled_source_missing_reports_actionable_detail() {
        let missing = vec![
            (
                "dsh-tauri".to_string(),
                PathBuf::from("C:\\Users\\t\\.dsh\\profiles\\safe\\node_modules\\dsh-tauri\\package.json"),
            ),
            (
                "dsh-tauri-ui".to_string(),
                PathBuf::from("C:\\Users\\t\\.dsh\\profiles\\safe\\node_modules\\dsh-tauri-ui\\package.json"),
            ),
        ];
        // 两个内置插件都解析到源目录，但源目录下 package.json 均不可读（缺失源）
        let resolve = |id: &str| {
            Some(PathBuf::from(format!(
                "E:\\Deepseek Harness Desktop\\resources\\node_modules\\{id}"
            )))
        };

        let detail = bundled_source_missing_detail_with(&missing, &resolve).expect("diagnosed");

        assert!(detail.starts_with("BUNDLED_PLUGIN_SOURCE_MISSING:"));
        assert!(detail.contains("dsh-tauri"));
        assert!(detail.contains("dsh-tauri-ui"));
        // 源目录按平台原生分隔符展示（Windows 反斜杠 / Unix 正斜杠）
        assert!(detail.contains("Deepseek Harness Desktop"));
        assert!(detail.contains("resources"));
        assert!(detail.contains("node_modules"));
        assert!(detail.contains("重新安装应用"));
    }

    /// 源目录可解析且 package.json 可读（真实存在）时，不属于「源缺失」，返回 None，
    /// 回落通用 silent-fail 诊断。
    #[test]
    fn bundled_source_present_falls_back_to_generic_detail() {
        let root = std::env::temp_dir().join(format!(
            "dsh-source-present-test-{}",
            std::process::id()
        ));
        let dir = root.join("dsh-tauri");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("package.json"), r#"{"name":"dsh-tauri"}"#).unwrap();

        let missing = vec![(
            "dsh-tauri".to_string(),
            root.join("node_modules/dsh-tauri/package.json"),
        )];
        let resolve = |_: &str| Some(dir.clone());

        assert!(bundled_source_missing_detail_with(&missing, &resolve).is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 缺失插件不是内置插件（resolve 返回 None）时，不误报源缺失，回落通用诊断。
    #[test]
    fn non_internal_missing_plugin_falls_back_to_generic_detail() {
        let missing = vec![(
            "dshmarket".to_string(),
            PathBuf::from("/tmp/profile/node_modules/dshmarket/package.json"),
        )];
        let resolve = |_: &str| None;

        assert!(bundled_source_missing_detail_with(&missing, &resolve).is_none());
    }

    /// 构造独立的临时插件包目录（含 `package.json`），供入口解析用例使用。
    fn tmp_pkg_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("dsh-entry-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn declared_main_prefers_dsh_plugin_manifest() {
        let dir = tmp_pkg_dir("manifest");
        std::fs::write(
            dir.join("dsh.plugin.json"),
            r#"{"id":"x","main":"./lib/index.js"}"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("package.json"),
            r#"{"name":"x","main":"dist/index.js"}"#,
        )
        .unwrap();
        assert_eq!(declared_main_entry(&dir).unwrap(), dir.join("lib/index.js"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn declared_main_falls_back_to_package_json() {
        let dir = tmp_pkg_dir("pkgjson");
        std::fs::write(
            dir.join("package.json"),
            r#"{"name":"x","main":"lib/index.js"}"#,
        )
        .unwrap();
        assert_eq!(declared_main_entry(&dir).unwrap(), dir.join("lib/index.js"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn declared_main_reads_exports_default() {
        let dir = tmp_pkg_dir("exports");
        std::fs::write(
            dir.join("package.json"),
            r#"{"name":"x","exports":{".":{"types":"./lib/types.d.ts","default":"./lib/index.js"}}}"#,
        )
        .unwrap();
        assert_eq!(declared_main_entry(&dir).unwrap(), dir.join("lib/index.js"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn declared_main_reads_exports_string_shorthand_and_require() {
        let dir = tmp_pkg_dir("exports-shorthand");
        std::fs::write(
            dir.join("package.json"),
            r#"{"name":"x","exports":"./dist/main.js"}"#,
        )
        .unwrap();
        assert_eq!(declared_main_entry(&dir).unwrap(), dir.join("dist/main.js"));
        let _ = std::fs::remove_dir_all(&dir);

        let dir2 = tmp_pkg_dir("exports-require");
        std::fs::write(
            dir2.join("package.json"),
            r#"{"name":"x","exports":{".":{"require":"./cjs/index.js"}}}"#,
        )
        .unwrap();
        assert_eq!(
            declared_main_entry(&dir2).unwrap(),
            dir2.join("cjs/index.js")
        );
        let _ = std::fs::remove_dir_all(&dir2);
    }

    #[test]
    fn declared_main_rejects_escaping_or_absolute_entries() {
        // `../` 逃逸与绝对路径都不应通过核验：防止把检查指向包外文件造成假通过
        let dir = tmp_pkg_dir("escape");
        std::fs::write(
            dir.join("package.json"),
            r#"{"name":"x","main":"../outside/index.js"}"#,
        )
        .unwrap();
        assert!(declared_main_entry(&dir).is_none());
        let absolute_entry = if cfg!(windows) {
            "C:\\\\outside\\\\index.js"
        } else {
            "/outside/index.js"
        };
        std::fs::write(
            dir.join("package.json"),
            format!(r#"{{"name":"x","main":"{}"}}"#, absolute_entry),
        )
        .unwrap();
        assert!(declared_main_entry(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn declared_main_falls_through_broken_plugin_manifest() {
        // dsh.plugin.json 存在但损坏/无 main 时，回落 package.json
        let dir = tmp_pkg_dir("broken-plugin-manifest");
        std::fs::write(dir.join("dsh.plugin.json"), r#"not-json"#).unwrap();
        std::fs::write(
            dir.join("package.json"),
            r#"{"name":"x","main":"lib/index.js"}"#,
        )
        .unwrap();
        assert_eq!(declared_main_entry(&dir).unwrap(), dir.join("lib/index.js"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn declared_main_none_without_manifest() {
        let dir = tmp_pkg_dir("none");
        assert!(declared_main_entry(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
