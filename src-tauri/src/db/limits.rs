//! Admission and settled token windows are independent of request-detail retention.
use super::{Db, MetricRecord, usage::UsageAggregate};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, Transaction, params};

const WINDOW_MS: i64 = 60_000;

pub(super) fn migrate(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS request_admissions (
            id TEXT PRIMARY KEY, key_id TEXT NOT NULL, admitted_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_admissions_key_time ON request_admissions(key_id, admitted_at);
        CREATE TABLE IF NOT EXISTS settled_token_usage (
            id TEXT PRIMARY KEY, key_id TEXT NOT NULL, settled_at INTEGER NOT NULL, tokens INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_settled_key_time ON settled_token_usage(key_id, settled_at);",
    )?;
    Ok(())
}

pub(super) fn settle(tx: &Transaction<'_>, metric: &MetricRecord) -> Result<()> {
    let Some(key) = &metric.api_key_id else {
        return Ok(());
    };
    let tokens = UsageAggregate::from_metric(metric)
        .tokens
        .get("totalTokens")
        .copied()
        .unwrap_or(0);
    // Count at completion, including streams that started more than a minute ago.
    tx.execute(
        "INSERT OR IGNORE INTO settled_token_usage VALUES(?1,?2,?3,?4)",
        params![metric.id, key, metric.completed_at, tokens],
    )?;
    prune(tx, metric.completed_at)?;
    Ok(())
}

fn prune(tx: &Transaction<'_>, now: i64) -> Result<()> {
    tx.execute(
        "DELETE FROM request_admissions WHERE admitted_at<=?1",
        [now - WINDOW_MS],
    )?;
    tx.execute(
        "DELETE FROM settled_token_usage WHERE settled_at<=?1",
        [now - WINDOW_MS],
    )?;
    Ok(())
}

impl Db {
    /// Checking the current policy and claiming a slot share one transaction.
    /// A denied request never consumes a slot; admitted failures/cancellations do.
    pub fn admit_request(&self, id: &str, key: &str, now: i64) -> Result<Option<&'static str>> {
        let mut connection = self.connection.lock().expect("sqlite mutex poisoned");
        let tx = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        prune(&tx, now)?;
        let policy = tx.query_row(
            "SELECT enabled,revoked_at,expires_at,rpm_limit,tpm_limit,quota_tokens,used_tokens FROM api_keys WHERE id=?1",
            [key],
            |row| Ok((row.get::<_, bool>(0)?, row.get::<_, Option<i64>>(1)?, row.get::<_, Option<i64>>(2)?, row.get::<_, Option<i64>>(3)?, row.get::<_, Option<i64>>(4)?, row.get::<_, Option<i64>>(5)?, row.get::<_, i64>(6)?)),
        ).optional()?;
        let denial = match policy {
            None => Some("API Key 已不存在"),
            Some((enabled, revoked, expires, rpm, tpm, quota, used)) => {
                if !enabled || revoked.is_some() || expires.is_some_and(|time| time <= now) {
                    Some("API Key 已失效")
                } else if quota.is_some_and(|limit| used >= limit) {
                    Some("API Key Token 配额已用尽")
                } else {
                    let requests: i64 = tx.query_row("SELECT COUNT(*) FROM request_admissions WHERE key_id=?1 AND admitted_at>?2", params![key, now-WINDOW_MS], |row| row.get(0))?;
                    let tokens: i64 = tx.query_row("SELECT COALESCE(SUM(tokens),0) FROM settled_token_usage WHERE key_id=?1 AND settled_at>?2", params![key, now-WINDOW_MS], |row| row.get(0))?;
                    if rpm.is_some_and(|limit| requests >= limit) {
                        Some("API Key 已达到每分钟请求上限")
                    } else if tpm.is_some_and(|limit| tokens >= limit) {
                        Some("API Key 已达到每分钟 Token 上限")
                    } else {
                        None
                    }
                }
            }
        };
        if denial.is_none() {
            tx.execute(
                "INSERT INTO request_admissions VALUES(?1,?2,?3)",
                params![id, key, now],
            )?;
        }
        tx.commit()?;
        Ok(denial)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::ApiKeyRecord;

    fn key(rpm: Option<i64>, tpm: Option<i64>) -> ApiKeyRecord {
        ApiKeyRecord {
            id: "client".into(),
            name: "Client".into(),
            prefix: "sk".into(),
            hash: "hash".into(),
            enabled: true,
            created_at: 0,
            expires_at: None,
            allowed_models: vec![],
            rpm_limit: rpm,
            tpm_limit: tpm,
            quota_tokens: None,
            used_tokens: 0,
            revoked_at: None,
            last_used_at: None,
        }
    }
    fn metric(id: &str, key: &str, start: i64, end: i64, tokens: i64) -> MetricRecord {
        MetricRecord {
            id: id.into(),
            started_at: start,
            completed_at: end,
            protocol: "chat".into(),
            provider: Some("mimo".into()),
            channel_id: None,
            model: Some("test".into()),
            status: "success".into(),
            status_code: Some(200),
            finish_reason: None,
            api_key_id: Some(key.into()),
            usage_json: Some(serde_json::json!({"totalTokens":tokens}).to_string()),
            diagnostics_json: None,
        }
    }

    #[test]
    fn concurrent_in_flight_requests_atomically_claim_the_rpm_slot() {
        let db = Db::open(Path::new(":memory:")).unwrap();
        db.upsert_api_key(&key(Some(1), None)).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(12));
        let threads: Vec<_> = (0..12)
            .map(|id| {
                let db = db.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    db.admit_request(&id.to_string(), "client", 100_000)
                        .unwrap()
                        .is_none()
                })
            })
            .collect();
        assert_eq!(
            threads
                .into_iter()
                .map(|thread| usize::from(thread.join().unwrap()))
                .sum::<usize>(),
            1
        );
        assert!(
            db.metric_rows(0).unwrap().is_empty(),
            "admission must not depend on completed logs"
        );
        assert!(
            db.admit_request("later", "client", 160_000)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn rpm_survives_restart_without_any_completed_request() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("gateway.db");
        let db = Db::open(&path).unwrap();
        db.upsert_api_key(&key(Some(1), None)).unwrap();
        assert!(db.admit_request("a", "client", 100_000).unwrap().is_none());
        drop(db);
        let db = Db::open(&path).unwrap();
        assert!(db.admit_request("b", "client", 100_001).unwrap().is_some());
    }

    #[test]
    fn settled_tokens_outlive_pruned_logs_and_count_long_streams_once() {
        let db = Db::open(Path::new(":memory:")).unwrap();
        db.upsert_api_key(&key(None, Some(10))).unwrap();
        let long_stream = metric("long", "client", 1, 100_000, 6);
        db.insert_metric(&long_stream).unwrap();
        db.insert_metric(&long_stream).unwrap();
        assert!(
            db.admit_request("still-under-limit", "client", 100_001)
                .unwrap()
                .is_none()
        );
        db.insert_metric(&metric("second", "client", 2, 100_001, 4))
            .unwrap();
        for i in 0..110 {
            db.insert_metric(&metric(
                &format!("other-{i}"),
                "other",
                100_002 + i,
                100_002 + i,
                1,
            ))
            .unwrap();
        }
        db.prune_metrics(100).unwrap();
        assert!(
            db.metric_rows(0)
                .unwrap()
                .iter()
                .all(|row| row.api_key_id.as_deref() != Some("client"))
        );
        assert_eq!(
            db.admit_request("blocked", "client", 100_200).unwrap(),
            Some("API Key 已达到每分钟 Token 上限")
        );
        assert!(
            db.admit_request("expired", "client", 160_002)
                .unwrap()
                .is_none()
        );
    }

    use std::path::Path;
}
