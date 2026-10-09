use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Manager};

fn remote_method(method: &str) -> Result<(reqwest::Method, &str), String> {
    if !matches!(
        method,
        "GET /api/tauri/ssh/machines"
            | "POST /api/tauri/ssh/machines"
            | "DELETE /api/tauri/ssh/machines"
            | "POST /api/tauri/ssh/machines/connect"
            | "POST /api/tauri/ssh/machines/disconnect"
            | "GET /api/tauri/ssh/machines/events"
            | "POST /api/tauri/ssh/machines/install"
            | "POST /api/tauri/ssh/machines/test"
            | "GET /api/tauri/ssh/session/role"
            | "GET /api/tauri/ssh/settings"
            | "POST /api/tauri/ssh/settings"
            | "POST /api/tauri/ssh/sync/apply"
            | "GET /api/tauri/ssh/sync/preview"
    ) {
        return Err(format!("REMOTE_METHOD_INVALID: {method}"));
    }
    let (verb, path) = method
        .split_once(' ')
        .ok_or_else(|| format!("REMOTE_METHOD_INVALID: {method}"))?;
    let verb = verb
        .parse()
        .map_err(|_| format!("REMOTE_METHOD_INVALID: {method}"))?;
    Ok((verb, path))
}

async fn remote_request(
    port: u16,
    method: reqwest::Method,
    path: &str,
    payload: Option<Value>,
) -> Result<Value, String> {
    let is_get = method == reqwest::Method::GET;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(if is_get { 10 } else { 600 }))
        .build()
        .map_err(|error| format!("REMOTE_REQUEST_FAILED: {error}"))?;
    let mut request = client.request(
        method,
        format!("{}{path}", crate::config::get_dsh_service_url(port)),
    );
    if let Some(payload) = payload.filter(|value| !value.is_null()) {
        if is_get {
            let params = payload.as_object().ok_or_else(|| {
                "REMOTE_PAYLOAD_INVALID: GET payload must be a query object".to_string()
            })?;
            let mut query = Vec::new();
            for (key, value) in params {
                let value = match value {
                    Value::Null => continue,
                    Value::String(value) => value.clone(),
                    Value::Bool(_) | Value::Number(_) => value.to_string(),
                    _ => {
                        return Err(format!(
                            "REMOTE_PAYLOAD_INVALID: query parameter {key} must be primitive"
                        ));
                    }
                };
                query.push((key, value));
            }
            request = request.query(&query);
        } else {
            request = request.json(&payload);
        }
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("REMOTE_REQUEST_FAILED: {error}"))?;
    let status = response.status();
    if matches!(status.as_u16(), 404 | 405) {
        return Err(format!("REMOTE_API_MISSING: {}", status.as_u16()));
    }
    let body = response
        .bytes()
        .await
        .map_err(|error| format!("REMOTE_REQUEST_FAILED: {error}"))?;
    let value: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    if !status.is_success() {
        let message = value
            .get("error")
            .and_then(Value::as_str)
            .or_else(|| value.get("message").and_then(Value::as_str))
            .map(str::to_string)
            .unwrap_or_else(|| format!("HTTP {}", status.as_u16()));
        return Err(format!("REMOTE_REQUEST_FAILED: {message}"));
    }
    Ok(value)
}

#[tauri::command]
pub async fn remote(
    app_handle: AppHandle,
    method: String,
    payload: Option<Value>,
) -> Result<Value, String> {
    let (method, path) = remote_method(&method)?;
    let port = crate::config::get_store_dat_setting(&app_handle).port;
    remote_request(port, method, path, payload).await
}

/// 弹窗窗口 label 前缀（与 capability 的 `remote-*` glob 对应）。
const REMOTE_WINDOW_LABEL_PREFIX: &str = "remote-";

/// 窗口 label 里仅允许的字符（Tauri label 字符集：字母数字与 `- _ / :`），
/// 其余字符一律折叠为 `-`，避免任意 machineId 注入非法 label。
fn sanitize_label_part(raw: &str) -> String {
    raw.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '/' | ':') {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// 校验隧道 URL：仅接受 `127.0.0.1` host 的明文 http（隧道由引擎建在
/// `127.0.0.1:<port>`，见插件 `SshLink`；与 capability `remote.urls`
/// `http://127.0.0.1:*` 精确对齐——`localhost`/`[::1]` 过守卫却命不中
/// capability，弹窗会静默退化为无 IPC 的纯 web，故在命令侧一并拒绝）。
fn validate_loopback_http_url(raw: &str) -> Result<tauri::Url, String> {
    let url: tauri::Url = raw
        .parse()
        .map_err(|err| format!("REMOTE_URL_INVALID: {err}"))?;
    if url.scheme() != "http" {
        return Err(format!(
            "REMOTE_URL_INVALID: scheme must be http, got {:?}",
            url.scheme()
        ));
    }
    if url.host_str() != Some("127.0.0.1") {
        return Err(format!(
            "REMOTE_URL_INVALID: only http://127.0.0.1:<port> tunnel URLs are allowed, got {:?}",
            url.host_str()
        ));
    }
    Ok(url)
}

/// 桥探测命令：iframe 内插件据此判定处于桌面壳（无参、恒成功）。
#[tauri::command]
pub fn remote_bridge_ping() -> String {
    "ok".to_string()
}

/// 校验弹窗入参并生成 (label, url)；抽成纯函数便于单测。`url` 允许为空
/// ——未连接机器也可先开窗（窗口内壳层会发起标准连接流程），仅在非空时
/// 做回环校验。
fn open_window_args(machine_id: &str, url: &str) -> Result<(String, Option<tauri::Url>), String> {
    if machine_id.trim().is_empty() {
        return Err("REMOTE_WINDOW_FAILED: machineId must not be empty".to_string());
    }
    let parsed_url = if url.trim().is_empty() {
        None
    } else {
        Some(validate_loopback_http_url(url)?)
    };
    let label = format!(
        "{}{}",
        REMOTE_WINDOW_LABEL_PREFIX,
        sanitize_label_part(machine_id)
    );
    Ok((label, parsed_url))
}

/// 打开（已开则聚焦）`remote-<machineId>` 弹窗窗口，加载壳层应用。
///
/// 壳不自存机器状态：前端按窗口 label 自解析目标机器并切换（机器状态经
/// `/api/tauri/ssh/machines` 轮询获取）；`url` 只做回环校验。重复调用聚焦已有窗口（不
/// 重复建窗）；失败返回带前缀的可读错误，由调用方（S4 面板按钮）呈现。
#[tauri::command]
pub fn remote_open_window(
    app_handle: AppHandle,
    machine_id: String,
    url: String,
) -> Result<(), String> {
    let (label, _validated_url) = open_window_args(&machine_id, &url)?;
    // 已有窗口：聚焦即可（再次「打开」同一机器的语义）。
    if let Some(existing) = app_handle.get_webview_window(&label) {
        let _ = existing.set_focus();
        return Ok(());
    }
    // 建窗 chrome 全部取壳层建窗真值（`build_shell_window`）：52px 导航栏交通灯、
    // 桥脚本按窗口注入、（Windows）WebView2 共用数据目录等，远端窗口与本体
    // 唯一区别是连接的后端。label 即机器寻址：前端 remote-<id> 自切换。
    let title = format!("DSH Remote · {machine_id}");
    crate::desktop::builder::build_shell_window(&app_handle, label, &title)
        .map(|_| ())
        .map_err(|err| format!("REMOTE_WINDOW_FAILED: {err}"))
}

#[cfg(test)]
mod tests {
    use super::{remote_method, remote_request, sanitize_label_part, validate_loopback_http_url};
    use serde_json::{json, Value};
    use std::time::Duration;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

    async fn response_server(
        status: &str,
        headers: &str,
        body: &str,
    ) -> (u16, tokio::task::JoinHandle<(String, Vec<u8>)>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
            body.len()
        );
        let server = tokio::spawn(async move {
            tokio::time::timeout(Duration::from_secs(3), async move {
                let (socket, _) = listener.accept().await.unwrap();
                let mut socket = BufReader::new(socket);
                let mut headers = String::new();
                let mut length = 0;
                loop {
                    let mut line = String::new();
                    assert_ne!(socket.read_line(&mut line).await.unwrap(), 0);
                    if line == "\r\n" {
                        break;
                    }
                    if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = value.trim().parse().unwrap();
                    }
                    headers.push_str(&line);
                }
                let mut body = vec![0; length];
                socket.read_exact(&mut body).await.unwrap();
                socket
                    .get_mut()
                    .write_all(response.as_bytes())
                    .await
                    .unwrap();
                (headers, body)
            })
            .await
            .expect("isolated loopback server must finish within three seconds")
        });
        (port, server)
    }

    #[test]
    fn remote_whitelist_accepts_all_thirteen_generated_endpoints() {
        for method in [
            "GET /api/tauri/ssh/machines",
            "POST /api/tauri/ssh/machines",
            "DELETE /api/tauri/ssh/machines",
            "POST /api/tauri/ssh/machines/connect",
            "POST /api/tauri/ssh/machines/disconnect",
            "GET /api/tauri/ssh/machines/events",
            "POST /api/tauri/ssh/machines/install",
            "POST /api/tauri/ssh/machines/test",
            "GET /api/tauri/ssh/session/role",
            "GET /api/tauri/ssh/settings",
            "POST /api/tauri/ssh/settings",
            "POST /api/tauri/ssh/sync/apply",
            "GET /api/tauri/ssh/sync/preview",
        ] {
            let (verb, path) = remote_method(method).expect("generated endpoint must be allowed");
            assert_eq!(format!("{verb} {path}"), method);
        }
    }

    #[test]
    fn remote_whitelist_rejects_unknown_verbs_paths_and_urls() {
        for method in [
            "",
            "GET",
            "get /api/tauri/ssh/machines",
            "PUT /api/tauri/ssh/machines",
            "GET /api/tauri/ssh/machines/connect",
            "POST /api/tauri/ssh/machines/events",
            "GET /api/tauri/ssh/machines?machineId=m1",
            "GET /api/tauri/ssh/machines/../settings",
            "GET /api/tauri/ssh/machines/",
            "GET  /api/tauri/ssh/machines",
            "GET /api/tauri/ssh/machines\n",
            "GET http://127.0.0.1:3080/api/tauri/ssh/machines",
            "GET https://example.com/api/tauri/ssh/machines",
            "GET //example.com/api/tauri/ssh/machines",
            "GET /api/other",
        ] {
            assert_eq!(
                remote_method(method).unwrap_err(),
                format!("REMOTE_METHOD_INVALID: {method}")
            );
        }
    }

    #[tokio::test]
    async fn remote_get_forwards_encoded_primitive_query_without_body() {
        let (port, server) = response_server("200 OK", "", r#"{"events":[]}"#).await;
        let (verb, path) = remote_method("GET /api/tauri/ssh/machines/events").unwrap();
        let result = remote_request(
            port,
            verb,
            path,
            Some(json!({"machineId": "m /&?中", "sinceSeq": 42, "flag": false, "absent": null})),
        )
        .await;
        let (headers, body) = server.await.unwrap();
        assert_eq!(result.unwrap(), json!({"events": []}));
        let target = headers
            .lines()
            .next()
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap();
        let url = tauri::Url::parse(&format!("http://127.0.0.1{target}")).unwrap();
        assert_eq!(url.path(), "/api/tauri/ssh/machines/events");
        let query: std::collections::BTreeMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(
            query,
            std::collections::BTreeMap::from([
                ("machineId".to_string(), "m /&?中".to_string()),
                ("sinceSeq".to_string(), "42".to_string()),
                ("flag".to_string(), "false".to_string()),
            ])
        );
        assert!(body.is_empty());
    }

    #[tokio::test]
    async fn remote_mutations_forward_json_body_and_preserve_http_verb() {
        for method in [
            "POST /api/tauri/ssh/machines/connect",
            "DELETE /api/tauri/ssh/machines",
        ] {
            let (port, server) = response_server("200 OK", "", r#"{"ok":true}"#).await;
            let (verb, path) = remote_method(method).unwrap();
            let result = remote_request(port, verb, path, Some(json!({"machineId": "m1"}))).await;
            let (headers, body) = server.await.unwrap();
            assert_eq!(result.unwrap(), json!({"ok": true}));
            assert_eq!(
                headers.lines().next().unwrap(),
                format!("{method} HTTP/1.1")
            );
            assert!(headers
                .to_ascii_lowercase()
                .contains("content-type: application/json\r\n"));
            assert_eq!(
                serde_json::from_slice::<Value>(&body).unwrap(),
                json!({"machineId": "m1"})
            );
        }
    }

    #[tokio::test]
    async fn remote_absent_or_null_payload_sends_no_query_or_body() {
        for method in [
            "GET /api/tauri/ssh/machines",
            "POST /api/tauri/ssh/machines/install",
        ] {
            for payload in [None, Some(Value::Null)] {
                let (port, server) = response_server("200 OK", "", "null").await;
                let (verb, path) = remote_method(method).unwrap();
                let result = remote_request(port, verb, path, payload).await;
                let (headers, body) = server.await.unwrap();
                assert_eq!(result.unwrap(), Value::Null);
                assert_eq!(
                    headers.lines().next().unwrap(),
                    format!("{method} HTTP/1.1")
                );
                assert!(body.is_empty());
            }
        }
    }

    #[tokio::test]
    async fn remote_success_tolerates_empty_or_non_json_body() {
        for (status, body) in [
            ("204 No Content", ""),
            ("200 OK", ""),
            ("201 Created", "not JSON"),
        ] {
            let (port, server) = response_server(status, "", body).await;
            let (verb, path) = remote_method("POST /api/tauri/ssh/settings").unwrap();
            let result = remote_request(port, verb, path, None).await;
            server.await.unwrap();
            assert_eq!(result.unwrap(), Value::Null);
        }
    }

    #[tokio::test]
    async fn remote_missing_api_is_distinct_from_other_http_failures() {
        for (status, expected) in [("404 Not Found", "404"), ("405 Method Not Allowed", "405")] {
            let (port, server) = response_server(status, "", r#"{"error":"disabled"}"#).await;
            let (verb, path) = remote_method("GET /api/tauri/ssh/settings").unwrap();
            let result = remote_request(port, verb, path, None).await;
            server.await.unwrap();
            assert_eq!(
                result.unwrap_err(),
                format!("REMOTE_API_MISSING: {expected}")
            );
        }
    }

    #[tokio::test]
    async fn remote_http_failures_keep_server_error_message_or_status() {
        for (body, expected) in [
            (
                r#"{"error":"SSH refused","message":"ignored"}"#,
                "SSH refused",
            ),
            (r#"{"message":"bootstrap failed"}"#, "bootstrap failed"),
            ("not JSON", "HTTP 500"),
            ("", "HTTP 500"),
        ] {
            let (port, server) = response_server("500 Internal Server Error", "", body).await;
            let (verb, path) = remote_method("POST /api/tauri/ssh/machines/test").unwrap();
            let result = remote_request(port, verb, path, None).await;
            server.await.unwrap();
            assert_eq!(
                result.unwrap_err(),
                format!("REMOTE_REQUEST_FAILED: {expected}")
            );
        }
    }

    #[tokio::test]
    async fn remote_unreachable_service_is_not_reported_as_missing_api() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let (verb, path) = remote_method("GET /api/tauri/ssh/machines").unwrap();
        let error = remote_request(port, verb, path, None).await.unwrap_err();
        assert!(
            error.starts_with("REMOTE_REQUEST_FAILED:"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn remote_redirects_are_rejected_without_contacting_target() {
        let target = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        target.set_nonblocking(true).unwrap();
        for location in [
            format!("http://{}/outside", target.local_addr().unwrap()),
            "https://example.invalid/outside".to_string(),
        ] {
            let (port, server) =
                response_server("302 Found", &format!("Location: {location}\r\n"), "").await;
            let (verb, path) = remote_method("GET /api/tauri/ssh/machines").unwrap();
            let result = remote_request(port, verb, path, None).await;
            server.await.unwrap();
            assert_eq!(result.unwrap_err(), "REMOTE_REQUEST_FAILED: HTTP 302");
        }
        assert_eq!(
            target.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[tokio::test]
    async fn remote_invalid_get_payload_is_rejected_before_connecting() {
        let (verb, path) = remote_method("GET /api/tauri/ssh/machines/events").unwrap();
        for payload in [json!([]), json!({"machineId": {"nested": true}})] {
            let error = remote_request(0, verb.clone(), path, Some(payload))
                .await
                .unwrap_err();
            assert!(
                error.starts_with("REMOTE_PAYLOAD_INVALID:"),
                "unexpected error: {error}"
            );
        }
    }

    #[test]
    fn label_part_keeps_tauri_charset_and_folds_the_rest() {
        assert_eq!(sanitize_label_part("abc-123"), "abc-123");
        assert_eq!(sanitize_label_part("a_b/c:d"), "a_b/c:d");
        // 空格、点、@ 等非法字符折叠为 '-'，防止注入越权 label
        assert_eq!(sanitize_label_part("a b.c@d"), "a-b-c-d");
        assert_eq!(sanitize_label_part("机器"), "--");
    }

    #[test]
    fn loopback_http_urls_pass_validation() {
        for raw in ["http://127.0.0.1:3080", "http://127.0.0.1:49152/"] {
            let url = validate_loopback_http_url(raw)
                .unwrap_or_else(|err| panic!("{raw} should pass: {err}"));
            assert_eq!(url.scheme(), "http");
        }
    }

    #[test]
    fn non_loopback_or_non_http_urls_are_rejected() {
        for raw in [
            "https://127.0.0.1:3080",  // https 不允许（隧道是明文回环）
            "http://192.168.1.5:3080", // 非回环
            "http://example.com",      // 公网域名
            "http://localhost:3080",   // 命不中 capability remote.urls，命令侧一并拒绝
            "http://[::1]:3080",       // 同上：与 127.0.0.1 精确对齐
            "file:///etc/passwd",      // 非 http scheme
            "not a url",               // 解析失败
            "",                        // 空
        ] {
            let err = validate_loopback_http_url(raw)
                .err()
                .unwrap_or_else(|| panic!("{raw:?} should be rejected"));
            assert!(
                err.starts_with("REMOTE_URL_INVALID:"),
                "error should carry the protocol prefix: {err}"
            );
        }
    }

    #[test]
    fn empty_machine_id_is_rejected_before_url_validation() {
        // 空白 machineId 直接拒绝（label 无法生成），错误前缀与窗口失败族一致
        let err = super::open_window_args("  ", "http://127.0.0.1:3080")
            .err()
            .expect("blank machineId should be rejected");
        assert!(err.starts_with("REMOTE_WINDOW_FAILED:"));
    }
}
