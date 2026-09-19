use crate::config::Config;
use crate::db::{ChannelRecord, Db, MetricRecord};
use axum::http::{HeaderMap, StatusCode};
use reqwest::Client;
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use tokio::time::timeout;
use tracing::warn;

mod auth;
mod http;
mod metrics;
mod model_catalog;
mod protocols;
mod sync;

pub(crate) use http::serve;
pub(crate) use sync::{RemoteSyncPullResult, RemoteSyncSettings, RemoteSyncStatus};

use auth::{
    GatewayError, error_response, hash_secret, now_ms, read_auth_captured_at, read_auth_headers,
    request_credential, secret_equal,
};
use model_catalog::{ModelCache, ModelInfo, fallback_models, parse_models};

const MIMO_URL: &str = "https://mimo-server-cn.xiaomimimo.com/api/route/chat/completions";
const MIMO_MODELS_URL: &str = "https://mimo-server-cn.xiaomimimo.com/api/model/list";
const WORKBUDDY_URL: &str = "https://copilot.tencent.com/v2/chat/completions";

fn load_auth_cache(config: &Config) -> HashMap<String, HeaderMap> {
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
    auth
}

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub db: Db,
    pub client: Client,
    auth: Arc<RwLock<HashMap<String, HeaderMap>>>,
    model_cache: Arc<RwLock<Option<ModelCache>>>,
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

        let auth = load_auth_cache(&config);
        let client = Client::builder()
            .user_agent("llm-gateway-rust/1.0")
            .connect_timeout(Duration::from_secs(15))
            .pool_max_idle_per_host(8)
            .build()?;
        Ok(Self {
            config,
            db,
            client,
            auth: Arc::new(RwLock::new(auth)),
            model_cache: Arc::new(RwLock::new(None)),
        })
    }

    pub(crate) async fn remote_sync_status(
        &self,
        settings: RemoteSyncSettings,
    ) -> anyhow::Result<RemoteSyncStatus> {
        sync::status(self, settings).await
    }

    pub(crate) async fn remote_sync_pull(
        &self,
        settings: RemoteSyncSettings,
        passphrase: String,
        force: bool,
    ) -> anyhow::Result<RemoteSyncPullResult> {
        sync::pull(self, settings, passphrase, force).await
    }

    pub(crate) fn reload_auth_cache(&self) -> anyhow::Result<()> {
        let auth = load_auth_cache(&self.config);
        let mut current = self
            .auth
            .write()
            .map_err(|_| anyhow::anyhow!("认证缓存锁已失效"))?;
        *current = auth;
        if let Ok(mut cache) = self.model_cache.write() {
            *cache = None;
        }
        Ok(())
    }

    pub(crate) fn auth_headers(&self, auth_ref: &str) -> Option<HeaderMap> {
        self.auth
            .read()
            .ok()
            .and_then(|auth| auth.get(auth_ref).cloned())
    }

    fn has_auth(&self, auth_ref: &str) -> bool {
        self.auth
            .read()
            .ok()
            .is_some_and(|auth| auth.contains_key(auth_ref))
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
                    "ready": self.has_auth(provider),
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

    fn authorize_model(&self, identity: &Identity, model: &str) -> Result<(), GatewayError> {
        if identity.allowed_models.is_empty()
            || identity
                .allowed_models
                .iter()
                .any(|item| item == "*" || item == model)
        {
            return Ok(());
        }
        Err(Box::new(error_response(
            StatusCode::FORBIDDEN,
            format!("API Key {} 无权访问模型 {}", identity.name, model),
            "permission_error",
        )))
    }

    fn authorize_limits(&self, identity: &Identity) -> Result<(), GatewayError> {
        if !identity.managed {
            return Ok(());
        }
        if identity
            .quota_tokens
            .is_some_and(|quota| identity.used_tokens >= quota)
        {
            return Err(Box::new(error_response(
                StatusCode::TOO_MANY_REQUESTS,
                "API Key Token 配额已用尽",
                "rate_limit_error",
            )));
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
            return Err(Box::new(error_response(
                StatusCode::TOO_MANY_REQUESTS,
                "API Key 已达到每分钟请求上限",
                "rate_limit_error",
            )));
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
                return Err(Box::new(error_response(
                    StatusCode::TOO_MANY_REQUESTS,
                    "API Key 已达到每分钟 Token 上限",
                    "rate_limit_error",
                )));
            }
        }
        Ok(())
    }

    fn select_routes(&self, model: &str) -> Result<Vec<Route>, GatewayError> {
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
                if !self.has_auth(&channel.auth_ref) {
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
            return Err(Box::new(error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                format!("provider {} 尚未配置登录凭据", provider),
                "configuration_error",
            )));
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
        let headers = self.auth_headers("mimo")?;
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
        let mut accumulator = protocols::StreamAccumulator::default();
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
