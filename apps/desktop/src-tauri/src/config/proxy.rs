use crate::{AppHandle};
use std::collections::HashMap;

use reqwest::{ClientBuilder, NoProxy, Proxy, Url};
use std::time::{Duration, Instant};
use tauri::{ Runtime};

pub fn normalize_proxy_url(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(String::new());
    }
    let invalid = || {
        "PROXY_INVALID: use an HTTP, HTTPS, SOCKS5 or SOCKS5H proxy URL without a path, query or fragment".to_string()
    };
    if !value.contains("://") || value.chars().any(char::is_whitespace) {
        return Err(invalid());
    }
    let url = Url::parse(value).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https" | "socks5" | "socks5h")
        || url.host_str().is_none()
        || url.port() == Some(0)
        || !matches!(url.path(), "" | "/")
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    Proxy::all(url.as_str()).map_err(|_| invalid())?;
    Ok(url.to_string())
}

pub fn http_client_builder<R: Runtime>(app: &AppHandle<R>) -> Result<ClientBuilder, String> {
    client_builder(&super::get_store_dat_setting(app).proxy_url)
}

pub(crate) fn client_builder(value: &str) -> Result<ClientBuilder, String> {
    let url = normalize_proxy_url(value)?;
    let builder = reqwest::Client::builder();
    if url.is_empty() {
        return Ok(builder);
    }
    let proxy = Proxy::all(&url)
        .map_err(|_| "PROXY_INVALID: unsupported proxy URL".to_string())?
        .no_proxy(NoProxy::from_string("localhost,.localhost,127.0.0.0/8,::1"));
    Ok(builder.no_proxy().proxy(proxy))
}

/// 代理连通性测试结果（`reason` 是固定的失败分类，不含任何原始错误文本）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct ProxyTestResult {
    pub ok: bool,
    pub reason: Option<String>,
    pub status: Option<u16>,
    pub latency_ms: u64,
}

/// 用给定代理向 `target` 发一次真实请求，只读响应头，用于判断配置是否可用。
pub async fn test(proxy_url: &str, target: &str, timeout: Duration) -> ProxyTestResult {
    let started = Instant::now();
    let failed = |reason: &str, status: Option<u16>| ProxyTestResult {
        ok: false,
        reason: Some(reason.to_string()),
        status,
        latency_ms: started.elapsed().as_millis() as u64,
    };
    let builder = match client_builder(proxy_url) {
        Ok(builder) => builder,
        Err(error) => {
            log::warn!("PROXY_TEST: invalid proxy setting: {error}");
            return failed("invalid", None);
        }
    };
    let client = match builder
        .user_agent("deepseek-harness-desktop")
        .timeout(timeout)
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            log::warn!("PROXY_TEST: client build failed: {error}");
            return failed("request", None);
        }
    };
    let response = match client.get(target).send().await {
        Ok(response) => response,
        Err(error) => {
            let reason = if error.is_timeout() {
                "timeout"
            } else if error.is_connect() {
                "connect"
            } else {
                "request"
            };
            log::warn!("PROXY_TEST: request failed ({reason})");
            return failed(reason, None);
        }
    };
    let status = response.status().as_u16();
    let latency_ms = started.elapsed().as_millis() as u64;
    if response.status().is_success() {
        return ProxyTestResult {
            ok: true,
            reason: None,
            status: Some(status),
            latency_ms,
        };
    }
    log::warn!("PROXY_TEST: unexpected status {status}");
    ProxyTestResult {
        ok: false,
        reason: Some("status".to_string()),
        status: Some(status),
        latency_ms,
    }
}

/// Node 的系统信任库开关：让 Node 用操作系统的 CA 信任库做 TLS 校验，而不是只信
/// 自带的 CA 列表（Node 22.15 起提供，Electron 的 Node 模式同样支持）。
///
/// 桌面端 Rust 侧（reqwest + native-tls）读的本来就是系统信任库，核心侧不读就是
/// 两侧信任不一致：走 TLS 中间人的企业代理时核心报 UNABLE_TO_VERIFY_LEAF_SIGNATURE，
/// 桌面端却正常（issue #1530）。用 Node 自带的开关对齐，语义由 Node 维护，跨平台
/// 不必自行解析 CA 文件。
pub const NODE_SYSTEM_CA_FLAG: &str = "--use-system-ca";

/// 该 Node 版本是否认识 [`NODE_SYSTEM_CA_FLAG`]。
///
/// 未知开关会让 Node 直接以 "bad option" 退出，必须先确认版本再下发。
pub fn node_supports_system_ca(version: &str) -> bool {
    let Some((major, minor)) = parse_node_version(version) else {
        return false;
    };
    match major {
        22 => minor >= 15,
        23 => minor >= 5,
        other => other >= 24,
    }
}

/// 给 NODE_OPTIONS 追加系统信任库开关；已经带有时原样返回。
pub fn node_options_with_system_ca(existing: &str) -> String {
    if existing
        .split_whitespace()
        .any(|item| item == NODE_SYSTEM_CA_FLAG)
    {
        return existing.to_string();
    }
    let trimmed = existing.trim();
    if trimmed.is_empty() {
        return NODE_SYSTEM_CA_FLAG.to_string();
    }
    format!("{trimmed} {NODE_SYSTEM_CA_FLAG}")
}

/// 解析 Node 版本号的前两段（"24.21.0" → (24, 21)）。
fn parse_node_version(version: &str) -> Option<(u32, u32)> {
    let mut parts = version.trim().trim_start_matches('v').split('.');
    let major = parts.next()?.trim().parse().ok()?;
    let minor = parts.next()?.trim().parse().ok()?;
    Some((major, minor))
}

/// 子进程代理环境（issue #110）：把配置页的代理地址翻译成核心与插件子进程能读的
/// 环境变量。
///
/// 核心（`@deepseek-ai/dsh-http-proxy`）只在启动时读 `http_proxy` / `https_proxy` /
/// `no_proxy` 发布代理策略，并给**它自己** spawn 的子进程补 `NODE_USE_ENV_PROXY`；
/// 桌面端 spawn 的进程不在那条链路上，必须显式下发。
///
/// 只写小写名：核心的读取顺序是小写优先、大写兜底，值相同故不重复写；curl、git、
/// pnpm 同样认小写。`no_proxy` 与 [`client_builder`] 的绕过列表保持一致并补上
/// Node 自己的匹配规则只认的写法，再逐条追加进程已有的 `NO_PROXY` / `no_proxy`
/// （见 [`child_no_proxy`]）。空值返回空 map：用户没配代理时不注入任何键，子进程
/// 照旧继承系统环境。
///
/// SOCKS 值原样下发：curl/git/pnpm 认，Node 侧由核心判为不支持后保持直连（与只配
/// 代理不改代码时一致）。
pub fn proxy_child_env(value: &str) -> HashMap<String, String> {
    let url = match normalize_proxy_url(value) {
        Ok(url) if !url.is_empty() => url,
        _ => return HashMap::new(),
    };
    HashMap::from([
        ("http_proxy".to_string(), url.clone()),
        ("https_proxy".to_string(), url),
        ("no_proxy".to_string(), child_no_proxy()),
    ])
}

// 仅补继承的 HTTP(S) 代理：单独注入 no_proxy 会让 GIO 改选环境 resolver，覆盖系统/PAC 代理。
#[cfg(any(target_os = "linux", test))]
pub(crate) fn prepare_inherited_proxy() {
    if ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY"]
        .iter()
        .any(|key| std::env::var(key).is_ok_and(|value| !value.trim().is_empty()))
    {
        let bypass = child_no_proxy();
        unsafe { std::env::set_var("no_proxy", &bypass); }
        unsafe { std::env::set_var("NO_PROXY", bypass); }
    }
}

/// 子进程的代理绕过列表：固定回环条目加上进程已有的 `NO_PROXY` / `no_proxy`。
///
/// 追加而不是覆盖：Node 与 curl 都是「命中即绕过」，追加不会让既有例外失效；
/// 小写 `no_proxy` 在 Node 中优先于大写，若直接覆盖，企业内网例外
/// （如 `.corp.example`）就会失效，内网请求被送去代理。两个名字都读、按原样去重。
fn child_no_proxy() -> String {
    let inherited = ["NO_PROXY", "no_proxy"]
        .iter()
        .filter_map(std::env::var_os)
        .map(|value| value.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(",");
    merge_no_proxy(&inherited)
}

/// 固定回环条目与继承条目合并成一份列表。
///
/// Node 的匹配规则只认裸主机名与「起-止」IPv4 段、不认 CIDR，所以回环段除保留
/// `127.0.0.0/8`（curl、git、pnpm 认）外再补一条 `127.0.0.1-127.255.255.255`。
fn merge_no_proxy(inherited: &str) -> String {
    let mut entries = CHILD_NO_PROXY
        .split(',')
        .map(str::to_string)
        .collect::<Vec<_>>();
    for entry in inherited.split(',') {
        let entry = entry.trim();
        if !entry.is_empty() && !entries.iter().any(|item| item == entry) {
            entries.push(entry.to_string());
        }
    }
    entries.join(",")
}

/// 子进程代理绕过列表的固定部分：回环地址与 [`client_builder`] 的约定保持一致，
/// 并补上 Node 自己那套匹配规则认得的形式（见 [`merge_no_proxy`]）。
const CHILD_NO_PROXY: &str =
    "localhost,.localhost,127.0.0.1,127.0.0.0/8,::1,[::1],127.0.0.1-127.255.255.255";

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn read_headers(stream: &mut tokio::net::TcpStream) -> String {
        let mut bytes = Vec::new();
        while !bytes.ends_with(b"\r\n\r\n") {
            assert!(bytes.len() < 4096);
            bytes.push(stream.read_u8().await.unwrap());
        }
        String::from_utf8(bytes).unwrap()
    }

    #[test]
    fn accepts_supported_proxy_schemes_and_empty_inheritance() {
        for value in [
            "http://localhost:7897",
            "https://proxy.example:8443",
            "socks5://127.0.0.1:1080",
            "socks5h://[::1]:1080",
            "http://user:secret@proxy.example:8080",
        ] {
            assert!(normalize_proxy_url(value).is_ok(), "{value}");
        }
        assert_eq!(normalize_proxy_url("  ").unwrap(), "");
        assert_eq!(
            normalize_proxy_url(" http://localhost:7897 ").unwrap(),
            "http://localhost:7897/"
        );
    }

    #[test]
    fn rejects_invalid_proxy_addresses_without_echoing_credentials() {
        for value in [
            "localhost:7897",
            "http:proxy.example",
            "ftp://proxy.example",
            "http://",
            "http://proxy.example:0",
            "http://proxy.example:65536",
            "http://proxy.example/path",
            "http://proxy.example?q=1",
            "http://proxy.example#fragment",
            "http://user:secret@proxy.example/path",
            "http://proxy. example",
        ] {
            let error = normalize_proxy_url(value).unwrap_err();
            assert!(error.starts_with("PROXY_INVALID:"));
            assert!(!error.contains("secret"));
        }
    }

    #[tokio::test]
    async fn external_http_request_reaches_the_configured_proxy() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let proxy = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request = read_headers(&mut stream).await;
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nproxied",
                )
                .await
                .unwrap();
            request
        });
        let client = client_builder(&format!("http://{address}"))
            .unwrap()
            .timeout(std::time::Duration::from_secs(3))
            .build()
            .unwrap();
        let response = client
            .get("http://dsh-proxy-test.invalid/resource")
            .send()
            .await
            .unwrap();
        assert_eq!(response.text().await.unwrap(), "proxied");
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(3), proxy)
                .await
                .unwrap()
                .unwrap()
                .starts_with("GET http://dsh-proxy-test.invalid/resource HTTP/1.1\r\n")
        );
    }

    #[tokio::test]
    async fn loopback_request_bypasses_an_unreachable_explicit_proxy() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_headers(&mut stream).await;
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\ndirect",
                )
                .await
                .unwrap();
        });
        let client = client_builder("http://127.0.0.1:1")
            .unwrap()
            .timeout(std::time::Duration::from_secs(3))
            .build()
            .unwrap();
        let response = client
            .get(format!("http://{address}/health"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.text().await.unwrap(), "direct");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn https_request_uses_connect_with_proxy_authentication() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let proxy = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request = read_headers(&mut stream).await;
            stream
                .write_all(
                    b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
            request
        });
        let client = client_builder(&format!("http://user:secret@{address}"))
            .unwrap()
            .timeout(std::time::Duration::from_secs(3))
            .build()
            .unwrap();
        assert!(client
            .get("https://dsh-proxy-test.invalid/resource")
            .send()
            .await
            .is_err());
        let request = tokio::time::timeout(std::time::Duration::from_secs(3), proxy)
            .await
            .unwrap()
            .unwrap();
        assert!(request.starts_with("CONNECT dsh-proxy-test.invalid:443 HTTP/1.1\r\n"));
        assert!(request
            .to_ascii_lowercase()
            .contains("proxy-authorization: basic dxnlcjpzzwnyzxq=\r\n"));
    }

    #[test]
    fn node_system_ca_flag_is_only_offered_to_runtimes_that_know_it() {
        for (version, supported) in [
            ("22.15.0", true),
            ("22.19.0", true),
            ("22.14.9", false),
            ("23.5.0", true),
            ("23.4.0", false),
            ("24.21.0", true),
            ("v24.21.0", true),
            ("20.11.0", false),
            ("garbage", false),
            ("24", false),
        ] {
            assert_eq!(node_supports_system_ca(version), supported, "{version}");
        }
    }

    #[test]
    fn node_options_add_the_system_ca_flag_once() {
        assert_eq!(node_options_with_system_ca(""), "--use-system-ca");
        assert_eq!(
            node_options_with_system_ca("--require ./hook.js"),
            "--require ./hook.js --use-system-ca"
        );
        assert_eq!(
            node_options_with_system_ca("--use-system-ca --require ./hook.js"),
            "--use-system-ca --require ./hook.js"
        );
    }

    #[test]
    fn proxy_child_env_exports_policy_names_for_usable_urls_only() {
        assert!(proxy_child_env("").is_empty());
        assert!(proxy_child_env("   ").is_empty());
        assert!(proxy_child_env("socks4://127.0.0.1:1080").is_empty());
        assert!(proxy_child_env("http://127.0.0.1:7897/path").is_empty());

        let envs = proxy_child_env(" http://user:secret@127.0.0.1:7897 ");
        let mut keys = envs.keys().cloned().collect::<Vec<_>>();
        keys.sort();
        assert_eq!(keys, vec!["http_proxy", "https_proxy", "no_proxy"]);
        assert_eq!(envs["http_proxy"], "http://user:secret@127.0.0.1:7897/");
        assert_eq!(envs["https_proxy"], envs["http_proxy"]);
    }

    #[test]
    fn proxy_child_env_bypasses_loopback_with_bare_hosts() {
        let envs = proxy_child_env("socks5h://127.0.0.1:1080");
        assert!(envs["http_proxy"].starts_with("socks5h://127.0.0.1:1080"));
        let entries = envs["no_proxy"].split(',').collect::<Vec<_>>();
        for entry in [
            "localhost",
            ".localhost",
            "127.0.0.1",
            "127.0.0.0/8",
            "::1",
            "[::1]",
        ] {
            assert!(entries.contains(&entry), "missing {entry}");
        }
        assert!(!envs.contains_key("all_proxy"));
        assert!(!envs.contains_key("NODE_USE_ENV_PROXY"));
    }

    #[test]
    fn inherited_proxy_startup_preserves_remote_routes_and_bypasses_loopback() {
        for mode in ["absent", "proxy"] {
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command.args([
                "--exact",
                "config::proxy::tests::inherited_proxy_startup_child",
                "--nocapture",
            ]);
            for key in [
                "http_proxy",
                "HTTP_PROXY",
                "https_proxy",
                "HTTPS_PROXY",
                "all_proxy",
                "ALL_PROXY",
                "no_proxy",
                "NO_PROXY",
            ] {
                command.env_remove(key);
            }
            command.env("DSH_TEST_INHERITED_PROXY", mode);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            let output = command.output().unwrap();
            assert!(
                output.status.success(),
                "{mode}: {}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(String::from_utf8_lossy(&output.stdout).contains("INHERITED_PROXY_VERIFIED"));
        }
    }

    #[tokio::test]
    async fn inherited_proxy_startup_child() {
        let Ok(mode) = std::env::var("DSH_TEST_INHERITED_PROXY") else {
            return;
        };
        if mode == "absent" {
            prepare_inherited_proxy();
            assert!(std::env::var_os("no_proxy").is_none());
            assert!(std::env::var_os("NO_PROXY").is_none());
            println!("INHERITED_PROXY_VERIFIED");
            return;
        }
        let direct = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = direct.local_addr().unwrap();
        let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_url = format!("http://{}", proxy.local_addr().unwrap());
        unsafe { std::env::set_var("http_proxy", &proxy_url); }
        unsafe { std::env::set_var("https_proxy", &proxy_url); }
        unsafe { std::env::set_var("no_proxy", "corp.example"); }
        let recording_proxy = tokio::spawn(async move {
            let mut requests = Vec::new();
            for _ in 0..4 {
                let (mut stream, _) = proxy.accept().await.unwrap();
                requests.push(read_headers(&mut stream).await);
                stream.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
            }
            requests
        });
        let local_server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut stream, _) = direct.accept().await.unwrap();
                let request = read_headers(&mut stream).await;
                if request.starts_with("GET /ws ") {
                    assert!(request
                        .to_ascii_lowercase()
                        .contains("upgrade: websocket\r\n"));
                    stream.write_all(b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n").await.unwrap();
                    let mut ping = [0; 6];
                    stream.read_exact(&mut ping).await.unwrap();
                    assert_eq!(ping, [0x89, 0x80, 1, 2, 3, 4]);
                    stream.write_all(&[0x8a, 0]).await.unwrap();
                } else {
                    assert!(request.starts_with("GET /health "));
                    stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\ndirect").await.unwrap();
                }
            }
        });
        let client = || {
            reqwest::Client::builder()
                .timeout(Duration::from_secs(3))
                .build()
                .unwrap()
        };
        let websocket = |client: &reqwest::Client| {
            client
                .get(format!("http://{address}/ws"))
                .header("Connection", "Upgrade")
                .header("Upgrade", "websocket")
                .header("Sec-WebSocket-Version", "13")
                .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
        };
        let before = client();
        assert_eq!(
            before
                .get(format!("http://{address}/health"))
                .send()
                .await
                .unwrap()
                .status(),
            502
        );
        assert_eq!(websocket(&before).send().await.unwrap().status(), 502);
        prepare_inherited_proxy();
        assert_eq!(std::env::var("http_proxy").unwrap(), proxy_url);
        assert_eq!(std::env::var("https_proxy").unwrap(), proxy_url);
        for key in ["no_proxy", "NO_PROXY"] {
            assert!(std::env::var(key)
                .unwrap()
                .split(',')
                .any(|entry| entry == "corp.example"));
        }
        let after = client();
        assert_eq!(
            after
                .get(format!("http://{address}/health"))
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            "direct"
        );
        let response = websocket(&after).send().await.unwrap();
        assert_eq!(
            response.status(),
            101,
            "loopback WebSocket handshake must bypass the inherited proxy"
        );
        let mut socket = response.upgrade().await.unwrap();
        socket.write_all(&[0x89, 0x80, 1, 2, 3, 4]).await.unwrap();
        let mut pong = [0; 2];
        tokio::time::timeout(Duration::from_secs(3), socket.read_exact(&mut pong))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(pong, [0x8a, 0]);
        assert_eq!(
            after
                .get("http://dsh-proxy-test.invalid/remote")
                .send()
                .await
                .unwrap()
                .status(),
            502
        );
        assert!(after
            .get("https://dsh-proxy-test.invalid/remote")
            .send()
            .await
            .is_err());
        let requests = tokio::time::timeout(Duration::from_secs(3), recording_proxy)
            .await
            .unwrap()
            .unwrap();
        assert!(requests[0].starts_with(&format!("GET http://{address}/health HTTP/1.1\r\n")));
        assert!(requests[1].starts_with(&format!("GET http://{address}/ws HTTP/1.1\r\n")));
        assert!(requests[2].starts_with("GET http://dsh-proxy-test.invalid/remote HTTP/1.1\r\n"));
        assert!(requests[3].starts_with("CONNECT dsh-proxy-test.invalid:443 HTTP/1.1\r\n"));
        tokio::time::timeout(Duration::from_secs(3), local_server)
            .await
            .unwrap()
            .unwrap();
        println!("INHERITED_PROXY_VERIFIED");
    }

    #[test]
    fn merge_no_proxy_appends_inherited_entries_without_duplicates() {
        assert_eq!(merge_no_proxy(""), CHILD_NO_PROXY);

        let merged = merge_no_proxy(" .corp.example ,localhost,, 10.0.0.0/8 ");
        let entries = merged.split(',').collect::<Vec<_>>();
        assert!(entries.contains(&".corp.example"));
        assert!(entries.contains(&"10.0.0.0/8"));
        assert_eq!(
            entries
                .iter()
                .filter(|entry| **entry == "localhost")
                .count(),
            1
        );
        assert!(entries.contains(&"127.0.0.1-127.255.255.255"));
        assert!(!entries.contains(&""));
    }

    #[tokio::test]
    async fn socks5h_resolves_the_destination_at_the_proxy() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let proxy = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            assert_eq!(stream.read_u8().await.unwrap(), 5);
            let count = stream.read_u8().await.unwrap();
            let mut methods = vec![0; count as usize];
            stream.read_exact(&mut methods).await.unwrap();
            assert!(methods.contains(&0));
            stream.write_all(&[5, 0]).await.unwrap();
            let mut command = [0; 4];
            stream.read_exact(&mut command).await.unwrap();
            assert_eq!(command, [5, 1, 0, 3]);
            let length = stream.read_u8().await.unwrap();
            let mut host = vec![0; length as usize];
            stream.read_exact(&mut host).await.unwrap();
            assert_eq!(host, b"dsh-proxy-test.invalid");
            assert_eq!(stream.read_u16().await.unwrap(), 80);
            stream
                .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 80])
                .await
                .unwrap();
            let request = read_headers(&mut stream).await;
            assert!(request.starts_with("GET /resource HTTP/1.1\r\n"));
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nproxied",
                )
                .await
                .unwrap();
        });
        let client = client_builder(&format!("socks5h://{address}"))
            .unwrap()
            .timeout(std::time::Duration::from_secs(3))
            .build()
            .unwrap();
        let response = client
            .get("http://dsh-proxy-test.invalid/resource")
            .send()
            .await
            .unwrap();
        assert_eq!(response.text().await.unwrap(), "proxied");
        tokio::time::timeout(std::time::Duration::from_secs(3), proxy)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn test_reports_success_through_the_configured_proxy() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let proxy = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request = read_headers(&mut stream).await;
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .await
                .unwrap();
            request
        });
        let result = test(
            &format!("http://{address}"),
            "http://dsh-proxy-test.invalid/releases.atom",
            std::time::Duration::from_secs(3),
        )
        .await;
        assert!(result.ok);
        assert_eq!(result.reason, None);
        assert_eq!(result.status, Some(200));
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(3), proxy)
                .await
                .unwrap()
                .unwrap()
                .starts_with("GET http://dsh-proxy-test.invalid/releases.atom HTTP/1.1\r\n")
        );
    }

    #[tokio::test]
    async fn test_reports_connect_failure_for_an_unreachable_proxy() {
        let result = test(
            "http://127.0.0.1:1",
            "http://dsh-proxy-test.invalid/releases.atom",
            std::time::Duration::from_secs(3),
        )
        .await;
        assert!(!result.ok);
        assert_eq!(result.reason.as_deref(), Some("connect"));
        assert_eq!(result.status, None);
    }

    #[tokio::test]
    async fn test_reports_timeout_when_the_proxy_never_answers() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let stalled = tokio::spawn(async move {
            let (_stream, _) = listener.accept().await.unwrap();
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        });
        let result = test(
            &format!("http://{address}"),
            "http://dsh-proxy-test.invalid/releases.atom",
            std::time::Duration::from_millis(500),
        )
        .await;
        assert!(!result.ok);
        assert_eq!(result.reason.as_deref(), Some("timeout"));
        stalled.abort();
    }

    #[tokio::test]
    async fn test_reports_unexpected_status_from_the_target() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let proxy = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_headers(&mut stream).await;
            stream
                .write_all(
                    b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
        });
        let result = test(
            &format!("http://{address}"),
            "http://dsh-proxy-test.invalid/releases.atom",
            std::time::Duration::from_secs(3),
        )
        .await;
        assert!(!result.ok);
        assert_eq!(result.reason.as_deref(), Some("status"));
        assert_eq!(result.status, Some(403));
        tokio::time::timeout(std::time::Duration::from_secs(3), proxy)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn test_reports_invalid_proxy_addresses_without_echoing_credentials() {
        let result = test(
            "http://user:secret@proxy.example/path",
            "http://dsh-proxy-test.invalid/releases.atom",
            std::time::Duration::from_secs(3),
        )
        .await;
        assert!(!result.ok);
        assert_eq!(result.reason.as_deref(), Some("invalid"));
        assert!(!format!("{result:?}").contains("secret"));
    }

    #[tokio::test]
    async fn test_treats_an_empty_proxy_as_a_direct_connection() {
        // 空代理 = 直连，目标必须走回环，否则会撞上运营商的 NXDOMAIN 劫持页面。
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let result = test(
            "",
            &format!("http://{address}/releases.atom"),
            std::time::Duration::from_secs(3),
        )
        .await;
        assert!(!result.ok, "{result:?}");
        assert!(
            matches!(
                result.reason.as_deref(),
                Some("connect" | "timeout" | "request")
            ),
            "{result:?}"
        );
    }
}
