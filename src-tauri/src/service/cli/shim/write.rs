//! shim 落盘：生成标记识别、悬空符号链接处理、用户文件保留、按外部解析方的
//! 代码页编码（cmd 用系统代码页、ps1 用带 BOM 的 UTF-8）与写入编排。

use crate::config;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Runtime};

#[cfg(not(windows))]
#[allow(unused_imports)] // debug 构建 dsh shim 不写入；测试仍引用
use super::build::build_sh_shim;
#[allow(unused_imports)] // 构建函数在 debug 构建/异平台下由 cfg 裁剪，测试仍引用
use super::build::{
    build_cmd_shim, build_npm_cmd_shim, build_npm_ps1_shim, build_npx_cmd_shim, build_npx_ps1_shim,
    build_pnpm_cmd_shim, build_pnpm_ps1_shim, build_pnpm_sh_shim, build_ps1_shim, ShimPaths,
};
#[cfg(all(windows, not(debug_assertions)))]
use super::SHIM_PS1_NAME;
#[cfg(windows)]
use super::{
    NPM_SHIM_CMD_NAME, NPM_SHIM_PS1_NAME, NPX_SHIM_CMD_NAME, NPX_SHIM_PS1_NAME, PNPM_SHIM_CMD_NAME,
    PNPM_SHIM_PS1_NAME, SHIM_CMD_NAME,
};
#[cfg(not(windows))]
use super::{PNPM_SHIM_SH_NAME, SHIM_SH_NAME};

/// 生成的 shim 自带的可识别标记（首行注释）。用于区分"本应用生成的 shim"
/// 与"用户自行放置的同名文件"。读文件只读该标记行，避免误删用户自有文件。
const GENERATED_MARKER: &str = "DeepSeek Harness Desktop - ";

/// 目标路径已存在且不是本应用生成的 shim（即用户手动放置的 `dsh`/`pnpm`）。
///
/// 此时绝不覆盖，保留用户文件，避免"安装后清空了之前手动安装的工具"。
fn is_foreign_file(path: &Path) -> bool {
    !is_generated_shim(path)
}

/// 路径是否为悬空符号链接（链接本身存在，但指向的目标不存在）。
///
/// 官方 dsh 安装器会在 `~/.local/bin/dsh -> ~/.dsh/source/current/bin/dsh` 留下
/// 符号链接；当 `current` 指向的目录被移动/删除后链接即悬空。此时
/// `Path::exists()` 跟随链接返回 `false`，但直接 `fs::write` 会沿链接打开目标
/// 并在其父目录缺失时报 `No such file or directory (os error 2)`——必须先把
/// 已失效的链接本身移除，才能按"文件不存在"正常写入。
fn is_dangling_symlink(path: &Path) -> bool {
    match path.symlink_metadata() {
        Ok(meta) => meta.file_type().is_symlink() && !path.exists(),
        Err(_) => false,
    }
}

/// 判断路径是否为本应用生成的 shim（生成标记出现在文件头部固定位置）。
///
/// 用于在本地 dsh 探测中区分"本应用 shim"与"用户自行放置的同名文件"：
/// 前者应被排除（它转发到捆绑 dsh，不构成用户本地核心），后者应被识别。
///
/// 标记只在前两行匹配：所有生成的 shim 都在头部第一行（cmd 是 @echo off
/// 后的第二行）写 #/rem DeepSeek Harness Desktop - ...；用户文件即使正文
/// 提到同样的短语（如 README 引用）也不应被误判为本应用 shim。
pub fn is_generated_shim(path: &Path) -> bool {
    match std::fs::read(path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes)
            .lines()
            .take(2)
            .any(|line| line.contains(GENERATED_MARKER)),
        Err(_) => false,
    }
}

/// shim 落盘编码。
///
/// cmd.exe 按控制台代码页（中文 Windows 为 936）读取 `.cmd`，PowerShell 5.1 只认
/// 带 BOM 的 UTF-8 `.ps1`。此前一律写 UTF-8：一旦烘焙进内容的绝对路径含非 ASCII
/// （用户名 `小蔡`、含中文的安装目录），`if exist "%PNPM_BIN%"` 判定就落空，shim
/// 走 `:no_pnpm` 以退出码 1 结束，`dsh plugin add` 随之失败并让 Harness 启动停在
/// `INTERNAL_PLUGIN_INSTALL_FAILED: PREINSTALL_FAILED`（重试/安全模式都走同一条
/// preinstall，因此永远无法恢复）。纯 ASCII 内容保持原字节，行为完全不变。
fn encode_shim(target: &Path, content: &str) -> Vec<u8> {
    #[cfg(not(windows))]
    let _ = target;
    if content.is_ascii() {
        return content.as_bytes().to_vec();
    }
    #[cfg(windows)]
    match target.extension().and_then(|ext| ext.to_str()) {
        Some("cmd") | Some("bat") => {
            if let Some(bytes) =
                crate::utils::encode_multibyte(content, crate::utils::console_code_page())
            {
                return bytes;
            }
            log::warn!(
                "Shim {target:?} contains characters the console code page cannot represent; \
                 falling back to utf-8, its baked paths will not resolve"
            );
        }
        Some("ps1") => {
            let mut bytes = vec![0xEF, 0xBB, 0xBF];
            bytes.extend_from_slice(content.as_bytes());
            return bytes;
        }
        _ => {}
    }
    content.as_bytes().to_vec()
}

/// 写入单个 shim 文件，处理目标已存在时的三种情形：
///
/// 1. 悬空符号链接（用户/官方安装器残留、目标已失效）→ 移除链接后正常写入；
/// 2. 已存在且非本应用生成（用户手动放置的 `dsh`/`pnpm`）→ 跳过，保留用户文件；
/// 3. 其余（不存在，或本应用生成的 shim）→ 直接写入/覆盖。
fn write_shim_file(target: &Path, content: &str) -> Result<(), String> {
    if is_dangling_symlink(target) {
        log::warn!(
            "Removing dangling symlink {:?} before writing shim (its target is gone)",
            target
        );
        fs::remove_file(target).map_err(|e| {
            format!(
                "SHIM_REMOVE_LINK_FAILED: remove dangling symlink {} failed: {e}",
                target.display()
            )
        })?;
    }
    if target.exists() && is_foreign_file(target) {
        log::warn!(
            "Skipping shim write to {:?}: an existing user file is preserved",
            target
        );
        return Ok(());
    }
    fs::write(target, encode_shim(target, content))
        .map_err(|e| format!("SHIM_WRITE_FAILED: write {} failed: {e}", target.display()))
}

/// 主 `dsh` shim 路径下是否保留了用户自行安装的同名文件（用于状态展示）。
pub fn user_dsh_preserved(bin_dir: &Path) -> bool {
    let path = {
        #[cfg(windows)]
        {
            bin_dir.join(SHIM_CMD_NAME)
        }
        #[cfg(not(windows))]
        {
            bin_dir.join(SHIM_SH_NAME)
        }
    };
    path.is_file() && is_foreign_file(&path)
}

/// shim 生成时烘焙的依赖路径：按依赖映射表解析，可能指向 AppData 之外的任意
/// 位置（如安装目录的 `resources/*` 捆绑副本）。
pub fn shim_paths<R: Runtime>(app_handle: &AppHandle<R>) -> ShimPaths {
    ShimPaths {
        node_bin: config::dependencies::binary_path(app_handle, config::dependencies::DEP_NODE),
        dsh_bin: config::get_dsh_binary_path(app_handle),
        pnpm_bin: config::get_pnpm_binary_path(app_handle),
        bundled_git_dir: bundled_git_dir(app_handle),
    }
}

/// 捆绑 MinGit 的 `cmd` 目录（系统 Git 缺 HTTPS helper 时由 shim 注入 PATH）。
#[cfg(windows)]
fn bundled_git_dir<R: Runtime>(app_handle: &AppHandle<R>) -> Option<PathBuf> {
    config::get_mingit_binary_path(app_handle)
        .parent()
        .map(Path::to_path_buf)
}

#[cfg(not(windows))]
fn bundled_git_dir<R: Runtime>(_app_handle: &AppHandle<R>) -> Option<PathBuf> {
    None
}

/// 将 shim 文件写入 bin 目录；目标已存在但非本应用生成的同名文件时跳过（保留）。
/// 目标为悬空符号链接时先移除链接再写入（链接目标已失效，保留只会让写入
/// 报 ENOENT）。
///
/// 覆盖式仅针对本应用生成的 shim（自愈时内容与当前安装一致）；用户手动放置的
/// 同名 `dsh`/`pnpm` 一律保留不动，避免覆盖用户自己的安装与配置。
pub fn write_shims<R: Runtime>(app_handle: &AppHandle<R>, bin_dir: &Path) -> Result<(), String> {
    let paths = shim_paths(app_handle);
    let dsh_home = config::get_dsh_data_path(app_handle);
    fs::create_dir_all(bin_dir)
        .map_err(|e| format!("SHIM_MKDIR_FAILED: create bin dir failed: {e}"))?;

    // 写入单个 shim：若目标已存在且非本应用生成，则跳过不覆盖（保留用户文件）。
    macro_rules! write_if_ours {
        ($path:expr, $content:expr) => {{
            let target = bin_dir.join($path);
            write_shim_file(&target, &$content)?;
            target
        }};
    }

    // dsh shim 会在内容里烘焙 $DSH_HOME（生产为 ~/.dsh、开发为 ~/.dsh.dev）。
    // 开发构建禁止改写用户共享的 dsh shim——改写会让终端 `dsh` 指向开发数据
    // 目录，并覆盖生产的命令行集成；生产版生成的 dsh shim 原样保留。
    #[cfg(not(debug_assertions))]
    {
        #[cfg(windows)]
        {
            write_if_ours!(SHIM_CMD_NAME, build_cmd_shim(&paths, &dsh_home));
            write_if_ours!(SHIM_PS1_NAME, build_ps1_shim(&paths, &dsh_home));
        }
        #[cfg(not(windows))]
        {
            write_if_ours!(SHIM_SH_NAME, build_sh_shim(&paths, &dsh_home));
        }
    }
    #[cfg(debug_assertions)]
    {
        let _ = &dsh_home;
        log::debug!("debug build: skip dsh shim write (shared user state kept for release)");
    }

    // pnpm/npx/npm shim 不烘焙 $DSH_HOME（仅绑定 bundle 目录与“用户命令优先”
    // 逻辑），内容与生产完全一致，开发构建也可写入——dsh plugin 子进程经 PATH
    // 解析这些命令依赖它，写它不污染任何共享数据。
    #[cfg(windows)]
    {
        write_if_ours!(PNPM_SHIM_CMD_NAME, build_pnpm_cmd_shim(&paths));
        write_if_ours!(PNPM_SHIM_PS1_NAME, build_pnpm_ps1_shim(&paths));
        write_if_ours!(NPX_SHIM_CMD_NAME, build_npx_cmd_shim(&paths));
        write_if_ours!(NPX_SHIM_PS1_NAME, build_npx_ps1_shim(&paths));
        write_if_ours!(NPM_SHIM_CMD_NAME, build_npm_cmd_shim(&paths));
        write_if_ours!(NPM_SHIM_PS1_NAME, build_npm_ps1_shim(&paths));
    }
    #[cfg(not(windows))]
    {
        write_if_ours!(PNPM_SHIM_SH_NAME, build_pnpm_sh_shim(&paths));
        // 仅对本应用生成/覆盖过的 shim 设置可执行位；保留的用户文件不动
        let chmod_names: &[&str] = if cfg!(debug_assertions) {
            &[PNPM_SHIM_SH_NAME]
        } else {
            &[SHIM_SH_NAME, PNPM_SHIM_SH_NAME]
        };
        for name in chmod_names {
            let path = bin_dir.join(name);
            if path.is_file() && !is_foreign_file(&path) {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
                    .map_err(|e| format!("SHIM_CHMOD_FAILED: chmod shim failed: {e}"))?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::test_util::{sample_dsh_home, sample_shim_paths, shim_paths_for};
    use super::*;
    use tauri::test::{mock_builder, mock_context, noop_assets};

    #[test]
    fn foreign_file_detection() {
        let dir = std::env::temp_dir().join(format!("dsh-shim-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // 用户手动放置的 dsh 脚本 -> 视为 foreign，不应被覆盖
        let user_dsh = dir.join(if cfg!(windows) { "dsh.cmd" } else { "dsh" });
        std::fs::write(&user_dsh, "#!/bin/sh\necho my real dsh\n").unwrap();
        assert!(
            is_foreign_file(&user_dsh),
            "user file must be treated as foreign"
        );

        // 本应用生成的 shim -> 不是 foreign，可覆盖
        #[cfg(not(windows))]
        let generated = build_sh_shim(&sample_shim_paths(), &sample_dsh_home());
        #[cfg(windows)]
        let generated = build_cmd_shim(&sample_shim_paths(), &sample_dsh_home());
        std::fs::write(&user_dsh, generated).unwrap();
        assert!(
            !is_foreign_file(&user_dsh),
            "generated shim must not be foreign"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ------------------------------------------------------------------
    // write_shim_file 目标文件处理（悬空符号链接 / 用户文件保留 / 生成文件覆盖）
    // ------------------------------------------------------------------

    /// 独立的临时目录，避免测试间互相干扰
    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dsh-shim-write-{tag}-{}-{}",
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

    /// 悬空符号链接（官方 dsh 安装器残留 `~/.local/bin/dsh -> ~/.dsh/source/current/bin/dsh`
    /// 且目标已消失）时：先移除失效链接，再正常写入生成 shim——修复原报错
    /// `write ... failed: No such file or directory (os error 2)`
    #[test]
    #[cfg(unix)]
    fn write_shim_file_removes_dangling_symlink() {
        use std::os::unix::fs::symlink;

        let dir = temp_dir("dangling");
        let target = dir.join("dsh");
        symlink(dir.join("missing/source/current/bin/dsh"), &target).unwrap();
        assert!(is_dangling_symlink(&target));

        write_shim_file(&target, "#!/bin/sh\ngenerated shim\n").unwrap();

        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "#!/bin/sh\ngenerated shim\n"
        );
        assert!(
            !std::fs::symlink_metadata(&target)
                .unwrap()
                .file_type()
                .is_symlink(),
            "dangling symlink must be replaced by a regular file"
        );
        assert!(!is_dangling_symlink(&target));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 指向真实用户 dsh 的符号链接（目标仍存在）→ 视为用户文件，保留不动
    #[test]
    #[cfg(unix)]
    fn write_shim_file_preserves_valid_user_symlink() {
        use std::os::unix::fs::symlink;

        let dir = temp_dir("userlink");
        let real = dir.join("real-dsh");
        std::fs::write(&real, "#!/bin/sh\necho my real dsh\n").unwrap();
        let target = dir.join("dsh");
        symlink(&real, &target).unwrap();

        write_shim_file(&target, "#!/bin/sh\ngenerated shim\n").unwrap();

        assert!(
            std::fs::symlink_metadata(&target)
                .unwrap()
                .file_type()
                .is_symlink(),
            "valid user symlink must be preserved"
        );
        assert_eq!(
            std::fs::read_to_string(&real).unwrap(),
            "#!/bin/sh\necho my real dsh\n"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 用户文件只在正文提到生成短语（非头部）→ 仍视为 foreign，不得覆盖
    #[test]
    fn generated_phrase_outside_header_is_not_generated_shim() {
        let dir =
            std::env::temp_dir().join(format!("dsh-shim-header-marker-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join(if cfg!(windows) { "dsh.cmd" } else { "dsh" });
        // 前两行不是标记（用户脚本），正文（第三行）却提到"DeepSeek Harness Desktop - "
        std::fs::write(
            &target,
            "@echo off\necho user shim\necho see DeepSeek Harness Desktop - readme note here\n",
        )
        .unwrap();
        assert!(
            is_foreign_file(&target),
            "phrase outside the header must not mark a user file as generated"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 本应用生成的 shim → 覆盖自愈内容
    #[test]
    fn write_shim_file_overwrites_generated_shim() {
        let dir = temp_dir("overwrite");
        let target = dir.join("dsh");
        std::fs::write(
            &target,
            "#!/bin/sh\n# DeepSeek Harness Desktop - old shim\n",
        )
        .unwrap();

        write_shim_file(
            &target,
            "#!/bin/sh\n# DeepSeek Harness Desktop - new shim\n",
        )
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "#!/bin/sh\n# DeepSeek Harness Desktop - new shim\n"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// issue #581：旧版本落盘的 LF-only `.cmd` 仍带生成标记（可被覆盖），
    /// 下一次 `ensure_shims` 必须把它升级为 CRLF 版本。
    #[test]
    fn write_shim_file_migrates_legacy_lf_only_cmd_shim() {
        let dir = temp_dir("legacy-lf-cmd");
        let target = dir.join("pnpm.cmd");
        let current = build_pnpm_cmd_shim(&shim_paths_for(&dir.join("app")));
        assert!(current.contains("\r\n"));
        std::fs::write(&target, current.replace("\r\n", "\n")).unwrap();
        assert!(
            !is_foreign_file(&target),
            "legacy generated shim must stay overwritable"
        );

        write_shim_file(&target, &current).unwrap();

        let content = std::fs::read_to_string(&target).unwrap();
        assert_eq!(content, current);
        assert_eq!(
            content.matches('\n').count(),
            content.matches("\r\n").count(),
            "migrated shim must not keep unpaired LF"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 非 ASCII 路径（用户名 `小蔡`）必须按 cmd.exe 的解析代码页落盘，
    /// 否则 `if exist "%PNPM_BIN%"` 判定落空、shim 以退出码 1 结束。
    #[test]
    #[cfg(windows)]
    fn cmd_shim_with_non_ascii_path_uses_console_code_page() {
        let dir = temp_dir("non-ascii-cmd");
        let target = dir.join("pnpm.cmd");
        let content = "@echo off\r\nrem DeepSeek Harness Desktop - pnpm command shim (generated)\r\nset \"PNPM_BIN=C:\\Users\\小蔡\\pnpm.cjs\"\r\n";
        assert!(!content.is_ascii());

        write_shim_file(&target, content).unwrap();

        let bytes = std::fs::read(&target).unwrap();
        let codepage = crate::utils::console_code_page();
        match crate::utils::encode_multibyte(content, codepage) {
            Some(encoded) => {
                assert_ne!(
                    bytes,
                    content.as_bytes(),
                    "non-ascii cmd shim must not be written as raw utf-8"
                );
                assert_eq!(bytes, encoded);
                assert_eq!(
                    crate::utils::decode_multibyte(&bytes, codepage).as_deref(),
                    Some(content),
                    "cmd shim must round-trip through the console code page"
                );
            }
            // 英文系统（CP437）表示不了中文用户名：只能退回原字节，应用侧靠
            // DSH_PNPM_BIN 与 portable_path_cmd 的 ASCII 令牌兜底。
            None => assert_eq!(bytes, content.as_bytes()),
        }
        assert!(
            !is_foreign_file(&target),
            "code-page encoded shim must still be recognised as generated"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// PowerShell 5.1 只认带 BOM 的 UTF-8；无 BOM 的非 ASCII `.ps1` 会按 ANSI 读成乱码。
    #[test]
    #[cfg(windows)]
    fn ps1_shim_with_non_ascii_path_gets_utf8_bom() {
        let dir = temp_dir("non-ascii-ps1");
        let target = dir.join("pnpm.ps1");
        let content =
            "# DeepSeek Harness Desktop - pnpm command shim (generated)\r\n$pnpmBin = 'C:\\Users\\小蔡\\pnpm.cjs'\r\n";

        write_shim_file(&target, content).unwrap();

        let bytes = std::fs::read(&target).unwrap();
        assert_eq!(&bytes[..3], &[0xEF, 0xBB, 0xBF], "ps1 shim needs a utf-8 bom");
        assert_eq!(
            std::fs::read_to_string(&target).unwrap().trim_start_matches('\u{feff}'),
            content
        );
        assert!(!is_foreign_file(&target));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ASCII 内容必须逐字节保持原样：历史落盘文件与既有断言都不受影响。
    #[test]
    fn ascii_shim_bytes_are_unchanged() {
        let dir = temp_dir("ascii-bytes");
        let target = dir.join("pnpm.cmd");
        let content = "@echo off\r\nset \"PNPM_BIN=C:\\tools\\pnpm.cjs\"\r\n";

        write_shim_file(&target, content).unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), content.as_bytes());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 代码页编码后仍是本应用生成的文件，下一次 `ensure_shims` 才能覆盖自愈。
    #[test]
    #[cfg(windows)]
    fn code_page_encoded_shim_stays_overwritable() {
        let dir = temp_dir("codepage-overwrite");
        let target = dir.join("pnpm.cmd");
        let header = "@echo off\r\nrem DeepSeek Harness Desktop - pnpm command shim (generated)\r\n";
        write_shim_file(&target, &format!("{header}rem C:\\Users\\小蔡\r\n")).unwrap();
        assert!(!is_foreign_file(&target));

        write_shim_file(&target, &format!("{header}rem C:\\Users\\小蔡\\fixed\r\n")).unwrap();

        let codepage = crate::utils::console_code_page();
        let fixed = format!("{header}rem C:\\Users\\小蔡\\fixed\r\n");
        let expected = crate::utils::encode_multibyte(&fixed, codepage)
            .unwrap_or_else(|| fixed.as_bytes().to_vec());
        assert_eq!(std::fs::read(&target).unwrap(), expected);
        let _ = std::fs::remove_dir_all(&dir);
    }
    /// 生产入口 `write_shims` 的落盘编排：pnpm/npx/npm 的 cmd 与 ps1 shim 必须一并
    /// 写入 bin 目录——这些 shim 是 dsh plugin 子进程解析 npx 的唯一可靠来源。
    /// 用 mock app 走真实入口，保证「接线断了」这类事故会被测试挡住。
    #[test]
    #[cfg(windows)]
    fn write_shims_writes_npx_and_npm_shims() {
        let dir = temp_dir("write-npx-npm");
        let bin_dir = dir.join("bin");
        let mut context = mock_context(noop_assets());
        context.config_mut().identifier = "dsh-tauri".into();
        let app = mock_builder().build(context).unwrap();

        write_shims(app.handle(), &bin_dir).unwrap();

        for name in [
            "pnpm.cmd", "pnpm.ps1", "npx.cmd", "npx.ps1", "npm.cmd", "npm.ps1",
        ] {
            let path = bin_dir.join(name);
            assert!(path.is_file(), "{name} was not written");
            assert!(!is_foreign_file(&path), "{name} must be a generated shim");
        }

        let npx = std::fs::read_to_string(bin_dir.join("npx.cmd")).unwrap();
        assert!(
            npx.contains("npx-cli.js"),
            "npx.cmd must bake the npm cli entry: {npx}"
        );
        assert!(
            npx.contains("npx command shim (generated)"),
            "npx.cmd lost its generated marker: {npx}"
        );
        assert!(!bin_dir.join("dsh.cmd").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
