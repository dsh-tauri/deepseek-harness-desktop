use std::path::Path;

use crate::utils::{patch_core_file, patch_dsh, PatchOutcome};

const CONVERSATION_CLIENT_JS: &str =
    "node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js";
const SET_DRAFT_ORIGINAL: &str =
    "setDraft(text) {\n\t\t\t\tthis.draftEditor.setDraft(text);\n\t\t\t}";
const SET_DRAFT_PATCHED: &str = r#"setDraft(text) {
                if (typeof text === "string") {
                    this.draftEditor.setDraft(text);
                    return;
                }
                const draft = text && typeof text.text === "string" ? text.text : "";
                const references = text?.references;
                let end = 0;
                const valid = Array.isArray(references) && references.every((reference) => {
                    if (!reference || typeof reference.source !== "string" || typeof reference.ref !== "string" || typeof reference.label !== "string" || typeof reference.clipboardText !== "string") return false;
                    if (!Number.isSafeInteger(reference.offset) || reference.offset < end || !Number.isSafeInteger(reference.length) || reference.length <= 0) return false;
                    if (reference.appearance !== void 0 && !["session", "file", "folder"].includes(reference.appearance)) return false;
                    if (reference.invalid !== void 0 && typeof reference.invalid !== "boolean") return false;
                    end = reference.offset + reference.length;
                    return reference.length === reference.clipboardText.length && end <= draft.length && draft.slice(reference.offset, end) === reference.clipboardText;
                });
                if (valid && references.length > 0) this.draftEditor.restoreDraft(draft, references);
                else this.draftEditor.setDraft(draft);
            }"#;

fn patch_source(source: &str) -> PatchOutcome {
    if source.contains(SET_DRAFT_PATCHED) {
        return PatchOutcome::AlreadyPatched;
    }
    if !source.contains(SET_DRAFT_ORIGINAL) {
        return PatchOutcome::AnchorMissing;
    }
    PatchOutcome::Patched(source.replacen(SET_DRAFT_ORIGINAL, SET_DRAFT_PATCHED, 1))
}

pub fn apply_at(core_dir: &Path) -> Result<(), String> {
    patch_core_file(core_dir, CONVERSATION_CLIENT_JS, patch_source)
}

pub fn apply(app_handle: &tauri::AppHandle) -> Result<(), String> {
    patch_dsh(app_handle, CONVERSATION_CLIENT_JS, patch_source)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patches_legacy_set_draft_once() {
        let source = format!("class SessionInputShell {{ {SET_DRAFT_ORIGINAL} }}");
        let PatchOutcome::Patched(patched) = patch_source(&source) else {
            panic!("expected Patched");
        };
        assert_eq!(
            patched,
            format!("class SessionInputShell {{ {SET_DRAFT_PATCHED} }}")
        );
        assert_eq!(patch_source(&patched), PatchOutcome::AlreadyPatched);
    }

    #[test]
    fn leaves_new_core_and_missing_anchor_unchanged() {
        let source = "setDraft(text) { const draft = resolveDraftInput(text); }";
        assert_eq!(patch_source(source), PatchOutcome::AnchorMissing);
    }
}
