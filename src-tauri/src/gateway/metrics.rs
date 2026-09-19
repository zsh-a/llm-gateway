use super::AppState;
use super::auth::{
    database_error, now_ms, parse_window, require_admin, require_public_auth_identity,
};
use crate::db::MetricRow;
use axum::Json;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::HashMap;

#[derive(Clone, Debug, Deserialize)]
pub(super) struct MetricQuery {
    window: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    status: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
    bucket: Option<String>,
}

#[derive(Clone, Copy)]
pub(super) enum MetricView {
    Summary,
    Timeseries,
    Requests,
}

pub(super) async fn metrics_response(
    state: &AppState,
    headers: &HeaderMap,
    query: &MetricQuery,
    admin: bool,
    view: MetricView,
) -> Response {
    let identity = if admin {
        if let Err(response) = require_admin(state, headers) {
            return *response;
        }
        None
    } else {
        match require_public_auth_identity(state, headers) {
            Ok(identity) => Some(identity),
            Err(response) => return *response,
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
