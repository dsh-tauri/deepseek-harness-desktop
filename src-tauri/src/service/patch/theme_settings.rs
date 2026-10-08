use std::path::Path;

use crate::utils::{patch_core_file, patch_dsh, PatchOutcome};

const CLIENT: &str = "node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js";
const PATCH_MARKER: &str = "dshPendingThemeWrites";
const THEME_WRITE: &str = r#"if (isThemePreference(id)) this.host.set(THEME_PREFERENCE_FIELD, id);"#;
const THEME_WRITE_PATCHED: &str =
    r#"if (isThemePreference(id)) this.dshWriteSetting(THEME_PREFERENCE_FIELD, id);"#;
const FONT_WRITE: &str = r#"this.host.set(FONT_SIZE_FIELD, px);"#;
const FONT_WRITE_PATCHED: &str = r#"this.dshWriteSetting(FONT_SIZE_FIELD, px);"#;
const ADOPT: &str = r#"			adopt() {
				const section = this.host.getSnapshot().value;"#;
const ADOPT_PATCHED: &str = r#"			dshPendingThemeWrites = 0;
			dshWriteSetting(field, value) {
				this.dshPendingThemeWrites++;
				const settle = () => {
					this.dshPendingThemeWrites--;
					this.adopt();
				};
				this.host.set(field, value).then(settle, settle);
			}
			adopt() {
				if (this.dshPendingThemeWrites > 0) return;
				const section = this.host.getSnapshot().value;"#;

fn patch_source(source: &str) -> PatchOutcome {
    if source.contains(PATCH_MARKER) {
        return PatchOutcome::AlreadyPatched;
    }
    let replacements = [
        (THEME_WRITE, THEME_WRITE_PATCHED),
        (FONT_WRITE, FONT_WRITE_PATCHED),
        (ADOPT, ADOPT_PATCHED),
    ];
    if replacements
        .iter()
        .any(|(before, _)| source.matches(*before).count() != 1)
    {
        return PatchOutcome::AnchorMissing;
    }
    let mut patched = source.to_owned();
    for (before, after) in replacements {
        patched = patched.replacen(before, after, 1);
    }
    PatchOutcome::Patched(patched)
}

pub fn apply_at(core_dir: &Path) -> Result<(), String> {
    patch_core_file(core_dir, CLIENT, patch_source)
}

pub fn apply(app_handle: &tauri::AppHandle) -> Result<(), String> {
    patch_dsh(app_handle, CLIENT, patch_source)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> String {
        [THEME_WRITE, FONT_WRITE, ADOPT].join("\n")
    }

    #[test]
    fn patches_both_writes_and_defers_adoption() {
        let PatchOutcome::Patched(patched) = patch_source(&fixture()) else {
            panic!("expected patched source");
        };
        assert!(patched.contains(THEME_WRITE_PATCHED));
        assert!(patched.contains(FONT_WRITE_PATCHED));
        assert!(patched.contains(ADOPT_PATCHED));
        assert_eq!(patch_source(&patched), PatchOutcome::AlreadyPatched);
    }

    #[test]
    fn skips_changed_or_ambiguous_core_without_partial_edits() {
        for anchor in [THEME_WRITE, FONT_WRITE, ADOPT] {
            assert_eq!(
                patch_source(&fixture().replace(anchor, "")),
                PatchOutcome::AnchorMissing
            );
            assert_eq!(
                patch_source(&format!("{}\n{anchor}", fixture())),
                PatchOutcome::AnchorMissing
            );
        }
        assert_eq!(patch_source(""), PatchOutcome::AnchorMissing);
    }
}
