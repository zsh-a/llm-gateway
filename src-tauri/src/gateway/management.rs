//! In-process management transport. The authority marker never crosses HTTP.
use super::{AppState, auth::require_admin, http};
use axum::{
    body::{Body, to_bytes},
    extract::FromRequestParts,
    http::{Request, request::Parts},
    response::Response,
};
use serde::Serialize;
use serde_json::Value;
use tower::ServiceExt;

#[derive(Clone)]
struct DesktopAuthority;

pub(super) struct AdminAccess;

impl FromRequestParts<AppState> for AdminAccess {
    type Rejection = Response;
    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        if parts.extensions.get::<DesktopAuthority>().is_none() {
            require_admin(state, &parts.headers).map_err(|response| *response)?;
        }
        Ok(Self)
    }
}

#[derive(Serialize)]
pub(crate) struct ManagementResponse {
    status: u16,
    body: Value,
}

pub(crate) async fn request(
    state: AppState,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<ManagementResponse, String> {
    let route = path.split('?').next().unwrap_or("");
    let allowed = match method.as_str() {
        "GET" => matches!(
            route,
            "/admin/keys"
                | "/admin/channels"
                | "/admin/models"
                | "/admin/metrics/summary"
                | "/admin/metrics/timeseries"
                | "/admin/metrics/requests"
        ),
        "POST" => matches!(route, "/admin/keys" | "/admin/channels"),
        "PATCH" => route.strip_prefix("/admin/keys/").is_some_and(valid_id),
        "DELETE" => {
            route.strip_prefix("/admin/keys/").is_some_and(valid_id)
                || route
                    .strip_prefix("/admin/channels/")
                    .is_some_and(|id| !id.is_empty() && id.len() <= 1024 && !id.contains('/'))
        }
        _ => false,
    };
    if !allowed {
        return Err("不支持的桌面管理操作".into());
    }
    let bytes = body
        .map(|value| serde_json::to_vec(&value))
        .transpose()
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    if bytes.len() > state.config.max_body_bytes {
        return Err("管理请求过大".into());
    }
    let mut request = Request::builder()
        .method(method.as_str())
        .uri(path)
        .header("content-type", "application/json")
        .body(Body::from(bytes))
        .map_err(|e| e.to_string())?;
    request.extensions_mut().insert(DesktopAuthority);
    let response = http::router(state)
        .oneshot(request)
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let bytes = to_bytes(response.into_body(), 16 * 1024 * 1024)
        .await
        .map_err(|e| e.to_string())?;
    let body = serde_json::from_slice(&bytes).map_err(|_| "管理接口返回了无效数据".to_string())?;
    Ok(ManagementResponse { status, body })
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
