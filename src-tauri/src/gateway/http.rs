// HTTP routing and request handlers for the gateway.
use super::AppState;
use super::auth::{
    database_error, error_response, hash_secret, now_ms, require_admin, require_public_auth,
    require_public_auth_identity, string_array,
};
use super::metrics::{MetricQuery, MetricView, metrics_response};
use super::protocols::{
    StreamAccumulator, build_upstream_body, chat_to_response, parse_upstream_response,
    responses_to_chat,
};
use crate::config::Config;
use crate::db::{ApiKeyRecord, ChannelRecord, Db};
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::header::{self, HeaderValue};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use base64::Engine;
use futures_util::stream::StreamExt;
use serde_json::{Value, json};
use std::convert::Infallible;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::time::timeout;
use tower_http::cors::{AllowOrigin, Any, CorsLayer};
use tracing::{debug, info};

const MAX_UPSTREAM_BODY_BYTES: usize = 8 * 1024 * 1024;

fn router(state: AppState) -> Router {
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
        .route("/admin/channels", get(list_channels).post(save_channel))
        .route("/admin/channels/{id}", delete(delete_channel))
        .route("/admin/keys", get(list_keys).post(create_key))
        .route("/admin/keys/{id}", patch(update_key).delete(revoke_key))
        .layer(DefaultBodyLimit::max(state.config.max_body_bytes))
        .layer(cors_layer(&state.config))
        .with_state(state)
}

fn cors_layer(config: &Config) -> CorsLayer {
    let base = CorsLayer::new().allow_methods(Any).allow_headers(Any);
    if config.cors_origin.trim().is_empty() {
        let defaults = [
            "http://127.0.0.1:1420",
            "http://localhost:1420",
            "tauri://localhost",
            "http://tauri.localhost",
            "https://tauri.localhost",
        ]
        .into_iter()
        .filter_map(|origin| HeaderValue::from_str(origin).ok())
        .collect::<Vec<_>>();
        return base.allow_origin(AllowOrigin::list(defaults));
    }
    let origins = config
        .cors_origin
        .split(',')
        .filter_map(|origin| HeaderValue::from_str(origin.trim()).ok())
        .collect::<Vec<_>>();
    if origins.is_empty() {
        base.allow_origin(Any)
    } else {
        base.allow_origin(AllowOrigin::list(origins))
    }
}

pub(crate) async fn serve(state: AppState) -> anyhow::Result<()> {
    let address = state.config.bind_address();
    let listener = TcpListener::bind(&address).await?;
    info!(%address, "Rust Axum 网关已启动");
    axum::serve(listener, router(state)).await?;
    Ok(())
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
        "protocols": {
            "chatCompletions": { "path": "/v1/chat/completions", "stream": true, "tools": true, "reasoningContent": true, "usageChunk": true },
            "responses": { "path": "/v1/responses", "stream": true, "reasoningText": true, "functionCalls": true }
        },
        "providers": [
            { "id": "mimo", "name": "MiMo", "authenticated": state.auth.contains_key("mimo") },
            { "id": "workbuddy", "name": "WorkBuddy", "authenticated": state.auth.contains_key("workbuddy") }
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
    Json(body): Json<Value>,
) -> Response {
    let mut body = body;
    proxy_chat(state, headers, &mut body, false).await
}

async fn responses(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let stream = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let mut chat = responses_to_chat(&body);
    let response = proxy_chat(state, headers, &mut chat, true).await;
    if stream || !response.status().is_success() {
        return response;
    }
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
    Json(chat_to_response(
        &chat_body,
        body.get("model").and_then(Value::as_str).unwrap_or(""),
    ))
    .into_response()
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
    let metric = state.metric(if responses_mode { "responses" } else { "chat" }, &identity);
    let mut response = None;
    let mut last_status = StatusCode::BAD_GATEWAY;
    for (index, route) in routes.iter().enumerate() {
        metric.set_route(route, &model);
        let upstream_body = build_upstream_body(body, route, responses_mode);
        let auth_headers = state.auth.get(&route.auth_ref).cloned().unwrap_or_default();
        let request = state
            .client
            .post(&route.upstream_url)
            .headers(auth_headers)
            .header(header::CONTENT_TYPE, "application/json")
            .timeout(Duration::from_millis(state.config.request_timeout_ms))
            .json(&upstream_body);
        match timeout(
            Duration::from_millis(state.config.request_timeout_ms),
            request.send(),
        )
        .await
        {
            Ok(Ok(upstream)) if upstream.status().is_success() => {
                response = Some(upstream);
                break;
            }
            Ok(Ok(upstream)) => {
                let status = upstream.status();
                last_status = status;
                let retryable = matches!(status.as_u16(), 401 | 403 | 408 | 409 | 429)
                    || status.is_server_error();
                if retryable && index + 1 < routes.len() {
                    debug!(provider = %route.provider, channel = %route.channel_id, status = status.as_u16(), "上游响应可重试，切换下一个渠道");
                    continue;
                }
            }
            Ok(Err(error)) => {
                debug!(%error, provider = %route.provider, channel = %route.channel_id, "上游请求失败");
                if index + 1 < routes.len() {
                    continue;
                }
            }
            Err(_) => {
                last_status = StatusCode::GATEWAY_TIMEOUT;
                if index + 1 < routes.len() {
                    continue;
                }
            }
        }
        break;
    }
    let Some(response) = response else {
        metric.finish("error", Some(last_status), None, None);
        let message = if last_status == StatusCode::GATEWAY_TIMEOUT {
            "上游请求超时".to_string()
        } else if last_status == StatusCode::BAD_GATEWAY {
            "无法连接上游服务".to_string()
        } else {
            format!("上游接口返回 HTTP {}", last_status.as_u16())
        };
        return error_response(
            last_status,
            message,
            if last_status == StatusCode::GATEWAY_TIMEOUT {
                "timeout_error"
            } else {
                "upstream_error"
            },
        );
    };
    let stream = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    if stream {
        let status = response.status();
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .cloned()
            .unwrap_or_else(|| HeaderValue::from_static("text/event-stream"));
        let upstream = response.bytes_stream();
        let status_for_stream = status;
        let stream = futures_util::stream::unfold(
            (upstream, Some(metric.clone()), StreamAccumulator::default()),
            move |(mut upstream, metric, mut accumulator)| async move {
                match upstream.next().await {
                    Some(Ok(bytes)) => {
                        accumulator.observe(&bytes);
                        Some((
                            Ok::<Bytes, Infallible>(bytes),
                            (upstream, metric, accumulator),
                        ))
                    }
                    Some(Err(error)) => {
                        if let Some(metric) = metric.as_ref() {
                            metric.finish(
                                "error",
                                Some(StatusCode::BAD_GATEWAY),
                                accumulator.finish_reason.as_deref(),
                                accumulator.usage.as_ref(),
                            );
                        }
                        let _ = error;
                        None
                    }
                    None => {
                        if let Some(metric) = metric.as_ref() {
                            metric.finish(
                                "success",
                                Some(status_for_stream),
                                accumulator.finish_reason.as_deref(),
                                accumulator.usage.as_ref(),
                            );
                        }
                        None
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
            .headers_mut()
            .insert(header::CONNECTION, HeaderValue::from_static("keep-alive"));
        output
    } else {
        let bytes = match read_upstream_body(response).await {
            Ok(bytes) => bytes,
            Err(error) => {
                debug!(?error, "读取上游响应失败");
                metric.finish("error", Some(StatusCode::BAD_GATEWAY), None, None);
                return error_response(
                    StatusCode::BAD_GATEWAY,
                    "读取上游响应失败",
                    "upstream_error",
                );
            }
        };
        let (output, usage, finish_reason) = parse_upstream_response(&bytes, &model);
        metric.finish(
            "success",
            Some(StatusCode::OK),
            finish_reason.as_deref(),
            usage.as_ref(),
        );
        Json(output).into_response()
    }
}

async fn read_upstream_body(response: reqwest::Response) -> Result<Vec<u8>, &'static str> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_UPSTREAM_BODY_BYTES as u64)
    {
        return Err("上游响应超过大小限制");
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "读取上游响应失败")?;
        if body.len().saturating_add(chunk.len()) > MAX_UPSTREAM_BODY_BYTES {
            return Err("上游响应超过大小限制");
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn list_channels(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(response) = require_admin(&state, &headers) {
        return *response;
    }
    match state.db.list_channels() {
        Ok(data) => Json(json!({ "object": "llm-gateway.channels", "data": data })).into_response(),
        Err(error) => database_error(error),
    }
}

async fn save_channel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(value): Json<Value>,
) -> Response {
    if let Err(response) = require_admin(&state, &headers) {
        return *response;
    }
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
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = require_admin(&state, &headers) {
        return *response;
    }
    match state.db.delete_channel(&id) {
        Ok(true) => {
            Json(json!({ "object": "llm-gateway.channel.deleted", "id": id })).into_response()
        }
        Ok(false) => error_response(StatusCode::NOT_FOUND, "渠道不存在", "invalid_request_error"),
        Err(error) => database_error(error),
    }
}

async fn list_keys(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(response) = require_admin(&state, &headers) {
        return *response;
    }
    match state.db.list_api_keys() {
        Ok(keys) => Json(json!({ "object": "llm-gateway.api_keys", "data": keys.into_iter().map(public_key).collect::<Vec<_>>() })).into_response(),
        Err(error) => database_error(error),
    }
}

async fn create_key(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(value): Json<Value>,
) -> Response {
    if let Err(response) = require_admin(&state, &headers) {
        return *response;
    }
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
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(value): Json<Value>,
) -> Response {
    if let Err(response) = require_admin(&state, &headers) {
        return *response;
    }
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
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = require_admin(&state, &headers) {
        return *response;
    }
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
    Query(query): Query<MetricQuery>,
) -> Response {
    metrics_response(&state, &headers, &query, true, MetricView::Summary).await
}
async fn admin_metrics_timeseries(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<MetricQuery>,
) -> Response {
    metrics_response(&state, &headers, &query, true, MetricView::Timeseries).await
}
async fn admin_metrics_requests(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<MetricQuery>,
) -> Response {
    metrics_response(&state, &headers, &query, true, MetricView::Requests).await
}

fn public_key(key: ApiKeyRecord) -> Value {
    json!({ "id": key.id, "name": key.name, "prefix": key.prefix, "enabled": key.enabled, "createdAt": key.created_at, "expiresAt": key.expires_at, "allowedModels": key.allowed_models, "rpmLimit": key.rpm_limit, "tpmLimit": key.tpm_limit, "quotaTokens": key.quota_tokens, "usedTokens": key.used_tokens, "remainingTokens": key.quota_tokens.map(|quota| (quota-key.used_tokens).max(0)) })
}
