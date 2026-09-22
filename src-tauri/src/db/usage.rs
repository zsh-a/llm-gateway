//! Durable usage aggregates, independent of the bounded request-detail log.
use super::{Db, MetricRecord};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub const BUCKET_MS: i64 = 60_000;

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct UsageAggregate {
    pub requests: i64,
    pub successes: i64,
    pub errors: i64,
    pub canceled: i64,
    pub duration_ms: i64,
    pub max_ms: i64,
    pub last_used_at: i64,
    pub tokens: BTreeMap<String, i64>,
    pub known: BTreeMap<String, i64>,
    pub latency: BTreeMap<i64, i64>,
}

impl UsageAggregate {
    pub fn from_metric(metric: &MetricRecord) -> Self {
        let duration = (metric.completed_at - metric.started_at).max(0);
        let mut value = Self {
            requests: 1,
            successes: i64::from(metric.status == "success"),
            errors: i64::from(metric.status == "error"),
            canceled: i64::from(metric.status == "canceled"),
            duration_ms: duration,
            max_ms: duration,
            last_used_at: metric.started_at,
            ..Default::default()
        };
        // Logarithmic latency buckets keep aggregate size bounded. UI labels percentiles approximate.
        let bucket = if duration == 0 {
            0
        } else {
            1_i64 << (63 - duration.leading_zeros())
        };
        value.latency.insert(bucket, 1);
        let usage = metric
            .usage_json
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
        if let Some(usage) = usage {
            for (name, aliases) in [
                (
                    "inputTokens",
                    &["inputTokens", "input_tokens", "prompt_tokens"][..],
                ),
                (
                    "outputTokens",
                    &["outputTokens", "output_tokens", "completion_tokens"][..],
                ),
                ("totalTokens", &["totalTokens", "total_tokens"][..]),
                (
                    "reasoningTokens",
                    &["reasoningTokens", "reasoning_tokens"][..],
                ),
                ("cachedTokens", &["cachedTokens", "cached_tokens"][..]),
            ] {
                if let Some(tokens) = aliases
                    .iter()
                    .find_map(|alias| usage.get(*alias).and_then(Value::as_i64))
                    .filter(|n| *n >= 0)
                {
                    value.tokens.insert(name.into(), tokens);
                    value.known.insert(name.into(), 1);
                }
            }
            if !value.tokens.contains_key("totalTokens") {
                if let (Some(input), Some(output)) = (
                    value.tokens.get("inputTokens"),
                    value.tokens.get("outputTokens"),
                ) {
                    value.tokens.insert("totalTokens".into(), input + output);
                    value.known.insert("totalTokens".into(), 1);
                }
            }
        }
        value
    }

    pub fn merge(&mut self, other: &Self) {
        self.requests += other.requests;
        self.successes += other.successes;
        self.errors += other.errors;
        self.canceled += other.canceled;
        self.duration_ms += other.duration_ms;
        self.max_ms = self.max_ms.max(other.max_ms);
        self.last_used_at = self.last_used_at.max(other.last_used_at);
        for (key, count) in &other.tokens {
            *self.tokens.entry(key.clone()).or_default() += count;
        }
        for (key, count) in &other.known {
            *self.known.entry(key.clone()).or_default() += count;
        }
        for (key, count) in &other.latency {
            *self.latency.entry(*key).or_default() += count;
        }
    }

    pub fn percentile(&self, fraction: f64) -> Option<i64> {
        if self.requests == 0 {
            return None;
        }
        let target = (self.requests as f64 * fraction).ceil() as i64;
        let mut count = 0;
        for (duration, n) in &self.latency {
            count += n;
            if count >= target {
                return Some(*duration);
            }
        }
        None
    }

    pub fn json(&self) -> Value {
        let mut tokens = serde_json::Map::new();
        for (key, count) in &self.tokens {
            tokens.insert(key.clone(), json!(count));
        }
        let known = self.known.get("totalTokens").copied().unwrap_or(0);
        tokens.insert("requestsWithUsage".into(), json!(known));
        tokens.insert("requestsWithoutUsage".into(), json!(self.requests - known));
        json!({
            "requests": self.requests, "successes": self.successes, "errors": self.errors,
            "canceled": self.canceled, "durationMs": self.duration_ms, "tokens": tokens,
            "successRate": if self.requests > 0 { Some(self.successes as f64 / self.requests as f64) } else { None },
            "averageMs": if self.requests > 0 { Some(self.duration_ms as f64 / self.requests as f64) } else { None },
            "lastUsedAt": if self.last_used_at > 0 { Some(self.last_used_at) } else { None },
        })
    }
}

pub struct UsageBucket {
    pub start: i64,
    pub key_id: String,
    pub provider: String,
    pub channel: String,
    pub model: String,
    pub status: String,
    pub usage: UsageAggregate,
}

pub(super) fn migrate(connection: &mut Connection) -> Result<()> {
    let tx = connection.transaction()?;
    let columns = {
        let mut query = tx.prepare("PRAGMA table_info(api_keys)")?;
        query
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for column in ["revoked_at", "last_used_at"] {
        if !columns.iter().any(|name| name == column) {
            tx.execute_batch(&format!(
                "ALTER TABLE api_keys ADD COLUMN {column} INTEGER;"
            ))?;
        }
    }
    tx.execute_batch("
        CREATE TABLE IF NOT EXISTS usage_rollups (
            bucket INTEGER NOT NULL, key_id TEXT NOT NULL, provider TEXT NOT NULL,
            channel TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL,
            PRIMARY KEY(bucket, key_id, provider, channel, model, status)
        );
        CREATE INDEX IF NOT EXISTS idx_usage_rollups_key_bucket ON usage_rollups(key_id, bucket);
        CREATE INDEX IF NOT EXISTS idx_request_metrics_key_time ON request_metrics(api_key_id, started_at);
        CREATE TABLE IF NOT EXISTS usage_accounted (request_id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS usage_metadata (id INTEGER PRIMARY KEY CHECK(id=1), complete_since INTEGER NOT NULL, legacy_incomplete INTEGER NOT NULL);
    ")?;
    let migrated: bool =
        tx.query_row("SELECT EXISTS(SELECT 1 FROM usage_metadata)", [], |row| {
            row.get(0)
        })?;
    if !migrated {
        let legacy: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM request_metrics) OR EXISTS(SELECT 1 FROM api_keys WHERE used_tokens>0)", [], |row| row.get(0))?;
        let records = {
            let mut query = tx.prepare("SELECT id,started_at,completed_at,protocol,provider,channel_id,model,status,status_code,finish_reason,api_key_id,usage_json FROM request_metrics")?;
            query
                .query_map([], |r| {
                    Ok(MetricRecord {
                        id: r.get(0)?,
                        started_at: r.get(1)?,
                        completed_at: r.get(2)?,
                        protocol: r.get(3)?,
                        provider: r.get(4)?,
                        channel_id: r.get(5)?,
                        model: r.get(6)?,
                        status: r.get(7)?,
                        status_code: r.get(8)?,
                        finish_reason: r.get(9)?,
                        api_key_id: r.get(10)?,
                        usage_json: r.get(11)?,
                        diagnostics_json: None,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        // Legacy used_tokens already includes these requests; backfill aggregates only.
        for record in records {
            account(&tx, &record, false)?;
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis() as i64;
        tx.execute(
            "INSERT INTO usage_metadata VALUES(1,?1,?2)",
            params![now, legacy],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub(super) fn account(
    tx: &Transaction<'_>,
    metric: &MetricRecord,
    update_quota: bool,
) -> Result<bool> {
    if tx.execute(
        "INSERT OR IGNORE INTO usage_accounted VALUES(?1)",
        [&metric.id],
    )? == 0
    {
        return Ok(false);
    }
    let bucket = metric.started_at / BUCKET_MS * BUCKET_MS;
    let key = metric.api_key_id.as_deref().unwrap_or("");
    let provider = metric.provider.as_deref().unwrap_or("unknown");
    let channel = metric.channel_id.as_deref().unwrap_or("unknown");
    let model = metric.model.as_deref().unwrap_or("unknown");
    let raw: Option<String> = tx.query_row("SELECT payload FROM usage_rollups WHERE bucket=?1 AND key_id=?2 AND provider=?3 AND channel=?4 AND model=?5 AND status=?6", params![bucket,key,provider,channel,model,metric.status], |row| row.get(0)).optional()?;
    let mut usage: UsageAggregate = raw
        .map(|raw| serde_json::from_str(&raw))
        .transpose()?
        .unwrap_or_default();
    let increment = UsageAggregate::from_metric(metric);
    usage.merge(&increment);
    tx.execute("INSERT INTO usage_rollups VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(bucket,key_id,provider,channel,model,status) DO UPDATE SET payload=excluded.payload", params![bucket,key,provider,channel,model,metric.status,serde_json::to_string(&usage)?])?;
    tx.execute("UPDATE api_keys SET last_used_at=MAX(COALESCE(last_used_at,0),?2), used_tokens=used_tokens+?3 WHERE id=?1", params![key,metric.started_at, if update_quota { increment.tokens.get("totalTokens").copied().unwrap_or(0) } else { 0 }])?;
    Ok(true)
}

impl Db {
    pub fn usage_buckets(&self, since: i64) -> Result<Vec<UsageBucket>> {
        let connection = self.connection.lock().expect("sqlite mutex poisoned");
        let mut query = connection.prepare("SELECT bucket,key_id,provider,channel,model,status,payload FROM usage_rollups WHERE bucket>=?1")?;
        let rows = query.query_map([since], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
            ))
        })?;
        rows.map(|row| {
            let (start, key_id, provider, channel, model, status, raw) = row?;
            Ok(UsageBucket {
                start,
                key_id,
                provider,
                channel,
                model,
                status,
                usage: serde_json::from_str(&raw)?,
            })
        })
        .collect()
    }

    pub fn usage_history(&self) -> Result<Value> {
        let connection = self.connection.lock().expect("sqlite mutex poisoned");
        Ok(connection.query_row("SELECT complete_since,legacy_incomplete FROM usage_metadata WHERE id=1", [], |row| Ok(json!({"completeSince":row.get::<_,i64>(0)?,"legacyIncomplete":row.get::<_,bool>(1)?})))?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::ApiKeyRecord;

    fn key() -> ApiKeyRecord {
        ApiKeyRecord {
            id: "key-a".into(),
            name: "Client A".into(),
            prefix: "sk-test".into(),
            hash: "test-hash".into(),
            enabled: true,
            created_at: 1,
            expires_at: None,
            allowed_models: vec![],
            rpm_limit: None,
            tpm_limit: None,
            quota_tokens: Some(5000),
            used_tokens: 0,
            revoked_at: None,
            last_used_at: None,
        }
    }
    fn metric(id: usize, usage: Option<Value>) -> MetricRecord {
        MetricRecord {
            id: format!("request-{id}"),
            started_at: 60_000 + id as i64,
            completed_at: 60_500 + id as i64,
            protocol: "chat".into(),
            provider: Some("mimo".into()),
            channel_id: Some("channel-a".into()),
            model: Some("test".into()),
            status: "success".into(),
            status_code: Some(200),
            finish_reason: None,
            api_key_id: Some("key-a".into()),
            usage_json: usage.map(|v| v.to_string()),
            diagnostics_json: None,
        }
    }

    #[test]
    fn request_diagnostics_survive_database_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("metrics.sqlite3");
        let diagnostics = json!({"receivedBytes":123,"error":{"code":"upstream_idle_timeout","stage":"stream_idle"}}).to_string();
        {
            let db = Db::open(&path).unwrap();
            let mut record = metric(0, None);
            record.status = "error".into();
            record.diagnostics_json = Some(diagnostics.clone());
            db.insert_metric(&record).unwrap();
        }
        let db = Db::open(&path).unwrap();
        assert_eq!(
            db.metric_rows(0).unwrap()[0].diagnostics_json.as_ref(),
            Some(&diagnostics)
        );
    }
    fn totals(db: &Db) -> UsageAggregate {
        let mut total = UsageAggregate::default();
        for row in db.usage_buckets(0).unwrap() {
            total.merge(&row.usage);
        }
        total
    }
    #[test]
    fn pruning_revocation_and_stale_metadata_updates_preserve_usage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db.sqlite3");
        let db = Db::open(&path).unwrap();
        db.upsert_api_key(&key()).unwrap();
        let stale = db.list_api_keys().unwrap().remove(0);
        for id in 0..130 {
            db.insert_metric(&metric(id, Some(json!({"inputTokens":5,"outputTokens":2}))))
                .unwrap();
        }
        db.insert_metric(&metric(130, None)).unwrap();
        db.prune_metrics(100).unwrap();
        db.insert_metric(&metric(0, Some(json!({"totalTokens":7}))))
            .unwrap();
        assert_eq!(db.metric_rows(0).unwrap().len(), 100);
        assert_eq!(totals(&db).requests, 131);
        assert_eq!(totals(&db).tokens["totalTokens"], 910);
        assert_eq!(totals(&db).json()["tokens"]["requestsWithoutUsage"], 1);
        db.upsert_api_key(&stale).unwrap();
        assert_eq!(db.list_api_keys().unwrap()[0].used_tokens, 910);
        assert!(db.delete_api_key("key-a").unwrap());
        db.upsert_api_key(&stale).unwrap();
        let retained = db.list_api_keys().unwrap().remove(0);
        assert!(!retained.enabled);
        assert!(retained.revoked_at.is_some());
        assert_eq!(retained.name, "Client A");
        assert_eq!(retained.used_tokens, 910);
        assert_eq!(retained.last_used_at, Some(60_130));
        drop(db);
        let restarted = Db::open(&path).unwrap();
        assert_eq!(totals(&restarted).requests, 131);
        assert_eq!(restarted.list_api_keys().unwrap()[0].used_tokens, 910);
    }
    #[test]
    fn accounting_is_atomic_with_details_and_idempotent_on_retry() {
        let db = Db::open(std::path::Path::new(":memory:")).unwrap();
        db.upsert_api_key(&key()).unwrap();
        db.connection.lock().unwrap().execute_batch("CREATE TRIGGER fail_metric BEFORE INSERT ON request_metrics BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
        let record = metric(1, Some(json!({"totalTokens":7})));
        assert!(db.insert_metric(&record).is_err());
        assert_eq!(totals(&db).requests, 0);
        assert_eq!(db.list_api_keys().unwrap()[0].used_tokens, 0);
        db.connection
            .lock()
            .unwrap()
            .execute_batch("DROP TRIGGER fail_metric;")
            .unwrap();
        db.insert_metric(&record).unwrap();
        db.insert_metric(&record).unwrap();
        assert_eq!(totals(&db).requests, 1);
        assert_eq!(db.list_api_keys().unwrap()[0].used_tokens, 7);
    }
    #[test]
    fn migration_backfills_retained_history_without_recharging_quota() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy.sqlite3");
        let db = Db::open(&path).unwrap();
        db.upsert_api_key(&key()).unwrap();
        db.insert_metric(&metric(1, Some(json!({"total_tokens":7}))))
            .unwrap();
        db.connection.lock().unwrap().execute_batch("DROP TABLE usage_rollups; DROP TABLE usage_accounted; DROP TABLE usage_metadata; ALTER TABLE api_keys DROP COLUMN revoked_at; ALTER TABLE api_keys DROP COLUMN last_used_at;").unwrap();
        drop(db);
        for _ in 0..2 {
            let db = Db::open(&path).unwrap();
            assert_eq!(totals(&db).requests, 1);
            assert_eq!(totals(&db).tokens["totalTokens"], 7);
            assert_eq!(db.list_api_keys().unwrap()[0].used_tokens, 7);
            assert_eq!(db.usage_history().unwrap()["legacyIncomplete"], true);
        }
    }
}
