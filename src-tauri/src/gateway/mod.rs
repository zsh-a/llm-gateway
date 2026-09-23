use crate::{config::Config, db::Db};
use activity::Activity;
use auth::AuthCache;
use model_catalog::{ModelCatalog, ModelInfo};
use reqwest::Client;
use routing::Route;
use std::time::Duration;
use tracking::MetricContext;
#[cfg(test)]
use {
    crate::db::ChannelRecord,
    axum::http::HeaderMap,
    model_catalog::parse_models,
    serde_json::{Value, json},
};

mod activity;
mod auth;
mod error;
mod http;
pub(crate) mod management;
mod metrics;
mod model_catalog;
#[cfg(test)]
mod model_catalog_tests;
mod policy;
#[cfg(test)]
mod protocol_tests;
mod protocols;
mod routing;
mod sync;
mod tracking;
mod upstream;
mod util;

pub(crate) use http::{serve, serve_listener};
pub(crate) use sync::{RemoteSyncPullResult, RemoteSyncSettings, RemoteSyncStatus};

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub db: Db,
    pub client: Client,
    pub(crate) activity: Activity,
    auth: AuthCache,
    catalog: ModelCatalog,
}

impl AppState {
    #[cfg(test)]
    pub(crate) fn test_state(runtime_dir: &std::path::Path) -> Self {
        // Explicit configuration: tests never read real credentials or DATABASE_FILE.
        let config = Config {
            bind_host: "127.0.0.1".into(),
            port: 0,
            connect_timeout_ms: 1000,
            first_byte_timeout_ms: 5000,
            idle_timeout_ms: 5000,
            max_body_bytes: crate::config::DEFAULT_MAX_BODY_BYTES,
            proxy_api_key: String::new(),
            proxy_admin_key: String::new(),
            cors_origin: String::new(),
            runtime_dir: runtime_dir.into(),
            auth_cache_dir: runtime_dir.join("auth"),
            channels_file: runtime_dir.join("channels.json"),
            api_keys_file: runtime_dir.join("keys.json"),
            model_file: None,
            model_discovery: false,
            model_discovery_timeout_ms: 100,
            default_model: String::new(),
            metrics_max_records: 100,
        };
        Self::assemble(
            config,
            Db::open(std::path::Path::new(":memory:")).unwrap(),
            Client::builder().no_proxy().build().unwrap(),
            AuthCache::default(),
        )
    }

    #[cfg(test)]
    pub(crate) fn test_upstream(&self, url: &str) {
        self.auth.set_headers("mimo", HeaderMap::new());
        self.db
            .upsert_channel(&ChannelRecord {
                id: "test".into(),
                name: "test".into(),
                provider_id: "mimo".into(),
                auth_ref: "mimo".into(),
                upstream_url: Some(url.into()),
                enabled: true,
                priority: 0,
                weight: 1,
                model_mappings: json!({}),
            })
            .unwrap();
    }

    pub fn new(config: Config) -> anyhow::Result<Self> {
        config.ensure_runtime_dir()?;
        let db = Db::open(&config.database_path())?;
        db.initialize_channels(&config.channels_file, &routing::default_channels())?;
        db.seed_api_keys(&config.api_keys_file)?;
        let auth = AuthCache::load(&config);
        let client = Client::builder()
            .user_agent("llm-gateway-rust/1.0")
            .connect_timeout(Duration::from_millis(config.connect_timeout_ms))
            .pool_max_idle_per_host(8)
            .build()?;
        Ok(Self::assemble(config, db, client, auth))
    }

    fn assemble(config: Config, db: Db, client: Client, auth: AuthCache) -> Self {
        let catalog = ModelCatalog::new(client.clone(), auth.clone());
        Self {
            config,
            db,
            client,
            activity: Activity::default(),
            auth,
            catalog,
        }
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
    pub(crate) async fn reload_auth_cache(&self) -> anyhow::Result<()> {
        self.catalog.reload_auth(&self.config).await
    }
    async fn models(&self) -> Vec<ModelInfo> {
        self.catalog.models(&self.config).await
    }
    #[cfg(test)]
    async fn models_from(&self, mimo_url: &str, workbuddy_url: &str) -> Vec<ModelInfo> {
        self.catalog
            .models_from(&self.config, mimo_url, workbuddy_url)
            .await
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
