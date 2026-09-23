use super::{ChannelRecord, Db};
use anyhow::Result;
use rusqlite::{Connection, params};
use std::path::Path;

pub(super) fn save(connection: &Connection, channel: &ChannelRecord) -> Result<()> {
    connection.execute(
        "INSERT INTO channels
         (id,name,provider_id,auth_ref,upstream_url,enabled,priority,weight,model_mappings)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
         ON CONFLICT(id) DO UPDATE SET
         name=excluded.name,provider_id=excluded.provider_id,auth_ref=excluded.auth_ref,
         upstream_url=excluded.upstream_url,enabled=excluded.enabled,priority=excluded.priority,
         weight=excluded.weight,model_mappings=excluded.model_mappings",
        params![
            channel.id,
            channel.name,
            channel.provider_id,
            channel.auth_ref,
            channel.upstream_url,
            i64::from(channel.enabled),
            channel.priority,
            channel.weight.max(1),
            serde_json::to_string(&channel.model_mappings)?
        ],
    )?;
    Ok(())
}

impl Db {
    pub fn initialize_channels(&self, legacy: &Path, defaults: &[ChannelRecord]) -> Result<()> {
        let mut connection = self.connection.lock().expect("sqlite mutex poisoned");
        let tx = connection.transaction()?;
        let initialized: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM gateway_metadata WHERE name='channels_initialized')",
            [],
            |row| row.get(0),
        )?;
        if initialized {
            return Ok(());
        }
        let count: i64 = tx.query_row("SELECT COUNT(*) FROM channels", [], |row| row.get(0))?;
        if count == 0 {
            let channels = if legacy.is_file() {
                let value: serde_json::Value =
                    serde_json::from_str(&std::fs::read_to_string(legacy)?)?;
                serde_json::from_value::<Vec<ChannelRecord>>(
                    value
                        .get("channels")
                        .cloned()
                        .unwrap_or_else(|| serde_json::json!([])),
                )?
            } else {
                defaults.to_vec()
            };
            for channel in channels {
                save(&tx, &channel)?;
            }
        }
        tx.execute(
            "INSERT INTO gateway_metadata VALUES('channels_initialized','1')",
            [],
        )?;
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn defaults() -> Vec<ChannelRecord> {
        vec![ChannelRecord {
            id: "default".into(),
            name: "Default".into(),
            provider_id: "mimo".into(),
            auth_ref: "mimo".into(),
            upstream_url: None,
            enabled: true,
            priority: 0,
            weight: 1,
            model_mappings: serde_json::json!({}),
        }]
    }

    #[test]
    fn deleting_all_channels_survives_reinitialization_and_restart() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("gateway.db");
        let legacy = directory.path().join("channels.json");
        let db = Db::open(&path).unwrap();
        db.initialize_channels(&legacy, &defaults()).unwrap();
        assert_eq!(db.list_channels().unwrap().len(), 1);
        db.delete_channel("default").unwrap();
        db.initialize_channels(&legacy, &defaults()).unwrap();
        drop(db);
        // A leftover import file must not resurrect a deliberately deleted channel.
        std::fs::write(
            &legacy,
            serde_json::json!({"channels":defaults()}).to_string(),
        )
        .unwrap();
        let db = Db::open(&path).unwrap();
        db.initialize_channels(&legacy, &defaults()).unwrap();
        assert!(db.list_channels().unwrap().is_empty());
    }

    #[test]
    fn upgrade_preserves_an_empty_existing_channel_table() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("gateway.db");
        // Simulate the old schema, which has no initialization marker.
        let db = Db::open(&path).unwrap();
        db.connection
            .lock()
            .unwrap()
            .execute("DROP TABLE gateway_metadata", [])
            .unwrap();
        drop(db);
        let db = Db::open(&path).unwrap();
        db.initialize_channels(&directory.path().join("missing"), &defaults())
            .unwrap();
        assert!(db.list_channels().unwrap().is_empty());
    }

    #[test]
    fn failed_legacy_import_is_retryable_and_empty_import_is_authoritative() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("gateway.db");
        let legacy = directory.path().join("channels.json");
        std::fs::write(&legacy, "invalid json").unwrap();
        let db = Db::open(&path).unwrap();
        assert!(db.initialize_channels(&legacy, &defaults()).is_err());
        drop(db);
        std::fs::write(&legacy, "{\"channels\":[]}").unwrap();
        let db = Db::open(&path).unwrap();
        db.initialize_channels(&legacy, &defaults()).unwrap();
        assert!(db.list_channels().unwrap().is_empty());
    }
}
