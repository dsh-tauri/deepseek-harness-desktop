use serde_json::json;

pub const SHELL_HOST_ATTRIBUTE: &str = "data-dsh-shell-host";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Theme {
    Light,
    Dark,
}

impl Theme {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }
}

pub struct ShellInjection {
    source: String,
}

fn initial_theme_script(theme: Theme) -> String {
    format!(
        r#"const applyTheme = () => {{
  const root = document.documentElement;
  if (root) root.dataset.theme = {};
}};
if (document.documentElement) applyTheme();
else document.addEventListener('DOMContentLoaded', applyTheme, {{ once: true }});"#,
        json!(theme.as_str()),
    )
}

impl ShellInjection {
    pub fn new(theme: Theme) -> Option<Self> {
        let js = shell_module()?;
        let source = format!(
            r#"(() => {{
  if (!['tauri:', 'http:', 'https:'].includes(location.protocol)) return;
  globalThis.__DSH_HOSTED__ = true;
  {initial_theme}
  globalThis.__DSH_SHELL_THEME__ = {theme};
  globalThis.process ??= {{ env: {{ NODE_ENV: 'production' }}, emit() {{ return false }}, platform: 'browser', versions: {{}} }};
  if (globalThis.__DSH_SHELL_LOADED__) return;
  globalThis.__DSH_SHELL_LOADED__ = true;
  const url = URL.createObjectURL(new Blob([{js}], {{ type: 'text/javascript' }}));
  import(url).then((mod) => mod.startShell()).catch((error) => console.error('[shell] bootstrap failed', error)).finally(() => URL.revokeObjectURL(url));
}})();"#,
            theme = json!(theme.as_str()),
            initial_theme = initial_theme_script(theme),
            js = json!(js),
        );
        Some(Self { source })
    }

    pub fn source(&self) -> &str {
        &self.source
    }
}

#[cfg(not(debug_assertions))]
fn shell_module() -> Option<String> {
    Some(include_str!("../../../dist.shell/shell.mjs").to_owned())
}

#[cfg(debug_assertions)]
fn shell_module() -> Option<String> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../dist.shell/shell.mjs");
    std::fs::read_to_string(path).ok()
}

#[cfg(test)]
mod tests {
    use super::{Theme, initial_theme_script};

    #[test]
    fn initial_theme_waits_for_document_root_when_injected_at_document_start() {
        let script = initial_theme_script(Theme::Light);
        assert!(script.contains("if (document.documentElement) applyTheme();"));
        assert!(script.contains("else document.addEventListener('DOMContentLoaded', applyTheme, { once: true });"));
        assert!(script.contains(r#"if (root) root.dataset.theme = "light";"#));
    }
}
