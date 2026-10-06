use reqwest::{ClientBuilder, NoProxy, Proxy, Url};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Runtime};

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
        return ProxyTestResult { ok: true, reason: None, status: Some(status), latency_ms };
    }
    log::warn!("PROXY_TEST: unexpected status {status}");
    ProxyTestResult { ok: false, reason: Some("status".to_string()), status: Some(status), latency_ms }
}

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
                .write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
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
            matches!(result.reason.as_deref(), Some("connect" | "timeout" | "request")),
            "{result:?}"
        );
    }
}
