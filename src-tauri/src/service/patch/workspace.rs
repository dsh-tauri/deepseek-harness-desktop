//! Workspace 会话归属补丁：允许显式 attach 的会话使用不同于 Workspace 的 cwd。
//!
//! worktree 会话必须以隔离目录作为 `session.header.cwd`，但产品上仍应归属源项目的
//! Workspace。上游 `@deepseek-ai/dsh-workspace` 同时在 attach、getter 与 mutate 三处按
//! `cwd === workspace.path` 过滤，导致合法 worktree 会话只能落入“未分组”。本补丁仅
//! 放宽显式 attach 后的归属保持；cwd 缺失、无法解析或不是目录的安全校验仍由上游保留。

use crate::utils::{patch_dsh, PatchOutcome};

// HARDCODE：以下锚点绑定内置 DSH 0.1.1-rc.2 的压缩后源码；锚点变化时安全跳过并告警。
const PATCH_MARKER: &str = "dsh-tauri-worktree: relaxed explicit workspace membership";
const GETTER_ORIGINAL: &str =
    "return this.record.sessionIds.filter((id) => this.host.sessionPath(id) === this.record.path);";
const GETTER_PATCHED: &str = "return this.record.sessionIds; /* dsh-tauri-worktree: relaxed explicit workspace membership */";
const ATTACH_ORIGINAL: &str = "if (cwd !== this.record.path) throw new Error(`cannot attach session '${sessionId}' to workspace '${this.record.path}': its cwd resolves to '${cwd}'`);";
const ATTACH_PATCHED: &str = "/* dsh-tauri-worktree: relaxed explicit workspace membership */";
const MUTATE_ORIGINAL: &str = "const sessionIds = changed.sessionIds.filter((id) => this.host.sessionPath(id) === changed.path);";
const MUTATE_PATCHED: &str = "const sessionIds = changed.sessionIds; /* dsh-tauri-worktree: relaxed explicit workspace membership */";

/// 相对活动核心安装目录的 workspace `lib/index.js` 包内路径。
pub(super) const WORKSPACE_INDEX_JS: &str = "node_modules/@deepseek-ai/dsh-workspace/lib/index.js";

fn patch_source(source: &str) -> PatchOutcome {
    if source.contains(PATCH_MARKER) {
        return PatchOutcome::AlreadyPatched;
    }
    if !source.contains(GETTER_ORIGINAL)
        || !source.contains(ATTACH_ORIGINAL)
        || !source.contains(MUTATE_ORIGINAL)
    {
        return PatchOutcome::AnchorMissing;
    }
    let patched = source
        .replacen(GETTER_ORIGINAL, GETTER_PATCHED, 1)
        .replacen(ATTACH_ORIGINAL, ATTACH_PATCHED, 1)
        .replacen(MUTATE_ORIGINAL, MUTATE_PATCHED, 1);
    PatchOutcome::Patched(patched)
}

/// 对活动核心的 dsh-workspace `lib/index.js` 应用补丁（幂等）。
/// 返回 Err 表示读/写失败；文件缺失、已打过、锚点变更均静默跳过（Ok）。
pub fn apply(app_handle: &tauri::AppHandle) -> Result<(), String> {
    patch_dsh(app_handle, WORKSPACE_INDEX_JS, patch_source)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> String {
        format!("{GETTER_ORIGINAL}\n{ATTACH_ORIGINAL}\n{MUTATE_ORIGINAL}\n")
    }

    #[test]
    fn patches_all_three_membership_guards() {
        let PatchOutcome::Patched(patched) = patch_source(&fixture()) else {
            panic!("expected patched source");
        };
        assert!(patched.contains(GETTER_PATCHED));
        assert!(patched.contains(ATTACH_PATCHED));
        assert!(patched.contains(MUTATE_PATCHED));
        assert!(!patched.contains(GETTER_ORIGINAL));
        assert!(!patched.contains(ATTACH_ORIGINAL));
        assert!(!patched.contains(MUTATE_ORIGINAL));
    }

    #[test]
    fn patch_is_idempotent() {
        let PatchOutcome::Patched(patched) = patch_source(&fixture()) else {
            panic!("expected patched source");
        };
        assert_eq!(patch_source(&patched), PatchOutcome::AlreadyPatched);
    }

    #[test]
    fn skips_partial_upstream_layout() {
        assert_eq!(patch_source(GETTER_ORIGINAL), PatchOutcome::AnchorMissing);
    }

    #[test]
    fn applies_to_alpha3_source_fragment() {
        // alpha.3 `@deepseek-ai/dsh-workspace` 重写了成员归属（sessionPaths /
        // rememberSessionPath 索引），但三处 attach/getter/mutate 成员过滤锚点与
        // rc.2 一致（已用 0.1.2-alpha.3 npm 产物的未打补丁 lib/index.js 片段核对）。
        // 用真实 alpha.3 片段断言补丁仍可应用，防升级再破。
        let alpha_attach = "if (header.cwd === void 0) throw new Error(`cannot attach session '${sessionId}' to workspace '${this.record.path}': its stored header carries no cwd to validate against`);\nlet cwd;\ncwd = await realpathNormalize(header.cwd);\nif (!(await stat(cwd)).isDirectory()) throw new Error(`cannot attach session '${sessionId}' to workspace '${this.record.path}': its cwd '${header.cwd}' is not a directory`);\n";
        let alpha_getter = "get sessionIds() {\nreturn this.record.sessionIds.filter((id) => this.host.sessionPath(id) === this.record.path);\n}";
        let alpha_mutate = "const sessionIds = changed.sessionIds.filter((id) => this.host.sessionPath(id) === changed.path);";
        // 还原被 GETTER/ATTACH/MUTATE 三个 ORIGINAL 片段锚定的真实成员源码。
        let source = format!(
            "{alpha_getter}\n{alpha_attach}{ATTACH_ORIGINAL}\n{alpha_mutate}\n"
        );
        let PatchOutcome::Patched(patched) = patch_source(&source) else {
            panic!("expected alpha.3 source to be patched");
        };
        assert!(patched.contains(GETTER_PATCHED));
        assert!(patched.contains(ATTACH_PATCHED));
        assert!(patched.contains(MUTATE_PATCHED));
        assert!(!patched.contains(ATTACH_ORIGINAL));
        assert!(!patched.contains(GETTER_ORIGINAL));
        assert!(!patched.contains(MUTATE_ORIGINAL));
    }
}
