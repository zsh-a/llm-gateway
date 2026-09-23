mod channels;
mod limits;
pub mod usage;

use anyhow::Context;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

#[derive(Clone)]
pub struct Db {
    connection: Arc<Mutex<Connection>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChannelRecord {
    pub id: String,
    pub name: String,
    #[serde(rename = "providerId")]
    pub provider_id: String,
    #[serde(rename = "authRef")]
    pub auth_ref: String,
    #[serde(rename = "upstreamUrl", skip_serializing_if = "Option::is_none")]
    pub upstream_url: Option<String>,
    pub enabled: bool,
    pub priority: i64,
    pub weight: i64,
    #[serde(rename = "modelMappings")]
    pub model_mappings: serde_json::Value,
}

#[derive(Clone, Debug)]
pub struct ApiKeyRecord {
    pub id: String,
    pub name: String,
    pub prefix: String,
    pub hash: String,
    pub enabled: bool,
    pub created_at: i64,
    pub expires_at: Option<i64>,
    pub allowed_models: Vec<String>,
    pub rpm_limit: Option<i64>,
    pub tpm_limit: Option<i64>,
    pub quota_tokens: Option<i64>,
    pub used_tokens: i64,
    pub revoked_at: Option<i64>,
    pub last_used_at: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct MetricRecord {
    pub id: String,
    pub started_at: i64,
    pub completed_at: i64,
    pub protocol: String,
    pub provider: Option<String>,
    pub channel_id: Option<String>,
    pub model: Option<String>,
    pub status: String,
    pub status_code: Option<i64>,
    pub finish_reason: Option<String>,
    pub api_key_id: Option<String>,
    pub usage_json: Option<String>,
    pub diagnostics_json: Option<String>,
}

#[derive(Clone, Debug)]
pub struct MetricRow {
    pub id: String,
    pub started_at: i64,
    pub completed_at: i64,
    pub protocol: String,
    pub provider: Option<String>,
    pub channel_id: Option<String>,
    pub model: Option<String>,
    pub status: String,
    pub status_code: Option<i64>,
    pub finish_reason: Option<String>,
    pub api_key_id: Option<String>,
    pub usage_json: Option<String>,
    pub diagnostics_json: Option<String>,
}

impl Db {
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut connection = Connection::open(path)
            .with_context(|| format!("无法打开 SQLite 数据库 {}", path.display()))?;
        let existing_channels: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='channels')",
            [],
            |row| row.get(0),
        )?;
        let existing_metadata: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='gateway_metadata')", [], |row| row.get(0))?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "busy_timeout", 5000_i64)?;
        connection.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS gateway_metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS channels (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              provider_id TEXT NOT NULL,
              auth_ref TEXT NOT NULL,
              upstream_url TEXT,
              enabled INTEGER NOT NULL DEFAULT 1,
              priority INTEGER NOT NULL DEFAULT 0,
              weight INTEGER NOT NULL DEFAULT 1,
              model_mappings TEXT NOT NULL DEFAULT '{}'
            );
            CREATE TABLE IF NOT EXISTS api_keys (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              prefix TEXT NOT NULL,
              hash TEXT NOT NULL UNIQUE,
              enabled INTEGER NOT NULL DEFAULT 1,
              created_at INTEGER NOT NULL,
              expires_at INTEGER,
              allowed_models TEXT NOT NULL DEFAULT '[]',
              rpm_limit INTEGER,
              tpm_limit INTEGER,
              quota_tokens INTEGER,
              used_tokens INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS request_metrics (
              id TEXT PRIMARY KEY,
              started_at INTEGER NOT NULL,
              completed_at INTEGER NOT NULL,
              protocol TEXT NOT NULL,
              provider TEXT,
              channel_id TEXT,
              model TEXT,
              status TEXT NOT NULL,
              status_code INTEGER,
              finish_reason TEXT,
              api_key_id TEXT,
              usage_json TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_request_metrics_started_at
              ON request_metrics(started_at);
            CREATE INDEX IF NOT EXISTS idx_request_metrics_model
              ON request_metrics(model);
            ",
        )?;
        if existing_channels && !existing_metadata {
            // Upgrades preserve intentionally empty channel configurations too.
            connection.execute(
                "INSERT OR IGNORE INTO gateway_metadata VALUES('channels_initialized','1')",
                [],
            )?;
        }
        usage::migrate(&mut connection)?;
        limits::migrate(&connection)?;
        let has_diagnostics = connection
            .prepare("PRAGMA table_info(request_metrics)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .iter()
            .any(|name| name == "diagnostics_json");
        if !has_diagnostics {
            connection
                .execute_batch("ALTER TABLE request_metrics ADD COLUMN diagnostics_json TEXT;")?;
        }
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    pub fn seed_api_keys(&self, path: &Path) -> anyhow::Result<()> {
        if self.count_api_keys()? > 0 || !path.is_file() {
            return Ok(());
        }
        let raw = std::fs::read_to_string(path)?;
        let value: serde_json::Value = serde_json::from_str(&raw)?;
        if let Some(items) = value.get("keys").and_then(|value| value.as_array()) {
            for item in items {
                if let Ok(key) = serde_json::from_value::<LegacyApiKey>(item.clone()) {
                    self.upsert_api_key(&ApiKeyRecord {
                        id: key.id,
                        name: key.name,
                        prefix: key.prefix,
                        hash: key.hash,
                        enabled: key.enabled,
                        created_at: key.created_at,
                        expires_at: key.expires_at,
                        allowed_models: key.allowed_models,
                        rpm_limit: key.rpm_limit,
                        tpm_limit: key.tpm_limit,
                        quota_tokens: key.quota_tokens,
                        used_tokens: key.used_tokens,
                        revoked_at: None,
                        last_used_at: None,
                    })?;
                }
            }
        }
        Ok(())
    }

    pub fn list_channels(&self) -> anyhow::Result<Vec<ChannelRecord>> {
        let connection = self.connection.lock().expect("sqlite mutex poisoned");
        let mut statement = connection.prepare(
            "SELECT id,name,provider_id,auth_ref,upstream_url,enabled,priority,weight,model_mappings
             FROM channels ORDER BY priority DESC, id ASC",
        )?;
        let rows = statement.query_map([], |row| {
            let mappings = row.get::<_, String>(8).unwrap_or_else(|_| "{}".to_string());
            Ok(ChannelRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                provider_id: row.get(2)?,
                auth_ref: row.get(3)?,
                upstream_url: row.get(4)?,
                enabled: row.get::<_, i64>(5)? != 0,
                priority: row.get(6)?,
                weight: row.get(7)?,
                model_mappings: serde_json::from_str(&mappings)
                    .unwrap_or_else(|_| serde_json::json!({})),
            })
        })?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub fn upsert_channel(&self, channel: &ChannelRecord) -> anyhow::Result<()> {
        let connection = self.connection.lock().expect("sqlite mutex poisoned");
        channels::save(&connection, channel)
    }

    pub fn delete_channel(&self, id: &str) -> anyhow::Result<bool> {
        let connection = self.connection.lock().expect("sqlite mutex poisoned");
        Ok(connection.execute("DELETE FROM channels WHERE id=?1", params![id])? > 0)
    }

    pub fn count_api_keys(&self) -> anyhow::Result<i64> {
        let connection = self.connection.lock().expect("sqlite mutex poisoned");
        Ok(connection.query_row("SELECT COUNT(*) FROM api_keys", [], |row| row.get(0))?)
    }

    pub fn list_api_keys(&self) -> anyhow::Result<Vec<ApiKeyRecord>> {
        let connection = self.connection.lock().expect("sqlite mutex poisoned");
        let mut statement = connection.prepare(
            "SELECT id,name,prefix,hash,enabled,created_at,expires_at,allowed_models,
                    rpm_limit,tpm_limit,quota_tokens,used_tokens,revoked_at,last_used_at
             FROM api_keys ORDER BY created_at DESC",
        )?;
        let rows = statement.query_map([], |row| {
            let models = row.get::<_, String>(7).unwrap_or_else(|_| "[]".to_string());
            Ok(ApiKeyRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                prefix: row.get(2)?,
                hash: row.get(3)?,
                enabled: row.get::<_, i64>(4)? != 0,
                created_at: row.get(5)?,
                expires_at: row.get(6)?,
                allowed_models: serde_json::from_str(&models).unwrap_or_default(),
                rpm_limit: row.get(8)?,
                tpm_limit: row.get(9)?,
                quota_tokens: row.get(10)?,
                used_tokens: row.get(11)?,
                revoked_at: row.get(12)?,
                last_used_at: row.get(13)?,
            })
        })?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub fn find_api_key_by_hash(&self, hash: &str) -> anyhow::Result<Option<ApiKeyRecord>> {
        let connection = self.connection.lock().expect("sqlite mutex poisoned");
        let item = connection
            .query_row(
                "SELECT id,name,prefix,hash,enabled,created_at,expires_at,allowed_models,
                        rpm_limit,tpm_limit,quota_tokens,used_tokens,revoked_at,last_used_at
                 FROM api_keys WHERE hash=?1",
                params![hash],
                |row| {
                    let models = row.get::<_, String>(7).unwrap_or_else(|_| "[]".to_string());
                    Ok(ApiKeyRecord {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        prefix: row.get(2)?,
                        hash: row.get(3)?,
                        enabled: row.get::<_, i64>(4)? != 0,
                        created_at: row.get(5)?,
                        expires_at: row.get(6)?,
                        allowed_models: serde_json::from_str(&models).unwrap_or_default(),
                        rpm_limit: row.get(8)?,
                        tpm_limit: row.get(9)?,
                        quota_tokens: row.get(10)?,
                        used_tokens: row.get(11)?,
                        revoked_at: row.get(12)?,
                        last_used_at: row.get(13)?,
                    })
                },
            )
            .optional()?;
        Ok(item)
    }

    pub fn upsert_api_key(&self, key: &ApiKeyRecord) -> anyhow::Result<()> {
        let connection = self.connection.lock().expect("sqlite mutex poisoned");
        connection.execute(
            "INSERT INTO api_keys
             (id,name,prefix,hash,enabled,created_at,expires_at,allowed_models,rpm_limit,tpm_limit,quota_tokens,used_tokens)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name,prefix=excluded.prefix,
             hash=excluded.hash,enabled=CASE WHEN api_keys.revoked_at IS NULL THEN excluded.enabled ELSE 0 END,expires_at=excluded.expires_at,
             allowed_models=excluded.allowed_models,rpm_limit=excluded.rpm_limit,
             tpm_limit=excluded.tpm_limit,quota_tokens=excluded.quota_tokens",
            params![
                key.id,
                key.name,
                key.prefix,
                key.hash,
                i64::from(key.enabled),
                key.created_at,
                key.expires_at,
                serde_json::to_string(&key.allowed_models)?,
                key.rpm_limit,
                key.tpm_limit,
                key.quota_tokens,
                key.used_tokens,
            ],
        )?;
        Ok(())
    }

    pub fn delete_api_key(&self, id: &str) -> anyhow::Result<bool> {
        let connection = self.connection.lock().expect("sqlite mutex poisoned");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis() as i64;
        Ok(connection.execute(
            "UPDATE api_keys SET enabled=0,revoked_at=?2 WHERE id=?1 AND revoked_at IS NULL",
            params![id, now],
        )? > 0)
    }

    pub fn insert_metric(&self, metric: &MetricRecord) -> anyhow::Result<()> {
        let mut connection = self.connection.lock().expect("sqlite mutex poisoned");
        let tx = connection.transaction()?;
        if !usage::account(&tx, metric, true)? {
            return Ok(());
        }
        limits::settle(&tx, metric)?;
        tx.execute(
            "INSERT OR REPLACE INTO request_metrics
             (id,started_at,completed_at,protocol,provider,channel_id,model,status,status_code,finish_reason,api_key_id,usage_json,diagnostics_json)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
            params![
                metric.id,
                metric.started_at,
                metric.completed_at,
                metric.protocol,
                metric.provider,
                metric.channel_id,
                metric.model,
                metric.status,
                metric.status_code,
                metric.finish_reason,
                metric.api_key_id,
                metric.usage_json,
                metric.diagnostics_json,
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn metric_rows(&self, since: i64) -> anyhow::Result<Vec<MetricRow>> {
        let connection = self.connection.lock().expect("sqlite mutex poisoned");
        let mut statement = connection.prepare(
            "SELECT id,started_at,completed_at,protocol,provider,channel_id,model,status,
                    status_code,finish_reason,api_key_id,usage_json,diagnostics_json
             FROM request_metrics WHERE started_at>=?1 ORDER BY started_at DESC",
        )?;
        let rows = statement.query_map(params![since], |row| {
            Ok(MetricRow {
                id: row.get(0)?,
                started_at: row.get(1)?,
                completed_at: row.get(2)?,
                protocol: row.get(3)?,
                provider: row.get(4)?,
                channel_id: row.get(5)?,
                model: row.get(6)?,
                status: row.get(7)?,
                status_code: row.get(8)?,
                finish_reason: row.get(9)?,
                api_key_id: row.get(10)?,
                usage_json: row.get(11)?,
                diagnostics_json: row.get(12)?,
            })
        })?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub fn prune_metrics(&self, keep: i64) -> anyhow::Result<()> {
        let connection = self.connection.lock().expect("sqlite mutex poisoned");
        connection.execute(
            "DELETE FROM request_metrics WHERE id NOT IN
             (SELECT id FROM request_metrics ORDER BY started_at DESC LIMIT ?1)",
            params![keep.max(100)],
        )?;
        Ok(())
    }

    pub fn new_id() -> String {
        Uuid::new_v4().to_string()
    }
}

#[derive(Deserialize)]
struct LegacyApiKey {
    id: String,
    name: String,
    prefix: String,
    hash: String,
    enabled: bool,
    #[serde(rename = "createdAt")]
    created_at: i64,
    #[serde(rename = "expiresAt")]
    expires_at: Option<i64>,
    #[serde(rename = "allowedModels", default)]
    allowed_models: Vec<String>,
    #[serde(rename = "rpmLimit")]
    rpm_limit: Option<i64>,
    #[serde(rename = "tpmLimit")]
    tpm_limit: Option<i64>,
    #[serde(rename = "quotaTokens")]
    quota_tokens: Option<i64>,
    #[serde(rename = "usedTokens", default)]
    used_tokens: i64,
}
