use tauri::Manager;

pub(super) fn launch_url_in(text: &str, port: u16) -> Option<String> {
    text.lines()
        .filter_map(|line| line.trim().strip_prefix("dsh web: "))
        .filter_map(|value| tauri::Url::parse(value.trim()).ok())
        .find(|url| {
            url.scheme() == "http"
                && url.host_str() == Some("127.0.0.1")
                && url.port() == Some(port)
                && url.path() == "/"
                && url.username().is_empty()
                && url.password().is_none()
                && url.fragment().is_none()
                && url
                    .query_pairs()
                    .any(|(key, value)| key == "token" && !value.is_empty())
        })
        .map(Into::into)
}

pub fn launch_url(port: u16) -> Result<String, String> {
    let instance = super::instances::instance();
    let process = instance
        .process
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if process.is_none() {
        return Err("HARNESS_NOT_OWNED: no Harness process is owned by this app".into());
    }
    let generation = instance
        .launch_url
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let output = generation.lock().unwrap_or_else(|error| error.into_inner());
    output
        .as_ref()
        .filter(|(owned_port, _)| *owned_port == port)
        .map(|(_, url)| url.clone())
        .ok_or_else(|| "HARNESS_NOT_READY: waiting for this Harness process launch URL".into())
}

pub(crate) async fn authenticated_host(
    app: &crate::AppHandle,
    port: u16,
) -> Result<tauri_runtime_electron::AuthenticatedWebHost, String> {
    let instance = super::instances::instance();
    let launch = launch_url(port)?;
    let mut cached = instance.authenticated_host.lock().await;
    if let Some((generation, host)) = cached.as_ref() {
        if generation == &launch {
            return Ok(host.clone());
        }
    }
    let client = app.state::<tauri_runtime_electron::ElectronClient>().inner().clone();
    let host = tauri_runtime_electron::authenticate_web_host(&client, &launch)
        .await
        .map_err(|error| format!("HARNESS_AUTH_FAILED: {error}"))?;
    if launch_url(port)? != launch {
        return Err("HARNESS_AUTH_STALE: launch URL changed during authentication".into());
    }
    *cached = Some((launch, host.clone()));
    Ok(host)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_url_rejects_non_loopback_or_tokenless_output() {
        for line in [
            "dsh web: http://127.0.0.1:3080/",
            "dsh web: http://127.0.0.1:3080/?token=",
            "dsh web: https://127.0.0.1:3080/?token=secret",
            "dsh web: http://example.test:3080/?token=secret",
            "dsh web: http://127.0.0.1:3080/api/?token=secret",
        ] {
            assert_eq!(launch_url_in(line, 3080), None, "{line}");
        }
    }

    #[test]
    fn launch_url_accepts_only_the_official_ready_line_for_the_owned_port() {
        let output = "Starting plugins...\ndsh web: http://127.0.0.1:3081/?token=other-port\ndsh web: http://127.0.0.1:3080/?token=fresh\n";
        assert_eq!(
            launch_url_in(output, 3080).as_deref(),
            Some("http://127.0.0.1:3080/?token=fresh")
        );
        assert_eq!(launch_url_in(output, 3082), None);
        assert_eq!(
            launch_url_in("[info] dsh web: http://127.0.0.1:3080/?token=old", 3080),
            None
        );
    }
}
