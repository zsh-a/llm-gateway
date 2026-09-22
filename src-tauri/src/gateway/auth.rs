use super::{AppState, Identity};
use axum::Json;
use axum::http::header::{self, HeaderName, HeaderValue};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use subtle::ConstantTimeEq;
use tracing::error;

pub(super) type GatewayError = Box<Response>;

pub(super) fn read_auth_headers(path: &PathBuf) -> Option<HeaderMap> {
    let raw = std::fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    let object = value
        .get("headers")
        .and_then(Value::as_object)
        .or_else(|| value.as_object());
    let object = object?;
    let mut headers = HeaderMap::new();
    for (name, value) in object {
        if !is_forwarded_header(name) {
            continue;
        }
        let Some(value) = value
            .as_str()
            .and_then(|value| HeaderValue::from_str(value).ok())
        else {
            continue;
        };
        let Ok(name) = HeaderName::from_bytes(name.as_bytes()) else {
            continue;
        };
        headers.insert(name, value);
    }
    headers
        .keys()
        .any(|name| name != header::USER_AGENT)
        .then_some(headers)
}

pub(super) fn read_auth_captured_at(path: &PathBuf) -> Option<i64> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&raw)
        .ok()?
        .get("capturedAt")
        .and_then(Value::as_i64)
}

pub(super) fn is_forwarded_header(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    matches!(
        name.as_str(),
        "authorization" | "cookie" | "user-agent" | "x-api-key" | "x-goog-api-key"
    ) || name.starts_with("x-")
}

pub(super) fn request_credential(headers: &HeaderMap) -> String {
    if let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    {
        if let Some(value) = value
            .strip_prefix("Bearer ")
            .or_else(|| value.strip_prefix("bearer "))
        {
            return value.trim().into();
        }
    }
    headers
        .get("x-api-key")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .trim()
        .into()
}

pub(super) fn require_public_auth(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), GatewayError> {
    let _ = require_public_auth_identity(state, headers)?;
    Ok(())
}

pub(super) fn require_public_auth_identity(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Identity, GatewayError> {
    let identity = require_public_identity(state, headers)?;
    state.authorize_limits(&identity)?;
    Ok(identity)
}

// Reading one's own usage must remain possible when the inference quota is exhausted.
pub(super) fn require_public_identity(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Identity, GatewayError> {
    let identity = state.authenticate(headers);
    if identity.is_none()
        || (!state.config.is_loopback()
            && !identity
                .as_ref()
                .is_some_and(|identity| identity.managed || identity.key_id == "environment"))
    {
        return Err(Box::new(error_response(
            StatusCode::UNAUTHORIZED,
            "缺少或无效的代理 API Key",
            "authentication_error",
        )));
    }
    let identity = identity.expect("checked above");
    Ok(identity)
}

pub(super) fn require_admin(state: &AppState, headers: &HeaderMap) -> Result<(), GatewayError> {
    if state.config.proxy_admin_key.is_empty() {
        return Err(Box::new(error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "HTTP 管理接口需要配置 PROXY_ADMIN_KEY；本机桌面可直接管理",
            "configuration_error",
        )));
    }
    if !state.admin_authorized(headers) {
        return Err(Box::new(error_response(
            StatusCode::UNAUTHORIZED,
            "缺少或无效的管理员 API Key",
            "authentication_error",
        )));
    }
    Ok(())
}

pub(super) fn error_response(
    status: StatusCode,
    message: impl Into<String>,
    error_type: &str,
) -> Response {
    (
        status,
        Json(json!({ "error": { "message": message.into(), "type": error_type } })),
    )
        .into_response()
}

pub(super) fn database_error(error: impl std::fmt::Display) -> Response {
    error!(%error, "SQLite 操作失败");
    error_response(
        StatusCode::INTERNAL_SERVER_ERROR,
        "数据库操作失败",
        "internal_error",
    )
}

pub(super) fn hash_secret(secret: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(secret.as_bytes());
    format!("{:x}", hasher.finalize())
}

pub(super) fn secret_equal(left: &str, right: &str) -> bool {
    left.as_bytes().ct_eq(right.as_bytes()).into()
}

pub(super) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub(super) fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn parse_window(value: Option<&str>) -> Duration {
    let value = value.unwrap_or("24h");
    let (number, multiplier) = if let Some(value) = value.strip_suffix('m') {
        (value, 60_000)
    } else if let Some(value) = value.strip_suffix('h') {
        (value, 3_600_000)
    } else if let Some(value) = value.strip_suffix('d') {
        (value, 86_400_000)
    } else {
        (value, 3_600_000)
    };
    number
        .parse::<u64>()
        .ok()
        .map(|value| Duration::from_millis(value.saturating_mul(multiplier)))
        .unwrap_or(Duration::from_secs(24 * 60 * 60))
}
