use super::AppState;
use super::auth::{database_error, error_response, now_ms, parse_window, require_public_identity};
use crate::db::{
    MetricRow,
    usage::{BUCKET_MS, UsageAggregate, UsageBucket},
};
use axum::{
    Json,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MetricQuery {
    window: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    status: Option<String>,
    api_key_id: Option<String>,
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
    // Admin HTTP handlers and the private desktop transport both require AdminAccess.
    let identity = if admin {
        None
    } else {
        match require_public_identity(state, headers) {
            Ok(identity) => Some(identity),
            Err(response) => return *response,
        }
    };
    if let (Some(identity), Some(key)) = (&identity, &query.api_key_id) {
        if key != &identity.key_id {
            return error_response(
                StatusCode::FORBIDDEN,
                "只能查看当前 Key 的使用情况",
                "permission_error",
            );
        }
    }
    let since = (now_ms() - parse_window(query.window.as_deref()).as_millis() as i64).max(0)
        / BUCKET_MS
        * BUCKET_MS;
    let allowed_key = |key: &str| {
        query
            .api_key_id
            .as_deref()
            .is_none_or(|selected| selected == key || (selected == "legacy" && key.is_empty()))
            && identity.as_ref().is_none_or(|identity| {
                key == identity.key_id || (!identity.managed && key.is_empty())
            })
    };
    let matches = |key: &str, provider: &str, model: &str, status: &str| {
        allowed_key(key)
            && query
                .provider
                .as_deref()
                .is_none_or(|value| value == provider)
            && query.model.as_deref().is_none_or(|value| value == model)
            && query.status.as_deref().is_none_or(|value| value == status)
    };
    let keys = match state.db.list_api_keys() {
        Ok(keys) => keys,
        Err(error) => return database_error(error),
    };
    let names: HashMap<_, _> = keys
        .iter()
        .map(|key| (key.id.as_str(), key.name.as_str()))
        .collect();
    if let MetricView::Requests = view {
        let rows = match state.db.metric_rows(since) {
            Ok(rows) => rows,
            Err(error) => return database_error(error),
        };
        let rows: Vec<_> = rows
            .into_iter()
            .filter(|row| {
                matches(
                    row.api_key_id.as_deref().unwrap_or(""),
                    row.provider.as_deref().unwrap_or("unknown"),
                    row.model.as_deref().unwrap_or("unknown"),
                    &row.status,
                )
            })
            .collect();
        let data: Vec<_> = rows
            .iter()
            .skip(query.offset.unwrap_or(0))
            .take(query.limit.unwrap_or(50).clamp(1, 500))
            .map(|row| metric_json(row, &names))
            .collect();
        return Json(json!({"data":data,"total":rows.len(),"retentionLimit":state.config.metrics_max_records})).into_response();
    }
    let rows = match state.db.usage_buckets(since) {
        Ok(rows) => rows,
        Err(error) => return database_error(error),
    };
    let rows: Vec<_> = rows
        .into_iter()
        .filter(|row| matches(&row.key_id, &row.provider, &row.model, &row.status))
        .collect();
    if let MetricView::Timeseries = view {
        let bucket_ms = query
            .bucket
            .as_deref()
            .map(|bucket| parse_window(Some(bucket)).as_millis() as i64)
            .unwrap_or(3_600_000)
            .max(BUCKET_MS);
        let mut buckets: BTreeMap<i64, UsageAggregate> = BTreeMap::new();
        for row in &rows {
            buckets
                .entry(row.start / bucket_ms * bucket_ms)
                .or_default()
                .merge(&row.usage);
        }
        let data: Vec<_> = buckets
            .into_iter()
            .map(|(start, usage)| {
                let mut value = usage.json();
                value["start"] = json!(start);
                value["end"] = json!(start + bucket_ms);
                value
            })
            .collect();
        return Json(json!({"data":data})).into_response();
    }
    let mut total = UsageAggregate::default();
    for row in &rows {
        total.merge(&row.usage);
    }
    let active = |key: Option<&str>| {
        if query.status.is_some() {
            0
        } else {
            state.activity.matching(
                key,
                query.provider.as_deref(),
                query.model.as_deref(),
                since,
            )
        }
    };
    let scope_key = identity
        .as_ref()
        .map(|identity| identity.key_id.as_str())
        .or(query.api_key_id.as_deref());
    let mut summary = total.json();
    summary["activeRequests"] = json!(active(scope_key));
    summary["latency"] = json!({"averageMs":summary["averageMs"],"p50Ms":total.percentile(0.5),"p95Ms":total.percentile(0.95),"maxMs":if total.requests > 0 { Some(total.max_ms) } else { None },"approximatePercentiles":true});
    summary["byProvider"] = groups(&rows, |r| &r.provider);
    summary["byChannel"] = groups(&rows, |r| &r.channel);
    summary["byModel"] = groups(&rows, |r| &r.model);
    summary["byApiKey"] = groups(&rows, |r| {
        if r.key_id.is_empty() {
            "legacy"
        } else {
            &r.key_id
        }
    });
    summary["scope"] = json!(if admin { "admin" } else { "self" });
    summary["periodStart"] = json!(since);
    summary["granularityMs"] = json!(BUCKET_MS);
    summary["history"] = match state.db.usage_history() {
        Ok(history) => history,
        Err(error) => return database_error(error),
    };
    let mut by_key: BTreeMap<String, UsageAggregate> = BTreeMap::new();
    for row in &rows {
        by_key
            .entry(row.key_id.clone())
            .or_default()
            .merge(&row.usage);
    }
    let mut key_usage = Vec::new();
    for key in keys.iter().filter(|key| allowed_key(&key.id)) {
        let usage = by_key.remove(&key.id).unwrap_or_default();
        key_usage.push(json!({"key":super::http::public_key(key.clone()),"usage":usage.json(),"activeRequests":active(Some(&key.id))}));
    }
    for (id, usage) in by_key {
        let (display_id, name) = match id.as_str() {
            "" => ("legacy", "历史未归属请求"),
            "anonymous" => ("anonymous", "匿名请求"),
            "environment" => ("environment", "环境变量 Key"),
            _ => (id.as_str(), "历史 Key"),
        };
        key_usage.push(json!({"key":{"id":display_id,"name":name,"prefix":"","enabled":false,"readOnly":true,"lastUsedAt":usage.last_used_at},"usage":usage.json(),"activeRequests":active(Some(&id))}));
    }
    summary["keyUsage"] = json!(key_usage);
    Json(summary).into_response()
}

fn groups<'a>(rows: &'a [UsageBucket], key: impl Fn(&'a UsageBucket) -> &'a str) -> Value {
    let mut groups: BTreeMap<&str, UsageAggregate> = BTreeMap::new();
    for row in rows {
        groups.entry(key(row)).or_default().merge(&row.usage);
    }
    json!(
        groups
            .into_iter()
            .map(|(key, usage)| {
                let mut value = usage.json();
                value["key"] = json!(key);
                value
            })
            .collect::<Vec<_>>()
    )
}

fn metric_json(row: &MetricRow, names: &HashMap<&str, &str>) -> Value {
    let id = row.api_key_id.as_deref().unwrap_or("legacy");
    json!({
        "id":row.id,"startedAt":row.started_at,"completedAt":row.completed_at,
        "durationMs":row.completed_at-row.started_at,"protocol":row.protocol,
        "provider":row.provider,"channelId":row.channel_id,"model":row.model,
        "status":row.status,"statusCode":row.status_code,"finishReason":row.finish_reason,
        "apiKeyId":id,"apiKeyName":names.get(id).copied().unwrap_or(match id { "anonymous"=>"匿名请求", "environment"=>"环境变量 Key", "legacy"=>"历史未归属请求", _=>"历史 Key" }),
        "usage":row.usage_json.as_deref().and_then(|raw| serde_json::from_str::<Value>(raw).ok())
    })
}
