use super::management::AdminAccess;
// HTTP routing and request handlers for the gateway.
use super::auth::{
    GatewayError, database_error, error_response, hash_secret, now_ms, require_public_auth,
    require_public_auth_identity, string_array,
};
use super::metrics::{MetricQuery, MetricView, metrics_response};
use super::protocols::{
    build_upstream_body, chat_to_response, parse_upstream_response, responses_to_chat,
};
use super::upstream::{UpstreamBody, UpstreamFailure};
use super::{AppState, MetricContext, Route};
use crate::config::{Config, parse_cors_origins};
use crate::db::{ApiKeyRecord, ChannelRecord, Db};
use axum::body::{Body, Bytes};
use axum::extract::rejection::JsonRejection;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::header::{self, HeaderValue};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use base64::Engine;
use serde_json::{Value, json};
use std::convert::Infallible;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::time::{Instant, timeout_at};
use tower_http::cors::{AllowHeaders, AllowOrigin, AllowPrivateNetwork, Any, CorsLayer};
use tracing::{debug, info, warn};

const MAX_UPSTREAM_BODY_BYTES: usize = 8 * 1024 * 1024;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod timeout_tests;

pub(super) fn router(state: AppState) -> Router {
    Router::new()
        .route("/", get(health))
        .route("/health", get(health))
        .route("/health/live", get(health))
        .route("/health/ready", get(health_ready))
        .route("/health/auth", get(health_auth))
        .route("/.well-known/llm-gateway/capabilities", get(capabilities))
        .route("/v1/models", get(models))
        .route("/v1/chat/completions", post(chat_completions))
        .route("/v1/responses", post(responses))
        .route("/metrics/summary", get(metrics_summary))
        .route("/metrics/timeseries", get(metrics_timeseries))
        .route("/metrics/requests", get(metrics_requests))
        .route("/admin/metrics/summary", get(admin_metrics_summary))
        .route("/admin/metrics/timeseries", get(admin_metrics_timeseries))
        .route("/admin/metrics/requests", get(admin_metrics_requests))
        .route("/admin/models", get(admin_models))
        .route("/admin/channels", get(list_channels).post(save_channel))
        .route("/admin/channels/{id}", delete(delete_channel))
        .route("/admin/keys", get(list_keys).post(create_key))
        .route("/admin/keys/{id}", patch(update_key).delete(revoke_key))
        .layer(DefaultBodyLimit::max(state.config.max_body_bytes))
        .layer(cors_layer(&state.config))
        .with_state(state)
}

fn cors_layer(config: &Config) -> CorsLayer {
    let base = CorsLayer::new()
        .allow_methods([
            Method::GET,
            Method::HEAD,
            Method::POST,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        // Authorization must be explicitly named in the preflight response;
        // Access-Control-Allow-Headers: * does not cover it in browsers.
        .allow_headers(AllowHeaders::mirror_request())
        .expose_headers([header::HeaderName::from_static("x-request-id")]);
    let configured = parse_cors_origins(&config.cors_origin).unwrap_or_else(|error| {
        warn!(%error, "CORS 配置无效，仅允许桌面端来源");
        Vec::new()
    });
    if configured.iter().any(|origin| origin == "*") {
        return base.allow_origin(Any).allow_private_network(true);
    }
    let mut origins = [
        "http://127.0.0.1:1420",
        "http://localhost:1420",
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
    ]
    .into_iter()
    .map(HeaderValue::from_static)
    .collect::<Vec<_>>();
    origins.extend(
        configured
            .iter()
            .filter_map(|origin| HeaderValue::from_str(origin).ok()),
    );
    let private_origins = origins.clone();
    base.allow_origin(AllowOrigin::list(origins))
        .allow_private_network(AllowPrivateNetwork::predicate(move |origin, _| {
            private_origins.contains(origin)
        }))
}

pub(crate) async fn serve(state: AppState) -> anyhow::Result<()> {
    let address = state.config.bind_address();
    let listener = TcpListener::bind(&address).await?;
    info!(%address, "Rust Axum 网关已启动");
    let activity = state.activity.clone();
    serve_listener(state, listener, async move {
        shutdown_signal().await;
        activity.set_accepting(false);
    })
    .await
}

pub(crate) async fn serve_listener(
    state: AppState,
    listener: TcpListener,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> anyhow::Result<()> {
    let discovery_state = state.clone();
    let discovery = tokio::spawn(async move { discovery_state.models().await });
    let result = axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown)
        .await;
    discovery.abort();
    result?;
    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let ctrl_c = async {
            if let Err(error) = tokio::signal::ctrl_c().await {
                debug!(%error, "监听 Ctrl-C 信号失败");
            }
        };
        let terminate = async {
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(mut signal) => {
                    signal.recv().await;
                }
                Err(error) => {
                    debug!(%error, "监听 SIGTERM 信号失败");
                    std::future::pending::<()>().await;
                }
            }
        };
        tokio::select! {
            _ = ctrl_c => {},
            _ = terminate => {},
        }
    }

    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }

    info!("收到关闭信号，正在停止 Rust Axum 网关");
}

async fn health() -> impl IntoResponse {
    Json(json!({
        "status": "ok",
        "service": "llm-gateway",
        "mode": "live",
        "providers": ["mimo", "workbuddy"]
    }))
}

async fn health_auth(State(state): State<AppState>) -> impl IntoResponse {
    Json(state.auth_status())
}

async fn health_ready(State(state): State<AppState>) -> Response {
    let auth = state.auth_status();
    let models = state.models().await;
    let authenticated = auth.get("ready").and_then(Value::as_bool).unwrap_or(false);
    let ready = authenticated && !models.is_empty();
    let body = json!({
        "status": if ready { "ok" } else { "not_ready" },
        "service": "llm-gateway",
        "mode": "ready",
        "authenticated": authenticated,
        "models": models.len(),
        "providers": auth.get("providers").cloned().unwrap_or_else(|| json!({}))
    });
    (
        if ready {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        Json(body),
    )
        .into_response()
}

async fn capabilities(State(state): State<AppState>) -> impl IntoResponse {
    let models = state.models().await;
    Json(json!({
        "object": "llm-gateway.capabilities",
        "version": 1,
        "service": "llm-gateway",
        "authRequired": state.requires_authentication(),
        "limits": { "maxBodyBytes": state.config.max_body_bytes },
        "protocols": {
            "chatCompletions": { "path": "/v1/chat/completions", "stream": true, "tools": true, "reasoningContent": true, "usageChunk": true },
            "responses": { "path": "/v1/responses", "stream": true, "reasoningText": true, "functionCalls": true }
        },
        "providers": [
            { "id": "mimo", "name": "MiMo", "authenticated": state.has_auth("mimo") },
            { "id": "workbuddy", "name": "WorkBuddy", "authenticated": state.has_auth("workbuddy") }
        ],
        "models": models
    }))
}

async fn models(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(response) = require_public_auth(&state, &headers) {
        return *response;
    }
    let data = state.models().await;
    Json(json!({ "object": "list", "data": data })).into_response()
}

async fn chat_completions(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    let mut body = match inference_body(body, state.config.max_body_bytes) {
        Ok(body) => body,
        Err(response) => return *response,
    };
    proxy_chat(state, headers, &mut body, false).await
}

async fn responses(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    let body = match inference_body(body, state.config.max_body_bytes) {
        Ok(body) => body,
        Err(response) => return *response,
    };
    let stream = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let mut chat = responses_to_chat(&body);
    let response = proxy_chat(state, headers, &mut chat, true).await;
    if stream || !response.status().is_success() {
        return response;
    }
    let request_id = response.headers().get("x-request-id").cloned();
    let bytes = match axum::body::to_bytes(response.into_body(), 8 * 1024 * 1024).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return error_response(
                StatusCode::BAD_GATEWAY,
                "读取上游响应失败",
                "upstream_error",
            );
        }
    };
    let chat_body: Value = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({}));
    let mut output = Json(chat_to_response(
        &chat_body,
        body.get("model").and_then(Value::as_str).unwrap_or(""),
    ))
    .into_response();
    if let Some(id) = request_id {
        output.headers_mut().insert("x-request-id", id);
    }
    output
}

fn inference_body(
    body: Result<Json<Value>, JsonRejection>,
    max_body_bytes: usize,
) -> Result<Value, GatewayError> {
    body.map(|Json(value)| value).map_err(|rejection| {
        if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
            Box::new((StatusCode::PAYLOAD_TOO_LARGE, Json(json!({
                "error": {
                    "message": format!(
                        "HTTP 请求体超过网关限制（{max_body_bytes} 字节），与模型 token 上下文限制无关。请压缩历史消息，或提高 MAX_BODY_BYTES 后重启网关。"
                    ),
                    "type": "invalid_request_error",
                    "code": "request_body_too_large",
                    "maxBodyBytes": max_body_bytes
                }
            }))).into_response())
        } else {
            Box::new(rejection.into_response())
        }
    })
}

async fn proxy_chat(
    state: AppState,
    headers: HeaderMap,
    body: &mut Value,
    responses_mode: bool,
) -> Response {
    let identity = match require_public_auth_identity(&state, &headers) {
        Ok(identity) => identity,
        Err(response) => return *response,
    };
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .filter(|model| !model.trim().is_empty())
        .unwrap_or_else(|| {
            if state.config.default_model.is_empty() {
                "default"
            } else {
                &state.config.default_model
            }
        })
        .to_string();
    if let Err(response) = state.authorize_model(&identity, &model) {
        return *response;
    }
    let routes = match state.select_routes(&model) {
        Ok(routes) => routes,
        Err(response) => return *response,
    };
    let Some(metric) = state.metric(if responses_mode { "responses" } else { "chat" }, &identity)
    else {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "网关正在停止，请稍后重试",
            "service_stopping",
        );
    };
    let request_id = metric.id();
    let mut response = proxy_upstream(state, body, responses_mode, &model, routes, metric).await;
    if let Ok(value) = HeaderValue::from_str(&request_id) {
        response.headers_mut().insert("x-request-id", value);
    }
    response
}

fn upstream_error(failure: &UpstreamFailure, metric: &MetricContext) -> Response {
    metric.fail(failure);
    (failure.status_code(), Json(failure.payload(&metric.id()))).into_response()
}

async fn proxy_upstream(
    state: AppState,
    body: &Value,
    responses_mode: bool,
    model: &str,
    routes: Vec<Route>,
    metric: MetricContext,
) -> Response {
    let mut response = None;
    let mut last_failure = UpstreamFailure::new(
        "upstream_request_error",
        "response_headers",
        "无法连接上游服务",
        StatusCode::BAD_GATEWAY,
    );
    for (index, route) in routes.iter().enumerate() {
        metric.set_route(route, model);
        let upstream_body = build_upstream_body(body, route, responses_mode);
        let auth_headers = state.auth_headers(&route.auth_ref).unwrap_or_default();
        // The first-byte deadline spans headers and the first nonempty body chunk.
        // There is deliberately no reqwest total timeout on a streaming request.
        let first_deadline =
            Instant::now() + Duration::from_millis(state.config.first_byte_timeout_ms);
        let request = state
            .client
            .post(&route.upstream_url)
            .headers(auth_headers)
            .header(header::CONTENT_TYPE, "application/json")
            .json(&upstream_body);
        last_failure = match timeout_at(first_deadline, request.send()).await {
            Ok(Ok(upstream)) if upstream.status().is_success() => {
                metric.headers_received();
                response = Some((upstream, first_deadline));
                break;
            }
            Ok(Ok(upstream)) => {
                metric.headers_received();
                let status = upstream.status();
                UpstreamFailure::new(
                    "upstream_http_error",
                    "response_headers",
                    format!("上游接口返回 HTTP {}", status.as_u16()),
                    status,
                )
            }
            Ok(Err(error)) => UpstreamFailure::request(&error, &state.config),
            Err(_) => {
                UpstreamFailure::timeout("response_headers", state.config.first_byte_timeout_ms)
            }
        };
        let retryable = last_failure.code != "upstream_http_error"
            || matches!(last_failure.status, 401 | 403 | 408 | 409 | 429)
            || last_failure.status >= 500;
        if !retryable || index + 1 == routes.len() {
            break;
        }
        warn!(request_id = %metric.id(), provider = %route.provider, channel = %route.channel_id,
            error_code = last_failure.code, stage = last_failure.stage,
            "上游尝试失败，切换下一个渠道");
    }
    let Some((response, first_deadline)) = response else {
        return upstream_error(&last_failure, &metric);
    };
    let stream = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    if !stream
        && response
            .content_length()
            .is_some_and(|length| length > MAX_UPSTREAM_BODY_BYTES as u64)
    {
        return upstream_error(&body_too_large(), &metric);
    }
    let status = response.status();
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .cloned()
        .unwrap_or_else(|| HeaderValue::from_static("text/event-stream"));
    let mut upstream = UpstreamBody::new(response, first_deadline, &state.config, metric.clone());
    // Delay downstream response headers until data arrives so a stalled first body
    // can still return HTTP 504 rather than a misleading HTTP 200.
    let first = match upstream.next_chunk().await {
        Ok(Some(bytes)) => bytes,
        Ok(None) => Bytes::new(),
        Err(failure) => return upstream_error(&failure, &metric),
    };
    if stream {
        let stream = futures_util::stream::unfold(
            (Some(first), Some(upstream)),
            move |(mut first, upstream)| async move {
                let mut upstream = upstream?;
                let next = if let Some(first) = first.take() {
                    Ok(Some(first))
                } else {
                    upstream.next_chunk().await
                };
                match next {
                    Ok(Some(bytes)) => {
                        if upstream.accumulator.done {
                            upstream.metric.finish("success", Some(status), None, None);
                        }
                        Some((Ok::<Bytes, Infallible>(bytes), (None, Some(upstream))))
                    }
                    Ok(None) => {
                        upstream.metric.finish("success", Some(status), None, None);
                        None
                    }
                    Err(failure) => {
                        upstream.metric.fail(&failure);
                        let event = failure.stream_event(&upstream.metric.id());
                        Some((Ok(event), (None, None)))
                    }
                }
            },
        );
        let mut output = Response::new(Body::from_stream(stream));
        output
            .headers_mut()
            .insert(header::CONTENT_TYPE, content_type);
        output
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
        output
    } else {
        let bytes = match read_upstream_body(upstream, first).await {
            Ok(bytes) => bytes,
            Err(failure) => return upstream_error(&failure, &metric),
        };
        let (output, usage, finish_reason) = parse_upstream_response(&bytes, model);
        metric.finish(
            "success",
            Some(StatusCode::OK),
            finish_reason.as_deref(),
            usage.as_ref(),
        );
        Json(output).into_response()
    }
}

fn body_too_large() -> UpstreamFailure {
    UpstreamFailure::new(
        "upstream_body_too_large",
        "response_body",
        "上游响应超过大小限制",
        StatusCode::BAD_GATEWAY,
    )
}

async fn read_upstream_body(
    mut upstream: UpstreamBody,
    first: Bytes,
) -> Result<Vec<u8>, UpstreamFailure> {
    if first.len() > MAX_UPSTREAM_BODY_BYTES {
        return Err(body_too_large());
    }
    let mut body = first.to_vec();
    while let Some(chunk) = upstream.next_chunk().await? {
        if body.len().saturating_add(chunk.len()) > MAX_UPSTREAM_BODY_BYTES {
            return Err(body_too_large());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn list_channels(State(state): State<AppState>, _admin: AdminAccess) -> Response {
    match state.db.list_channels() {
        Ok(data) => Json(json!({ "object": "llm-gateway.channels", "data": data })).into_response(),
        Err(error) => database_error(error),
    }
}

async fn save_channel(
    State(state): State<AppState>,
    _admin: AdminAccess,
    Json(value): Json<Value>,
) -> Response {
    let Some(object) = value.as_object() else {
        return error_response(
            StatusCode::BAD_REQUEST,
            "渠道配置必须是 JSON 对象",
            "invalid_request_error",
        );
    };
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let provider = object
        .get("providerId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if id.is_empty() || !["mimo", "workbuddy"].contains(&provider) {
        return error_response(
            StatusCode::BAD_REQUEST,
            "渠道需要有效的 id 和 providerId",
            "invalid_request_error",
        );
    }
    let channel = ChannelRecord {
        id: id.into(),
        name: object
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(id)
            .into(),
        provider_id: provider.into(),
        auth_ref: object
            .get("authRef")
            .and_then(Value::as_str)
            .unwrap_or(provider)
            .into(),
        upstream_url: object
            .get("upstreamUrl")
            .and_then(Value::as_str)
            .map(str::to_string),
        enabled: object
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        priority: object.get("priority").and_then(Value::as_i64).unwrap_or(0),
        weight: object
            .get("weight")
            .and_then(Value::as_i64)
            .unwrap_or(1)
            .max(1),
        model_mappings: object
            .get("modelMappings")
            .cloned()
            .unwrap_or_else(|| json!({})),
    };
    match state.db.upsert_channel(&channel) {
        Ok(()) => Json(json!({ "object": "llm-gateway.channel", "data": channel })).into_response(),
        Err(error) => database_error(error),
    }
}

async fn delete_channel(
    State(state): State<AppState>,
    _admin: AdminAccess,
    Path(id): Path<String>,
) -> Response {
    match state.db.delete_channel(&id) {
        Ok(true) => {
            Json(json!({ "object": "llm-gateway.channel.deleted", "id": id })).into_response()
        }
        Ok(false) => error_response(StatusCode::NOT_FOUND, "渠道不存在", "invalid_request_error"),
        Err(error) => database_error(error),
    }
}

async fn list_keys(State(state): State<AppState>, _admin: AdminAccess) -> Response {
    match state.db.list_api_keys() {
        Ok(keys) => Json(json!({ "object": "llm-gateway.api_keys", "data": keys.into_iter().map(public_key).collect::<Vec<_>>() })).into_response(),
        Err(error) => database_error(error),
    }
}

async fn create_key(
    State(state): State<AppState>,
    _admin: AdminAccess,
    Json(value): Json<Value>,
) -> Response {
    let object = value.as_object().cloned().unwrap_or_default();
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("未命名 Key")
        .trim();
    let secret = format!(
        "sk-gw-{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(rand::random::<[u8; 24]>())
    );
    let key = ApiKeyRecord {
        id: Db::new_id(),
        name: name.into(),
        prefix: secret.chars().take(10).collect(),
        hash: hash_secret(&secret),
        enabled: true,
        created_at: now_ms(),
        expires_at: object.get("expiresAt").and_then(Value::as_i64),
        allowed_models: string_array(object.get("allowedModels")),
        rpm_limit: object.get("rpmLimit").and_then(Value::as_i64),
        tpm_limit: object.get("tpmLimit").and_then(Value::as_i64),
        quota_tokens: object.get("quotaTokens").and_then(Value::as_i64),
        used_tokens: 0,
        revoked_at: None,
        last_used_at: None,
    };
    match state.db.upsert_api_key(&key) {
        Ok(()) => Json(json!({
            "object": "llm-gateway.api_key",
            "data": public_key(key),
            "secret": secret,
            "warning": "secret 只在本次响应中返回，请立即保存"
        }))
        .into_response(),
        Err(error) => database_error(error),
    }
}

async fn update_key(
    State(state): State<AppState>,
    _admin: AdminAccess,
    Path(id): Path<String>,
    Json(value): Json<Value>,
) -> Response {
    let Some(mut key) = state
        .db
        .list_api_keys()
        .ok()
        .and_then(|keys| keys.into_iter().find(|key| key.id == id))
    else {
        return error_response(
            StatusCode::NOT_FOUND,
            "API Key 不存在",
            "invalid_request_error",
        );
    };
    if key.revoked_at.is_some() {
        return error_response(
            StatusCode::CONFLICT,
            "已撤销的 Key 不可恢复或修改",
            "invalid_request_error",
        );
    }
    if value.get("expiresAt").is_some() {
        key.expires_at = value.get("expiresAt").and_then(Value::as_i64);
    }
    if let Some(name) = value.get("name").and_then(Value::as_str) {
        key.name = name.into();
    }
    if let Some(enabled) = value.get("enabled").and_then(Value::as_bool) {
        key.enabled = enabled;
    }
    if value.get("allowedModels").is_some() {
        key.allowed_models = string_array(value.get("allowedModels"));
    }
    for (field, target) in [
        ("rpmLimit", &mut key.rpm_limit),
        ("tpmLimit", &mut key.tpm_limit),
        ("quotaTokens", &mut key.quota_tokens),
    ] {
        if value.get(field).is_some() {
            *target = value.get(field).and_then(Value::as_i64);
        }
    }
    match state.db.upsert_api_key(&key) {
        Ok(()) => Json(json!({ "object": "llm-gateway.api_key", "data": public_key(key) }))
            .into_response(),
        Err(error) => database_error(error),
    }
}

async fn revoke_key(
    State(state): State<AppState>,
    _admin: AdminAccess,
    Path(id): Path<String>,
) -> Response {
    match state.db.delete_api_key(&id) {
        Ok(true) => {
            Json(json!({ "object": "llm-gateway.api_key.revoked", "id": id })).into_response()
        }
        Ok(false) => error_response(
            StatusCode::NOT_FOUND,
            "API Key 不存在",
            "invalid_request_error",
        ),
        Err(error) => database_error(error),
    }
}

async fn metrics_summary(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<MetricQuery>,
) -> Response {
    metrics_response(&state, &headers, &query, false, MetricView::Summary).await
}
async fn metrics_timeseries(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<MetricQuery>,
) -> Response {
    metrics_response(&state, &headers, &query, false, MetricView::Timeseries).await
}
async fn metrics_requests(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<MetricQuery>,
) -> Response {
    metrics_response(&state, &headers, &query, false, MetricView::Requests).await
}
async fn admin_metrics_summary(
    State(state): State<AppState>,
    headers: HeaderMap,
    _admin: AdminAccess,
    Query(query): Query<MetricQuery>,
) -> Response {
    metrics_response(&state, &headers, &query, true, MetricView::Summary).await
}
async fn admin_metrics_timeseries(
    State(state): State<AppState>,
    headers: HeaderMap,
    _admin: AdminAccess,
    Query(query): Query<MetricQuery>,
) -> Response {
    metrics_response(&state, &headers, &query, true, MetricView::Timeseries).await
}
async fn admin_metrics_requests(
    State(state): State<AppState>,
    headers: HeaderMap,
    _admin: AdminAccess,
    Query(query): Query<MetricQuery>,
) -> Response {
    metrics_response(&state, &headers, &query, true, MetricView::Requests).await
}

pub(super) fn public_key(key: ApiKeyRecord) -> Value {
    json!({ "id": key.id, "name": key.name, "prefix": key.prefix, "enabled": key.enabled, "createdAt": key.created_at, "expiresAt": key.expires_at, "allowedModels": key.allowed_models, "rpmLimit": key.rpm_limit, "tpmLimit": key.tpm_limit, "quotaTokens": key.quota_tokens, "usedTokens": key.used_tokens, "revokedAt": key.revoked_at, "lastUsedAt": key.last_used_at, "remainingTokens": key.quota_tokens.map(|quota| (quota-key.used_tokens).max(0)) })
}

async fn admin_models(State(state): State<AppState>, _admin: AdminAccess) -> Response {
    Json(json!({"object":"list","data":state.models().await})).into_response()
}
