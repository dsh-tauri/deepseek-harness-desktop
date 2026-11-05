//! 主窗口壳层注入。
//!
//! 与 DSH 官方一致：主窗口 webContents 直接加载 DSH 页面，壳层 UI 由 preload 注入。
//! 注入必须走 Shadow DOM——壳层 Tailwind 预检实测会把 DSH 的 body 字号、button/input
//! 排版改掉；Shadow root 双向隔离，壳层样式不外泄、DSH 样式不侵入。

use serde_json::json;

// 编译期直接内嵌 dist.shell 产物：不拷贝进 rust 目录，也不依赖运行时的磁盘路径
// （CARGO_MANIFEST_DIR 是构建机绝对路径，打包后不存在）。
const SHELL_CSS: &str = include_str!("../../../dist.shell/shell.css");
const SHELL_JS: &str = include_str!("../../../dist.shell/shell.iife.js");

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

/// 构造 preload 注入脚本：写入样式与主题，再执行壳层 IIFE 由 `src/shell.ts` 装配。
pub struct ShellInjection {
  source: String,
}

impl ShellInjection {
  pub fn new(theme: Theme) -> Self {
    let source = format!(
      "(() => {{\n  globalThis.__DSH_SHELL_CSS__ = {css};\n  globalThis.__DSH_SHELL_THEME__ = {theme};\n}})();\n{js}",
      css = json!(SHELL_CSS),
      theme = json!(theme.as_str()),
      js = SHELL_JS,
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
  fn injection_hands_css_and_theme_to_the_runtime() {
    let source = ShellInjection::new(Theme::Dark).source();
    assert!(source.contains("__DSH_SHELL_CSS__"));
    assert!(source.contains("__DSH_SHELL_THEME__"));
    assert!(source.contains("\"dark\""));
  }

  #[test]
  fn injection_appends_the_shell_iife() {
    assert!(ShellInjection::new(Theme::Light).source().contains("__DSH_SHELL__"));
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
