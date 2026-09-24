use super::auth::AuthCache;
use crate::config::Config;
use reqwest::Client;
use serde_json::{Map, json};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tracing::warn;

const MIMO_MODELS_URL: &str = "https://mimo-server-cn.xiaomimimo.com/api/model/list";
const WORKBUDDY_MODELS_URL: &str = "https://copilot.tencent.com/v3/config";
// /v3/config selects its catalog by platform as well as client version.
// Older auth vaults omitted User-Agent; WorkBuddy alone returns a legacy catalog.
const WORKBUDDY_USER_AGENT: &str = "CLI/5.5.6 WorkBuddy/5.5.6";

#[derive(Clone)]
pub(super) struct ModelCatalog {
    client: Client,
    auth: AuthCache,
    cache: Arc<RwLock<Option<ModelCache>>>,
    refresh: Arc<tokio::sync::Mutex<()>>,
}

impl ModelCatalog {
    pub fn snapshot(&self) -> Vec<ModelInfo> {
        self.cache
            .read()
            .ok()
            .and_then(|cache| cache.as_ref().map(|cache| cache.models.clone()))
            .unwrap_or_default()
    }
    pub fn new(client: Client, auth: AuthCache) -> Self {
        Self {
            client,
            auth,
            cache: Arc::new(RwLock::new(None)),
            refresh: Arc::new(tokio::sync::Mutex::new(())),
        }
    }
    pub async fn reload_auth(&self, config: &Config) -> anyhow::Result<()> {
        let _refresh = self.refresh.lock().await;
        self.auth.reload(config)?;
        *self
            .cache
            .write()
            .map_err(|_| anyhow::anyhow!("模型缓存锁已失效"))? = None;
        Ok(())
    }
    #[cfg(test)]
    pub fn expire(&self) {
        if let Some(cache) = self.cache.write().unwrap().as_mut() {
            cache.fetched_at = Instant::now() - Duration::from_secs(301);
        }
    }
    pub async fn models(&self, config: &Config) -> Vec<ModelInfo> {
        self.models_from(config, MIMO_MODELS_URL, WORKBUDDY_MODELS_URL)
            .await
    }

    pub async fn models_from(
        &self,
        config: &Config,
        mimo_url: &str,
        workbuddy_url: &str,
    ) -> Vec<ModelInfo> {
        // Startup, health checks and the console can all request models concurrently.
        let _refresh = self.refresh.lock().await;
        if let Some(cache) = self.cache.read().ok().and_then(|guard| guard.clone()) {
            if cache.fetched_at.elapsed() < Duration::from_secs(300) {
                return cache.models;
            }
        }
        let mut models = Vec::new();
        if config.model_discovery {
            let (mimo, workbuddy) = tokio::join!(
                self.fetch_mimo_models(config, mimo_url),
                self.fetch_workbuddy_models(config, workbuddy_url),
            );
            if let Some(remote) = mimo {
                models.extend(remote);
            }
            if let Some(remote) = workbuddy {
                if let Err(error) = save_workbuddy_catalog(&config.runtime_dir, &remote) {
                    warn!(%error, "无法保存 WorkBuddy 模型缓存，当前会话仍使用远端目录");
                }
                models.extend(remote);
            } else {
                models.extend(self.local_workbuddy_models(config));
            }
        }
        let mut seen = HashSet::new();
        models.retain(|model| seen.insert((model.provider.clone(), model.id.clone())));
        if let Ok(mut cache) = self.cache.write() {
            *cache = Some(ModelCache {
                fetched_at: Instant::now(),
                models: models.clone(),
            });
        }
        models
    }

    fn local_workbuddy_models(&self, config: &Config) -> Vec<ModelInfo> {
        let mut workbuddy_files = Vec::new();
        if let Some(path) = &config.model_file {
            workbuddy_files.push(path.clone());
        }
        workbuddy_files.push(workbuddy_catalog_path(&config.runtime_dir));
        // Client product files can contain bundled defaults merged into their cache.
        // Only use an explicit catalog or models previously fetched by this gateway.
        for path in workbuddy_files {
            if let Ok(raw) = std::fs::read_to_string(path) {
                let discovered = parse_models(&raw, "workbuddy");
                if !discovered.is_empty() {
                    return discovered;
                }
            }
        }
        Vec::new()
    }

    pub(super) async fn fetch_workbuddy_models(
        &self,
        config: &Config,
        endpoint: &str,
    ) -> Option<Vec<ModelInfo>> {
        let mut headers = self.auth.headers("workbuddy")?;
        headers
            .entry(axum::http::header::USER_AGENT)
            .or_insert(axum::http::HeaderValue::from_static(WORKBUDDY_USER_AGENT));
        let response = match self
            .client
            .get(endpoint)
            .headers(headers)
            .header("accept", "application/json")
            .timeout(Duration::from_millis(config.model_discovery_timeout_ms))
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => response,
            Ok(response) => {
                warn!(status = %response.status(), "WorkBuddy 模型目录请求失败，使用本地缓存");
                return None;
            }
            Err(error) => {
                warn!(%error, "WorkBuddy 模型目录请求失败，使用本地缓存");
                return None;
            }
        };
        let body = match response.text().await {
            Ok(body) => body,
            Err(error) => {
                warn!(%error, "读取 WorkBuddy 模型目录失败，使用本地缓存");
                return None;
            }
        };
        let Ok(value) = serde_json::from_str::<Map<String, Value>>(&body) else {
            warn!("WorkBuddy 配置不是有效 JSON，保留本地缓存");
            return None;
        };
        if let Some(code) = value.get("code") {
            if code != &json!(0) && code != &json!("0") {
                warn!("WorkBuddy 配置返回业务错误，保留本地缓存");
                return None;
            }
        }
        let models = parse_models(&body, "workbuddy");
        if models.is_empty() {
            warn!("WorkBuddy 配置未返回有效模型，保留本地缓存");
            return None;
        }
        Some(models)
    }

    async fn fetch_mimo_models(&self, config: &Config, endpoint: &str) -> Option<Vec<ModelInfo>> {
        let headers = self.auth.headers("mimo")?;
        let response = self
            .client
            .get(endpoint)
            .headers(headers)
            .timeout(Duration::from_millis(config.model_discovery_timeout_ms))
            .send()
            .await
            .ok()?
            .error_for_status()
            .ok()?;
        let body = response.text().await.ok()?;
        let models = parse_models(&body, "mimo");
        (!models.is_empty()).then_some(models)
    }
}

use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Instant;

pub(super) fn workbuddy_catalog_path(runtime_dir: &Path) -> PathBuf {
    runtime_dir.join("models").join("workbuddy.json")
}

pub(super) fn save_workbuddy_catalog(
    runtime_dir: &Path,
    models: &[ModelInfo],
) -> anyhow::Result<()> {
    let catalog = serde_json::json!({
        "models": models.iter().map(|model| serde_json::json!({
            "id": model.id,
            "name": model.name,
            "supportsReasoning": model.capabilities.get("reasoning").copied().unwrap_or(false),
            "maxOutputTokens": model.max_output_tokens,
            "contextWindow": model.context_window,
        })).collect::<Vec<_>>()
    });
    let path = workbuddy_catalog_path(runtime_dir);
    std::fs::create_dir_all(path.parent().expect("model cache directory"))?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> anyhow::Result<()> {
        std::fs::write(&temporary, serde_json::to_vec_pretty(&catalog)?)?;
        std::fs::rename(&temporary, &path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

#[derive(Clone)]
pub(super) struct ModelCache {
    pub(super) fetched_at: Instant,
    pub(super) models: Vec<ModelInfo>,
}

#[derive(Clone, Debug, Serialize)]
pub(super) struct ModelInfo {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub owned_by: String,
    pub capabilities: HashMap<String, bool>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "max_output_tokens")]
    pub max_output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "contextWindow")]
    pub context_window: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "reasoningEfforts")]
    pub reasoning_efforts: Option<HashMap<String, Option<String>>>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        rename = "defaultReasoningEffort"
    )]
    pub default_reasoning_effort: Option<String>,
}

pub(super) fn parse_models(raw: &str, provider: &str) -> Vec<ModelInfo> {
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
                max_output_tokens: [
                    "max_output_tokens",
                    "maxOutputTokens",
                    "max_completion_tokens",
                    "maxCompletionTokens",
                ]
                .iter()
                .find_map(|key| value.get(*key).and_then(Value::as_u64))
                .filter(|v| *v > 0),
                context_window: [
                    "contextWindow",
                    "context_window",
                    "maxContextTokens",
                    "max_context_tokens",
                ]
                .iter()
                .find_map(|key| value.get(*key).and_then(Value::as_u64))
                .filter(|v| *v > 0),
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
}
