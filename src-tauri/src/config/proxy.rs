use std::collections::HashMap;

use reqwest::{ClientBuilder, NoProxy, Proxy, Url};
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

/// 子进程代理环境（issue #110）：把配置页的代理地址翻译成核心与插件子进程能读的
/// 环境变量。
///
/// 核心（`@deepseek-ai/dsh-http-proxy`）只在启动时读 `http_proxy` / `https_proxy` /
/// `no_proxy` 发布代理策略，并给**它自己** spawn 的子进程补 `NODE_USE_ENV_PROXY`；
/// 桌面端 spawn 的进程不在那条链路上，必须显式下发。
///
/// 只写小写名：核心的读取顺序是小写优先、大写兜底，值相同故不重复写；curl、git、
/// pnpm 同样认小写。`no_proxy` 与 [`client_builder`] 的绕过列表保持一致并补上
/// Node 自己的匹配规则只认的裸回环地址（`127.0.0.1` / `[::1]`，IPv4 段写法 Node
/// 不识别）。空值返回空 map：用户没配代理时不注入任何键，子进程照旧继承系统环境。
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
        ("https_proxy".to_string(), url.clone()),
        ("no_proxy".to_string(), CHILD_NO_PROXY.to_string()),
    ])
}

/// 子进程的代理绕过列表：既有回环约定（见 [`client_builder`]）加上 Node
/// `NODE_USE_ENV_PROXY` 匹配 `NO_PROXY` 时要求的裸主机名形式。
const CHILD_NO_PROXY: &str = "localhost,.localhost,127.0.0.1,127.0.0.0/8,::1,[::1]";

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
        for entry in ["localhost", ".localhost", "127.0.0.1", "127.0.0.0/8", "::1", "[::1]"] {
            assert!(entries.contains(&entry), "missing {entry}");
        }
        assert!(!envs.contains_key("all_proxy"));
        assert!(!envs.contains_key("NODE_USE_ENV_PROXY"));
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
}
