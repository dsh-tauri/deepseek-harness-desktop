//! 主窗口壳层注入。
//!
//! 与 DSH 官方一致：主窗口 webContents 直接加载 DSH 页面，壳层 UI 注入其上。
//! 注入必须走 Shadow DOM——壳层 Tailwind 预检实测会把 DSH 的 body 字号、button/input
//! 排版改掉；Shadow root 双向隔离，壳层样式不外泄、DSH 样式不侵入。
//!
//! 壳层需要 Tauri IPC，而 `__TAURI_INTERNALS__` 由 contextBridge 暴露在主世界，故注入
//! 必须经 `initialization_script`（主世界）而非 `preload_script`（隔离世界）。

use serde_json::json;

// 编译期直接内嵌 dist.shell 产物：不拷贝进 rust 目录，也不依赖运行时的磁盘路径。
const SHELL_CSS: &str = include_str!("../../../dist.shell/shell.css");
const SHELL_JS: &str = include_str!("../../../dist.shell/shell.mjs");

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

/// 构造主窗口初始化脚本：标注文档即 DSH、写入样式与主题，再以 Blob URL 动态 import 壳层。
///
/// 壳层产物是 ESM（依赖含顶层 await），不能用自执行脚本注入；Blob URL 在页面源下执行，
/// 继承主世界，因此 `__TAURI_INTERNALS__` 与 Shadow DOM 都可用。注入幂等：同一文档只执行一次。
pub struct ShellInjection {
  source: String,
}

impl ShellInjection {
  pub fn new(theme: Theme) -> Self {
    let source = format!(
      r#"(() => {{
  globalThis.__DSH_HOSTED__ = true;
  globalThis.__DSH_SHELL_CSS__ = {css};
  globalThis.__DSH_SHELL_THEME__ = {theme};
  // 壳层在主世界执行，那里没有 Node 的 process；依赖会用 process.env 做环境判断。
  globalThis.process ??= {{ env: {{ NODE_ENV: 'production' }}, emit() {{ return false }}, platform: 'browser', versions: {{}} }};
  if (globalThis.__DSH_SHELL_LOADED__) return;
  globalThis.__DSH_SHELL_LOADED__ = true;
  const url = URL.createObjectURL(new Blob([{js}], {{ type: 'text/javascript' }}));
  import(url).catch((error) => console.error('[shell] bootstrap failed', error));
}})();"#,
      css = json!(SHELL_CSS),
      theme = json!(theme.as_str()),
      js = json!(SHELL_JS),
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

  #[test]
  fn injection_marks_the_document_as_hosted() {
    let injection = ShellInjection::new(Theme::Light);
    assert!(injection.source().contains("__DSH_HOSTED__ = true"));
  }

  #[test]
  fn injection_hands_css_and_theme_to_the_runtime() {
    let injection = ShellInjection::new(Theme::Dark);
    let source = injection.source();
    assert!(source.contains("__DSH_SHELL_CSS__"));
    assert!(source.contains("__DSH_SHELL_THEME__"));
    assert!(source.contains("\"dark\""));
  }

  #[test]
  fn injection_appends_the_shell_module() {
    let injection = ShellInjection::new(Theme::Light);
    let source = injection.source();
    assert!(source.contains("URL.createObjectURL"));
    assert!(source.contains("import(url)"));
    assert!(source.contains("__DSH_SHELL_LOADED__"));
  }

  #[test]
  fn embedded_stylesheet_is_rewritten_for_the_shadow_host() {
    assert_eq!(SHELL_CSS.matches(":root").count(), 0);
    assert_eq!(SHELL_CSS.matches("html[data-theme").count(), 0);
    assert!(SHELL_CSS.contains(":host"));
  }

  #[test]
  fn theme_strings_are_stable_for_the_host_attribute() {
    assert_eq!(Theme::Light.as_str(), "light");
    assert_eq!(Theme::Dark.as_str(), "dark");
  }
}
