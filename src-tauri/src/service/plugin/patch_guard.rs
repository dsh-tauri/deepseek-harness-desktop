//! 补丁层语法错误的隔离：让安全模式在用户补丁层损坏时仍然可用。
//!
//! `$DSH_HOME/cordis.patch.yml`（机器级 home 层）与
//! `$DSH_HOME/profiles/<id>/cordis.patch.yml`（档案层）都是用户可手写的 YAML
//! 补丁层。上游 dsh 的契约是「文件存在却不能被应用时必须大声失败，绝不静默跳过」
//! （`@deepseek-ai/dsh-app-boot` 的 `loadOptionalPatches` 明确写着这一点），桌面端
//! 的内置插件自愈（[`super::internal::repair_loader_state`]）同样在解析阶段直接失败。
//! 于是一处手写笔误——典型是 `!!js` 表达式里带 `: `/`?` 却没加引号——会让应用
//! **永久不可用**：每次启动都停在同一处，而唯一的兜底入口「安全模式」也走同一份
//! home 层（home 层作用于所有档案，安全档案不例外），连兜底一起失效（issue #525）。
//!
//! 因此这里提供「隔离」这一**显式**恢复动作：把解析不了的补丁文件改名为
//! `<原文件名>.broken-<UTC 时间戳>`（绝不删除，内容原样保留），决定权交回用户
//! ——修好语法后改回原名即可恢复。只有用户点「安全模式」或错误页的「隔离损坏的
//! 补丁文件」时才执行，绝不自动发生；普通档案的启动路径仍然按上游契约大声失败，
//! 由前端给出「哪个文件、哪一行、怎么改」的针对性提示。

use std::path::{Path, PathBuf};

use tauri::AppHandle;

use super::patch_entries::{
    scan_unresolved_entries_in, unresolved_entries_message, PATCH_ENTRY_UNRESOLVED,
};
use super::profile_dir;
use crate::config;

/// dsh 的补丁层文件名：档案层与 home 层同名，靠目录区分。
const PATCH_FILENAME: &str = "cordis.patch.yml";

/// 一个已被隔离（改名保存）的补丁层。
#[derive(Debug, Clone, serde::Serialize)]
pub struct QuarantinedPatchLayer {
    /// 原始补丁文件路径。
    pub original: String,
    /// 备份路径（`<原名>.broken-<UTC 时间戳>`）。
    pub backup: String,
    /// 解析错误（serde_yaml 文本，含行列号）。
    pub error: String,
}

/// 一个无法移动的损坏补丁层（隔离失败）：调用方只记录，不阻断。
#[derive(Debug, Clone, serde::Serialize)]
pub struct PatchQuarantineFailure {
    /// 补丁文件路径。
    pub path: String,
    /// 改名失败原因。
    pub error: String,
}

/// 一次隔离动作的结果：成功移走的层 + 未能移走的层。
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct PatchQuarantineReport {
    /// 已隔离（改名保存）的补丁层，前端据此提示备份路径。
    pub quarantined: Vec<QuarantinedPatchLayer>,
    /// 隔离失败的补丁层，只进日志与提示，不影响其它层。
    pub failures: Vec<PatchQuarantineFailure>,
}

impl PatchQuarantineReport {
    /// 是否有损坏层仍未移走。
    ///
    /// 非空时调用方**绝不能**重启或切档案：不可解析的文件还在原地，上游契约要求
    /// 启动再次大声失败，于是又回到同一个失败循环（issue #525 的形态）。此时应把
    /// 失败原因交给用户，由用户手动改名或修复权限后重试。
    pub fn has_failures(&self) -> bool {
        !self.failures.is_empty()
    }
}

/// 补丁层路径：档案层在前、home 层在后（与 dsh 的层叠顺序一致）。
///
/// 与 [`super::internal::repair_loader_state`] 共用同一份清单，避免两处对
/// 「哪些补丁层需要自愈」的认知漂移。
pub(crate) fn patch_layer_paths(profile_dir: &Path, dsh_home: &Path) -> [PathBuf; 2] {
    [
        profile_dir.join(PATCH_FILENAME),
        dsh_home.join(PATCH_FILENAME),
    ]
}

pub(crate) fn preflight_at(
    profile: &Path,
    data_home: &Path,
    install_anchor: Option<&Path>,
) -> Result<(), String> {
    let entries = scan_unresolved_entries_in(profile, data_home, install_anchor);
    if entries.is_empty() {
        return Ok(());
    }
    let names = entries
        .iter()
        .map(|entry| format!("{}:{} {}", entry.layer, entry.line, entry.name))
        .collect::<Vec<_>>()
        .join(", ");
    log::error!("{PATCH_ENTRY_UNRESOLVED}: {names}");
    Err(unresolved_entries_message(&entries))
}

/// 解析补丁层：语法错误时返回 serde_yaml 的错误文本（含行列号）。
///
/// 文件不存在、读不出来（权限错位/竞态）都不算语法错误——那些由可写性预检与
/// 上游自身的错误路径负责，本模块只处理「文件在、但 YAML 解析不了」。
fn parse_error(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_yaml::from_str::<serde_yaml::Value>(&raw)
        .err()
        .map(|error| error.to_string())
}

/// 备份路径 `<原名>.<suffix>-<stamp>`；已存在时追加 `-2`、`-3`…，绝不覆盖已有备份。
///
/// `suffix` 由调用方给定：语法错误用 `broken`（隔离，改名保存），悬空条目用
/// `bak`（清理，改写前留底），两者在同一个档案目录里必须一眼可分。
pub(super) fn backup_path(path: &Path, suffix: &str, stamp: &str) -> PathBuf {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut candidate = path.with_file_name(format!("{name}.{suffix}-{stamp}"));
    let mut extra = 2;
    while candidate.exists() {
        candidate = path.with_file_name(format!("{name}.{suffix}-{stamp}-{extra}"));
        extra += 1;
    }
    candidate
}

/// 隔离给定补丁层里所有解析失败的文件。
///
/// 每层独立处理：某一层改名失败不阻断其它层（与启动期其它自愈同一策略——清理不
/// 彻底只是恢复效果打折，把已能恢复的层留在原地则让应用彻底不可用）。
fn quarantine_layers(paths: &[PathBuf], stamp: &str) -> PatchQuarantineReport {
    let mut report = PatchQuarantineReport::default();
    for path in paths {
        let Some(error) = parse_error(path) else {
            continue;
        };
        let backup = backup_path(path, "broken", stamp);
        match std::fs::rename(path, &backup) {
            Ok(()) => {
                log::warn!(
                    "PATCH_LAYER_QUARANTINED: {} -> {} ({error})",
                    path.display(),
                    backup.display()
                );
                report.quarantined.push(QuarantinedPatchLayer {
                    original: path.display().to_string(),
                    backup: backup.display().to_string(),
                    error,
                });
            }
            Err(rename_error) => {
                let message = rename_error.to_string();
                log::warn!(
                    "PATCH_LAYER_QUARANTINE_FAILED: {}: {message}",
                    path.display()
                );
                report.failures.push(PatchQuarantineFailure {
                    path: path.display().to_string(),
                    error: message,
                });
            }
        }
    }
    report
}

/// 生成 UTC 时间戳（`yyyymmddhhmmss`），与档案备份、插件快照的命名一致。
pub(super) fn now_stamp() -> String {
    use time::OffsetDateTime;
    let now = OffsetDateTime::now_utc();
    let date = now.date();
    let time = now.time();
    format!(
        "{:04}{:02}{:02}{:02}{:02}{:02}",
        date.year(),
        date.month() as u8,
        date.day(),
        time.hour(),
        time.minute(),
        time.second()
    )
}

/// 隔离指定档案层与 home 层里解析失败的补丁文件。
///
/// 只改名、不删除、不改内容：用户可以修好语法后把备份改回原名。
pub(crate) fn quarantine_patch_layers_in(
    profile_dir: &Path,
    dsh_home: &Path,
) -> PatchQuarantineReport {
    quarantine_layers(&patch_layer_paths(profile_dir, dsh_home), &now_stamp())
}

/// 隔离「当前档案层 + home 层」里解析失败的补丁文件。
///
/// 由错误页的「隔离损坏的补丁文件并重启」入口调用：用户想留在自己的档案里恢复。
pub(crate) fn quarantine_active_patch_layers(app_handle: &AppHandle) -> PatchQuarantineReport {
    quarantine_patch_layers_in(
        &profile_dir(app_handle),
        &config::get_dsh_data_path(app_handle),
    )
}

/// 把隔离失败的层拼成给用户的错误串（含路径与原因）。
///
/// 前缀 `PATCH_LAYER_QUARANTINE_FAILED` 与日志一致，便于从日志面板回查。
pub(crate) fn quarantine_failure_message(report: &PatchQuarantineReport) -> String {
    let detail = report
        .failures
        .iter()
        .map(|failure| format!("{}: {}", failure.path, failure.error))
        .collect::<Vec<_>>()
        .join("; ");
    format!("PATCH_LAYER_QUARANTINE_FAILED: {detail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造独立的临时目录，供补丁层用例使用。
    fn tmp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dsh-patch-guard-{name}-{}-{}",
            std::process::id(),
            now_stamp()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// issue #525 的真实形态：`!!js` 表达式带 `: ` 却没加引号。
    const BROKEN_UNQUOTED_JS: &str = r#"- id: session-telemetry-otel
  config:
    YUNXIAO_ACCESS_TOKEN: !!js process.env.TOKEN ? process.env.TOKEN : (function () { return '' })()
"#;
    const VALID_LAYER: &str = "- id: dsh-base\n  disabled: false\n";

    #[test]
    fn preflight_at_rereads_both_layers_and_uses_the_real_install_anchor_resolution() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let profile = home.join("profiles/probe");
        std::fs::create_dir_all(&profile).unwrap();
        let manifest = profile.join("package.json");
        std::fs::write(
            &manifest,
            r#"{"dependencies":{"dsh-preflight-probe":"1.0.0"}}"#,
        )
        .unwrap();
        let layer = "- insert:\n    - id: probe\n      name: dsh-preflight-probe\n";
        let paths = patch_layer_paths(&profile, &home);
        for path in &paths {
            std::fs::write(path, layer).unwrap();
        }

        let error = preflight_at(&profile, &home, None).unwrap_err();
        let payload: serde_json::Value = serde_json::from_str(
            error
                .strip_prefix("PATCH_LAYER_ENTRY_UNRESOLVED: ")
                .unwrap(),
        )
        .unwrap();
        let entries = payload["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        for (entry, path) in entries.iter().zip(&paths) {
            assert_eq!(entry["layer"], path.display().to_string());
            assert_eq!(entry["line"], 3);
            assert_eq!(entry["name"], "dsh-preflight-probe");
            assert_eq!(entry["declared"], true);
            assert_eq!(std::fs::read_to_string(path).unwrap(), layer);
        }

        let anchor = temp.path().join("core/lib/bin.js");
        let installed = temp.path().join("core/node_modules/dsh-preflight-probe");
        std::fs::create_dir_all(&installed).unwrap();
        let package = installed.join("package.json");
        std::fs::write(&package, "{}\n").unwrap();
        assert_eq!(preflight_at(&profile, &home, Some(&anchor)), Ok(()));
        std::fs::remove_file(package).unwrap();
        assert!(preflight_at(&profile, &home, Some(&anchor))
            .unwrap_err()
            .starts_with("PATCH_LAYER_ENTRY_UNRESOLVED: "));
    }

    #[test]
    fn parse_error_reports_unquoted_js_expression() {
        let dir = tmp_dir("parse-error");
        let path = dir.join(PATCH_FILENAME);
        std::fs::write(&path, BROKEN_UNQUOTED_JS).unwrap();

        // 这一形态必须被判为语法错误，否则 #525 的补丁层不会被隔离。
        assert!(parse_error(&path).is_some());
        std::fs::write(&path, VALID_LAYER).unwrap();
        assert!(parse_error(&path).is_none());
        // 不存在的文件不是语法错误（由上游与可写性预检负责）。
        assert!(parse_error(&dir.join("missing.yml")).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn quarantine_moves_only_unparsable_layers() {
        let profile = tmp_dir("quarantine-profile");
        let home = tmp_dir("quarantine-home");
        let profile_patch = profile.join(PATCH_FILENAME);
        let home_patch = home.join(PATCH_FILENAME);
        std::fs::write(&profile_patch, VALID_LAYER).unwrap();
        std::fs::write(&home_patch, BROKEN_UNQUOTED_JS).unwrap();

        let report = quarantine_patch_layers_in(&profile, &home);

        assert!(report.failures.is_empty(), "{:?}", report.failures);
        assert_eq!(report.quarantined.len(), 1);
        let record = &report.quarantined[0];
        assert_eq!(record.original, home_patch.display().to_string());
        // 原文件被移走、备份保留原始内容（绝不删除）。
        assert!(!home_patch.exists());
        assert_eq!(
            std::fs::read_to_string(&record.backup).unwrap(),
            BROKEN_UNQUOTED_JS
        );
        // 合法的档案层原样保留，且不产生备份。
        assert_eq!(
            std::fs::read_to_string(&profile_patch).unwrap(),
            VALID_LAYER
        );
        assert_eq!(std::fs::read_dir(&profile).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(&profile);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn quarantine_is_idempotent() {
        let profile = tmp_dir("idempotent-profile");
        let home = tmp_dir("idempotent-home");
        std::fs::write(home.join(PATCH_FILENAME), BROKEN_UNQUOTED_JS).unwrap();

        assert_eq!(
            quarantine_patch_layers_in(&profile, &home)
                .quarantined
                .len(),
            1
        );
        // 第二次调用：文件已不在，不再产生任何动作（可反复点「安全模式」）。
        let second = quarantine_patch_layers_in(&profile, &home);
        assert!(second.quarantined.is_empty());
        assert!(second.failures.is_empty());
        let _ = std::fs::remove_dir_all(&profile);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn backup_path_never_overwrites_existing_backup() {
        let dir = tmp_dir("backup-collision");
        let patch = dir.join(PATCH_FILENAME);
        std::fs::write(&patch, BROKEN_UNQUOTED_JS).unwrap();
        let first = dir.join(format!("{PATCH_FILENAME}.broken-20260914123456"));
        std::fs::write(&first, "keep me\n").unwrap();

        let report = quarantine_layers(std::slice::from_ref(&patch), "20260914123456");

        assert_eq!(report.quarantined.len(), 1);
        let record = &report.quarantined[0];
        assert!(record.backup.ends_with("-2"), "{}", record.backup);
        // 既有备份内容不被覆盖。
        assert_eq!(std::fs::read_to_string(&first).unwrap(), "keep me\n");
        assert_eq!(
            std::fs::read_to_string(&record.backup).unwrap(),
            BROKEN_UNQUOTED_JS
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn quarantine_ignores_valid_and_missing_layers() {
        let profile = tmp_dir("valid-profile");
        let home = tmp_dir("valid-home");
        std::fs::write(profile.join(PATCH_FILENAME), VALID_LAYER).unwrap();
        std::fs::write(home.join(PATCH_FILENAME), "[]\n").unwrap();

        let report = quarantine_patch_layers_in(&profile, &home);

        assert!(report.quarantined.is_empty());
        assert!(report.failures.is_empty());
        assert_eq!(
            std::fs::read_to_string(profile.join(PATCH_FILENAME)).unwrap(),
            VALID_LAYER
        );
        let _ = std::fs::remove_dir_all(&profile);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn patch_layer_paths_are_profile_then_home() {
        let paths = patch_layer_paths(Path::new("/profiles/safe"), Path::new("/dsh-home"));
        assert_eq!(paths[0], Path::new("/profiles/safe").join(PATCH_FILENAME));
        assert_eq!(paths[1], Path::new("/dsh-home").join(PATCH_FILENAME));
    }

    /// 隔离失败时报告必须标记出来，让调用方拒绝重启/切档案（否则回到同一个失败循环）。
    ///
    /// 无法稳定制造改名失败（`backup_path` 会避让已存在的备份，权限/占用又依赖环境），
    /// 这里直接构造失败报告，锁定「报告 → has_failures / 错误串」的契约本身。
    #[test]
    fn report_flags_failures_and_renders_message() {
        let broken = PathBuf::from("/profiles/safe/cordis.patch.yml");
        let report = PatchQuarantineReport {
            quarantined: Vec::new(),
            failures: vec![PatchQuarantineFailure {
                path: broken.display().to_string(),
                error: "Access is denied. (os error 5)".to_string(),
            }],
        };

        assert!(report.has_failures());
        let message = quarantine_failure_message(&report);
        assert!(
            message.starts_with("PATCH_LAYER_QUARANTINE_FAILED: "),
            "{message}"
        );
        assert!(message.contains(&broken.display().to_string()), "{message}");
        assert!(message.contains("os error 5"), "{message}");
    }

    /// 全部隔离成功时 `has_failures` 必须为假，成功路径才能继续重启。
    #[test]
    fn successful_quarantine_has_no_failures() {
        let profile = tmp_dir("success-profile");
        let home = tmp_dir("success-home");
        std::fs::write(home.join(PATCH_FILENAME), BROKEN_UNQUOTED_JS).unwrap();

        let report = quarantine_patch_layers_in(&profile, &home);

        assert!(!report.has_failures());
        assert_eq!(report.quarantined.len(), 1);
        let _ = std::fs::remove_dir_all(&profile);
        let _ = std::fs::remove_dir_all(&home);
    }
}
