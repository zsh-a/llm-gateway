use super::{
    activity::{Activity, RequestGuard},
    error::{ErrorKind, GatewayError},
    policy::Identity,
    protocols,
    routing::Route,
    upstream,
    util::now_ms,
};
use crate::db::{Db, MetricRecord};
use axum::http::StatusCode;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tracing::warn;

#[derive(Clone)]
pub(super) struct MetricContext {
    db: Db,
    max_records: i64,
    draft: Arc<Mutex<MetricDraft>>,
}

#[derive(Default)]
struct MetricDraft {
    active: Option<RequestGuard>,
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
    diagnostics: upstream::RequestDiagnostics,
}

impl MetricContext {
    pub fn begin(
        db: &Db,
        activity: &Activity,
        max_records: i64,
        protocol: &str,
        identity: &Identity,
    ) -> Result<Self, GatewayError> {
        let now = now_ms();
        let id = Db::new_id();
        let active = activity
            .begin(id.clone(), identity.key_id.clone(), now)
            .ok_or_else(|| {
                GatewayError::new(ErrorKind::Configuration, "网关正在停止，请稍后重试")
            })?;
        if identity.managed {
            if let Some(message) = db
                .admit_request(&id, &identity.key_id, now)
                .map_err(GatewayError::database)?
            {
                return Err(GatewayError::new(ErrorKind::RateLimited, message));
            }
        }
        Ok(Self {
            db: db.clone(),
            max_records,
            draft: Arc::new(Mutex::new(MetricDraft {
                id,
                active: Some(active),
                started_at: now,
                protocol: protocol.into(),
                api_key_id: Some(identity.key_id.clone()),
                ..Default::default()
            })),
        })
    }

    pub fn id(&self) -> String {
        self.draft
            .lock()
            .map(|draft| draft.id.clone())
            .unwrap_or_default()
    }

    pub fn headers_received(&self) {
        if let Ok(mut draft) = self.draft.lock() {
            draft.diagnostics.response_headers_ms = Some((now_ms() - draft.started_at).max(0));
        }
    }

    pub fn observe_chunk(&self, bytes: usize, accumulator: &protocols::StreamAccumulator) {
        if let Ok(mut draft) = self.draft.lock() {
            let elapsed = (now_ms() - draft.started_at).max(0);
            draft.diagnostics.first_byte_ms.get_or_insert(elapsed);
            draft.diagnostics.last_byte_ms = Some(elapsed);
            draft.diagnostics.received_bytes += bytes as u64;
            draft.diagnostics.received_chunks += 1;
            if let Some(usage) = &accumulator.usage {
                draft.usage_json = Some(usage.to_string());
            }
            if let Some(reason) = &accumulator.finish_reason {
                draft.finish_reason = Some(reason.clone());
            }
        }
    }

    pub fn fail(&self, failure: &upstream::UpstreamFailure) {
        self.attempt_failed(failure);
        if let Ok(mut draft) = self.draft.lock() {
            if draft.finished {
                return;
            }
            draft.diagnostics.error = Some(failure.clone());
            warn!(request_id = %draft.id, provider = ?draft.provider, channel = ?draft.channel_id,
                error_code = failure.code, stage = failure.stage, timeout_ms = ?failure.timeout_ms,
                received_bytes = draft.diagnostics.received_bytes, first_byte_ms = ?draft.diagnostics.first_byte_ms,
                last_byte_ms = ?draft.diagnostics.last_byte_ms, "上游请求失败");
        }
        self.finish("error", Some(failure.status_code()), None, None);
    }

    pub fn set_route(&self, route: &Route, model: &str) {
        if let Ok(mut draft) = self.draft.lock() {
            if let Some(active) = &draft.active {
                active.set_route(&route.provider, model);
            }
            draft.provider = Some(route.provider.clone());
            draft.channel_id = Some(route.channel_id.clone());
            draft.model = Some(model.to_string());
            let mut details = std::mem::take(&mut draft.diagnostics.attempt_details);
            details.push(upstream::AttemptDetails {
                channel_id: route.channel_id.clone(),
                provider: route.provider.clone(),
                model: route.upstream_model.clone(),
                error: None,
            });
            draft.diagnostics = upstream::RequestDiagnostics {
                attempts: draft.diagnostics.attempts + 1,
                attempt_details: details,
                ..Default::default()
            };
        }
    }

    pub fn attempt_failed(&self, failure: &upstream::UpstreamFailure) {
        if let Ok(mut draft) = self.draft.lock() {
            if let Some(attempt) = draft.diagnostics.attempt_details.last_mut() {
                attempt.error = Some(failure.clone());
            }
        }
    }

    pub fn parameters(&self, requested: &Value, upstream: &Value) {
        let budget = |body: &Value| {
            ["max_output_tokens", "max_completion_tokens", "max_tokens"]
                .into_iter()
                .filter_map(|field| body[field].as_u64().map(|value| (field.to_string(), value)))
                .collect()
        };
        if let Ok(mut draft) = self.draft.lock() {
            draft.diagnostics.output_budget = Some(upstream::OutputBudget {
                requested: budget(requested),
                upstream: budget(upstream),
            });
        }
    }

    pub fn finish(
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
        let active = guard.active.take();
        guard.status = Some(status.to_string());
        guard.status_code = code.map(|value| value.as_u16() as i64);
        if let Some(reason) = finish_reason {
            guard.finish_reason = Some(reason.to_string());
        }
        if let Some(usage) = usage {
            guard.usage_json = Some(usage.to_string());
        }
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
            diagnostics_json: serde_json::to_string(&guard.diagnostics).ok(),
        };
        drop(guard);
        if let Err(error) = self.db.insert_metric(&record) {
            warn!(%error, "写入 SQLite 指标失败");
        }
        let _ = self.db.prune_metrics(self.max_records);
        drop(active);
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
