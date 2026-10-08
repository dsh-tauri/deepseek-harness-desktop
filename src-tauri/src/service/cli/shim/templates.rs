//! shim 共享脚本片段（纯文本常量，作为 format! 的参数嵌入各构建函数）。
//!
//! shim 文本必须全英文：cmd/ps1 按系统代码页解析，中文注释会乱码成命令执行。
//! 变量约定：cmd 用 `%NODE_BIN%` / `%NODE_DIR%` / `%DSH_BIN%` / `%PNPM_BIN%`，
//! ps1 用 `$nodeBin` / `$nodeDir` / `$gitDir` / `$dshBin` / `$pnpmBin`，sh 用同名
//! 大写下划线形式。cmd 侧不设 `GIT_DIR`：该变量对 Git 是仓库目录语义，导出会给所有
//! 子进程注入一个假仓库根；捆绑 Git 目录由构建函数直接内联进 PATH 注入行。路径全部
//! 由桌面端在生成 shim 时按依赖映射表解析后写死（不再假设
//! `<AppData>/dependencies/<name>` 布局）；这些常量里的 `{`/`}` 是字面量（由
//! format! 的参数占位符区分）。

// ---------------------------------------------------------------------------
// shim 共享片段：node 解析逻辑（dsh / pnpm shim 共用）
//
// 规则：优先 `DSH_NODE` 环境变量（桌面端注入其已解析并核验过的 node 路径，
// 保证 shim 与应用预检一致），其次 PATH 中版本兼容的本地 node（v22.19+ /
// v24+，与 config::is_supported_node_version 一致），否则回退捆绑
// 运行时。`DSH_NODE` 只在桌面端自身派生的子进程里存在，终端用户环境不受影响。
// ---------------------------------------------------------------------------

pub(super) const CMD_NODE_RESOLVE: &str = r#"
rem Prefer the desktop-resolved node (DSH_NODE, injected by the app into its
rem own child processes), then a version-compatible local node, then the
rem bundled runtime. DSH_NODE makes the shim and the app's pre-check agree:
rem the app verified the node exists before spawning the child, and the shim
rem must not re-derive it from PATH (which can miss nodes the app found).
rem Pure batch version check (for /f tokens + numeric compare), no powershell
rem child: avoids console flashes when invoked without a console and skips the
rem per-call powershell startup cost.
if not defined DSH_NODE goto :skip_dsh_node
set "NODE=%DSH_NODE%"
rem Windows canonical paths may carry a \\?\ verbatim prefix that cmd.exe
rem cannot launch directly; strip it before checking/using the path.
if "%NODE:~0,4%"=="\\?\" set "NODE=%NODE:~4%"
if exist "%NODE%" goto :launch
:skip_dsh_node
where node >nul 2>nul
if errorlevel 1 goto :use_bundled
set "NODE_VERSION="
for /f "delims=" %%v in ('node --version 2^>nul ^| findstr /r /x "v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*"') do set "NODE_VERSION=%%v"
if not defined NODE_VERSION goto :use_bundled
for /f "tokens=1,2 delims=v." %%a in ("%NODE_VERSION%") do set "NODE_MAJOR=%%a" & set "NODE_MINOR=%%b"
if not defined NODE_MAJOR goto :use_bundled
if %NODE_MAJOR% GEQ 24 goto :node_ok
if %NODE_MAJOR% EQU 22 if defined NODE_MINOR if %NODE_MINOR% GEQ 19 goto :node_ok
goto :use_bundled

:node_ok
set "NODE=node"
goto :launch

:node_dsh
set "NODE=%DSH_NODE%"
goto :launch

:use_bundled
if not exist "%NODE_BIN%" goto :no_node
set "NODE=%NODE_BIN%"
set "PATH=%NODE_DIR%;%PATH%"
"#;

pub(super) const PS1_NODE_RESOLVE: &str = r#"
# Prefer the desktop-resolved node (DSH_NODE, injected by the app into its
# own child processes), then a version-compatible local node, then the
# bundled runtime — see the CMD shim for why DSH_NODE wins first.
$node = $null
if ($env:DSH_NODE) {
    $node = $env:DSH_NODE
    # Windows canonical paths may carry a \\?\ verbatim prefix; strip it so
    # PowerShell/cmd can launch the path directly.
    if ($node.StartsWith('\\?\')) { $node = $node.Substring(4) }
    if (-not (Test-Path -LiteralPath $node)) { $node = $null }
}
if (-not $node) {
    $localNode = Get-Command node -ErrorAction SilentlyContinue
    if ($localNode) {
        try {
            $version = & node --version 2>$null
            if ($version -match '^v(\d+)\.(\d+)\.(\d+)$') {
                $major = [int]$matches[1]
                $minor = [int]$matches[2]
                if (($major -eq 22 -and $minor -ge 19) -or $major -ge 24) {
                    $node = 'node'
                }
            }
        } catch { }
    }
}
if (-not $node) {
    if (Test-Path -LiteralPath $nodeBin) {
        $node = $nodeBin
        $env:PATH = $nodeDir + ';' + $env:PATH
    }
}
if (-not $node) {
    Write-Error 'Node.js runtime not found. Please run DeepSeek Harness Desktop to install it first.'
    exit 1
}
"#;

pub(super) const SH_NODE_RESOLVE: &str = r#"
NODE=""
# Prefer the desktop-resolved node (DSH_NODE, injected by the app into its
# own child processes), then a version-compatible local node, then the
# bundled runtime — see the CMD shim for why DSH_NODE wins first.
if [ -n "$DSH_NODE" ] && [ -x "$DSH_NODE" ]; then
  NODE="$DSH_NODE"
fi
if [ -z "$NODE" ] && command -v node >/dev/null 2>&1; then
  NODE_V=$(node --version 2>/dev/null)
  if printf '%s\n' "$NODE_V" | awk '/^v[0-9]+\.[0-9]+\.[0-9]+$/ { exit 0 } { exit 1 }'; then
    MAJOR=$(printf '%s' "$NODE_V" | awk -F. '{ gsub(/^v/, "", $1); print $1 }')
    MINOR=$(printf '%s' "$NODE_V" | awk -F. '{ print $2 }')
    if { [ -n "$MAJOR" ] && [ "$MAJOR" -ge 24 ]; } 2>/dev/null || \
       { [ "$MAJOR" -eq 22 ] && [ "$MINOR" -ge 19 ]; } 2>/dev/null; then
      NODE="node"
    fi
  fi
fi
if [ -z "$NODE" ]; then
  if [ -x "$NODE_BIN" ]; then
    NODE="$NODE_BIN"
    export PATH="$NODE_DIR:$PATH"
  fi
fi
if [ -z "$NODE" ]; then
  echo "Node.js runtime not found. Please run DeepSeek Harness Desktop to install it first." >&2
  exit 1
fi
"#;

// ---------------------------------------------------------------------------
// dsh shim 共享片段：用户已安装的 dsh 优先（避免覆盖/遮蔽用户自己的 dsh 与
// $DSH_HOME）。与 pnpm shim 的"用户优先"策略一致：先转发 PATH 中（排除本
// shim 目录）的用户 dsh，转发时不注入本应用的 DSH_HOME，保留用户环境；
// 仅找不到用户 dsh 时才回退到捆绑 dsh。
// 变量约定：cmd 用 %SELF_PREFIX%/%USER_DSH%，ps1 用 $selfDir/$userDsh，
// sh 用 $SELF_DIR。dsh shim 仅 release 构建写入（debug 构建不覆盖共享的
// dsh shim，见 write_shims），debug 下这些常量/函数未使用，允许 dead_code。
// ---------------------------------------------------------------------------

#[cfg_attr(debug_assertions, allow(dead_code))]
pub(super) const CMD_USER_DSH_PRECEDENCE: &str = r#"
rem Prefer a user-installed dsh on PATH (skip our own shim dir), fall back to bundled.
rem This preserves your own dsh binary and its $DSH_HOME config; nothing is overwritten.
set "SELF_PREFIX=%~dp0"
set "SELF_PREFIX=%SELF_PREFIX:~0,-1%"
set "USER_DSH="
for /f "delims=" %%d in ('where dsh 2^>nul') do (
  if not defined USER_DSH (
    if /i not "%%d"=="%SELF_PREFIX%\dsh.cmd" (
      if /i not "%%d"=="%SELF_PREFIX%\dsh.ps1" (
        if /i not "%%d"=="%SELF_PREFIX%\dsh.exe" (
          if /i not "%%d"=="%SELF_PREFIX%\dsh.bat" (
            if /i "%%~xd"==".cmd" set "USER_DSH=%%d"
            if /i "%%~xd"==".exe" set "USER_DSH=%%d"
            if /i "%%~xd"==".bat" set "USER_DSH=%%d"
          )
        )
      )
    )
  )
)
if defined USER_DSH (
  call "%USER_DSH%" %*
  exit /b %ERRORLEVEL%
)
"#;

#[cfg_attr(debug_assertions, allow(dead_code))]
pub(super) const PS1_USER_DSH_PRECEDENCE: &str = r#"
# Prefer a user-installed dsh on PATH (skip our own shim dir), fall back to bundled.
# This preserves your own dsh binary and its $env:DSH_HOME config; nothing is overwritten.
$selfDir = $PSScriptRoot.TrimEnd('\') + '\'
$userDsh = Get-Command dsh -All -ErrorAction SilentlyContinue |
    Where-Object { $_.Source -and -not $_.Source.StartsWith($selfDir, [System.StringComparison]::OrdinalIgnoreCase) } |
    Select-Object -First 1
if ($userDsh) {
    & $userDsh.Source @args
    exit $LASTEXITCODE
}
"#;

#[cfg_attr(any(windows, debug_assertions), allow(dead_code))] // 仅 Unix shim 使用
pub(super) const SH_USER_DSH_PRECEDENCE: &str = r#"
# Prefer a user-installed dsh on PATH (skip our own shim dir), fall back to bundled.
# This preserves your own dsh binary and its $DSH_HOME config; nothing is overwritten.
remaining_path=${PATH-}:
while [ -n "$remaining_path" ]; do
  dir=${remaining_path%%:*}
  remaining_path=${remaining_path#*:}
  dir=${dir:-.}
  if [ "$dir/dsh" -ef "$0" ]; then
    continue
  fi
  if [ -x "$dir/dsh" ]; then
    exec "$dir/dsh" "$@"
  fi
done
unset remaining_path
"#;

#[cfg(all(test, unix))]
mod tests {
    use super::SH_USER_DSH_PRECEDENCE;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::path::PathBuf;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    struct Scratch(PathBuf);

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn dsh_shim_skips_aliases_and_preserves_user_command_arguments_and_status() {
        let scratch = Scratch(std::env::temp_dir().join(format!(
            "dsh-shim-alias-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        )));
        let root = &scratch.0;
        let bin = root.join("shim bin");
        std::fs::create_dir_all(&bin).unwrap();
        let shim = bin.join("dsh");
        std::fs::write(
            &shim,
            format!("#!/bin/sh\n{SH_USER_DSH_PRECEDENCE}\nprintf 'FALLBACK\\n'\n"),
        )
        .unwrap();
        std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755)).unwrap();
        let alias = root.join("alias");
        symlink(&bin, &alias).unwrap();
        let file_alias = root.join("file-alias");
        std::fs::create_dir_all(&file_alias).unwrap();
        symlink(&shim, file_alias.join("dsh")).unwrap();
        let hard_link = root.join("hard-link");
        std::fs::create_dir_all(&hard_link).unwrap();
        std::fs::hard_link(&shim, hard_link.join("dsh")).unwrap();

        for prefix in [
            bin.display().to_string(),
            format!("{}/", bin.display()),
            format!("{}:{}", bin.display(), alias.display()),
            file_alias.display().to_string(),
            hard_link.display().to_string(),
            ".".into(),
            String::new(),
        ] {
            let output = tokio::time::timeout(
                Duration::from_secs(2),
                tokio::process::Command::new(&shim)
                    .current_dir(&bin)
                    .env_clear()
                    .env("PATH", format!("{prefix}:{}", root.join("missing").display()))
                    .kill_on_drop(true)
                    .output(),
            )
            .await
            .expect("shim must not re-execute itself")
            .unwrap();
            assert!(output.status.success(), "PATH prefix: {prefix}");
            assert_eq!(output.stdout, b"FALLBACK\n", "PATH prefix: {prefix}");
        }

        let user_bin = root.join("user[bin]");
        std::fs::create_dir_all(&user_bin).unwrap();
        let user_dsh = user_bin.join("dsh");
        std::fs::write(&user_dsh, "#!/bin/sh\nprintf '%s\\n' \"$@\"\nexit 7\n").unwrap();
        std::fs::set_permissions(&user_dsh, std::fs::Permissions::from_mode(0o755)).unwrap();
        let decoy = root.join("userb");
        std::fs::create_dir_all(&decoy).unwrap();
        let decoy_dsh = decoy.join("dsh");
        std::fs::write(&decoy_dsh, "#!/bin/sh\nexit 99\n").unwrap();
        std::fs::set_permissions(&decoy_dsh, std::fs::Permissions::from_mode(0o755)).unwrap();
        for path in [
            format!("{}:{}", bin.display(), user_bin.display()),
            format!("{}:", root.join("missing").display()),
            String::new(),
        ] {
            let output = tokio::time::timeout(
                Duration::from_secs(2),
                tokio::process::Command::new(&shim)
                    .current_dir(&user_bin)
                    .env_clear()
                    .env("PATH", &path)
                    .args(["two words", "*"])
                    .kill_on_drop(true)
                    .output(),
            )
            .await
            .expect("user command must finish")
            .unwrap();
            assert_eq!(output.status.code(), Some(7), "PATH: {path}");
            assert_eq!(output.stdout, b"two words\n*\n", "PATH: {path}");
        }
    }
}
