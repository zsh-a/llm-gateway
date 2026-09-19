use crate::config::Config;
use crate::db::{ApiKeyRecord, ChannelRecord, Db, MetricRecord, MetricRow};
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::header::{self, HeaderName, HeaderValue};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use base64::Engine;
use futures_util::stream::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use subtle::ConstantTimeEq;
use tokio::net::TcpListener;
use tokio::time::timeout;
use tower_http::cors::{AllowOrigin, Any, CorsLayer};
use tracing::{debug, error, info, warn};

const MIMO_URL: &str = "https://mimo-server-cn.xiaomimimo.com/api/route/chat/completions";
const MIMO_MODELS_URL: &str = "https://mimo-server-cn.xiaomimimo.com/api/model/list";
const WORKBUDDY_URL: &str = "https://copilot.tencent.com/v2/chat/completions";

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub db: Db,
    pub client: Client,
    auth: Arc<HashMap<String, HeaderMap>>,
    model_cache: Arc<RwLock<Option<ModelCache>>>,
}

#[derive(Clone)]
struct ModelCache {
    fetched_at: Instant,
    models: Vec<ModelInfo>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub owned_by: String,
    pub capabilities: HashMap<String, bool>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "reasoningEfforts")]
    pub reasoning_efforts: Option<HashMap<String, Option<String>>>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        rename = "defaultReasoningEffort"
    )]
    pub default_reasoning_effort: Option<String>,
}

#[derive(Clone, Debug)]
struct Identity {
    key_id: String,
    name: String,
    managed: bool,
    allowed_models: Vec<String>,
    rpm_limit: Option<i64>,
    tpm_limit: Option<i64>,
    quota_tokens: Option<i64>,
    used_tokens: i64,
}

#[derive(Clone, Debug)]
struct Route {
    provider: String,
    channel_id: String,
    upstream_url: String,
    upstream_model: String,
    auth_ref: String,
}

#[derive(Clone)]
struct MetricContext {
    state: AppState,
    draft: Arc<Mutex<MetricDraft>>,
}

#[derive(Default)]
struct MetricDraft {
    id: String,
    started_at: i64,
    protocol: String,
    provider: Option<String>,
    channel_id: Option<String>,
    model: Option<String>,
    status: Option<String>,
    status_code: Option<i64>,
    finish_reason: Option<String>,
    api_key_id: Option<String>,
    usage_json: Option<String>,
    finished: bool,
}

#[derive(Default)]
struct StreamAccumulator {
    buffer: String,
    usage: Option<Value>,
    finish_reason: Option<String>,
}

impl StreamAccumulator {
    fn observe(&mut self, bytes: &[u8]) {
        self.buffer.push_str(&String::from_utf8_lossy(bytes));
        if self.buffer.len() > 64 * 1024 {
            let keep_from = self.buffer.len() - 64 * 1024;
            self.buffer = self.buffer.split_off(keep_from);
        }
        let blocks = self.buffer.split("\n\n").collect::<Vec<_>>();
        let trailing = blocks.last().copied().unwrap_or_default().to_string();
        let complete = blocks.len().saturating_sub(1);
        for block in blocks.into_iter().take(complete) {
            let data = block
                .lines()
                .filter_map(|line| line.strip_prefix("data:"))
                .map(str::trim)
                .collect::<Vec<_>>()
                .join("\n");
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(&data) else {
                continue;
            };
            if let Some(usage) = value.get("usage") {
                self.usage = Some(normalize_usage(usage));
            }
            self.finish_reason = value
                .get("choices")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(|choice| choice.get("finish_reason"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| self.finish_reason.clone());
        }
        self.buffer = trailing;
    }
}

impl AppState {
    pub fn new(config: Config) -> anyhow::Result<Self> {
        config.ensure_runtime_dir()?;
        let db = Db::open(&config.database_path())?;
        db.seed_channels(&config.channels_file)?;
        db.seed_api_keys(&config.api_keys_file)?;
        if db.list_channels()?.is_empty() {
            db.upsert_channel(&ChannelRecord {
                id: "mimo-default".into(),
                name: "MiMo 默认渠道".into(),
                provider_id: "mimo".into(),
                auth_ref: "mimo".into(),
                upstream_url: Some(MIMO_URL.into()),
                enabled: true,
                priority: 0,
                weight: 1,
                model_mappings: json!({}),
            })?;
            db.upsert_channel(&ChannelRecord {
                id: "workbuddy-default".into(),
                name: "WorkBuddy 默认渠道".into(),
                provider_id: "workbuddy".into(),
                auth_ref: "workbuddy".into(),
                upstream_url: Some(WORKBUDDY_URL.into()),
                enabled: true,
                priority: 0,
                weight: 1,
                model_mappings: json!({}),
            })?;
        }

        let mut auth = HashMap::new();
        if let Ok(entries) = std::fs::read_dir(&config.auth_cache_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|value| value.to_str()) != Some("json") {
                    continue;
                }
                let Some(name) = path.file_stem().and_then(|value| value.to_str()) else {
                    continue;
                };
                if let Some(headers) = read_auth_headers(&path) {
                    auth.insert(name.to_string(), headers);
                }
            }
        }
        for provider in ["mimo", "workbuddy"] {
            let path = config.auth_path(provider);
            if !auth.contains_key(provider) {
                if let Some(headers) = read_auth_headers(&path) {
                    auth.insert(provider.to_string(), headers);
                }
            }
        }
        let client = Client::builder()
            .user_agent("llm-gateway-rust/1.0")
            .connect_timeout(Duration::from_secs(15))
            .pool_max_idle_per_host(8)
            .build()?;
        Ok(Self {
            config,
            db,
            client,
            auth: Arc::new(auth),
            model_cache: Arc::new(RwLock::new(None)),
        })
    }

    fn metric(&self, protocol: &str, identity: &Identity) -> MetricContext {
        let now = now_ms();
        MetricContext {
            state: self.clone(),
            draft: Arc::new(Mutex::new(MetricDraft {
                id: Db::new_id(),
                started_at: now,
                protocol: protocol.to_string(),
                api_key_id: identity.managed.then(|| identity.key_id.clone()),
                ..MetricDraft::default()
            })),
        }
    }

    fn auth_status(&self) -> Value {
        let providers = ["mimo", "workbuddy"]
            .into_iter()
            .map(|provider| {
                let path = self.config.auth_path(provider);
                let captured_at = read_auth_captured_at(&path);
                (
                    provider.to_string(),
                    json!({
                        "ready": self.auth.contains_key(provider),
                        "capturedAt": captured_at,
                        "source": "cache"
                    }),
                )
            })
            .collect::<Map<_, _>>();
        json!({ "ready": providers.values().any(|value| value.get("ready") == Some(&Value::Bool(true))), "providers": providers })
    }

    fn requires_authentication(&self) -> bool {
        !self.config.proxy_api_key.is_empty() || self.db.count_api_keys().unwrap_or(0) > 0
    }

    fn authenticate(&self, headers: &HeaderMap) -> Option<Identity> {
        let credential = request_credential(headers);
        if self.config.proxy_api_key.is_empty() && self.db.count_api_keys().unwrap_or(0) == 0 {
            return Some(Identity {
                key_id: "anonymous".into(),
                name: "匿名访问".into(),
                managed: false,
                allowed_models: Vec::new(),
                rpm_limit: None,
                tpm_limit: None,
                quota_tokens: None,
                used_tokens: 0,
            });
        }
        if !credential.is_empty() && secret_equal(&credential, &self.config.proxy_api_key) {
            return Some(Identity {
                key_id: "environment".into(),
                name: "环境变量 API Key".into(),
                managed: false,
                allowed_models: Vec::new(),
                rpm_limit: None,
                tpm_limit: None,
                quota_tokens: None,
                used_tokens: 0,
            });
        }
        if credential.is_empty() {
            return None;
        }
        let hash = hash_secret(&credential);
        let key = self.db.find_api_key_by_hash(&hash).ok().flatten()?;
        if !key.enabled || key.expires_at.is_some_and(|expires| expires <= now_ms()) {
            return None;
        }
        Some(Identity {
            key_id: key.id,
            name: key.name,
            managed: true,
            allowed_models: key.allowed_models,
            rpm_limit: key.rpm_limit,
            tpm_limit: key.tpm_limit,
            quota_tokens: key.quota_tokens,
            used_tokens: key.used_tokens,
        })
    }

    fn admin_authorized(&self, headers: &HeaderMap) -> bool {
        let admin_key = if !self.config.proxy_admin_key.is_empty() {
            &self.config.proxy_admin_key
        } else {
            &self.config.proxy_api_key
        };
        admin_key.is_empty() || secret_equal(&request_credential(headers), admin_key)
    }

    fn authorize_model(&self, identity: &Identity, model: &str) -> Result<(), Response> {
        if identity.allowed_models.is_empty()
            || identity
                .allowed_models
                .iter()
                .any(|item| item == "*" || item == model)
        {
            return Ok(());
        }
        Err(error_response(
            StatusCode::FORBIDDEN,
            format!("API Key {} 无权访问模型 {}", identity.name, model),
            "permission_error",
        ))
    }

    fn authorize_limits(&self, identity: &Identity) -> Result<(), Response> {
        if !identity.managed {
            return Ok(());
        }
        if identity
            .quota_tokens
            .is_some_and(|quota| identity.used_tokens >= quota)
        {
            return Err(error_response(
                StatusCode::TOO_MANY_REQUESTS,
                "API Key Token 配额已用尽",
                "rate_limit_error",
            ));
        }
        let rows = self.db.metric_rows(now_ms() - 60_000).unwrap_or_default();
        let own = rows
            .iter()
            .filter(|row| row.api_key_id.as_deref() == Some(identity.key_id.as_str()))
            .collect::<Vec<_>>();
        if identity
            .rpm_limit
            .is_some_and(|limit| own.len() as i64 >= limit)
        {
            return Err(error_response(
                StatusCode::TOO_MANY_REQUESTS,
                "API Key 已达到每分钟请求上限",
                "rate_limit_error",
            ));
        }
        if let Some(limit) = identity.tpm_limit {
            let used = own
                .iter()
                .filter_map(|row| row.usage_json.as_deref())
                .filter_map(|raw| serde_json::from_str::<Value>(raw).ok())
                .filter_map(|usage| {
                    usage
                        .get("totalTokens")
                        .or_else(|| usage.get("total_tokens"))
                        .and_then(Value::as_i64)
                })
                .sum::<i64>();
            if used >= limit {
                return Err(error_response(
                    StatusCode::TOO_MANY_REQUESTS,
                    "API Key 已达到每分钟 Token 上限",
                    "rate_limit_error",
                ));
            }
        }
        Ok(())
    }

    fn select_routes(&self, model: &str) -> Result<Vec<Route>, Response> {
        let (provider, upstream_model) = if let Some((provider, model)) = model.split_once('/') {
            (provider.to_ascii_lowercase(), model.to_string())
        } else if model.eq_ignore_ascii_case("default") {
            ("workbuddy".into(), model.to_string())
        } else if model.to_ascii_lowercase().starts_with("mimo") {
            ("mimo".into(), model.to_string())
        } else {
            let known_mimo = ["mimo-x-pro-preview", "mimo-pro", "mimo-flash"];
            if known_mimo.contains(&model) {
                ("mimo".into(), model.to_string())
            } else {
                ("workbuddy".into(), model.to_string())
            }
        };
        let channels = self.db.list_channels().unwrap_or_default();
        let mut candidates: Vec<ChannelRecord> = channels
            .into_iter()
            .filter(|channel| channel.enabled && channel.provider_id == provider)
            .collect();
        candidates.sort_by(|left, right| {
            right
                .priority
                .cmp(&left.priority)
                .then_with(|| right.weight.cmp(&left.weight))
        });
        if candidates.is_empty() {
            candidates.push(ChannelRecord {
                id: format!("{provider}-default"),
                name: provider.clone(),
                provider_id: provider.clone(),
                auth_ref: provider.clone(),
                upstream_url: None,
                enabled: true,
                priority: 0,
                weight: 1,
                model_mappings: json!({}),
            });
        }
        let routes = candidates
            .into_iter()
            .filter_map(|channel| {
                if !self.auth.contains_key(&channel.auth_ref) {
                    return None;
                }
                let mapped_model = channel
                    .model_mappings
                    .get(model)
                    .or_else(|| channel.model_mappings.get(&upstream_model))
                    .or_else(|| channel.model_mappings.get("*"))
                    .and_then(Value::as_str)
                    .unwrap_or(&upstream_model)
                    .to_string();
                let upstream_url = channel
                    .upstream_url
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| {
                        if provider == "mimo" {
                            MIMO_URL.into()
                        } else {
                            WORKBUDDY_URL.into()
                        }
                    });
                Some(Route {
                    provider: provider.clone(),
                    channel_id: channel.id,
                    upstream_url,
                    upstream_model: mapped_model,
                    auth_ref: channel.auth_ref,
                })
            })
            .collect::<Vec<_>>();
        if routes.is_empty() {
            return Err(error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                format!("provider {} 尚未配置登录凭据", provider),
                "configuration_error",
            ));
        }
        Ok(routes)
    }

    async fn models(&self) -> Vec<ModelInfo> {
        if let Some(cache) = self.model_cache.read().ok().and_then(|guard| guard.clone()) {
            if cache.fetched_at.elapsed() < Duration::from_secs(300) {
                return cache.models;
            }
        }
        let mut models = fallback_models();
        if self.config.model_discovery {
            if let Some(remote) = self.fetch_mimo_models().await {
                for model in remote {
                    if !models.iter().any(|current| current.id == model.id) {
                        models.push(model);
                    }
                }
            }
            let mut workbuddy_files = Vec::new();
            if let Some(path) = &self.config.model_file {
                workbuddy_files.push(path.clone());
            }
            if let Some(home) = dirs::home_dir() {
                workbuddy_files.push(home.join(".workbuddy/cache/acc-product-config-v3.json"));
            }
            if cfg!(target_os = "macos") {
                workbuddy_files.push(PathBuf::from("/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/product.json"));
            }
            for path in workbuddy_files {
                if let Ok(raw) = std::fs::read_to_string(path) {
                    let discovered = parse_models(&raw, "workbuddy");
                    if !discovered.is_empty() {
                        models.extend(discovered);
                        break;
                    }
                }
            }
        }
        let mut seen = HashSet::new();
        models.retain(|model| seen.insert(model.id.clone()));
        if let Ok(mut cache) = self.model_cache.write() {
            *cache = Some(ModelCache {
                fetched_at: Instant::now(),
                models: models.clone(),
            });
        }
        models
    }

    async fn fetch_mimo_models(&self) -> Option<Vec<ModelInfo>> {
        let headers = self.auth.get("mimo")?;
        let request = self.client.get(MIMO_MODELS_URL).headers(headers.clone());
        let response = timeout(
            Duration::from_millis(self.config.model_discovery_timeout_ms),
            request.send(),
        )
        .await
        .ok()?
        .ok()?;
        let body = response.text().await.ok()?;
        let models = parse_models(&body, "mimo");
        (!models.is_empty()).then_some(models)
    }
}

impl MetricContext {
    fn set_route(&self, route: &Route, model: &str) {
        if let Ok(mut draft) = self.draft.lock() {
            draft.provider = Some(route.provider.clone());
            draft.channel_id = Some(route.channel_id.clone());
            draft.model = Some(model.to_string());
        }
    }

    fn finish(
        &self,
        status: &str,
        code: Option<StatusCode>,
        finish_reason: Option<&str>,
        usage: Option<&Value>,
    ) {
        let mut guard = match self.draft.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        if guard.finished {
            return;
        }
        guard.finished = true;
        guard.status = Some(status.to_string());
        guard.status_code = code.map(|value| value.as_u16() as i64);
        guard.finish_reason = finish_reason.map(str::to_string);
        guard.usage_json = usage.map(Value::to_string);
        let completed_at = now_ms();
        let record = MetricRecord {
            id: guard.id.clone(),
            started_at: guard.started_at,
            completed_at,
            protocol: guard.protocol.clone(),
            provider: guard.provider.clone(),
            channel_id: guard.channel_id.clone(),
            model: guard.model.clone(),
            status: guard.status.clone().unwrap_or_else(|| "error".into()),
            status_code: guard.status_code,
            finish_reason: guard.finish_reason.clone(),
            api_key_id: guard.api_key_id.clone(),
            usage_json: guard.usage_json.clone(),
        };
        drop(guard);
        if let Err(error) = self.state.db.insert_metric(&record) {
            warn!(%error, "写入 SQLite 指标失败");
        }
        if let Some(usage) = usage {
            let tokens = usage
                .get("total_tokens")
                .or_else(|| usage.get("totalTokens"))
                .and_then(Value::as_i64)
                .unwrap_or(0);
            if tokens > 0 {
                if let Some(key_id) = record.api_key_id.as_deref() {
                    let _ = self.state.db.add_usage(key_id, tokens);
                }
            }
        }
        let _ = self
            .state
            .db
            .prune_metrics(self.state.config.metrics_max_records);
    }
}

impl Drop for MetricContext {
    fn drop(&mut self) {
        // A client disconnect drops the stream before the upstream reaches EOF.
        // The last metric handle records that request as canceled so an
        // abandoned stream cannot remain invisible in SQLite forever.
        if Arc::strong_count(&self.draft) == 1 {
            self.finish("canceled", Some(StatusCode::REQUEST_TIMEOUT), None, None);
        }
    }
}

pub fn router(state: AppState) -> Router {
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

pub async fn serve(state: AppState) -> anyhow::Result<()> {
    let address = format!("{}:{}", state.config.bind_host, state.config.port);
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
        return response;
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
        Err(response) => return response,
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
        return response;
    }
    let routes = match state.select_routes(&model) {
        Ok(routes) => routes,
        Err(response) => return response,
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
        let bytes = match response.bytes().await {
            Ok(bytes) => bytes,
            Err(error) => {
                debug!(%error, "读取上游响应失败");
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

fn build_upstream_body(body: &Value, route: &Route, responses_mode: bool) -> Value {
    let mut output = body.clone();
    if let Some(object) = output.as_object_mut() {
        object.insert("model".into(), Value::String(route.upstream_model.clone()));
        object.insert("stream".into(), Value::Bool(true));
        if responses_mode {
            object.remove("input");
            object.remove("instructions");
            if let Some(max_output_tokens) = object.remove("max_output_tokens") {
                object.entry("max_tokens").or_insert(max_output_tokens);
            }
        }
        if route.provider == "mimo" {
            if let Some(max_tokens) = object.remove("max_tokens") {
                object.entry("max_completion_tokens").or_insert(max_tokens);
            }
        }
        if let Some(messages) = object.get_mut("messages").and_then(Value::as_array_mut) {
            for message in messages {
                if message.get("role").and_then(Value::as_str) == Some("developer") {
                    if let Some(map) = message.as_object_mut() {
                        map.insert("role".into(), Value::String("system".into()));
                    }
                }
            }
        }
        if object.get("reasoning_effort").and_then(Value::as_str) == Some("none") {
            object.remove("reasoning_effort");
            object.insert("thinking".into(), json!({ "type": "disabled" }));
        }
    }
    output
}

fn responses_to_chat(body: &Value) -> Value {
    let mut chat = Map::new();
    if let Some(model) = body.get("model") {
        chat.insert("model".into(), model.clone());
    }
    if let Some(stream) = body.get("stream") {
        chat.insert("stream".into(), stream.clone());
    }
    let mut messages = Vec::new();
    if let Some(instructions) = body.get("instructions").and_then(Value::as_str) {
        messages.push(json!({ "role": "system", "content": instructions }));
    }
    if let Some(input) = body.get("input") {
        if let Some(text) = input.as_str() {
            messages.push(json!({ "role": "user", "content": text }));
        } else if let Some(items) = input.as_array() {
            for item in items {
                if item.get("role").is_some() {
                    messages.push(json!({
                        "role": item.get("role").cloned().unwrap_or_else(|| json!("user")),
                        "content": item.get("content").cloned().unwrap_or_else(|| json!(""))
                    }));
                }
            }
        }
    }
    chat.insert("messages".into(), Value::Array(messages));
    for key in [
        "temperature",
        "top_p",
        "max_output_tokens",
        "reasoning_effort",
        "tools",
        "tool_choice",
    ] {
        if let Some(value) = body.get(key) {
            chat.insert(key.into(), value.clone());
        }
    }
    Value::Object(chat)
}

fn chat_to_response(body: &Value, model: &str) -> Value {
    let choice = body
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|items| items.first());
    let message = choice
        .and_then(|choice| choice.get("message"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let text = message
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default();
    json!({
        "id": body.get("id").cloned().unwrap_or_else(|| json!(format!("resp_{}", Db::new_id()))),
        "object": "response",
        "created_at": now_ms() / 1000,
        "model": if model.is_empty() { body.get("model").and_then(Value::as_str).unwrap_or("default") } else { model },
        "output": [{
            "type": "message",
            "id": format!("msg_{}", Db::new_id()),
            "role": "assistant",
            "content": [{ "type": "output_text", "text": text, "annotations": [] }]
        }],
        "status": "completed",
        "usage": body.get("usage").cloned().unwrap_or_else(|| json!({}))
    })
}

fn parse_upstream_response(bytes: &[u8], model: &str) -> (Value, Option<Value>, Option<String>) {
    if let Ok(value) = serde_json::from_slice::<Value>(bytes) {
        if value.get("choices").is_some() {
            return (
                normalize_chat_response(value.clone(), model),
                value.get("usage").cloned(),
                value
                    .get("choices")
                    .and_then(Value::as_array)
                    .and_then(|items| items.first())
                    .and_then(|choice| choice.get("finish_reason"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
            );
        }
    }
    let text = String::from_utf8_lossy(bytes);
    let mut id = format!("chatcmpl-{}", Db::new_id());
    let mut content = String::new();
    let mut reasoning = String::new();
    let mut finish_reason = None;
    let mut usage = None;
    for block in text.split("\n\n") {
        let data = block
            .lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(str::trim)
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        if let Some(value_id) = value.get("id").and_then(Value::as_str) {
            id = value_id.to_string();
        }
        if let Some(choice) = value
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
        {
            if let Some(delta) = choice.get("delta") {
                append_content(&mut content, delta.get("content"));
                append_content(
                    &mut reasoning,
                    delta
                        .get("reasoning_content")
                        .or_else(|| delta.get("reasoning")),
                );
            }
            finish_reason = choice
                .get("finish_reason")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or(finish_reason);
        }
        if let Some(value_usage) = value.get("usage") {
            usage = Some(normalize_usage(value_usage));
        }
    }
    let mut message = json!({ "role": "assistant", "content": content });
    if !reasoning.is_empty() {
        message["reasoning_content"] = Value::String(reasoning);
    }
    let output = json!({
        "id": id,
        "object": "chat.completion",
        "created": now_ms() / 1000,
        "model": model,
        "choices": [{ "index": 0, "message": message, "finish_reason": finish_reason.clone().unwrap_or_else(|| "stop".into()) }],
        "usage": usage.clone().unwrap_or_else(|| json!({}))
    });
    (output, usage, finish_reason)
}

fn normalize_chat_response(mut value: Value, model: &str) -> Value {
    if let Some(object) = value.as_object_mut() {
        object
            .entry("model")
            .or_insert_with(|| Value::String(model.to_string()));
        if let Some(usage) = object.get("usage").cloned() {
            object.insert("usage".into(), normalize_usage(&usage));
        }
    }
    value
}

fn normalize_usage(value: &Value) -> Value {
    let object = value.as_object().cloned().unwrap_or_default();
    let mut output = Map::new();
    for (target, keys) in [
        (
            "inputTokens",
            vec!["inputTokens", "input_tokens", "prompt_tokens"],
        ),
        (
            "outputTokens",
            vec!["outputTokens", "output_tokens", "completion_tokens"],
        ),
        (
            "totalTokens",
            vec!["totalTokens", "total_tokens", "total_tokens"],
        ),
        (
            "reasoningTokens",
            vec!["reasoningTokens", "reasoning_tokens"],
        ),
        ("cachedTokens", vec!["cachedTokens", "cached_tokens"]),
    ] {
        if let Some(found) = keys
            .iter()
            .find_map(|key| object.get(*key).and_then(Value::as_i64))
        {
            output.insert(target.into(), Value::Number(found.into()));
        }
    }
    if output.get("totalTokens").is_none() {
        let total = output
            .get("inputTokens")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            + output
                .get("outputTokens")
                .and_then(Value::as_i64)
                .unwrap_or(0);
        if total > 0 {
            output.insert("totalTokens".into(), Value::Number(total.into()));
        }
    }
    Value::Object(output)
}

fn append_content(target: &mut String, value: Option<&Value>) {
    match value {
        Some(Value::String(text)) => target.push_str(text),
        Some(Value::Array(items)) => {
            for item in items {
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    target.push_str(text);
                }
            }
        }
        _ => {}
    }
}

async fn list_channels(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(response) = require_admin(&state, &headers) {
        return response;
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
        return response;
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
        return response;
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
        return response;
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
        return response;
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
        return response;
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
        return response;
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

#[derive(Clone, Debug, Deserialize)]
struct MetricQuery {
    window: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    status: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
    bucket: Option<String>,
}

#[derive(Clone, Copy)]
enum MetricView {
    Summary,
    Timeseries,
    Requests,
}

async fn metrics_response(
    state: &AppState,
    headers: &HeaderMap,
    query: &MetricQuery,
    admin: bool,
    view: MetricView,
) -> Response {
    let identity = if admin {
        if let Err(response) = require_admin(state, headers) {
            return response;
        }
        None
    } else {
        match require_public_auth_identity(state, headers) {
            Ok(identity) => Some(identity),
            Err(response) => return response,
        }
    };
    let since = now_ms() - parse_window(query.window.as_deref()).as_millis() as i64;
    let mut rows = match state.db.metric_rows(since) {
        Ok(rows) => rows,
        Err(error) => return database_error(error),
    };
    rows.retain(|row| {
        query
            .provider
            .as_deref()
            .is_none_or(|value| row.provider.as_deref() == Some(value))
            && query
                .model
                .as_deref()
                .is_none_or(|value| row.model.as_deref() == Some(value))
            && query
                .status
                .as_deref()
                .is_none_or(|value| row.status == value)
            && identity
                .as_ref()
                .is_none_or(|identity| row.api_key_id.as_deref() == Some(identity.key_id.as_str()))
    });
    match view {
        MetricView::Summary => Json(summary_json(&rows)).into_response(),
        MetricView::Requests => {
            let offset = query.offset.unwrap_or(0);
            let limit = query.limit.unwrap_or(50).clamp(1, 500);
            let data = rows
                .iter()
                .skip(offset)
                .take(limit)
                .map(metric_json)
                .collect::<Vec<_>>();
            Json(json!({ "data": data, "total": rows.len() })).into_response()
        }
        MetricView::Timeseries => {
            Json(json!({ "data": timeseries_json(&rows, query.bucket.as_deref()) })).into_response()
        }
    }
}

fn summary_json(rows: &[MetricRow]) -> Value {
    let requests = rows.len() as i64;
    let successes = rows.iter().filter(|row| row.status == "success").count() as i64;
    let errors = rows.iter().filter(|row| row.status == "error").count() as i64;
    let canceled = rows.iter().filter(|row| row.status == "canceled").count() as i64;
    let durations = rows
        .iter()
        .map(|row| row.completed_at - row.started_at)
        .filter(|value| *value >= 0)
        .collect::<Vec<_>>();
    let tokens = aggregate_usage(rows);
    json!({
        "requests": requests,
        "successes": successes,
        "errors": errors,
        "canceled": canceled,
        "successRate": if requests > 0 { json!(successes as f64 / requests as f64) } else { Value::Null },
        "activeRequests": 0,
        "latency": {
            "averageMs": average(&durations),
            "p50Ms": percentile(&durations, 0.50),
            "p95Ms": percentile(&durations, 0.95),
            "maxMs": durations.iter().max().copied()
        },
        "tokens": tokens,
        "byProvider": groups_json(rows, |row| row.provider.clone().unwrap_or_else(|| "unknown".into())),
        "byChannel": groups_json(rows, |row| row.channel_id.clone().unwrap_or_else(|| "unknown".into())),
        "byModel": groups_json(rows, |row| row.model.clone().unwrap_or_else(|| "unknown".into())),
        "byApiKey": groups_json(rows, |row| row.api_key_id.clone().unwrap_or_else(|| "anonymous".into()))
    })
}

fn groups_json<F>(rows: &[MetricRow], key: F) -> Vec<Value>
where
    F: Fn(&MetricRow) -> String,
{
    let mut groups: HashMap<String, Vec<&MetricRow>> = HashMap::new();
    for row in rows {
        groups.entry(key(row)).or_default().push(row);
    }
    groups.into_iter().map(|(name, items)| {
        let total = items.len() as i64;
        let successes = items.iter().filter(|row| row.status == "success").count() as i64;
        let durations = items.iter().map(|row| row.completed_at - row.started_at).collect::<Vec<_>>();
        json!({ "key": name, "requests": total, "successes": successes, "errors": items.iter().filter(|row| row.status == "error").count(), "successRate": if total > 0 { json!(successes as f64 / total as f64) } else { Value::Null }, "averageMs": average(&durations), "tokens": aggregate_usage_refs(&items) })
    }).collect()
}

fn timeseries_json(rows: &[MetricRow], bucket: Option<&str>) -> Vec<Value> {
    let bucket_ms = bucket
        .map(|value| parse_window(Some(value)))
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(60 * 60 * 1000)
        .max(60_000);
    let mut groups: HashMap<i64, Vec<&MetricRow>> = HashMap::new();
    for row in rows {
        let start = row.started_at / bucket_ms * bucket_ms;
        groups.entry(start).or_default().push(row);
    }
    let mut output = groups.into_iter().map(|(start, items)| {
        json!({ "start": start, "end": start + bucket_ms, "requests": items.len(), "successes": items.iter().filter(|row| row.status == "success").count(), "errors": items.iter().filter(|row| row.status == "error").count(), "canceled": items.iter().filter(|row| row.status == "canceled").count(), "durationMs": items.iter().map(|row| row.completed_at-row.started_at).sum::<i64>(), "tokens": aggregate_usage_refs(&items) })
    }).collect::<Vec<_>>();
    output.sort_by_key(|value| value.get("start").and_then(Value::as_i64).unwrap_or(0));
    output
}

fn metric_json(row: &MetricRow) -> Value {
    json!({
        "id": row.id,
        "startedAt": row.started_at,
        "completedAt": row.completed_at,
        "durationMs": row.completed_at - row.started_at,
        "protocol": row.protocol,
        "provider": row.provider,
        "channelId": row.channel_id,
        "model": row.model,
        "status": row.status,
        "statusCode": row.status_code,
        "finishReason": row.finish_reason,
        "usage": row.usage_json.as_deref().and_then(|raw| serde_json::from_str::<Value>(raw).ok())
    })
}

fn aggregate_usage(rows: &[MetricRow]) -> Value {
    let refs = rows.iter().collect::<Vec<_>>();
    aggregate_usage_refs(&refs)
}

fn aggregate_usage_refs(rows: &[&MetricRow]) -> Value {
    let mut output = Map::new();
    for (target, aliases) in [
        (
            "inputTokens",
            &["inputTokens", "input_tokens", "prompt_tokens"] as &[&str],
        ),
        (
            "outputTokens",
            &["outputTokens", "output_tokens", "completion_tokens"],
        ),
        ("reasoningTokens", &["reasoningTokens", "reasoning_tokens"]),
        ("cachedTokens", &["cachedTokens", "cached_tokens"]),
        ("totalTokens", &["totalTokens", "total_tokens"]),
    ] {
        let sum = rows
            .iter()
            .filter_map(|row| row.usage_json.as_deref())
            .filter_map(|raw| serde_json::from_str::<Value>(raw).ok())
            .filter_map(|value| {
                aliases
                    .iter()
                    .find_map(|alias| value.get(*alias).and_then(Value::as_i64))
            })
            .sum::<i64>();
        output.insert(target.into(), Value::Number(sum.into()));
    }
    output.insert(
        "requestsWithUsage".into(),
        Value::Number((rows.iter().filter(|row| row.usage_json.is_some()).count() as i64).into()),
    );
    Value::Object(output)
}

fn average(values: &[i64]) -> Value {
    if values.is_empty() {
        Value::Null
    } else {
        json!(values.iter().sum::<i64>() as f64 / values.len() as f64)
    }
}
fn percentile(values: &[i64], fraction: f64) -> Value {
    if values.is_empty() {
        return Value::Null;
    }
    let mut values = values.to_vec();
    values.sort_unstable();
    let index = ((values.len() - 1) as f64 * fraction).round() as usize;
    json!(values[index])
}

fn public_key(key: ApiKeyRecord) -> Value {
    json!({ "id": key.id, "name": key.name, "prefix": key.prefix, "enabled": key.enabled, "createdAt": key.created_at, "expiresAt": key.expires_at, "allowedModels": key.allowed_models, "rpmLimit": key.rpm_limit, "tpmLimit": key.tpm_limit, "quotaTokens": key.quota_tokens, "usedTokens": key.used_tokens, "remainingTokens": key.quota_tokens.map(|quota| (quota-key.used_tokens).max(0)) })
}

fn fallback_models() -> Vec<ModelInfo> {
    vec![
        ModelInfo {
            id: "mimo-x-pro-preview".into(),
            name: "MiMo X Pro Preview".into(),
            provider: "mimo".into(),
            owned_by: "mimo".into(),
            capabilities: [("chat".into(), true), ("reasoning".into(), true)]
                .into_iter()
                .collect(),
            reasoning_efforts: Some(
                [
                    ("off".into(), None),
                    ("minimal".into(), Some("low".into())),
                    ("low".into(), Some("low".into())),
                    ("medium".into(), Some("medium".into())),
                    ("high".into(), Some("high".into())),
                    ("xhigh".into(), Some("xhigh".into())),
                    ("max".into(), Some("max".into())),
                ]
                .into_iter()
                .collect(),
            ),
            default_reasoning_effort: Some("medium".into()),
        },
        ModelInfo {
            id: "mimo-pro".into(),
            name: "MiMo Pro".into(),
            provider: "mimo".into(),
            owned_by: "mimo".into(),
            capabilities: [("chat".into(), true)].into_iter().collect(),
            reasoning_efforts: None,
            default_reasoning_effort: None,
        },
        ModelInfo {
            id: "mimo-flash".into(),
            name: "MiMo Flash".into(),
            provider: "mimo".into(),
            owned_by: "mimo".into(),
            capabilities: [("chat".into(), true)].into_iter().collect(),
            reasoning_efforts: None,
            default_reasoning_effort: None,
        },
        ModelInfo {
            id: "default".into(),
            name: "WorkBuddy Default".into(),
            provider: "workbuddy".into(),
            owned_by: "workbuddy".into(),
            capabilities: [("chat".into(), true)].into_iter().collect(),
            reasoning_efforts: None,
            default_reasoning_effort: None,
        },
    ]
}

fn parse_models(raw: &str, provider: &str) -> Vec<ModelInfo> {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    let root = value.as_object();
    let mut values = Vec::new();
    if let Some(root) = root {
        if let Some(models) = root.get("models").and_then(Value::as_array) {
            values.extend(models.iter());
        }
        if let Some(data) = root.get("data") {
            if let Some(data_items) = data.as_array() {
                values.extend(data_items.iter());
            }
            if let Some(data_object) = data.as_object() {
                if let Some(models) = data_object.get("models").and_then(Value::as_array) {
                    values.extend(models.iter());
                }
                if let Some(groups) = data_object.get("groups").and_then(Value::as_array) {
                    for group in groups {
                        if let Some(models) = group.get("models").and_then(Value::as_array) {
                            values.extend(models.iter());
                        }
                    }
                }
            }
        }
    }
    if values.is_empty() && model_id(&value).is_some() {
        values.push(&value);
    }
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter_map(|value| {
            let id = model_id(value)?;
            if !valid_model_id(&id) || !seen.insert(id.clone()) {
                return None;
            }
            let mut capabilities = [("chat".into(), true)]
                .into_iter()
                .collect::<HashMap<_, _>>();
            let reasoning = value
                .get("supportsReasoning")
                .and_then(Value::as_bool)
                .or_else(|| value.get("reasoning").and_then(Value::as_bool))
                .unwrap_or_else(|| value.get("reasoningEfforts").is_some());
            if reasoning {
                capabilities.insert("reasoning".into(), true);
            }
            Some(ModelInfo {
                id: id.clone(),
                name: value
                    .get("displayName")
                    .or_else(|| value.get("name"))
                    .or_else(|| value.get("label"))
                    .and_then(Value::as_str)
                    .unwrap_or(&id)
                    .to_string(),
                provider: provider.into(),
                owned_by: provider.into(),
                capabilities,
                reasoning_efforts: None,
                default_reasoning_effort: None,
            })
        })
        .collect()
}

fn model_id(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_string)
        .or_else(|| value.get("id").and_then(Value::as_str).map(str::to_string))
        .or_else(|| {
            value
                .get("modelName")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .or_else(|| {
            value
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
}

fn valid_model_id(id: &str) -> bool {
    let id = id.trim();
    !id.is_empty()
        && id.len() <= 128
        && !id.chars().any(char::is_whitespace)
        && !id.ends_with(".json")
        && !id.contains('/')
        && (id == "default" || id.contains('-') || id.contains('.') || id.contains('_'))
}

fn read_auth_headers(path: &PathBuf) -> Option<HeaderMap> {
    let raw = std::fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    let object = value
        .get("headers")
        .and_then(Value::as_object)
        .or_else(|| value.as_object());
    let Some(object) = object else { return None };
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
    (!headers.is_empty()).then_some(headers)
}

fn read_auth_captured_at(path: &PathBuf) -> Option<i64> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&raw)
        .ok()?
        .get("capturedAt")
        .and_then(Value::as_i64)
}

fn is_forwarded_header(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    matches!(
        name.as_str(),
        "authorization" | "cookie" | "x-api-key" | "x-goog-api-key"
    ) || name.starts_with("x-")
}

fn request_credential(headers: &HeaderMap) -> String {
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

fn require_public_auth(state: &AppState, headers: &HeaderMap) -> Result<(), Response> {
    let _ = require_public_auth_identity(state, headers)?;
    Ok(())
}

fn require_public_auth_identity(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Identity, Response> {
    let identity = state.authenticate(headers);
    if identity.is_none()
        || (!state.config.is_loopback()
            && !identity
                .as_ref()
                .is_some_and(|identity| identity.managed || identity.key_id == "environment"))
    {
        return Err(error_response(
            StatusCode::UNAUTHORIZED,
            "缺少或无效的代理 API Key",
            "authentication_error",
        ));
    }
    let identity = identity.expect("checked above");
    state.authorize_limits(&identity)?;
    Ok(identity)
}

fn require_admin(state: &AppState, headers: &HeaderMap) -> Result<(), Response> {
    if !state.config.is_loopback() && state.config.proxy_admin_key.is_empty() {
        return Err(error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "非本地监听必须配置 PROXY_ADMIN_KEY",
            "configuration_error",
        ));
    }
    if !state.admin_authorized(headers) {
        return Err(error_response(
            StatusCode::UNAUTHORIZED,
            "缺少或无效的管理员 API Key",
            "authentication_error",
        ));
    }
    Ok(())
}

fn error_response(status: StatusCode, message: impl Into<String>, error_type: &str) -> Response {
    (
        status,
        Json(json!({ "error": { "message": message.into(), "type": error_type } })),
    )
        .into_response()
}

fn database_error(error: impl std::fmt::Display) -> Response {
    error!(%error, "SQLite 操作失败");
    error_response(
        StatusCode::INTERNAL_SERVER_ERROR,
        "数据库操作失败",
        "internal_error",
    )
}

fn hash_secret(secret: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(secret.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn secret_equal(left: &str, right: &str) -> bool {
    left.as_bytes().ct_eq(right.as_bytes()).into()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn string_array(value: Option<&Value>) -> Vec<String> {
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

fn parse_window(value: Option<&str>) -> Duration {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_parser_only_reads_model_collections() {
        let raw = r#"{
          "models": [{"id":"deepseek-v4-pro","name":"DeepSeek"}],
          "prompts": [{"name":"agent-prompt","template":"do not expose this"}],
          "tools": ["tool-skill-description"]
        }"#;
        let models = parse_models(raw, "workbuddy");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "deepseek-v4-pro");
    }

    #[test]
    fn stream_accumulator_handles_chunk_boundaries_and_usage() {
        let mut accumulator = StreamAccumulator::default();
        accumulator.observe(b"data: {\"choices\":[],\"usage\":{\"total_tokens\":7}}\n");
        accumulator.observe(b"\n");
        assert_eq!(
            accumulator
                .usage
                .as_ref()
                .and_then(|usage| usage.get("totalTokens"))
                .and_then(Value::as_i64),
            Some(7)
        );
    }
}
