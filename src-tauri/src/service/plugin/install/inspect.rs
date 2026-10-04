//! 插件 spec 兼容性只读检查：解析包名与声明的版本 → 读 npm registry 对应清单 →
//! 提取 `@deepseek-ai/dsh` 家族依赖 → 用 [`crate::service::plugin::compat`] 判定
//! 是否匹配运行时核心版本。全程不落盘、不起子进程，供插件市场在安装前提示。

use std::time::Duration;

use semver::Version;
use tauri::AppHandle;

use crate::service::plugin::compat::{self, PluginInspect};
use crate::service::plugin::update::encode_registry_name;

use super::spec;

/// registry 请求超时：与更新探测一致，只读检查不该拖住安装前交互。
const INSPECT_TIMEOUT: Duration = Duration::from_secs(10);

/// 逐条检查 spec；单条检查的任何异常都收敛为该条的 `problem`，不影响其余条目
/// （Fail-Open：判定失败不等于不兼容）。
pub async fn inspect_specs(
    app_handle: &AppHandle,
    specs: &[String],
    dsh: Option<String>,
) -> Result<Vec<PluginInspect>, String> {
    let runtime = dsh
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| crate::service::core::active_version(app_handle));
    let client = crate::config::proxy::http_client_builder(app_handle)?
        .timeout(INSPECT_TIMEOUT)
        .build()
        .map_err(|e| format!("INSPECT_CLIENT: {e}"))?;

    let mut results = Vec::with_capacity(specs.len());
    for raw in specs {
        results.push(inspect_one(&client, raw, runtime.as_deref()).await);
    }
    Ok(results)
}

/// 单条 spec：静态解析不出包名（git / 本地路径 / 非法写法）时不做网络请求。
async fn inspect_one(client: &reqwest::Client, spec: &str, runtime: Option<&str>) -> PluginInspect {
    let raw = spec.trim();
    let Some(name) = spec::package_name_of_spec(raw) else {
        return problem_result(raw, None, "invalid-spec");
    };

    let requested = requested_version(raw, &name);
    let exact = requested
        .as_deref()
        .filter(|value| Version::parse(value).is_ok());
    let target = exact.unwrap_or("latest");
    let url = format!(
        "https://registry.npmjs.org/{}/{}",
        encode_registry_name(&name),
        target
    );
    let response = match client
        .get(&url)
        .header("accept", "application/json")
        .header("user-agent", "deepseek-harness-desktop")
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return problem_result(raw, Some(name), "network"),
    };
    // 404 是确定性的「包不存在」，其余非 2xx 都按网络问题处理。
    if !response.status().is_success() {
        let problem = if response.status() == reqwest::StatusCode::NOT_FOUND {
            "not-found"
        } else {
            "network"
        };
        return problem_result(raw, Some(name), problem);
    }
    let Ok(manifest) = response.json::<serde_json::Value>().await else {
        return problem_result(raw, Some(name), "network");
    };

    let version = manifest
        .get("version")
        .and_then(serde_json::Value::as_str)
        .map(String::from);
    let peers = compat::peers_from_manifest(&manifest);
    // 区间（`^1.2.0` / `>=1 <2`）暂不做版本解析：此时读的是 latest 清单，
    // 拿它的依赖去判定会误伤「用旧版本规避新版不兼容」的标准做法，故放行。
    let compatible = if requested.is_some() && exact.is_none() {
        None
    } else {
        runtime.and_then(|runtime| compat::evaluate(&peers, runtime))
    };
    PluginInspect {
        spec: raw.to_string(),
        name: Some(name),
        version,
        compatible,
        peers: (!peers.is_empty()).then_some(peers),
        problem: None,
    }
}

/// spec 里在包名之后显式声明的版本片段（`aaa@1.0.0` / `@scope/aaa@^1.0.0`）。
fn requested_version(raw: &str, name: &str) -> Option<String> {
    raw.strip_prefix(name)
        .and_then(|rest| rest.strip_prefix('@'))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(String::from)
}

/// 出错条目：保留已解析到的包名便于前端展示，兼容性留空（Fail-Open）。
fn problem_result(spec: &str, name: Option<String>, problem: &str) -> PluginInspect {
    PluginInspect {
        spec: spec.to_string(),
        name,
        version: None,
        compatible: None,
        peers: None,
        problem: Some(problem.to_string()),
    }
}
