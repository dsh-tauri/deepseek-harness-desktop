//! shim 脚本内容生成与落盘：`dsh` / `pnpm` 的 cmd、ps1、sh 包装脚本。
//!
//! 模块划分：
//! - [`templates`]：共享脚本片段常量（node 解析、用户优先逻辑）
//! - [`build`]：各平台 shim 构建函数（纯函数，便于测试）
//! - [`write`]：落盘（生成标记识别、悬空符号链接、用户文件保留）
//!
//! shim 文本必须全英文：cmd/ps1 按系统代码页解析，中文注释会乱码成命令执行。

use std::path::Path;

mod build;
mod templates;
mod write;

pub use write::{is_generated_shim, user_dsh_preserved, write_shims};

/// Windows 下 shim 文件名（cmd 为主入口，ps1 供 PowerShell 原生体验）
#[cfg(windows)]
pub const SHIM_CMD_NAME: &str = "dsh.cmd";
#[cfg(windows)]
pub const SHIM_PS1_NAME: &str = "dsh.ps1";
#[cfg(windows)]
pub const PNPM_SHIM_CMD_NAME: &str = "pnpm.cmd";
#[cfg(windows)]
pub const PNPM_SHIM_PS1_NAME: &str = "pnpm.ps1";
#[cfg(windows)]
pub const NPX_SHIM_CMD_NAME: &str = "npx.cmd";
#[cfg(windows)]
pub const NPX_SHIM_PS1_NAME: &str = "npx.ps1";
#[cfg(windows)]
pub const NPM_SHIM_CMD_NAME: &str = "npm.cmd";
#[cfg(windows)]
pub const NPM_SHIM_PS1_NAME: &str = "npm.ps1";

/// Unix 下 shim 文件名
#[cfg(unix)]
pub const SHIM_SH_NAME: &str = "dsh";
#[cfg(unix)]
pub const PNPM_SHIM_SH_NAME: &str = "pnpm";

// ---------------------------------------------------------------------------
// 路径转义（按目标脚本语言的字符串规则）
// ---------------------------------------------------------------------------

/// 批处理中 `%` 会被展开，需写成 `%%`
#[inline]
pub fn escape_path_cmd(path: &Path) -> String {
    path.to_string_lossy().replace('%', "%%")
}

/// 把路径烘焙进 `.cmd` 前，尽量换成语义等价的纯 ASCII 写法。
///
/// cmd.exe 按控制台代码页解析批处理文件：路径含非 ASCII（中文用户名）时，英文
/// 系统（CP437）根本无法用该代码页表示，`if exist "%PNPM_BIN%"` 必然落空、shim
/// 以退出码 1 结束。依次尝试：用户目录下的 `%APPDATA%`/`%LOCALAPPDATA%`/
/// `%USERPROFILE%` 令牌、Windows 8.3 短名；都拿不到纯 ASCII 时才保留原字面量，
/// 由 write.rs 的按代码页编码兜底。
pub fn portable_path_cmd(path: &Path) -> String {
    let text = path.to_string_lossy();
    if text.is_ascii() {
        return escape_path_cmd(path);
    }
    for (var, token) in [
        ("APPDATA", "%APPDATA%"),
        ("LOCALAPPDATA", "%LOCALAPPDATA%"),
        ("USERPROFILE", "%USERPROFILE%"),
    ] {
        let Some(root) = std::env::var_os(var) else {
            continue;
        };
        if let Some(rendered) = under_root(path, Path::new(&root), token) {
            return rendered;
        }
    }
    // 令牌之外的路径（如 `D:\软件\nodejs`）用 8.3 短名换回 ASCII；卷上关掉
    // 短名或路径不存在时拿回的仍是长名，此处按 is_ascii 拒绝。
    #[cfg(windows)]
    if let Some(short) = crate::utils::short_path(path) {
        if short.to_string_lossy().is_ascii() {
            return escape_path_cmd(&short);
        }
    }
    escape_path_cmd(path)
}

/// `path` 在 `root` 之下时渲染成 `<token>\<其余部分>`，其余部分按批处理转义。
fn under_root(path: &Path, root: &Path, token: &str) -> Option<String> {
    let rest = path.strip_prefix(root).ok()?;
    if rest.as_os_str().is_empty() {
        return None;
    }
    Some(format!("{token}\\{}", escape_path_cmd(rest)))
}

/// 单引号字符串中 `'` 需翻倍
#[inline]
pub fn escape_path_ps1(path: &Path) -> String {
    path.to_string_lossy().replace('\'', "''")
}

/// 单引号字符串中 `'` 需写成 `'\''`
#[inline]
pub fn escape_path_sh(path: &Path) -> String {
    path.to_string_lossy().replace('\'', "'\\''")
}

#[cfg(test)]
mod test_util {
    use std::path::PathBuf;

    /// 与生产同源的默认布局样例（AppData 托管根 + 清单入口相对路径），
    /// 供 shim 构建/落盘测试断言烘焙结果。
    pub(super) fn sample_shim_paths() -> super::build::ShimPaths {
        shim_paths_for(&sample_app_dir())
    }

    /// 任意根目录 + 清单默认布局的等价 `ShimPaths`：生产侧入口路径来自依赖映射表
    /// 与清单 `entry`，按临时目录构造的测试用同一布局换算。
    pub(super) fn shim_paths_for(app_dir: &std::path::Path) -> super::build::ShimPaths {
        let app_dir = app_dir.to_path_buf();
        let node_root = app_dir.join("runtime");
        super::build::ShimPaths {
            node_bin: if cfg!(windows) {
                node_root.join("node.exe")
            } else {
                node_root.join("bin").join("node")
            },
            dsh_bin: app_dir
                .join("dependencies")
                .join("dsh")
                .join("node_modules")
                .join("@deepseek-ai")
                .join("dsh")
                .join("lib")
                .join("bin.js"),
            pnpm_bin: app_dir
                .join("dependencies")
                .join("pnpm")
                .join("bin")
                .join("pnpm.cjs"),
            bundled_git_dir: Some(app_dir.join("dependencies").join("git").join("cmd")),
        }
    }

    pub(super) fn sample_app_dir() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\Users\test\AppData\Roaming\dsh-tauri")
        } else {
            PathBuf::from("/home/test/.local/share/dsh-tauri")
        }
    }

    /// 官方 $DSH_HOME（~/.dsh）
    pub(super) fn sample_dsh_home() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\Users\test\.dsh")
        } else {
            PathBuf::from("/home/test/.dsh")
        }
    }

    /// 独立的临时目录，避免测试间互相干扰
    pub(super) fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dsh-shim-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ------------------------------------------------------------------
    // escape_path_* 纯函数基线（与 shim 内嵌路径的场景一致）
    // ------------------------------------------------------------------

    #[test]
    fn escape_path_cmd_doubles_percent() {
        assert_eq!(
            escape_path_cmd(Path::new(r"C:\Users\%test%\x")),
            r"C:\Users\%%test%%\x"
        );
        assert_eq!(escape_path_cmd(Path::new("/tmp/a b")), "/tmp/a b");
    }

    #[test]
    fn escape_path_ps1_doubles_single_quotes() {
        assert_eq!(
            escape_path_ps1(Path::new(r"C:\Users\o'brien")),
            r"C:\Users\o''brien"
        );
        assert_eq!(escape_path_ps1(Path::new("/plain/path")), "/plain/path");
    }

    #[test]
    fn escape_path_sh_escapes_single_quotes() {
        assert_eq!(
            escape_path_sh(Path::new("/home/o'brien/.dsh")),
            r"/home/o'\''brien/.dsh"
        );
        assert_eq!(escape_path_sh(Path::new("/plain/.dsh")), "/plain/.dsh");
    }

    // ------------------------------------------------------------------
    // 非 ASCII 路径的 ASCII 令牌改写（cmd.exe 按代码页读批处理）
    // ------------------------------------------------------------------

    /// 中文用户名下的 AppData 路径必须退化成 `%APPDATA%` 令牌：英文系统
    /// （CP437）用代码页也编不出这些字符，只有纯 ASCII 才与代码页无关。
    #[test]
    #[cfg(windows)]
    fn portable_path_cmd_renders_non_ascii_user_paths_as_tokens() {
        let root = Path::new(r"C:\Users\小蔡\AppData\Roaming");
        assert_eq!(
            under_root(
                Path::new(r"C:\Users\小蔡\AppData\Roaming\dsh-tauri\dependencies\pnpm\bin\pnpm.cjs"),
                root,
                "%APPDATA%",
            )
            .as_deref(),
            Some(r"%APPDATA%\dsh-tauri\dependencies\pnpm\bin\pnpm.cjs")
        );
        assert_eq!(
            under_root(Path::new(r"C:\Users\小蔡\.dsh"), Path::new(r"C:\Users\小蔡"), "%USERPROFILE%")
                .as_deref(),
            Some(r"%USERPROFILE%\.dsh")
        );
        // 令牌之外没有剩余内容、或路径不在根下时不改写。
        assert_eq!(under_root(root, root, "%APPDATA%"), None);
        assert_eq!(
            under_root(Path::new(r"D:\tools\x"), root, "%APPDATA%"),
            None
        );
        // 其余部分仍按批处理转义。
        assert_eq!(
            under_root(Path::new(r"C:\Users\小蔡\a%20b"), Path::new(r"C:\Users\小蔡"), "%USERPROFILE%")
                .as_deref(),
            Some(r"%USERPROFILE%\a%%20b")
        );
    }

    /// 纯 ASCII 路径逐字节走原逻辑（不留令牌、不做无谓改写）。
    #[test]
    fn portable_path_cmd_keeps_ascii_paths_verbatim() {
        assert_eq!(
            portable_path_cmd(Path::new(r"C:\Users\test\AppData\Roaming\dsh-tauri\pnpm.cjs")),
            r"C:\Users\test\AppData\Roaming\dsh-tauri\pnpm.cjs"
        );
        assert_eq!(
            portable_path_cmd(Path::new(r"C:\tools\100%\pnpm.cjs")),
            r"C:\tools\100%%\pnpm.cjs"
        );
    }
}
