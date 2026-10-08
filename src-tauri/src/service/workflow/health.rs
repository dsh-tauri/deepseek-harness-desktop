//! 健康检查（通过 Rust 代理，避免 WebView CORS 问题）。

use std::sync::atomic::Ordering;

use futures_util::StreamExt;

use crate::config;

use super::process::{has_owned_process, LAUNCH_GUARD};
use super::startup;
use super::utils;

/// 客户端 bundle 的并发探测度：足以吃满回环带宽，又不会把刚起来的服务进程
/// 压到无暇响应 WebView 自己的并发加载。
const HEALTH_PROBE_CONCURRENCY: usize = 16;

/// 读取 Harness 首页并解析本次启动实际声明的客户端模块。
async fn client_probe_endpoints(port: u16) -> Result<Vec<String>, String> {
    let client = utils::loopback_http_client(config::HEALTH_CHECK_TIMEOUT)
        .map_err(|e| format!("HARNESS_HEALTH_CLIENT_FAILED: {e}"))?;
    let root = format!("{}/", config::get_dsh_service_url(port));
    let started = std::time::Instant::now();
    let response = client.get(root).send().await.map_err(|e| {
        log::warn!(
            "Harness boot manifest request failed: elapsed_ms={} connect={} timeout={} {e:?}",
            started.elapsed().as_millis(),
            e.is_connect(),
            e.is_timeout(),
        );
        format!(
            "HARNESS_BOOT_MANIFEST_REQUEST_FAILED: connect={} timeout={} {e:?}",
            e.is_connect(),
            e.is_timeout(),
        )
    })?;
    startup::note_http_answer();
    if !response.status().is_success() {
        return Err(format!(
            "HARNESS_NOT_READY: boot page returned {}",
            response.status()
        ));
    }
    let body = response
        .text()
        .await
        .map_err(|e| format!("HARNESS_BOOT_MANIFEST_READ_FAILED: {e}"))?;
    Ok(utils::client_urls_from_boot_html(port, &body)
        .unwrap_or_else(|| utils::health_probe_plugin_urls(port)))
}

/// 无持有进程时应返回给前端的探测信号。
///
/// `launch` 仍在进行（LAUNCH_GUARD 未释放）时，无持有进程是**临时**状态：`launch`
/// 已抢到守卫、尚未把持有进程登记进槽位（spawn 未完成，典型为 auto_start 与前端
/// boot 并发拉起——前端 `launch_harness` 命中“launch already in progress, skipping”
/// 后立刻来探测，此刻 `wait_for_port_release` 可能仍在等待端口回落）。若把这种
/// 临时状态当作 `HARNESS_NOT_OWNED`，前端会命中快速失败分支（`notOwned` → 立即
/// 放弃重试），表现为“首次启动超时、刷新/重试后恢复”。
///
/// 因此 `launch` 仍在进行时返回可重试的“启动中”（`HARNESS_NOT_READY`），让前端
/// 继续轮询；守卫已释放却仍无持有进程，才是真正崩溃/从未拉起（进程随后退出、槽位
/// 被监视线程清空），返回 `HARNESS_NOT_OWNED` 让前端快速失败，避免把“启动即崩溃”
/// 误判成“启动慢”而白白耗完 8 轮重试。
fn not_owned_probe_signal(launch_in_progress: bool) -> &'static str {
    if launch_in_progress {
        "HARNESS_NOT_READY: Harness service is still starting"
    } else {
        "HARNESS_NOT_OWNED: no Harness process is owned by this app"
    }
}

fn all_client_modules_ready(ready: usize, total: usize) -> bool {
    total > 0 && ready == total
}

/// 并发探测全部客户端 bundle，返回（就绪数量，按地址顺序排列的失败明细）。
///
/// 单个 bundle 动辄数百 KB，串行探测在 90 个模块上要 600ms 以上，而这段耗时正好
/// 压在启动尾段的关键路径上：模块就绪后仍要等整轮探测走完才算就绪。
///
/// 结果按入参顺序回填，而不是按完成顺序：失败明细会拼进返回给前端的就绪原因，
/// 前端靠它判断「是否出现新进展」（变化即刷新无活动计时）。顺序随并发抖动的话，
/// 同一组失败每轮都会被当成新进展，把无活动超时一路拖到绝对上限。
async fn probe_client_bundles(
    client: &reqwest::Client,
    endpoints: Vec<String>,
) -> (usize, Vec<String>) {
    let mut outcomes = futures_util::stream::iter(endpoints.into_iter().enumerate())
        .map(|(index, endpoint)| async move {
            let failure = match client.get(&endpoint).send().await {
                Ok(response) => {
                    let status = response.status();
                    let body = response.text().await.unwrap_or_default();
                    if utils::looks_like_plugin_bundle(status.is_success(), &body) {
                        None
                    } else {
                        let failure = format!("{endpoint} returned {status} (not a plugin bundle)");
                        log::debug!("Health check failed: {failure}");
                        Some(failure)
                    }
                }
                Err(err) => {
                    log::debug!("Health check {endpoint}: {err}");
                    Some(format!("{endpoint}: {err}"))
                }
            };
            (index, failure)
        })
        .buffer_unordered(HEALTH_PROBE_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    outcomes.sort_unstable_by_key(|(index, _)| *index);

    let mut ready = 0usize;
    let mut failures = Vec::with_capacity(outcomes.len());
    for (_, failure) in outcomes {
        match failure {
            Some(failure) => failures.push(failure),
            None => ready += 1,
        }
    }
    (ready, failures)
}

/// 健康检查（通过 Rust 代理，避免 WebView CORS 问题）
pub async fn proxy_health_check(port: u16) -> Result<String, String> {
    if !has_owned_process() {
        return Err(not_owned_probe_signal(LAUNCH_GUARD.load(Ordering::SeqCst)).to_string());
    }
    let client = utils::loopback_http_client(config::HEALTH_CHECK_TIMEOUT)
        .map_err(|e| format!("HARNESS_HEALTH_CLIENT_FAILED: {e}"))?;
    let endpoints = client_probe_endpoints(port).await?;
    let total = endpoints.len();
    let (ready, failures) = probe_client_bundles(&client, endpoints).await;
    if all_client_modules_ready(ready, total) {
        startup::note_client_modules_ready(ready, total);
        return Ok(format!("healthy - {ready}/{total} client modules ready"));
    }
    Err(format!(
        "HARNESS_NOT_READY: Harness client modules are not ready ({ready}/{total} ready; {})",
        failures.join("; ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 回归：无持有进程在“launch 仍在进行”（守卫未释放）时应返回可重试的
    /// `HARNESS_NOT_READY`，而不是把临时状态当成崩溃的 `HARNESS_NOT_OWNED` —
    /// 后者会让前端命中快速失败分支，表现为“首次启动超时、刷新/重试后恢复”。
    #[test]
    fn not_owned_is_retryable_during_launch_not_fatal() {
        // launch 仍在进行（守卫未释放）：无持有进程是启动中的临时状态，前端继续轮询
        assert!(not_owned_probe_signal(true).starts_with("HARNESS_NOT_READY"));
        // 启动已结束（守卫释放）却仍无持有进程：进程已退出/从未拉起 → 快速失败
        assert!(not_owned_probe_signal(false).starts_with("HARNESS_NOT_OWNED"));
    }

    #[tokio::test]
    async fn boot_probe_reports_connection_refusal_with_underlying_cause() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let error = client_probe_endpoints(port).await.unwrap_err();
        assert!(
            error.starts_with("HARNESS_BOOT_MANIFEST_REQUEST_FAILED:"),
            "{error}"
        );
        assert!(error.contains("connect=true"), "{error}");
        assert!(!error.contains("elapsed_ms="), "{error}");
        assert!(error.contains("source:"), "{error}");
        assert!(
            error.contains(&format!("http://127.0.0.1:{port}/")),
            "{error}"
        );
        assert_eq!(client_probe_endpoints(port).await.unwrap_err(), error);
    }

    #[tokio::test]
    async fn boot_probe_gives_up_on_closed_port_without_os_connect_timeout() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let started = std::time::Instant::now();
        let error = client_probe_endpoints(port).await.unwrap_err();
        let elapsed = started.elapsed();

        assert!(error.contains("connect=true"), "{error}");
        assert!(
            elapsed < std::time::Duration::from_secs(1),
            "closed-port probe waited {elapsed:?}"
        );
    }

    #[tokio::test]
    async fn boot_probe_distinguishes_response_timeout_from_connection_failure() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (release, mut hold) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            tokio::select! {
                socket = listener.accept() => {
                    let (socket, _) = socket.unwrap();
                    let _ = hold.await;
                    drop(socket);
                }
                _ = &mut hold => {}
            }
        });

        let result = client_probe_endpoints(port).await;
        let _ = release.send(());
        server.await.unwrap();
        let error = result.unwrap_err();
        assert!(
            error.starts_with("HARNESS_BOOT_MANIFEST_REQUEST_FAILED:"),
            "{error}"
        );
        assert!(error.contains("connect=false"), "{error}");
        assert!(error.contains("timeout=true"), "{error}");
        assert!(!error.contains("elapsed_ms="), "{error}");
        assert!(error.contains("source:"), "{error}");
    }

    #[tokio::test]
    async fn boot_probe_preserves_http_response_readiness_contract() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let html = r#"<script>globalThis["__DSH_BOOT__"] = {"entries":[{"url":"plugins/fixture/client.js"}]};</script>"#;
        for status in ["200 OK", "503 Service Unavailable"] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let mut server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                assert!(socket.read(&mut request).await.unwrap() > 0);
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
                    html.len(),
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            });
            let result = client_probe_endpoints(port).await;
            let served = tokio::time::timeout(std::time::Duration::from_secs(1), &mut server).await;
            server.abort();
            served.expect("HTTP fixture did not complete").unwrap();
            if status == "200 OK" {
                assert_eq!(
                    result.unwrap(),
                    vec![format!("http://127.0.0.1:{port}/plugins/fixture/client.js")]
                );
            } else {
                assert_eq!(
                    result.unwrap_err(),
                    "HARNESS_NOT_READY: boot page returned 503 Service Unavailable"
                );
            }
        }
    }

    #[test]
    fn readiness_requires_every_client_module() {
        assert!(!all_client_modules_ready(1, 2));
        assert!(all_client_modules_ready(2, 2));
        assert!(!all_client_modules_ready(0, 0));
    }

    /// 并发探测必须保住失败明细的地址顺序，并且真的在并发。
    ///
    /// 顺序：失败明细会拼进返回给前端的就绪原因，前端靠它判断「是否出现新进展」
    /// （变化即刷新无活动计时）。按完成顺序回填的话，同一组失败每轮都会被当成
    /// 新进展，把无活动超时一路拖到绝对上限。
    /// 并发：串行探测在 90 个模块上要 600ms 以上，这段耗时正好压在启动尾段。
    #[tokio::test]
    async fn client_bundle_probe_keeps_endpoint_order_and_runs_concurrently() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // 完成顺序与端点顺序刻意相反：最慢的是第一个失败，第三个失败先完成。
        // 按完成顺序回填的话失败明细会变成 [2, 0]，只有真按入参顺序排序才得到 [0, 2]。
        let delays = [
            std::time::Duration::from_millis(400),
            std::time::Duration::from_millis(100),
            std::time::Duration::from_millis(150),
        ];
        let serial = delays.iter().sum::<std::time::Duration>();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let paths = [
            "/plugins/slow/client.js",
            "/plugins/ready/client.js",
            "/plugins/markup/client.js",
        ];
        let server = tokio::spawn(async move {
            for _ in 0..paths.len() {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                let read = socket.read(&mut request).await.unwrap();
                let request = String::from_utf8_lossy(&request[..read]).to_string();
                let index = paths
                    .iter()
                    .position(|path| request.contains(*path))
                    .expect("request path is one of the probed endpoints");
                let body = if index == 1 {
                    "export const ready = true;"
                } else {
                    "<!doctype html><html></html>"
                };
                tokio::spawn(async move {
                    tokio::time::sleep(delays[index]).await;
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len(),
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        });

        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let endpoints = paths
            .iter()
            .map(|path| format!("http://127.0.0.1:{port}{path}"))
            .collect::<Vec<_>>();
        let started = std::time::Instant::now();
        let (ready, failures) = probe_client_bundles(&client, endpoints.clone()).await;
        let elapsed = started.elapsed();
        let served = tokio::time::timeout(std::time::Duration::from_secs(10), server).await;
        served
            .expect("bundle fixture did not serve every request")
            .unwrap();

        assert_eq!(ready, 1);
        assert_eq!(
            failures,
            vec![
                format!("{} returned 200 OK (not a plugin bundle)", endpoints[0]),
                format!("{} returned 200 OK (not a plugin bundle)", endpoints[2]),
            ]
        );
        // 串行要跑满三段延迟之和（≥650ms），并发只等最慢的那一段（约 400ms）
        assert!(
            elapsed < serial,
            "probe waited {elapsed:?} for three endpoints"
        );
    }
}
