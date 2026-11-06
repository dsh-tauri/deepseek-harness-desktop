//! 主窗口壳层注入。
//!
//! 与 DSH 官方一致：主窗口 webContents 直接加载 DSH 页面，壳层 UI 注入其上。
//! 注入必须走 Shadow DOM——壳层 Tailwind 预检实测会把 DSH 的 body 字号、button/input
//! 排版改掉；Shadow root 双向隔离，壳层样式不外泄、DSH 样式不侵入。
//!
//! 壳层需要 Tauri IPC，而 `__TAURI_INTERNALS__` 由 contextBridge 暴露在主世界，故注入
//! 必须经 `initialization_script`（主世界）而非 `preload_script`（隔离世界）。

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
      Theme::Light => "light",
      Theme::Dark => "dark",
    }
  }
}

/// 构造主窗口初始化脚本：标注文档即 DSH、写入主题，再以 Blob URL 动态 import 壳层。
///
/// 壳层产物是 ESM（依赖含顶层 await），不能用自执行脚本注入；Blob URL 在页面源下执行，
/// 继承主世界，因此 `__TAURI_INTERNALS__` 与 Shadow DOM 都可用。注入幂等：同一文档只执行一次。
///
/// 壳层来源分两种构建形态：
/// - release：`include_str!` 编译期内嵌，产物随二进制分发，不依赖运行期磁盘路径。
/// - debug（dev）：运行期从 `dist.shell/shell.mjs` 读；文件不存在时返回 `None`，调用方
///   跳过注入，主窗口退回「独立壳层页 + `<webview>` 标签承载 DSH」的 dev 形态，从而让
///   Vite dev 的 HMR 直接作用于壳层组件，不必每次 `build:shell` 再重启进程。
pub struct ShellInjection {
  source: String,
}

impl ShellInjection {
  pub fn new(theme: Theme) -> Option<Self> {
    let js = shell_module()?;
    let source = format!(
      r#"(() => {{
  globalThis.__DSH_HOSTED__ = true;
  globalThis.__DSH_SHELL_THEME__ = {theme};
  // 壳层在主世界执行，那里没有 Node 的 process；依赖会用 process.env 做环境判断。
  globalThis.process ??= {{ env: {{ NODE_ENV: 'production' }}, emit() {{ return false }}, platform: 'browser', versions: {{}} }};
  if (globalThis.__DSH_SHELL_LOADED__) return;
  globalThis.__DSH_SHELL_LOADED__ = true;
  const url = URL.createObjectURL(new Blob([{js}], {{ type: 'text/javascript' }}));
  import(url).catch((error) => console.error('[shell] bootstrap failed', error));
}})();"#,
      theme = json!(theme.as_str()),
      js = json!(js),
    );
    Some(Self { source })
  }

  pub fn source(&self) -> &str {
    &self.source
  }
}

/// release 编译期内嵌；debug 运行期读盘，缺失即视为「本次不注入」。
#[cfg(not(debug_assertions))]
fn shell_module() -> Option<&'static str> {
  Some(include_str!("../../../dist.shell/shell.mjs"))
}

#[cfg(debug_assertions)]
fn shell_module() -> Option<&'static str> {
  const PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../dist.shell/shell.mjs");
  match std::fs::read_to_string(PATH) {
    Ok(source) => Some(Box::leak(source.into_boxed_str())),
    Err(error) => {
      log::info!("[shell] dev: {PATH} 不存在（{error}），主窗口走 webview 标签形态");
      None
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn injection_marks_the_document_as_hosted() {
    let injection = ShellInjection::new(Theme::Light).expect("测试需要壳层产物");
    assert!(injection.source().contains("__DSH_HOSTED__ = true"));
  }

  #[test]
  fn injection_hands_theme_to_the_runtime_without_separate_css() {
    let injection = ShellInjection::new(Theme::Dark).expect("测试需要壳层产物");
    let source = injection.source();
    // 样式已内联进 shell.mjs，注入脚本的模板前缀不再单独赋值 `__DSH_SHELL_CSS__`。
    // 注意壳层产物内部仍保留 `__DSH_SHELL_CSS__` 作为 dev 回退，故只检查模板前缀。
    let preamble = source.split("const url = URL.createObjectURL").next().unwrap_or("");
    assert!(!preamble.contains("__DSH_SHELL_CSS__"));
    assert!(source.contains("__DSH_SHELL_THEME__"));
    assert!(source.contains("\"dark\""));
  }

  #[test]
  fn injection_appends_the_shell_module() {
    let injection = ShellInjection::new(Theme::Light).expect("测试需要壳层产物");
    let source = injection.source();
    assert!(source.contains("URL.createObjectURL"));
    assert!(source.contains("import(url)"));
    assert!(source.contains("__DSH_SHELL_LOADED__"));
  }

  #[test]
  fn theme_strings_are_stable_for_the_host_attribute() {
    assert_eq!(Theme::Light.as_str(), "light");
    assert_eq!(Theme::Dark.as_str(), "dark");
  }
}
