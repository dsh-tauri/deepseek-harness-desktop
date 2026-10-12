use std::str::FromStr;

use lettre::message::Mailbox;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::constants::NOTIFY_WEBHOOK_TIMEOUT;

pub const NOTIFY_CHANNEL_OFF: &str = "off";
pub const NOTIFY_CHANNEL_EMAIL: &str = "email";
pub const NOTIFY_CHANNEL_PUSHPLUS: &str = "pushplus";

pub const NOTIFY_SMTP_STARTTLS: &str = "starttls";
pub const NOTIFY_SMTP_TLS: &str = "tls";
pub const NOTIFY_SMTP_PLAIN: &str = "plain";

/// 加密方式对应的默认端口：STARTTLS 587、隐式 TLS 465、明文 25。
pub const NOTIFY_SMTP_DEFAULT_PORT: u16 = 587;

/// pushplus 推送端点；集成测试用本地假服务器替换它，验证真实请求体。
pub const NOTIFY_PUSHPLUS_ENDPOINT: &str = "https://www.pushplus.plus/send";

const NOTIFY_SUBJECT_FALLBACK: &str = "DSH 通知";
const NOTIFY_SUBJECT_MAX_CHARS: usize = 200;
const NOTIFY_TEST_TITLE: &str = "DSH 通知推送测试";
const NOTIFY_TEST_BODY: &str = "这条消息由桌面端设置面板发出，收到即代表配置可用。";

/// 通知 webhook 配置：窗口失焦时把系统通知转发到邮件 / pushplus。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", from = "serde_json::Value")]
pub struct NotifyWebhook {
    pub channel: String,
    pub email: NotifyEmail,
    pub pushplus: NotifyPushplus,
}

/// SMTP 发信配置（`from` / `to` 各一个地址，不做多收件人）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", from = "serde_json::Value")]
pub struct NotifyEmail {
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_security: String,
    pub smtp_username: String,
    pub smtp_password: String,
    pub from: String,
    pub to: String,
}

/// pushplus 配置（只要 token，收件人由 pushplus 账号决定）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", from = "serde_json::Value")]
pub struct NotifyPushplus {
    pub token: String,
}

/// 转发内容：壳层只透传标题 / 正文 / 会话，不解析业务语义。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NotifyWebhookPayload {
    pub title: String,
    pub body: String,
    pub session_id: String,
}

impl Default for NotifyWebhook {
    fn default() -> Self {
        Self {
            channel: NOTIFY_CHANNEL_OFF.into(),
            email: NotifyEmail::default(),
            pushplus: NotifyPushplus::default(),
        }
    }
}

impl Default for NotifyEmail {
    fn default() -> Self {
        Self {
            smtp_host: String::new(),
            smtp_port: NOTIFY_SMTP_DEFAULT_PORT,
            smtp_security: NOTIFY_SMTP_STARTTLS.into(),
            smtp_username: String::new(),
            smtp_password: String::new(),
            from: String::new(),
            to: String::new(),
        }
    }
}

impl Default for NotifyPushplus {
    fn default() -> Self {
        Self {
            token: String::new(),
        }
    }
}

impl From<serde_json::Value> for NotifyWebhook {
    fn from(value: serde_json::Value) -> Self {
        let mut webhook = Self {
            channel: value["channel"]
                .as_str()
                .unwrap_or(NOTIFY_CHANNEL_OFF)
                .to_owned(),
            email: value["email"].clone().into(),
            pushplus: value["pushplus"].clone().into(),
        };
        webhook.normalize();
        webhook
    }
}

impl From<serde_json::Value> for NotifyEmail {
    fn from(value: serde_json::Value) -> Self {
        let mut email = Self {
            smtp_host: value["smtpHost"].as_str().unwrap_or_default().to_owned(),
            smtp_port: value["smtpPort"].as_u64().unwrap_or(0) as u16,
            smtp_security: value["smtpSecurity"]
                .as_str()
                .unwrap_or(NOTIFY_SMTP_STARTTLS)
                .to_owned(),
            smtp_username: value["smtpUsername"].as_str().unwrap_or_default().to_owned(),
            smtp_password: value["smtpPassword"].as_str().unwrap_or_default().to_owned(),
            from: value["from"].as_str().unwrap_or_default().to_owned(),
            to: value["to"].as_str().unwrap_or_default().to_owned(),
        };
        email.normalize();
        email
    }
}

impl From<serde_json::Value> for NotifyPushplus {
    fn from(value: serde_json::Value) -> Self {
        let mut pushplus = Self {
            token: value["token"].as_str().unwrap_or_default().to_owned(),
        };
        pushplus.normalize();
        pushplus
    }
}

impl NotifyWebhook {
    pub fn normalize(&mut self) {
        if !matches!(
            self.channel.as_str(),
            NOTIFY_CHANNEL_OFF | NOTIFY_CHANNEL_EMAIL | NOTIFY_CHANNEL_PUSHPLUS
        ) {
            self.channel = NOTIFY_CHANNEL_OFF.into();
        }
        self.email.normalize();
        self.pushplus.normalize();
    }
}

impl NotifyEmail {
    pub fn normalize(&mut self) {
        if !matches!(
            self.smtp_security.as_str(),
            NOTIFY_SMTP_STARTTLS | NOTIFY_SMTP_TLS | NOTIFY_SMTP_PLAIN
        ) {
            self.smtp_security = NOTIFY_SMTP_STARTTLS.into();
        }
        // 端口 0 不是有效 SMTP 端口：回落到当前加密方式的默认端口，而不是静默连 0。
        if self.smtp_port == 0 {
            self.smtp_port = default_smtp_port(&self.smtp_security);
        }
        self.smtp_host = self.smtp_host.trim().to_owned();
        self.smtp_username = self.smtp_username.trim().to_owned();
        self.from = self.from.trim().to_owned();
        self.to = self.to.trim().to_owned();
    }
}

impl NotifyPushplus {
    pub fn normalize(&mut self) {
        self.token = self.token.trim().to_owned();
    }
}

fn default_smtp_port(security: &str) -> u16 {
    match security {
        NOTIFY_SMTP_TLS => 465,
        NOTIFY_SMTP_PLAIN => 25,
        _ => NOTIFY_SMTP_DEFAULT_PORT,
    }
}

/// 用当前保存的渠道投递一条通知；渠道为「关闭」时什么都不做。
pub async fn dispatch(app_handle: &AppHandle, payload: NotifyWebhookPayload) -> Result<(), String> {
    let setting = super::get_store_dat_setting(app_handle);
    if setting.notify_webhook.channel == NOTIFY_CHANNEL_OFF {
        return Ok(());
    }
    deliver(&setting.notify_webhook, &setting.proxy_url, &payload).await
}

/// 用当前保存的配置发一条真实测试消息，失败只返回固定分类（不含任何凭据）。
pub async fn test(app_handle: &AppHandle) -> Result<(), String> {
    let setting = super::get_store_dat_setting(app_handle);
    let payload = NotifyWebhookPayload {
        title: NOTIFY_TEST_TITLE.to_string(),
        body: NOTIFY_TEST_BODY.to_string(),
        session_id: String::new(),
    };
    deliver(&setting.notify_webhook, &setting.proxy_url, &payload).await
}

async fn deliver(
    webhook: &NotifyWebhook,
    proxy_url: &str,
    payload: &NotifyWebhookPayload,
) -> Result<(), String> {
    match webhook.channel.as_str() {
        NOTIFY_CHANNEL_EMAIL => send_email(&webhook.email, payload).await,
        NOTIFY_CHANNEL_PUSHPLUS => {
            send_pushplus(proxy_url, &webhook.pushplus, payload, NOTIFY_PUSHPLUS_ENDPOINT).await
        }
        _ => Err("NOTIFY_UNCONFIGURED: channel".to_string()),
    }
}

async fn send_email(email: &NotifyEmail, payload: &NotifyWebhookPayload) -> Result<(), String> {
    let from = parse_mailbox(&email.from, "from")?;
    let to = parse_mailbox(&email.to, "to")?;
    let message = Message::builder()
        .from(from)
        .to(to)
        .subject(subject_text(payload))
        .body(body_text(payload))
        .map_err(|_| "NOTIFY_INVALID: message".to_string())?;
    let builder = match email.smtp_security.as_str() {
        NOTIFY_SMTP_TLS => AsyncSmtpTransport::<Tokio1Executor>::relay(&email.smtp_host),
        NOTIFY_SMTP_PLAIN => Ok(AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(
            &email.smtp_host,
        )),
        _ => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&email.smtp_host),
    }
    .map_err(|_| "NOTIFY_INVALID: smtp host".to_string())?;
    let mut builder = builder
        .port(email.smtp_port)
        .timeout(Some(NOTIFY_WEBHOOK_TIMEOUT));
    if !email.smtp_username.is_empty() {
        builder = builder.credentials(Credentials::new(
            email.smtp_username.clone(),
            email.smtp_password.clone(),
        ));
    }
    let transport = builder.build();
    transport.send(message).await.map(|_| ()).map_err(|error| {
        // 传输错误类型对下游不可命名（lettre 的 transport::smtp::error 是私有模块），
        // 只能就地分类；分类里不带原始错误文本，避免回显凭据。
        if error.is_timeout() {
            "NOTIFY_TIMEOUT: smtp".to_string()
        } else if let Some(status) = error.status() {
            format!("NOTIFY_REJECTED: {}", u16::from(status))
        } else if error.is_response() {
            "NOTIFY_RESPONSE: smtp".to_string()
        } else if error.is_client() {
            "NOTIFY_INVALID: smtp client".to_string()
        } else if error.is_transport_shutdown() {
            "NOTIFY_SHUTDOWN: smtp".to_string()
        } else {
            "NOTIFY_CONNECT: smtp".to_string()
        }
    })
}

async fn send_pushplus(
    proxy_url: &str,
    pushplus: &NotifyPushplus,
    payload: &NotifyWebhookPayload,
    endpoint: &str,
) -> Result<(), String> {
    if pushplus.token.is_empty() {
        return Err("NOTIFY_UNCONFIGURED: pushplus token".to_string());
    }
    let body = serde_json::json!({
        "token": pushplus.token,
        "title": subject_text(payload),
        "content": body_text(payload),
    });
    let client = super::proxy::client_builder(proxy_url)?
        .timeout(NOTIFY_WEBHOOK_TIMEOUT)
        .build()
        .map_err(|_| "NOTIFY_INVALID: http client".to_string())?;
    let response = client
        .post(endpoint)
        .json(&body)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "NOTIFY_TIMEOUT: pushplus".to_string()
            } else {
                "NOTIFY_CONNECT: pushplus".to_string()
            }
        })?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("NOTIFY_RESPONSE: {}", status.as_u16()));
    }
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| "NOTIFY_RESPONSE: pushplus".to_string())?;
    if value["code"].as_i64() != Some(200) {
        let message = value["msg"].as_str().unwrap_or_default().trim();
        let message: String = message.chars().take(NOTIFY_SUBJECT_MAX_CHARS).collect();
        return Err(if message.is_empty() {
            format!("NOTIFY_PUSHPLUS: code {}", value["code"].as_i64().unwrap_or(-1))
        } else {
            format!("NOTIFY_PUSHPLUS: {message}")
        });
    }
    Ok(())
}

fn parse_mailbox(value: &str, field: &str) -> Result<Mailbox, String> {
    if value.is_empty() {
        return Err(format!("NOTIFY_UNCONFIGURED: email {field}"));
    }
    Mailbox::from_str(value).map_err(|_| format!("NOTIFY_INVALID: email {field}"))
}

/// 主题取自标题（标题为空时退回正文首行），换行折成空格，避免头注入。
fn subject_text(payload: &NotifyWebhookPayload) -> String {
    let title = sanitize_header(&payload.title);
    if !title.is_empty() {
        return title;
    }
    let body = sanitize_header(payload.body.lines().next().unwrap_or_default());
    if body.is_empty() {
        NOTIFY_SUBJECT_FALLBACK.to_string()
    } else {
        body
    }
}

fn sanitize_header(value: &str) -> String {
    value
        .replace(['\r', '\n'], " ")
        .trim()
        .chars()
        .take(NOTIFY_SUBJECT_MAX_CHARS)
        .collect()
}

fn body_text(payload: &NotifyWebhookPayload) -> String {
    let mut text = String::new();
    let title = payload.title.trim();
    if !title.is_empty() {
        text.push_str(title);
        text.push_str("\n\n");
    }
    text.push_str(payload.body.trim());
    let session_id = payload.session_id.trim();
    if !session_id.is_empty() {
        if !text.is_empty() {
            text.push_str("\n\n");
        }
        text.push_str("会话: ");
        text.push_str(session_id);
    }
    if text.is_empty() {
        text.push_str(NOTIFY_SUBJECT_FALLBACK);
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    /// 读一行；对端直接断开时返回空串，调用方据此结束会话
    /// （认证被拒后 lettre 不再发命令、直接关连接，这里必须容忍 EOF）。
    async fn read_line(stream: &mut TcpStream) -> String {
        let mut bytes = Vec::new();
        loop {
            let Ok(byte) = stream.read_u8().await else {
                break;
            };
            bytes.push(byte);
            if byte == b'\n' {
                break;
            }
            assert!(bytes.len() < 8192, "smtp line too long");
        }
        String::from_utf8(bytes).unwrap()
    }

    async fn write_line(stream: &mut TcpStream, line: &str) {
        stream.write_all(line.as_bytes()).await.unwrap();
    }

    /// 极简 SMTP 假服务器：只应答 lettre 真正会发的命令，回传 DATA 正文与是否走过认证。
    async fn serve_smtp(listener: TcpListener, auth_reply: &'static str) -> (String, bool) {
        let (mut stream, _) = listener.accept().await.unwrap();
        write_line(&mut stream, "220 fake ESMTP ready\r\n").await;
        let mut data = String::new();
        let mut authenticated = false;
        loop {
            let line = read_line(&mut stream).await;
            if line.is_empty() {
                break;
            }
            let command = line.trim_end().to_uppercase();
            if command.starts_with("EHLO") || command.starts_with("HELO") {
                write_line(&mut stream, "250-fake greets you\r\n250 AUTH PLAIN\r\n").await;
            } else if command.starts_with("AUTH") {
                authenticated = auth_reply.starts_with("235");
                write_line(&mut stream, auth_reply).await;
            } else if command.starts_with("MAIL FROM") || command.starts_with("RCPT TO") {
                write_line(&mut stream, "250 2.1.0 ok\r\n").await;
            } else if command.starts_with("DATA") {
                write_line(&mut stream, "354 end with <CR><LF>.<CR><LF>\r\n").await;
                loop {
                    let body_line = read_line(&mut stream).await;
                    if body_line == ".\r\n" || body_line.is_empty() {
                        break;
                    }
                    data.push_str(&body_line);
                }
                write_line(&mut stream, "250 2.0.0 queued\r\n").await;
            } else if command.starts_with("QUIT") {
                write_line(&mut stream, "221 2.0.0 bye\r\n").await;
                break;
            } else {
                write_line(&mut stream, "250 ok\r\n").await;
            }
        }
        (data, authenticated)
    }

    /// 极简 HTTP 假服务器：读满头部与 Content-Length 正文，回一段固定 JSON。
    async fn serve_http(listener: TcpListener, reply: &'static str) -> String {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        let mut length = 0usize;
        while !bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            bytes.push(stream.read_u8().await.unwrap());
            assert!(bytes.len() < 16384, "http head too long");
        }
        let head = String::from_utf8(bytes.clone()).unwrap();
        for line in head.lines() {
            if let Some(value) = line.to_lowercase().strip_prefix("content-length:") {
                length = value.trim().parse().unwrap();
            }
        }
        let mut body = vec![0u8; length];
        stream.read_exact(&mut body).await.unwrap();
        bytes.extend_from_slice(&body);
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            reply.len(),
            reply
        );
        stream.write_all(response.as_bytes()).await.unwrap();
        String::from_utf8(bytes).unwrap()
    }

    fn email_setting(port: u16) -> NotifyEmail {
        NotifyEmail {
            smtp_host: "127.0.0.1".to_string(),
            smtp_port: port,
            smtp_security: NOTIFY_SMTP_PLAIN.to_string(),
            smtp_username: String::new(),
            smtp_password: String::new(),
            from: "shell@example.com".to_string(),
            to: "user@example.com".to_string(),
        }
    }

    fn payload() -> NotifyWebhookPayload {
        NotifyWebhookPayload {
            title: "Task finished".to_string(),
            body: "session body".to_string(),
            session_id: "session-1".to_string(),
        }
    }

    #[test]
    fn unknown_channel_and_security_fall_back_to_the_safe_defaults() {
        let mut webhook = NotifyWebhook {
            channel: "telegram".to_string(),
            email: NotifyEmail {
                smtp_security: "ssl3".to_string(),
                ..NotifyEmail::default()
            },
            pushplus: NotifyPushplus::default(),
        };
        webhook.normalize();
        assert_eq!(webhook.channel, NOTIFY_CHANNEL_OFF);
        assert_eq!(webhook.email.smtp_security, NOTIFY_SMTP_STARTTLS);
    }

    #[test]
    fn zero_smtp_port_falls_back_to_the_port_of_its_security_mode() {
        for (security, expected) in [
            (NOTIFY_SMTP_STARTTLS, 587),
            (NOTIFY_SMTP_TLS, 465),
            (NOTIFY_SMTP_PLAIN, 25),
        ] {
            let mut email = NotifyEmail {
                smtp_port: 0,
                smtp_security: security.to_string(),
                ..NotifyEmail::default()
            };
            email.normalize();
            assert_eq!(email.smtp_port, expected, "{security}");
        }
    }

    #[test]
    fn unreadable_store_values_fall_back_to_the_disabled_channel() {
        let webhook = NotifyWebhook::from(serde_json::Value::Null);
        assert_eq!(webhook, NotifyWebhook::default());
        let webhook = NotifyWebhook::from(serde_json::json!({ "channel": 7, "email": "smtp" }));
        assert_eq!(webhook.channel, NOTIFY_CHANNEL_OFF);
        assert_eq!(webhook.email, NotifyEmail::default());
    }

    /// 前后端共享 camelCase 形状，字段改名不会有编译错误，只能拿真实序列化结果兜住。
    #[test]
    fn serialized_shape_matches_the_frontend_contract() {
        let webhook = NotifyWebhook {
            channel: NOTIFY_CHANNEL_EMAIL.to_string(),
            email: NotifyEmail {
                smtp_host: "smtp.example.com".to_string(),
                smtp_port: 465,
                smtp_security: NOTIFY_SMTP_TLS.to_string(),
                smtp_username: "u".to_string(),
                smtp_password: "p".to_string(),
                from: "a@example.com".to_string(),
                to: "b@example.com".to_string(),
            },
            pushplus: NotifyPushplus {
                token: "t".to_string(),
            },
        };
        let value = serde_json::to_value(&webhook).unwrap();
        assert_eq!(value["channel"], "email");
        assert_eq!(value["email"]["smtpHost"], "smtp.example.com");
        assert_eq!(value["email"]["smtpPort"], 465);
        assert_eq!(value["email"]["smtpSecurity"], "tls");
        assert_eq!(value["email"]["smtpUsername"], "u");
        assert_eq!(value["pushplus"]["token"], "t");
        let round_trip: NotifyWebhook = serde_json::from_value(value).unwrap();
        assert_eq!(round_trip, webhook);
    }

    #[test]
    fn subject_falls_back_to_body_then_to_a_fixed_title() {
        let mut item = payload();
        item.title = "  ".to_string();
        assert_eq!(subject_text(&item), "session body");
        item.body = String::new();
        assert_eq!(subject_text(&item), NOTIFY_SUBJECT_FALLBACK);
    }

    #[test]
    fn header_newlines_cannot_inject_extra_mail_headers() {
        let mut item = payload();
        item.title = "hello\r\nBcc: victim@example.com".to_string();
        assert_eq!(subject_text(&item), "hello  Bcc: victim@example.com");
    }

    #[test]
    fn missing_credentials_are_rejected_before_any_network_call() {
        assert_eq!(
            parse_mailbox("", "from").unwrap_err(),
            "NOTIFY_UNCONFIGURED: email from"
        );
        assert_eq!(
            parse_mailbox("not-an-address", "to").unwrap_err(),
            "NOTIFY_INVALID: email to"
        );
    }

    #[tokio::test]
    async fn email_delivery_reaches_a_real_smtp_conversation() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(serve_smtp(listener, "235 2.7.0 accepted\r\n"));
        send_email(&email_setting(port), &payload()).await.unwrap();
        let (data, authenticated) = server.await.unwrap();
        assert!(data.contains("Subject: Task finished"), "{data}");
        assert!(data.contains("From: shell@example.com"), "{data}");
        assert!(data.contains("To: user@example.com"), "{data}");
        assert!(data.contains("session body"), "{data}");
        assert!(data.contains("session-1"), "{data}");
        assert!(!authenticated, "未配置账号时不应发起 SMTP 认证");
    }

    #[tokio::test]
    async fn configured_credentials_are_sent_as_smtp_authentication() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(serve_smtp(listener, "235 2.7.0 accepted\r\n"));
        let email = NotifyEmail {
            smtp_username: "sender@example.com".to_string(),
            smtp_password: "app-password".to_string(),
            ..email_setting(port)
        };
        send_email(&email, &payload()).await.unwrap();
        let (_, authenticated) = server.await.unwrap();
        assert!(authenticated, "配置了账号密码就必须走 SMTP 认证");
    }

    #[tokio::test]
    async fn rejected_smtp_credentials_surface_a_fixed_error_code() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(serve_smtp(listener, "535 5.7.8 bad credentials\r\n"));
        let email = NotifyEmail {
            smtp_username: "sender@example.com".to_string(),
            smtp_password: "wrong-password".to_string(),
            ..email_setting(port)
        };
        let error = send_email(&email, &payload()).await.unwrap_err();
        assert!(error.starts_with("NOTIFY_REJECTED: 535"), "{error}");
        assert!(!error.contains("wrong-password"), "{error}");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn pushplus_delivery_posts_the_token_and_notification_content() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/send", listener.local_addr().unwrap());
        let server = tokio::spawn(serve_http(listener, r#"{"code":200,"msg":"请求成功"}"#));
        let pushplus = NotifyPushplus {
            token: "token-123".to_string(),
        };
        send_pushplus("", &pushplus, &payload(), &endpoint).await.unwrap();
        let request = server.await.unwrap();
        assert!(request.starts_with("POST /send HTTP/1.1"), "{request}");
        assert!(request.contains(r#""token":"token-123""#), "{request}");
        assert!(request.contains(r#""title":"Task finished""#), "{request}");
        assert!(
            request.contains(r#""content":"Task finished\n\nsession body\n\n会话: session-1""#),
            "{request}"
        );
    }

    #[tokio::test]
    async fn pushplus_business_error_is_reported_without_echoing_the_token() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/send", listener.local_addr().unwrap());
        let server = tokio::spawn(serve_http(listener, r#"{"code":903,"msg":"token无效"}"#));
        let pushplus = NotifyPushplus {
            token: "secret-token".to_string(),
        };
        let error = send_pushplus("", &pushplus, &payload(), &endpoint)
            .await
            .unwrap_err();
        assert_eq!(error, "NOTIFY_PUSHPLUS: token无效");
        assert!(!error.contains("secret-token"), "{error}");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn unreachable_pushplus_endpoint_is_reported_as_a_connect_failure() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/send", listener.local_addr().unwrap());
        drop(listener);
        let pushplus = NotifyPushplus {
            token: "token-123".to_string(),
        };
        let error = send_pushplus("", &pushplus, &payload(), &endpoint)
            .await
            .unwrap_err();
        assert_eq!(error, "NOTIFY_CONNECT: pushplus");
    }

    #[tokio::test]
    async fn empty_pushplus_token_is_rejected_before_any_network_call() {
        let pushplus = NotifyPushplus::default();
        let result = send_pushplus("", &pushplus, &payload(), NOTIFY_PUSHPLUS_ENDPOINT).await;
        assert_eq!(result.unwrap_err(), "NOTIFY_UNCONFIGURED: pushplus token");
    }
}
