//! Unix（macOS / Linux）下 `DSH_HOME` 的持久化机制（issue #871 的跨平台部分）。
//!
//! Windows 的落点是注册表 `HKCU\Environment`：一个值就能覆盖所有后续进程。
//! Unix 没有等价物，必须按「谁启动应用」分别覆盖，这里三个机制同时写、同时清：
//!
//! 1. **macOS LaunchAgent**（`~/Library/LaunchAgents/<APP_IDENTIFIER>.env.plist`）：
//!    plist 里的 `ProgramArguments` 在 `RunAtLoad` 时执行 `/bin/launchctl setenv`，
//!    把变量写进用户 launchd 会话，此后 Dock / Finder / Spotlight 启动的 GUI 应用
//!    都会继承——这是 macOS 上唯一能让「不经过 shell 启动」的应用读到变量的办法
//!    （plist 自带的 `EnvironmentVariables` 键只影响任务自身，GUI 应用读不到）；
//! 2. **Linux `~/.config/environment.d/<APP_IDENTIFIER>.conf`**：systemd 用户会话的
//!    变量定义，GNOME/KDE 等从显示管理器登录时由 `systemd --user` 读取；
//! 3. **`~/.profile` 的标记块**：所有走 login shell 的场景（终端启动、SSH，以及
//!    多数 X11 会话的 `.xinitrc` 链路）。
//!
//! 三个机制都只用纯文本 + 系统自带命令，不引入新依赖；Windows 上本模块整块不编译。
//!
//! 与 PATH 注入的区别：PATH 块可以「写进 rc 文件、下次开终端生效」，数据目录不行——
//! 迁移刚结束就要能拉起 Harness，因此除写文件外还要立刻 `std::env::set_var`，
//! 并在应用启动时从磁盘回读（见 [`restore_process_env`]）。

use std::path::PathBuf;

#[cfg(target_os = "macos")]
use crate::config::APP_IDENTIFIER;
use crate::service::cli::{strip_rc_block, upsert_rc_block, write_rc_with_backup};

use super::env::DATA_DIR_ENV;

/// 环境变量在 `~/.profile` 里的块标记。
///
/// 与 PATH 注入块（`cli::path::rc` 的 `RC_MARK_*`）**必须是不同的标记**：同一个
/// 文件里两份块各自只认得自己的标记，否则后写的一份会把前一份删掉。
const PROFILE_MARK_START: &str = "# >>> deepseek-harness dsh home >>>";
const PROFILE_MARK_END: &str = "# <<< deepseek-harness dsh home <<<";

/// Linux 的 systemd 用户会话变量文件（相对 `$HOME`）。
#[cfg(target_os = "linux")]
const ENVIRONMENT_D_FILE: &str = ".config/environment.d/dsh-tauri.conf";

/// macOS LaunchAgent 文件名（相对 `$HOME`）。
#[cfg(target_os = "macos")]
fn launch_agent_path(home: &std::path::Path) -> PathBuf {
    home.join(format!("Library/LaunchAgents/{APP_IDENTIFIER}.env.plist"))
}

// ---------------------------------------------------------------------------
// 纯文本助手（与平台无关，因此在 Windows 上也能单测）
// ---------------------------------------------------------------------------

/// `~/.profile` 的标记块内容。
///
/// 值来自 [`quote_sh`]：绝对路径里出现空格、`$`、引号时也要写出合法 shell 语句。
pub(crate) fn profile_block(value: &str) -> String {
    format!(
        "{PROFILE_MARK_START}\nexport {DATA_DIR_ENV}=\"{}\"\n{PROFILE_MARK_END}\n",
        quote_sh(value)
    )
}

/// 从 `~/.profile` 内容里读出标记块中的值（没有块时 `None`）。
///
/// 只认自己写的 `export NAME="..."` 形式；用户手写的其它形式不解析，避免误读
/// 一条与迁移无关的设置。
pub(crate) fn parse_profile_block(content: &str) -> Option<String> {
    let mut inside = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == PROFILE_MARK_START {
            inside = true;
            continue;
        }
        if !inside {
            continue;
        }
        if trimmed == PROFILE_MARK_END {
            break;
        }
        let Some(rest) = trimmed.strip_prefix("export ") else {
            continue;
        };
        let Some(rest) = rest.strip_prefix(DATA_DIR_ENV) else {
            continue;
        };
        let Some(raw) = rest.strip_prefix('=') else {
            continue;
        };
        let value = unquote_sh(raw.trim());
        if !value.is_empty() {
            return Some(value);
        }
    }
    None
}

/// 移除 `~/.profile` 里的标记块（保留用户其余内容）。
pub(crate) fn strip_profile_block(content: &str) -> String {
    strip_rc_block(content, PROFILE_MARK_START, PROFILE_MARK_END)
}

/// 把标记块并入 `~/.profile` 内容（幂等，块始终落在文件末尾）。
pub(crate) fn upsert_profile_block(content: &str, value: &str) -> String {
    upsert_rc_block(
        content,
        &profile_block(value),
        PROFILE_MARK_START,
        PROFILE_MARK_END,
    )
}

/// 单个 shell 双引号字符串的转义：`\`、`"`、`$` 与反引号需要加反斜杠，
/// 其余字符（含空格与中文路径）原样保留。
pub(crate) fn quote_sh(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        if matches!(c, '\\' | '"' | '$' | '`') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// [`quote_sh`] 的逆操作：去掉包裹的双引号并还原反斜杠转义。
pub(crate) fn unquote_sh(value: &str) -> String {
    let inner = value
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .unwrap_or(value);
    let mut out = String::with_capacity(inner.len());
    let mut escaped = false;
    for c in inner.chars() {
        if escaped {
            out.push(c);
            escaped = false;
            continue;
        }
        if c == '\\' {
            escaped = true;
            continue;
        }
        out.push(c);
    }
    out
}

/// 单个 systemd `environment.d` 值的转义。
///
/// `environment.d` 只做 `$VAR` 展开与引号剥离（见 systemd 的 `environment.d(5)`），
/// 反斜杠**不是**转义符，因此不能照搬 shell 的写法：把 `\` 写成 `\\` 会真的得到
/// 一个双反斜杠。这里只处理真正有语义的字符：`$` 写成 `$$`，`"` 与 `\` 原样保留
/// （都被双引号包裹，且不参与展开）。
#[cfg(any(target_os = "linux", test))]
pub(crate) fn quote_environment_d(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        if c == '$' {
            out.push_str("$$");
        } else {
            out.push(c);
        }
    }
    out
}

/// `~/.config/environment.d/<APP_IDENTIFIER>.conf` 的内容。
///
/// 写绝对路径而不是 `$HOME/...`：systemd 从显示管理器读取该文件时并不保证 `HOME`
/// 已经存在，展开失败会把数据目录指到一个字面量 `$HOME` 目录上。
#[cfg(target_os = "linux")]
pub(crate) fn environment_d_content(value: &str) -> String {
    format!("{DATA_DIR_ENV}=\"{}\"\n", quote_environment_d(value))
}

/// 从 `environment.d` 文件内容里读 `DSH_HOME`（只认 `NAME="值"` / `NAME=值`）。
#[cfg(any(target_os = "linux", test))]
pub(crate) fn parse_environment_d(content: &str) -> Option<String> {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') {
            continue;
        }
        let Some(rest) = trimmed.strip_prefix(DATA_DIR_ENV) else {
            continue;
        };
        let Some(raw) = rest.strip_prefix('=') else {
            continue;
        };
        let value = raw.trim().trim_matches('"').replace("$$", "$");
        if !value.is_empty() {
            return Some(value);
        }
    }
    None
}

/// macOS LaunchAgent 的 plist 内容。
#[cfg(target_os = "macos")]
pub(crate) fn launch_agent_plist(value: &str) -> String {
    format!(
        concat!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n",
            "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n",
            "<plist version=\"1.0\">\n",
            "<dict>\n",
            "  <key>Label</key>\n",
            "  <string>{0}.env</string>\n",
            "  <key>ProgramArguments</key>\n",
            "  <array>\n",
            "    <string>/bin/launchctl</string>\n",
            "    <string>setenv</string>\n",
            "    <string>{1}</string>\n",
            "    <string>{2}</string>\n",
            "  </array>\n",
            "  <key>RunAtLoad</key>\n",
            "  <true/>\n",
            "</dict>\n",
            "</plist>\n"
        ),
        APP_IDENTIFIER,
        DATA_DIR_ENV,
        xml_escape(value)
    )
}

/// XML 文本转义（plist 里 `<string>` 的值）。
#[cfg(target_os = "macos")]
pub(crate) fn xml_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

/// 从 LaunchAgent plist 里读回 `DSH_HOME`（`setenv` 的第三个参数）。
#[cfg(target_os = "macos")]
pub(crate) fn parse_launch_agent(content: &str) -> Option<String> {
    let needle = format!("<string>{DATA_DIR_ENV}</string>");
    let mut lines = content.lines();
    while let Some(line) = lines.next() {
        if line.trim() != needle {
            continue;
        }
        let raw = lines.next()?.trim();
        let value = raw.strip_prefix("<string>")?.strip_suffix("</string>")?;
        let value = xml_unescape(value);
        if !value.is_empty() {
            return Some(value);
        }
    }
    None
}

/// [`xml_escape`] 的逆操作。
#[cfg(target_os = "macos")]
pub(crate) fn xml_unescape(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&amp;", "&")
}

// ---------------------------------------------------------------------------
// 平台 I/O
// ---------------------------------------------------------------------------

/// 用户主目录（`$HOME`），复用 `config::user_home_dir` 的平台语义。
pub(crate) fn home_dir() -> Result<PathBuf, String> {
    crate::config::user_home_dir()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| "DATA_DIR_ENV_HOME: $HOME 未设置".to_string())
}

/// 读取 `~/.profile`（不存在视为空文件，读失败才报错）。
pub(crate) fn read_profile() -> Result<String, String> {
    let path = home_dir()?.join(".profile");
    match std::fs::read_to_string(&path) {
        Ok(content) => Ok(content),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(format!("DATA_DIR_ENV_READ: {}: {error}", path.display())),
    }
}

/// 写入 `~/.profile`（备份 + 原子替换，见 `cli::path::rc::write_rc_with_backup`）。
pub(crate) fn write_profile(content: &str) -> Result<(), String> {
    let path = home_dir()?.join(".profile");
    write_rc_with_backup(&path, content)
        .map_err(|error| format!("DATA_DIR_ENV_WRITE: {}: {error}", path.display()))
}

/// 写入 `DSH_HOME`（三处机制一起写）。
pub(crate) fn write_value(value: &str) -> Result<(), String> {
    let profile = read_profile()?;
    write_profile(&upsert_profile_block(&profile, value))?;
    write_platform_extra(value)?;
    apply_to_process(Some(value));
    Ok(())
}

/// 清除 `DSH_HOME`（三处机制一起清）。
pub(crate) fn clear_value() -> Result<(), String> {
    let profile = read_profile()?;
    let cleaned = strip_profile_block(&profile);
    if cleaned != profile {
        write_profile(&cleaned)?;
    }
    clear_platform_extra()?;
    apply_to_process(None);
    Ok(())
}

/// 让本进程立刻看到新值：后续 `config::get_dsh_data_path`、shim 生成与拉起的
/// Harness 都读它，不必等重启。
fn apply_to_process(value: Option<&str>) {
    match value {
        Some(text) => std::env::set_var(DATA_DIR_ENV, text),
        None => std::env::remove_var(DATA_DIR_ENV),
    }
}

/// 从磁盘回读持久化的值（GUI 应用由 launchd / 显示管理器启动，进程环境里可能
/// 什么都没有）。
pub(crate) fn read_value() -> Option<String> {
    if let Some(value) = std::env::var(DATA_DIR_ENV)
        .ok()
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
    {
        return Some(value);
    }
    if let Ok(profile) = read_profile() {
        if let Some(value) = parse_profile_block(&profile) {
            return Some(value);
        }
    }
    read_platform_extra()
}

/// 应用启动时把持久化的值注入本进程。
///
/// 必须在任何 `config::get_dsh_data_path` 调用之前执行：macOS / Linux 上 GUI 应用
/// 拿不到登录 shell 的环境，迁移过的数据目录只能靠这一步回到进程里。
/// 只补环境、不改文件：`DSH_HOME` 已经设过（终端启动、用户手工 export）时以环境为准。
pub(crate) fn restore_process_env() {
    if std::env::var(DATA_DIR_ENV)
        .map(|text| !text.trim().is_empty())
        .unwrap_or(false)
    {
        return;
    }
    let Some(value) = read_value() else {
        return;
    };
    log::info!("restored {DATA_DIR_ENV} from the persisted configuration: {value}");
    std::env::set_var(DATA_DIR_ENV, value);
}

/// macOS：`/bin/launchctl setenv` 立刻写入当前用户的 launchd 会话，并写一份
/// `~/Library/LaunchAgents/*.plist` 让每次登录自动重放（`setenv` 本身只活在
/// 当前会话里，注销即失效）。
#[cfg(target_os = "macos")]
fn write_platform_extra(value: &str) -> Result<(), String> {
    let plist = launch_agent_path(&home_dir()?);
    if let Some(parent) = plist.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("DATA_DIR_ENV_MKDIR: {}: {error}", parent.display()))?;
    }
    std::fs::write(&plist, launch_agent_plist(value))
        .map_err(|error| format!("DATA_DIR_ENV_WRITE: {}: {error}", plist.display()))?;
    launchctl(&["setenv", DATA_DIR_ENV, value])?;
    // 旧定义可能还留在 launchd 里：先卸载再加载，否则下次登录会重放旧值。
    let domain = launch_domain();
    let text = plist.to_string_lossy().into_owned();
    let _ = launchctl(&["bootout", &domain, &text]);
    launchctl(&["bootstrap", &domain, &text])
}

/// macOS：清掉 `setenv` 与 LaunchAgent。
#[cfg(target_os = "macos")]
fn clear_platform_extra() -> Result<(), String> {
    let plist = launch_agent_path(&home_dir()?);
    if plist.exists() {
        let _ = launchctl(&[
            "bootout",
            &launch_domain(),
            &plist.to_string_lossy().into_owned(),
        ]);
        std::fs::remove_file(&plist)
            .map_err(|error| format!("DATA_DIR_ENV_REMOVE: {}: {error}", plist.display()))?;
    }
    let _ = launchctl(&["unsetenv", DATA_DIR_ENV]);
    Ok(())
}

#[cfg(target_os = "macos")]
fn read_platform_extra() -> Option<String> {
    let plist = launch_agent_path(&home_dir().ok()?);
    parse_launch_agent(&std::fs::read_to_string(plist).ok()?)
}

#[cfg(target_os = "macos")]
fn launch_domain() -> String {
    format!("gui/{}", unsafe { libc::getuid() })
}

/// 调用 `/bin/launchctl`（不走 shell，参数原样传递）。
#[cfg(target_os = "macos")]
fn launchctl(args: &[&str]) -> Result<(), String> {
    let output = std::process::Command::new("/bin/launchctl")
        .args(args)
        .output()
        .map_err(|error| format!("DATA_DIR_ENV_LAUNCHCTL: launchctl {}: {error}", args[0]))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(format!(
        "DATA_DIR_ENV_LAUNCHCTL: launchctl {} failed: {stderr}",
        args[0]
    ))
}

/// Linux：写 `~/.config/environment.d/<APP_IDENTIFIER>.conf`。
///
/// 只写文件、不调 `systemctl --user import-environment`：后者导入的是「当前进程
/// 环境」，在 GUI 会话之外调用会把它清空，对 GUI 应用也没有意义。
#[cfg(target_os = "linux")]
fn write_platform_extra(value: &str) -> Result<(), String> {
    let path = home_dir()?.join(ENVIRONMENT_D_FILE);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("DATA_DIR_ENV_MKDIR: {}: {error}", parent.display()))?;
    }
    std::fs::write(&path, environment_d_content(value))
        .map_err(|error| format!("DATA_DIR_ENV_WRITE: {}: {error}", path.display()))?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn clear_platform_extra() -> Result<(), String> {
    let path = home_dir()?.join(ENVIRONMENT_D_FILE);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("DATA_DIR_ENV_REMOVE: {}: {error}", path.display())),
    }
}

#[cfg(target_os = "linux")]
fn read_platform_extra() -> Option<String> {
    let path = home_dir().ok()?.join(ENVIRONMENT_D_FILE);
    parse_environment_d(&std::fs::read_to_string(path).ok()?)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn write_platform_extra(_value: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn clear_platform_extra() -> Result<(), String> {
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn read_platform_extra() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_block_round_trips_and_escapes_shell_metacharacters() {
        let value = "/Volumes/Data/D$SH Home`x`\"q\"";
        let block = profile_block(value);
        assert!(block.starts_with(PROFILE_MARK_START));
        assert!(block.contains("export DSH_HOME=\"/Volumes/Data/D\\$SH Home\\`x\\`\\\"q\\\"\""));
        assert_eq!(parse_profile_block(&block), Some(value.to_string()));
    }

    #[test]
    fn profile_block_upsert_is_idempotent_and_keeps_other_blocks() {
        const PATH_BLOCK: &str = "# >>> deepseek-harness dsh >>>\nexport PATH=\"$HOME/.local/bin:$PATH\"\n# <<< deepseek-harness dsh <<<\n";
        let once = upsert_profile_block(PATH_BLOCK, "/data/dsh");
        assert!(once.contains("export PATH="));
        assert_eq!(parse_profile_block(&once), Some("/data/dsh".to_string()));
        assert_eq!(upsert_profile_block(&once, "/data/dsh"), once);
        assert_eq!(strip_profile_block(&once), PATH_BLOCK);
    }

    #[test]
    fn parse_profile_block_ignores_foreign_exports() {
        let content = format!("{PROFILE_MARK_START}\nexport OTHER=x\n{PROFILE_MARK_END}\n");
        assert_eq!(parse_profile_block(&content), None);
        assert_eq!(parse_profile_block("export DSH_HOME=/data/dsh\n"), None);
    }

    #[test]
    fn quote_sh_only_escapes_what_a_double_quoted_shell_string_needs() {
        assert_eq!(quote_sh("/data/dsh"), "/data/dsh");
        assert_eq!(quote_sh("/data/a b"), "/data/a b");
        assert_eq!(quote_sh("a\"b"), "a\\\"b");
        assert_eq!(quote_sh("a$b"), "a\\$b");
        assert_eq!(quote_sh("a\\b"), "a\\\\b");
    }

    #[test]
    fn environment_d_quoting_matches_systemd_rules() {
        assert_eq!(quote_environment_d("/data/dsh"), "/data/dsh");
        assert_eq!(quote_environment_d("/data/D$SH"), "/data/D$$SH");
        assert_eq!(quote_environment_d("C:\\data"), "C:\\data");
        assert_eq!(parse_environment_d("# c\nDSH_HOME=\"/data/dsh\"\n"), Some("/data/dsh".to_string()));
        assert_eq!(parse_environment_d("DSH_HOME=\n"), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn launch_agent_plist_is_well_formed_xml_with_escaped_values() {
        let value = "/Volumes/a&b/<dsh>";
        let plist = launch_agent_plist(value);
        assert!(plist.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>"));
        assert!(plist.contains("<string>/bin/launchctl</string>"));
        assert!(plist.contains("<string>setenv</string>"));
        assert!(plist.contains("<string>/Volumes/a&amp;b/&lt;dsh&gt;</string>"));
        assert!(plist.contains("<key>RunAtLoad</key>"));
        assert!(plist.ends_with("</plist>\n"));
        assert_eq!(parse_launch_agent(&plist), Some(value.to_string()));
        // 有 plutil 的机器上顺带做一次真实语法校验
        let dir = std::env::temp_dir().join(format!("dsh-launch-agent-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("env.plist");
        std::fs::write(&file, &plist).unwrap();
        let lint = std::process::Command::new("/usr/bin/plutil")
            .args(["-lint", file.to_str().unwrap()])
            .output();
        if let Ok(output) = lint {
            assert!(output.status.success(), "plutil -lint rejected the plist");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
