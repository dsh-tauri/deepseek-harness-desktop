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
        r#"const initialTheme = {};
const applyTheme = () => {{
  const root = document.documentElement;
  if (root) root.dataset.theme = initialTheme;
}};
if (document.documentElement) applyTheme();
else document.addEventListener('DOMContentLoaded', applyTheme, {{ once: true }});
let bootPreference;
let bootBackground;
let previousBackground;
let previousPriority;
function releaseThemeHydration() {{
  themeHydration.disconnect();
  const body = document.body;
  if (body && bootBackground !== undefined && body.style.backgroundColor === bootBackground) {{
    if (previousBackground) body.style.setProperty('background-color', previousBackground, previousPriority);
    else body.style.removeProperty('background-color');
  }}
}}
document.addEventListener('DOMContentLoaded', () => {{
  if (!document.documentElement?.dataset.dsThemeSource) releaseThemeHydration();
}}, {{ once: true }});
const themeHydration = new MutationObserver(() => {{
  const root = document.documentElement;
  const body = document.body;
  if (!root || !body) return;
  if (bootBackground === undefined) {{
    const background = getComputedStyle(body).getPropertyValue('--dsh-boot-bg').trim();
    if (!background) return;
    bootBackground = background;
    previousBackground = body.style.getPropertyValue('background-color');
    previousPriority = body.style.getPropertyPriority('background-color');
    if (bootBackground) body.style.backgroundColor = bootBackground;
    bootBackground = body.style.backgroundColor;
  }}
  const source = root.dataset.dsThemeSource;
  bootPreference ??= source;
  if (bootPreference !== 'light' && bootPreference !== 'dark') {{
    if (bootPreference) releaseThemeHydration();
    return;
  }}
  if (!root.style.colorScheme) return;
  if (source !== 'system') {{
    releaseThemeHydration();
    return;
  }}
  if (root.style.colorScheme !== bootPreference) root.style.colorScheme = bootPreference;
  if (root.dataset.theme !== bootPreference) root.dataset.theme = bootPreference;
  if (body.hasAttribute('data-ds-dark-theme') !== (bootPreference === 'dark')) body.toggleAttribute('data-ds-dark-theme', bootPreference === 'dark');
}});
themeHydration.observe(document, {{ childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'data-ds-theme-source', 'data-ds-dark-theme'] }});"#,
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
    fn theme_hydration_releases_after_the_first_durable_presenter_snapshot() {
        let runtime = crate::service::workflow::test_runtime_executable()
            .expect("bundled Electron runtime required for bootstrap test");
        let script = initial_theme_script(Theme::Light);
        let probe = format!(
            r#"const assert = require('node:assert/strict');
const {{ JSDOM }} = require({jsdom});
const tick = () => new Promise(resolve => setImmediate(resolve));
async function run(boot, first, hydrated, concurrentBackground) {{
  const dom = new JSDOM('<!doctype html><html><body style="background-color: red !important"></body></html>', {{ runScripts: 'outside-only' }});
  const window = dom.window;
  let disconnected = 0;
  const Original = window.MutationObserver;
  window.MutationObserver = class extends Original {{
    disconnect() {{ disconnected++; super.disconnect(); }}
  }};
  window.document.body.style.setProperty('--dsh-boot-bg', boot === 'dark' ? '#151517' : '#fff');
  await tick();
  window.eval({script});
  window.document.body.append(window.document.createElement('span'));
  await Promise.resolve();
  assert.equal(disconnected, 0);
  assert.equal(window.document.body.style.backgroundColor, boot === 'dark' ? 'rgb(21, 21, 23)' : 'rgb(255, 255, 255)');
  window.document.documentElement.dataset.dsThemeSource = boot;
  await tick();
  function present(source) {{
    const dark = source === 'dark' || source === 'system' && boot === 'light';
    window.document.documentElement.dataset.dsThemeSource = source;
    window.document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    window.document.body.toggleAttribute('data-ds-dark-theme', dark);
  }}
  present(first);
  await tick();
  if (boot !== 'system') {{
    assert.equal(window.document.body.hasAttribute('data-ds-dark-theme'), first === 'system' ? boot === 'dark' : first === 'dark');
    if (concurrentBackground) window.document.body.style.backgroundColor = concurrentBackground;
    if (hydrated) {{ present(hydrated); await tick(); }}
    assert.equal(disconnected, 1);
    assert.equal(window.document.body.style.backgroundColor, concurrentBackground ?? 'red');
    if (!concurrentBackground) assert.equal(window.document.body.style.getPropertyPriority('background-color'), 'important');
    present('system');
    await tick();
    assert.equal(window.document.body.hasAttribute('data-ds-dark-theme'), boot === 'light');
  }} else assert.equal(disconnected, 1);
  window.close();
}}
(async () => {{
  await run('light', 'system', 'light');
  await run('dark', 'system', 'dark');
  await run('light', 'light');
  await run('dark', 'dark');
  await run('light', 'system', 'dark');
  await run('system', 'system');
  await run('light', 'system', 'light', 'blue');
}})().catch(error => {{ console.error(error); process.exitCode = 1; }});"#,
            jsdom = serde_json::json!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../node_modules/jsdom")),
            script = serde_json::json!(script),
        );
        let output = std::process::Command::new(runtime)
            .args(["-e", &probe])
            .env("ELECTRON_RUN_AS_NODE", "1")
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .output()
            .unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    }

    #[test]
    fn initial_theme_waits_for_document_root_when_injected_at_document_start() {
        let runtime = crate::service::workflow::test_runtime_executable()
            .expect("bundled Electron runtime required for bootstrap test");
        for theme in [Theme::Light, Theme::Dark] {
            let script = initial_theme_script(theme);
            let probe = format!(
                r#"const assert = require('node:assert/strict');
const vm = require('node:vm');
for (const hasRoot of [false, true]) {{
  const root = {{ dataset: {{}} }};
  const ready = [];
  const document = {{
    documentElement: hasRoot ? root : null,
    addEventListener(event, callback, options) {{
      assert.equal(event, 'DOMContentLoaded');
      assert.equal(options.once, true);
      ready.push(callback);
    }}
  }};
  vm.runInNewContext({script}, {{ document, MutationObserver: class {{ observe() {{}} disconnect() {{}} }} }});
  if (!hasRoot) {{
    assert.equal(root.dataset.theme, undefined);
    assert.equal(ready.length, 2);
    document.documentElement = root;
    for (const callback of ready) callback();
  }}
  assert.equal(root.dataset.theme, {theme});
}}"#,
                script = serde_json::json!(script),
                theme = serde_json::json!(theme.as_str()),
            );
            let output = std::process::Command::new(&runtime)
                .args(["-e", &probe])
                .env("ELECTRON_RUN_AS_NODE", "1")
                .env_remove("NODE_OPTIONS")
                .env_remove("NODE_PATH")
                .output()
                .unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        }
    }
}
