use super::management::ManagementRequest;
// HTTP routing and request handlers for the gateway.
use super::auth::{require_admin, require_public_identity};
use super::error::GatewayError;
use super::metrics::{MetricQuery, MetricScope, MetricView};
use super::protocols::{Protocol, ResponsesStream, build_upstream_body, responses_to_chat};
use super::upstream::{UpstreamBody, UpstreamFailure};
#[cfg(test)]
use super::util::now_ms;
use super::{AppState, MetricContext, Route};
use super::{policy, routing};
use crate::config::{Config, parse_cors_origins};

use axum::body::{Body, Bytes};
use axum::extract::rejection::JsonRejection;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::header::{self, HeaderValue};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use serde_json::{Value, json};
use std::convert::Infallible;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::time::{Instant, timeout_at};
use tower_http::cors::{AllowHeaders, AllowOrigin, AllowPrivateNetwork, Any, CorsLayer};
use tracing::{debug, info, warn};

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
    Json(state.auth.status(&state.config))
}

async fn health_ready(State(state): State<AppState>) -> Response {
    let auth = state.auth.status(&state.config);
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
        "authRequired": !state.config.proxy_api_key.is_empty() || state.db.count_api_keys().map(|count| count > 0).unwrap_or(true),
        "limits": { "maxBodyBytes": state.config.max_body_bytes, "maxResponseBytes": state.config.max_response_bytes },
        "protocols": {
            "chatCompletions": { "path": "/v1/chat/completions", "stream": true, "tools": true, "reasoningContent": true, "usageChunk": true },
            "responses": { "path": "/v1/responses", "stream": true, "reasoningText": true, "functionCalls": true, "conversationState": false }
        },
        "providers": [
            { "id": "mimo", "name": "MiMo", "authenticated": state.auth.contains("mimo") },
            { "id": "workbuddy", "name": "WorkBuddy", "authenticated": state.auth.contains("workbuddy") }
        ],
        "models": models
    }))
}

async fn models(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let identity = match require_public_identity(&state, &headers) {
        Ok(identity) => identity,
        Err(error) => return error.into_response(),
    };
    let catalog = state.models().await;
    let channels = match state.db.list_channels() {
        Ok(channels) => channels,
        Err(error) => return GatewayError::database(error).into_response(),
    };
    let data = routing::visible_models(&catalog, &channels, &state.auth, &identity);
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
    proxy_chat(state, headers, &mut body, Protocol::Chat).await
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
    let mut chat = match responses_to_chat(&body) {
        Ok(chat) => chat,
        Err(error) => return error.into_response(),
    };
    proxy_chat(state, headers, &mut chat, Protocol::Responses).await
}

fn inference_body(
    body: Result<Json<Value>, JsonRejection>,
    max_body_bytes: usize,
) -> Result<Value, Box<Response>> {
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
    protocol: Protocol,
) -> Response {
    let identity = match require_public_identity(&state, &headers) {
        Ok(identity) => identity,
        Err(response) => return response.into_response(),
    };
    if let Err(error) = super::protocols::validate_request(body) {
        return error.into_response();
    }
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
    if let Err(response) = policy::authorize_model(&identity, &model) {
        return response.into_response();
    }
    let routes = match state
        .db
        .list_channels()
        .map_err(GatewayError::database)
        .and_then(|channels| {
            routing::select_routes(channels, &state.auth, &model, &state.catalog.snapshot())
        }) {
        Ok(routes) => routes,
        Err(response) => return response.into_response(),
    };
    let metric = match MetricContext::begin(
        &state.db,
        &state.activity,
        state.config.metrics_max_records,
        protocol.name(),
        &identity,
    ) {
        Ok(metric) => metric,
        Err(error) => return error.into_response(),
    };
    let request_id = metric.id();
    let mut response = proxy_upstream(state, body, protocol, &model, routes, metric).await;
    if let Ok(value) = HeaderValue::from_str(&request_id) {
        response.headers_mut().insert("x-request-id", value);
    }
    response
}

fn upstream_error(failure: &UpstreamFailure, metric: &MetricContext) -> Response {
    metric.fail(failure);
    let mut response = (failure.status_code(), Json(failure.payload(&metric.id()))).into_response();
    if let Some(ms) = failure.retry_after_ms {
        if let Ok(value) = (ms / 1000).to_string().parse() {
            response.headers_mut().insert(header::RETRY_AFTER, value);
        }
    }
    response
}

async fn proxy_upstream(
    state: AppState,
    body: &Value,
    protocol: Protocol,
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
        let upstream_body = build_upstream_body(body, route, protocol);
        metric.parameters(body, &upstream_body);
        let auth_headers = state.auth.headers(&route.auth_ref).unwrap_or_default();
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
                UpstreamFailure::http(upstream, first_deadline).await
            }
            Ok(Err(error)) => UpstreamFailure::request(&error, &state.config),
            Err(_) => {
                UpstreamFailure::timeout("response_headers", state.config.first_byte_timeout_ms)
            }
        };
        metric.attempt_failed(&last_failure);
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
            .is_some_and(|length| length > state.config.max_response_bytes as u64)
    {
        return upstream_error(&body_too_large(), &metric);
    }
    let status = response.status();
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .cloned()
        .unwrap_or_else(|| HeaderValue::from_static("text/event-stream"));
    if stream
        && protocol == Protocol::Responses
        && !content_type
            .to_str()
            .unwrap_or_default()
            .starts_with("text/event-stream")
    {
        return upstream_error(
            &UpstreamFailure::new(
                "upstream_invalid_response",
                "response_body",
                "上游未返回请求的 SSE 响应",
                StatusCode::BAD_GATEWAY,
            ),
            &metric,
        );
    }
    let mut upstream = UpstreamBody::new(
        response,
        first_deadline,
        &state.config,
        metric.clone(),
        !stream,
    );
    // Delay downstream response headers until data arrives so a stalled first body
    // can still return HTTP 504 rather than a misleading HTTP 200.
    let first = match upstream.next_chunk().await {
        Ok(Some(bytes)) => bytes,
        Ok(None) => Bytes::new(),
        Err(failure) => return upstream_error(&failure, &metric),
    };
    if stream {
        let adapter = (protocol == Protocol::Responses)
            .then(|| ResponsesStream::new(model, &metric.id(), state.config.max_response_bytes));
        let stream = futures_util::stream::unfold(
            (Some(first), Some(upstream), adapter),
            move |(mut first, upstream, mut adapter)| async move {
                let mut upstream = upstream?;
                loop {
                    let next = if let Some(first) = first.take() {
                        Ok(Some(first))
                    } else {
                        upstream.next_chunk().await
                    };
                    match next {
                        Ok(Some(raw)) => {
                            let bytes = if let Some(adapter) = &mut adapter {
                                match adapter.push(std::mem::take(&mut upstream.events)) {
                                    Ok(bytes) => bytes,
                                    Err(failure) => {
                                        upstream.metric.fail(&failure);
                                        return Some((
                                            Ok::<Bytes, Infallible>(adapter.finish(Some(&failure))),
                                            (None, None, None),
                                        ));
                                    }
                                }
                            } else {
                                raw
                            };
                            if upstream.accumulator.done {
                                upstream.metric.finish("success", Some(status), None, None);
                            }
                            if bytes.is_empty() {
                                continue;
                            }
                            return Some((Ok(bytes), (None, Some(upstream), adapter)));
                        }
                        Ok(None) => {
                            upstream.metric.finish("success", Some(status), None, None);
                            return adapter
                                .map(|mut adapter| (Ok(adapter.finish(None)), (None, None, None)));
                        }
                        Err(failure) => {
                            upstream.metric.fail(&failure);
                            let event = adapter.as_mut().map_or_else(
                                || failure.stream_event(&upstream.metric.id()),
                                |adapter| adapter.finish(Some(&failure)),
                            );
                            return Some((Ok(event), (None, None, None)));
                        }
                    }
                }
            },
        );
        let mut output = Response::new(Body::from_stream(stream));
        output.headers_mut().insert(
            header::CONTENT_TYPE,
            if protocol == Protocol::Responses {
                HeaderValue::from_static("text/event-stream")
            } else {
                content_type
            },
        );
        output
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
        output
    } else {
        loop {
            match upstream.next_chunk().await {
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(failure) => return upstream_error(&failure, &metric),
            }
        }
        let (output, usage, finish_reason) = match upstream.completion(model) {
            Ok(result) => result,
            Err(failure) => return upstream_error(&failure, &metric),
        };
        metric.finish(
            "success",
            Some(StatusCode::OK),
            finish_reason.as_deref(),
            usage.as_ref(),
        );
        Json(protocol.render(output, model)).into_response()
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

async fn managed(state: AppState, request: ManagementRequest) -> Response {
    match super::management::execute(&state, request).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => error.into_response(),
    }
}
async fn list_channels(State(state): State<AppState>, _admin: AdminAccess) -> Response {
    managed(state, ManagementRequest::ListChannels {}).await
}
async fn save_channel(
    State(state): State<AppState>,
    _admin: AdminAccess,
    Json(body): Json<Value>,
) -> Response {
    managed(state, ManagementRequest::SaveChannel { body }).await
}
async fn delete_channel(
    State(state): State<AppState>,
    _admin: AdminAccess,
    Path(id): Path<String>,
) -> Response {
    managed(state, ManagementRequest::DeleteChannel { id }).await
}
async fn list_keys(State(state): State<AppState>, _admin: AdminAccess) -> Response {
    managed(state, ManagementRequest::ListKeys {}).await
}
async fn create_key(
    State(state): State<AppState>,
    _admin: AdminAccess,
    Json(body): Json<Value>,
) -> Response {
    managed(state, ManagementRequest::CreateKey { body }).await
}
async fn update_key(
    State(state): State<AppState>,
    _admin: AdminAccess,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    managed(state, ManagementRequest::UpdateKey { id, body }).await
}
async fn revoke_key(
    State(state): State<AppState>,
    _admin: AdminAccess,
    Path(id): Path<String>,
) -> Response {
    managed(state, ManagementRequest::RevokeKey { id }).await
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

async fn admin_models(State(state): State<AppState>, _admin: AdminAccess) -> Response {
    managed(state, ManagementRequest::Models {}).await
}

struct AdminAccess;
impl axum::extract::FromRequestParts<AppState> for AdminAccess {
    type Rejection = Response;
    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        state: &AppState,
    ) -> Result<Self, Response> {
        require_admin(state, &parts.headers).map_err(IntoResponse::into_response)?;
        Ok(Self)
    }
}

async fn metrics_response(
    state: &AppState,
    headers: &HeaderMap,
    query: &MetricQuery,
    admin: bool,
    view: MetricView,
) -> Response {
    let scope = if admin {
        MetricScope::Admin
    } else {
        match require_public_identity(state, headers) {
            Ok(identity) => MetricScope::Identity(identity),
            Err(error) => return error.into_response(),
        }
    };
    match super::metrics::query_metrics(state, query, scope, view) {
        Ok(value) => Json(value).into_response(),
        Err(error) => error.into_response(),
    }
}

impl IntoResponse for GatewayError {
    fn into_response(self) -> Response {
        (
            StatusCode::from_u16(self.status()).expect("gateway error status"),
            Json(self.payload()),
        )
            .into_response()
    }
}
