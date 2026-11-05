//! 主窗口壳层注入。
//!
//! 与 DSH 官方一致：主窗口 webContents 直接加载 DSH 页面，壳层 UI 由 preload 注入。
//! 注入必须走 Shadow DOM——壳层 Tailwind 预检实测会把 DSH 的 body 字号、button/input
//! 排版改掉；Shadow root 双向隔离，壳层样式不外泄、DSH 样式不侵入。
//! 弹层默认 portal 到 `document.body` 会逃出 shadow root，故预留 shadow 内的 portal 容器。

use serde_json::json;

const SHELL_CSS: &str = include_str!("shell.css");

pub const SHELL_HOST_ATTRIBUTE: &str = "data-dsh-shell-host";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Theme {
  Light,
  Dark,
}

impl Theme {
  pub fn as_str(self) -> &'static str {
    match self {
      Theme::Light => "light",
      Theme::Dark => "dark",
    }
  }
}

pub struct ShellInjection {
  source: String,
}

impl ShellInjection {
  pub fn new(theme: Theme) -> Self {
    let source = format!(
      r#"(() => {{
  const HOST_ATTRIBUTE = {host_attribute};
  const THEME = {theme};
  const CSS = {css};
  function install() {{
    if (document.querySelector('[' + HOST_ATTRIBUTE + ']') !== null) return;
    const root = document.documentElement;
    if (root === null) return;
    const host = document.createElement('div');
    host.setAttribute(HOST_ATTRIBUTE, '');
    host.setAttribute('data-theme', THEME);
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000';
    const shadow = host.attachShadow({{ mode: 'open' }});
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.append(style);
    const mount = document.createElement('div');
    mount.id = 'shell-root';
    mount.style.cssText = 'pointer-events:none';
    shadow.append(mount);
    const portal = document.createElement('div');
    portal.id = 'shell-portal';
    portal.style.cssText = 'pointer-events:none';
    shadow.append(portal);
    root.append(host);
    globalThis.__DSH_SHELL_HOST__ = {{ host, shadow, mount, portal }};
  }}
  // preload 在文档极早期执行，documentElement 可能还没就绪。
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', install, {{ once: true }});
  else
    install();
}})();"#,
      host_attribute = json!(SHELL_HOST_ATTRIBUTE),
      theme = json!(theme.as_str()),
      css = json!(SHELL_CSS),
    );
    Self { source }
  }

  pub fn source(&self) -> &str {
    &self.source
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn count(haystack: &str, needle: &str) -> usize {
    haystack.matches(needle).count()
  }

  #[test]
  fn injection_is_idempotent_guarded_by_the_host_attribute() {
    let script = ShellInjection::new(Theme::Dark).source();
    assert!(script.contains(SHELL_HOST_ATTRIBUTE));
    assert!(script.contains("!== null) return;"));
    assert_eq!(count(script, "attachShadow"), 1);
  }

  #[test]
  fn injection_defers_until_the_document_element_exists() {
    let script = ShellInjection::new(Theme::Light).source();
    assert!(script.contains("document.readyState === 'loading'"));
    assert!(script.contains("DOMContentLoaded"));
    assert!(script.contains("if (root === null) return;"));
  }

  #[test]
  fn injection_writes_the_requested_theme() {
    assert!(ShellInjection::new(Theme::Dark).source().contains("\"dark\""));
    assert!(ShellInjection::new(Theme::Light).source().contains("\"light\""));
  }

  #[test]
  fn injection_exposes_mount_and_portal_containers() {
    let script = ShellInjection::new(Theme::Light).source();
    assert!(script.contains("'shell-root'"));
    assert!(script.contains("'shell-portal'"));
    assert!(script.contains("__DSH_SHELL_HOST__"));
  }

  #[test]
  fn injection_embeds_the_scoped_stylesheet() {
    let script = ShellInjection::new(Theme::Light).source();
    assert!(script.contains("style.textContent"));
    assert_eq!(count(SHELL_CSS, ":root"), 0);
    assert_eq!(count(SHELL_CSS, "html[data-theme"), 0);
    assert!(count(SHELL_CSS, ":host") > 0);
  }

  #[test]
  fn theme_strings_are_stable_for_the_host_attribute() {
    assert_eq!(Theme::Light.as_str(), "light");
    assert_eq!(Theme::Dark.as_str(), "dark");
  }
}
