//! 桌面载体的浏览器会话建立：取本次启动的 token URL，完成内核的 303 +
//! Set-Cookie 交换，把会话 Cookie 交给 WebView 的 Cookie 库。
//!
//! 内嵌载体会把内核的 `authorizeIndex` 短路（见 `packages/builtin-plugin-tauri`
//! 的 `gate`），WebView 因此从来没有那颗 `dsh-auth-*` 会话 Cookie。内核的 `/api`
//! RPC 通道由 `admit` 覆写放行，但插件自建的 HTTP 路由（浏览器插件的
//! `/api/ego/*` 等）只认这颗 Cookie，缺了它一律 401。
//!
//! 官方 Electron 壳在壳进程里做同一件事（`authenticateWebHost` 取 303 的
//! `set-cookie` 再转发 `Cookie` 头）。这里交换一次后直接写进 Cookie 库，
//! WebView 内的普通请求就自带凭证，页面 URL 不必携带 token，载体标记
//! （`dshDesktop=1`）也不会被 303 抹掉。

use std::io::Read;
use std::path::Path;
use std::time::Duration;

use tauri::webview::cookie::{Cookie, Expiration, SameSite};

use crate::config;

/// `dsh web` 打印的登录 URL 前缀（`printUrl` 默认开启）。
const LAUNCH_LINE_PREFIX: &str = "dsh web: ";

/// 日志头部窗口：每次启动都会轮转日志，token 行稳定落在开头几百字节内，
/// 而日志正文会随会话增长到数 MB，故只从头部取。
const LOG_HEAD_BYTES: u64 = 64 * 1024;

const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(5);

/// 从服务日志头部取出与本进程端口匹配的 token URL。
pub fn launch_url_in(text: &str, port: u16) -> Option<String> {
    text.lines()
        .filter_map(|line| line.trim().strip_prefix(LAUNCH_LINE_PREFIX))
        .filter_map(|url| tauri::Url::parse(url.trim()).ok())
        .find(|url| url.port() == Some(port))
        .map(Into::into)
}

/// 完成 token → 会话 Cookie 的交换。
///
/// 失败只意味着拿不到 Cookie：其余通道仍由 `gate` 放行，调用方记一条告警即可。
pub async fn session_cookie(port: u16, log_path: &Path) -> Result<Cookie<'static>, String> {
    let launch_url = launch_url_in(&read_head(log_path)?, port)
        .ok_or("HARNESS_AUTH_TOKEN_MISSING: no dsh web launch URL for this port")?;
    let header = exchange(&launch_url).await?;
    cookie_from_set_cookie(&header)
        .ok_or_else(|| "HARNESS_AUTH_COOKIE_INVALID: unusable set-cookie".to_string())
}

/// 把本次启动的会话 Cookie 种进承载 Harness 页面的 WebView。
///
/// 必须在子 WebView 创建前调用：子页面与会话共享同一份 Cookie 库，先种后加载
/// 才能让首帧请求就带上凭证。
pub fn inject(webview: &crate::Webview, cookie: Cookie<'static>) -> Result<(), String> {
    webview
        .set_cookie(cookie)
        .map_err(|error| format!("HARNESS_AUTH_COOKIE_REJECTED: {error}"))
}

fn read_head(path: &Path) -> Result<String, String> {
    let file = std::fs::File::open(path)
        .map_err(|error| format!("HARNESS_AUTH_LOG_UNREADABLE: {error}"))?;
    let mut bytes = Vec::new();
    file.take(LOG_HEAD_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("HARNESS_AUTH_LOG_UNREADABLE: {error}"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// 请求 token URL，只接受 303 + `set-cookie`：不跟随重定向，重定向本身即成功信号。
async fn exchange(launch_url: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(config::LOOPBACK_CONNECT_TIMEOUT)
        .timeout(EXCHANGE_TIMEOUT)
        .build()
        .map_err(|error| format!("HARNESS_AUTH_CLIENT_FAILED: {error}"))?;
    let response = client
        .get(launch_url)
        .send()
        .await
        .map_err(|error| format!("HARNESS_AUTH_REQUEST_FAILED: {error}"))?;
    if response.status() != reqwest::StatusCode::SEE_OTHER {
        return Err(format!(
            "HARNESS_AUTH_REJECTED: token exchange returned {}",
            response.status()
        ));
    }
    response
        .headers()
        .get(reqwest::header::SET_COOKIE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .ok_or_else(|| "HARNESS_AUTH_REJECTED: token exchange set no cookie".to_string())
}

/// 把 `Set-Cookie` 转成宿主 Cookie。
///
/// 必须带 `domain`：运行时用它拼出 `set_cookie` 的 URL（壳页面自身是
/// `tauri://localhost`，不是 Cookie 能落的那种 URL）。回环 IP 上的 Domain 在
/// Chromium 里按 host-only 处理，端口不参与归属，正是内核签发时的语义。
fn cookie_from_set_cookie(header: &str) -> Option<Cookie<'static>> {
    let parsed = Cookie::parse(header.to_owned()).ok()?;
    let mut builder = Cookie::build((parsed.name().to_owned(), parsed.value().to_owned()))
        .domain(config::DSH_HOST.trim_start_matches("http://").to_owned())
        .path(parsed.path().unwrap_or("/").to_owned())
        .secure(parsed.secure().unwrap_or(false))
        .http_only(parsed.http_only().unwrap_or(true))
        .same_site(parsed.same_site().unwrap_or(SameSite::Strict));
    if let Some(expires) = parsed.expires_datetime() {
        builder = builder.expires(Expiration::DateTime(expires));
    }
    Some(builder.build())
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::net::TcpListener;
    use std::thread;

    use super::*;

    const LOG: &str = "\
2026-10-15T01:06:55.167Z [info] boot
dsh web: http://127.0.0.1:3081/?token=other-port
dsh web: http://127.0.0.1:3080/?token=fresh
";

    #[test]
    fn launch_url_takes_the_first_line_matching_the_port() {
        assert_eq!(
            launch_url_in(LOG, 3080).as_deref(),
            Some("http://127.0.0.1:3080/?token=fresh")
        );
        assert_eq!(
            launch_url_in(LOG, 3081).as_deref(),
            Some("http://127.0.0.1:3081/?token=other-port")
        );
        assert_eq!(launch_url_in(LOG, 3082), None);
        assert_eq!(launch_url_in("no launch line\n", 3080), None);
        assert_eq!(
            launch_url_in("dsh web: http://127.0.0.1:3080\n", 3080).as_deref(),
            Some("http://127.0.0.1:3080"),
            "没有 token 的旧内核行同样是本端口的启动记录"
        );
    }

    #[test]
    fn head_window_keeps_the_launch_line_inside_a_long_log() {
        let dir = std::env::temp_dir().join(format!("dsh-auth-head-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("dsh-web.log");
        let mut text = format!("dsh web: http://127.0.0.1:3080/?token=fresh\n");
        text.push_str(&"x".repeat(usize::try_from(LOG_HEAD_BYTES).unwrap()));
        std::fs::write(&path, text).unwrap();
        let head = read_head(&path).unwrap();
        assert_eq!(
            launch_url_in(&head, 3080).as_deref(),
            Some("http://127.0.0.1:3080/?token=fresh")
        );
        let missing = read_head(&dir.join("absent.log")).unwrap_err();
        assert!(
            missing.starts_with("HARNESS_AUTH_LOG_UNREADABLE"),
            "{missing}"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn set_cookie_keeps_the_kernel_session_attributes() {
        let header = "dsh-auth-abc=v1.body.sig; Max-Age=2592000; Path=/; \
                      Expires=Wed, 02 Dec 2026 07:31:46 GMT; HttpOnly; SameSite=Strict";
        let cookie = cookie_from_set_cookie(header).expect("kernel set-cookie must parse");
        assert_eq!(cookie.name(), "dsh-auth-abc");
        assert_eq!(cookie.value(), "v1.body.sig");
        assert_eq!(cookie.domain(), Some("127.0.0.1"));
        assert_eq!(cookie.path(), Some("/"));
        assert_eq!(cookie.http_only(), Some(true));
        assert_eq!(cookie.same_site(), Some(SameSite::Strict));
        assert!(cookie.expires_datetime().is_some());
    }

    #[test]
    fn bare_set_cookie_stays_http_only_and_strict() {
        let cookie = cookie_from_set_cookie("dsh-auth-abc=value").expect("minimal cookie parses");
        assert_eq!(cookie.path(), Some("/"));
        assert_eq!(cookie.http_only(), Some(true));
        assert_eq!(cookie.same_site(), Some(SameSite::Strict));
        assert_eq!(cookie.secure(), Some(false));
        assert_eq!(cookie.expires_datetime(), None);
    }

    #[tokio::test]
    async fn exchange_returns_the_minted_cookie_only_for_a_303() {
        let minted = "dsh-auth-127001=token-value; Max-Age=60; Path=/; HttpOnly; SameSite=Strict";
        let url = serve(303, minted).await;
        assert_eq!(exchange(&url).await.unwrap(), minted);
    }

    #[tokio::test]
    async fn exchange_rejects_a_served_index_without_a_redirect() {
        let url = serve(200, "dsh-auth-127001=leaked").await;
        let error = exchange(&url).await.unwrap_err();
        assert!(error.starts_with("HARNESS_AUTH_REJECTED"), "{error}");
    }

    /// 起一个只回一行的回环 HTTP 服务，返回它的 token URL。
    async fn serve(status: u16, set_cookie: &str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let response = format!(
            "HTTP/1.1 {status} X\r\ncontent-length: 0\r\nlocation: ./\r\nset-cookie: {set_cookie}\r\nconnection: close\r\n\r\n"
        );
        thread::spawn(move || {
            if let Ok((mut socket, _)) = listener.accept() {
                let mut sink = [0u8; 1024];
                let _ = socket.read(&mut sink);
                let _ = socket.write_all(response.as_bytes());
            }
        });
        format!("http://127.0.0.1:{port}/?token=test")
    }
}
